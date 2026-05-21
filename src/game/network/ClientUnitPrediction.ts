import {
  getClientUnitGroundNormalEmaMode,
  getMovementPosEmaMode,
  getMovementVelEmaMode,
  getPredictionMode,
  getRotationPosEmaMode,
  getRotationVelEmaMode,
} from '@/clientBarConfig';
import { LAND_CELL_SIZE } from '../../config';
import { UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC } from '@/shellConfig';
import type { Entity, TurretState } from '../sim/types';
import {
  angleDeltaAbs,
  clamp,
  lerp,
  lerpAngle,
  magnitude3,
  normalizeAngle,
} from '../math';
import { getChannelBlend, halfLifeBlend } from './driftEma';
import type { PredictionStep } from './ClientPredictionCadence';
import { advanceUnitSuspension } from '../sim/unitSuspension';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import {
  advanceUnitMotionPhysicsMutable,
  type MutableUnitMotion3,
} from '../sim/unitMotionIntegration';
import { getUnitAirFrictionDamp } from '../sim/unitAirFriction';
import {
  getUnitGroundFrictionDamp,
  isUnitGroundPenetrationInContact,
} from '../sim/unitGroundPhysics';
import { CT_TURRET_STATE_ENGAGED } from '../sim-wasm/init';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from '../sim/combat/targetingInputStamping';
import type { ServerTarget } from './ClientPredictionTargets';

const PREDICTION_POS_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_VEL_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_ROT_EPSILON = 0.001;
const PREDICTION_TURRET_EPSILON = 0.001;
const PREDICTION_GROUND_REST_PENETRATION_EPSILON = 0.1;
const TURRET_PITCH_MIN = -Math.PI / 2;
const TURRET_PITCH_MAX = Math.PI / 2;

type UnitPredictionTarget = ServerTarget;

// Slab-first read of the per-turret engaged state. On the host the
// targeting Rust kernel is the authoritative source; on a remote
// client the slab is unstamped and we fall back to the snapshot-
// hydrated JS Turret.state.
const _predictFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: null,
};
function isTurretEngaged(
  entity: Entity,
  weaponIndex: number,
  jsState: TurretState,
): boolean {
  return readCombatTargetingTurretFsmInto(entity, weaponIndex, _predictFsm)
    ? _predictFsm.stateCode === CT_TURRET_STATE_ENGAGED
    : jsState === 'engaged';
}

function advanceTurretYaw(angle: number, angularVelocity: number, dt: number): number {
  const safeAngle = Number.isFinite(angle) ? angle : 0;
  const safeVelocity = Number.isFinite(angularVelocity) ? angularVelocity : 0;
  const safeDt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  return normalizeAngle(safeAngle + safeVelocity * safeDt);
}

// Reused in the per-turret prediction loop; callers copy fields immediately.
const turretPitchStepScratch = { pitch: 0, pitchVelocity: 0 };
function advanceTurretPitch(
  pitch: number,
  pitchVelocity: number,
  dt: number,
): { pitch: number; pitchVelocity: number } {
  const safePitch = Number.isFinite(pitch) ? pitch : 0;
  const safeVelocity = Number.isFinite(pitchVelocity) ? pitchVelocity : 0;
  const safeDt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const nextPitch = safePitch + safeVelocity * safeDt;
  const clampedPitch = clamp(nextPitch, TURRET_PITCH_MIN, TURRET_PITCH_MAX);
  turretPitchStepScratch.pitch = clampedPitch;
  turretPitchStepScratch.pitchVelocity = clampedPitch === nextPitch ? safeVelocity : 0;
  return turretPitchStepScratch;
}

const motionScratch: MutableUnitMotion3 = {
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
};

const targetMotionScratch: MutableUnitMotion3 = {
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
};

let predictionMapWidth = 2000;
let predictionMapHeight = 2000;

function getPredictionGroundZ(x: number, y: number): number {
  return getSurfaceHeight(
    x,
    y,
    predictionMapWidth,
    predictionMapHeight,
    LAND_CELL_SIZE,
  );
}

