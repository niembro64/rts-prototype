// StandingRig3D — the biped. Two legs, two arms, and nothing borrowed from the
// arachnid leg rig.
//
// WHY NOT `legs`. The leg rig solves a spider: each limb owns an independent
// reach shell and chooses a world-space foothold. A standing mech instead owns
// one coupled biped cycle and visible hip sockets. Its stopped pose may open
// each straight support column slightly forward and outward, but that authored
// stance blends back into the shared sagittal walk rather than becoming a
// second foothold controller.
//
// THE WALK IS ONE COUPLED BIPED CYCLE. Unlike `legs`, a standing unit does not
// own independent world-space foothold state per limb. Both legs sample one
// distance-driven phase exactly half a cycle apart, so their longitudinal
// poses are mathematical opposites at every instant. Each arm then reads and
// opposes its same-side leg. Runtime and Entity Lab use the same sampler: the
// 180-degree contract cannot drift between gameplay presentation and preview.
//
// UPRIGHT. A biped does not lean into a hill. The hull's terrain tilt is
// cancelled at the pose (see Render3DEntities' upright hosts), so this rig can
// treat chassis-local Y as true vertical, and the only thing a slope changes is
// how far down each foot reaches. That is exactly what a real leg does with a
// hill, and it is why each foot target samples terrain height rather than living
// at a fixed depth below the hip.

