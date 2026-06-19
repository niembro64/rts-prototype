// WheelRig3D — four real cylindrical tires for wheeled units (jackal,
// mongoose, …). Each tire carries the four canonical visual state
// channels (movement position, movement velocity, rotation position,
// rotation velocity). Animation always plays off body motion — the
// rig never asks "is this tire on the ground?" The floor clamp + lift
// EMA handle position; the angular-velocity EMA handles spin. Outside
// wheels travel farther than inside wheels and can rotate opposite
// directions during a pivot because each tire has its own signed
// chassis-local distance. See the "Locomotion Visuals Are Frontend"
// section of budget_design_philosophy.html.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { Entity, PlayerId } from '../sim/types';
import type { WheelConfig } from '@/types/blueprints';
import {
  type LocomotionBase,
  type RollingContactState,
  emaAlpha,
  rollingContact,
  rollingLocomotionBodyActive,
  sampleRollingContactDistance,
  transformChassisToWorld,
} from './LocomotionRigShared3D';
import {
  getLocomotionSurfaceNormal,
  sampleLocomotionPartClamp,
  type LocomotionPartClamp,
} from './LocomotionTerrainSampler';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';
import { getLocomotionMatByCache } from './RenderUtils';

// Movement-position EMA tau for the per-tire suspension lift. Drives
// the wheel toward the floor-clamp target each frame; long enough
// that terrain undulations read as suspension travel, short enough
// that the wheel doesn't lag behind the chassis on rolling ground.
const WHEEL_LIFT_TAU_SEC = 0.12;
// Rotation-velocity EMA tau for tire angular velocity. Short enough
// that the wheel reads as gripping body motion tightly, long enough
// that a sudden velocity change in the body motion doesn't manifest
// as an instantaneous spin rate change.
const WHEEL_OMEGA_TAU_SEC = 0.04;
const WHEEL_LIFT_SETTLED_EPSILON = 0.02;
const WHEEL_OMEGA_SETTLED_EPSILON = 0.02;

const WHEEL_COLOR = COLORS.units.locomotion.wheel.tire.colorHex;
const _wheelClamp: LocomotionPartClamp = { groundY: 0, renderedY: 0 };

const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const wheelMats = new Map<number, THREE.MeshBasicMaterial>();

/** Per-tire chassis-local mount, plus the four canonical visual state
 *  channels carried across every frame:
 *
 *    movement position  →  `lift`            (chassis-local Y offset
 *                                              above the wheel's
 *                                              natural mount Y)
 *    movement velocity  →  (integrated from lift via the EMA on
 *                            the lift channel; not stored separately)
 *    rotation position  →  `THREE.Mesh.rotation.y` on the tire mesh
 *                          (owned by three.js; integrated below)
 *    rotation velocity  →  `angularVelocity`  (rad/s around axle)
 *
 *  Position EMAs toward the floor clamp every frame; angular velocity
 *  EMAs toward the body-motion-derived spin rate every frame. */
