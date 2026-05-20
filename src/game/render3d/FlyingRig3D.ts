// FlyingRig3D — fixed wings plus rear jet smoke for flying locomotion.

import * as THREE from 'three';
import type { FlyingConfig } from '@/types/blueprints';
import type { Entity } from '../sim/types';
import type { LocomotionBase } from './LocomotionRigShared3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';

const WING_COLOR = 0x000000;
const JET_COLOR = 0x111111;
const JET_SMOKE_COLOR = 0xcccccc;
const DEFAULT_JET_SMOKE_SPEED = 70;
const LOCAL_EXHAUST_DIR = new THREE.Vector3(-1, 0, 0);

// Wing geometry: tapered, swept-back planform extending across both sides.
// Built unit-sized (root chord 1, total span 1, thickness 1) so callers can
// scale by (chord, thickness, span) like the previous box geometry.
function buildWingGeom(): THREE.BufferGeometry {
  const rootHalfChord = 0.5;
  const tipHalfChord = 0.12;
  const sweep = 0.35;
  const halfSpan = 0.5;

  const shape = new THREE.Shape();
  shape.moveTo(rootHalfChord, 0);
  shape.lineTo(-sweep + tipHalfChord, halfSpan);
  shape.lineTo(-sweep - tipHalfChord, halfSpan);
  shape.lineTo(-rootHalfChord, 0);
  shape.lineTo(-sweep - tipHalfChord, -halfSpan);
  shape.lineTo(-sweep + tipHalfChord, -halfSpan);
  shape.lineTo(rootHalfChord, 0);

  const geom = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geom.translate(0, 0, -0.5);
  geom.rotateX(Math.PI / 2);
  return geom;
}

const wingGeom = buildWingGeom();
const jetGeom = new THREE.CylinderGeometry(1, 1, 1, 18, 1, true);
jetGeom.rotateZ(Math.PI / 2);
const wingMat = new THREE.MeshBasicMaterial({ color: WING_COLOR });
const jetMat = new THREE.MeshBasicMaterial({ color: JET_COLOR });
const _jetWorldPos = new THREE.Vector3();
const _jetWorldQuat = new THREE.Quaternion();
const _jetWorldDir = new THREE.Vector3();

type FlyingJet = {
  group: THREE.Group;
  emitter: THREE.Object3D;
  smoke: SmokePuffEmitter;
};

export type FlyingMesh = {
  type: 'flying';
  group: THREE.Group;
  jets: FlyingJet[];
  jetSmokeSpeed: number;
} & LocomotionBase;

export function buildFlyingRig(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfg: FlyingConfig,
  entityId: number,
): FlyingMesh {
  const group = new THREE.Group();

  const wingSpan = Math.max(1, unitRadius * cfg.wingSpan);
  const wingChord = Math.max(1, unitRadius * cfg.wingChord);
  const wingThickness = Math.max(0.25, unitRadius * (cfg.wingThickness ?? 0.04));
  const wing = new THREE.Mesh(wingGeom, wingMat);
  wing.position.set(
    unitRadius * cfg.wingOffsetX,
    unitRadius * cfg.wingHeight,
    0,
  );
  wing.scale.set(wingChord, wingThickness, wingSpan);
  group.add(wing);

  const jetRadius = Math.max(0.4, unitRadius * cfg.jetRadius);
  const jetLength = Math.max(1, unitRadius * cfg.jetLength);
  const jetX = unitRadius * cfg.jetOffsetX;
  const jetY = unitRadius * cfg.jetOffsetZ;
  const jetZ = unitRadius * cfg.jetOffsetY;
  const jets: FlyingJet[] = [];

  for (const side of [-1, 1]) {
    const jetGroup = new THREE.Group();
    jetGroup.position.set(jetX, jetY, side * jetZ);

    const nozzle = new THREE.Mesh(jetGeom, jetMat);
    nozzle.scale.set(jetLength, jetRadius, jetRadius);
    jetGroup.add(nozzle);

    const emitter = new THREE.Object3D();
    emitter.position.set(-jetLength * 0.55, 0, 0);
    jetGroup.add(emitter);

    group.add(jetGroup);
    jets.push({
      group: jetGroup,
      emitter,
      smoke: {
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        emitFramesSkip: 0,
        lifespanMs: 850,
        startRadius: 1,
        endRadius: 7,
        startAlpha: 0.85,
        color: JET_SMOKE_COLOR,
        phase: entityId * 2 + jets.length,
        scopePadding: 180,
      },
    });
  }

  unitGroup.add(group);
  return {
    type: 'flying',
    group,
    jets,
    jetSmokeSpeed: cfg.jetSmokeSpeed ?? DEFAULT_JET_SMOKE_SPEED,
    geometryKey: '',
  };
}

export function updateFlyingRig(
  mesh: FlyingMesh,
  _entity: Entity,
  _dtMs: number,
  smokeOut?: SmokePuffEmitter[],
): void {
  if (!smokeOut) return;

  for (const jet of mesh.jets) {
    jet.emitter.getWorldPosition(_jetWorldPos);
    jet.group.getWorldQuaternion(_jetWorldQuat);
    _jetWorldDir.copy(LOCAL_EXHAUST_DIR).applyQuaternion(_jetWorldQuat).normalize();

    jet.smoke.x = _jetWorldPos.x;
    jet.smoke.y = _jetWorldPos.z;
    jet.smoke.z = _jetWorldPos.y;
    jet.smoke.vx = _jetWorldDir.x * mesh.jetSmokeSpeed;
    jet.smoke.vy = _jetWorldDir.z * mesh.jetSmokeSpeed;
    jet.smoke.vz = _jetWorldDir.y * mesh.jetSmokeSpeed;
    smokeOut.push(jet.smoke);
  }
}