import * as THREE from 'three';
import type {
  StandingArms,
  StandingLegs,
  UnitTurretHostAttachment,
} from '@/types/blueprintSchema.generated';
import type { Entity, PlayerId, Turret } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import {
  getSharedPrimitiveSphereGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import {
  rollingContact,
  sampleRollingContactDistance,
  transformWorldVectorToChassis,
  type LocomotionBase,
  type LocomotionRenderPose,
  type RollingContactState,
} from './LocomotionRigShared3D';
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import { getLocomotionMatByCache } from './RenderUtils';
import { COLORS } from '@/colorsConfig';
import { getConstructionHostMarkingProfile } from '@/constructionVisualConfig';
import { buildConstructionHostMarking } from './ConstructionHostMarking3D';
import type { ClientRenderTurretHostRows } from './ClientRenderTurretStateSlab';
import {
  readHostTurretAimSample3D,
  type HostTurretAimSample3D,
} from './HostTurretAim3D';

const SEGMENT_COLOR = COLORS.units.locomotion.leg.segment.colorHex;
const segmentMaterials = new Map<number, THREE.MeshLambertMaterial>();
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const constructionEmitterMaterial = new THREE.MeshBasicMaterial({
  color: COLORS.units.unitCommander.lens.colorHex,
});

type StandingVariant = 'commander' | 'human' | 'generic';
type StandingArmRole = 'weapon' | 'construction' | 'free';
type StandingArmHostAttachment = Extract<
  UnitTurretHostAttachment,
  { kind: 'standingArm' }
>;
export type StandingArmId = StandingArmHostAttachment['arm'];

type StandingTurretAimMemory = {
  initialized: boolean;
  yaw: number;
  pitch: number;
  manualHoldMs: number;
  /** Manual fire arrives as a pose discontinuity rather than a targeting FSM
   *  lock. Client interpolation can expose that one discontinuity as many
   *  small pose changes, so it may trigger one assist window and cannot
   *  trigger another until the pose has actually settled. */
  manualPoseArmed: boolean;
};

/** One rigid part drawn between two points in the leg's own plane. Boxes, not
 *  cylinders: a commander's limbs are plate and actuator housing, and a box
 *  edge is what makes a knee read as a hinge rather than as a ball. */
type Strut = {
  mesh: THREE.Mesh;
  /** A shorter, wider plate rides the outside of the actuator core. BAR's
   *  walkers read as nested armour and piston housings, not four sticks. */
  armor: THREE.Mesh;
  /** Commander-only team-light strip on the outward armour face. */
  accent?: THREE.Mesh;
  accentSide: number;
  /** Cross-section, world units. Length comes from the endpoints. */
  width: number;
  depth: number;
};

export type StandingLeg = {
  /** -1 right, +1 left in the standing frame's lateral axis. */
  side: number;
  /** Hip socket, chassis-local. */
  hipX: number;
  hipY: number;
  hipZ: number;
  thighLength: number;
  shinLength: number;
  /** Visible articulated housing at the fixed upper-leg attachment. */
  hipJoint: THREE.Mesh;
  thigh: Strut;
  shin: Strut;
  knee: THREE.Mesh;
  /** Compact sole, ankle armour, and two or three forward digits. */
  foot: THREE.Group;
  /** Resolved longitudinal position in the hip frame. Arms read this actual
   *  pose, so same-side counter-swing cannot acquire a second gait clock. */
  footLocalX: number;
  footLocalZ: number;
};

export type StandingArm = {
  id: StandingArmId;
  side: number;
  role: StandingArmRole;
  shoulderX: number;
  shoulderY: number;
  shoulderZ: number;
  upperLength: number;
  forearmLength: number;
  outwardRad: number;
  actionBlend: number;
  /** Host-selected echo of an attached turret's current pitch. The turret
   *  still pitches itself; this only makes the carrier arm help the motion. */
  turretAimActive: boolean;
  turretAimPitch: number;
  /** Visible articulated housing at the fixed upper-arm attachment. */
  shoulderJoint: THREE.Mesh;
  upper: Strut;
  forearm: Strut;
  elbow: THREE.Mesh;
  wrist: THREE.Mesh;
  /** Arm-local attachment point for the commander's construction tool and
   *  any later held equipment. It follows the forearm orientation. */
  attachment: THREE.Group;
  /** Where the forearm ends, chassis-local. The turret mounted on this arm is
   *  what the commander holds there — the rig draws no hand of its own, because
   *  a fist on the end of a weapon arm is one lump too many. */
  handX: number;
  handY: number;
  handZ: number;
};

export type StandingMesh = {
  type: 'standing';
  variant: StandingVariant;
  group: THREE.Group;
  /** The legs hang off this, and it yaws INSIDE the hull.
   *
   *  A commander may keep its torso — and therefore its weapons — pointed at
   *  what it is shooting or building. The hips only cancel that temporary
   *  upper-body offset, leaving ordinary authoritative unit facing as the one
   *  and only direction input for the locomotion rig. */
  hips: THREE.Group;
  /** Armoured bridge between the two hip sockets. It belongs to the lower
   * body and therefore turns with the legs, never with turret-assisted torso
   * yaw. */
  pelvis: THREE.Mesh;
  /** Presentation-only local Three.js yaw applied by the host to its upper
   *  body. Turret world aim remains authoritative and independently posed. */
  upperBodyYaw: number;
  /** True whenever any attached turret owns the host presentation. This is a
   *  host-wide animation gate: combat aim suppresses gait on both arms even
   *  when only one arm receives the selected turret's pitch proposal. */
  turretLockActive: boolean;
  turretAimMemory: Map<string, StandingTurretAimMemory>;
  legs: StandingLeg[];
  arms: StandingArm[];
  /** Ground distance used to advance the shared biped gait. */
  contact: RollingContactState;
  /** Shared normalized right-leg phase; the left leg always adds exactly .5. */
  gaitPhase: number;
  /** Smoothed 0..1 walk amplitude for all four limbs. */
  gait: number;
  /** Longitudinal travel covered by one left/right step. */
  stepLength: number;
  /** Terrain distance covered by one complete gait cycle. The stance half is
   * calibrated against this distance so its foot cancels chassis travel. */
  gaitCycleDistance: number;
  strideLift: number;
  /** Stopped-pose foot offsets. Both blend to zero as the walk comes in. */
  stanceForward: number;
  stanceOutward: number;
  /** Nominal hip height above the sole, from standHeightRatio. Blueprint
   * validation keeps this equal to the hip socket's flat-ground height. */
  standHipY: number;
  armSwingRad: number;
  armRestRad: number;
  /** Ground plane in the lifted rig's local frame. */
  groundLocalY: number;
  unitRadius: number;
} & LocomotionBase;

/** Below these rates a standing unit is visually at rest. */
const IDLE_SPEED = 1.5;
const IDLE_YAW_RATE = 0.12;
/** Seconds for the standing gait amplitude to ease in and out. */
const GAIT_EASE_SECONDS = 0.16;
/** How far the elbow follows the shoulder, as a fraction of shoulder swing. */
const ELBOW_FOLLOW = 0.28;
/** Constant global forearm pitch. The source BAR commander carries roughly
 *  50 degrees of elbow fold through the walk; the old 17-degree fold made
 *  both arms hang like ropes. */
const ELBOW_BEND_RAD = THREE.MathUtils.degToRad(52);
/** No standing arm may become a straight hanging rod, even under turret or
 * construction assistance. */
const MIN_ELBOW_BEND_RAD = THREE.MathUtils.degToRad(28);
/** Arms ease from walk swing into a working pose rather than snapping. */
const ARM_ACTION_EASE_SECONDS = 0.11;
/** A standing torso quickly accepts a locked turret heading. */
const UPPER_BODY_YAW_EASE_SECONDS = 0.12;
/** With no turret asking for host assistance, the torso is carried directly
 *  by the locomotion frame and quickly sheds any leftover aiming offset. */
const UPPER_BODY_RETURN_EASE_SECONDS = 0.45;
/** Manual emitters such as the Commander's D-gun have no tracking FSM lock.
 *  A changed authoritative pose therefore grants them a short host-assist
 *  window, long enough for the torso/arm echo to visibly follow the shot. */
const MANUAL_TURRET_ASSIST_HOLD_MS = 420;
const MANUAL_TURRET_POSE_EPSILON = 1e-4;

const _knee = new THREE.Vector3();
const _resolvedFoot = new THREE.Vector3();
const _chord = new THREE.Vector3();
const _bendDirection = new THREE.Vector3();
const _chassisVelocity = { x: 0, y: 0, z: 0 };
const _poseQuat = new THREE.Quaternion();
const _inversePoseQuat = new THREE.Quaternion();
const _footWorld = new THREE.Vector3();
const _segDir = new THREE.Vector3();
const _segQuat = new THREE.Quaternion();
const _segLateralReference = new THREE.Vector3(0, 0, 1);
const _segFallbackReference = new THREE.Vector3(1, 0, 0);
const _segWidthAxis = new THREE.Vector3();
const _segDepthAxis = new THREE.Vector3();
const _segBasis = new THREE.Matrix4();
const _accentOffset = new THREE.Vector3();
const _turretMount = new THREE.Vector3();
const _hostTurretAimSample: HostTurretAimSample3D = {
  turretIndex: -1,
  yaw: 0,
  pitch: 0,
  state: 'idle',
};

function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function material(ownerId: PlayerId | undefined): THREE.MeshLambertMaterial {
  return getLocomotionMatByCache(segmentMaterials, SEGMENT_COLOR, ownerId);
}

function makeStrut(
  parent: THREE.Group,
  width: number,
  depth: number,
  ownerId: PlayerId | undefined,
  accentSide = 0,
  layered = true,
): Strut {
  const mesh = new THREE.Mesh(unitBox, material(ownerId));
  const armor = new THREE.Mesh(unitBox, material(ownerId));
  mesh.visible = layered;
  parent.add(mesh, armor);
  let accent: THREE.Mesh | undefined;
  if (accentSide !== 0) {
    accent = new THREE.Mesh(unitBox, constructionEmitterMaterial);
    parent.add(accent);
  }
  return { mesh, armor, accent, accentSide, width, depth };
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

function makeStandingJointSphere(
  parent: THREE.Group,
  radius: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    getSharedPrimitiveSphereGeometry('locomotion', geometryTier),
    material(ownerId),
  );
  mesh.scale.setScalar(radius);
  parent.add(mesh);
  return mesh;
}

/** Compact BAR-style mech boot: a real outsole with a raised heel, quarter,
 *  sloped instep and toe box. Standing feet turn with their legs, so this
 *  volume can read as a simple shoe instead of a ground-pinned landing pad. */
function makeFoot(
  parent: THREE.Group,
  length: number,
  width: number,
  ownerId: PlayerId | undefined,
  variant: StandingVariant,
  geometryTier: PrimitiveGeometryTier,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.standingShoe = true;
  const soleHeight = Math.max(0.36, width * 0.13);
  const sole = makeBlock(group, length * 0.80, soleHeight, width * 0.90, ownerId);
  sole.position.set(length * 0.01, soleHeight * 0.5, 0);

  if (geometryTier !== 'far') {
    const heel = makeBlock(group, length * 0.28, soleHeight * 2.0, width * 0.72, ownerId);
    heel.position.set(-length * 0.34, soleHeight, 0);
  }

  const quarterHeight = Math.max(soleHeight * 2.8, width * 0.48);
  const quarter = makeBlock(
    group,
    length * (variant === 'commander' ? 0.36 : 0.32),
    quarterHeight,
    width * 0.70,
    ownerId,
  );
  quarter.userData.standingShoeUpper = true;
  quarter.position.set(-length * 0.19, soleHeight + quarterHeight * 0.5, 0);
  quarter.rotation.z = THREE.MathUtils.degToRad(-7);

  if (geometryTier !== 'far') {
    const instepHeight = Math.max(soleHeight * 2.0, width * 0.34);
    const instep = makeBlock(
      group,
      length * 0.44,
      instepHeight,
      width * 0.74,
      ownerId,
    );
    instep.position.set(length * 0.08, soleHeight + instepHeight * 0.5, 0);
    instep.rotation.z = THREE.MathUtils.degToRad(-9);
  }

  const toeHeight = Math.max(soleHeight * 1.45, width * 0.24);
  const toe = makeBlock(group, length * 0.36, toeHeight, width * 0.80, ownerId);
  toe.userData.standingShoeToe = true;
  toe.position.set(length * 0.34, soleHeight + toeHeight * 0.5, 0);
  toe.rotation.z = THREE.MathUtils.degToRad(-4);

  if (variant === 'commander' && geometryTier === 'close') {
    const toeAccent = new THREE.Mesh(unitBox, constructionEmitterMaterial);
    toeAccent.position.set(
      length * 0.39,
      soleHeight + toeHeight * 0.82,
      0,
    );
    toeAccent.scale.set(
      length * 0.20,
      Math.max(0.12, soleHeight * 0.18),
      width * 0.52,
    );
    toeAccent.rotation.z = toe.rotation.z;
    group.add(toeAccent);
  }
  parent.add(group);
  return group;
}

function standingVariant(unitBlueprintId: string | undefined): StandingVariant {
  if (unitBlueprintId === 'unitCommander') return 'commander';
  if (unitBlueprintId === 'unitHuman') return 'human';
  return 'generic';
}

function armRole(variant: StandingVariant, side: number): StandingArmRole {
  // The Human carries its weapon on the right. The Commander deliberately
  // separates equipment: construction on the right, beam weapon on the left.
  if (variant === 'commander') return side < 0 ? 'construction' : 'weapon';
  if (side < 0) return 'weapon';
  return 'free';
}

function standingArmId(side: number): StandingArmId {
  // The standing frame is right-handed: +X forward and +Y/Three +Z left.
  // The negative-lateral limb is therefore the host's right arm.
  return side < 0 ? 'rightArm' : 'leftArm';
}

function addCommanderConstructionTool(
  attachment: THREE.Group,
  unitRadius: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier,
): void {
  const housing = makeBlock(
    attachment,
    unitRadius * 0.26,
    unitRadius * 0.48,
    unitRadius * 0.32,
    ownerId,
  );
  housing.position.y = -unitRadius * 0.17;
  housing.userData.standingConstructionTool = true;

  // A thick distal tool head and twin luminous nano rails make the right arm
  // unmistakably a construction implement rather than an unarmed fist.
  const toolHead = makeBlock(
    attachment,
    unitRadius * 0.30,
    unitRadius * 0.22,
    unitRadius * 0.38,
    ownerId,
  );
  toolHead.position.y = unitRadius * 0.10;
  toolHead.userData.standingConstructionTool = true;

  const profile = getConstructionHostMarkingProfile('unitCommander');
  if (profile !== null) attachment.add(
    buildConstructionHostMarking(profile, unitRadius, geometryTier),
  );

  // Two bright nano nozzles make the construction side readable even when
  // the hazard sleeve is edge-on. They are a tool, not a second weapon.
  if (geometryTier !== 'far') for (const side of [-1, 1] as const) {
    const prong = new THREE.Mesh(unitBox, constructionEmitterMaterial);
    prong.position.set(0, unitRadius * 0.30, side * unitRadius * 0.105);
    prong.scale.set(unitRadius * 0.07, unitRadius * 0.30, unitRadius * 0.055);
    prong.userData.standingConstructionEmitter = true;
    attachment.add(prong);
  }
}

/** Point a strut from `a` to `b` and stretch it to span them.
 *
 *  Aligning local Y with `setFromUnitVectors` leaves roll unconstrained. That
 *  is harmless for a cylinder but makes an armoured box visibly corkscrew as
 *  an arm crosses vertical. Projecting the standing rig's lateral axis onto
 *  the segment-normal plane gives every limb a stable rectangular frame. */
function poseStrut(strut: Strut, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  _segDir.set(bx - ax, by - ay, bz - az);
  const length = _segDir.length();
  if (length < 1e-5) return;
  _segDir.divideScalar(length);
  _segDepthAxis.copy(_segLateralReference)
    .addScaledVector(_segDir, -_segLateralReference.dot(_segDir));
  if (_segDepthAxis.lengthSq() < 1e-8) {
    _segDepthAxis.copy(_segFallbackReference)
      .addScaledVector(_segDir, -_segFallbackReference.dot(_segDir));
  }
  _segDepthAxis.normalize();
  _segWidthAxis.crossVectors(_segDir, _segDepthAxis).normalize();
  _segDepthAxis.crossVectors(_segWidthAxis, _segDir).normalize();
  _segBasis.makeBasis(_segWidthAxis, _segDir, _segDepthAxis);
  _segQuat.setFromRotationMatrix(_segBasis);
  strut.mesh.quaternion.copy(_segQuat);
  strut.mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  strut.mesh.scale.set(strut.width * 0.64, length, strut.depth * 0.62);
  strut.armor.quaternion.copy(_segQuat);
  strut.armor.position.set(
    (ax + bx) * 0.5,
    (ay + by) * 0.5,
    (az + bz) * 0.5,
  );
  strut.armor.scale.set(
    strut.width,
    length * (strut.mesh.visible ? 0.58 : 0.96),
    strut.depth,
  );
  if (strut.accent !== undefined) {
    _accentOffset
      .set(0, 0, strut.depth * 0.52 * strut.accentSide)
      .applyQuaternion(_segQuat);
    strut.accent.quaternion.copy(_segQuat);
    strut.accent.position
      .set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5)
      .add(_accentOffset)
      .addScaledVector(_segDir, -length * 0.04);
    strut.accent.scale.set(strut.width * 0.2, length * 0.42, strut.depth * 0.08);
  }
}

