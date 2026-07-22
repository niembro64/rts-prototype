// TreadRig3D — a static tread belt shell + an animated cleat strip,
// for tracked locomotion units. The interior is a single non-spinning
// shell (a rounded slab of boxes + cylindrical end caps at High/Medium,
// one envelope box at Low); the only per-frame motion is the cleat
// scroll, driven by per-side body motion. There are no spinning road
// wheels inside the belt.
//
// Each side (left/right ribbon) lives in its own sub-group and carries
// the four canonical visual state channels:
//
//   movement position  →  side group local Y (`lift`)
//   movement velocity  →  integrated from lift via the EMA on `lift`
//   rotation position  →  `beltPhase` (where cleats sit on the belt loop)
//   rotation velocity  →  `beltVelocity` (linear m/s along belt tangent)
//
// High/Medium animation plays without checking whether the side is
// touching ground. Position EMAs toward the floor-clamp target every
// frame; belt velocity EMAs toward the per-side body-motion-derived
// target every frame. Low uses static envelope boxes while retaining
// the position clamp and contact samples. See the "Locomotion Visuals Are Frontend"
// section of budget_design_philosophy.html.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { Entity, PlayerId } from '../sim/types';
import type { TreadConfig } from '@/types/blueprints';
import { TREAD_CHASSIS_LIFT_Y } from '../math/BodyDimensions';
import {
  type LocomotionBase,
  type LocomotionRenderPose,
  type RollingContactState,
  chassisUpFromPose,
  emaAlpha,
  rollingContact,
  rollingLocomotionBodyActive,
  sampleRollingContactDistance,
  sampleRollingContactPosition,
  transformChassisToWorld,
  wrappedRollingPhase,
} from './LocomotionRigShared3D';
import {
  sampleLocomotionPartClamp,
  type LocomotionPartClamp,
} from './LocomotionTerrainSampler';
import { getLocomotionMatByCache } from './RenderUtils';
import { type PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';

const TREAD_COLOR = COLORS.units.locomotion.tread.slab.colorHex;
const _treadClamp: LocomotionPartClamp = { groundY: 0, renderedY: 0 };
const TREAD_HEIGHT = TREAD_CHASSIS_LIFT_Y;
const TREAD_Y = TREAD_HEIGHT / 2;
const TREAD_CLEAT_HEIGHT = 1.1;
const TREAD_CLEAT_WIDTH_FRAC = 1.0;
const TREAD_CLEAT_LENGTH_FRAC = 0.36;

// Movement-position EMA tau for the per-side lift. Drives the side
// toward the floor-clamp target each frame; long enough that terrain
// undulations read as suspension travel, short enough that the side
// doesn't lag the chassis on rolling ground.
const TREAD_LIFT_TAU_SEC = 0.12;
// Rotation-velocity EMA tau for cleat scroll velocity (and internal
// wheel angular velocity, derived from the same per-side beltVelocity).
// Short enough that treads grip body motion tightly, long enough that
// a sudden velocity change doesn't manifest as an instantaneous cleat
// scroll rate change.
const TREAD_BELT_TAU_SEC = 0.04;
const TREAD_LIFT_SETTLED_EPSILON = 0.02;
const TREAD_BELT_SETTLED_EPSILON = 0.02;

const treadBoxGeom = new THREE.BoxGeometry(1, 1, 1);

// One watertight stadium (rounded-rectangle) prism for the belt shell, cached
// per (dimensions, tier). A single extruded solid — not a slab box with
// cylinder end caps punched into it — so no interior triangles overlap or
// intersect. Cached module-side like the shared box geometry above.
const treadShellGeoms = new Map<string, THREE.ExtrudeGeometry>();

function getTreadShellGeom(
  straightLength: number,
  treadRadius: number,
  width: number,
  tier: PrimitiveGeometryTier,
): THREE.ExtrudeGeometry {
  const arcSegs = tier === 'mid' ? 6 : 10;
  const key = `${straightLength.toFixed(2)}:${treadRadius.toFixed(2)}:${width.toFixed(2)}:${tier}`;
  let geom = treadShellGeoms.get(key);
  if (!geom) {
    const hs = straightLength / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-hs, -treadRadius);
    shape.lineTo(hs, -treadRadius); // bottom straight
    shape.absarc(hs, 0, treadRadius, -Math.PI / 2, Math.PI / 2, false); // front semicircle
    shape.lineTo(-hs, treadRadius); // top straight
    shape.absarc(-hs, 0, treadRadius, Math.PI / 2, Math.PI * 1.5, false); // back semicircle
    geom = new THREE.ExtrudeGeometry(shape, {
      depth: width,
      bevelEnabled: false,
      steps: 1,
      curveSegments: arcSegs,
    });
    geom.translate(0, 0, -width / 2); // centre the extrusion across the belt width
    treadShellGeoms.set(key, geom);
  }
  return geom;
}
const treadMats = new Map<number, THREE.MeshBasicMaterial>();
const cleatMats = new Map<number, THREE.MeshBasicMaterial>();