function getPredictionGroundNormal(
  x: number,
  y: number,
): { nx: number; ny: number; nz: number } {
  return getSurfaceNormal(
    x,
    y,
    predictionMapWidth,
    predictionMapHeight,
    LAND_CELL_SIZE,
  );
}

function motionVelocitySq(motion: MutableUnitMotion3): number {
  const vx = motion.vx;
  const vy = motion.vy;
  const vz = motion.vz;
  return vx * vx + vy * vy + vz * vz;
}

function advanceSharedUnitMotionPrediction(
  motion: MutableUnitMotion3,
  dt: number,
  groundOffset: number,
  airDamp: number,
  groundDamp: number,
): boolean {
  // PLAYER CLIENT bar: PREDICT mode gates how aggressively the
  // client extrapolates motion between snapshots.
  //   'pos' — no integration. The per-channel drift lerp downstream
  //            still pulls the entity to snapshot position; this just
  //            stops the client from running any kinematic step itself.
  //   'vel' — integrate position from the last-seen velocity each
  //            frame. Acceleration is never on the wire (the client
  //            ships velocity, not forces), so there is no ACC mode.
  const mode = getPredictionMode();
  const groundZ = getPredictionGroundZ(motion.x, motion.y);
  const penetration = groundZ - (motion.z - groundOffset);
  const contact = isUnitGroundPenetrationInContact(penetration);

  if (mode === 'pos') {
    if (contact) {
      motion.z = groundZ + groundOffset;
    }
    return contact;
  }

  if (
    contact &&
    penetration <= PREDICTION_GROUND_REST_PENETRATION_EPSILON &&
    motionVelocitySq(motion) <= PREDICTION_VEL_EPSILON_SQ
  ) {
    motion.z = groundZ + groundOffset;
    motion.vx = 0;
    motion.vy = 0;
    motion.vz = 0;
    return true;
  }

  // Powered acceleration intentionally zero: the client receives
  // velocity-only and integrates that forward. Gravity is owned by the
  // server-side force solver — re-applying it here would stale-double
  // the pull against the velocity already encoded in the snapshot.
  advanceUnitMotionPhysicsMutable(
    motion,
    dt,
    groundOffset,
    0,
    0,
    0,
    airDamp,
    groundDamp,
    0,
    0,
    0,
    getPredictionGroundZ,
    getPredictionGroundNormal,
  );

  const nextGroundZ = getPredictionGroundZ(motion.x, motion.y);
  return isUnitGroundPenetrationInContact(
    nextGroundZ - (motion.z - groundOffset),
  );
}

function advanceTargetExtrapolation(
  target: UnitPredictionTarget,
  dt: number,
  airDamp: number,
  groundDamp: number,
): void {
  targetMotionScratch.x = target.x;
  targetMotionScratch.y = target.y;
  targetMotionScratch.z = target.z;
  targetMotionScratch.vx = target.velocityX ?? 0;
  targetMotionScratch.vy = target.velocityY ?? 0;
  targetMotionScratch.vz = target.velocityZ ?? 0;

  target.predictedGroundContact = advanceSharedUnitMotionPrediction(
    targetMotionScratch,
    dt,
    target.bodyCenterHeight,
    airDamp,
    groundDamp,
  );

  target.x = targetMotionScratch.x;
  target.y = targetMotionScratch.y;
  target.z = targetMotionScratch.z;
  target.velocityX = targetMotionScratch.vx;
  target.velocityY = targetMotionScratch.vy;
  target.velocityZ = targetMotionScratch.vz;
}

function advanceUnitMotionState(
  unit: NonNullable<Entity['unit']>,
  motion: MutableUnitMotion3,
  dt: number,
  airDamp: number,
  groundDamp: number,
): boolean {
  return advanceSharedUnitMotionPrediction(
    motion,
    dt,
    unit.bodyCenterHeight,
    airDamp,
    groundDamp,
  );
}

