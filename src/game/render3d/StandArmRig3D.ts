// StandArmRig3D — the arms half of `stand` locomotion.
//
// A `stand` unit is a biped: the legs are the ordinary leg rig with one
// authored leftSide entry (mirrored into a pair), and the arms are this. They
// are two limbs of the same machine, so they are made of the same parts — an
// arm allocates out of the SAME LegInstancedRenderer pools a leg does, and
// draws in the same two instanced calls. Nothing here is a second strut
// renderer; if it were, an arm and a leg on one unit would drift apart in
// thickness, chart, tier and fade the first time either pool changed.
//
// What differs is the pose, and only the pose. A leg is solved against the
// ground: it plants, holds, and is dragged forward when the reach envelope
// runs out. An arm touches nothing. It hangs from a fixed shoulder socket on
// the chassis and swings fore/aft off the same stride distance the gait
// already accumulates, counter-phased against the leg on its own side, which
// is what makes a walk read as a walk rather than as a body sliding over two
// stepping poles.

import * as THREE from 'three';
import type { StandArms } from '@/types/blueprintSchema.generated';
import type { PlayerId } from '../sim/types';
import type { LegInstancedRenderer } from './LegInstancedRenderer';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import type { SurfaceChartId } from './SurfaceChart3D';
import {
  transformChassisRootToWorld,
  type LocomotionRenderPose,
} from './LocomotionRigShared3D';
import { locomotionPieceColorHex } from './colorUtils';
import { COLORS } from '@/colorsConfig';

/** Charts for the three surfaces an arm shows. Same roles a leg uses — an arm
 *  strut is the same hydraulic as a leg strut, so it wears the same plating. */
export type StandArmCharts = {
  upper: SurfaceChartId;
  lower: SurfaceChartId;
  joint: SurfaceChartId;
};

export type ArmInstance = {
  /** -1 left, +1 right. Drives both the mirrored shoulder socket and the
   *  half-cycle phase offset against the leg on the same side. */
  side: number;
  /** Shoulder socket in chassis-root space, already mirrored. */
  shoulderX: number;
  shoulderY: number;
  shoulderZ: number;
  upperLength: number;
  lowerLength: number;
  radius: number;
  handRadius: number;
  geometryTier: PrimitiveGeometryTier;
  upperSlot: number;
  lowerSlot: number;
  shoulderJointSlot: number;
  elbowJointSlot: number;
  handSlot: number;
};

export type StandArmRig = {
  arms: ArmInstance[];
  /** Stride phase in radians. Advanced by DISTANCE, not by time, so the swing
   *  stays locked to the feet at any speed and stops dead when the unit does —
   *  the same reason the leg gait integrates distance. */
  phase: number;
  /** Smoothed 0..1 stride amplitude. Ramps the swing in and out so a unit
   *  that starts or stops does not snap its arms to full throw. */
  swing: number;
  restSwingRad: number;
  walkSwingRad: number;
  outwardRad: number;
};

/** Distance one full swing cycle covers, as a multiple of the arm's total
 *  length. A limb's natural cadence scales with its own length — a pendulum
 *  argument, and the reason this is not a fixed world distance that would
 *  make the Commander mince and a smaller biped stride. */
const ARM_CYCLE_LENGTH_RATIO = 2.6;
/** Stride speed at which the swing reaches full amplitude, world units/sec. */
const ARM_FULL_SWING_SPEED = 26;
/** Seconds for the amplitude to close most of the gap to its target. */
const ARM_SWING_EASE_SECONDS = 0.18;
/** How much the elbow leads the shoulder, as a fraction of shoulder swing.
 *  A straight rod swinging from a socket reads as a broom; a forearm that
 *  trails and then catches up reads as an arm. */
const ARM_ELBOW_FOLLOW = 0.45;
/** Constant elbow bend, radians. Arms hang slightly bent, never locked. */
const ARM_ELBOW_BEND_RAD = 0.22;

const _shoulderWorld = { x: 0, y: 0, z: 0 };
const _elbowWorld = { x: 0, y: 0, z: 0 };
const _handWorld = { x: 0, y: 0, z: 0 };
const _localVelocity = new THREE.Vector3();
const _poseQuat = new THREE.Quaternion();
const _segmentQuat = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();

/** Build the mirrored pair of arms for one `stand` unit.
 *
 *  `chassisLiftY` matches the leg rig's: shoulder sockets are authored in the
 *  same footprint-local frame the leg attachments are, so the two limbs stay
 *  in one coordinate system rather than each carrying its own origin. */
