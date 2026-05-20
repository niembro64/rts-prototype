// HoverRig3D — ducted fan ring + downward smoke columns for hover
// locomotion. Hover never contacts ground, so the visuals contract
// (see "Locomotion Visuals Are Frontend" in design_philosophy.html)
// inverts: the rig tracks per-frame `clearance` (chassis world Y −
// terrain Y) instead of a contact boolean, and the floor clamp is a
// soft safety — the rendered rig group is lifted at minimum
// HOVER_FLOOR_MARGIN above terrain so a stale snapshot can never park
// fans inside the dirt.

import * as THREE from 'three';
import type { HoverConfig } from '@/types/blueprints';
import type { Entity } from '../sim/types';
import type { LocomotionBase } from './LocomotionRigShared3D';
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import type { SmokePuffEmitter } from './SmokeTrail3D';

/** Minimum world-Y gap the rendered fan ring is allowed to have above
 *  terrain. The sim is supposed to keep hovers above ground via the
 *  inverse-distance lift force, but a bad snapshot or a 1-tick
 *  interpolation glitch can briefly drop the rendered chassis below.
 *  The rig group lifts itself by enough to keep fans visible above
 *  the surface in that case. */
const HOVER_FLOOR_MARGIN = 1;

const FAN_RING_COLOR = 0x000000;
const FAN_BLADE_COLOR = 0xffffff;
const FAN_HUB_COLOR = 0xffffff;
const HOVER_SMOKE_COLOR = 0xcccccc;
const DEFAULT_FAN_SPIN_RAD_PER_SEC = 42;
const FAN_SMOKE_SPEED = 60;
const DEFAULT_FAN_OUTWARD_ANGLE_DEG = 14;
const FAN_BLADE_PITCH_DEG = 24;

const ringGeomByTubeRatio = new Map<number, THREE.TorusGeometry>();
const hubGeom = new THREE.SphereGeometry(1, 18, 12);
const bladeGeom = new THREE.BoxGeometry(1, 1, 1);
const ringMat = new THREE.MeshBasicMaterial({ color: FAN_RING_COLOR });
const bladeMat = new THREE.MeshBasicMaterial({ color: FAN_BLADE_COLOR });
const hubMat = new THREE.MeshBasicMaterial({ color: FAN_HUB_COLOR });
const LOCAL_EXHAUST_DIR = new THREE.Vector3(0, -1, 0);
const _fanWorldPos = new THREE.Vector3();
const _fanWorldQuat = new THREE.Quaternion();
const _fanWorldDir = new THREE.Vector3();

function getRingGeom(tubeRatio: number): THREE.TorusGeometry {
  const key = Math.round(THREE.MathUtils.clamp(tubeRatio, 0.05, 0.2) * 1000) / 1000;
  let geom = ringGeomByTubeRatio.get(key);
  if (!geom) {
    geom = new THREE.TorusGeometry(1, key, 16, 40);
    ringGeomByTubeRatio.set(key, geom);
  }
  return geom;
}

type HoverFan = {
  group: THREE.Group;
  rotor: THREE.Group;
  emitter: THREE.Object3D;
  smoke: SmokePuffEmitter;
};

export type HoverMesh = {
  type: 'hover';
  group: THREE.Group;
  fans: HoverFan[];
  /** Most recent world-Y gap between the chassis and terrain below
   *  it. Updated every frame in updateHoverFans. Useful to other
   *  client systems (smoke length, dust kick-up, altitude shading)
   *  that key off the hover gap rather than absolute altitude. */
  clearance: number;
  fanSpinRadPerSec: number;
} & LocomotionBase;