/** Resolve a mechanically valid two-bone leg.
 *
 * The old pose interpolated the knee between a straight chord and an IK knee.
 * That looked straight, but silently shortened both bones at partial bend and
 * made the rendered struts stretch as the unit walked. Here hip→knee and
 * knee→foot always remain the authored lengths. An unreachable terrain target
 * is clamped to the leg's reach instead of disconnecting or stretching it. */
function solveStandingKnee(
  hipX: number, hipY: number, hipZ: number,
  footX: number, footY: number, footZ: number,
  thigh: number, shin: number,
  outKnee: THREE.Vector3,
  outFoot: THREE.Vector3,
): void {
  _chord.set(footX - hipX, footY - hipY, footZ - hipZ);
  const rawSpan = _chord.length();
  if (rawSpan > 1e-5) _chord.divideScalar(rawSpan);
  else _chord.set(0, -1, 0);
  const minReach = Math.abs(thigh - shin) + 1e-4;
  const maxReach = Math.max(minReach, thigh + shin - 1e-4);
  const reach = THREE.MathUtils.clamp(rawSpan, minReach, maxReach);
  outFoot.set(
    hipX + _chord.x * reach,
    hipY + _chord.y * reach,
    hipZ + _chord.z * reach,
  );
  const along = THREE.MathUtils.clamp(
    (thigh * thigh + reach * reach - shin * shin) / (2 * reach),
    0,
    thigh,
  );
  const perpendicular = Math.sqrt(Math.max(0, thigh * thigh - along * along));
  // Project chassis-forward onto the chord-normal plane. It is the one stable
  // direction that makes both mirrored knees articulate forward rather than
  // collapsing toward or away from one another.
  _bendDirection
    .set(1, 0, 0)
    .addScaledVector(_chord, -_chord.x);
  if (_bendDirection.lengthSq() < 1e-8) {
    _bendDirection
      .set(0, 0, 1)
      .addScaledVector(_chord, -_chord.z);
  }
  _bendDirection.normalize();
  outKnee.set(
    hipX + _chord.x * along + _bendDirection.x * perpendicular,
    hipY + _chord.y * along + _bendDirection.y * perpendicular,
    hipZ + _chord.z * along + _bendDirection.z * perpendicular,
  );
}

