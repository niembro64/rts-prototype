// FlyingRig3D — fixed wings plus rear jet smoke for flying locomotion.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  getSmokeProfile,
  type FlyingSmokeUseId,
  type ResolvedSmokeProfile,
} from '@/smokeConfig';
import type { FlyingConfig } from '@/types/blueprints';
import type { Entity, PlayerId } from '../sim/types';
import type { LocomotionBase } from './LocomotionRigShared3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';
import { locomotionPieceColorHex } from './colorUtils';

const WING_COLOR = COLORS.units.locomotion.flying.wing.colorHex;
const JET_COLOR = COLORS.units.locomotion.flying.jet.colorHex;
const JET_SMOKE_COLOR = COLORS.units.locomotion.flying.smoke.colorHex;
const LOCAL_EXHAUST_DIR = new THREE.Vector3(-1, 0, 0);

// Wing panel geometry: tapered, swept-back planform for one side only.
// Built unit-sized (root chord 1, side span 1, thickness 1) so callers can
// scale by (chord, thickness, sideSpan). The root edge sits on local Z=0,
// letting each side rotate around the fuselage for dihedral/anhedral.
function buildWingPanelGeom(lateralSign: -1 | 1): THREE.BufferGeometry {
  const rootHalfChord = 0.5;
  const tipHalfChord = 0.12;
  const sweep = 0.35;
  const tipZ = lateralSign;

  const shape = new THREE.Shape();
  shape.moveTo(rootHalfChord, 0);
  shape.lineTo(-sweep + tipHalfChord, tipZ);
  shape.lineTo(-sweep - tipHalfChord, tipZ);
  shape.lineTo(-rootHalfChord, 0);
  shape.lineTo(rootHalfChord, 0);

  const geom = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geom.translate(0, 0, -0.5);
  geom.rotateX(Math.PI / 2);
  return geom;
}

const leftWingGeom = buildWingPanelGeom(-1);
const rightWingGeom = buildWingPanelGeom(1);
const jetGeom = new THREE.CylinderGeometry(1, 1, 1, 18, 1, true);
jetGeom.rotateZ(Math.PI / 2);
const wingMats = new Map<number, THREE.MeshBasicMaterial>();
const jetMats = new Map<number, THREE.MeshBasicMaterial>();
const _jetWorldPos = new THREE.Vector3();
const _jetWorldQuat = new THREE.Quaternion();
const _jetWorldDir = new THREE.Vector3();

function getFlyingMat(
  cache: Map<number, THREE.MeshBasicMaterial>,
  baseColor: number,
  ownerId: PlayerId | undefined,
  side?: THREE.Side,
): THREE.MeshBasicMaterial {
  const color = locomotionPieceColorHex(baseColor, ownerId);
  let mat = cache.get(color);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ color, side });
    cache.set(color, mat);
  }
  return mat;
}

type FlyingJet = {
  group: THREE.Group;
  emitter: THREE.Object3D;
  smoke: SmokePuffEmitter;
};

export type FlyingMesh = {
  type: 'flying';
  group: THREE.Group;
  jets: FlyingJet[];
  smokeExhaustSpeed: number;
  smokeProfile: ResolvedSmokeProfile;
} & LocomotionBase;

