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
import type {
  AirborneEmitterBatch3D,
  AirborneEmitterParentPose3D,
} from './AirborneEmitterBatch3D';
import type { LocomotionBase } from './LocomotionRigShared3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';
import { getLocomotionMatByCache } from './RenderUtils';
import {
  createPrimitiveCylinderGeometry,
  getOrCreate,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

const WING_COLOR = COLORS.units.locomotion.flying.wing.colorHex;
const JET_COLOR = COLORS.units.locomotion.flying.jet.colorHex;
const JET_SMOKE_COLOR = COLORS.units.locomotion.flying.smoke.colorHex;
const LOCAL_EXHAUST_DIR = new THREE.Vector3(-1, 0, 0);
const DEFAULT_WING_TIP_HALF_CHORD_FRAC = 0.12;

// Wing panel geometry: tapered, swept-back planform for one side only.
// Built unit-sized (root chord 1, side span 1, thickness 1) so callers can
// scale by (chord, thickness, sideSpan). The root edge sits on local Z=0,
// letting each side rotate around the fuselage for dihedral/anhedral.
function buildWingPanelGeom(
  lateralSign: -1 | 1,
  sweepFrac: number,
  _tier: PrimitiveGeometryTier,
): THREE.BufferGeometry {
  const rootHalfChord = 0.5;
  const tipHalfChord = DEFAULT_WING_TIP_HALF_CHORD_FRAC;
  const tipZ = lateralSign;

  const shape = new THREE.Shape();
  shape.moveTo(rootHalfChord, 0);
  shape.lineTo(-sweepFrac + tipHalfChord, tipZ);
  shape.lineTo(-sweepFrac - tipHalfChord, tipZ);
  shape.lineTo(-rootHalfChord, 0);
  shape.lineTo(rootHalfChord, 0);

  // Even Low keeps the authored wing thickness. A planar ShapeGeometry made
  // distant aircraft look wilted and has literally zero enclosed volume.
  const geom: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: false,
    steps: 1,
  });
  geom.translate(0, 0, -0.5);
  geom.rotateX(Math.PI / 2);
  return geom;
}

const wingGeomCache = new Map<string, THREE.BufferGeometry>();
const jetGeomByTier = new Map<PrimitiveGeometryTier, THREE.CylinderGeometry>();
function getJetGeom(tier: PrimitiveGeometryTier): THREE.CylinderGeometry {
  return getOrCreate(jetGeomByTier, tier, () => {
    const geometry = createPrimitiveCylinderGeometry('locomotion', tier, 1, 1, 1, 1, true);
    geometry.rotateZ(Math.PI / 2);
    return geometry;
  });
}
const wingMats = new Map<number, THREE.MeshLambertMaterial>();
const jetMats = new Map<number, THREE.MeshLambertMaterial>();
const _jetWorldPos = new THREE.Vector3();
const _jetWorldQuat = new THREE.Quaternion();
const _jetWorldDir = new THREE.Vector3();

