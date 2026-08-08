// StandingRig3D — the biped. Two legs, two arms, and nothing borrowed from the
// arachnid leg rig.
//
// WHY NOT `legs`. The leg rig solves a spider: each limb owns a reach shell
// around its own attachment, picks a foot point anywhere inside it, and is
// dragged to a new one when the shell runs out. That is the right model for a
// walker whose legs splay outward and whose knee tracks a point in 3D. It is
// the wrong model for a mech. A mech's leg lives in ONE plane — the vertical
// plane through its own hip, parallel to the hull's forward axis — and its knee
// is a hinge in that plane. Reusing the arachnid solver here bought the legs a
// third degree of freedom they do not have, and it showed: knees swung sideways
// and feet wandered off the line of travel.
//
// So every foot target is authored in that plane, the knee comes out of a 2D
// two-link solve inside it, and the lateral offset of the whole limb is a
// CONSTANT. Sideways motion is not damped here — it is unrepresentable.
//
// THE WALK IS NOT ON A CLOCK. The foothold is the state and the gait is the
// consequence: each foot is placed at a WORLD point and held there, and the
// leg takes a new step when the hip has carried far enough away from it. A
// planted foot is therefore motionless by construction, at any speed and at
// none — no phase counter to agree with, so none to disagree with. It also
// means every way a unit can move produces stepping for free: walking,
// pivoting on the spot, strafing, accelerating, cresting a slope. All of them
// move the hip away from the foothold, which is the only thing being measured.
//
// A phase-driven trajectory was tried first and skated: stance swept the foot
// back through the hull frame by stride×gait while the hull advanced by the
// full stride, so the two agreed only at top speed and the feet slid at every
// speed below it. Turning on the spot moved the chassis centre by nothing at
// all, so the phase froze and the unit spun with its feet welded on.
//
// Only one foot may swing at a time. That rule IS a biped's balance.
//
// UPRIGHT. A biped does not lean into a hill. The hull's terrain tilt is
// cancelled at the pose (see Render3DEntities' upright hosts), so this rig can
// treat chassis-local Y as true vertical, and the only thing a slope changes is
// how far down each foot reaches. That is exactly what a real leg does with a
// hill, and it is why the stance foot is placed at terrain height rather than
// at a fixed depth below the hip.

import * as THREE from 'three';
import type { StandingArms, StandingLegs } from '@/types/blueprintSchema.generated';
import type { PlayerId } from '../sim/types';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import {
  rollingContact,
  sampleRollingContactDistance,
  type LocomotionBase,
  type LocomotionRenderPose,
  type RollingContactState,
} from './LocomotionRigShared3D';
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import { getLocomotionMatByCache } from './RenderUtils';
import { COLORS } from '@/colorsConfig';

const SEGMENT_COLOR = COLORS.units.locomotion.leg.segment.colorHex;
const segmentMaterials = new Map<number, THREE.MeshLambertMaterial>();
const unitBox = new THREE.BoxGeometry(1, 1, 1);

/** One rigid part drawn between two points in the leg's own plane. Boxes, not
 *  cylinders: a commander's limbs are plate and actuator housing, and a box
 *  edge is what makes a knee read as a hinge rather than as a ball. */
type Strut = {
  mesh: THREE.Mesh;
  /** Cross-section, world units. Length comes from the endpoints. */
  width: number;
  depth: number;
};