export function applyClientUnitVisualPrediction(options: {
  entity: Entity;
  target: UnitPredictionTarget | undefined;
  deltaMs: number;
  mapWidth: number;
  mapHeight: number;
}): void {
  const { entity, target, deltaMs, mapWidth, mapHeight } = options;
  if (!entity.unit) return;
  const dt = deltaMs / 1000;
  const movPosBlend = getChannelBlend(getMovementPosEmaMode(), dt);
  const movVelBlend = getChannelBlend(getMovementVelEmaMode(), dt);
  const rotPosBlend = getChannelBlend(getRotationPosEmaMode(), dt);
  const rotVelBlend = getChannelBlend(getRotationVelEmaMode(), dt);
  const airDamp = getUnitAirFrictionDamp(dt);
  const groundDamp = getUnitGroundFrictionDamp(dt);
  predictionMapWidth = mapWidth;
  predictionMapHeight = mapHeight;

  if (target) {
    // Unit body motion is a visual contract, not an optional detail.
    // Keep this smooth at render cadence.
    advanceTargetExtrapolation(target, dt, airDamp, groundDamp);
  }

  motionScratch.x = entity.transform.x;
  motionScratch.y = entity.transform.y;
  motionScratch.z = entity.transform.z;
  motionScratch.vx = entity.unit.velocityX ?? 0;
  motionScratch.vy = entity.unit.velocityY ?? 0;
  motionScratch.vz = entity.unit.velocityZ ?? 0;
  const legContact = advanceUnitMotionState(
    entity.unit,
    motionScratch,
    dt,
    airDamp,
    groundDamp,
  );
  entity.transform.x = motionScratch.x;
  entity.transform.y = motionScratch.y;
  entity.transform.z = motionScratch.z;
  entity.unit.velocityX = motionScratch.vx;
  entity.unit.velocityY = motionScratch.vy;
  entity.unit.velocityZ = motionScratch.vz;
  advanceUnitSuspension(entity.unit, entity.transform.rotation, deltaMs, { legContact });

  if (!target) return;

  // Movement position channel — snap / EMA.
  if (movPosBlend >= 0) {
    entity.transform.x = lerp(entity.transform.x, target.x, movPosBlend);
    entity.transform.y = lerp(entity.transform.y, target.y, movPosBlend);
    entity.transform.z = lerp(entity.transform.z, target.z, movPosBlend);
  }

  // Rotation position channel — covers the body yaw scalar AND, below,
  // each turret's rotation/pitch.
  if (rotPosBlend >= 0) {
    entity.transform.rotation = lerpAngle(
      entity.transform.rotation,
      target.rotation,
      rotPosBlend,
    );
  }

  // Movement velocity channel.
  if (movVelBlend >= 0) {
    entity.unit.velocityX = lerp(
      entity.unit.velocityX ?? 0,
      target.velocityX ?? 0,
      movVelBlend,
    );
    entity.unit.velocityY = lerp(
      entity.unit.velocityY ?? 0,
      target.velocityY ?? 0,
      movVelBlend,
    );
    entity.unit.velocityZ = lerp(
      entity.unit.velocityZ ?? 0,
      target.velocityZ ?? 0,
      movVelBlend,
    );
  }

  // Full 3-DOF orientation drift for hover-style units. The body
  // quaternion is the rotation-position channel for hovers; we use the
  // same blend factor as the yaw scalar so changing the rotation-pos
  // EMA mode affects both ground and hover bodies consistently. We
  // componentwise-lerp + renormalize rather than slerp because the
  // per-frame blend is small (a few percent of the remaining error)
  // and componentwise lerp is much cheaper.
  if (rotPosBlend >= 0 && target.orientation && entity.unit.orientation) {
    const eo = entity.unit.orientation;
    const to = target.orientation;
    eo.x = lerp(eo.x, to.x, rotPosBlend);
    eo.y = lerp(eo.y, to.y, rotPosBlend);
    eo.z = lerp(eo.z, to.z, rotPosBlend);
    eo.w = lerp(eo.w, to.w, rotPosBlend);
    const m2 = eo.x * eo.x + eo.y * eo.y + eo.z * eo.z + eo.w * eo.w;
    if (m2 > 1e-12) {
      const inv = 1 / Math.sqrt(m2);
      eo.x *= inv; eo.y *= inv; eo.z *= inv; eo.w *= inv;
    }
  }

  // Hover angular velocity — paired with orientation. Blends with the
  // rotation-velocity channel.
  if (
    rotVelBlend >= 0
    && entity.unit.angularVelocity3
    && target.angularVelocityX !== undefined
  ) {
    const av = entity.unit.angularVelocity3;
    av.x = lerp(av.x, target.angularVelocityX, rotVelBlend);
    av.y = lerp(av.y, target.angularVelocityY ?? 0, rotVelBlend);
    av.z = lerp(av.z, target.angularVelocityZ ?? 0, rotVelBlend);
  }

  // Unit Ground Normal EMA is its own knob — orthogonal to the per-channel snapshot
  // drift — because it smooths a SERVER-side EMA's output (slope
  // normal), not a snapshot drift correction. Always applied.
  const normalAlpha = halfLifeBlend(
    dt,
    UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC[getClientUnitGroundNormalEmaMode()],
  );
  const sn = entity.unit.surfaceNormal;
  const tnx = sn.nx + (target.surfaceNormalX - sn.nx) * normalAlpha;
  const tny = sn.ny + (target.surfaceNormalY - sn.ny) * normalAlpha;
  const tnz = sn.nz + (target.surfaceNormalZ - sn.nz) * normalAlpha;
  const tlen = magnitude3(tnx, tny, tnz);
  if (tlen > 1e-6) {
    const inv = 1 / tlen;
    sn.nx = tnx * inv;
    sn.ny = tny * inv;
    sn.nz = tnz * inv;
  }
}