function positiveUnitPhase(phase: number): number {
  return ((phase % 1) + 1) % 1;
}

/** Sample terrain under a phase-authored foot without turning it into a
 * contact-locked foothold. Longitudinal gait remains coupled; only the
 * standing leg's vertical reach adapts to the ground under each shoe. */
function standingFootGroundLocalY(
  mesh: StandingMesh,
  footX: number,
  footZ: number,
  pose: LocomotionRenderPose,
  mapWidth: number,
  mapHeight: number,
): number {
  _poseQuat.set(
    pose.quaternionX,
    pose.quaternionY,
    pose.quaternionZ,
    pose.quaternionW,
  );
  _footWorld
    .set(footX, mesh.groundLocalY, footZ)
    .applyQuaternion(_poseQuat);
  _footWorld.x += pose.rootX;
  _footWorld.z += pose.rootZ;
  _footWorld.y = getLocomotionSurfaceHeight(
    _footWorld.x,
    _footWorld.z,
    mapWidth,
    mapHeight,
    0,
  );
  _footWorld.x -= pose.rootX;
  _footWorld.y -= pose.rootY;
  _footWorld.z -= pose.rootZ;
  _footWorld.applyQuaternion(_inversePoseQuat.copy(_poseQuat).invert());
  return _footWorld.y;
}

/** A triangle wave keeps both legs exact longitudinal opposites while making
 * the planted half linear. Unlike a sine, its stance speed does not accelerate
 * through mid-step and stall near toe-off. */
