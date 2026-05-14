import { getClientTiltEmaMode, getPredictionMode } from '@/clientBarConfig';
import { GRAVITY, LAND_CELL_SIZE } from '../../config';
import { TILT_EMA_HALF_LIFE_SEC } from '@/shellConfig';
import type { Entity } from '../sim/types';
import {
  lerp,
  lerpAngle,
  magnitude3,
} from '../math';
import { halfLifeBlend, type DriftPreset } from './driftEma';
import type { PredictionStep } from './ClientPredictionLod';
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
import type { ServerTarget } from './ClientPredictionTargets';

const PREDICTION_POS_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_VEL_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_ACCEL_EPSILON_SQ = 0.1 * 0.1;
const PREDICTION_ROT_EPSILON = 0.001;
const PREDICTION_TURRET_EPSILON = 0.001;
const PREDICTION_GROUND_REST_PENETRATION_EPSILON = 0.1;

type UnitPredictionTarget = ServerTarget;

function angleDeltaAbs(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
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
  movementAccelX: number,
  movementAccelY: number,
  movementAccelZ: number,
): boolean {
  // PLAYER CLIENT bar: PREDICT mode gates how aggressively the
  // client extrapolates physics between snapshots.
  //   'pos' — no integration. The drift lerp toward target.x downstream
  //            still pulls the entity to snapshot position; this just
  //            stops the client from running the F=ma chain itself.
  //   'vel' — integrate position from velocity but treat acceleration
  //            (movement input AND gravity) as zero, so velocity stays
  //            at whatever the snapshot last said.
  //   'acc' — full F=ma extrapolation (default).
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

  const useAccel = mode === 'acc';
  const poweredAx = useAccel && contact ? movementAccelX : 0;
  const poweredAy = useAccel && contact ? movementAccelY : 0;
  const poweredAz = useAccel && contact ? movementAccelZ : 0;
  const poweredAccelSq =
    poweredAx * poweredAx + poweredAy * poweredAy + poweredAz * poweredAz;

  if (
    contact &&
    poweredAccelSq <= PREDICTION_ACCEL_EPSILON_SQ &&
    penetration <= PREDICTION_GROUND_REST_PENETRATION_EPSILON &&
    motionVelocitySq(motion) <= PREDICTION_VEL_EPSILON_SQ
  ) {
    motion.z = groundZ + groundOffset;
    motion.vx = 0;
    motion.vy = 0;
    motion.vz = 0;
    return true;
  }

  advanceUnitMotionPhysicsMutable(
    motion,
    dt,
    groundOffset,
    poweredAx,
    poweredAy,
    poweredAz - (useAccel ? GRAVITY : 0),
    airDamp,
    groundDamp,
    // Jump launches are server-authored events; prediction only
    // integrates the resulting position/velocity after that snap.
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
    target.movementAccelX ?? 0,
    target.movementAccelY ?? 0,
    target.movementAccelZ ?? 0,
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
  movementAccelX: number,
  movementAccelY: number,
  movementAccelZ: number,
): boolean {
  return advanceSharedUnitMotionPrediction(
    motion,
    dt,
    unit.bodyCenterHeight,
    airDamp,
    groundDamp,
    movementAccelX,
    movementAccelY,
    movementAccelZ,
  );
}

export function applyClientUnitVisualPrediction(options: {
  entity: Entity;
  target: UnitPredictionTarget | undefined;
  deltaMs: number;
  preset: DriftPreset;
  mapWidth: number;
  mapHeight: number;
}): void {
  const { entity, target, deltaMs, preset, mapWidth, mapHeight } = options;
  if (!entity.unit) return;
  const dt = deltaMs / 1000;
  const movPosDrift = halfLifeBlend(dt, preset.movement.pos);
  const movVelDrift = halfLifeBlend(dt, preset.movement.vel);
  const rotPosDrift = halfLifeBlend(dt, preset.rotation.pos);
  const airDamp = getUnitAirFrictionDamp(dt);
  const groundDamp = getUnitGroundFrictionDamp(dt);
  predictionMapWidth = mapWidth;
  predictionMapHeight = mapHeight;

  if (target) {
    // Unit body motion is a visual contract, not an optional detail.
    // Keep this smooth at render cadence while LOD throttles heavier
    // turret / force-field prediction elsewhere.
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
    entity.unit.movementAccelX ?? 0,
    entity.unit.movementAccelY ?? 0,
    entity.unit.movementAccelZ ?? 0,
  );
  entity.transform.x = motionScratch.x;
  entity.transform.y = motionScratch.y;
  entity.transform.z = motionScratch.z;
  entity.unit.velocityX = motionScratch.vx;
  entity.unit.velocityY = motionScratch.vy;
  entity.unit.velocityZ = motionScratch.vz;
  advanceUnitSuspension(entity.unit, entity.transform.rotation, deltaMs, { legContact });

  if (!target) return;

  entity.transform.x = lerp(entity.transform.x, target.x, movPosDrift);
  entity.transform.y = lerp(entity.transform.y, target.y, movPosDrift);
  entity.transform.z = lerp(entity.transform.z, target.z, movPosDrift);
  entity.transform.rotation = lerpAngle(
    entity.transform.rotation,
    target.rotation,
    rotPosDrift,
  );

  entity.unit.velocityX = lerp(
    entity.unit.velocityX ?? 0,
    target.velocityX ?? 0,
    movVelDrift,
  );
  entity.unit.velocityY = lerp(
    entity.unit.velocityY ?? 0,
    target.velocityY ?? 0,
    movVelDrift,
  );
  entity.unit.velocityZ = lerp(
    entity.unit.velocityZ ?? 0,
    target.velocityZ ?? 0,
    movVelDrift,
  );

  const tiltAlpha = halfLifeBlend(dt, TILT_EMA_HALF_LIFE_SEC[getClientTiltEmaMode()]);
  const sn = entity.unit.surfaceNormal;
  const tnx = sn.nx + (target.surfaceNormalX - sn.nx) * tiltAlpha;
  const tny = sn.ny + (target.surfaceNormalY - sn.ny) * tiltAlpha;
  const tnz = sn.nz + (target.surfaceNormalZ - sn.nz) * tiltAlpha;
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
  preset: DriftPreset;
  forceFieldsEnabled: boolean;
}): void {
  const { entity, target, predictionStep, preset, forceFieldsEnabled } = options;
  if (!entity.combat) return;
  const dt = predictionStep.entityDeltaMs / 1000;
  const targetDt = predictionStep.targetDeltaMs / 1000;
  const rotPosDrift = halfLifeBlend(dt, preset.rotation.pos);
  const rotVelDrift = halfLifeBlend(dt, preset.rotation.vel);

  // Turret yaw has no server-reported angular acceleration, so VEL
  // and ACC behave the same here — both integrate rotation from
  // angularVelocity. POS skips integration entirely (rotation snaps
  // to the target via the lerp below).
  const integrateRotation = getPredictionMode() !== 'pos';
  const turrets = entity.combat.turrets;
  for (let i = 0; i < turrets.length; i++) {
    const weapon = turrets[i];
    if (weapon.config.visualOnly) continue;
    if (integrateRotation) {
      weapon.rotation += weapon.angularVelocity * dt;
    }

    const tw = target?.turrets?.[i];
    if (tw) {
      if (integrateRotation) {
        tw.rotation += tw.angularVelocity * targetDt;
      }
      weapon.rotation = lerpAngle(
        weapon.rotation,
        tw.rotation,
        rotPosDrift,
      );
      weapon.angularVelocity = lerp(
        weapon.angularVelocity,
        tw.angularVelocity,
        rotVelDrift,
      );
      weapon.pitch = lerpAngle(
        weapon.pitch,
        tw.pitch,
        rotPosDrift,
      );
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
    const targetProgress = weapon.state === 'engaged' ? 1 : 0;
    const progressDelta = dt / (fieldShot.transitionTime / 1000);
    let next = cur;
    if (cur < targetProgress) {
      next = Math.min(cur + progressDelta, 1);
    } else if (cur > targetProgress) {
      next = Math.max(cur - progressDelta, 0);
    }

    const serverRange = tw?.forceFieldRange;
    if (serverRange !== undefined) {
      next = lerp(next, serverRange, rotPosDrift);
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
    const ax = unit.movementAccelX ?? 0;
    const ay = unit.movementAccelY ?? 0;
    const az = unit.movementAccelZ ?? 0;
    if (ax * ax + ay * ay + az * az > PREDICTION_ACCEL_EPSILON_SQ) return false;

    if (target) {
      const tvx = target.velocityX ?? 0;
      const tvy = target.velocityY ?? 0;
      const tvz = target.velocityZ ?? 0;
      if (tvx * tvx + tvy * tvy + tvz * tvz > PREDICTION_VEL_EPSILON_SQ) return false;
      const tax = target.movementAccelX ?? 0;
      const tay = target.movementAccelY ?? 0;
      const taz = target.movementAccelZ ?? 0;
      if (tax * tax + tay * tay + taz * taz > PREDICTION_ACCEL_EPSILON_SQ) return false;

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
      if (weapon.state === 'engaged') return false;
    }
  }

  return true;
}