export function applyClientCombatExpensivePrediction(options: {
  entity: Entity;
  target: UnitPredictionTarget | undefined;
  predictionStep: PredictionStep;
  forceFieldsEnabled: boolean;
}): void {
  const { entity, target, predictionStep, forceFieldsEnabled } = options;
  if (!entity.combat) return;
  const dt = predictionStep.entityDeltaMs / 1000;
  const targetDt = predictionStep.targetDeltaMs / 1000;
  const rotPosBlend = getChannelBlend(getRotationPosEmaMode(), dt);
  const rotVelBlend = getChannelBlend(getRotationVelEmaMode(), dt);

  // PREDICT mode gates turret yaw / pitch integration. POS skips both
  // and only the per-channel rotation-position EMA pulls toward the
  // snapshot rotation. VEL integrates rotation from angular velocity.
  // Angular acceleration is not on the wire, so the velocity-only
  // integrator is the only available kinematic step.
  const predictionMode = getPredictionMode();
  const integrateRotation = predictionMode !== 'pos';
  const turrets = entity.combat.turrets;
  for (let i = 0; i < turrets.length; i++) {
    const weapon = turrets[i];
    if (weapon.config.visualOnly) continue;
    if (integrateRotation) {
      weapon.rotation = advanceTurretYaw(weapon.rotation, weapon.angularVelocity, dt);
      const pitchStep = advanceTurretPitch(weapon.pitch, weapon.pitchVelocity, dt);
      weapon.pitch = pitchStep.pitch;
      weapon.pitchVelocity = pitchStep.pitchVelocity;
    }

    const tw = target?.turrets?.[i];
    if (tw) {
      if (integrateRotation) {
        tw.rotation = advanceTurretYaw(tw.rotation, tw.angularVelocity, targetDt);
        const targetPitchStep = advanceTurretPitch(tw.pitch, tw.pitchVelocity, targetDt);
        tw.pitch = targetPitchStep.pitch;
        tw.pitchVelocity = targetPitchStep.pitchVelocity;
      }
      if (rotPosBlend >= 0) {
        weapon.rotation = normalizeAngle(lerpAngle(weapon.rotation, tw.rotation, rotPosBlend));
        weapon.pitch = clamp(
          lerpAngle(weapon.pitch, tw.pitch, rotPosBlend),
          TURRET_PITCH_MIN,
          TURRET_PITCH_MAX,
        );
      }
      if (rotVelBlend >= 0) {
        weapon.angularVelocity = lerp(
          weapon.angularVelocity,
          tw.angularVelocity,
          rotVelBlend,
        );
        weapon.pitchVelocity = lerp(
          weapon.pitchVelocity,
          tw.pitchVelocity,
          rotVelBlend,
        );
      }
    }

    const shot = weapon.config.shot;
    if (!shot || shot.type !== 'force') continue;
    if (!forceFieldsEnabled) {
      if (weapon.forceField) {
        weapon.forceField.range = 0;
        weapon.forceField.transition = 0;
      }
      continue;
    }
    const fieldShot = shot;
    const cur = weapon.forceField?.range ?? 0;
    const targetProgress = isTurretEngaged(entity, i, weapon.state) ? 1 : 0;
    const progressDelta = dt / (fieldShot.transitionTime / 1000);
    let next = cur;
    if (cur < targetProgress) {
      next = Math.min(cur + progressDelta, 1);
    } else if (cur > targetProgress) {
      next = Math.max(cur - progressDelta, 0);
    }

    // The force-field range is a slow visual transition, not a
    // snapshot-drift channel. It rides along with rotation-position
    // correction.
    const serverRange = tw?.forceFieldRange;
    if (serverRange !== undefined && rotPosBlend >= 0) {
      next = lerp(next, serverRange, rotPosBlend);
    }
    if (!weapon.forceField) {
      weapon.forceField = { range: next, transition: 0 };
    } else {
      weapon.forceField.range = next;
    }
  }
}