function standingLongitudinalWave(phase: number): number {
  const cycle = positiveUnitPhase(phase);
  return cycle < 0.5 ? -1 + cycle * 4 : 3 - cycle * 4;
}

/** Pose the whole standing biped from one gait phase.
 *
 * Each leg recovers from back to front for half a cycle, then travels linearly
 * from front to back while planted. The full-cycle terrain distance is four
 * half-strides, so the local stance motion exactly cancels forward chassis
 * travel. Arms consume these resolved foot positions later; no other phase or
 * speed clock exists. */
function poseCoupledStandingGait(
  mesh: StandingMesh,
  phase: number,
  gait: number,
  pose?: LocomotionRenderPose,
  mapWidth = 0,
  mapHeight = 0,
): void {
  const cycle = positiveUnitPhase(phase);
  const amplitude = THREE.MathUtils.clamp(gait, 0, 1);
  const stanceBlend = 1 - amplitude;
  const halfStride = mesh.gaitCycleDistance * 0.25;
  for (const leg of mesh.legs) {
    const legPhase = positiveUnitPhase(cycle + (leg.side > 0 ? 0.5 : 0));
    const longitudinalWave = standingLongitudinalWave(legPhase);
    const recoveryWave = legPhase < 0.5
      ? Math.sin(legPhase * Math.PI * 2)
      : 0;
    const footX = leg.hipX + mesh.stanceForward * stanceBlend +
      longitudinalWave * halfStride * amplitude;
    const footZ = leg.hipZ + leg.side * mesh.stanceOutward * stanceBlend;
    const groundY = pose === undefined
      ? mesh.groundLocalY
      : standingFootGroundLocalY(mesh, footX, footZ, pose, mapWidth, mapHeight);
    const footY = groundY + recoveryWave * mesh.strideLift * amplitude;
    solveStandingKnee(
      leg.hipX,
      leg.hipY,
      leg.hipZ,
      footX,
      footY,
      footZ,
      leg.thighLength,
      leg.shinLength,
      _knee,
      _resolvedFoot,
    );
    leg.footLocalX = _resolvedFoot.x;
    leg.footLocalZ = _resolvedFoot.z;
    poseStrut(leg.thigh, leg.hipX, leg.hipY, leg.hipZ, _knee.x, _knee.y, _knee.z);
    poseStrut(
      leg.shin,
      _knee.x,
      _knee.y,
      _knee.z,
      _resolvedFoot.x,
      _resolvedFoot.y,
      _resolvedFoot.z,
    );
    leg.knee.position.copy(_knee);
    leg.foot.position.copy(_resolvedFoot);
    // Standing feet follow lower-body facing but stay ground-parallel through
    // recovery. Contact-locked foot yaw belongs only to the `legs` rig.
    leg.foot.rotation.set(0, 0, 0);
  }
}