export type StandingLeg = {
  /** -1 left, +1 right. Fixes the limb's plane; nothing moves it. */
  side: number;
  /** Hip socket, chassis-local. The lateral component never changes. */
  hipX: number;
  hipY: number;
  hipZ: number;
  thighLength: number;
  shinLength: number;
  thigh: Strut;
  shin: Strut;
  knee: THREE.Mesh;
  /** Foot plate plus its two forward toes. */
  foot: THREE.Group;
  /** WHERE THIS FOOT IS, IN THE WORLD. This is the leg's state, and the pose
   *  is derived from it — not the other way round. A planted foot is then
   *  motionless by construction at any speed, including none, and every way a
   *  unit can move (walking, turning on the spot, strafing, accelerating,
   *  cresting a slope) produces stepping for free, because all of them move
   *  the hip away from the foothold. */
  footX: number;
  footY: number;
  footZ: number;
  /** Swing state. A leg is either planted or on its way to a new foothold. */
  stepping: boolean;
  /** 0..1 through the current swing. */
  stepT: number;
  stepSeconds: number;
  fromX: number;
  fromY: number;
  fromZ: number;
  toX: number;
  toY: number;
  toZ: number;
};

export type StandingArm = {
  side: number;
  shoulderX: number;
  shoulderY: number;
  shoulderZ: number;
  upperLength: number;
  forearmLength: number;
  phaseOffset: number;
  upper: Strut;
  forearm: Strut;
  elbow: THREE.Mesh;
  /** Where the forearm ends, chassis-local. The turret mounted on this arm is
   *  what the commander holds there — the rig draws no hand of its own, because
   *  a fist on the end of a weapon arm is one lump too many. */
  handX: number;
  handY: number;
};

export type StandingMesh = {
  type: 'standing';
  group: THREE.Group;
  /** The legs hang off this, and it yaws INSIDE the hull.
   *
   *  A commander keeps its torso — and therefore its weapons — pointed at what
   *  it is shooting or building while its legs go somewhere else entirely. The
   *  hull carries the facing; the hips carry the walk. Everything the rig does
   *  in a leg's plane is unchanged, because the plane turns with the hips. */
  hips: THREE.Group;
  hipYaw: number;
  legs: StandingLeg[];
  arms: StandingArm[];
  /** Ground distance. Used only to size a swing and to swing the arms — the
   *  legs are driven by where their feet are, not by a clock. */
  contact: RollingContactState;
  /** Arm swing phase in cycles, 0..1. Advanced by ground distance so the arms
   *  stay locked to the walk. */
  phase: number;
  /** Smoothed 0..1 walk amplitude for the arms. */
  gait: number;
  /** How far apart consecutive footholds are placed. */
  stepLength: number;
  strideLift: number;
  /** Nominal hip height above the sole, from standHeightRatio. Sets where a
   *  foothold is placed and keeps the solve inside the leg's reach. */
  standHipY: number;
  /** Which leg may swing next. A biped never lifts both feet. */
  swingingLeg: number;
  armSwingRad: number;
  armRestRad: number;
} & LocomotionBase;

/** Shortest and longest a swing may take, seconds. Between them the swing
 *  lasts as long as the hull needs to cover half a step, so a slow walk places
 *  its feet slowly and a run snaps them down. */
const SWING_MIN_SECONDS = 0.14;
const SWING_MAX_SECONDS = 0.55;
/** Knee flex held at a standstill, radians. A locked-straight leg reads as a
 *  stilt; every mech stands with a little bend in it. */
const STAND_KNEE_BEND_RAD = 0.16;
/** A foothold further than this from where the leg wants it, as a fraction of
 *  the step length, is overdue and the leg picks a new one. */
const STEP_TRIGGER_FRACTION = 0.4;
/** Seconds for the arm swing amplitude to ease in and out. */
const GAIT_EASE_SECONDS = 0.16;
/** Ground speed at which the arms reach full swing, world units/sec. */
const ARM_FULL_SWING_SPEED = 22;
/** How far the elbow follows the shoulder, as a fraction of shoulder swing. */
const ELBOW_FOLLOW = 0.4;
/** Constant elbow flex, radians. */
const ELBOW_BEND_RAD = 0.3;
/** Seconds for the hips to swing most of the way to the travel heading. Slow
 *  enough that a commander turning on the spot pivots rather than snapping. */
const HIP_YAW_EASE_SECONDS = 0.22;
/** Below this speed there is no travel direction to point the hips at, so they
 *  square back up under the torso. */