export function buildStandArms(
  unitRadius: number,
  cfg: StandArms,
  chassisLiftY: number,
  legRenderer: LegInstancedRenderer,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
  charts?: StandArmCharts,
): StandArmRig {
  const color = locomotionPieceColorHex(COLORS.units.locomotion.leg.segment.colorHex, ownerId);
  const upperLength = unitRadius * cfg.segments.upper.lengthUnitRadiusRatio;
  const lowerLength = unitRadius * cfg.segments.lower.lengthUnitRadiusRatio;
  const chartScale = (upperLength + lowerLength) / Math.max(1, unitRadius);
  const arms: ArmInstance[] = [];

  for (const side of [-1, 1] as const) {
    const arm: ArmInstance = {
      side,
      shoulderX: unitRadius * cfg.shoulder.xUnitRadiusRatio,
      shoulderY: unitRadius * cfg.shoulder.zUnitRadiusRatio - chassisLiftY,
      shoulderZ: side * unitRadius * cfg.shoulder.yUnitRadiusRatio,
      upperLength,
      lowerLength,
      radius: cfg.radius,
      handRadius: cfg.radius * cfg.handRadiusRatio,
      geometryTier,
      upperSlot: -1,
      lowerSlot: -1,
      shoulderJointSlot: -1,
      elbowJointSlot: -1,
      handSlot: -1,
    };
    arm.upperSlot = legRenderer.allocUpper(
      color, (s) => { arm.upperSlot = s; }, geometryTier, charts?.upper, chartScale,
    );
    arm.lowerSlot = legRenderer.allocLower(
      color, (s) => { arm.lowerSlot = s; }, geometryTier, charts?.lower, chartScale,
    );
    arm.shoulderJointSlot = legRenderer.allocJoint(
      color, (s) => { arm.shoulderJointSlot = s; }, geometryTier, charts?.joint, chartScale,
    );
    arm.elbowJointSlot = legRenderer.allocJoint(
      color, (s) => { arm.elbowJointSlot = s; }, geometryTier, charts?.joint, chartScale,
    );
    arm.handSlot = legRenderer.allocFoot(
      color, (s) => { arm.handSlot = s; }, geometryTier, charts?.joint, chartScale,
    );
    arms.push(arm);
  }

  return {
    arms,
    phase: 0,
    swing: 0,
    restSwingRad: THREE.MathUtils.degToRad(cfg.restSwingDeg),
    walkSwingRad: THREE.MathUtils.degToRad(cfg.walkSwingDeg),
    outwardRad: THREE.MathUtils.degToRad(cfg.outwardDeg),
  };
}

/** Advance and write both arms. Called from the same place the legs update, so
 *  the two halves of the biped always see the same frame and the same pose. */