export function buildHoverFans(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfg: HoverConfig,
  entityId: number,
): HoverMesh {
  const group = new THREE.Group();
  const fanRadius = Math.max(1, unitRadius * cfg.fanRadius);
  const ringTubeRadius = Math.max(0.35, unitRadius * cfg.fanRingTubeRadius);
  const ringTubeRatio = ringTubeRadius / fanRadius;
  const fanY = -Math.max(0.6, ringTubeRadius * 0.9);
  const fx = unitRadius * cfg.fanDistX;
  const fz = unitRadius * cfg.fanDistY;
  const outwardAngleRad = THREE.MathUtils.degToRad(
    Math.max(0, Math.min(35, cfg.fanOutwardAngleDeg ?? DEFAULT_FAN_OUTWARD_ANGLE_DEG)),
  );
  const fans: HoverFan[] = [];

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const fanGroup = new THREE.Group();
      const localX = sx * fx;
      const localZ = sz * fz;
      fanGroup.position.set(localX, fanY, localZ);

      const outward = new THREE.Vector3(localX, 0, localZ);
      if (outward.lengthSq() > 1e-6) {
        outward.normalize();
        const exhaustDir = outward
          .multiplyScalar(Math.sin(outwardAngleRad))
          .addScaledVector(new THREE.Vector3(0, -1, 0), Math.cos(outwardAngleRad))
          .normalize();
        fanGroup.quaternion.setFromUnitVectors(LOCAL_EXHAUST_DIR, exhaustDir);
      }

      const ring = new THREE.Mesh(getRingGeom(ringTubeRatio), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.scale.setScalar(fanRadius);
      fanGroup.add(ring);

      const rotor = new THREE.Group();
      const hubRadius = fanRadius * 0.22;
      const bladeRootRadius = hubRadius * 0.9;
      const bladeTipRadius = fanRadius * 0.82;
      const bladeLength = Math.max(0.2, bladeTipRadius - bladeRootRadius);
      const bladeChord = Math.max(0.55, bladeLength * 0.42);
      const bladeThickness = Math.max(0.14, ringTubeRadius * 0.32);
      const bladePitchRad = THREE.MathUtils.degToRad(FAN_BLADE_PITCH_DEG);
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(bladeGeom, bladeMat);
        blade.scale.set(bladeLength, bladeThickness, bladeChord);
        blade.position.x = bladeRootRadius + bladeLength * 0.5;
        blade.rotation.x = bladePitchRad;
        const bladePivot = new THREE.Group();
        bladePivot.rotation.y = (i * Math.PI) / 2;
        bladePivot.add(blade);
        rotor.add(bladePivot);
      }

      const hub = new THREE.Mesh(hubGeom, hubMat);
      hub.scale.setScalar(hubRadius);
      rotor.add(hub);
      fanGroup.add(rotor);

      const emitter = new THREE.Object3D();
      emitter.position.set(0, -Math.max(0.35, ringTubeRadius * 0.9), 0);
      fanGroup.add(emitter);

      group.add(fanGroup);
      fans.push({
        group: fanGroup,
        rotor,
        emitter,
        smoke: {
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          vz: -FAN_SMOKE_SPEED,
          emitFramesSkip: 0,
          lifespanMs: 900,
          startRadius: 1,
          endRadius: 8,
          startAlpha: 0.9,
          color: HOVER_SMOKE_COLOR,
          phase: entityId * 4 + fans.length,
          scopePadding: 160,
        },
      });
    }
  }

  unitGroup.add(group);
  return {
    type: 'hover',
    group,
    fans,
    clearance: 0,
    fanSpinRadPerSec: cfg.fanSpinRadPerSec ?? DEFAULT_FAN_SPIN_RAD_PER_SEC,
    geometryKey: '',
  };
}

export function updateHoverFans(
  mesh: HoverMesh,
  entity: Entity,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
  smokeOut?: SmokePuffEmitter[],
): void {
  const dtSec = dtMs / 1000;

  // Per-frame clearance + soft floor safety. The chassis world Y is
  // sim altitude (entity.transform.z); the rendered rig group is a
  // child of the unitGroup, so local-Y adjustments shift it relative
  // to that chassis. Lift the group by whatever it takes to keep the
  // fans at least HOVER_FLOOR_MARGIN above terrain. On the common
  // case (chassis floating cleanly above ground) this is a no-op.
  const chassisWorldY = entity.transform.z;
  const groundY = getLocomotionSurfaceHeight(
    entity.transform.x, entity.transform.y, mapWidth, mapHeight,
  );
  const rawClearance = chassisWorldY - groundY;
  const floorDeficit = HOVER_FLOOR_MARGIN - rawClearance;
  mesh.group.position.y = floorDeficit > 0 ? floorDeficit : 0;
  mesh.clearance = Math.max(rawClearance, HOVER_FLOOR_MARGIN);

  for (let i = 0; i < mesh.fans.length; i++) {
    const fan = mesh.fans[i];
    fan.rotor.rotation.y -= mesh.fanSpinRadPerSec * dtSec;
    if (!smokeOut) continue;

    fan.emitter.getWorldPosition(_fanWorldPos);
    fan.group.getWorldQuaternion(_fanWorldQuat);
    _fanWorldDir.copy(LOCAL_EXHAUST_DIR).applyQuaternion(_fanWorldQuat).normalize();

    fan.smoke.x = _fanWorldPos.x;
    fan.smoke.y = _fanWorldPos.z;
    fan.smoke.z = _fanWorldPos.y;
    fan.smoke.vx = _fanWorldDir.x * FAN_SMOKE_SPEED;
    fan.smoke.vy = _fanWorldDir.z * FAN_SMOKE_SPEED;
    fan.smoke.vz = _fanWorldDir.y * FAN_SMOKE_SPEED;
    smokeOut.push(fan.smoke);
  }
}