export function buildFlyingRig(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfg: FlyingConfig,
  smokeUseId: FlyingSmokeUseId,
  entityId: number,
  ownerId: PlayerId | undefined,
): FlyingMesh {
  const group = new THREE.Group();
  const smokeProfile = getSmokeProfile(smokeUseId);

  addWingPanels(group, unitRadius, {
    spanFrac: cfg.wingSpan,
    chordFrac: cfg.wingChord,
    offsetXFrac: cfg.wingOffsetX,
    heightFrac: cfg.wingHeight,
    thicknessFrac: cfg.wingThickness ?? 0.04,
    dihedralDeg: cfg.wingDihedralDeg ?? 0,
    mirrorX: false,
    ownerId,
  });

  if (
    cfg.tailWingSpan !== undefined &&
    cfg.tailWingChord !== undefined &&
    cfg.tailWingOffsetX !== undefined &&
    cfg.tailWingHeight !== undefined
  ) {
    addWingPanels(group, unitRadius, {
      spanFrac: cfg.tailWingSpan,
      chordFrac: cfg.tailWingChord,
      offsetXFrac: cfg.tailWingOffsetX,
      heightFrac: cfg.tailWingHeight,
      thicknessFrac: cfg.tailWingThickness ?? cfg.wingThickness ?? 0.04,
      dihedralDeg: cfg.tailWingDihedralDeg ?? 0,
      mirrorX: cfg.tailWingMirrorX ?? false,
      ownerId,
    });
  }

  const jetRadius = Math.max(0.4, unitRadius * cfg.jetRadius);
  const jetLength = Math.max(1, unitRadius * cfg.jetLength);
  const jetX = unitRadius * cfg.jetOffsetX;
  const jetY = unitRadius * cfg.jetOffsetZ;
  const jetZ = unitRadius * cfg.jetOffsetY;
  const jetLateralOffsets = cfg.jetCount === 1 ? [0] : [-jetZ, jetZ];
  const jets: FlyingJet[] = [];
  const smokeFramesSkip = Math.max(0, smokeProfile.emitFramesSkip);

  for (const lateralOffset of jetLateralOffsets) {
    const jetGroup = new THREE.Group();
    jetGroup.position.set(jetX, jetY, lateralOffset);

    const nozzle = new THREE.Mesh(jetGeom, getFlyingMat(jetMats, JET_COLOR, ownerId));
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
        useId: smokeProfile.useId,
        maxPoolSize: smokeProfile.maxPoolSize,
        emitFramesSkip: smokeFramesSkip,
        fadeInMs: smokeProfile.fadeInMs,
        fadeOutMs: smokeProfile.fadeOutMs,
        startRadius: smokeProfile.startRadius,
        endRadiusMultiplier: smokeProfile.endRadiusMultiplier,
        maxAlpha: smokeProfile.maxAlpha,
        color: JET_SMOKE_COLOR,
        phase: entityId * 2 + jets.length,
      },
    });
  }

  unitGroup.add(group);
  return {
    type: 'flying',
    group,
    jets,
    smokeExhaustSpeed: smokeProfile.exhaustSpeed,
    smokeProfile,
    geometryKey: '',
  };
}

function addWingPanels(
  group: THREE.Group,
  unitRadius: number,
  spec: {
    spanFrac: number;
    chordFrac: number;
    offsetXFrac: number;
    heightFrac: number;
    thicknessFrac: number;
    dihedralDeg: number;
    mirrorX: boolean;
    ownerId: PlayerId | undefined;
  },
): void {
  const sideSpan = Math.max(0.5, unitRadius * spec.spanFrac * 0.5);
  const chord = Math.max(0.5, unitRadius * spec.chordFrac);
  const thickness = Math.max(0.2, unitRadius * spec.thicknessFrac);
  const offsetX = unitRadius * spec.offsetXFrac;
  const height = unitRadius * spec.heightFrac;
  const dihedralRad = spec.dihedralDeg * Math.PI / 180;
  // mirrorX flips the wing front-to-back so a panel placed at the rear
  // reads as a mirror image of the front wings (root toward the tail,
  // tip swept forward toward the body) instead of repeating the same
  // backward sweep at the back.
  const chordSign = spec.mirrorX ? -1 : 1;

  for (const side of [-1, 1] as const) {
    const panelGroup = new THREE.Group();
    panelGroup.position.set(offsetX, height, 0);
    panelGroup.rotation.x = -side * dihedralRad;

    const panel = new THREE.Mesh(
      side < 0 ? leftWingGeom : rightWingGeom,
      getFlyingMat(wingMats, WING_COLOR, spec.ownerId, THREE.DoubleSide),
    );
    panel.scale.set(chord * chordSign, thickness, sideSpan);
    panelGroup.add(panel);
    group.add(panelGroup);
  }
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
    jet.smoke.vx = _jetWorldDir.x * mesh.smokeExhaustSpeed;
    jet.smoke.vy = _jetWorldDir.z * mesh.smokeExhaustSpeed;
    jet.smoke.vz = _jetWorldDir.y * mesh.smokeExhaustSpeed;
    smokeOut.push(jet.smoke);
  }
}