export function updateStandArms(
  rig: StandArmRig,
  pose: LocomotionRenderPose,
  dtMs: number,
  legRenderer: LegInstancedRenderer,
): void {
  const dt = Math.max(0, dtMs) / 1000;
  _poseQuat.set(pose.quaternionX, pose.quaternionY, pose.quaternionZ, pose.quaternionW);
  // Stride is FORWARD travel, not raw speed: a unit sliding sideways or
  // spinning in place is not taking steps, and arms that swung for it would
  // read as a limb with a mind of its own.
  _localVelocity.set(pose.velocityX, pose.velocityY, pose.velocityZ)
    .applyQuaternion(_poseQuat.clone().invert());
  const strideSpeed = Math.abs(_localVelocity.x);

  const first = rig.arms[0];
  const cycleLength = Math.max(
    1e-3,
    (first.upperLength + first.lowerLength) * ARM_CYCLE_LENGTH_RATIO,
  );
  rig.phase = (rig.phase + (strideSpeed * dt / cycleLength) * Math.PI * 2) % (Math.PI * 2);

  const targetSwing = Math.min(1, strideSpeed / ARM_FULL_SWING_SPEED);
  const ease = dt <= 0 ? 1 : 1 - Math.exp(-dt / ARM_SWING_EASE_SECONDS);
  rig.swing += (targetSwing - rig.swing) * ease;

  for (const arm of rig.arms) {
    // Counter-phase: the right arm leads with the left leg. Half a cycle
    // between the sides is what a walk is.
    const sidePhase = rig.phase + (arm.side > 0 ? Math.PI : 0);
    const shoulderPitch =
      rig.restSwingRad + Math.sin(sidePhase) * rig.walkSwingRad * rig.swing;
    const elbowPitch = shoulderPitch * ARM_ELBOW_FOLLOW - ARM_ELBOW_BEND_RAD;
    const roll = arm.side * rig.outwardRad;

    // Chassis-local limb: hangs along -Y, pitched fore/aft (about the lateral
    // axis) and rolled outward from the torso.
    const upperDirX = Math.sin(shoulderPitch) * Math.cos(roll);
    const upperDirY = -Math.cos(shoulderPitch);
    const upperDirZ = Math.sin(roll);
    const elbowX = arm.shoulderX + upperDirX * arm.upperLength;
    const elbowY = arm.shoulderY + upperDirY * arm.upperLength;
    const elbowZ = arm.shoulderZ + upperDirZ * arm.upperLength;

    const lowerDirX = Math.sin(elbowPitch) * Math.cos(roll);
    const lowerDirY = -Math.cos(elbowPitch);
    const lowerDirZ = Math.sin(roll);
    const handX = elbowX + lowerDirX * arm.lowerLength;
    const handY = elbowY + lowerDirY * arm.lowerLength;
    const handZ = elbowZ + lowerDirZ * arm.lowerLength;

    transformChassisRootToWorld(arm.shoulderX, arm.shoulderY, arm.shoulderZ, pose, _shoulderWorld);
    transformChassisRootToWorld(elbowX, elbowY, elbowZ, pose, _elbowWorld);
    transformChassisRootToWorld(handX, handY, handZ, pose, _handWorld);

    writeArmSegment(
      legRenderer, arm.upperSlot, _shoulderWorld, _elbowWorld, arm.radius, arm.geometryTier, true,
    );
    writeArmSegment(
      legRenderer, arm.lowerSlot, _elbowWorld, _handWorld, arm.radius, arm.geometryTier, false,
    );
    legRenderer.updateJoint(
      arm.shoulderJointSlot,
      _shoulderWorld.x, _shoulderWorld.y, _shoulderWorld.z,
      arm.radius * 1.15,
      arm.geometryTier,
    );
    legRenderer.updateJoint(
      arm.elbowJointSlot,
      _elbowWorld.x, _elbowWorld.y, _elbowWorld.z,
      arm.radius,
      arm.geometryTier,
    );
    // The hand takes the forearm's own orientation rather than an upright one:
    // a leg's foot is levelled to the ground it stands on, and an arm has no
    // ground to level against.
    _dir.set(_handWorld.x - _elbowWorld.x, _handWorld.y - _elbowWorld.y, _handWorld.z - _elbowWorld.z);
    if (_dir.lengthSq() < 1e-12) _dir.set(0, -1, 0);
    _segmentQuat.setFromUnitVectors(_up, _dir.normalize());
    legRenderer.updateFoot(
      arm.handSlot,
      _handWorld.x, _handWorld.y, _handWorld.z,
      arm.handRadius,
      _segmentQuat.x, _segmentQuat.y, _segmentQuat.z, _segmentQuat.w,
      arm.geometryTier,
    );
  }
}

function writeArmSegment(
  legRenderer: LegInstancedRenderer,
  slot: number,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  thickness: number,
  tier: PrimitiveGeometryTier,
  upper: boolean,
): void {
  if (slot < 0) return;
  // The pool builds its strut from the endpoints plus a `right` vector that
  // rolls the cross-section. Deriving it from the segment keeps a bent arm's
  // two struts sharing one flat side instead of twisting at the elbow.
  _dir.set(end.x - start.x, end.y - start.y, end.z - start.z);
  if (_dir.lengthSq() < 1e-12) return;
  _dir.normalize();
  _right.set(0, 1, 0).cross(_dir);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  const write = upper ? legRenderer.updateUpper : legRenderer.updateLower;
  write.call(
    legRenderer, slot,
    start.x, start.y, start.z,
    end.x, end.y, end.z,
    thickness,
    _right.x, _right.y, _right.z,
    tier,
  );
}

/** Return every arm slot to the shared pools. Mirrors freeLegSlots — an arm
 *  that kept its slot after the unit died would leak a strut into the next
 *  unit that allocated. */
export function freeStandArmSlots(rig: StandArmRig, legRenderer: LegInstancedRenderer): void {
  for (const arm of rig.arms) {
    legRenderer.freeUpper(arm.upperSlot, arm.geometryTier);
    legRenderer.freeLower(arm.lowerSlot, arm.geometryTier);
    legRenderer.freeJoint(arm.shoulderJointSlot, arm.geometryTier);
    legRenderer.freeJoint(arm.elbowJointSlot, arm.geometryTier);
    legRenderer.freeFoot(arm.handSlot, arm.geometryTier);
  }
}

/** Fade every arm surface with the body it belongs to. */
export function fadeStandArmSlots(
  rig: StandArmRig,
  legRenderer: LegInstancedRenderer,
  fade: number,
): void {
  for (const arm of rig.arms) {
    legRenderer.fadeUpper(arm.upperSlot, fade, arm.geometryTier);
    legRenderer.fadeLower(arm.lowerSlot, fade, arm.geometryTier);
    legRenderer.fadeJoint(arm.shoulderJointSlot, fade, arm.geometryTier);
    legRenderer.fadeJoint(arm.elbowJointSlot, fade, arm.geometryTier);
    legRenderer.fadeFoot(arm.handSlot, fade, arm.geometryTier);
  }
}
