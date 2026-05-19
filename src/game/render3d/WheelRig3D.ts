// WheelRig3D — four real cylindrical tires for wheeled units (jackal,
// mongoose, …). Each tire spins independently from its own
// chassis-local underside contact, so reverse motion stays honest and
// pivot turns show outside wheels rolling faster than inside wheels.
// Each tire is also independently clamped above terrain per frame: the
// rendered wheel never tunnels through ground, and the tire only spins
// when it is actually in contact with the surface. See the "Locomotion
// Visuals Are Frontend" section of design_philosophy.html.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { WheelConfig } from '@/types/blueprints';
import {
  type LocomotionBase,
  type RollingContactState,
  rollingContact,
  sampleRollingContactDistance,
  transformChassisToWorld,
} from './LocomotionRigShared3D';
import {
  getLocomotionSurfaceNormal,
  sampleLocomotionPartClamp,
} from './LocomotionTerrainSampler';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';

const WHEEL_COLOR = 0x2a2f36;

const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const wheelMat = new THREE.MeshBasicMaterial({ color: WHEEL_COLOR });

/** Per-tire chassis-local mount in (localX, localZ) plus the wheel
 *  radius (chassis-local Y of the tire center on flat ground). The
 *  rig holds one entry per tire so the per-frame floor clamp can
 *  re-derive the natural world position without re-reading the
 *  three.js group. */
export type WheelMount = {
  localX: number;
  localZ: number;
  wheelR: number;
  /** Per-tire ground-contact flag derived from the floor clamp.
   *  True when the terrain term won the per-frame `max()` — i.e.
   *  the tire is resting on the surface, not floating above it.
   *  Spin advances only while this is true. */
  contact: boolean;
};

export type WheelMesh = {
  type: 'wheels';
  group: THREE.Group;
  /** Each tire's outer group — owns chassis-local position. Local Y
   *  is rewritten every frame by the floor clamp so the tire bottom
   *  rests on terrain. */
  wheelGroups: THREE.Group[];
  wheels: THREE.Mesh[];
  wheelMounts: WheelMount[];
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
  const wheelGroups: THREE.Group[] = [];
  const wheels: THREE.Mesh[] = [];
  const wheelMounts: WheelMount[] = [];
  const wheelContacts: RollingContactState[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      // Outer group: position at the wheel mount, lay the cylinder
      // on its side (axle parallel to lateral). Wheel center sits at
      // y = wheelR so the bottom of the tire touches the ground —
      // baseline before the per-frame floor clamp lifts it further to
      // ride terrain.
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
      wheelGroups.push(wheelGroup);
      wheels.push(tire);
      wheelMounts.push({
        localX: sx * fx,
        localZ: sz * fz,
        wheelR,
        contact: true,
      });
      wheelContacts.push(rollingContact(sx * fx, sz * fz));
    }
  }
  unitGroup.add(group);
  // Rut narrower than the tire — tires squash the soil under their
  // contact patch, not the full slick width.
  const printWidth = Math.max(0.5, tireWidth * 0.65);
  return {
    type: 'wheels',
    group,
    wheelGroups,
    wheels,
    wheelMounts,
    wheelContacts,
    printWidth,
    geometryKey: '',
  };
}

// Scratch reused per frame so the wheel loop never allocates.
const _wheelWorld = { x: 0, y: 0, z: 0 };

/** Per-frame: floor-clamp each tire above terrain, then advance its
 *  spin from the frame-to-frame motion of its own chassis-local
 *  underside point — but only while that tire is in contact with the
 *  ground. Outside wheels travel farther than inside wheels and can
 *  rotate opposite directions during a pivot; airborne wheels freeze
 *  instead of pretending to spin against nothing. */
export function updateWheels(
  mesh: WheelMesh,
  entity: Entity,
  mapWidth: number,
  mapHeight: number,
): void {
  const bodyCenterHeight = entity.unit ? getUnitBodyCenterHeight(entity.unit) : 0;
  // The chassis tilt rotates local Y through the surface normal; lift
  // applied as a local-Y delta moves the wheel approximately by
  // `localLift * normal.z` in world Y. Invert that ratio (with the
  // same 0.35 floor LegRig3D uses) when converting a required world
  // lift back to a local-frame adjustment.
  const n = getLocomotionSurfaceNormal(entity, mapWidth, mapHeight);
  const normalY = Math.max(0.35, n.nz);

  const count = Math.min(mesh.wheels.length, mesh.wheelContacts.length);
  for (let i = 0; i < count; i++) {
    const mount = mesh.wheelMounts[i];
    const wheelGroup = mesh.wheelGroups[i];

    // Natural world position of the tire center if we left the local
    // Y at its baseline (mount.wheelR). transformChassisToWorld bakes
    // in the unit's tilt, yaw, and suspension offsets.
    transformChassisToWorld(
      mount.localX, mount.wheelR, mount.localZ,
      entity, bodyCenterHeight, mapWidth, mapHeight, _wheelWorld,
    );
    const naturalWorldY = _wheelWorld.y;
    // Sample terrain at the tire's world XZ and clamp: tire center
    // must sit at least `wheelR` above ground.
    const clamp = sampleLocomotionPartClamp(
      _wheelWorld.x, _wheelWorld.z,
      naturalWorldY, mount.wheelR,
      mapWidth, mapHeight,
    );
    mount.contact = clamp.contact;

    // Translate the world-Y lift back into a chassis-local Y offset
    // applied on top of the wheel's baseline mount.
    const worldLift = clamp.renderedY - naturalWorldY;
    const localLift = worldLift > 0 ? worldLift / normalY : 0;
    wheelGroup.position.y = mount.wheelR + localLift;

    // Spin gating: track rolling phase always (so the phase stays
    // consistent across brief liftoffs), but only advance the visible
    // rotation while the tire is touching ground. Airborne tires
    // freeze in place.
    const signedDistance = sampleRollingContactDistance(entity, mesh.wheelContacts[i]);
    if (!mount.contact) continue;
    if (Math.abs(signedDistance) <= 1e-4) continue;
    const tireR = Math.max(1, mesh.wheels[i].scale.x);
    mesh.wheels[i].rotation.y += signedDistance / tireR;
  }
}