function getWingPanelGeom(
  lateralSign: -1 | 1,
  sweepFrac: number,
  tier: PrimitiveGeometryTier,
): THREE.BufferGeometry {
  const key = `${tier}:${lateralSign}:${sweepFrac.toFixed(3)}`;
  return getOrCreate(wingGeomCache, key, () =>
    buildWingPanelGeom(lateralSign, sweepFrac, tier));
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
  geometryTier: PrimitiveGeometryTier = 'close',
): FlyingMesh {
  const group = new THREE.Group();
  const smokeProfile = getSmokeProfile(smokeUseId);

  // Each lifting surface is one authored object with its own mount, so
  // "does this unit have a main wing" is `wing !== null` rather than five
  // optional scalars that had to be present together and a separate
  // `wingEnabled` flag that could disagree with them.
  for (const surface of [cfg.wing, cfg.tailWing]) {
    if (surface === null) continue;
    addWingPanels(group, unitRadius, {
      spanFrac: surface.span,
      chordFrac: surface.chord,
      offsetXFrac: surface.offset.xUnitRadiusRatio,
      heightFrac: surface.offset.zUnitRadiusRatio,
      lateralFrac: surface.offset.yUnitRadiusRatio,
      thicknessFrac: surface.thickness,
      dihedralDeg: surface.dihedralDeg,
      sweepFrac: surface.sweepFrac,
      mirrorX: surface.mirrorX,
      ownerId,
      geometryTier,
    });
  }

  const jetRadius = Math.max(0.4, unitRadius * cfg.jetRadius);
  const jetLength = Math.max(1, unitRadius * cfg.jetLength);
  const jets: FlyingJet[] = [];
  const smokeFramesSkip = Math.max(0, smokeProfile.emitFramesSkip);

  // One authored mount per nozzle. A `jetCount` with a single lateral scalar
  // meant a twin-jet unit put both nozzles at ±that scalar — and every
  // twin-jet unit in the roster authored it as 0, so the pair rendered
  // exactly coincident: one nozzle wearing two.
  for (const jet of cfg.jets) {
    const jetGroup = new THREE.Group();
    jetGroup.position.set(
      unitRadius * jet.offset.xUnitRadiusRatio,
      unitRadius * jet.offset.zUnitRadiusRatio,
      unitRadius * jet.offset.yUnitRadiusRatio,
    );

    const nozzle = new THREE.Mesh(
      getJetGeom(geometryTier),
      getLocomotionMatByCache(jetMats, JET_COLOR, ownerId),
    );
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
        capPolicy: smokeProfile.capPolicy,
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
    lateralFrac: number;
    thicknessFrac: number;
    dihedralDeg: number;
    sweepFrac: number;
    mirrorX: boolean;
    ownerId: PlayerId | undefined;
    geometryTier: PrimitiveGeometryTier;
  },
): void {
  const sideSpan = Math.max(0.5, unitRadius * spec.spanFrac * 0.5);
  const chord = Math.max(0.5, unitRadius * spec.chordFrac);
  const thickness = Math.max(0.2, unitRadius * spec.thicknessFrac);
  const offsetX = unitRadius * spec.offsetXFrac;
  const height = unitRadius * spec.heightFrac;
  const lateral = unitRadius * spec.lateralFrac;
  const dihedralRad = spec.dihedralDeg * Math.PI / 180;
  const sweepFrac = Math.max(0, spec.sweepFrac);
  // mirrorX flips the wing front-to-back so a panel placed at the rear
  // reads as a mirror image of the front wings (root toward the tail,
  // tip swept forward toward the body) instead of repeating the same
  // backward sweep at the back.
  const chordSign = spec.mirrorX ? -1 : 1;

  for (const side of [-1, 1] as const) {
    const panelGroup = new THREE.Group();
    panelGroup.position.set(offsetX, height, lateral);
    panelGroup.rotation.x = -side * dihedralRad;

    const panel = new THREE.Mesh(
      getWingPanelGeom(side, sweepFrac, spec.geometryTier),
      getLocomotionMatByCache(wingMats, WING_COLOR, spec.ownerId, THREE.DoubleSide),
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
  emitterBatch?: AirborneEmitterBatch3D,
  parentPose?: AirborneEmitterParentPose3D,
): boolean {
  if (!smokeOut) return false;

  for (const jet of mesh.jets) {
    if (emitterBatch && parentPose) {
      emitterBatch.enqueue(
        parentPose,
        mesh.group.position.x,
        mesh.group.position.y,
        mesh.group.position.z,
        jet.group.position.x,
        jet.group.position.y,
        jet.group.position.z,
        jet.group.quaternion.x,
        jet.group.quaternion.y,
        jet.group.quaternion.z,
        jet.group.quaternion.w,
        jet.emitter.position.x,
        jet.emitter.position.y,
        jet.emitter.position.z,
        LOCAL_EXHAUST_DIR.x,
        LOCAL_EXHAUST_DIR.y,
        LOCAL_EXHAUST_DIR.z,
        mesh.smokeExhaustSpeed,
        jet.smoke,
      );
      continue;
    }

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
  return true;
}
