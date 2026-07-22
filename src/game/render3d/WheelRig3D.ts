// WheelRig3D — four real cylindrical tires for wheeled units (jackal,
// mongoose, …). Each tire carries the four canonical visual state
// channels (movement position, movement velocity, rotation position,
// rotation velocity). High/Medium animation plays off body motion — the
// rig never asks "is this tire on the ground?" The floor clamp + lift
// EMA handle position; the angular-velocity EMA handles spin. Low keeps
// only the floor-clamped boxes and rolling-contact samples. Outside
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
  type LocomotionRenderPose,
  type RollingContactState,
  chassisUpFromPose,
  emaAlpha,
  rollingContact,
  rollingLocomotionBodyActive,
  rollingWheelAngularVelocity,
  sampleRollingContactDistance,
  sampleRollingContactPosition,
  transformChassisToWorld,
} from './LocomotionRigShared3D';
import {
  sampleLocomotionPartClamp,
  type LocomotionPartClamp,
} from './LocomotionTerrainSampler';
import { getLocomotionMatByCache } from './RenderUtils';
import {
  createPrimitiveCylinderGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

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

const wheelGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
function getWheelGeom(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  let geometry = wheelGeomByTier.get(tier);
  if (!geometry) {
    geometry = tier === 'far'
      // A square-prism tire is cheap, but its cross-section must retain the
      // cylinder's pi*r^2 area. Unit BoxGeometry would lose ~68% of volume.
      ? new THREE.BoxGeometry(Math.sqrt(Math.PI), 1, Math.sqrt(Math.PI))
      : createPrimitiveCylinderGeometry('locomotion', tier);
    wheelGeomByTier.set(tier, geometry);
  }
  return geometry;
}
const wheelMats = new Map<number, THREE.MeshBasicMaterial>();

/** Per-tire chassis-local mount, plus the four canonical visual state
 *  channels carried across every frame:
 *
 *    movement position  →  `lift`            (chassis-local Y offset
 *                                              above the wheel's
 *                                              natural mount Y)
 *    movement velocity  →  (integrated from lift via the EMA on
 *                            the lift channel; not stored separately)
 *    rotation position  →  `rotation` (mirrored to the tire mesh above Low)
 *    rotation velocity  →  `angularVelocity`  (rad/s around axle)
 *
 *  Position EMAs toward the floor clamp every frame; angular velocity
 *  EMAs toward the body-motion-derived spin rate every frame. */
export type WheelMount = {
  localX: number;
  localZ: number;
  wheelR: number;
  /** Hard attachment envelope. Terrain may request more clearance,
   *  but a tire can never visually leave its suspension travel. */
  maxLift: number;
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
   *  its axle. EMA-couples toward `-signedDistance / dt / wheelR` every
   *  frame so the bottom contact surface moves opposite chassis travel;
   *  rotation integrates from this. */
  angularVelocity: number;
  /** Logical rotation phase, retained across geometry-tier rebuilds even
   *  though the Low box deliberately renders without rotation. */
  rotation: number;
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
  /** False only for the Low box representation. Suspension and rolling
   *  contact sampling remain live, but all spin work is disabled. */
  rotationAnimated: boolean;
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
  geometryTier: PrimitiveGeometryTier = 'close',
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
      const tire = new THREE.Mesh(
        getWheelGeom(geometryTier),
        getLocomotionMatByCache(wheelMats, WHEEL_COLOR, ownerId),
      );
      tire.scale.set(wheelR, tireWidth, wheelR);
      wheelGroup.add(tire);
      group.add(wheelGroup);
      wheelGroups.push(wheelGroup);
      wheels.push(tire);
      wheelMounts.push({
        localX: sx * fx,
        localZ: sz * fz,
        wheelR,
        maxLift: Math.max(1, wheelR * 1.25),
        lift: 0,
        targetLift: 0,
        angularVelocity: 0,
        rotation: 0,
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
    rotationAnimated: geometryTier !== 'far',
    printWidth,
    geometryKey: '',
  };
}

// Scratch reused per frame so the wheel loop never allocates.
const _wheelWorld = { x: 0, y: 0, z: 0 };
const _wheelUp = { x: 0, y: 1, z: 0 };

/** Per-frame: integrate each tire's visual channels forward.
 *  Movement-position (lift) EMA-tracks the floor clamp under the
 *  tire; rotation-velocity (angular velocity) EMA-tracks the
 *  body-motion-derived spin rate. Rotation position integrates from
 *  angular velocity. Low retains suspension/contact work but skips
 *  angular velocity and phase integration entirely. */
export function updateWheels(
  mesh: WheelMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const dtSec = Math.max(0.001, dtMs / 1000);
  // The chassis tilt rotates local Y through the surface normal; lift
  // applied as a local-Y delta moves the wheel approximately by
  // `localLift * normal.z` in world Y. Invert that ratio (with the
  // same 0.35 floor LegRig3D uses) when converting a required world
  // lift back to a local-frame adjustment.
  chassisUpFromPose(pose, _wheelUp);
  const normalY = Math.max(0.35, _wheelUp.y);
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
      pose, _wheelWorld,
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
    const targetLift = Math.min(mount.maxLift, worldLift > 0 ? worldLift / normalY : 0);
    mount.targetLift = targetLift;
    mount.lift += (targetLift - mount.lift) * liftAlpha;
    wheelGroup.position.y = mount.wheelR + mount.lift;

    // ── Rotation-velocity channel: angularVelocity ───────────────
    // Target spin rate is always derived from the per-tire signed
    // chassis-local distance with the no-slip contact sign. Reverse motion comes for free because
    // signedDistance is signed; pivots show opposite spin on opposite
    // wheels because each tire has its own contact and target.
    if (mesh.rotationAnimated) {
      const signedDistance = sampleRollingContactDistance(pose, mesh.wheelContacts[i]);
      const targetOmega = rollingWheelAngularVelocity(
        signedDistance / dtSec,
        mount.wheelR,
      );
      mount.angularVelocity += (targetOmega - mount.angularVelocity) * omegaAlpha;

      // ── Rotation-position channel: tire rotation ───────────────
      // Integrate from the velocity channel.
      mount.rotation += mount.angularVelocity * dtSec;
      mesh.wheels[i].rotation.y = mount.rotation;
    } else {
      sampleRollingContactPosition(pose, mesh.wheelContacts[i]);
      mount.angularVelocity = 0;
      mesh.wheels[i].rotation.y = 0;
    }
  }
  return wheelsNeedFrame(mesh, pose);
}

function wheelsNeedFrame(mesh: WheelMesh, pose: LocomotionRenderPose): boolean {
  if (rollingLocomotionBodyActive(pose)) return true;
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