export function buildStandingRig(
  unitGroup: THREE.Group,
  unitRadius: number,
  cfgLegs: StandingLegs,
  cfgArms: StandingArms,
  chassisLiftY: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
  unitBlueprintId?: string,
): StandingMesh {
  const variant = standingVariant(unitBlueprintId);
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
  const stepLength = Math.max(1, legLength * cfgLegs.strideLengthRatio);
  const gaitCycleDistance = stepLength * 0.48 * 4;

  const hipX = unitRadius * cfgLegs.hip.xUnitRadiusRatio;
  const hipY = unitRadius * cfgLegs.hip.zUnitRadiusRatio - chassisLiftY;
  const hipHalfTrack = unitRadius * cfgLegs.hip.yUnitRadiusRatio;
  const hipJointRadius = legWidth * 0.62;
  const pelvis = makeBlock(
    hips,
    legWidth * 1.42,
    legWidth * 0.82,
    hipHalfTrack * 2,
    ownerId,
  );
  pelvis.position.set(hipX, hipY + legWidth * 0.26, 0);
  pelvis.userData.standingPelvis = true;

  const legs: StandingLeg[] = [];
  for (const side of [-1, 1] as const) {
    const hipZ = side * hipHalfTrack;
    const hipJoint = makeStandingJointSphere(
      hips,
      hipJointRadius,
      ownerId,
      geometryTier,
    );
    hipJoint.position.set(hipX, hipY, hipZ);
    hipJoint.userData.standingHipJoint = true;
    const leg: StandingLeg = {
      side,
      hipX,
      hipY,
      hipZ,
      thighLength,
      shinLength,
      hipJoint,
      // Left leads. Half a cycle is the whole of what makes a walk a walk.
      thigh: makeStrut(
        hips, legWidth, legWidth * 0.82, ownerId,
        variant === 'commander' && geometryTier === 'close' ? side : 0,
        geometryTier !== 'far',
      ),
      shin: makeStrut(
        hips, legWidth * 0.78, legWidth * 0.66, ownerId,
        variant === 'commander' && geometryTier === 'close' ? side : 0,
        geometryTier !== 'far',
      ),
      knee: makeBlock(hips, legWidth * 0.95, legWidth * 0.95, legWidth * 0.9, ownerId),
      foot: makeFoot(hips, footLength, footWidth, ownerId, variant, geometryTier),
      footLocalX: hipX,
      footLocalZ: hipZ,
    };
    legs.push(leg);
  }

  const upperLength = unitRadius * cfgArms.segments.upper.lengthUnitRadiusRatio;
  const forearmLength = unitRadius * cfgArms.segments.lower.lengthUnitRadiusRatio;
  const armWidth = cfgArms.radius;
  const arms: StandingArm[] = [];
  for (const side of [-1, 1] as const) {
    const attachment = new THREE.Group();
    group.add(attachment);
    const role = armRole(variant, side);
    if (role === 'construction') {
      addCommanderConstructionTool(
        attachment,
        unitRadius,
        ownerId,
        geometryTier,
      );
    }
    const wrist = makeBlock(
      group,
      armWidth * cfgArms.handRadiusRatio,
      armWidth * cfgArms.handRadiusRatio * 0.8,
      armWidth * cfgArms.handRadiusRatio,
      ownerId,
    );
    // A visible fist underneath an arm cannon doubles the hand volume and
    // hides its muzzle. The held weapon is the hand on this side.
    wrist.visible = role !== 'weapon';
    const shoulderX = unitRadius * cfgArms.shoulder.xUnitRadiusRatio;
    const shoulderY = unitRadius * cfgArms.shoulder.zUnitRadiusRatio - chassisLiftY;
    const shoulderZ = side * unitRadius * cfgArms.shoulder.yUnitRadiusRatio;
    const shoulderJoint = makeBlock(
      group,
      armWidth * 1.12,
      armWidth * 1.08,
      armWidth * 1.18,
      ownerId,
    );
    shoulderJoint.position.set(shoulderX, shoulderY, shoulderZ);
    shoulderJoint.userData.standingShoulderJoint = true;
    arms.push({
      id: standingArmId(side),
      side,
      role,
      shoulderX,
      shoulderY,
      shoulderZ,
      upperLength,
      forearmLength,
      outwardRad: THREE.MathUtils.degToRad(cfgArms.outwardDeg),
      actionBlend: 0,
      turretAimActive: false,
      turretAimPitch: 0,
      shoulderJoint,
      upper: makeStrut(
        group, armWidth, armWidth * 0.9, ownerId,
        variant === 'commander' && geometryTier === 'close' ? side : 0,
        geometryTier !== 'far',
      ),
      forearm: makeStrut(
        group, armWidth * 0.86, armWidth * 0.78, ownerId,
        variant === 'commander' && geometryTier === 'close' ? side : 0,
        geometryTier !== 'far',
      ),
      elbow: makeBlock(group, armWidth * 0.92, armWidth * 0.92, armWidth * 0.86, ownerId),
      wrist,
      attachment,
      handX: 0,
      handY: 0,
      handZ: 0,
    });
  }

  return {
    type: 'standing',
    variant,
    group,
    hips,
    pelvis,
    upperBodyYaw: 0,
    turretLockActive: false,
    turretAimMemory: new Map(),
    legs,
    arms,
    contact: rollingContact(0, 0),
    gaitPhase: 0,
    gait: 0,
    stepLength,
    gaitCycleDistance,
    strideLift: Math.max(0.5, legLength * cfgLegs.strideLiftRatio),
    stanceForward: unitRadius * cfgLegs.stanceForwardUnitRadiusRatio,
    stanceOutward: unitRadius * cfgLegs.stanceOutwardUnitRadiusRatio,
    standHipY: legLength * cfgLegs.standHeightRatio,
    armSwingRad: THREE.MathUtils.degToRad(cfgArms.walkSwingDeg),
    armRestRad: THREE.MathUtils.degToRad(cfgArms.restSwingDeg),
    groundLocalY: -chassisLiftY,
    unitRadius,
    geometryKey: '',
  };
}

function poseArm(
  arm: StandingArm,
  shoulderPitch: number,
  forearmPitch: number,
): void {
  const upperPlanar = Math.cos(arm.outwardRad) * arm.upperLength;
  const elbowX = arm.shoulderX + Math.sin(shoulderPitch) * upperPlanar;
  const elbowY = arm.shoulderY - Math.cos(shoulderPitch) * upperPlanar;
  const elbowZ = arm.shoulderZ + arm.side * Math.sin(arm.outwardRad) * arm.upperLength;
  const forearmOutward = arm.outwardRad * 0.72;
  const forearmPlanar = Math.cos(forearmOutward) * arm.forearmLength;
  const handX = elbowX + Math.sin(forearmPitch) * forearmPlanar;
  const handY = elbowY - Math.cos(forearmPitch) * forearmPlanar;
  const handZ = elbowZ + arm.side * Math.sin(forearmOutward) * arm.forearmLength;
  poseStrut(
    arm.upper,
    arm.shoulderX, arm.shoulderY, arm.shoulderZ,
    elbowX, elbowY, elbowZ,
  );
  poseStrut(
    arm.forearm,
    elbowX, elbowY, elbowZ,
    handX, handY, handZ,
  );
  arm.elbow.position.set(elbowX, elbowY, elbowZ);
  arm.wrist.position.set(handX, handY, handZ);
  arm.wrist.quaternion.copy(arm.forearm.mesh.quaternion);
  arm.attachment.position.set(handX, handY, handZ);
  arm.attachment.quaternion.copy(arm.forearm.mesh.quaternion);
  arm.handX = handX;
  arm.handY = handY;
  arm.handZ = handZ;
}

function standingTurretAssistPriority(
  turret: Turret,
  state: HostTurretAimSample3D['state'],
  manualHoldMs: number,
): number {
  // A manual pose change represents an explicit player ability and wins over
  // ordinary tracking. Engaged beats tracking; the fight-stop mount is the
  // host's authored primary weapon and wins ties between sibling weapons.
  if (turret.config.controlMode === 'manual' && manualHoldMs > 0) return 400;
  if (state === 'engaged') return 300 + (turret.config.requiredEngagedForFightStop ? 10 : 0);
  if (state === 'tracking') return 200 + (turret.config.requiredEngagedForFightStop ? 10 : 0);
  return 0;
}

/** Let a standing host echo the aim already solved by its arm-mounted
 * turrets. Every turret remains independently posed at its authoritative
 * world yaw/pitch; this host-side pass only selects optional secondary torso
 * and arm motion from the same values. */