/**
 * Belt slabs and rounded end caps never change in their side-local space.
 * Their parent still carries the live suspension lift, but freezing their
 * local matrices skips needless position/scale/quaternion recomposition on
 * every display frame for every tracked vehicle.
 */
function freezeStaticLocalTransform(mesh: THREE.Mesh): void {
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
}

/** Per-side state owned by the rig. The `group` holds the side's
 *  slab, end caps, internal wheels, and animated cleats — all in a
 *  frame where local origin is the side's lateral offset, so the
 *  per-frame floor clamp can rewrite local Y without touching any
 *  child. `lift` / `beltPhase` / `beltVelocity` are the four visual
 *  state channels for the side. */
export type TreadSide = {
  /** -1 for the left rail, +1 for the right rail. */
  side: -1 | 1;
  /** Lateral offset from chassis center (= side * cfg.treadOffset). */
  lateralOffset: number;
  group: THREE.Group;
  /** Movement-position channel: side group local Y offset above the
   *  baseline 0. EMA-converges toward whatever lift the floor clamp
   *  requires every frame. */
  lift: number;
  /** Last sampled lift target. Lets the render-side active queue stop
   *  updating a stationary tread side once the lift EMA has settled. */
  targetLift: number;
  /** Rotation-position channel: cleat phase distance along the belt
   *  loop. Integrated from `beltVelocity * dt` every frame; wraps to
   *  `cleatLoopLength` when laying out cleats. */
  beltPhase: number;
  /** Rotation-velocity channel: cleat scroll velocity in world units
   *  per second along the belt tangent. EMA-couples to the per-side
   *  body-motion signed distance every frame. */
  beltVelocity: number;
  /** Logical internal-wheel phase. Kept even at Low, where the internal
   * wheel meshes are absent, so changing LOD cannot reset their rotation. */
  wheelRotation: number;
};

export type TreadMesh = {
  type: 'treads';
  group: THREE.Group;
  sides: TreadSide[];
  wheels: THREE.Mesh[];
  /** Per-internal-wheel side index (0 or 1) into `sides[]`, so the
   *  per-frame loop knows which beltVelocity drives this wheel. */
  wheelSide: number[];
  /** Per-side rolling contact at (0, ±offset). Tracks the world XY of
   *  each ribbon's center so per-frame signed distance can be sampled
   *  as the input to the belt-velocity EMA. */
  treadContacts: RollingContactState[];
  /** Animated cleat strips around the tread belt (empty when
   *  treadsAnimated is off). The first half is the left side, the
   *  second half the right side; layout consumes `beltPhase` per side. */
  cleats: THREE.Mesh[];
  cleatSpacing: number;
  cleatLoopLength: number;
  treadStraightLength: number;
  treadRadius: number;
  /** Maximum chassis-local suspension travel. A support surface can
   *  lift the belt within this envelope, never detach the whole rig. */
  maxLift: number;
  /** Width of the rut a single tread side stamps onto the ground, in
   *  world units. Roughly the cleat width — narrower than the full
   *  belt so the two parallel ruts are visually separated rather
   *  than reading as one wide smear. */
  printWidth: number;
  /** False for the Low box representation, which has no moving cleats or
   *  wheel meshes and performs no belt/wheel phase integration. */
  rotationAnimated: boolean;
} & LocomotionBase;