export function clientUnitPredictionIsSettled(
  entity: Entity,
  target: UnitPredictionTarget | undefined,
  forceFieldsEnabled: boolean,
): boolean {
  const unit = entity.unit;
  if (unit) {
    const vx = unit.velocityX ?? 0;
    const vy = unit.velocityY ?? 0;
    const vz = unit.velocityZ ?? 0;
    if (vx * vx + vy * vy + vz * vz > PREDICTION_VEL_EPSILON_SQ) return false;

    if (target) {
      const tvx = target.velocityX ?? 0;
      const tvy = target.velocityY ?? 0;
      const tvz = target.velocityZ ?? 0;
      if (tvx * tvx + tvy * tvy + tvz * tvz > PREDICTION_VEL_EPSILON_SQ) return false;

      const dx = entity.transform.x - target.x;
      const dy = entity.transform.y - target.y;
      const dz = entity.transform.z - target.z;
      if (dx * dx + dy * dy + dz * dz > PREDICTION_POS_EPSILON_SQ) return false;
      if (angleDeltaAbs(entity.transform.rotation, target.rotation) > PREDICTION_ROT_EPSILON) return false;
    }
  }

  const weapons = entity.combat?.turrets;
  if (!weapons || weapons.length === 0) return true;

  for (let i = 0; i < weapons.length; i++) {
    const weapon = weapons[i];
    if (weapon.config.visualOnly) continue;
    if (Math.abs(weapon.angularVelocity) > PREDICTION_TURRET_EPSILON) return false;

    const tw = target?.turrets?.[i];
    if (tw) {
      if (Math.abs(tw.angularVelocity) > PREDICTION_TURRET_EPSILON) return false;
      if (angleDeltaAbs(weapon.rotation, tw.rotation) > PREDICTION_TURRET_EPSILON) return false;
      if (angleDeltaAbs(weapon.pitch, tw.pitch) > PREDICTION_TURRET_EPSILON) return false;
      if (forceFieldsEnabled) {
        const localRange = weapon.forceField?.range ?? 0;
        const targetRange = tw.forceFieldRange ?? 0;
        if (Math.abs(localRange - targetRange) > PREDICTION_TURRET_EPSILON) return false;
      }
    }

    if (forceFieldsEnabled && weapon.config.shot?.type === 'force') {
      if ((weapon.forceField?.range ?? 0) > PREDICTION_TURRET_EPSILON) return false;
      if (isTurretEngaged(entity, i, weapon.state)) return false;
    }
  }

  return true;
}
