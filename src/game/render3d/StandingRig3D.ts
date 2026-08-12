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
// treat chassis-local Y as true vertical. Its shoes are conventional authored
// walk-cycle pieces, following the BAR Commander philosophy: they face with
// the lower body, stay flat through stance, and pitch modestly through
// recovery. They do not sample or retain terrain planes of their own.

import * as THREE from 'three';
import type {
  StandingArms,
  StandingLegs,
  UnitTurretHostAttachment,
} from '@/types/blueprintSchema.generated';
import type { Entity, PlayerId, Turret } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import {
  getSharedPrimitiveCylinderGeometry,
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
import { getLocomotionMatByCache } from './RenderUtils';
import { COLORS } from '@/colorsConfig';
import { UNIT_MASS_MULTIPLIER } from '@/config';
import { getConstructionHostMarkingProfile } from '@/constructionVisualConfig';
import { buildConstructionHostMarking } from './ConstructionHostMarking3D';
import type { ClientRenderTurretHostRows } from './ClientRenderTurretStateSlab';
import {
  readHostTurretAimSample3D,
  type HostTurretAimSample3D,
} from './HostTurretAim3D';
import { clampUnit } from '../math';

const SEGMENT_COLOR = COLORS.units.locomotion.leg.segment.colorHex;
const segmentMaterials = new Map<number, THREE.MeshLambertMaterial>();
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const constructionEmitterMaterial = new THREE.MeshBasicMaterial({
  color: COLORS.units.unitCommander.lens.colorHex,
});

type StandingVariant = 'commander' | 'human' | 'titan' | 'generic';
type StandingArmRole = 'weapon' | 'construction' | 'free';
type StandingArmHostAttachment = Extract<
  UnitTurretHostAttachment,
  { kind: 'standingArm' }
>;
export type StandingArmId = StandingArmHostAttachment['arm'];

/** Local yaw/pitch a held turret takes from the arm carrying it. */
export type StandingArmTurretAim = { yaw: number; pitch: number };

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
  armor?: THREE.Mesh;
  /** Commander-only team-light strip on the outward limb-shell face. */
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
  /** Unit vector elbow -> hand, chassis-local: the direction this arm is
   *  currently pointing. A gun held in the hand is rigid to it, so this is
   *  the whole of that gun's rendered orientation — see
   *  resolveStandingArmTurretAim. */
  aimX: number;
  aimY: number;
  aimZ: number;
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
   *  body. This is derived each frame from the independently smoothed world
   *  heading below and the locomotion-owned host heading. */
  upperBodyYaw: number;
  /** Retained upper-body heading in simulation/world yaw coordinates. Keeping
   *  the EMA here, rather than on the local waist twist, prevents a leg turn
   *  from dragging a locked torso and lets an unlocked torso visibly follow
   *  locomotion-forward instead of snapping to it. Null means the first live
   *  pose should initialize from the host heading. */
  upperBodyWorldYaw: number | null;
  /** World-yaw angular velocity retained by the inertial torso controller.
   * Keeping this beside the heading makes geometry-tier rebuilds continuous
   * through both halves of the second-order response. */
  upperBodyYawVelocity: number;
  /** Critically damped spring gain derived from the unit's physical mass,
   * radius, and authored ground propulsive force. */
  upperBodyYawSpringGain: number;
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
  /** Last non-zero direction of phase travel, for forward/reverse recovery. */
  gaitDirection: -1 | 1;
  /** Smoothed 0..1 walk amplitude for all four limbs. */
  gait: number;
  /** Longitudinal travel covered by one left/right step. */
  stepLength: number;
  /** Ground-travel distance covered by one complete gait cycle. The stance half is
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
/** Match the authoritative chassis attitude servo: a factor of two keeps the
 * critically damped response inside the maximum acceleration implied by its
 * available edge force. Unlike chassis steering, a waist motor does not need
 * to cap its actuator force at one body-weight of ground traction. */
const UPPER_BODY_RESPONSE_TIME_SCALE = 2;
/** Dynamic unit bodies use solid-sphere inertia (I = 2/5 m r^2). With no
 * separately authored torso mass distribution, using that same conservative
 * envelope gives every standing unit a deterministic turn authority without
 * adding a per-blueprint animation-speed knob. */
const UPPER_BODY_INERTIA_FACTOR = 2 / 5;
const FORCE_TO_ACCELERATION_SCALE = 1_000_000;
/** Manual emitters such as the Commander's D-gun have no tracking FSM lock.
 *  A changed authoritative pose therefore grants them a short host-assist
 *  window, long enough for the torso/arm echo to visibly follow the shot. */
const MANUAL_TURRET_ASSIST_HOLD_MS = 420;
const MANUAL_TURRET_POSE_EPSILON = 1e-4;
const STANDING_PELVIS_CENTER_LIFT_RATIO = 0.26;
const STANDING_PELVIS_HEIGHT_RATIO = 0.82;
/** Conventional authored shoe roll, based on the BAR Commander approach.
 * The angles are deliberately restrained at RTS camera distance. */
const STANDING_FOOT_PUSH_OFF_RAD = THREE.MathUtils.degToRad(-14);
const STANDING_FOOT_HEEL_STRIKE_RAD = THREE.MathUtils.degToRad(10);

const _knee = new THREE.Vector3();
const _resolvedFoot = new THREE.Vector3();
const _chord = new THREE.Vector3();
const _bendDirection = new THREE.Vector3();
const _chassisVelocity = { x: 0, y: 0, z: 0 };
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

/** Convert the same physical quantities that govern chassis motion into a
 * presentation spring for the articulated upper body. A force applied at the
 * body's edge produces torque F*r; dividing by solid-body inertia makes a
 * broad, massive Rex turn materially slower than a Human without naming
 * either unit here. */
export function standingUpperBodyYawSpringGain(
  authoredMass: number,
  radius: number,
  maxPropulsiveForce: number,
): number {
  const bodyMass = authoredMass * UNIT_MASS_MULTIPLIER;
  const safeRadius = Math.max(1, radius);
  if (
    !Number.isFinite(bodyMass) || bodyMass <= 0 ||
    !Number.isFinite(maxPropulsiveForce) || maxPropulsiveForce <= 0
  ) return 0;
  const inertia = bodyMass * safeRadius * safeRadius * UPPER_BODY_INERTIA_FACTOR;
  const torque = maxPropulsiveForce * safeRadius;
  const maxAngularAcceleration =
    torque * FORCE_TO_ACCELERATION_SCALE / inertia;
  return maxAngularAcceleration /
    (Math.PI * UPPER_BODY_RESPONSE_TIME_SCALE * UPPER_BODY_RESPONSE_TIME_SCALE);
}

/** Exact critically damped step for a wrapped world-yaw axis. This is the
 * closed-form counterpart of the authoritative damped attitude solve, so the
 * result is stable across render frame rates and carries angular momentum
 * when a turret changes targets. */
function stepStandingUpperBodyYaw(
  mesh: StandingMesh,
  targetWorldYaw: number,
  dt: number,
): void {
  if (mesh.upperBodyWorldYaw === null || dt <= 0) return;
  const k = mesh.upperBodyYawSpringGain;
  if (!(k > 0) || !Number.isFinite(k)) {
    mesh.upperBodyYawVelocity = 0;
    return;
  }
  const rootK = Math.sqrt(k);
  const relativeYaw = shortestAngleDelta(
    targetWorldYaw,
    mesh.upperBodyWorldYaw,
  );
  const safeVelocity = Number.isFinite(mesh.upperBodyYawVelocity)
    ? mesh.upperBodyYawVelocity
    : 0;
  const b = safeVelocity + rootK * relativeYaw;
  const decay = Math.exp(-rootK * dt);
  const nextRelativeYaw = (relativeYaw + b * dt) * decay;
  mesh.upperBodyYawVelocity =
    (b - rootK * (relativeYaw + b * dt)) * decay;
  mesh.upperBodyWorldYaw = targetWorldYaw + nextRelativeYaw;
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
  armored = true,
): Strut {
  const mesh = new THREE.Mesh(unitBox, material(ownerId));
  const armor = armored ? new THREE.Mesh(unitBox, material(ownerId)) : undefined;
  // A bare actuator remains the whole limb at far LOD; a layered strut lets
  // its broader armour sleeve carry the silhouette there instead.
  mesh.visible = layered || !armored;
  parent.add(mesh);
  if (armor !== undefined) parent.add(armor);
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

/** A standing limb joint is a hinge housing, not another limb block. The shared
 * cylinder's authored axis is local Y; rotate it onto standing-local Z so the
 * axle runs across the limb while the round profile reads in its bend plane. */
function makeStandingHingeCylinder(
  parent: THREE.Group,
  diameter: number,
  axleLength: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    getSharedPrimitiveCylinderGeometry('locomotion', geometryTier),
    material(ownerId),
  );
  mesh.scale.set(diameter * 0.5, axleLength, diameter * 0.5);
  mesh.rotation.x = Math.PI * 0.5;
  parent.add(mesh);
  return mesh;
}

/** Upper seam of the lower-body pelvis in the lifted standing-rig frame.
 * Standing chassis art begins on this exact plane so no hidden upper-body
 * blocks extend down inside the independently yawing hips. */
export function getStandingPelvisTopLocalY(
  unitRadius: number,
  cfgLegs: StandingLegs,
  chassisLiftY: number,
): number {
  const hipY = unitRadius * cfgLegs.hip.zUnitRadiusRatio - chassisLiftY;
  return hipY +
    cfgLegs.radius * STANDING_PELVIS_CENTER_LIFT_RATIO +
    cfgLegs.radius * STANDING_PELVIS_HEIGHT_RATIO * 0.5;
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
  if (unitBlueprintId === 'unitRex') return 'titan';
  return 'generic';
}

function armRole(variant: StandingVariant, side: number): StandingArmRole {
  // The Human carries its weapon on the right. The Commander deliberately
  // separates equipment: construction on the right, beam weapon on the left.
  // A titan carries a gun in each hand, so neither arm is ever free.
  if (variant === 'commander') return side < 0 ? 'construction' : 'weapon';
  if (variant === 'titan') return 'weapon';
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
function poseStrut(
  strut: Strut,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  startInset = 0,
  endInset = 0,
): void {
  _segDir.set(bx - ax, by - ay, bz - az);
  const length = _segDir.length();
  if (length < 1e-5) return;
  _segDir.divideScalar(length);
  // Bone endpoints remain joint centers for IK. Only the visible shell is
  // trimmed, so it touches each housing instead of continuing invisibly
  // through the hip/knee/shoulder/elbow volume.
  const insetScale = startInset + endInset > length - 1e-4
    ? Math.max(0, length - 1e-4) / Math.max(1e-5, startInset + endInset)
    : 1;
  const visibleStart = Math.max(0, startInset) * insetScale;
  const visibleEnd = Math.max(0, endInset) * insetScale;
  const visibleLength = Math.max(1e-4, length - visibleStart - visibleEnd);
  const centerAlong = visibleStart + visibleLength * 0.5;
  const centerX = ax + _segDir.x * centerAlong;
  const centerY = ay + _segDir.y * centerAlong;
  const centerZ = az + _segDir.z * centerAlong;
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
  strut.mesh.position.set(centerX, centerY, centerZ);
  strut.mesh.scale.set(strut.width * 0.64, visibleLength, strut.depth * 0.62);
  if (strut.armor !== undefined) {
    strut.armor.quaternion.copy(_segQuat);
    strut.armor.position.set(centerX, centerY, centerZ);
    strut.armor.scale.set(
      strut.width,
      visibleLength * (strut.mesh.visible ? 0.58 : 0.96),
      strut.depth,
    );
  }
  if (strut.accent !== undefined) {
    _accentOffset
      .set(
        0,
        0,
        strut.depth * (strut.armor !== undefined ? 0.52 : 0.33) * strut.accentSide,
      )
      .applyQuaternion(_segQuat);
    strut.accent.quaternion.copy(_segQuat);
    strut.accent.position
      .set(centerX, centerY, centerZ)
      .add(_accentOffset)
      .addScaledVector(_segDir, -visibleLength * 0.04);
    strut.accent.scale.set(
      strut.width * 0.2,
      visibleLength * 0.42,
      strut.depth * 0.08,
    );
  }
}

/** Distance from an axis-aligned box center to the first face hit by the
 * center-to-child ray. Standing shoulder housings are unrotated boxes. */
function boxJointSurfaceDistance(
  box: THREE.Mesh,
  dx: number,
  dy: number,
  dz: number,
): number {
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-5) return 0;
  const nx = Math.abs(dx / length);
  const ny = Math.abs(dy / length);
  const nz = Math.abs(dz / length);
  let distance = Infinity;
  if (nx > 1e-8) distance = Math.min(distance, box.scale.x * 0.5 / nx);
  if (ny > 1e-8) distance = Math.min(distance, box.scale.y * 0.5 / ny);
  if (nz > 1e-8) distance = Math.min(distance, box.scale.z * 0.5 / nz);
  return Number.isFinite(distance) ? distance : 0;
}

/** Resolve a mechanically valid two-bone leg.
 *
 * The old pose interpolated the knee between a straight chord and an IK knee.
 * That looked straight, but silently shortened both bones at partial bend and
 * made the rendered struts stretch as the unit walked. Here hip→knee and
 * knee→foot always remain the authored lengths. An unreachable stride target
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

/** A triangle wave keeps both legs exact longitudinal opposites while making
 * the planted half linear. Unlike a sine, its stance speed does not accelerate
 * through mid-step and stall near toe-off. */
function standingLongitudinalWave(phase: number): number {
  const cycle = positiveUnitPhase(phase);
  return cycle < 0.5 ? -1 + cycle * 4 : 3 - cycle * 4;
}

/** A small authored ankle pitch during recovery. BAR's Commanders animate
 * their foot pieces as part of the walk cycle rather than solving them against
 * terrain. We keep that readable idea with four linear keys: toe-down at
 * push-off, neutral through mid-swing, toe-up before heel strike, then flat at
 * touchdown. The planted half remains completely flat. */
export function standingFootPitch(phase: number): number {
  const legPhase = positiveUnitPhase(phase);
  if (legPhase >= 0.5) return 0;
  const recovery = legPhase * 2;
  if (recovery < 0.2) {
    return THREE.MathUtils.lerp(
      0,
      STANDING_FOOT_PUSH_OFF_RAD,
      recovery / 0.2,
    );
  }
  if (recovery < 0.55) {
    return THREE.MathUtils.lerp(
      STANDING_FOOT_PUSH_OFF_RAD,
      0,
      (recovery - 0.2) / 0.35,
    );
  }
  if (recovery < 0.82) {
    return THREE.MathUtils.lerp(
      0,
      STANDING_FOOT_HEEL_STRIKE_RAD,
      (recovery - 0.55) / 0.27,
    );
  }
  return THREE.MathUtils.lerp(
    STANDING_FOOT_HEEL_STRIKE_RAD,
    0,
    (recovery - 0.82) / 0.18,
  );
}

/** Pose the whole standing biped from one gait phase.
 *
 * Each leg recovers from back to front for half a cycle, then travels linearly
 * from front to back while planted. The full-cycle travel distance is four
 * half-strides, so the local stance motion exactly cancels forward chassis
 * travel. Arms consume these resolved foot positions later; no other phase or
 * speed clock exists. */
function poseCoupledStandingGait(
  mesh: StandingMesh,
  phase: number,
  gait: number,
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
    const requestedFootLift = recoveryWave * mesh.strideLift * amplitude;
    const footY = mesh.groundLocalY + requestedFootLift;
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
    poseStrut(
      leg.thigh,
      leg.hipX, leg.hipY, leg.hipZ,
      _knee.x, _knee.y, _knee.z,
      leg.hipJoint.scale.x,
      leg.knee.scale.x,
    );
    poseStrut(
      leg.shin,
      _knee.x,
      _knee.y,
      _knee.z,
      _resolvedFoot.x,
      _resolvedFoot.y,
      _resolvedFoot.z,
      leg.knee.scale.x,
    );
    leg.knee.position.copy(_knee);
    leg.foot.position.copy(_resolvedFoot);
    // The shoe is an authored lower-body animation piece, not a terrain
    // contact solver. It always faces with the hips; only the recovery half
    // receives a modest toe/heel pitch.
    leg.foot.rotation.set(0, 0, standingFootPitch(legPhase) * amplitude);
  }
}

