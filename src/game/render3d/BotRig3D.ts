// BotRig3D — the biped. Two legs, one required arm pair, an optional upper
// pair, and nothing borrowed from the arachnid leg rig.
//
// WHY NOT `crawler`. The crawler rig solves a spider: each limb owns an independent
// reach shell and chooses a world-space foothold. A bot mech instead owns
// one coupled biped cycle and visible hip sockets. Its stopped pose may open
// each straight support column slightly forward and outward, but that authored
// stance blends back into the shared sagittal walk rather than becoming a
// second foothold controller.
//
// THE WALK IS ONE COUPLED BIPED CYCLE. Unlike `crawler`, a bot unit does not
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
  BotArms,
  BotLegs,
  UnitTurretHostAttachment,
} from '@/types/blueprintSchema.generated';
import type { Entity, PlayerId, Turret } from '../sim/types';
import { NO_ENTITY_ID } from '../sim/types';
import { deterministicMath as DMath } from '../sim/deterministicMath';
import {
  getSharedPrimitiveCylinderGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import {
  rollingContact,
  sampleRollingContactDistance,
  transformChassisToWorld,
  transformWorldVectorToChassis,
  type LocomotionBase,
  type LocomotionRenderPose,
  type RollingContactState,
} from './LocomotionRigShared3D';
import { getLocomotionMatByCache } from './RenderUtils';
import { COLORS } from '@/colorsConfig';
import { getConstructionHostMarkingProfiles } from '@/constructionVisualConfig';
import { buildConstructionHostMarking } from './ConstructionHostMarking3D';
import type { ClientRenderTurretHostRows } from './ClientRenderTurretStateSlab';
import {
  readHostTurretAimSample3D,
  type HostTurretAimSample3D,
} from './HostTurretAim3D';
import { clampUnit } from '../math';
import {
  resolveBotWeaponArmSocketPose,
  selectBotTorsoTurretIndex,
  shortestBotSocketAngleDelta,
  type BotArmSocketPose,
} from '../math/BotHostSocketGeometry';

const SEGMENT_COLOR = COLORS.units.locomotion.leg.segment.colorHex;
const segmentMaterials = new Map<number, THREE.MeshLambertMaterial>();
const unitBox = new THREE.BoxGeometry(1, 1, 1);
unitBox.name = 'botRigBox';
const botAccentGlowMaterial = new THREE.MeshBasicMaterial({
  color: COLORS.units.unitCommander.lens.colorHex,
});

type BotVariant = 'commander' | 'constructor' | 'human' | 'titan' | 'generic';
type BotArmRole = 'weapon' | 'construction' | 'free';
export type BotArmHostAttachment = Extract<
  UnitTurretHostAttachment,
  { kind: 'botArm' }
>;
type BotArmId = BotArmHostAttachment['arm'];

/** Local yaw/pitch a held turret takes from the arm carrying it. */
type BotArmTurretAim = { yaw: number; pitch: number };

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

type BotLeg = {
  /** -1 right, +1 left in the bot frame's lateral axis. */
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
  /** The sole's world XZ and whether it is in its stance half, published for
   *  ground prints so a footprint lands exactly under the drawn foot. False
   *  until the first posed frame. */
  footTracked: boolean;
  footPlanted: boolean;
  footWorldX: number;
  footWorldZ: number;
  /** Sim heading the sole points along — the print is a rectangle, so it
   *  needs the foot's direction, not just its centre. */
  footYaw: number;
};

type BotArm = {
  id: BotArmId;
  side: number;
  role: BotArmRole;
  /** Pair-local blueprint geometry. Upper arms may deliberately use different
   * proportions and an opposite elbow direction from the primary pair. */
  config: BotArms;
  shoulderX: number;
  shoulderY: number;
  shoulderZ: number;
  upperLength: number;
  forearmLength: number;
  outwardRad: number;
  elbowVerticalSign: -1 | 1;
  swingRad: number;
  restRad: number;
  actionBlend: number;
  /** Host-selected echo of an attached turret's current pitch. The turret
   *  still pitches itself; this only makes the carrier arm help the motion. */
  turretAimActive: boolean;
  /** Previous-frame activity used to initialize heavy-arm presentation
   * damping without easing in from an unrelated idle pose. */
  turretAimActiveLastFrame: boolean;
  turretAimPitch: number;
  /** Authoritative arm yaw relative to the shared upper-body piece. */
  turretAimYaw: number;
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
  /** Unit vector elbow -> hand, chassis-local. This is host-piece geometry;
   * the turret still applies its authoritative world yaw/pitch inside the
   * hand socket. */
  aimX: number;
  aimY: number;
  aimZ: number;
};

export type BotMesh = {
  type: 'bot';
  variant: BotVariant;
  /** Physical-size presentation profile. Compact bots retain the complete
   * authored rig and motion, but use chunkier, lower-piece-count limb shells. */
  compactGeometry: boolean;
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
  /** Local Three.js yaw applied to the upper-body host piece. Derived from the
   *  authoritative waist-servo pose and the chassis heading. */
  upperBodyYaw: number;
  /** Current upper-body heading in simulation/world yaw coordinates. Null is
   *  the uninitialized render-state sentinel retained for capture compatibility. */
  upperBodyWorldYaw: number | null;
  /** Authoritative waist-servo velocity, retained across geometry rebuilds. */
  upperBodyYawVelocity: number;
  /** Diagnostic flag indicating that at least one authoritative weapon arm is
   *  currently driven by an attached turret. Each arm still follows only its
   *  own turret; this flag never changes the host piece-tree solution. */
  turretLockActive: boolean;
  legs: BotLeg[];
  arms: BotArm[];
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
  /** Ground plane in the lifted rig's local frame. */
  groundLocalY: number;
  unitRadius: number;
} & LocomotionBase;

/** Below these rates a bot unit is visually at rest. */
const IDLE_SPEED = 1.5;
const IDLE_YAW_RATE = 0.12;
/** Seconds for the bot gait amplitude to ease in and out. */
const GAIT_EASE_SECONDS = 0.16;
/** How far the elbow follows the shoulder, as a fraction of shoulder swing. */
const ELBOW_FOLLOW = 0.28;
/** Constant global forearm pitch. The source BAR commander carries roughly
 *  50 degrees of elbow fold through the walk; the old 17-degree fold made
 *  both arms hang like ropes. */
const ELBOW_BEND_RAD = THREE.MathUtils.degToRad(52);
/** No bot arm may become a straight hanging rod, even under turret or
 * construction assistance. */
const MIN_ELBOW_BEND_RAD = THREE.MathUtils.degToRad(28);
/** Arms ease from walk swing into a working pose rather than snapping. */
const ARM_ACTION_EASE_SECONDS = 0.11;
/** Rex carries far more weapon mass than the ordinary bots. Damping only its
 * visible arm response prevents tiny consecutive targeting corrections from
 * reading as firing vibration while the logical turret remains exact. */
const REX_WEAPON_ARM_AIM_EASE_SECONDS = 0.12;
const STANDING_PELVIS_CENTER_LIFT_RATIO = 0.26;
const STANDING_PELVIS_HEIGHT_RATIO = 0.82;
/** Human-scale and construction bipeds are too small on screen for nested
 * actuator shells to read. Commander- and titan-scale bots stay fully authored. */
export const COMPACT_BOT_MAX_UNIT_RADIUS = 18;
export const COMPACT_BOT_LIMB_WIDTH_SCALE = 1.14;
/** Conventional authored shoe roll, based on the BAR Commander approach.
 * The angles are deliberately restrained at RTS camera distance. */
const STANDING_FOOT_PUSH_OFF_RAD = THREE.MathUtils.degToRad(-14);
const STANDING_FOOT_HEEL_STRIKE_RAD = THREE.MathUtils.degToRad(10);

const _knee = new THREE.Vector3();
const _resolvedFoot = new THREE.Vector3();
const _chord = new THREE.Vector3();
const _bendDirection = new THREE.Vector3();
const _chassisVelocity = { x: 0, y: 0, z: 0 };
const _footWorld = { x: 0, y: 0, z: 0 };
const _footForward = { x: 0, y: 0, z: 0 };
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
const _weaponArmSocketPose: BotArmSocketPose = {
  elbowX: 0,
  elbowY: 0,
  elbowZ: 0,
  handX: 0,
  handY: 0,
  handZ: 0,
  aimX: 1,
  aimY: 0,
  aimZ: 0,
};

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
    accent = new THREE.Mesh(unitBox, botAccentGlowMaterial);
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

/** A bot limb joint is a hinge housing, not another limb block. The shared
 * cylinder's authored axis is local Y; rotate it onto bot-local Z so the
 * axle runs across the limb while the round profile reads in its bend plane. */
function makeBotHingeCylinder(
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

/** Upper seam of the lower-body pelvis in the lifted bot-rig frame.
 * Bot chassis art begins on this exact plane so no hidden upper-body
 * blocks extend down inside the independently yawing hips. */
export function getBotPelvisTopLocalY(
  unitRadius: number,
  cfgLegs: BotLegs,
  chassisLiftY: number,
): number {
  const hipY = unitRadius * cfgLegs.hip.zUnitRadiusRatio - chassisLiftY;
  return hipY +
    cfgLegs.radius * STANDING_PELVIS_CENTER_LIFT_RATIO +
    cfgLegs.radius * STANDING_PELVIS_HEIGHT_RATIO * 0.5;
}

/** Compact BAR-style mech boot: a real outsole with a raised heel, quarter,
 *  sloped instep and toe box. Bot feet turn with their legs, so this
 *  volume can read as a simple shoe instead of a ground-pinned landing pad. */
function makeFoot(
  parent: THREE.Group,
  length: number,
  width: number,
  ownerId: PlayerId | undefined,
  variant: BotVariant,
  geometryTier: PrimitiveGeometryTier,
  compactGeometry: boolean,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.botShoe = true;
  const soleHeight = Math.max(0.36, width * 0.13);
  const sole = makeBlock(group, length * 0.80, soleHeight, width * 0.90, ownerId);
  sole.position.set(length * 0.01, soleHeight * 0.5, 0);

  if (!compactGeometry && geometryTier !== 'far') {
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
  quarter.userData.botShoeUpper = true;
  quarter.position.set(-length * 0.19, soleHeight + quarterHeight * 0.5, 0);
  quarter.rotation.z = THREE.MathUtils.degToRad(-7);

  if ((!compactGeometry && geometryTier !== 'far') ||
    (compactGeometry && geometryTier === 'close')) {
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
  toe.userData.botShoeToe = true;
  toe.position.set(length * 0.34, soleHeight + toeHeight * 0.5, 0);
  toe.rotation.z = THREE.MathUtils.degToRad(-4);

  if (variant === 'commander' && geometryTier === 'close') {
    const toeAccent = new THREE.Mesh(unitBox, botAccentGlowMaterial);
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

function botVariant(unitBlueprintId: string | undefined): BotVariant {
  if (unitBlueprintId === 'unitCommander') return 'commander';
  if (
    unitBlueprintId === 'unitConstructionBot' ||
    unitBlueprintId === 'unitAdvancedConstructionBot'
  ) {
    return 'constructor';
  }
  if (unitBlueprintId === 'unitHuman') return 'human';
  if (unitBlueprintId === 'unitRex') return 'titan';
  return 'generic';
}

function armRole(variant: BotVariant, side: number): BotArmRole {
  // The Human carries its weapon on the right. The Commander deliberately
  // separates equipment: construction on the right, beam weapon on the left.
  // A construction bot is a builder first: the same tool arm on the right,
  // and an unarmed free hand on the left. A titan carries a gun in each
  // hand, so neither arm is ever free.
  if (variant === 'commander') return side < 0 ? 'construction' : 'weapon';
  if (variant === 'constructor') return side < 0 ? 'construction' : 'free';
  if (variant === 'titan') return 'weapon';
  if (side < 0) return 'weapon';
  return 'free';
}

function botArmId(side: number, upper: boolean): BotArmId {
  // The bot frame is right-handed: +X forward and +Y/Three +Z left.
  // The negative-lateral limb is therefore the host's right arm.
  if (upper) return side < 0 ? 'rightUpperArm' : 'leftUpperArm';
  return side < 0 ? 'rightArm' : 'leftArm';
}

function addConstructionToolArm(
  attachment: THREE.Group,
  unitRadius: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier,
  unitBlueprintId: string,
): void {
  const housing = makeBlock(
    attachment,
    unitRadius * 0.26,
    unitRadius * 0.48,
    unitRadius * 0.32,
    ownerId,
  );
  housing.position.y = -unitRadius * 0.17;
  housing.userData.botConstructionTool = true;

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
  toolHead.userData.botConstructionTool = true;

  for (const profile of getConstructionHostMarkingProfiles(unitBlueprintId)) {
    if (profile.attach !== 'constructionArm') continue;
    attachment.add(buildConstructionHostMarking(profile, unitRadius, geometryTier));
  }

  // Two bright nano nozzles make the construction side readable even when
  // the hazard sleeve is edge-on. They are a tool, not a second weapon.
  if (geometryTier !== 'far') for (const side of [-1, 1] as const) {
    const prong = new THREE.Mesh(unitBox, botAccentGlowMaterial);
    prong.position.set(0, unitRadius * 0.30, side * unitRadius * 0.105);
    prong.scale.set(unitRadius * 0.07, unitRadius * 0.30, unitRadius * 0.055);
    prong.userData.botWorkEmitter = true;
    attachment.add(prong);
  }
}

/** Point a strut from `a` to `b` and stretch it to span them.
 *
 *  Aligning local Y with `setFromUnitVectors` leaves roll unconstrained. That
 *  is harmless for a cylinder but makes an armoured box visibly corkscrew as
 *  an arm crosses vertical. Projecting the bot rig's lateral axis onto
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
 * center-to-child ray. Bot shoulder housings are unrotated boxes. */
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
function solveBotKnee(
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
function botLongitudinalWave(phase: number): number {
  const cycle = positiveUnitPhase(phase);
  return cycle < 0.5 ? -1 + cycle * 4 : 3 - cycle * 4;
}

/** A small authored ankle pitch during recovery. BAR's Commanders animate
 * their foot pieces as part of the walk cycle rather than solving them against
 * terrain. We keep that readable idea with four linear keys: toe-down at
 * push-off, neutral through mid-swing, toe-up before heel strike, then flat at
 * touchdown. The planted half remains completely flat. */
export function botFootPitch(phase: number): number {
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

/** Publish each sole's world XZ and stance state for ground prints. The feet
 *  are posed in the hips frame, which yaws inside the hull to cancel the
 *  upper body's turret assistance, so undo that yaw before the chassis
 *  transform. A leg is planted through its stance half of the cycle, and
 *  the whole time while the walk amplitude is out (standing). */
function publishBotFootContacts(mesh: BotMesh, pose: LocomotionRenderPose): void {
  const hipsYaw = mesh.hips.rotation.y;
  const cosYaw = Math.cos(hipsYaw);
  const sinYaw = Math.sin(hipsYaw);
  const standing = mesh.gait < 0.05;
  // The sole points along the hips frame's +X; carry that direction through
  // the same chassis transform (as a point minus the base) so the print's
  // rectangle turns with the leg, not with the upper body.
  transformChassisToWorld(cosYaw, 0, -sinYaw, pose, _footForward);
  const footYaw = Math.atan2(_footForward.z - pose.baseZ, _footForward.x - pose.baseX);
  for (const leg of mesh.legs) {
    const localX = leg.footLocalX * cosYaw + leg.footLocalZ * sinYaw;
    const localZ = -leg.footLocalX * sinYaw + leg.footLocalZ * cosYaw;
    transformChassisToWorld(localX, mesh.groundLocalY, localZ, pose, _footWorld);
    const legPhase = positiveUnitPhase(mesh.gaitPhase + (leg.side > 0 ? 0.5 : 0));
    leg.footWorldX = _footWorld.x;
    leg.footWorldZ = _footWorld.z;
    leg.footYaw = footYaw;
    leg.footPlanted = standing || legPhase >= 0.5;
    leg.footTracked = true;
  }
}

/** Pose the whole bot biped from one gait phase.
 *
 * Each leg recovers from back to front for half a cycle, then travels linearly
 * from front to back while planted. The full-cycle travel distance is four
 * half-strides, so the local stance motion exactly cancels forward chassis
 * travel. Arms consume these resolved foot positions later; no other phase or
 * speed clock exists. */
function poseCoupledBotGait(
  mesh: BotMesh,
  phase: number,
  gait: number,
): void {
  const cycle = positiveUnitPhase(phase);
  const amplitude = THREE.MathUtils.clamp(gait, 0, 1);
  const stanceBlend = 1 - amplitude;
  const halfStride = mesh.gaitCycleDistance * 0.25;
  for (const leg of mesh.legs) {
    const legPhase = positiveUnitPhase(cycle + (leg.side > 0 ? 0.5 : 0));
    const longitudinalWave = botLongitudinalWave(legPhase);
    const recoveryWave = legPhase < 0.5
      ? Math.sin(legPhase * Math.PI * 2)
      : 0;
    const footX = leg.hipX + mesh.stanceForward * stanceBlend +
      longitudinalWave * halfStride * amplitude;
    const footZ = leg.hipZ + leg.side * mesh.stanceOutward * stanceBlend;
    const requestedFootLift = recoveryWave * mesh.strideLift * amplitude;
    const footY = mesh.groundLocalY + requestedFootLift;
    solveBotKnee(
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
    leg.foot.rotation.set(0, 0, botFootPitch(legPhase) * amplitude);
  }
}

export function buildBotRig(
  unitGroup: THREE.Group,
  unitRadius: number,
  _unitMass: number,
  _maxPropulsiveForce: number,
  cfgLegs: BotLegs,
  cfgArms: BotArms,
  cfgUpperArms: BotArms | undefined,
  chassisLiftY: number,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
  unitBlueprintId?: string,
): BotMesh {
  const variant = botVariant(unitBlueprintId);
  const compactGeometry = unitRadius <= COMPACT_BOT_MAX_UNIT_RADIUS;
  const geometryWidthScale = compactGeometry ? COMPACT_BOT_LIMB_WIDTH_SCALE : 1;
  const jointGeometryTier: PrimitiveGeometryTier = compactGeometry
    ? (geometryTier === 'close' ? 'mid' : 'far')
    : geometryTier;
  const group = new THREE.Group();
  unitGroup.add(group);
  const hips = new THREE.Group();
  group.add(hips);

  const thighLength = unitRadius * cfgLegs.segments.upper.lengthUnitRadiusRatio;
  const shinLength = unitRadius * cfgLegs.segments.lower.lengthUnitRadiusRatio;
  const legLength = thighLength + shinLength;
  const legWidth = cfgLegs.radius * geometryWidthScale;
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
  pelvis.userData.botPelvis = true;

  const legs: BotLeg[] = [];
  for (const side of [-1, 1] as const) {
    const hipZ = side * hipHalfTrack;
    const hipJoint = makeBotHingeCylinder(
      hips,
      hipJointRadius * 2,
      legWidth * 0.95,
      ownerId,
      jointGeometryTier,
    );
    hipJoint.position.set(hipX, hipY, hipZ);
    hipJoint.userData.botHipJoint = true;
    const leg: BotLeg = {
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
        !compactGeometry && geometryTier !== 'far',
      ),
      shin: makeStrut(
        hips, legWidth * 0.78, legWidth * 0.66, ownerId,
        variant === 'commander' && geometryTier === 'close' ? side : 0,
        !compactGeometry && geometryTier !== 'far',
      ),
      knee: makeBotHingeCylinder(
        hips,
        legWidth * 0.95,
        legWidth * 0.9,
        ownerId,
        jointGeometryTier,
      ),
      foot: makeFoot(
        hips,
        footLength,
        footWidth,
        ownerId,
        variant,
        geometryTier,
        compactGeometry,
      ),
      footLocalX: hipX,
      footLocalZ: hipZ,
      footTracked: false,
      footPlanted: false,
      footWorldX: 0,
      footWorldZ: 0,
      footYaw: 0,
    };
    legs.push(leg);
  }

  const arms: BotArm[] = [];
  const armPairs = [
    { config: cfgArms, upper: false },
    ...(cfgUpperArms === undefined ? [] : [{ config: cfgUpperArms, upper: true }]),
  ];
  for (const pair of armPairs) {
    const armWidth = pair.config.radius * geometryWidthScale;
    const upperLength = unitRadius * pair.config.segments.upper.lengthUnitRadiusRatio;
    const forearmLength = unitRadius * pair.config.segments.lower.lengthUnitRadiusRatio;
    for (const side of [-1, 1] as const) {
      const attachment = new THREE.Group();
      group.add(attachment);
      const role = pair.upper ? 'weapon' : armRole(variant, side);
      if (role === 'construction') {
        addConstructionToolArm(
          attachment,
          unitRadius,
          ownerId,
          geometryTier,
          unitBlueprintId ?? 'unitCommander',
        );
      }
      const wrist = makeBlock(
        group,
        armWidth * pair.config.handRadiusRatio,
        armWidth * pair.config.handRadiusRatio * 0.8,
        armWidth * pair.config.handRadiusRatio,
        ownerId,
      );
      // A visible fist underneath an arm cannon doubles the hand volume and
      // hides its muzzle. The held weapon is the hand on this side.
      wrist.visible = role !== 'weapon';
      const shoulderX = unitRadius * pair.config.shoulder.xUnitRadiusRatio;
      const shoulderY = unitRadius * pair.config.shoulder.zUnitRadiusRatio - chassisLiftY;
      const shoulderZ = side * unitRadius * pair.config.shoulder.yUnitRadiusRatio;
      const shoulderJoint = makeBlock(
        group,
        armWidth * 1.12,
        armWidth * 1.08,
        armWidth * 1.18,
        ownerId,
      );
      shoulderJoint.position.set(shoulderX, shoulderY, shoulderZ);
      shoulderJoint.userData.botShoulderJoint = true;
      shoulderJoint.userData.botUpperArmShoulderJoint = pair.upper;
      arms.push({
        id: botArmId(side, pair.upper),
        side,
        role,
        config: pair.config,
        shoulderX,
        shoulderY,
        shoulderZ,
        upperLength,
        forearmLength,
        outwardRad: THREE.MathUtils.degToRad(pair.config.outwardDeg),
        elbowVerticalSign: pair.config.elbowBendDirection === 'downward' ? 1 : -1,
        swingRad: THREE.MathUtils.degToRad(pair.config.walkSwingDeg),
        restRad: THREE.MathUtils.degToRad(pair.config.restSwingDeg),
        actionBlend: 0,
        turretAimActive: false,
        turretAimActiveLastFrame: false,
        turretAimPitch: 0,
        turretAimYaw: 0,
        shoulderJoint,
        upper: makeStrut(
          group, armWidth, armWidth * 0.9, ownerId,
          variant === 'commander' && geometryTier === 'close' ? side : 0,
          !compactGeometry && geometryTier !== 'far',
          false,
        ),
        forearm: makeStrut(
          group, armWidth * 0.86, armWidth * 0.78, ownerId,
          variant === 'commander' && geometryTier === 'close' ? side : 0,
          !compactGeometry && geometryTier !== 'far',
        ),
        elbow: makeBotHingeCylinder(
          group,
          armWidth * 0.92,
          armWidth * 0.86,
          ownerId,
          jointGeometryTier,
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
  }

  return {
    type: 'bot',
    variant,
    compactGeometry,
    group,
    hips,
    pelvis,
    upperBodyYaw: 0,
    upperBodyWorldYaw: null,
    upperBodyYawVelocity: 0,
    turretLockActive: false,
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
    groundLocalY: -chassisLiftY,
    unitRadius,
    geometryKey: '',
  };
}

function poseArm(
  arm: BotArm,
  shoulderPitch: number,
  forearmPitch: number,
): void {
  const upperPlanar = Math.cos(arm.outwardRad) * arm.upperLength;
  const elbowX = arm.shoulderX + Math.sin(shoulderPitch) * upperPlanar;
  const elbowY = arm.shoulderY +
    arm.elbowVerticalSign * Math.cos(shoulderPitch) * upperPlanar;
  const elbowZ = arm.shoulderZ + arm.side * Math.sin(arm.outwardRad) * arm.upperLength;
  const forearmOutward = arm.outwardRad * 0.72;
  const forearmPlanar = Math.cos(forearmOutward) * arm.forearmLength;
  const handX = elbowX + Math.sin(forearmPitch) * forearmPlanar;
  const handY = elbowY - Math.cos(forearmPitch) * forearmPlanar;
  const handZ = elbowZ + arm.side * Math.sin(forearmOutward) * arm.forearmLength;
  poseResolvedArm(arm, elbowX, elbowY, elbowZ, handX, handY, handZ);
}

function poseResolvedArm(
  arm: BotArm,
  elbowX: number,
  elbowY: number,
  elbowZ: number,
  handX: number,
  handY: number,
  handZ: number,
): void {
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

/** Resolve the renderer from the same deterministic host-piece contract used
 * by simulation. The nominated primary turret owns the shared torso piece;
 * every attached arm receives its own turret yaw/pitch. */
export function updateBotHostTurretAim(
  mesh: BotMesh,
  hostYaw: number,
  turretRows: ClientRenderTurretHostRows | undefined,
  turrets: readonly Turret[],
  dtMs: number,
): number {
  for (const arm of mesh.arms) {
    arm.turretAimActiveLastFrame = arm.turretAimActive;
    arm.turretAimActive = false;
  }
  const torsoTurretIndex = selectBotTorsoTurretIndex(turrets);
  const torsoOwner = torsoTurretIndex >= 0 ? turrets[torsoTurretIndex] : undefined;
  const torsoStateRow = torsoTurretIndex >= 0 && turretRows !== undefined &&
      torsoTurretIndex < turretRows.count
    ? turretRows.start + torsoTurretIndex
    : -1;
  const rowHostYaw = torsoStateRow >= 0
    ? turretRows!.views.hostPieceYaw?.[torsoStateRow] ?? Number.NaN
    : Number.NaN;
  let torsoWorldYaw = Number.isFinite(rowHostYaw)
    ? rowHostYaw
    : torsoOwner !== undefined && Number.isFinite(torsoOwner.hostPieceYaw)
      ? torsoOwner.hostPieceYaw
    : hostYaw;
  // Loading previews and legacy snapshots can precede the first authoritative
  // host-piece tick. Preserve their useful direct-pose fallback; live bot
  // entities receive a finite servo pose before combat emission.
  if (
    torsoOwner !== undefined &&
    !Number.isFinite(torsoOwner.hostPieceYaw) &&
    readHostTurretAimSample3D(
      turretRows,
      turrets,
      torsoTurretIndex,
      _hostTurretAimSample,
    )
  ) {
    torsoWorldYaw = _hostTurretAimSample.yaw;
  }

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

    if (attachment.kind !== 'botArm') continue;
    const arm = mesh.arms.find((candidate) => candidate.id === attachment.arm);
    if (arm === undefined || arm.turretAimActive) continue;
    arm.turretAimActive = true;
    const desiredPitch = _hostTurretAimSample.pitch;
    const desiredYaw = shortestBotSocketAngleDelta(
      torsoWorldYaw,
      _hostTurretAimSample.yaw,
    );
    if (
      mesh.variant === 'titan' &&
      arm.turretAimActiveLastFrame &&
      dtMs > 0
    ) {
      const alpha = 1 - Math.exp(
        -Math.max(0, dtMs) / 1000 / REX_WEAPON_ARM_AIM_EASE_SECONDS,
      );
      arm.turretAimPitch += (desiredPitch - arm.turretAimPitch) * alpha;
      arm.turretAimYaw += shortestBotSocketAngleDelta(
        arm.turretAimYaw,
        desiredYaw,
      ) * alpha;
    } else {
      arm.turretAimPitch = desiredPitch;
      arm.turretAimYaw = desiredYaw;
    }
  }

  for (const arm of mesh.arms) {
    if (arm.turretAimActive) continue;
    arm.turretAimPitch = 0;
    arm.turretAimYaw = 0;
  }

  mesh.turretLockActive = mesh.arms.some((arm) => arm.turretAimActive);
  mesh.upperBodyWorldYaw = torsoWorldYaw;
  mesh.upperBodyYawVelocity = torsoStateRow >= 0
    ? turretRows!.views.hostPieceYawVelocity?.[torsoStateRow] ?? 0
    : torsoOwner?.hostPieceYawVelocity ?? 0;
  // Three's +Y rotation is the inverse sign of sim yaw in the x/z mapping.
  mesh.upperBodyYaw = shortestBotSocketAngleDelta(torsoWorldYaw, hostYaw);
  return mesh.upperBodyYaw;
}

function armActionActive(entity: Entity | undefined, arm: BotArm): boolean {
  if (arm.role === 'construction') {
    return entity !== undefined &&
      entity.builder !== null &&
      (
        (
          entity.builder.workStation !== null &&
          entity.builder.workStation.targetEntityId !== NO_ENTITY_ID
        ) ||
        entity.builder.currentBuildTarget !== NO_ENTITY_ID
      );
  }
  return arm.turretAimActive;
}

function poseArms(
  mesh: BotMesh,
  entity: Entity | undefined,
  dt: number,
): void {
  const actionEase = dt <= 0 ? 1 : 1 - Math.exp(-dt / ARM_ACTION_EASE_SECONDS);
  for (const arm of mesh.arms) {
    const workStation = arm.role === 'construction'
      ? entity?.builder?.workStation ?? null
      : null;
    if (workStation !== null && workStation.targetEntityId !== NO_ENTITY_ID) {
      resolveBotWeaponArmSocketPose(
        arm.config,
        mesh.unitRadius,
        arm.id,
        arm.shoulderY,
        workStation.localPitch,
        workStation.localYaw,
        DMath,
        _weaponArmSocketPose,
      );
      poseResolvedArm(
        arm,
        _weaponArmSocketPose.elbowX,
        _weaponArmSocketPose.elbowZ,
        _weaponArmSocketPose.elbowY,
        _weaponArmSocketPose.handX,
        _weaponArmSocketPose.handZ,
        _weaponArmSocketPose.handY,
      );
      arm.actionBlend = 1;
      continue;
    }
    if (arm.turretAimActive) {
      resolveBotWeaponArmSocketPose(
        arm.config,
        mesh.unitRadius,
        arm.id,
        arm.shoulderY,
        arm.turretAimPitch,
        arm.turretAimYaw,
        DMath,
        _weaponArmSocketPose,
      );
      poseResolvedArm(
        arm,
        _weaponArmSocketPose.elbowX,
        _weaponArmSocketPose.elbowZ,
        _weaponArmSocketPose.elbowY,
        _weaponArmSocketPose.handX,
        _weaponArmSocketPose.handZ,
        _weaponArmSocketPose.handY,
      );
      arm.actionBlend = 1;
      continue;
    }
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
    const armWave = -legForward;
    const actionTarget = armActionActive(entity, arm) ? 1 : 0;
    arm.actionBlend += (actionTarget - arm.actionBlend) * actionEase;

    // Same-side free/construction arms oppose the leg and keep the forearm
    // deeply folded. Weapon arms returned above and never enter this gait path.
    const walkShoulder = arm.restRad + armWave * arm.swingRad;
    const restForearmBend = ELBOW_BEND_RAD;
    const walkForearm = walkShoulder * ELBOW_FOLLOW
      + restForearmBend
      - armWave * arm.swingRad * 0.32;
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

/** Resolve the visible AimFrom root from the same authoritative weapon-hand
 * geometry used by simulation. The root is lowered by headRadius because a
 * turret mesh root sits below its logical head-center pivot. */
export function resolveBotArmTurretRoot(
  mesh: BotMesh,
  attachment: BotArmHostAttachment,
  headRadius: number,
  out: THREE.Vector3 = _turretMount,
): THREE.Vector3 | null {
  const arm = mesh.arms.find((candidate) => candidate.id === attachment.arm);
  if (arm === undefined) return null;
  out.set(
    arm.handX + attachment.socketOffset.x * mesh.unitRadius,
    arm.handY + attachment.socketOffset.z * mesh.unitRadius - headRadius,
    arm.handZ + attachment.socketOffset.y * mesh.unitRadius,
  );
  return out;
}

/** Diagnostic direction of the solved forearm for contract tests and visual
 *  tooling. This is not the turret aim: the arm owns the moving parent socket,
 *  while the attached logical turret still applies its own yaw and pitch. */
export function resolveBotArmTurretAim(
  mesh: BotMesh,
  armId: BotArmId,
  out: BotArmTurretAim,
): BotArmTurretAim | null {
  const arm = mesh.arms.find((candidate) => candidate.id === armId);
  if (arm === undefined) return null;
  out.yaw = Math.atan2(-arm.aimZ, arm.aimX);
  out.pitch = Math.asin(clampUnit(arm.aimY));
  return out;
}

export function updateBotRig(
  mesh: BotMesh,
  entity: Entity,
  pose: LocomotionRenderPose,
  dtMs: number,
): boolean {
  const dt = Math.max(0, dtMs) / 1000;
  const travelled = sampleRollingContactDistance(pose, mesh.contact);

  // LOWER BODY. Bot legs are ordinary locomotion: they inherit the same
  // authoritative unit orientation as wheels or treads. The renderer applies
  // optional turret assistance to the lifted upper body, so the hips cancel
  // only that relative offset and never invent a second travel-facing yaw.
  const planarSpeed = Math.hypot(pose.velocityX, pose.velocityZ);
  const turningSpeed = Math.abs(pose.yawRate) * mesh.unitRadius;
  const locomotionSpeed = Math.max(planarSpeed, turningSpeed);
  // A beam-carried bot hangs in the tractor field: the carrier drags its
  // world position (and its velocity mirrors the carrier's), so both the
  // speed gate and the travel-distance sampler would fake a full walk
  // cycle in mid-air.
  const moving = !pose.carried && (planarSpeed > IDLE_SPEED ||
    Math.abs(pose.yawRate) > IDLE_YAW_RATE);
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
  poseCoupledBotGait(mesh, mesh.gaitPhase, mesh.gait);
  publishBotFootContacts(mesh, pose);
  poseArms(mesh, entity, dt);

  return true;
}

/** Standstill pose, for a preview card or a unit built before its first tick. */
export function poseBotRigAtRest(mesh: BotMesh): void {
  mesh.hips.rotation.y = -mesh.upperBodyYaw;
  poseCoupledBotGait(mesh, mesh.gaitPhase, 0);
  poseArms(mesh, undefined, 0);
}

/** The Entity Lab uses the exact same coupled gait sampler as the battlefield. */
export function poseBotRigAtPreviewCycle(
  mesh: BotMesh,
  phase: number,
  gait: number,
): void {
  mesh.hips.rotation.y = -mesh.upperBodyYaw;
  poseCoupledBotGait(mesh, phase, gait);
  poseArms(mesh, undefined, 0);
}
