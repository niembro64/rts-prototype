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
import type {
  StandingArms,
  StandingLegs,
  UnitTurretHostAttachment,
} from '@/types/blueprintSchema.generated';
import type { Entity, PlayerId, Turret } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
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
export type StandingArmId = UnitTurretHostAttachment['arm'];

type StandingTurretAimMemory = {
  initialized: boolean;
  yaw: number;
  pitch: number;
  manualHoldMs: number;
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
  /** Compact sole, ankle armour, and two or three forward digits. */
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
  /** Most recently resolved longitudinal foot position in the hip frame.
   *  Arms read this pose directly so their counter-swing cannot drift out of
   *  phase with foothold-driven legs. */
  footLocalX: number;
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
   *  A commander keeps its torso — and therefore its weapons — pointed at what
   *  it is shooting or building while its legs go somewhere else entirely. The
   *  hull carries the facing; the hips carry the walk. Everything the rig does
   *  in a leg's plane is unchanged, because the plane turns with the hips. */
  hips: THREE.Group;
  hipYaw: number;
  /** Presentation-only local Three.js yaw applied by the host to its upper
   *  body. Turret world aim remains authoritative and independently posed. */
  upperBodyYaw: number;
  turretAimMemory: Map<string, StandingTurretAimMemory>;
  legs: StandingLeg[];
  arms: StandingArm[];
  /** Ground distance used to estimate visible gait amplitude. The legs are
   *  driven by where their feet are, not by a clock. */
  contact: RollingContactState;
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
  wasMoving: boolean;
  settling: boolean;
  armSwingRad: number;
  armRestRad: number;
  /** Ground plane in the lifted rig's local frame. */
  groundLocalY: number;
  unitRadius: number;
} & LocomotionBase;

/** Shortest and longest a swing may take, seconds. Between them the swing
 *  lasts as long as the hull needs to cover half a step, so a slow walk places
 *  its feet slowly and a run snaps them down. */
const SWING_MIN_SECONDS = 0.14;
const SWING_MAX_SECONDS = 0.55;
/** A foothold further than this from where the leg wants it, as a fraction of
 *  the step length, is overdue and the leg picks a new one. */
const STEP_TRIGGER_FRACTION = 0.4;
/** Below this ground speed the unit is standing, not walking, and a standing
 *  mech does not shuffle: no step may START while idle.
 *
 *  Reach alone is not enough of a rule. A hull that is stopped still drifts a
 *  little — prediction settling, a hip yaw easing back to square, a contact
 *  point resampling — and any of it can nudge a hip past the trigger and set a
 *  foot swinging for no reason a viewer can see. A leg already in the air
 *  finishes its step; it is only the decision to start one that is gated. */
const IDLE_SPEED = 1.5;
/** ...but turning on the spot is NOT standing. A `standing` unit pushes along
 *  its own facing, so it turns before it walks, and that turn has no velocity
 *  in it at all — gated on speed alone the commander would pivot with its feet
 *  welded to the ground and then set off already twisted. */
const IDLE_YAW_RATE = 0.12;
/** Seconds for the arm swing amplitude to ease in and out. */
const GAIT_EASE_SECONDS = 0.16;
/** Ground speed at which the arms reach full swing, world units/sec. */
const ARM_FULL_SWING_SPEED = 22;
/** How far the elbow follows the shoulder, as a fraction of shoulder swing. */
const ELBOW_FOLLOW = 0.28;
/** Constant global forearm pitch. The source BAR commander carries roughly
 *  50 degrees of elbow fold through the walk; the old 17-degree fold made
 *  both arms hang like ropes. */
const ELBOW_BEND_RAD = THREE.MathUtils.degToRad(52);
/** A stopped BAR walker returns to its authored symmetric stance instead of
 *  freezing forever in the last long stride. Each foot gets one short,
 *  alternating recovery step. */
const SETTLE_TRIGGER_FRACTION = 0.12;
const SETTLE_SECONDS = 0.28;
/** Arms that are building or aiming ease from walk swing into their working
 *  pose independently; the other arm remains free to counter-swing. */
const ARM_ACTION_EASE_SECONDS = 0.11;
/** Seconds for the hips to swing most of the way to the travel heading. Slow
 *  enough that a commander turning on the spot pivots rather than snapping. */
const HIP_YAW_EASE_SECONDS = 0.22;
/** Below this speed there is no travel direction to point the hips at, so they
 *  square back up under the torso. */