const HIP_YAW_MIN_SPEED = 3;

const _hip = new THREE.Vector2();
const _foot = new THREE.Vector2();
const _knee = new THREE.Vector2();
const _chord = new THREE.Vector2();
const _hipWorld = new THREE.Vector3();
const _stepTarget = new THREE.Vector3();
const _footLocal = new THREE.Vector3();
const _localVelocity = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();
const _poseQuat = new THREE.Quaternion();
const _segDir = new THREE.Vector3();
const _segQuat = new THREE.Quaternion();
const _segUp = new THREE.Vector3(0, 1, 0);

/** Chassis-local (already hip-yawed) → world. */
function toWorld(
  lx: number, ly: number, lz: number,
  pose: LocomotionRenderPose, hipYaw: number,
  out: THREE.Vector3,
): void {
  const cos = Math.cos(hipYaw);
  const sin = Math.sin(hipYaw);
  out.set(lx * cos + lz * sin, ly, -lx * sin + lz * cos);
  _poseQuat.set(pose.quaternionX, pose.quaternionY, pose.quaternionZ, pose.quaternionW);
  out.applyQuaternion(_poseQuat);
  out.x += pose.rootX;
  out.y += pose.rootY;
  out.z += pose.rootZ;
}

/** World → chassis-local, then out of the hips' own yaw. The exact inverse of
 *  toWorld, so a foothold survives the round trip. */
function toHipLocal(
  wx: number, wy: number, wz: number,
  pose: LocomotionRenderPose, hipYaw: number,
  out: THREE.Vector3,
): void {
  out.set(wx - pose.rootX, wy - pose.rootY, wz - pose.rootZ);
  _poseQuat.set(pose.quaternionX, pose.quaternionY, pose.quaternionZ, pose.quaternionW);
  out.applyQuaternion(_poseQuat.invert());
  const cos = Math.cos(-hipYaw);
  const sin = Math.sin(-hipYaw);
  const x = out.x;
  const z = out.z;
  out.x = x * cos + z * sin;
  out.z = -x * sin + z * cos;
}

/** Put a foot on the ground directly under its hip. Used on the first frame
 *  and by the rest pose, so a unit never starts with its feet at the origin. */
function plantUnderHip(
  leg: StandingLeg,
  mesh: StandingMesh,
  pose: LocomotionRenderPose,
  mapWidth: number,
  mapHeight: number,
): void {
  toWorld(leg.hipX, leg.hipY, leg.hipZ, pose, mesh.hipYaw, _stepTarget);
  leg.footX = _stepTarget.x;
  leg.footZ = _stepTarget.z;
  leg.footY = getLocomotionSurfaceHeight(leg.footX, leg.footZ, mapWidth, mapHeight, 0);
  leg.stepping = false;
  leg.stepT = 0;
}

function material(ownerId: PlayerId | undefined): THREE.MeshLambertMaterial {
  return getLocomotionMatByCache(segmentMaterials, SEGMENT_COLOR, ownerId);
}

function makeStrut(
  parent: THREE.Group,
  width: number,
  depth: number,
  ownerId: PlayerId | undefined,
): Strut {
  const mesh = new THREE.Mesh(unitBox, material(ownerId));
  parent.add(mesh);
  return { mesh, width, depth };
}

function makeBlock(
  parent: THREE.Group,
  sx: number, sy: number, sz: number,
  ownerId: PlayerId | undefined,
): THREE.Mesh {
  const mesh = new THREE.Mesh(unitBox, material(ownerId));
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}

/** The commander's foot: a thin sole plate with two forward toes.
 *
 *  Deliberately flat. The shin is the thick part of a mech leg; a foot that
 *  matched it would read as a boot, and BAR's commander stands on plates it
 *  could slide under a door. */
