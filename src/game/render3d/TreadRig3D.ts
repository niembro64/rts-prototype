// TreadRig3D — tread slab + internal wheels + animated cleat strip,
// for tracked locomotion units. The rig itself is a static slab of
// boxes + cylindrical end caps; per-frame motion (wheel spin and
// cleat scroll) is driven by per-side ground-contact distance.
//
// Each side (left/right ribbon) lives in its own sub-group and carries
// the four canonical visual state channels:
//
//   movement position  →  side group local Y (`lift`)
//   movement velocity  →  integrated from lift via the EMA on `lift`
//   rotation position  →  `beltPhase` (where cleats sit on the belt loop)
//   rotation velocity  →  `beltVelocity` (linear m/s along belt tangent)
//
// Ground contact never overwrites these — it only switches which EMA
// tau drives the velocity channels toward their in-contact targets.
// Off contact: long tau, slow drift; cleats keep scrolling at whatever
// speed they had, the side lifts gently back toward its natural mount
// position. Internal wheels read their angular velocity from the same
// per-side beltVelocity / wheelR, so the whole side spins as one
// continuous mechanism. See the "Locomotion Visuals Are Frontend"
// section of design_philosophy.html.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { TreadConfig } from '@/types/blueprints';
import { TREAD_CHASSIS_LIFT_Y } from '../math/BodyDimensions';
import {
  type LocomotionBase,
  type RollingContactState,
  emaAlpha,
  rollingContact,
  sampleRollingContactDistance,
  transformChassisToWorld,
  wrappedRollingPhase,
} from './LocomotionRigShared3D';
import {
  getLocomotionSurfaceNormal,
  sampleLocomotionPartClamp,
} from './LocomotionTerrainSampler';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';

const TREAD_COLOR = 0x1a1d22;
const WHEEL_COLOR = 0x2a2f36;
export const TREAD_HEIGHT = TREAD_CHASSIS_LIFT_Y;
const TREAD_Y = TREAD_HEIGHT / 2;
const TREAD_CLEAT_HEIGHT = 1.1;
const TREAD_CLEAT_WIDTH_FRAC = 1.0;
const TREAD_CLEAT_LENGTH_FRAC = 0.36;

// Movement-position EMA tau for the per-side lift. Short on contact
// (terrain pushes the ribbon up promptly), longer off contact so the
// side settles toward its mount gently when terrain disappears.
const TREAD_LIFT_TAU_CONTACT_SEC = 0.08;
const TREAD_LIFT_TAU_FREE_SEC = 0.30;
// Rotation-velocity EMA tau for cleat scroll velocity (and internal
// wheel angular velocity, derived from the same per-side beltVelocity).
// Short on contact (treads grip body motion); very long off contact so
// the belt keeps scrolling and drains energy slowly via air drag.
const TREAD_BELT_TAU_CONTACT_SEC = 0.04;
const TREAD_BELT_TAU_FREE_SEC = 5.0;

const treadBoxGeom = new THREE.BoxGeometry(1, 1, 1);
const treadEndGeom = new THREE.CylinderGeometry(1, 1, 1, 16);
const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const treadMat = new THREE.MeshBasicMaterial({ color: TREAD_COLOR });
const wheelMat = new THREE.MeshBasicMaterial({ color: WHEEL_COLOR });
const cleatMat = new THREE.MeshBasicMaterial({ color: 0x3a4046 });

/** Per-side state owned by the rig. The `group` holds the side's
 *  slab, end caps, internal wheels, and animated cleats — all in a
 *  frame where local origin is the side's lateral offset, so the
 *  per-frame floor clamp can rewrite local Y without touching any
 *  child. `lift` / `beltPhase` / `beltVelocity` are the four visual
 *  state channels for the side; `contact` is the regime selector
 *  (which EMA tau to use). */