export function buildTreads(
  unitGroup: THREE.Group,
  r: number,
  cfg: TreadConfig,
  animatedWheels: boolean,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
): TreadMesh {
  const group = new THREE.Group();
  const length = r * cfg.treadLength;
  const width = r * cfg.treadWidth;
  const offset = r * cfg.treadOffset;
  const treadRadius = Math.min(TREAD_HEIGHT / 2, Math.max(1, length / 2));
  const straightLength = Math.max(1, length - 2 * treadRadius);

  const sides: TreadSide[] = [];
  const wheels: THREE.Mesh[] = [];
  const wheelSide: number[] = [];
  const cleats: THREE.Mesh[] = [];
  let cleatSpacing = 0;
  const cleatLoopLength = 2 * straightLength + 2 * Math.PI * treadRadius;
  const treadMat = getLocomotionMatByCache(treadMats, TREAD_COLOR, ownerId);
  const cleatMat = getLocomotionMatByCache(
    cleatMats,
    COLORS.units.locomotion.tread.cleat.colorHex,
    ownerId,
  );
  cleatMat.side = THREE.DoubleSide;

  for (const side of [-1, 1] as const) {
    const sideGroup = new THREE.Group();
    sideGroup.position.set(0, 0, side * offset);
    group.add(sideGroup);

    if (geometryTier === 'far') {
      // Low is a single box per side, sized to the complete authored
      // track envelope. It preserves the high-detail rig's overall
      // length, height, width, and lateral placement without moving parts.
      const treadBox = new THREE.Mesh(treadBoxGeom, treadMat);
      treadBox.scale.set(length, TREAD_HEIGHT, width);
      treadBox.position.set(0, TREAD_Y, 0);
      freezeStaticLocalTransform(treadBox);
      sideGroup.add(treadBox);
    } else {
      // High/medium: one watertight stadium prism for the belt shell -- flat
      // straights joined by semicircular ends, no overlapping interior
      // triangles. The shape's X/Y are the belt length/height and the extrusion
      // depth is the belt width, so it drops straight into the side group.
      const shell = new THREE.Mesh(
        getTreadShellGeom(straightLength, treadRadius, width, geometryTier),
        treadMat,
      );
      shell.position.set(0, TREAD_Y, 0);
      freezeStaticLocalTransform(shell);
      sideGroup.add(shell);
    }

    sides.push({
      side,
      lateralOffset: side * offset,
      group: sideGroup,
      lift: 0,
      targetLift: 0,
      beltPhase: 0,
      beltVelocity: 0,
      wheelRotation: 0,
    });
  }

  const treadContacts: RollingContactState[] = [
    rollingContact(0, -offset),
    rollingContact(0, offset),
  ];

  if (animatedWheels && geometryTier !== 'far') {
    // Animated cleats cover the full belt loop: top run, rounded front
    // return, bottom ground-contact run, and rounded rear return. This
    // makes treads read correctly from side/front/back instead of
    // looking like a square slab with only top markings.
    const cleatCount = geometryTier === 'mid'
      ? Math.max(6, Math.round(cleatLoopLength / Math.max(1, r * 0.62)))
      : Math.max(8, Math.round(cleatLoopLength / Math.max(1, r * 0.26)));
    cleatSpacing = cleatLoopLength / cleatCount;
    const cleatLen = cleatSpacing * TREAD_CLEAT_LENGTH_FRAC;
    const cleatWidth = width * TREAD_CLEAT_WIDTH_FRAC;
    const cleatsPerSide = cleatCount + 1;
    for (let s = 0; s < 2; s++) {
      const sideGroup = sides[s].group;
      for (let i = 0; i < cleatsPerSide; i++) {
        const cleat = new THREE.Mesh(treadBoxGeom, cleatMat);
        cleat.scale.set(cleatLen, TREAD_CLEAT_HEIGHT, cleatWidth);
        layoutTreadCleat(cleat, i * cleatSpacing, straightLength, treadRadius);
        sideGroup.add(cleat);
        cleats.push(cleat);
      }
    }
  }

  unitGroup.add(group);
  // Rut width sized to the cleat: narrower than the slab so the
  // left+right ruts read as two parallel lines instead of merging.
  const printWidth = Math.max(0.5, width * TREAD_CLEAT_WIDTH_FRAC);
  return {
    type: 'treads',
    group,
    sides,
    wheels,
    wheelSide,
    treadContacts,
    cleats,
    cleatSpacing,
    cleatLoopLength,
    treadStraightLength: straightLength,
    treadRadius,
    maxLift: Math.max(1, Math.min(r * 0.35, TREAD_HEIGHT)),
    printWidth,
    rotationAnimated: geometryTier !== 'far',
    geometryKey: '',
  };
}

