import type { Entity, Turret } from '../types';
import { isProjectileShot } from '../types';
import { CT_TURRET_STATE_IDLE } from '../../sim-wasm/init';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';

export type MirrorTargetTurretPick = {
  turret: Turret;
  index: number;
  score: number;
};

const _mirrorTargetFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_IDLE,
  targetId: null,
};

/** Sustained DPS for a turret based on its compiled shot config and
 *  cooldown. Beams sustain their authored `dps` continuously; lasers
 *  pulse for `duration` out of every `cooldown` window; plasma/rocket
 *  shots deliver `explosion.damage` per `cooldown` ms. Force shots
 *  and turrets without a damaging shot return 0 and are filtered out. */
export function turretDps(turret: Turret): number {
  const shot = turret.config.shot;
  if (!shot) return 0;
  if (shot.type === 'beam') return shot.dps;
  if (shot.type === 'laser') {
    const period = Math.max(shot.duration, turret.config.cooldown);
    return period > 0 ? (shot.dps * shot.duration) / period : 0;
  }
  if (isProjectileShot(shot)) {
    const damage = shot.explosion?.damage ?? 0;
    return turret.config.cooldown > 0
      ? (damage * 1000) / turret.config.cooldown
      : 0;
  }
  return 0;
}

/** A mirror turret only locks onto an enemy turret that is itself
 *  actively locked onto our own unit (target === ourUnitId, non-idle).
 *  Score equals sustained DPS so the most dangerous incoming turret
 *  wins when several enemy turrets target the same unit. */
export function scoreMirrorTargetTurret(turret: Turret, ourUnitId: number): number {
  if (turret.config.passive) return 0;
  if (turret.config.visualOnly) return 0;
  if (turret.config.isManualFire) return 0;
  if (turret.target !== ourUnitId) return 0;
  if (turret.state === 'idle') return 0;
  return turretDps(turret);
}

function scoreMirrorTargetTurretFromTarget(
  target: Entity,
  turretIndex: number,
  turret: Turret,
  ourUnitId: number,
): number {
  if (turret.config.passive) return 0;
  if (turret.config.visualOnly) return 0;
  if (turret.config.isManualFire) return 0;
  if (readCombatTargetingTurretFsmInto(target, turretIndex, _mirrorTargetFsm)) {
    if (_mirrorTargetFsm.targetId !== ourUnitId) return 0;
    if (_mirrorTargetFsm.stateCode === CT_TURRET_STATE_IDLE) return 0;
    return turretDps(turret);
  }
  if (turret.target !== ourUnitId) return 0;
  if (turret.state === 'idle') return 0;
  return turretDps(turret);
}

export function pickMirrorTargetTurret(
  target: Entity,
  ourUnitId: number,
): MirrorTargetTurretPick | null {
  const turrets = target.combat?.turrets;
  if (!turrets) return null;
  let best: MirrorTargetTurretPick | null = null;
  for (let ti = 0; ti < turrets.length; ti++) {
    const turret = turrets[ti];
    const score = scoreMirrorTargetTurretFromTarget(target, ti, turret, ourUnitId);
    if (score <= 0) continue;
    if (best === null || score > best.score) {
      best = { turret, index: ti, score };
    }
  }
  return best;
}

export function pickTargetAimTurret(
  target: Entity,
  sourceEntityId?: number,
): MirrorTargetTurretPick | null {
  if (sourceEntityId !== undefined) {
    const directThreat = pickMirrorTargetTurret(target, sourceEntityId);
    if (directThreat) return directThreat;
  }

  const turrets = target.combat?.turrets;
  if (!turrets) return null;
  let best: MirrorTargetTurretPick | null = null;
  for (let ti = 0; ti < turrets.length; ti++) {
    const turret = turrets[ti];
    if (turret.config.passive) continue;
    if (turret.config.visualOnly) continue;
    if (turret.config.isManualFire) continue;
    const score = turretDps(turret);
    if (score <= 0) continue;
    if (best === null || score > best.score) {
      best = { turret, index: ti, score };
    }
  }
  return best;
}

export function getMirrorTargetScore(target: Entity, ourUnitId: number): number {
  return pickMirrorTargetTurret(target, ourUnitId)?.score ?? 0;
}
