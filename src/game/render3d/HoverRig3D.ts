// HoverRig3D — ducted fan ring + downward smoke columns for hover
// locomotion. Hover never contacts ground, so the visuals contract
// (see "Locomotion Visuals Are Frontend" in design_philosophy.html)
// inverts: the rig tracks per-frame `clearance` (chassis world Y −
// terrain Y) instead of a contact boolean, and the floor clamp is a
// soft safety — the rendered rig group is lifted at minimum
// HOVER_FLOOR_MARGIN above terrain so a stale snapshot can never park
// fans inside the dirt.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { HoverConfig } from '@/types/blueprints';
import type { Entity, PlayerId } from '../sim/types';
import type { LocomotionBase } from './LocomotionRigShared3D';
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import type { SmokePuffEmitter } from './SmokeTrail3D';
import { locomotionPieceColorHex } from './colorUtils';

/** Minimum world-Y gap the rendered fan ring is allowed to have above
 *  terrain. The sim is supposed to keep hovers above ground via the
 *  inverse-distance lift force, but a bad snapshot or a 1-tick
 *  interpolation glitch can briefly drop the rendered chassis below.
 *  The rig group lifts itself by enough to keep fans visible above
 *  the surface in that case. */
const HOVER_FLOOR_MARGIN = 1;

const FAN_RING_COLOR = COLORS.units.locomotion.hover.fanRing.colorHex;
const FAN_BLADE_COLOR = COLORS.units.locomotion.hover.fanBlade.colorHex;
const FAN_HUB_COLOR = COLORS.units.locomotion.hover.fanHub.colorHex;
const HOVER_SMOKE_COLOR = COLORS.units.locomotion.hover.smoke.colorHex;
const HOVER_SMOKE_START_ALPHA = COLORS.units.locomotion.hover.smoke.startAlpha;
const DEFAULT_FAN_SPIN_RAD_PER_SEC = 42;
const DEFAULT_FAN_OUTWARD_ANGLE_DEG = 14;
const FAN_BLADE_PITCH_DEG = 24;
const FAN_BLADE_COUNT = 3;
const TRI_FRONT_FAN_ANGLES_RAD = [-Math.PI / 3, Math.PI / 3, Math.PI];

const ringGeomByTubeRatio = new Map<number, THREE.TorusGeometry>();
const hubGeom = new THREE.SphereGeometry(1, 18, 12);
const bladeGeom = new THREE.BoxGeometry(1, 1, 1);
const ringMats = new Map<number, THREE.MeshBasicMaterial>();
const bladeMats = new Map<number, THREE.MeshBasicMaterial>();
const hubMats = new Map<number, THREE.MeshBasicMaterial>();
const LOCAL_EXHAUST_DIR = new THREE.Vector3(0, -1, 0);
const _fanWorldPos = new THREE.Vector3();
const _fanWorldQuat = new THREE.Quaternion();
const _fanWorldDir = new THREE.Vector3();

function getFanMat(
  cache: Map<number, THREE.MeshBasicMaterial>,
  baseColor: number,
  ownerId: PlayerId | undefined,
): THREE.MeshBasicMaterial {
  const color = locomotionPieceColorHex(baseColor, ownerId);
  let mat = cache.get(color);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color });
    cache.set(color, mat);
  }
  return mat;
}

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
  exhaustSpeed: number;
};

type FanSmokeProfile = {
  startRadius: number;
  endRadius: number;
  lifespanMs: number;
  exhaustSpeed: number;
  scopePadding: number;
  largePuff: boolean;
};

const SMALL_FAN_SMOKE: FanSmokeProfile = {
  startRadius: 1,
  endRadius: 8,
  lifespanMs: 900,
  exhaustSpeed: 60,
  scopePadding: 160,
  largePuff: false,
};