export type TreadSide = {
  /** -1 for the left rail, +1 for the right rail. */
  side: -1 | 1;
  /** Lateral offset from chassis center (= side * cfg.treadOffset). */
  lateralOffset: number;
  group: THREE.Group;
  /** True when any of the side's sample points are pushed up by
   *  terrain this frame. Picks the coupling tau, not a state gate. */
  contact: boolean;
  /** Movement-position channel: side group local Y offset above the
   *  baseline 0. EMA-converges toward whatever lift the floor clamp
   *  requires; off contact, decays back toward 0 with a longer tau. */
  lift: number;
  /** Rotation-position channel: cleat phase distance along the belt
   *  loop. Integrated from `beltVelocity * dt` every frame; wraps to
   *  `cleatLoopLength` when laying out cleats. */
  beltPhase: number;
  /** Rotation-velocity channel: cleat scroll velocity in world units
   *  per second along the belt tangent. Couples to body motion through
   *  ground friction when in contact; drifts under air drag when not. */
  beltVelocity: number;
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
  /** Width of the rut a single tread side stamps onto the ground, in
   *  world units. Roughly the cleat width — narrower than the full
   *  belt so the two parallel ruts are visually separated rather
   *  than reading as one wide smear. */
  printWidth: number;
} & LocomotionBase;

export function buildTreads(
  unitGroup: THREE.Group,
  r: number,
  cfg: TreadConfig,
  animatedWheels: boolean,
): TreadMesh {
  const group = new THREE.Group();
  const length = r * cfg.treadLength;
  const width = r * cfg.treadWidth;
  const offset = r * cfg.treadOffset;
  const treadRadius = Math.min(TREAD_HEIGHT / 2, Math.max(1, length / 2));
  const straightLength = Math.max(1, length - 2 * treadRadius);
  const halfStraight = straightLength / 2;

  const sides: TreadSide[] = [];
  const wheels: THREE.Mesh[] = [];
  const wheelSide: number[] = [];
  const cleats: THREE.Mesh[] = [];
  let cleatSpacing = 0;
  const cleatLoopLength = 2 * straightLength + 2 * Math.PI * treadRadius;

  for (const side of [-1, 1] as const) {
    const sideGroup = new THREE.Group();
    sideGroup.position.set(0, 0, side * offset);
    group.add(sideGroup);

    // Slab pieces — center run + two rounded end caps. Built at
    // sideZ=0 inside the per-side group; the group itself carries
    // the lateral offset.
    const centerRun = new THREE.Mesh(treadBoxGeom, treadMat);
    centerRun.scale.set(straightLength, TREAD_HEIGHT, width);
    centerRun.position.set(0, TREAD_Y, 0);
    sideGroup.add(centerRun);

    for (const end of [-1, 1] as const) {
      const roundedEnd = new THREE.Mesh(treadEndGeom, treadMat);
      roundedEnd.rotation.x = Math.PI / 2;
      roundedEnd.scale.set(treadRadius, width, treadRadius);
      roundedEnd.position.set(end * halfStraight, TREAD_Y, 0);
      sideGroup.add(roundedEnd);
    }

    sides.push({
      side,
      lateralOffset: side * offset,
      group: sideGroup,
      contact: true,
      lift: 0,
      beltPhase: 0,
      beltVelocity: 0,
    });
  }

  const treadContacts: RollingContactState[] = [
    rollingContact(0, -offset),
    rollingContact(0, offset),
  ];

  if (animatedWheels) {
    // Internal wheels — mostly hidden inside the slab but ensure the
    // chassis-speed → wheel-rotation rate stays consistent with what the
    // visible cleats display. Their angular velocity is derived from
    // their parent side's beltVelocity, so the whole side moves as
    // one mechanism (cleats and wheels can't desync).
    const wheelCount = Math.max(2, Math.round(cfg.treadLength * 2));
    const wheelR = Math.max(1, r * cfg.wheelRadius);
    for (let s = 0; s < 2; s++) {
      const sideGroup = sides[s].group;
      for (let i = 0; i < wheelCount; i++) {
        const t = (i + 0.5) / wheelCount;
        const x = -length / 2 + t * length;
        const w = new THREE.Mesh(wheelGeom, wheelMat);
        w.rotation.x = Math.PI / 2;
        w.scale.set(wheelR, width * 1.05, wheelR);
        w.position.set(x, TREAD_Y, 0);
        sideGroup.add(w);
        wheels.push(w);
        wheelSide.push(s);
      }
    }

    // Animated cleats cover the full belt loop: top run, rounded front
    // return, bottom ground-contact run, and rounded rear return. This
    // makes treads read correctly from side/front/back instead of
    // looking like a square slab with only top markings.
    const cleatCount = Math.max(8, Math.round(cleatLoopLength / Math.max(1, r * 0.26)));
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
    printWidth,
    geometryKey: '',
  };
}

