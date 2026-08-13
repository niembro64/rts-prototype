import type {
  BotArms,
  UnitTurretHostAttachment,
} from '@/types/blueprints';

export type BotArmId = Extract<
  UnitTurretHostAttachment,
  { kind: 'botArm' }
>['arm'];

export type BotHostTurretAttachmentSource = {
  mountIndex: number;
  config: {
    hostAttachment: UnitTurretHostAttachment | null;
    requiredEngagedForFightStop: boolean;
    articulation: {
      claimGroup: string | null;
      claimPriority: number;
    };
  };
};

export type BotArmSocketPose = {
  elbowX: number;
  elbowY: number;
  elbowZ: number;
  handX: number;
  handY: number;
  handZ: number;
  aimX: number;
  aimY: number;
  aimZ: number;
};

export type BotSocketTrig = {
  sin(value: number): number;
  cos(value: number): number;
  hypot(...values: readonly number[]): number;
};

const DEG_TO_RAD = Math.PI / 180;
const WEAPON_SHOULDER_REST_RAD = 24 * DEG_TO_RAD;
// Mechanical safety envelope for the shared arm solver. Individual weapon
// stations author tighter stops; the wider QueryWork arm range lets a builder
// service steep terrain immediately beside its feet without rotating through
// the torso or pretending a clamped hand is aligned.
const WEAPON_MIN_PITCH_RAD = -1.55;
const WEAPON_MAX_PITCH_RAD = 1.55;

export function shortestBotSocketAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/**
 * Choose the one upper-body heading that owns the bot waist joint.
 *
 * Every attached turret remains independently authoritative. The authored
 * fight-stop mount is merely the deterministic owner of the shared torso
 * piece; sibling head/arm turrets continue to yaw inside that parent. This is
 * the same piece-ownership rule BAR scripts express by turning one torso piece
 * from a nominated weapon's AimWeapon callback.
 */
export function selectBotTorsoTurretIndex(
  turrets: readonly BotHostTurretAttachmentSource[],
): number {
  let fallback = -1;
  let selected = -1;
  let selectedPriority = Number.NEGATIVE_INFINITY;
  let selectedMountIndex = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    if (turret.config.hostAttachment === null) continue;
    if (fallback < 0) fallback = i;
    if (turret.config.articulation.claimGroup !== 'botUpperBody') continue;
    const priority = turret.config.articulation.claimPriority;
    if (priority < selectedPriority) continue;
    if (priority === selectedPriority && turret.mountIndex >= selectedMountIndex) continue;
    selected = i;
    selectedPriority = priority;
    selectedMountIndex = turret.mountIndex;
  }
  return selected >= 0 ? selected : fallback;
}

export function botArmSide(arm: BotArmId): -1 | 1 {
  return arm === 'rightArm' ? -1 : 1;
}

/**
 * Resolve the fixed weapon pose of an authoritative bot arm.
 *
 * Coordinates use the simulation frame: +X forward, +Y left, +Z up. The
 * caller chooses the origin for shoulderZ, so the same function serves the
 * sim's ground-relative skeleton and the renderer's lift-group-relative rig.
 * Weapon arms do not borrow the presentation gait clock: a locomotion-only
 * animation is never allowed to move an authoritative QueryWeapon socket.
 */
export function resolveBotWeaponArmSocketPose(
  arms: BotArms,
  unitRadius: number,
  arm: BotArmId,
  shoulderZ: number,
  turretPitch: number,
  yawFromTorso: number,
  trig: BotSocketTrig,
  out: BotArmSocketPose,
): BotArmSocketPose {
  const side = botArmSide(arm);
  const shoulderX = unitRadius * arms.shoulder.xUnitRadiusRatio;
  const shoulderY = side * unitRadius * arms.shoulder.yUnitRadiusRatio;
  const upperLength = unitRadius * arms.segments.upper.lengthUnitRadiusRatio;
  const forearmLength = unitRadius * arms.segments.lower.lengthUnitRadiusRatio;
  const outward = arms.outwardDeg * DEG_TO_RAD;
  const clampedPitch = Math.max(
    WEAPON_MIN_PITCH_RAD,
    Math.min(WEAPON_MAX_PITCH_RAD, turretPitch),
  );
  const shoulderPitch = WEAPON_SHOULDER_REST_RAD + clampedPitch * 0.55;
  // The forearm is the physical emitter axis. Keep the upper arm's authored
  // outward elbow for a readable silhouette, but solve the forearm exactly to
  // the station's yaw/pitch so the visible hand, QueryWeapon/QueryWork axis,
  // and gameplay shot direction cannot disagree.
  const forearmPitch = Math.PI / 2 + clampedPitch;

  const upperPlanar = trig.cos(outward) * upperLength;
  const elbowForward = trig.sin(shoulderPitch) * upperPlanar;
  const elbowLateral = side * trig.sin(outward) * upperLength;
  const elbowUp = -trig.cos(shoulderPitch) * upperPlanar;
  const forearmPlanar = forearmLength;
  const handForward = elbowForward + trig.sin(forearmPitch) * forearmPlanar;
  const handLateral = elbowLateral;
  const handUp = elbowUp - trig.cos(forearmPitch) * forearmPlanar;

  const yawCos = trig.cos(yawFromTorso);
  const yawSin = trig.sin(yawFromTorso);
  out.elbowX = shoulderX + yawCos * elbowForward - yawSin * elbowLateral;
  out.elbowY = shoulderY + yawSin * elbowForward + yawCos * elbowLateral;
  out.elbowZ = shoulderZ + elbowUp;
  out.handX = shoulderX + yawCos * handForward - yawSin * handLateral;
  out.handY = shoulderY + yawSin * handForward + yawCos * handLateral;
  out.handZ = shoulderZ + handUp;

  const reachX = out.handX - out.elbowX;
  const reachY = out.handY - out.elbowY;
  const reachZ = out.handZ - out.elbowZ;
  const reach = trig.hypot(reachX, reachY, reachZ);
  if (reach > 1e-9) {
    out.aimX = reachX / reach;
    out.aimY = reachY / reach;
    out.aimZ = reachZ / reach;
  } else {
    out.aimX = yawCos;
    out.aimY = yawSin;
    out.aimZ = 0;
  }
  return out;
}