export function updateStandingHostTurretAim(
  mesh: StandingMesh,
  hostYaw: number,
  turretRows: ClientRenderTurretHostRows | undefined,
  turrets: readonly Turret[],
  dtMs: number,
): number {
  for (const arm of mesh.arms) {
    arm.turretAimActive = false;
    // Pitch is a proposal owned by the currently selected turret, not sticky
    // arm state. poseArms still eases actionBlend back to the rest pose.
    arm.turretAimPitch = 0;
  }
  mesh.turretLockActive = false;

  const elapsedMs = Math.max(0, dtMs);
  let selectedPriority = 0;
  let selectedYaw = 0;
  let selectedPitch = 0;
  let selectedArm: StandingArmId | null = null;

  for (let turretIndex = 0; turretIndex < turrets.length; turretIndex++) {
    const turret = turrets[turretIndex];
    const attachment = turret.config.hostAttachment;
    if (attachment === null) continue;
    if (!readHostTurretAimSample3D(
      turretRows,
      turrets,
      turretIndex,
      _hostTurretAimSample,
    )) continue;

    let memory = mesh.turretAimMemory.get(turret.mountId);
    if (memory === undefined) {
      memory = {
        initialized: false,
        yaw: _hostTurretAimSample.yaw,
        pitch: _hostTurretAimSample.pitch,
        manualHoldMs: 0,
        manualPoseArmed: true,
      };
      mesh.turretAimMemory.set(turret.mountId, memory);
    }
    memory.manualHoldMs = Math.max(0, memory.manualHoldMs - elapsedMs);
    if (memory.initialized && turret.config.controlMode === 'manual') {
      const yawChanged = Math.abs(shortestAngleDelta(
        memory.yaw,
        _hostTurretAimSample.yaw,
      )) > MANUAL_TURRET_POSE_EPSILON;
      const pitchChanged = Math.abs(memory.pitch - _hostTurretAimSample.pitch) >
        MANUAL_TURRET_POSE_EPSILON;
      const poseChanged = yawChanged || pitchChanged;
      if (poseChanged && memory.manualPoseArmed) {
        memory.manualHoldMs = MANUAL_TURRET_ASSIST_HOLD_MS;
        memory.manualPoseArmed = false;
      } else if (!poseChanged && memory.manualHoldMs <= 0) {
        // A stable idle sample re-arms the next explicit manual-fire snap.
        memory.manualPoseArmed = true;
      }
    }
    memory.initialized = true;
    memory.yaw = _hostTurretAimSample.yaw;
    memory.pitch = _hostTurretAimSample.pitch;

    const priority = standingTurretAssistPriority(
      turret,
      _hostTurretAimSample.state,
      memory.manualHoldMs,
    );
    if (priority <= selectedPriority) continue;
    selectedPriority = priority;
    selectedYaw = _hostTurretAimSample.yaw;
    selectedPitch = _hostTurretAimSample.pitch;
    selectedArm = attachment.kind === 'standingArm' ? attachment.arm : null;
  }

  mesh.turretLockActive = selectedPriority > 0;

  const localSimYaw = selectedPriority > 0
    ? shortestAngleDelta(hostYaw, selectedYaw)
    : 0;
  // Sim yaw is around +Z; Three yaw is around +Y with the opposite sign.
  const targetUpperBodyYaw = -localSimYaw;
  const dt = elapsedMs / 1000;
  const yawEaseSeconds = selectedPriority > 0
    ? UPPER_BODY_YAW_EASE_SECONDS
    : UPPER_BODY_RETURN_EASE_SECONDS;
  const yawEase = dt <= 0
    ? (selectedPriority > 0 ? 1 : 0)
    : 1 - Math.exp(-dt / yawEaseSeconds);
  mesh.upperBodyYaw += shortestAngleDelta(
    mesh.upperBodyYaw,
    targetUpperBodyYaw,
  ) * yawEase;

  if (selectedArm !== null) {
    const arm = mesh.arms.find((candidate) => candidate.id === selectedArm);
    if (arm !== undefined) {
      arm.turretAimActive = true;
      arm.turretAimPitch = selectedPitch;
    }
  }
  return mesh.upperBodyYaw;
}

function armActionActive(entity: Entity | undefined, arm: StandingArm): boolean {
  if (arm.role === 'construction') {
    return entity !== undefined &&
      entity.builder !== null &&
      entity.builder.currentBuildTarget !== NO_ENTITY_ID;
  }
  return arm.turretAimActive;
}

