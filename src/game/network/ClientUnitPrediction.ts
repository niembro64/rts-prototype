import { getClientTiltEmaMode } from '@/clientBarConfig';
import { TILT_EMA_HALF_LIFE_SEC } from '@/shellConfig';
import type { Entity } from '../sim/types';
import {
  lerp,
  lerpAngle,
  magnitude3,
} from '../math';
import { halfLifeBlend, type DriftPreset } from './driftEma';
import type { PredictionStep } from './ClientPredictionLod';

const PREDICTION_POS_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_VEL_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_ROT_EPSILON = 0.001;
const PREDICTION_TURRET_EPSILON = 0.001;

type UnitPredictionTarget = {
  x: number;
  y: number;
  z: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  surfaceNormalX: number;
  surfaceNormalY: number;
  surfaceNormalZ: number;
  turrets: {
    rotation: number;
    angularVelocity: number;
    pitch: number;
    forceFieldRange: number | undefined;
  }[];
};

function angleDeltaAbs(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

export function applyClientUnitVisualPrediction(options: {
  entity: Entity;
  target: UnitPredictionTarget | undefined;
  deltaMs: number;
  preset: DriftPreset;
}): void {
  const { entity, target, deltaMs, preset } = options;
  if (!entity.unit) return;
  const dt = deltaMs / 1000;
  const movPosDrift = halfLifeBlend(dt, preset.movement.pos);
  const movVelDrift = halfLifeBlend(dt, preset.movement.vel);
  const rotPosDrift = halfLifeBlend(dt, preset.rotation.pos);

  if (target) {
    // Unit body motion is a visual contract, not an optional detail.
    // Keep this smooth at render cadence while LOD throttles heavier
    // turret / force-field prediction elsewhere.
    target.x += target.velocityX * dt;
    target.y += target.velocityY * dt;
    target.z += target.velocityZ * dt;
  }

  const vx = entity.unit.velocityX ?? 0;
  const vy = entity.unit.velocityY ?? 0;
  const vz = entity.unit.velocityZ ?? 0;
  entity.transform.x += vx * dt;
  entity.transform.y += vy * dt;
  entity.transform.z += vz * dt;

  if (!target) return;

  entity.transform.x = lerp(entity.transform.x, target.x, movPosDrift);
  entity.transform.y = lerp(entity.transform.y, target.y, movPosDrift);
  entity.transform.z = lerp(entity.transform.z, target.z, movPosDrift);
  entity.transform.rotation = lerpAngle(
    entity.transform.rotation,
    target.rotation,
    rotPosDrift,
  );

  entity.unit.velocityX = lerp(vx, target.velocityX ?? 0, movVelDrift);
  entity.unit.velocityY = lerp(vy, target.velocityY ?? 0, movVelDrift);
  entity.unit.velocityZ = lerp(vz, target.velocityZ ?? 0, movVelDrift);

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

  const turrets = entity.combat.turrets;
  for (let i = 0; i < turrets.length; i++) {
    const weapon = turrets[i];
    if (weapon.config.visualOnly) continue;
    weapon.rotation += weapon.angularVelocity * dt;

    const tw = target?.turrets?.[i];
    if (tw) {
      tw.rotation += tw.angularVelocity * targetDt;
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
      if (weapon.state === 'engaged') return false;
    }
  }

  return true;
}
