import * as THREE from 'three';
import type { HoverConfig } from '@/types/blueprints';
import type { Entity } from '../sim/types';
import type { LocomotionBase } from './LocomotionRigShared3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';

const FAN_RING_COLOR = 0x273038;
const FAN_BLADE_COLOR = 0x9fb0b8;
const FAN_HUB_COLOR = 0x46525a;
const HOVER_SMOKE_COLOR = 0xcccccc;
const FAN_SPIN_RAD_PER_SEC = 42;
const FAN_SMOKE_SPEED = 60;
const DEFAULT_FAN_OUTWARD_ANGLE_DEG = 14;

const ringGeom = new THREE.TorusGeometry(1, 0.08, 8, 28);
const ductGeom = new THREE.CylinderGeometry(1, 1, 1, 28, 1, true);
const hubGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const bladeGeom = new THREE.BoxGeometry(1, 1, 1);
const ringMat = new THREE.MeshBasicMaterial({ color: FAN_RING_COLOR });
const ductMat = new THREE.MeshBasicMaterial({ color: FAN_RING_COLOR, side: THREE.DoubleSide });
const bladeMat = new THREE.MeshBasicMaterial({ color: FAN_BLADE_COLOR });
const hubMat = new THREE.MeshBasicMaterial({ color: FAN_HUB_COLOR });
const LOCAL_EXHAUST_DIR = new THREE.Vector3(0, -1, 0);
const _fanWorldPos = new THREE.Vector3();
const _fanWorldQuat = new THREE.Quaternion();
const _fanWorldDir = new THREE.Vector3();

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
} & LocomotionBase;

export function buildHoverFans(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfg: HoverConfig,
  entityId: number,
): HoverMesh {
  const group = new THREE.Group();
  const fanRadius = Math.max(1, unitRadius * cfg.fanRadius);
  const ringTubeScale = Math.max(0.35, unitRadius * cfg.fanRingTubeRadius);
  const fanY = -Math.max(0.6, ringTubeScale * 0.9);
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

      const duct = new THREE.Mesh(ductGeom, ductMat);
      duct.scale.set(fanRadius * 1.02, Math.max(0.45, ringTubeScale * 2.1), fanRadius * 1.02);
      fanGroup.add(duct);

      const ring = new THREE.Mesh(ringGeom, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.scale.set(fanRadius, fanRadius, ringTubeScale);
      fanGroup.add(ring);

      const rotor = new THREE.Group();
      const bladeLength = fanRadius * 1.45;
      const bladeWidth = Math.max(0.45, fanRadius * 0.18);
      const bladeThickness = Math.max(0.12, ringTubeScale * 0.35);
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(bladeGeom, bladeMat);
        blade.position.x = fanRadius * 0.28;
        blade.scale.set(bladeLength * 0.5, bladeThickness, bladeWidth);
        const bladePivot = new THREE.Group();
        bladePivot.rotation.y = (i * Math.PI) / 2;
        bladePivot.add(blade);
        rotor.add(bladePivot);
      }

      const hub = new THREE.Mesh(hubGeom, hubMat);
      hub.scale.set(fanRadius * 0.22, Math.max(0.2, ringTubeScale * 0.8), fanRadius * 0.22);
      rotor.add(hub);
      fanGroup.add(rotor);

      const emitter = new THREE.Object3D();
      emitter.position.set(0, -Math.max(0.35, ringTubeScale * 0.9), 0);
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
  return { type: 'hover', group, fans, lodKey: '' };
}

export function updateHoverFans(
  mesh: HoverMesh,
  _entity: Entity,
  dtMs: number,
  smokeOut?: SmokePuffEmitter[],
): void {
  const dtSec = dtMs / 1000;

  for (let i = 0; i < mesh.fans.length; i++) {
    const fan = mesh.fans[i];
    fan.rotor.rotation.y -= FAN_SPIN_RAD_PER_SEC * dtSec;
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