const HIP_YAW_MIN_SPEED = 3;
/** A standing torso helps an arm-mounted turret without turning all the way
 *  backwards. The turret remains free to cover the rest of its own traverse. */
const UPPER_BODY_YAW_LIMIT = THREE.MathUtils.degToRad(85);
const UPPER_BODY_YAW_EASE_SECONDS = 0.12;
/** Manual emitters such as the Commander's D-gun have no tracking FSM lock.
 *  A changed authoritative pose therefore grants them a short host-assist
 *  window, long enough for the torso/arm echo to visibly follow the shot. */
const MANUAL_TURRET_ASSIST_HOLD_MS = 420;
const MANUAL_TURRET_POSE_EPSILON = 1e-4;

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

function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
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

/** Compact BAR-style mech foot: a low heel/sole, an armoured ankle wedge, and
 *  narrow forward digits. The old implementation made every toe more than a
 *  third of the complete foot width and overlapped the two feet into one huge
 *  pink boulder. */
function makeFoot(
  parent: THREE.Group,
  length: number,
  width: number,
  ownerId: PlayerId | undefined,
  variant: StandingVariant,
  geometryTier: PrimitiveGeometryTier,
): THREE.Group {
  const group = new THREE.Group();
  const soleHeight = Math.max(0.3, width * 0.10);
  const sole = makeBlock(group, length * 0.68, soleHeight, width * 0.86, ownerId);
  sole.position.set(-length * 0.04, soleHeight * 0.5, 0);

  if (geometryTier !== 'far') {
    const heel = makeBlock(group, length * 0.28, soleHeight * 1.5, width * 0.68, ownerId);
    heel.position.set(-length * 0.37, soleHeight * 0.75, 0);
  }

  // The ankle armour supplies the apparent height. Keeping it behind the
  // digits leaves a readable toe break from the RTS camera.
  const ankle = makeBlock(
    group,
    length * (variant === 'commander' ? 0.34 : 0.30),
    Math.max(soleHeight * 2.5, width * 0.34),
    width * 0.68,
    ownerId,
  );
  ankle.position.set(-length * 0.20, ankle.scale.y * 0.5 + soleHeight, 0);
  ankle.rotation.z = THREE.MathUtils.degToRad(-8);

  const toeCount = geometryTier === 'far' ? 2 : variant === 'commander' ? 3 : 2;
  const toeWidth = width * (variant === 'commander' ? 0.20 : 0.31);
  const toeSpacing = toeCount === 3 ? width * 0.28 : width * 0.24;
  for (let i = 0; i < toeCount; i++) {
    const lateral = (i - (toeCount - 1) * 0.5) * toeSpacing;
    const toe = makeBlock(group, length * 0.40, soleHeight * 0.72, toeWidth, ownerId);
    toe.position.set(length * 0.34, soleHeight * 0.44, lateral);
    // Splay the outer digits by a few degrees, like the commander's clawed
    // sole, without turning them into the old starfish feet.
    toe.rotation.y = THREE.MathUtils.degToRad((i - (toeCount - 1) * 0.5) * 5);
    if (variant === 'commander' && geometryTier === 'close') {
      const accent = new THREE.Mesh(unitBox, constructionEmitterMaterial);
      accent.position.set(length * 0.38, soleHeight * 0.86, lateral);
      accent.scale.set(length * 0.26, Math.max(0.12, soleHeight * 0.18), toeWidth * 0.52);
      accent.rotation.y = toe.rotation.y;
      group.add(accent);
    }
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
  // Both authored standing units carry their weapon on the negative-lateral
  // arm. The Commander reserves the opposite arm for the construction kit.
  if (side < 0) return 'weapon';
  if (variant === 'commander') return 'construction';
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

  const profile = getConstructionHostMarkingProfile('unitCommander');
  if (profile !== null) attachment.add(
    buildConstructionHostMarking(profile, unitRadius, geometryTier),
  );

  // Two bright nano nozzles make the construction side readable even when
  // the hazard sleeve is edge-on. They are a tool, not a second weapon.
  if (geometryTier !== 'far') for (const side of [-1, 1] as const) {
    const prong = new THREE.Mesh(unitBox, constructionEmitterMaterial);
    prong.position.set(unitRadius * 0.14, -unitRadius * 0.43, side * unitRadius * 0.085);
    prong.scale.set(unitRadius * 0.18, unitRadius * 0.06, unitRadius * 0.045);
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
  strut.armor.position
    .set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5)
    .addScaledVector(_segDir, -length * 0.05);
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
      footX: 0,
      footY: 0,
      footZ: 0,
      footLocalX: unitRadius * cfgLegs.hip.xUnitRadiusRatio,
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
    arms.push({
      id: standingArmId(side),
      side,
      role,
      shoulderX: unitRadius * cfgArms.shoulder.xUnitRadiusRatio,
      shoulderY: unitRadius * cfgArms.shoulder.zUnitRadiusRatio - chassisLiftY,
      shoulderZ: side * unitRadius * cfgArms.shoulder.yUnitRadiusRatio,
      upperLength,
      forearmLength,
      outwardRad: THREE.MathUtils.degToRad(cfgArms.outwardDeg),
      actionBlend: 0,
      turretAimActive: false,
      turretAimPitch: 0,
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
    hipYaw: 0,
    upperBodyYaw: 0,
    turretAimMemory: new Map(),
    legs,
    arms,
    contact: rollingContact(0, 0),
    gait: 0,
    stepLength: Math.max(1, legLength * cfgLegs.strideLengthRatio),
    strideLift: Math.max(0.5, legLength * cfgLegs.strideLiftRatio),
    standHipY: legLength * cfgLegs.standHeightRatio,
    swingingLeg: -1,
    wasMoving: false,
    settling: false,
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
  for (const arm of mesh.arms) arm.turretAimActive = false;

  const elapsedMs = Math.max(0, dtMs);
  let selectedPriority = 0;
  let selectedYaw = 0;
  let selectedPitch = 0;
  let selectedArm: StandingArmId | null = null;

  for (let turretIndex = 0; turretIndex < turrets.length; turretIndex++) {
    const turret = turrets[turretIndex];
    const attachment = turret.config.hostAttachment;
    if (attachment?.kind !== 'standingArm') continue;
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
      if (yawChanged || pitchChanged) {
        memory.manualHoldMs = MANUAL_TURRET_ASSIST_HOLD_MS;
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
    selectedArm = attachment.arm;
  }

  const localSimYaw = selectedPriority > 0
    ? THREE.MathUtils.clamp(
      shortestAngleDelta(hostYaw, selectedYaw),
      -UPPER_BODY_YAW_LIMIT,
      UPPER_BODY_YAW_LIMIT,
    )
    : 0;
  // Sim yaw is around +Z; Three yaw is around +Y with the opposite sign.
  const targetUpperBodyYaw = -localSimYaw;
  const dt = elapsedMs / 1000;
  const yawEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / UPPER_BODY_YAW_EASE_SECONDS);
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
  previewGait?: number,
): void {
  const gait = previewGait ?? mesh.gait;
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
    // true for the foothold gait instead of hoping a second clock stays synced.
    const armWave = -legForward;
    const actionTarget = armActionActive(entity, arm) ? 1 : 0;
    arm.actionBlend += (actionTarget - arm.actionBlend) * actionEase;

    // Same-side arm opposes the leg and the forearm remains deeply folded.
    // Aiming/building takes over only that arm, matching BAR's independent
    // leftArm/rightArm animation gates.
    const walkShoulder = mesh.armRestRad + armWave * mesh.armSwingRad * gait;
    const restForearmBend = mesh.variant === 'commander'
      ? THREE.MathUtils.degToRad(28)
      : ELBOW_BEND_RAD;
    const walkForearm = walkShoulder * ELBOW_FOLLOW
      + restForearmBend
      - armWave * mesh.armSwingRad * 0.32 * gait;
    const turretPitchAssist = THREE.MathUtils.clamp(
      arm.turretAimPitch,
      THREE.MathUtils.degToRad(-45),
      THREE.MathUtils.degToRad(75),
    );
    const actionShoulder = arm.role === 'construction'
      ? THREE.MathUtils.degToRad(18)
      : THREE.MathUtils.degToRad(24) + turretPitchAssist * 0.55;
    const actionForearm = arm.role === 'construction'
      ? THREE.MathUtils.degToRad(mesh.variant === 'commander' ? 38 : 68)
      : THREE.MathUtils.degToRad(80) + turretPitchAssist * 0.45;
    poseArm(
      arm,
      THREE.MathUtils.lerp(walkShoulder, actionShoulder, arm.actionBlend),
      THREE.MathUtils.lerp(walkForearm, actionForearm, arm.actionBlend),
    );
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
    } else if (mountId === 'disruptor') {
      centerYOffset = -mesh.unitRadius * 0.05;
      lateralOffset = arm.side * mesh.unitRadius * 0.10;
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
  const moving = planarSpeed > IDLE_SPEED || Math.abs(pose.yawRate) > IDLE_YAW_RATE;
  if (moving) mesh.settling = false;
  else if (mesh.wasMoving) mesh.settling = true;
  mesh.wasMoving = moving;
  const targetHipYaw = planarSpeed > HIP_YAW_MIN_SPEED
    ? Math.atan2(-_localVelocity.z, _localVelocity.x)
    : 0;
  const hipEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / HIP_YAW_EASE_SECONDS);
  let hipDelta = targetHipYaw - mesh.hipYaw;
  while (hipDelta > Math.PI) hipDelta -= Math.PI * 2;
  while (hipDelta < -Math.PI) hipDelta += Math.PI * 2;
  mesh.hipYaw += hipDelta * hipEase;
  // The entire lifted standing host is upper-body yawed by the renderer.
  // Counter-yaw the hips so planted legs retain the locomotion/world frame
  // while the chassis and arms intentionally help the selected turret.
  mesh.hips.rotation.y = mesh.hipYaw - mesh.upperBodyYaw;

  const gaitEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / GAIT_EASE_SECONDS);
  mesh.gait += (Math.min(1, speed / ARM_FULL_SWING_SPEED) - mesh.gait) * gaitEase;

  const swingSeconds = Math.min(
    SWING_MAX_SECONDS,
    Math.max(
      SWING_MIN_SECONDS,
      planarSpeed > 0.01 ? (mesh.stepLength * 0.5) / planarSpeed : SWING_MAX_SECONDS,
    ),
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
      const moveT = t * t * (3 - 2 * t);
      const arc = Math.sin(Math.PI * t) * mesh.strideLift;
      leg.footX = leg.fromX + (leg.toX - leg.fromX) * moveT;
      leg.footZ = leg.fromZ + (leg.toZ - leg.fromZ) * moveT;
      leg.footY = leg.fromY + (leg.toY - leg.fromY) * moveT + arc;
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
      const needsSettle = mesh.settling &&
        Math.hypot(dx, dz) > mesh.stepLength * SETTLE_TRIGGER_FRACTION;
      // One foot at a time. That rule IS a biped's balance.
      // Idle is judged on the unit's own VELOCITY, not on the rolling contact
      // that clocks the arms: the contact is sampled at the terrain footprint
      // while the hips ride the lifted root, and gating one on the other let a
      // walking commander stand still with its feet 54 units behind it.
      if ((moving ? overdue : needsSettle) && mesh.swingingLeg === -1) {
        mesh.swingingLeg = i;
        leg.stepping = true;
        leg.stepT = 0;
        leg.stepSeconds = moving ? swingSeconds : SETTLE_SECONDS;
        leg.fromX = leg.footX;
        leg.fromY = leg.footY;
        leg.fromZ = leg.footZ;
        // Land half a step PAST the hip along the direction of travel, so the
        // hip catches up to it and passes it again — which is what walking is.
        const lead = moving ? mesh.stepLength * 0.5 : 0;
        toWorld(leg.hipX + lead, leg.hipY, leg.hipZ, pose, mesh.hipYaw, _stepTarget);
        leg.toX = _stepTarget.x;
        leg.toZ = _stepTarget.z;
        leg.toY = getLocomotionSurfaceHeight(leg.toX, leg.toZ, mapWidth, mapHeight, 0);
      }
    }

    // Pose from the foothold. Back into the leg's own plane, where the knee is
    // a hinge and nothing has a third axis to wander along.
    toHipLocal(leg.footX, leg.footY, leg.footZ, pose, mesh.hipYaw, _footLocal);
    leg.footLocalX = _footLocal.x;
    solveKnee(leg.hipX, leg.hipY, _footLocal.x, _footLocal.y, leg.thighLength, leg.shinLength, _knee);
    poseStrut(leg.thigh, leg.hipX, leg.hipY, leg.hipZ, _knee.x, _knee.y, leg.hipZ);
    poseStrut(leg.shin, _knee.x, _knee.y, leg.hipZ, _footLocal.x, _footLocal.y, leg.hipZ);
    leg.knee.position.set(_knee.x, _knee.y, leg.hipZ);
    // Standing feet face down the leg plane and therefore inherit the hips'
    // yaw. Unlike the multi-legged rig they do not preserve a contact-locked
    // world angle. Toe pitch remains independent during the swing.
    leg.foot.rotation.y = 0;
    leg.foot.rotation.z = leg.stepping
      ? Math.sin(leg.stepT * Math.PI * 2) * THREE.MathUtils.degToRad(13)
        + Math.sin(leg.stepT * Math.PI) * THREE.MathUtils.degToRad(5)
      : 0;
    leg.foot.position.set(_footLocal.x, _footLocal.y, leg.hipZ);
  }

  if (!moving && mesh.settling && mesh.swingingLeg === -1) {
    let stillOffset = false;
    for (const leg of mesh.legs) {
      toWorld(leg.hipX, leg.hipY, leg.hipZ, pose, mesh.hipYaw, _hipWorld);
      if (Math.hypot(_hipWorld.x - leg.footX, _hipWorld.z - leg.footZ) >
        mesh.stepLength * SETTLE_TRIGGER_FRACTION) {
        stillOffset = true;
        break;
      }
    }
    if (!stillOffset) mesh.settling = false;
  }
  poseArms(mesh, entity, dt);

  return true;
}