export function buildStandingRig(
  unitGroup: THREE.Group,
  unitRadius: number,
  unitMass: number,
  maxPropulsiveForce: number,
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
    legWidth * STANDING_PELVIS_HEIGHT_RATIO,
    hipHalfTrack * 2,
    ownerId,
  );
  pelvis.position.set(hipX, hipY + legWidth * STANDING_PELVIS_CENTER_LIFT_RATIO, 0);
  pelvis.userData.standingPelvis = true;

  const legs: StandingLeg[] = [];
  for (const side of [-1, 1] as const) {
    const hipZ = side * hipHalfTrack;
    const hipJoint = makeStandingHingeCylinder(
      hips,
      hipJointRadius * 2,
      legWidth * 0.95,
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
      knee: makeStandingHingeCylinder(
        hips,
        legWidth * 0.95,
        legWidth * 0.9,
        ownerId,
        geometryTier,
      ),
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
        false,
      ),
      forearm: makeStrut(
        group, armWidth * 0.86, armWidth * 0.78, ownerId,
        variant === 'commander' && geometryTier === 'close' ? side : 0,
        geometryTier !== 'far',
      ),
      elbow: makeStandingHingeCylinder(
        group,
        armWidth * 0.92,
        armWidth * 0.86,
        ownerId,
        geometryTier,
      ),
      wrist,
      attachment,
      handX: 0,
      handY: 0,
      handZ: 0,
      aimX: 1,
      aimY: 0,
      aimZ: 0,
    });
  }

  return {
    type: 'standing',
    variant,
    group,
    hips,
    pelvis,
    upperBodyYaw: 0,
    upperBodyWorldYaw: null,
    upperBodyYawVelocity: 0,
    upperBodyYawSpringGain: standingUpperBodyYawSpringGain(
      unitMass,
      unitRadius,
      maxPropulsiveForce,
    ),
    turretLockActive: false,
    turretAimMemory: new Map(),
    legs,
    arms,
    contact: rollingContact(0, 0),
    gaitPhase: 0,
    gaitDirection: 1,
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
  const shoulderInset = boxJointSurfaceDistance(
    arm.shoulderJoint,
    elbowX - arm.shoulderX,
    elbowY - arm.shoulderY,
    elbowZ - arm.shoulderZ,
  );
  const elbowInset = arm.elbow.scale.x;
  poseStrut(
    arm.upper,
    arm.shoulderX, arm.shoulderY, arm.shoulderZ,
    elbowX, elbowY, elbowZ,
    shoulderInset,
    elbowInset,
  );
  poseStrut(
    arm.forearm,
    elbowX, elbowY, elbowZ,
    handX, handY, handZ,
    elbowInset,
    arm.wrist.visible ? arm.wrist.scale.y * 0.5 : 0,
  );
  arm.elbow.position.set(elbowX, elbowY, elbowZ);
  arm.wrist.position.set(handX, handY, handZ);
  arm.wrist.quaternion.copy(arm.forearm.mesh.quaternion);
  arm.attachment.position.set(handX, handY, handZ);
  arm.attachment.quaternion.copy(arm.forearm.mesh.quaternion);
  arm.handX = handX;
  arm.handY = handY;
  arm.handZ = handZ;
  // Where this arm points, for whatever it is holding. A folded arm is never
  // zero-length, so the guard is only there so a degenerate authored segment
  // leaves the last direction alone instead of publishing NaN.
  const reachX = handX - elbowX;
  const reachY = handY - elbowY;
  const reachZ = handZ - elbowZ;
  const reach = Math.hypot(reachX, reachY, reachZ);
  if (reach > 1e-6) {
    arm.aimX = reachX / reach;
    arm.aimY = reachY / reach;
    arm.aimZ = reachZ / reach;
  }
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

  if (mesh.upperBodyWorldYaw === null) {
    // upperBodyYaw is Three-local and therefore the inverse of sim-local yaw:
    // localThree = hostSim - torsoWorldSim.
    mesh.upperBodyWorldYaw = hostYaw - mesh.upperBodyYaw;
    mesh.upperBodyYawVelocity = 0;
  }
  const targetWorldYaw = selectedPriority > 0 ? selectedYaw : hostYaw;
  const dt = elapsedMs / 1000;
  if (dt <= 0 && selectedPriority > 0) {
    // Zero-delta setup/preview passes have no elapsed time to animate. Keep
    // their established direct-pose behavior without leaking momentum into
    // the first live frame.
    mesh.upperBodyWorldYaw = targetWorldYaw;
    mesh.upperBodyYawVelocity = 0;
  } else {
    stepStandingUpperBodyYaw(mesh, targetWorldYaw, dt);
  }
  // The lifted upper body is parented under the locomotion yaw. Derive only
  // the local counter/assist twist here; the persistent inertial controller
  // above never sees that moving parent frame.
  mesh.upperBodyYaw = shortestAngleDelta(mesh.upperBodyWorldYaw, hostYaw);

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

/** Rendered orientation of a gun held by `armId`, as the local yaw/pitch a
 *  turret rig applies to its own yaw and pitch groups.
 *
 *  A standing host aims with its body: the torso carries the weapon heading
 *  and the arm carries the elevation, and the gun is bolted to the hand at
 *  the end of that chain. So the arm direction IS the gun direction, and a
 *  held turret must not also articulate on its own — that would express one
 *  aim twice and leave the barrel visibly disagreeing with the arm holding
 *  it. Every other host keeps the ordinary turret pose, where the mount is
 *  fixed to the hull and only the turret moves.
 *
 *  Returned in the same chassis-local frame `resolveStandingArmTurretRoot`
 *  reports its position in, and using the same convention as
 *  applyTurretAimPose3D: barrel along local +X, yaw about Y, pitch about Z. */
export function resolveStandingArmTurretAim(
  mesh: StandingMesh,
  armId: StandingArmId,
  out: StandingArmTurretAim,
): StandingArmTurretAim | null {
  const arm = mesh.arms.find((candidate) => candidate.id === armId);
  if (arm === undefined) return null;
  out.yaw = Math.atan2(-arm.aimZ, arm.aimX);
  out.pitch = Math.asin(clampUnit(arm.aimY));
  return out;
}

export function updateStandingRig(
  mesh: StandingMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
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
    if (Math.abs(strideDistance) > 1e-6) {
      mesh.gaitDirection = strideDistance < 0 ? -1 : 1;
    }
    mesh.gaitPhase = positiveUnitPhase(
      mesh.gaitPhase + strideDistance / Math.max(1, mesh.gaitCycleDistance),
    );
  }
  poseCoupledStandingGait(mesh, mesh.gaitPhase, mesh.gait);
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
