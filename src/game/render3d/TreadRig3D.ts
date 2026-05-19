// TreadRig3D — tread slab + internal wheels + animated cleat strip,
// for tracked locomotion units. The rig itself is a static slab of
// boxes + cylindrical end caps; per-frame motion (wheel spin and
// cleat scroll) is driven by per-side ground-contact distance.
//
// Each side (left/right ribbon) lives in its own sub-group so it can
// be floor-clamped above terrain independently. A tread crossing a
// crest sees the higher of three sample points along its length and
// rises just enough to clear it, never tunneling. The cleat scroll
// for that side is gated on its own contact bit. See the "Locomotion
// Visuals Are Frontend" section of design_philosophy.html.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { TreadConfig } from '@/types/blueprints';
import { TREAD_CHASSIS_LIFT_Y } from '../math/BodyDimensions';
import {
  type LocomotionBase,
  type RollingContactState,
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
 *  child. `contact` is the gate for that side's cleat scroll. */
export type TreadSide = {
  /** -1 for the left rail, +1 for the right rail. */
  side: -1 | 1;
  /** Lateral offset from chassis center (= side * cfg.treadOffset). */
  lateralOffset: number;
  group: THREE.Group;
  /** Per-side ground-contact flag derived from the floor clamp. True
   *  when the terrain term won the per-frame `max()` for any of the
   *  side's sample points — i.e. some part of the ribbon is touching
   *  ground. Cleat scroll advances only while this is true. */
  contact: boolean;
};

export type TreadMesh = {
  type: 'treads';
  group: THREE.Group;
  sides: TreadSide[];
  wheels: THREE.Mesh[];
  wheelContacts: RollingContactState[];
  /** Per-internal-wheel side index (0 or 1) into `sides[]`, so the
   *  per-frame loop knows which side gates the spin. */
  wheelSide: number[];
  treadContacts: RollingContactState[];
  /** Animated cleat strips around the tread belt (empty when
   *  treadsAnimated is off). Each side scrolls from that side's own
   *  ground-contact motion, so a turning tread can crawl one side
   *  forward and the other backward. */
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
  const wheelContacts: RollingContactState[] = [];
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
    });
  }

  const treadContacts: RollingContactState[] = [
    rollingContact(0, -offset),
    rollingContact(0, offset),
  ];

  if (animatedWheels) {
    // Internal wheels — mostly hidden inside the slab but ensure the
    // chassis-speed → wheel-rotation rate stays consistent with what the
    // visible cleats display.
    const wheelCount = Math.max(2, Math.round(cfg.treadLength * 2));
    const wheelR = Math.max(1, r * cfg.wheelRadius);
    for (let s = 0; s < 2; s++) {
      const sideGroup = sides[s].group;
      const side = sides[s].side;
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
        // Rolling contact in chassis frame still carries the side
        // offset so the sampling math sees the wheel's true world
        // position, even though the mesh is parented to a side group.
        wheelContacts.push(rollingContact(x, side * offset));
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
    wheelContacts,
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

// Scratch reused per frame so the tread loop never allocates. One
// sample-point world coord and one ribbon-clearance accumulator.
const _treadWorld = { x: 0, y: 0, z: 0 };

/** Per-frame: floor-clamp each side ribbon, roll internal wheels
 *  whose side is in contact, and scroll cleats along each grounded
 *  belt loop. Sides are sampled at front, middle, and rear localX so
 *  a tank cresting a hill catches the highest point under its belt
 *  and lifts to clear it — no tunneling. */
export function updateTreads(
  mesh: TreadMesh,
  entity: Entity,
  mapWidth: number,
  mapHeight: number,
): void {
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
    let maxRequiredLocalLift = 0;
    let anyContact = false;
    for (let p = 0; p < sampleLocalXs.length; p++) {
      const localX = sampleLocalXs[p];
      // Natural world position of this sample point on the side's
      // belt — chassis-local (localX, 0, lateralOffset) with the
      // side group's natural Y of 0 baked in.
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
    sideEntry.group.position.y = maxRequiredLocalLift;
  }

  // Internal wheels roll from their own contact centers, gated on
  // their parent side's contact bit.
  const wheelCount = Math.min(mesh.wheels.length, mesh.wheelContacts.length);
  for (let i = 0; i < wheelCount; i++) {
    const signedDistance = sampleRollingContactDistance(entity, mesh.wheelContacts[i]);
    if (!mesh.sides[mesh.wheelSide[i]].contact) continue;
    if (Math.abs(signedDistance) <= 1e-4) continue;
    const wheelR = Math.max(1, mesh.wheels[i].scale.x);
    mesh.wheels[i].rotation.y += signedDistance / wheelR;
  }

  // Cleats scroll along the slab length at the same linear speed.
  // Advance one signed phase per tread side and lay out cleats modulo
  // spacing so they look continuous regardless of cumulative distance.
  // Cleat phase always tracks (so brief liftoffs don't desync the
  // belt visually), but the visible offset only advances on contact.
  if (mesh.cleats.length > 0 && mesh.cleatSpacing > 0) {
    const spacing = mesh.cleatSpacing;
    const cleatsPerSide = mesh.cleats.length / 2;
    for (let s = 0; s < 2; s++) {
      const contact = mesh.treadContacts[s];
      if (!contact) continue;
      sampleRollingContactDistance(entity, contact);
      if (!mesh.sides[s].contact) continue;
      const phaseOff = wrappedRollingPhase(contact.phase, mesh.cleatLoopLength);
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
