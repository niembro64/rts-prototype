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
// THE WALK. One cycle is one stride length of ground covered, so the phase is
// integrated from ground distance, not from time: a mech pushed backwards walks
// backwards, and a stopped one stops with its feet down. Each leg spends half
// the cycle in stance — foot fixed to the ground, travelling backwards through
// the hull's frame at exactly the speed the hull travels forwards, which is
// what stops the feet skating — and half in swing, lifted along an arc to the
// next footfall. The legs are half a cycle apart; the arms take the leg phase
// on the opposite side, which is what a walk is.
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
  /** Half a cycle apart from its opposite number. */
  phaseOffset: number;
  thigh: Strut;
  shin: Strut;
  knee: THREE.Mesh;
  /** Foot plate plus its two forward prongs — the splayed commander foot. */
  foot: THREE.Group;
  /** Where this foot is planted, chassis-local. Held through stance. */
  plantX: number;
  plantY: number;
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
  /** Ground distance, the only clock this rig has. */
  contact: RollingContactState;
  /** Stride phase in cycles, 0..1. */
  phase: number;
  /** Smoothed 0..1 stride amplitude, so starting and stopping eases. */
  gait: number;
  strideLength: number;
  strideLift: number;
  standHipY: number;
  armSwingRad: number;
  armRestRad: number;
} & LocomotionBase;

/** Seconds for the gait amplitude to close most of the gap to its target. */
const GAIT_EASE_SECONDS = 0.16;
/** Ground speed at which the walk reaches full stride, world units/sec. */
const FULL_STRIDE_SPEED = 22;
/** Knee flex held at a standstill, radians. A locked-straight leg reads as a
 *  stilt; every mech stands with a little bend in it. */
const STAND_KNEE_BEND_RAD = 0.16;
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
const _worldFoot = new THREE.Vector3();
const _poseQuat = new THREE.Quaternion();
const _segDir = new THREE.Vector3();
const _segQuat = new THREE.Quaternion();
const _segUp = new THREE.Vector3(0, 1, 0);

/** The hull's yaw about world up. Upright hosts have no other rotation. */
function yawOf(pose: LocomotionRenderPose): number {
  return Math.atan2(
    2 * (pose.quaternionW * pose.quaternionY + pose.quaternionX * pose.quaternionZ),
    1 - 2 * (pose.quaternionY * pose.quaternionY + pose.quaternionZ * pose.quaternionZ),
  );
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
      phaseOffset: side < 0 ? 0 : 0.5,
      thigh: makeStrut(hips, legWidth, legWidth * 0.82, ownerId),
      shin: makeStrut(hips, legWidth * 0.78, legWidth * 0.66, ownerId),
      knee: makeBlock(hips, legWidth * 0.95, legWidth * 0.95, legWidth * 0.9, ownerId),
      foot: makeFoot(hips, footLength, footWidth, ownerId),
      plantX: 0,
      plantY: 0,
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
    strideLength: Math.max(1, legLength * cfgLegs.strideLengthRatio),
    strideLift: Math.max(0.5, legLength * cfgLegs.strideLiftRatio),
    standHipY: legLength * cfgLegs.standHeightRatio,
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
  // Ground distance drives the cycle, so the feet cannot outrun the hull.
  const travelled = sampleRollingContactDistance(pose, mesh.contact);
  mesh.phase = (mesh.phase + travelled / mesh.strideLength) % 1;
  if (mesh.phase < 0) mesh.phase += 1;

  const speed = dt > 0 ? Math.abs(travelled) / dt : 0;

  // HIPS. The hull faces what the commander is aiming at or building; the legs
  // have to walk wherever the order sent them. Yaw the hip group by the angle
  // between the two, which is the whole of what lets the torso spin free: the
  // leg planes turn with it, so every solve below is unchanged.
  const localVX = pose.velocityX * Math.cos(-yawOf(pose)) - pose.velocityZ * Math.sin(-yawOf(pose));
  const localVZ = pose.velocityX * Math.sin(-yawOf(pose)) + pose.velocityZ * Math.cos(-yawOf(pose));
  const planarSpeed = Math.hypot(localVX, localVZ);
  const targetHipYaw = planarSpeed > HIP_YAW_MIN_SPEED ? Math.atan2(-localVZ, localVX) : 0;
  const hipEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / HIP_YAW_EASE_SECONDS);
  let hipDelta = targetHipYaw - mesh.hipYaw;
  while (hipDelta > Math.PI) hipDelta -= Math.PI * 2;
  while (hipDelta < -Math.PI) hipDelta += Math.PI * 2;
  mesh.hipYaw += hipDelta * hipEase;
  mesh.hips.rotation.y = mesh.hipYaw;
  const ease = dt <= 0 ? 1 : 1 - Math.exp(-dt / GAIT_EASE_SECONDS);
  mesh.gait += (Math.min(1, speed / FULL_STRIDE_SPEED) - mesh.gait) * ease;

  // The hull is posed upright, so its yaw alone maps the leg plane into the
  // world. Terrain is sampled under each foot rather than assumed flat.
  _poseQuat.set(pose.quaternionX, pose.quaternionY, pose.quaternionZ, pose.quaternionW);

  for (const leg of mesh.legs) {
    const p = (mesh.phase + leg.phaseOffset) % 1;
    const stride = mesh.strideLength * mesh.gait;
    let footX: number;
    let lift: number;
    if (p < 0.5) {
      // STANCE. The foot travels backwards through the hull's frame at the
      // rate the hull travels forwards; in the world it does not move at all.
      footX = leg.hipX + stride * (0.5 - p * 2) * 0.5;
      lift = 0;
    } else {
      // SWING. Forward along an arc to the next footfall.
      const t = (p - 0.5) * 2;
      footX = leg.hipX + stride * (t - 0.5) * 0.5;
      lift = Math.sin(Math.PI * t) * mesh.strideLift * mesh.gait;
    }

    // Hip-local → chassis-local → world XZ. Only yaw matters: the hull is
    // upright, so the hips' own yaw is the only rotation between them.
    const cosHip = Math.cos(mesh.hipYaw);
    const sinHip = Math.sin(mesh.hipYaw);
    _worldFoot.set(
      footX * cosHip + leg.hipZ * sinHip,
      0,
      -footX * sinHip + leg.hipZ * cosHip,
    ).applyQuaternion(_poseQuat);
    const groundY = getLocomotionSurfaceHeight(
      pose.rootX + _worldFoot.x,
      pose.rootZ + _worldFoot.z,
      mapWidth,
      mapHeight,
      0,
    );
    // The hull rides at a fixed height above its own footprint, so a foot on
    // higher ground simply reaches less far down.
    const footY = (groundY - pose.rootY) + lift;

    leg.plantX = footX;
    leg.plantY = footY;

    solveKnee(leg.hipX, leg.hipY, footX, footY, leg.thighLength, leg.shinLength, _knee);
    poseStrut(leg.thigh, leg.hipX, leg.hipY, leg.hipZ, _knee.x, _knee.y, leg.hipZ);
    poseStrut(leg.shin, _knee.x, _knee.y, leg.hipZ, footX, footY, leg.hipZ);
    leg.knee.position.set(_knee.x, _knee.y, leg.hipZ);
    // The foot stays flat and square to the hull — a mech plants its sole, it
    // does not point its toes down the way a swinging limb would.
    leg.foot.position.set(footX, footY, leg.hipZ);
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
    const footY = leg.hipY - Math.cos(STAND_KNEE_BEND_RAD) * (leg.thighLength + leg.shinLength) * 0.98;
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