/** Standstill pose, for a preview card or a unit built before its first tick. */
export function poseStandingRigAtRest(mesh: StandingMesh): void {
  mesh.hips.rotation.y = mesh.hipYaw - mesh.upperBodyYaw;
  for (const leg of mesh.legs) {
    const footY = mesh.groundLocalY;
    solveKnee(leg.hipX, leg.hipY, leg.hipX, footY, leg.thighLength, leg.shinLength, _knee);
    poseStrut(leg.thigh, leg.hipX, leg.hipY, leg.hipZ, _knee.x, _knee.y, leg.hipZ);
    poseStrut(leg.shin, _knee.x, _knee.y, leg.hipZ, leg.hipX, footY, leg.hipZ);
    leg.knee.position.set(_knee.x, _knee.y, leg.hipZ);
    leg.foot.position.set(leg.hipX, footY, leg.hipZ);
    leg.footLocalX = leg.hipX;
    leg.foot.rotation.set(0, 0, 0);
  }
  poseArms(mesh, undefined, 0, 0);
}

/** Representative flat-ground walk for the Entity Lab. The battlefield rig
 *  remains foothold-driven; this deterministic cycle exists so the lab's
 *  Walking toggle actually lets artists inspect knee, foot, and arm timing. */
export function poseStandingRigAtPreviewCycle(
  mesh: StandingMesh,
  phase: number,
  gait: number,
): void {
  mesh.hips.rotation.y = mesh.hipYaw - mesh.upperBodyYaw;
  const cycle = ((phase % 1) + 1) % 1;
  const halfStride = mesh.stepLength * 0.48;
  const swingFraction = 0.38;
  for (let i = 0; i < mesh.legs.length; i++) {
    const leg = mesh.legs[i];
    const p = (cycle + i * 0.5) % 1;
    let x: number;
    let y = mesh.groundLocalY;
    let footPitch = 0;
    if (p < swingFraction) {
      const t = p / swingFraction;
      const moveT = t * t * (3 - 2 * t);
      x = -halfStride + halfStride * 2 * moveT;
      y += Math.sin(Math.PI * t) * mesh.strideLift * gait;
      footPitch = (
        Math.sin(t * Math.PI * 2) * THREE.MathUtils.degToRad(13)
        + Math.sin(t * Math.PI) * THREE.MathUtils.degToRad(5)
      ) * gait;
    } else {
      const t = (p - swingFraction) / (1 - swingFraction);
      x = halfStride - halfStride * 2 * t;
    }
    x = leg.hipX + x * gait;
    leg.footLocalX = x;
    solveKnee(leg.hipX, leg.hipY, x, y, leg.thighLength, leg.shinLength, _knee);
    poseStrut(leg.thigh, leg.hipX, leg.hipY, leg.hipZ, _knee.x, _knee.y, leg.hipZ);
    poseStrut(leg.shin, _knee.x, _knee.y, leg.hipZ, x, y, leg.hipZ);
    leg.knee.position.set(_knee.x, _knee.y, leg.hipZ);
    leg.foot.position.set(x, y, leg.hipZ);
    leg.foot.rotation.set(0, 0, footPitch);
  }
  poseArms(mesh, undefined, 0, gait);
}

export function disposeStandingRigGeometry(): void {
  unitBox.dispose();
  for (const mat of segmentMaterials.values()) mat.dispose();
  segmentMaterials.clear();
  constructionEmitterMaterial.dispose();
}
