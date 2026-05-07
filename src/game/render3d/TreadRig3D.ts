// TreadRig3D — tread slab + internal wheels + animated cleat strip,
// for tracked locomotion units. The rig itself is a static slab of
// boxes + cylindrical end caps; per-frame motion (wheel spin and
// cleat scroll) is driven by per-side ground-contact distance.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { TreadConfig } from '@/types/blueprints';
import { TREAD_CHASSIS_LIFT_Y } from '../math/BodyDimensions';
import {
  type LocomotionBase,
  type RollingContactState,
  rollingContact,
  sampleRollingContactDistance,
  wrappedRollingPhase,
} from './LocomotionRigShared3D';

const TREAD_COLOR = 0x1a1d22;
const WHEEL_COLOR = 0x2a2f36;
export const TREAD_HEIGHT = TREAD_CHASSIS_LIFT_Y;
const TREAD_Y = TREAD_HEIGHT / 2;
const TREAD_CLEAT_HEIGHT = 2;
const TREAD_CLEAT_WIDTH_FRAC = 0.85;
const TREAD_CLEAT_LENGTH_FRAC = 0.36;

const treadBoxGeom = new THREE.BoxGeometry(1, 1, 1);
const treadEndGeom = new THREE.CylinderGeometry(1, 1, 1, 16);
const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const treadMat = new THREE.MeshBasicMaterial({ color: TREAD_COLOR });
const wheelMat = new THREE.MeshBasicMaterial({ color: WHEEL_COLOR });
// Lighter gray for the animated cleats, mirroring the 2D
// drawAnimatedTread track-line color (`GRAY_LIGHT`) so the moving
// highlights read over the dark tread slab.
const cleatMat = new THREE.MeshBasicMaterial({ color: 0x5a636d });

export type TreadMesh = {
  type: 'treads';
  group: THREE.Group;
  wheels: THREE.Mesh[];
  wheelContacts: RollingContactState[];
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

  for (const side of [-1, 1]) {
    const centerRun = new THREE.Mesh(treadBoxGeom, treadMat);
    centerRun.scale.set(straightLength, TREAD_HEIGHT, width);
    centerRun.position.set(0, TREAD_Y, side * offset);
    group.add(centerRun);

    for (const end of [-1, 1]) {
      const roundedEnd = new THREE.Mesh(treadEndGeom, treadMat);
      roundedEnd.rotation.x = Math.PI / 2;
      roundedEnd.scale.set(treadRadius, width, treadRadius);
      roundedEnd.position.set(end * halfStraight, TREAD_Y, side * offset);
      group.add(roundedEnd);
    }
  }

  const wheels: THREE.Mesh[] = [];
  const wheelContacts: RollingContactState[] = [];
  const treadContacts: RollingContactState[] = [
    rollingContact(0, -offset),
    rollingContact(0, offset),
  ];
  const cleats: THREE.Mesh[] = [];
  let cleatSpacing = 0;

  if (animatedWheels) {
    // Internal wheels — mostly hidden inside the slab but ensure the
    // chassis-speed → wheel-rotation rate stays consistent with what the
    // visible cleats display.
    const wheelCount = Math.max(2, Math.round(cfg.treadLength * 2));
    const wheelR = Math.max(1, r * cfg.wheelRadius);
    for (const side of [-1, 1]) {
      for (let i = 0; i < wheelCount; i++) {
        const t = (i + 0.5) / wheelCount;
        const x = -length / 2 + t * length;
        const w = new THREE.Mesh(wheelGeom, wheelMat);
        w.rotation.x = Math.PI / 2;
        w.scale.set(wheelR, width * 1.05, wheelR);
        w.position.set(x, TREAD_Y, side * offset);
        group.add(w);
        wheels.push(w);
        wheelContacts.push(rollingContact(x, side * offset));
      }
    }

    // Animated cleats cover the full belt loop: top run, rounded front
    // return, bottom ground-contact run, and rounded rear return. This
    // makes treads read correctly from side/front/back instead of
    // looking like a square slab with only top markings.
    const loopLength = 2 * straightLength + 2 * Math.PI * treadRadius;
    const cleatCount = Math.max(10, Math.round(loopLength / Math.max(1, r * 0.16)));
    cleatSpacing = loopLength / cleatCount;
    const cleatLen = cleatSpacing * TREAD_CLEAT_LENGTH_FRAC;
    const cleatWidth = width * TREAD_CLEAT_WIDTH_FRAC;
    const cleatsPerSide = cleatCount + 1;
    for (const side of [-1, 1]) {
      for (let i = 0; i < cleatsPerSide; i++) {
        const cleat = new THREE.Mesh(treadBoxGeom, cleatMat);
        cleat.scale.set(cleatLen, TREAD_CLEAT_HEIGHT, cleatWidth);
        layoutTreadCleat(
          cleat,
          i * cleatSpacing,
          straightLength,
          treadRadius,
          side * offset,
        );
        group.add(cleat);
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
    wheels,
    wheelContacts,
    treadContacts,
    cleats,
    cleatSpacing,
    cleatLoopLength: 2 * straightLength + 2 * Math.PI * treadRadius,
    treadStraightLength: straightLength,
    treadRadius,
    printWidth,
    lodKey: '',
  };
}

/** Per-frame: roll internal wheels from per-contact ground motion,
 *  then advance and lay out cleats along each side of the belt loop.
 *  Treaded turns therefore show the two sides moving at different
 *  speeds / directions. */
export function updateTreads(mesh: TreadMesh, entity: Entity): void {
  // Internal wheels roll from their own contact centers, not from
  // the unit center.
  const wheelCount = Math.min(mesh.wheels.length, mesh.wheelContacts.length);
  for (let i = 0; i < wheelCount; i++) {
    const signedDistance = sampleRollingContactDistance(entity, mesh.wheelContacts[i]);
    if (Math.abs(signedDistance) <= 1e-4) continue;
    const wheelR = Math.max(1, mesh.wheels[i].scale.x);
    mesh.wheels[i].rotation.y += signedDistance / wheelR;
  }

  // Cleats scroll along the slab length at the same linear speed.
  // Advance one signed phase per tread side and lay out cleats modulo
  // spacing so they look continuous regardless of cumulative distance.
  if (mesh.cleats.length > 0 && mesh.cleatSpacing > 0) {
    const spacing = mesh.cleatSpacing;
    const cleatsPerSide = mesh.cleats.length / 2;
    for (let s = 0; s < 2; s++) {
      const contact = mesh.treadContacts[s];
      if (!contact) continue;
      sampleRollingContactDistance(entity, contact);
      const phaseOff = wrappedRollingPhase(contact.phase, mesh.cleatLoopLength);
      const baseIdx = s * cleatsPerSide;
      for (let i = 0; i < cleatsPerSide; i++) {
        layoutTreadCleat(
          mesh.cleats[baseIdx + i],
          phaseOff + i * spacing,
          mesh.treadStraightLength,
          mesh.treadRadius,
          contact.localZ,
        );
      }
    }
  }
}

/** Lay one cleat mesh on the belt loop given its phase distance.
 *  Wraps around: front-top → front-arc → bottom → rear-arc → repeat. */
function layoutTreadCleat(
  cleat: THREE.Mesh,
  distance: number,
  straightLength: number,
  treadRadius: number,
  sideZ: number,
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

  cleat.position.set(x, y, sideZ);
  cleat.rotation.z = angle;
}