function makeFoot(
  parent: THREE.Group,
  length: number,
  width: number,
  ownerId: PlayerId | undefined,
): THREE.Group {
  const group = new THREE.Group();
  const height = Math.max(0.35, width * 0.16);
  const sole = makeBlock(group, length * 0.56, height, width * 0.9, ownerId);
  sole.position.set(-length * 0.16, height * 0.5, 0);
  for (const side of [-1, 1] as const) {
    const toe = makeBlock(group, length * 0.56, height * 0.8, width * 0.34, ownerId);
    toe.position.set(length * 0.40, height * 0.45, side * width * 0.30);
  }
  // A low heel spur, so the plate does not look like it is floating.
  const heel = makeBlock(group, length * 0.16, height * 1.5, width * 0.5, ownerId);
  heel.position.set(-length * 0.40, height * 0.75, 0);
  parent.add(group);
  return group;
}

/** Point a strut from `a` to `b` and stretch it to span them. */
function poseStrut(strut: Strut, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  _segDir.set(bx - ax, by - ay, bz - az);
  const length = _segDir.length();
  if (length < 1e-5) return;
  _segDir.divideScalar(length);
  _segQuat.setFromUnitVectors(_segUp, _segDir);
  strut.mesh.quaternion.copy(_segQuat);
  strut.mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  strut.mesh.scale.set(strut.width, length, strut.depth);
}

/**
 * Two-link solve in the leg's own vertical plane.
 *
 * The knee is placed on the FORWARD side of the hip→foot chord, which is the
 * only choice a knee has: it is a hinge, and a hinge that could pick either
 * side would snap through straight whenever the leg passed under the hip.
 */
function solveKnee(
  hipX: number, hipY: number,
  footX: number, footY: number,
  thigh: number, shin: number,
  out: THREE.Vector2,
): void {
  _hip.set(hipX, hipY);
  _foot.set(footX, footY);
  _chord.subVectors(_foot, _hip);
  const span = Math.max(1e-4, _chord.length());
  // Clamped so a foot placed further than the leg reaches straightens it
  // instead of producing a NaN, and one placed too close folds rather than
  // inverting.
  const reach = Math.min(Math.max(span, Math.abs(thigh - shin) + 1e-3), thigh + shin - 1e-3);
  const cos = Math.min(1, Math.max(-1, (thigh * thigh + reach * reach - shin * shin) / (2 * thigh * reach)));
  const angle = Math.acos(cos);
  const chordAngle = Math.atan2(_chord.y, _chord.x);
  // +angle rotates the thigh towards +X, which is forward.
  const kneeAngle = chordAngle + angle;
  out.set(hipX + Math.cos(kneeAngle) * thigh, hipY + Math.sin(kneeAngle) * thigh);
}

