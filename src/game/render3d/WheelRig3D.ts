// WheelRig3D — four real cylindrical tires for wheeled units (jackal,
// mongoose, …). Each tire spins independently from its own
// chassis-local underside contact, so reverse motion stays honest and
// pivot turns show outside wheels rolling faster than inside wheels.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { WheelConfig } from '@/types/blueprints';
import {
  type LocomotionBase,
  type RollingContactState,
  rollingContact,
  sampleRollingContactDistance,
} from './LocomotionRigShared3D';

const WHEEL_COLOR = 0x2a2f36;

const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const wheelMat = new THREE.MeshBasicMaterial({ color: WHEEL_COLOR });

export type WheelMesh = {
  type: 'wheels';
  group: THREE.Group;
  wheels: THREE.Mesh[];
  wheelContacts: RollingContactState[];
  /** Width of the rut a single tire stamps onto the ground, in world
   *  units. Derived from tireWidth at build so GroundPrint3D doesn't
   *  have to re-walk the blueprint to size its quads. */
  printWidth: number;
} & LocomotionBase;

export function buildWheels(
  unitGroup: THREE.Group,
  r: number,
  cfg: WheelConfig,
): WheelMesh {
  // Wheeled units get four real cylindrical wheels — not the four
  // small tread-slabs the previous renderer used. The cylinder's
  // default axis is +Y; we wrap each in a group rotated so the axle
  // points along the unit's lateral (+Z) axis, and the inner mesh
  // spins around its own +Y for the rolling-tire animation when the
  // unit moves.
  const group = new THREE.Group();
  const wheelR = Math.max(1, r * cfg.wheelRadius);
  const tireWidth = Math.max(0.5, r * cfg.treadWidth);
  const fx = r * cfg.wheelDistX;
  const fz = r * cfg.wheelDistY;
  const wheels: THREE.Mesh[] = [];
  const wheelContacts: RollingContactState[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Outer group: position at the wheel mount, lay the cylinder
      // on its side (axle parallel to lateral). Wheel center sits at
      // y = wheelR so the bottom of the tire touches the ground.
      const wheelGroup = new THREE.Group();
      wheelGroup.position.set(sx * fx, wheelR, sz * fz);
      wheelGroup.rotation.x = Math.PI / 2;
      // Inner mesh — the spinning tire. Local +X / +Z scale to wheel
      // radius (the disc face); local +Y scale to tire width (post-
      // rotation, world lateral). Spin animation rotates this mesh
      // around its own +Y, which after the parent's rotation.x is
      // the lateral axis in the unit's frame.
      const tire = new THREE.Mesh(wheelGeom, wheelMat);
      tire.scale.set(wheelR, tireWidth, wheelR);
      wheelGroup.add(tire);
      group.add(wheelGroup);
      wheels.push(tire);
      wheelContacts.push(rollingContact(sx * fx, sz * fz));
    }
  }
  unitGroup.add(group);
  // Rut narrower than the tire — tires squash the soil under their
  // contact patch, not the full slick width.
  const printWidth = Math.max(0.5, tireWidth * 0.65);
  return { type: 'wheels', group, wheels, wheelContacts, printWidth, lodKey: '' };
}

/** Per-frame: each tire rolls from the frame-to-frame motion of its
 *  own chassis-local underside point. Outside wheels travel farther
 *  than inside wheels and can rotate opposite directions during a
 *  pivot. */
export function updateWheels(mesh: WheelMesh, entity: Entity): void {
  const count = Math.min(mesh.wheels.length, mesh.wheelContacts.length);
  for (let i = 0; i < count; i++) {
    const signedDistance = sampleRollingContactDistance(entity, mesh.wheelContacts[i]);
    if (Math.abs(signedDistance) <= 1e-4) continue;
    const wheelR = Math.max(1, mesh.wheels[i].scale.x);
    mesh.wheels[i].rotation.y += signedDistance / wheelR;
  }
}
