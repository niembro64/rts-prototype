// WheelRig3D — four real cylindrical tires for wheeled units (jackal,
// mongoose, …). Each tire is a small simulated object with continuous
// state in the four canonical visual channels (movement position,
// movement velocity, rotation position, rotation velocity). Ground
// contact never overwrites state — it only switches the EMA tau that
// couples the velocity channels toward their in-contact targets
// (lift toward terrain, angular velocity toward body-motion-derived
// spin rate). Off-contact: long tau drag, slow decay. Effect: a tire
// leaving the ground keeps spinning at whatever rate it had and slowly
// loses momentum to air drag; a tire touching down quickly catches up
// to body motion through friction. Neither transition snaps. See the
// "Locomotion Visuals Are Frontend" section of design_philosophy.html.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { WheelConfig } from '@/types/blueprints';
import {
  type LocomotionBase,
  type RollingContactState,
  emaAlpha,
  rollingContact,
  sampleRollingContactDistance,
  transformChassisToWorld,
} from './LocomotionRigShared3D';
import {
  getLocomotionSurfaceNormal,
  sampleLocomotionPartClamp,
} from './LocomotionTerrainSampler';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';

// Movement-position EMA tau for the per-tire suspension lift. Short
// when in contact (terrain pushes the wheel up promptly), longer when
// off (the wheel settles back toward its chassis-natural position
// gently rather than snapping when terrain disappears under it).
const WHEEL_LIFT_TAU_CONTACT_SEC = 0.08;
const WHEEL_LIFT_TAU_FREE_SEC = 0.30;
// Rotation-velocity EMA tau for tire angular velocity. Short when in
// contact so wheels grip body motion tightly; very long when off so an
// airborne tire keeps spinning at its current rate and decays slowly
// via air drag.
const WHEEL_OMEGA_TAU_CONTACT_SEC = 0.04;
const WHEEL_OMEGA_TAU_FREE_SEC = 5.0;

const WHEEL_COLOR = 0x2a2f36;

const wheelGeom = new THREE.CylinderGeometry(1, 1, 1, 12);
const wheelMat = new THREE.MeshBasicMaterial({ color: WHEEL_COLOR });

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
 *  Ground contact never overwrites these. It only switches which tau
 *  the EMA uses to drive the velocity channel toward its target. */
export type WheelMount = {
  localX: number;
  localZ: number;
  wheelR: number;
  /** Per-tire ground-contact flag derived from the floor clamp. True
   *  when the terrain term won the per-frame `max()` — i.e. the tire
   *  is being pushed up by the surface. Used to pick the coupling tau,
   *  not to gate state updates. */
  contact: boolean;
  /** Movement-position channel: chassis-local Y offset added on top of
   *  the baseline mount Y (`wheelR`). EMA'd toward `max(0, terrainLift)`
   *  every frame, so the wheel smoothly rises and falls over terrain
   *  instead of teleporting between in-contact and off-contact heights. */
  lift: number;
  /** Rotation-velocity channel: tire angular velocity in rad/s around
   *  its axle. Always integrated forward; the EMA tau (contact vs free)
   *  determines how aggressively it tracks body motion. */
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
        lift: 0,
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
 *  body-motion-derived target spin rate when in contact and decays
 *  via air drag when not. Rotation position is integrated from
 *  angular velocity. No channel ever snaps at the contact boundary —
 *  only the EMA tau switches. */
export function updateWheels(
  mesh: WheelMesh,
  entity: Entity,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
): void {
  const dtSec = Math.max(0.001, dtMs / 1000);
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

    // ── Movement-position channel: lift ──────────────────────────
    // Target = the world-Y lift the clamp asks for, translated back
    // into chassis-local Y. EMA-converge toward it. On contact the
    // tau is short (terrain pushes the wheel up promptly); off
    // contact the target is 0 and the tau is longer so the wheel
    // settles back toward its mount without a snap.
    const worldLift = clamp.renderedY - naturalWorldY;
    const targetLift = worldLift > 0 ? worldLift / normalY : 0;
    const liftTau = mount.contact ? WHEEL_LIFT_TAU_CONTACT_SEC : WHEEL_LIFT_TAU_FREE_SEC;
    mount.lift += (targetLift - mount.lift) * emaAlpha(dtSec, liftTau);
    wheelGroup.position.y = mount.wheelR + mount.lift;

    // ── Rotation-velocity channel: angularVelocity ───────────────
    // Always advance rolling phase tracking so the contact-point
    // history stays continuous across brief liftoffs; derive the
    // target spin rate from that signed distance only when in
    // contact (ground friction couples toward it). When off contact
    // the target is 0 with a long tau, modeling air drag.
    const signedDistance = sampleRollingContactDistance(entity, mesh.wheelContacts[i]);
    const tireR = Math.max(1, mount.wheelR);
    const targetOmega = mount.contact ? signedDistance / dtSec / tireR : 0;
    const omegaTau = mount.contact ? WHEEL_OMEGA_TAU_CONTACT_SEC : WHEEL_OMEGA_TAU_FREE_SEC;
    mount.angularVelocity += (targetOmega - mount.angularVelocity) * emaAlpha(dtSec, omegaTau);

    // ── Rotation-position channel: tire rotation ─────────────────
    // Integrate from the velocity channel. Reverse motion comes for
    // free because targetOmega is signed; pivots show opposite
    // spin on opposite wheels because each tire has its own signed
    // distance and its own angular velocity.
    mesh.wheels[i].rotation.y += mount.angularVelocity * dtSec;
  }
}