export function buildStandingRig(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfgLegs: StandingLegs,
  cfgArms: StandingArms,
  chassisLiftY: number,
  ownerId: PlayerId | undefined,
  _geometryTier: PrimitiveGeometryTier = 'close',
): StandingMesh {
  const group = new THREE.Group();
  unitGroup.add(group);
  const hips = new THREE.Group();
  group.add(hips);

  const thighLength = unitRadius * cfgLegs.segments.upper.lengthUnitRadiusRatio;
  const shinLength = unitRadius * cfgLegs.segments.lower.lengthUnitRadiusRatio;
  const legLength = thighLength + shinLength;
  const legWidth = cfgLegs.radius;
  const footLength = legLength * cfgLegs.footLengthRatio;
  const footWidth = legWidth * cfgLegs.footWidthRatio;

  const legs: StandingLeg[] = [];
  for (const side of [-1, 1] as const) {
    const leg: StandingLeg = {
      side,
      hipX: unitRadius * cfgLegs.hip.xUnitRadiusRatio,
      hipY: unitRadius * cfgLegs.hip.zUnitRadiusRatio - chassisLiftY,
      hipZ: side * unitRadius * cfgLegs.hip.yUnitRadiusRatio,
      thighLength,
      shinLength,
      // Left leads. Half a cycle is the whole of what makes a walk a walk.
      thigh: makeStrut(hips, legWidth, legWidth * 0.82, ownerId),
      shin: makeStrut(hips, legWidth * 0.78, legWidth * 0.66, ownerId),
      knee: makeBlock(hips, legWidth * 0.95, legWidth * 0.95, legWidth * 0.9, ownerId),
      foot: makeFoot(hips, footLength, footWidth, ownerId),
      footX: 0,
      footY: 0,
      footZ: 0,
      stepping: false,
      stepT: 0,
      stepSeconds: SWING_MIN_SECONDS,
      fromX: 0, fromY: 0, fromZ: 0,
      toX: 0, toY: 0, toZ: 0,
    };
    legs.push(leg);
  }

  const upperLength = unitRadius * cfgArms.segments.upper.lengthUnitRadiusRatio;
  const forearmLength = unitRadius * cfgArms.segments.lower.lengthUnitRadiusRatio;
  const armWidth = cfgArms.radius;
  const arms: StandingArm[] = [];
  for (const side of [-1, 1] as const) {
    arms.push({
      side,
      shoulderX: unitRadius * cfgArms.shoulder.xUnitRadiusRatio,
      shoulderY: unitRadius * cfgArms.shoulder.zUnitRadiusRatio - chassisLiftY,
      shoulderZ: side * unitRadius * cfgArms.shoulder.yUnitRadiusRatio,
      upperLength,
      forearmLength,
      // Opposite the leg on the same side.
      phaseOffset: side < 0 ? 0.5 : 0,
      upper: makeStrut(group, armWidth, armWidth * 0.9, ownerId),
      forearm: makeStrut(group, armWidth * 0.86, armWidth * 0.78, ownerId),
      elbow: makeBlock(group, armWidth * 0.92, armWidth * 0.92, armWidth * 0.86, ownerId),
      handX: 0,
      handY: 0,
    });
  }

  return {
    type: 'standing',
    group,
    hips,
    hipYaw: 0,
    legs,
    arms,
    contact: rollingContact(0, 0),
    phase: 0,
    gait: 0,
    stepLength: Math.max(1, legLength * cfgLegs.strideLengthRatio),
    strideLift: Math.max(0.5, legLength * cfgLegs.strideLiftRatio),
    standHipY: legLength * cfgLegs.standHeightRatio,
    swingingLeg: -1,
    armSwingRad: THREE.MathUtils.degToRad(cfgArms.walkSwingDeg),
    armRestRad: THREE.MathUtils.degToRad(cfgArms.restSwingDeg),
    geometryKey: '',
  };
}