// Scratch reused per frame so the tread loop never allocates.
const _treadWorld = { x: 0, y: 0, z: 0 };
const _treadUp = { x: 0, y: 1, z: 0 };

/** Per-frame: integrate each side's visual channels forward. The floor
 *  clamp drives the lift channel via EMA; the per-side signed distance
 *  drives the beltVelocity channel via EMA. beltPhase integrates from
 *  beltVelocity and feeds the cleat layout. Low skips belt scroll while
 *  retaining the floor clamp. The interior is a single static belt shell
 *  (no spinning road wheels), so only the cleats move. */
export function updateTreads(
  mesh: TreadMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const dtSec = Math.max(0.001, dtMs / 1000);
  // Convert a world-Y lift back into a chassis-local Y delta. Tilt
  // rotates local Y through the surface normal; the local lift needed
  // to raise the side by `worldLift` world units is approximately
  // `worldLift / normal.z` (with the same 0.35 floor LegRig3D uses).
  chassisUpFromPose(pose, _treadUp);
  const normalY = Math.max(0.35, _treadUp.y);
  const liftAlpha = emaAlpha(dtSec, TREAD_LIFT_TAU_SEC);
  const beltAlpha = emaAlpha(dtSec, TREAD_BELT_TAU_SEC);

  // Sample localX positions along each side's belt straight section:
  // rear, mid, front. The slab's bottom sits at world Y = side world
  // Y − treadRadius (treadRadius is also the half-height of the rounded
  // end cap and the slab's vertical half-extent), so the floor clamp
  // wants the side center to be at least `treadRadius` above terrain.
  const halfStraight = mesh.treadStraightLength / 2;
  const sampleLocalXs: readonly number[] = [-halfStraight, 0, halfStraight];

  for (let s = 0; s < mesh.sides.length; s++) {
    const sideEntry = mesh.sides[s];

    // ── Movement-position channel: lift ──────────────────────────
    // Walk the 3 sample points, take the max world-lift required by
    // any of them. EMA-converge `lift` toward that target every frame.
    let maxRequiredLocalLift = 0;
    for (let p = 0; p < sampleLocalXs.length; p++) {
      const localX = sampleLocalXs[p];
      transformChassisToWorld(
        localX, 0, sideEntry.lateralOffset,
        pose, _treadWorld,
      );
      const naturalWorldY = _treadWorld.y;
      const clamp = sampleLocomotionPartClamp(
        _treadWorld.x, _treadWorld.z,
        naturalWorldY, mesh.treadRadius,
        mapWidth, mapHeight,
        entity.id,
        _treadClamp,
      );
      const worldLift = clamp.renderedY - naturalWorldY;
      if (worldLift > 0) {
        const localLift = worldLift / normalY;
        if (localLift > maxRequiredLocalLift) maxRequiredLocalLift = localLift;
      }
    }
    maxRequiredLocalLift = Math.min(mesh.maxLift, maxRequiredLocalLift);
    sideEntry.targetLift = maxRequiredLocalLift;
    sideEntry.lift += (maxRequiredLocalLift - sideEntry.lift) * liftAlpha;
    sideEntry.group.position.y = sideEntry.lift;

    // ── Rotation-velocity channel: beltVelocity ──────────────────
    // Target scroll velocity is always derived from the per-side
    // signed distance. The EMA gives the belt a hair of inertia so
    // a sudden body velocity change doesn't manifest as a cleat-scroll
    // discontinuity.
    const contact = mesh.treadContacts[s];
    if (mesh.rotationAnimated) {
      const signedDistance = contact !== undefined
        ? sampleRollingContactDistance(pose, contact)
        : 0;
      const targetBeltVelocity = signedDistance / dtSec;
      sideEntry.beltVelocity += (targetBeltVelocity - sideEntry.beltVelocity) * beltAlpha;

      // ── Rotation-position channel: beltPhase ───────────────────
      // Integrate from the velocity channel. Wraps modulo
      // cleatLoopLength implicitly inside the cleat layout helper.
      sideEntry.beltPhase += sideEntry.beltVelocity * dtSec;
    } else {
      if (contact !== undefined) sampleRollingContactPosition(pose, contact);
      sideEntry.beltVelocity = 0;
    }
  }

  // Lay out cleats from each side's beltPhase.
  if (mesh.cleats.length > 0 && mesh.cleatSpacing > 0) {
    const spacing = mesh.cleatSpacing;
    const cleatsPerSide = mesh.cleats.length / 2;
    for (let s = 0; s < 2; s++) {
      const sideEntry = mesh.sides[s];
      const phaseOff = wrappedRollingPhase(sideEntry.beltPhase, mesh.cleatLoopLength);
      const baseIdx = s * cleatsPerSide;
      for (let i = 0; i < cleatsPerSide; i++) {
        layoutTreadCleat(
          mesh.cleats[baseIdx + i],
          phaseOff + i * spacing,
          mesh.treadStraightLength,
          mesh.treadRadius,
        );
      }
    }
  }
  return treadsNeedFrame(mesh, pose);
}