// Dragonfly wing-fan exhaust. Routed to SmokeTrail3D's large-puff
// pool so the higher-poly sphere reads as a soft cloud at this size
// instead of a 36-tri faceted blob, and tuned with a longer lifespan
// + stronger downwash so the visual matches the fan's much greater
// thrust footprint.
const LARGE_FAN_SMOKE: FanSmokeProfile = {
  startRadius: 4,
  endRadius: 26,
  lifespanMs: 1300,
  exhaustSpeed: 90,
  scopePadding: 260,
  largePuff: true,
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

type FanSpec = {
  localX: number;
  localZ: number;
  fanRadius: number;
  ringTubeRadius: number;
  outwardAngleRad: number;
  smokeProfile: FanSmokeProfile;
};

function buildFan(
  parent: THREE.Group,
  spec: FanSpec,
  entityId: number,
  fanIndex: number,
  ownerId: PlayerId | undefined,
): HoverFan {
  const { localX, localZ, fanRadius, ringTubeRadius, outwardAngleRad, smokeProfile } = spec;
  const ringTubeRatio = ringTubeRadius / fanRadius;
  const fanY = -Math.max(0.4, ringTubeRadius * 0.9);

  const fanGroup = new THREE.Group();
  fanGroup.position.set(localX, fanY, localZ);

  const outward = new THREE.Vector3(localX, 0, localZ);
  if (outward.lengthSq() > 1e-6 && outwardAngleRad > 0) {
    outward.normalize();
    const exhaustDir = outward
      .multiplyScalar(Math.sin(outwardAngleRad))
      .addScaledVector(new THREE.Vector3(0, -1, 0), Math.cos(outwardAngleRad))
      .normalize();
    fanGroup.quaternion.setFromUnitVectors(LOCAL_EXHAUST_DIR, exhaustDir);
  }

  const ring = new THREE.Mesh(
    getRingGeom(ringTubeRatio),
    getFanMat(ringMats, FAN_RING_COLOR, ownerId),
  );
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
  for (let i = 0; i < FAN_BLADE_COUNT; i++) {
    const blade = new THREE.Mesh(bladeGeom, getFanMat(bladeMats, FAN_BLADE_COLOR, ownerId));
    blade.scale.set(bladeLength, bladeThickness, bladeChord);
    blade.position.x = bladeRootRadius + bladeLength * 0.5;
    blade.rotation.x = bladePitchRad;
    const bladePivot = new THREE.Group();
    bladePivot.rotation.y = (i * Math.PI * 2) / FAN_BLADE_COUNT;
    bladePivot.add(blade);
    rotor.add(bladePivot);
  }

  const hub = new THREE.Mesh(hubGeom, getFanMat(hubMats, FAN_HUB_COLOR, ownerId));
  hub.scale.setScalar(hubRadius);
  rotor.add(hub);
  fanGroup.add(rotor);

  const emitter = new THREE.Object3D();
  emitter.position.set(0, -Math.max(0.35, ringTubeRadius * 0.9), 0);
  fanGroup.add(emitter);

  parent.add(fanGroup);
  return {
    group: fanGroup,
    rotor,
    emitter,
    exhaustSpeed: smokeProfile.exhaustSpeed,
    smoke: {
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: -smokeProfile.exhaustSpeed,
      emitFramesSkip: 0,
      lifespanMs: smokeProfile.lifespanMs,
      startRadius: smokeProfile.startRadius,
      endRadius: smokeProfile.endRadius,
      startAlpha: HOVER_SMOKE_START_ALPHA,
      color: HOVER_SMOKE_COLOR,
      phase: entityId * 4 + fanIndex,
      scopePadding: smokeProfile.scopePadding,
      largePuff: smokeProfile.largePuff,
    },
  };
}

export function buildHoverFans(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfg: HoverConfig,
  entityId: number,
  ownerId: PlayerId | undefined,
): HoverMesh {
  const group = new THREE.Group();
  const mainFanRadius = Math.max(1, unitRadius * cfg.fanRadius);
  const mainRingTubeRadius = Math.max(0.35, unitRadius * cfg.fanRingTubeRadius);
  const outwardAngleRad = THREE.MathUtils.degToRad(
    Math.max(0, Math.min(35, cfg.fanOutwardAngleDeg ?? DEFAULT_FAN_OUTWARD_ANGLE_DEG)),
  );
  const fans: HoverFan[] = [];

  const useDragonflyLayout = cfg.tailFanOffsetX !== undefined;
  const hasTailFan =
    useDragonflyLayout && cfg.tailFanRadius !== undefined && cfg.tailFanRadius > 0;

  if (useDragonflyLayout) {
    // Dragonfly layout: two large "wing" fans at body center forward,
    // spread laterally; optionally one small fan at the tail tip. The
    // wing fans sit on the lateral axis (localX = 0) so they read as
    // wings, not corner thrusters. Wing-fan downwash uses the
    // large-puff pool so the chunky scale reads as soft cloud; the
    // tail fan keeps the small-puff profile since it's the same scale
    // as standard hovers.
    const lateral = unitRadius * cfg.fanDistY;
    for (const sz of [-1, 1]) {
      fans.push(buildFan(
        group,
        {
          localX: 0,
          localZ: sz * lateral,
          fanRadius: mainFanRadius,
          ringTubeRadius: mainRingTubeRadius,
          outwardAngleRad,
          smokeProfile: LARGE_FAN_SMOKE,
        },
        entityId,
        fans.length,
        ownerId,
      ));
    }
    if (hasTailFan) {
      const tailFanRadius = Math.max(0.6, unitRadius * cfg.tailFanRadius!);
      const tailRingTubeRadius = Math.max(
        0.18,
        unitRadius * (cfg.tailFanRingTubeRadius ?? cfg.fanRingTubeRadius),
      );
      // The tail fan sits at (x=tailFanOffsetX*r, z=0) so its
      // center-to-fan radial vector is exactly the unit's −X axis. Feeding
      // that direction into buildFan's outwardAngleRad therefore tilts
      // the duct rearward — which is the visual the user wants for
      // "the tail fan angled back."
      const tailBackAngleRad = THREE.MathUtils.degToRad(
        Math.max(0, Math.min(90, cfg.tailFanBackAngleDeg ?? 0)),
      );
      fans.push(buildFan(
        group,
        {
          localX: unitRadius * (cfg.tailFanOffsetX ?? 0),
          localZ: 0,
          fanRadius: tailFanRadius,
          ringTubeRadius: tailRingTubeRadius,
          outwardAngleRad: tailBackAngleRad,
          smokeProfile: SMALL_FAN_SMOKE,
        },
        entityId,
        fans.length,
        ownerId,
      ));
    }
  } else if (cfg.fanLayout === 'triFront') {
    const fanDist = unitRadius * Math.hypot(cfg.fanDistX, cfg.fanDistY);
    for (const angle of TRI_FRONT_FAN_ANGLES_RAD) {
      fans.push(buildFan(
        group,
        {
          localX: Math.cos(angle) * fanDist,
          localZ: Math.sin(angle) * fanDist,
          fanRadius: mainFanRadius,
          ringTubeRadius: mainRingTubeRadius,
          outwardAngleRad,
          smokeProfile: SMALL_FAN_SMOKE,
        },
        entityId,
        fans.length,
        ownerId,
      ));
    }
  } else {
    const fx = unitRadius * cfg.fanDistX;
    const fz = unitRadius * cfg.fanDistY;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        fans.push(buildFan(
          group,
          {
            localX: sx * fx,
            localZ: sz * fz,
            fanRadius: mainFanRadius,
            ringTubeRadius: mainRingTubeRadius,
            outwardAngleRad,
            smokeProfile: SMALL_FAN_SMOKE,
        },
        entityId,
        fans.length,
        ownerId,
      ));
      }
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
    fan.smoke.vx = _fanWorldDir.x * fan.exhaustSpeed;
    fan.smoke.vy = _fanWorldDir.z * fan.exhaustSpeed;
    fan.smoke.vz = _fanWorldDir.y * fan.exhaustSpeed;
    smokeOut.push(fan.smoke);
  }
}