export function updateStandingRig(
  mesh: StandingMesh,
  pose: LocomotionRenderPose,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const dt = Math.max(0, dtMs) / 1000;
  const travelled = sampleRollingContactDistance(pose, mesh.contact);
  const speed = dt > 0 ? Math.abs(travelled) / dt : 0;

  // HIPS. The hull faces what the commander is aiming at or building; the legs
  // walk wherever the order sent them. Yaw the hip group by the angle between
  // the two — the leg planes turn with it, so every solve below is unchanged.
  //
  // The local velocity comes off the inverse pose quaternion, the way every
  // other rig does it. Hand-rolling the 2D rotation is what put a sign error
  // in both components and turned the hips the wrong way.
  _poseQuat.set(pose.quaternionX, pose.quaternionY, pose.quaternionZ, pose.quaternionW);
  _localVelocity.set(pose.velocityX, pose.velocityY, pose.velocityZ)
    .applyQuaternion(_invQuat.copy(_poseQuat).invert());
  const planarSpeed = Math.hypot(_localVelocity.x, _localVelocity.z);
  const targetHipYaw = planarSpeed > HIP_YAW_MIN_SPEED
    ? Math.atan2(-_localVelocity.z, _localVelocity.x)
    : 0;
  const hipEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / HIP_YAW_EASE_SECONDS);
  let hipDelta = targetHipYaw - mesh.hipYaw;
  while (hipDelta > Math.PI) hipDelta -= Math.PI * 2;
  while (hipDelta < -Math.PI) hipDelta += Math.PI * 2;
  mesh.hipYaw += hipDelta * hipEase;
  mesh.hips.rotation.y = mesh.hipYaw;

  const gaitEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / GAIT_EASE_SECONDS);
  mesh.gait += (Math.min(1, speed / ARM_FULL_SWING_SPEED) - mesh.gait) * gaitEase;
  mesh.phase = (mesh.phase + travelled / Math.max(1, mesh.stepLength * 2)) % 1;
  if (mesh.phase < 0) mesh.phase += 1;

  const swingSeconds = Math.min(
    SWING_MAX_SECONDS,
    Math.max(SWING_MIN_SECONDS, speed > 0.01 ? (mesh.stepLength * 0.5) / speed : SWING_MAX_SECONDS),
  );

  for (let i = 0; i < mesh.legs.length; i++) {
    const leg = mesh.legs[i];

    // Where this leg WANTS its foot: under its own hip, in its own plane.
    toWorld(leg.hipX, leg.hipY, leg.hipZ, pose, mesh.hipYaw, _hipWorld);

    if (!leg.stepping && leg.footX === 0 && leg.footY === 0 && leg.footZ === 0) {
      // First frame: plant where the leg already stands.
      plantUnderHip(leg, mesh, pose, mapWidth, mapHeight);
    }

    if (leg.stepping) {
      leg.stepT = Math.min(1, leg.stepT + (leg.stepSeconds > 0 ? dt / leg.stepSeconds : 1));
      const t = leg.stepT;
      const arc = Math.sin(Math.PI * t) * mesh.strideLift;
      leg.footX = leg.fromX + (leg.toX - leg.fromX) * t;
      leg.footZ = leg.fromZ + (leg.toZ - leg.fromZ) * t;
      leg.footY = leg.fromY + (leg.toY - leg.fromY) * t + arc;
      if (t >= 1) {
        leg.stepping = false;
        leg.footX = leg.toX;
        leg.footY = leg.toY;
        leg.footZ = leg.toZ;
        if (mesh.swingingLeg === i) mesh.swingingLeg = -1;
      }
    } else {
      // REACH, not a clock. The foothold is judged against where the hip now
      // is; anything that moved the hip — walking, pivoting, strafing, a
      // slope — shows up here as the same overdue distance.
      const dx = _hipWorld.x - leg.footX;
      const dz = _hipWorld.z - leg.footZ;
      const overdue = Math.hypot(dx, dz) > mesh.stepLength * STEP_TRIGGER_FRACTION;
      // One foot at a time. That rule IS a biped's balance.
      if (overdue && mesh.swingingLeg === -1) {
        mesh.swingingLeg = i;
        leg.stepping = true;
        leg.stepT = 0;
        leg.stepSeconds = swingSeconds;
        leg.fromX = leg.footX;
        leg.fromY = leg.footY;
        leg.fromZ = leg.footZ;
        // Land half a step PAST the hip along the direction of travel, so the
        // hip catches up to it and passes it again — which is what walking is.
        const lead = mesh.stepLength * 0.5;
        toWorld(leg.hipX + lead, leg.hipY, leg.hipZ, pose, mesh.hipYaw, _stepTarget);
        leg.toX = _stepTarget.x;
        leg.toZ = _stepTarget.z;
        leg.toY = getLocomotionSurfaceHeight(leg.toX, leg.toZ, mapWidth, mapHeight, 0);
      }
    }

    // Pose from the foothold. Back into the leg's own plane, where the knee is
    // a hinge and nothing has a third axis to wander along.
    toHipLocal(leg.footX, leg.footY, leg.footZ, pose, mesh.hipYaw, _footLocal);
    solveKnee(leg.hipX, leg.hipY, _footLocal.x, _footLocal.y, leg.thighLength, leg.shinLength, _knee);
    poseStrut(leg.thigh, leg.hipX, leg.hipY, leg.hipZ, _knee.x, _knee.y, leg.hipZ);
    poseStrut(leg.shin, _knee.x, _knee.y, leg.hipZ, _footLocal.x, _footLocal.y, leg.hipZ);
    leg.knee.position.set(_knee.x, _knee.y, leg.hipZ);
    // Flat sole, square to the hips: a mech plants its foot, it does not point
    // its toes the way a free-swinging limb would.
    leg.foot.position.set(_footLocal.x, _footLocal.y, leg.hipZ);
  }

  for (const arm of mesh.arms) {
    const p = (mesh.phase + arm.phaseOffset) % 1;
    const shoulderPitch = mesh.armRestRad + Math.sin(p * Math.PI * 2) * mesh.armSwingRad * mesh.gait;
    const elbowPitch = shoulderPitch * ELBOW_FOLLOW - ELBOW_BEND_RAD;
    const elbowX = arm.shoulderX + Math.sin(shoulderPitch) * arm.upperLength;
    const elbowY = arm.shoulderY - Math.cos(shoulderPitch) * arm.upperLength;
    const handX = elbowX + Math.sin(elbowPitch) * arm.forearmLength;
    const handY = elbowY - Math.cos(elbowPitch) * arm.forearmLength;
    poseStrut(arm.upper, arm.shoulderX, arm.shoulderY, arm.shoulderZ, elbowX, elbowY, arm.shoulderZ);
    poseStrut(arm.forearm, elbowX, elbowY, arm.shoulderZ, handX, handY, arm.shoulderZ);
    arm.elbow.position.set(elbowX, elbowY, arm.shoulderZ);
    arm.handX = handX;
    arm.handY = handY;
  }

  return true;
}