// Scratch reused per frame so the tread loop never allocates.
const _treadWorld = { x: 0, y: 0, z: 0 };

/** Per-frame: integrate each side's four visual channels forward. The
 *  floor clamp drives the lift channel via EMA; the per-side signed
 *  distance drives the beltVelocity channel via EMA. beltPhase
 *  integrates from beltVelocity and feeds the cleat layout. Internal
 *  wheels integrate from the same per-side beltVelocity / wheelR. No
 *  channel snaps at the contact boundary — only the tau switches. */
export function updateTreads(
  mesh: TreadMesh,
  entity: Entity,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
): void {
  const dtSec = Math.max(0.001, dtMs / 1000);
  const bodyCenterHeight = entity.unit ? getUnitBodyCenterHeight(entity.unit) : 0;
  // Convert a world-Y lift back into a chassis-local Y delta. Tilt
  // rotates local Y through the surface normal; the local lift needed
  // to raise the side by `worldLift` world units is approximately
  // `worldLift / normal.z` (with the same 0.35 floor LegRig3D uses).
  const n = getLocomotionSurfaceNormal(entity, mapWidth, mapHeight);
  const normalY = Math.max(0.35, n.nz);

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
    // any of them. EMA-converge `lift` toward that target with the
    // contact/free tau. Contact = any sample is pushed up by terrain.
    let maxRequiredLocalLift = 0;
    let anyContact = false;
    for (let p = 0; p < sampleLocalXs.length; p++) {
      const localX = sampleLocalXs[p];
      transformChassisToWorld(
        localX, 0, sideEntry.lateralOffset,
        entity, bodyCenterHeight, mapWidth, mapHeight, _treadWorld,
      );
      const naturalWorldY = _treadWorld.y;
      const clamp = sampleLocomotionPartClamp(
        _treadWorld.x, _treadWorld.z,
        naturalWorldY, mesh.treadRadius,
        mapWidth, mapHeight,
      );
      if (clamp.contact) anyContact = true;
      const worldLift = clamp.renderedY - naturalWorldY;
      if (worldLift > 0) {
        const localLift = worldLift / normalY;
        if (localLift > maxRequiredLocalLift) maxRequiredLocalLift = localLift;
      }
    }
    sideEntry.contact = anyContact;
    const liftTau = anyContact ? TREAD_LIFT_TAU_CONTACT_SEC : TREAD_LIFT_TAU_FREE_SEC;
    sideEntry.lift += (maxRequiredLocalLift - sideEntry.lift) * emaAlpha(dtSec, liftTau);
    sideEntry.group.position.y = sideEntry.lift;

    // ── Rotation-velocity channel: beltVelocity ──────────────────
    // Always advance per-side contact tracking so signed distance
    // history stays continuous across brief liftoffs. Derive the
    // target scroll velocity only when in contact (ground friction
    // couples toward it); when off contact the target is 0 with a
    // long tau (air drag), so the belt drifts to a stop rather than
    // freezing instantly.
    const contact = mesh.treadContacts[s];
    const signedDistance = contact !== undefined
      ? sampleRollingContactDistance(entity, contact)
      : 0;
    const targetBeltVelocity = anyContact ? signedDistance / dtSec : 0;
    const beltTau = anyContact ? TREAD_BELT_TAU_CONTACT_SEC : TREAD_BELT_TAU_FREE_SEC;
    sideEntry.beltVelocity +=
      (targetBeltVelocity - sideEntry.beltVelocity) * emaAlpha(dtSec, beltTau);

    // ── Rotation-position channel: beltPhase ─────────────────────
    // Integrate from the velocity channel. Wraps modulo cleatLoopLength
    // implicitly inside the cleat layout helper.
    sideEntry.beltPhase += sideEntry.beltVelocity * dtSec;
  }

  // Internal wheels: angular velocity = parent side's beltVelocity / wheelR.
  // Rotation integrates from that. Same tau, same regime — wheels and
  // cleats on one side move as one mechanism.
  for (let i = 0; i < mesh.wheels.length; i++) {
    const sideIdx = mesh.wheelSide[i];
    const side = mesh.sides[sideIdx];
    if (!side) continue;
    const tireR = Math.max(1, mesh.wheels[i].scale.x);
    const omega = side.beltVelocity / tireR;
    mesh.wheels[i].rotation.y += omega * dtSec;
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