function poseArms(
  mesh: StandingMesh,
  entity: Entity | undefined,
  dt: number,
): void {
  const actionEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / ARM_ACTION_EASE_SECONDS);
  for (const arm of mesh.arms) {
    const sameSideLeg = mesh.legs.find((leg) => leg.side === arm.side);
    const legForward = sameSideLeg === undefined
      ? 0
      : THREE.MathUtils.clamp(
        (sameSideLeg.footLocalX - sameSideLeg.hipX) /
          Math.max(1, mesh.stepLength * 0.5),
        -1,
        1,
      );
    // BAR's walk is contralateral: a forward same-side leg drives this arm
    // backward. Reading the actual solved foot pose keeps that relationship
    // true by construction instead of hoping a second clock stays synced.
    const armWave = mesh.turretLockActive ? 0 : -legForward;
    const actionTarget = armActionActive(entity, arm) ? 1 : 0;
    arm.actionBlend += (actionTarget - arm.actionBlend) * actionEase;

    // Same-side arm opposes the leg and the forearm remains deeply folded.
    // Any turret lock removes noisy gait from both arms. Only the arm named by
    // the selected attachment receives pitch; the other settles at rest.
    const walkShoulder = mesh.armRestRad + armWave * mesh.armSwingRad;
    const restForearmBend = ELBOW_BEND_RAD;
    const walkForearm = walkShoulder * ELBOW_FOLLOW
      + restForearmBend
      - armWave * mesh.armSwingRad * 0.32;
    const turretPitchAssist = THREE.MathUtils.clamp(
      arm.turretAimPitch,
      THREE.MathUtils.degToRad(-45),
      THREE.MathUtils.degToRad(75),
    );
    const actionShoulder = arm.role === 'construction'
      ? THREE.MathUtils.degToRad(18)
      : THREE.MathUtils.degToRad(24) + turretPitchAssist * 0.55;
    const actionForearm = arm.role === 'construction'
      ? THREE.MathUtils.degToRad(62)
      : THREE.MathUtils.degToRad(80) + turretPitchAssist * 0.45;
    const resolvedShoulder = THREE.MathUtils.lerp(
      walkShoulder,
      actionShoulder,
      arm.actionBlend,
    );
    const requestedForearm = THREE.MathUtils.lerp(
      walkForearm,
      actionForearm,
      arm.actionBlend,
    );
    const elbowDelta = requestedForearm - resolvedShoulder;
    const resolvedForearm = Math.abs(elbowDelta) < MIN_ELBOW_BEND_RAD
      ? resolvedShoulder + (elbowDelta < 0 ? -1 : 1) * MIN_ELBOW_BEND_RAD
      : requestedForearm;
    poseArm(arm, resolvedShoulder, resolvedForearm);
  }
}

/** Resolve the visible root of a held turret from the animated weapon hand.
 *  Gameplay still owns its stable blueprint mount; this is the articulated
 *  presentation mount that prevents the gun from remaining in the torso while
 *  its arm walks away. */
export function resolveStandingArmTurretRoot(
  mesh: StandingMesh,
  armId: StandingArmId,
  mountId: string,
  headRadius: number,
  out: THREE.Vector3 = _turretMount,
): THREE.Vector3 | null {
  const arm = mesh.arms.find((candidate) => candidate.id === armId);
  if (arm === undefined) return null;
  let centerYOffset = 0;
  let lateralOffset = 0;
  if (mesh.variant === 'commander') {
    if (mountId === 'beam') {
      centerYOffset = mesh.unitRadius * 0.10;
      lateralOffset = -arm.side * mesh.unitRadius * 0.10;
    } else {
      return null;
    }
  }
  out.set(
    arm.handX + mesh.unitRadius * 0.02,
    arm.handY + centerYOffset - headRadius,
    arm.handZ + lateralOffset,
  );
  return out;
}

export function updateStandingRig(
  mesh: StandingMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
  mapWidth: number,
  mapHeight: number,
): boolean {
  const dt = Math.max(0, dtMs) / 1000;
  const travelled = sampleRollingContactDistance(pose, mesh.contact);

  // LOWER BODY. Standing legs are ordinary locomotion: they inherit the same
  // authoritative unit orientation as wheels or treads. The renderer applies
  // optional turret assistance to the lifted upper body, so the hips cancel
  // only that relative offset and never invent a second travel-facing yaw.
  const planarSpeed = Math.hypot(pose.velocityX, pose.velocityZ);
  const turningSpeed = Math.abs(pose.yawRate) * mesh.unitRadius;
  const locomotionSpeed = Math.max(planarSpeed, turningSpeed);
  const moving = planarSpeed > IDLE_SPEED ||
    Math.abs(pose.yawRate) > IDLE_YAW_RATE;
  mesh.hips.rotation.y = -mesh.upperBodyYaw;

  const gaitEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / GAIT_EASE_SECONDS);
  // Walking speed changes the gait clock, not its stride amplitude. Scaling
  // both independently caused ordinary-speed units to take shortened steps
  // on a full-length cycle, so their planted feet visibly slid over terrain.
  const gaitTarget = moving ? 1 : 0;
  mesh.gait += (gaitTarget - mesh.gait) * gaitEase;

  if (moving && dt > 0) {
    transformWorldVectorToChassis(
      pose.velocityX,
      pose.velocityY,
      pose.velocityZ,
      pose,
      _chassisVelocity,
    );
    // The rolling contact gives exact signed forward travel after its first
    // sample. Velocity covers that first frame, strafing, and pivoting so the
    // biped never reverts to independent leg decisions for special movement.
    const fallbackSign = _chassisVelocity.x < -IDLE_SPEED ? -1 : 1;
    const strideDistance = Math.abs(travelled) > 1e-5
      ? travelled
      : fallbackSign * locomotionSpeed * dt;
    mesh.gaitPhase = positiveUnitPhase(
      mesh.gaitPhase + strideDistance / Math.max(1, mesh.gaitCycleDistance),
    );
  }
  poseCoupledStandingGait(mesh, mesh.gaitPhase, mesh.gait, pose, mapWidth, mapHeight);
  poseArms(mesh, entity, dt);

  return true;
}

/** Standstill pose, for a preview card or a unit built before its first tick. */
export function poseStandingRigAtRest(mesh: StandingMesh): void {
  mesh.hips.rotation.y = -mesh.upperBodyYaw;
  poseCoupledStandingGait(mesh, mesh.gaitPhase, 0);
  poseArms(mesh, undefined, 0);
}

/** The Entity Lab uses the exact same coupled gait sampler as the battlefield. */
export function poseStandingRigAtPreviewCycle(
  mesh: StandingMesh,
  phase: number,
  gait: number,
): void {
  mesh.hips.rotation.y = -mesh.upperBodyYaw;
  poseCoupledStandingGait(mesh, phase, gait);
  poseArms(mesh, undefined, 0);
}

export function disposeStandingRigGeometry(): void {
  unitBox.dispose();
  for (const mat of segmentMaterials.values()) mat.dispose();
  segmentMaterials.clear();
  constructionEmitterMaterial.dispose();
}