/** Standstill pose, for a preview card or a unit built before its first tick. */
export function poseStandingRigAtRest(mesh: StandingMesh): void {
  for (const leg of mesh.legs) {
    // standHipY is the authored stance height, so the knee keeps the bend the
    // blueprint asked for instead of locking straight at full extension.
    const footY = leg.hipY - Math.cos(STAND_KNEE_BEND_RAD) * mesh.standHipY;
    solveKnee(leg.hipX, leg.hipY, leg.hipX, footY, leg.thighLength, leg.shinLength, _knee);
    poseStrut(leg.thigh, leg.hipX, leg.hipY, leg.hipZ, _knee.x, _knee.y, leg.hipZ);
    poseStrut(leg.shin, _knee.x, _knee.y, leg.hipZ, leg.hipX, footY, leg.hipZ);
    leg.knee.position.set(_knee.x, _knee.y, leg.hipZ);
    leg.foot.position.set(leg.hipX, footY, leg.hipZ);
  }
  for (const arm of mesh.arms) {
    const elbowX = arm.shoulderX + Math.sin(mesh.armRestRad) * arm.upperLength;
    const elbowY = arm.shoulderY - Math.cos(mesh.armRestRad) * arm.upperLength;
    const pitch = mesh.armRestRad * ELBOW_FOLLOW - ELBOW_BEND_RAD;
    const handX = elbowX + Math.sin(pitch) * arm.forearmLength;
    const handY = elbowY - Math.cos(pitch) * arm.forearmLength;
    poseStrut(arm.upper, arm.shoulderX, arm.shoulderY, arm.shoulderZ, elbowX, elbowY, arm.shoulderZ);
    poseStrut(arm.forearm, elbowX, elbowY, arm.shoulderZ, handX, handY, arm.shoulderZ);
    arm.elbow.position.set(elbowX, elbowY, arm.shoulderZ);
    arm.handX = handX;
    arm.handY = handY;
  }
}

export function disposeStandingRigGeometry(): void {
  unitBox.dispose();
  for (const mat of segmentMaterials.values()) mat.dispose();
  segmentMaterials.clear();
}