function treadsNeedFrame(mesh: TreadMesh, pose: LocomotionRenderPose): boolean {
  if (rollingLocomotionBodyActive(pose)) return true;
  for (let s = 0; s < mesh.sides.length; s++) {
    const contact = mesh.treadContacts[s];
    if (contact === undefined || !contact.initialized) return true;
    const side = mesh.sides[s];
    if (Math.abs(side.targetLift - side.lift) > TREAD_LIFT_SETTLED_EPSILON) return true;
    if (Math.abs(side.beltVelocity) > TREAD_BELT_SETTLED_EPSILON) return true;
  }
  return false;
}

/** Lay one cleat mesh on the belt loop given its phase distance.
 *  Wraps around: front-top → front-arc → bottom → rear-arc → repeat.
 *  Lateral position is owned by the side group the cleat is parented
 *  to (sideZ = 0 here). */
function layoutTreadCleat(
  cleat: THREE.Mesh,
  distance: number,
  straightLength: number,
  treadRadius: number,
): void {
  const halfStraight = straightLength / 2;
  const arcLength = Math.PI * treadRadius;
  const loopLength = 2 * straightLength + 2 * arcLength;
  let d = ((distance % loopLength) + loopLength) % loopLength;
  const outerRadius = treadRadius + TREAD_CLEAT_HEIGHT / 2;

  let x = 0;
  let y = 0;
  let angle = 0;

  if (d < straightLength) {
    x = -halfStraight + d;
    y = TREAD_Y + outerRadius;
    angle = 0;
  } else {
    d -= straightLength;
    if (d < arcLength) {
      const theta = Math.PI / 2 - d / treadRadius;
      x = halfStraight + Math.cos(theta) * outerRadius;
      y = TREAD_Y + Math.sin(theta) * outerRadius;
      angle = Math.atan2(-Math.cos(theta), Math.sin(theta));
    } else {
      d -= arcLength;
      if (d < straightLength) {
        x = halfStraight - d;
        y = TREAD_Y - outerRadius;
        angle = Math.PI;
      } else {
        d -= straightLength;
        const theta = -Math.PI / 2 - d / treadRadius;
        x = -halfStraight + Math.cos(theta) * outerRadius;
        y = TREAD_Y + Math.sin(theta) * outerRadius;
        angle = Math.atan2(-Math.cos(theta), Math.sin(theta));
      }
    }
  }

  cleat.position.set(x, y, 0);
  cleat.rotation.z = angle;
}