export type WheelMount = {
  localX: number;
  localZ: number;
  wheelR: number;
  /** Movement-position channel: chassis-local Y offset added on top of
   *  the baseline mount Y (`wheelR`). EMA'd toward `max(0, terrainLift)`
   *  every frame, so the wheel smoothly rises and falls over terrain
   *  instead of teleporting when terrain changes under it. */
  lift: number;
  /** Last sampled lift target. Used by the render-side active queue to
   *  stop updating a stationary tire once the EMA has reached the
   *  sampled clamp target. */
  targetLift: number;
  /** Rotation-velocity channel: tire angular velocity in rad/s around
   *  its axle. EMA-couples toward `signedDistance / dt / wheelR` every
   *  frame; rotation integrates from this. */
  angularVelocity: number;
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
  ownerId: PlayerId | undefined,
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
      const tire = new THREE.Mesh(wheelGeom, getLocomotionMatByCache(wheelMats, WHEEL_COLOR, ownerId));
      tire.scale.set(wheelR, tireWidth, wheelR);
      wheelGroup.add(tire);
      group.add(wheelGroup);
      wheelGroups.push(wheelGroup);
      wheels.push(tire);
      wheelMounts.push({
        localX: sx * fx,
        localZ: sz * fz,
        wheelR,
        lift: 0,
        targetLift: 0,
        angularVelocity: 0,
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

/** Per-frame: integrate each tire's four visual channels forward.
 *  Movement-position (lift) EMA-tracks the floor clamp under the
 *  tire; rotation-velocity (angular velocity) EMA-tracks the
 *  body-motion-derived spin rate. Rotation position integrates from
 *  angular velocity. Animation always plays — the rig doesn't check
 *  whether the tire is touching the ground. */
export function updateWheels(
  mesh: WheelMesh,
  entity: Entity,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const dtSec = Math.max(0.001, dtMs / 1000);
  const bodyCenterHeight = entity.unit ? getUnitBodyCenterHeight(entity.unit) : 0;
  // The chassis tilt rotates local Y through the surface normal; lift
  // applied as a local-Y delta moves the wheel approximately by
  // `localLift * normal.z` in world Y. Invert that ratio (with the
  // same 0.35 floor LegRig3D uses) when converting a required world
  // lift back to a local-frame adjustment.
  const n = getLocomotionSurfaceNormal(entity, mapWidth, mapHeight);
  const normalY = Math.max(0.35, n.nz);
  const liftAlpha = emaAlpha(dtSec, WHEEL_LIFT_TAU_SEC);
  const omegaAlpha = emaAlpha(dtSec, WHEEL_OMEGA_TAU_SEC);

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
      entity.id,
      _wheelClamp,
    );

    // ── Movement-position channel: lift ──────────────────────────
    // Target = the world-Y lift the clamp asks for, translated back
    // into chassis-local Y. EMA-converge toward it. When terrain
    // disappears under the wheel, target drops to 0 and the wheel
    // settles back toward its mount over the lift tau instead of
    // teleporting down.
    const worldLift = clamp.renderedY - naturalWorldY;
    const targetLift = worldLift > 0 ? worldLift / normalY : 0;
    mount.targetLift = targetLift;
    mount.lift += (targetLift - mount.lift) * liftAlpha;
    wheelGroup.position.y = mount.wheelR + mount.lift;

    // ── Rotation-velocity channel: angularVelocity ───────────────
    // Target spin rate is always derived from the per-tire signed
    // chassis-local distance. Reverse motion comes for free because
    // signedDistance is signed; pivots show opposite spin on opposite
    // wheels because each tire has its own contact and target.
    const signedDistance = sampleRollingContactDistance(entity, mesh.wheelContacts[i]);
    const tireR = Math.max(1, mount.wheelR);
    const targetOmega = signedDistance / dtSec / tireR;
    mount.angularVelocity += (targetOmega - mount.angularVelocity) * omegaAlpha;

    // ── Rotation-position channel: tire rotation ─────────────────
    // Integrate from the velocity channel.
    mesh.wheels[i].rotation.y += mount.angularVelocity * dtSec;
  }
  return wheelsNeedFrame(mesh, entity);
}

function wheelsNeedFrame(mesh: WheelMesh, entity: Entity): boolean {
  if (rollingLocomotionBodyActive(entity)) return true;
  const count = Math.min(
    mesh.wheels.length,
    mesh.wheelContacts.length,
    mesh.wheelMounts.length,
  );
  for (let i = 0; i < count; i++) {
    const contact = mesh.wheelContacts[i];
    if (contact === undefined || !contact.initialized) return true;
    const mount = mesh.wheelMounts[i];
    if (Math.abs(mount.targetLift - mount.lift) > WHEEL_LIFT_SETTLED_EPSILON) return true;
    if (Math.abs(mount.angularVelocity) > WHEEL_OMEGA_SETTLED_EPSILON) return true;
  }
  return false;
}
