import type { Entity, Turret } from '../types';
import { isProjectileShot } from '../types';
import { CT_TURRET_STATE_IDLE } from '../../sim-wasm/init';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from './targetingInputStamping';

export type ForceFieldPanelTargetTurretPick = {
  turret: Turret;
  index: number;
  score: number;
};

const _forceFieldPanelTargetFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_IDLE,
  targetId: -1,
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
    const damage = shot.explosion !== undefined ? shot.explosion.damage : 0;
    return turret.config.cooldown > 0
      ? (damage * 1000) / turret.config.cooldown
      : 0;
  }
  return 0;
}

/** A turretForceFieldPanel only locks onto an enemy turret that is itself
 *  actively locked onto our own unit (target === ourUnitId, non-idle).
 *  Score equals sustained DPS so the most dangerous incoming turret
 *  wins when several enemy turrets target the same unit. Reads the
 *  Rust combat-targeting slab tuple when stamped, falling back to JS
 *  Turret state on non-sim client paths. */
function scoreForceFieldPanelTargetTurretFromTarget(
  target: Entity,
  turretIndex: number,
  turret: Turret,
  ourUnitId: number,
): number {
  if (turret.config.passive) return 0;
  if (turret.config.visualOnly) return 0;
  if (turret.config.isManualFire) return 0;
  if (readCombatTargetingTurretFsmInto(target, turretIndex, _forceFieldPanelTargetFsm)) {
    if (_forceFieldPanelTargetFsm.targetId !== ourUnitId) return 0;
    if (_forceFieldPanelTargetFsm.stateCode === CT_TURRET_STATE_IDLE) return 0;
    return turretDps(turret);
  }
  if (turret.target !== ourUnitId) return 0;
  if (turret.state === 'idle') return 0;
  return turretDps(turret);
}

export function pickForceFieldPanelTargetTurret(
  target: Entity,
  ourUnitId: number,
): ForceFieldPanelTargetTurretPick | null {
  if (target.combat === null) return null;
  const turrets = target.combat.turrets;
  let best: ForceFieldPanelTargetTurretPick | null = null;
  for (let ti = 0; ti < turrets.length; ti++) {
    const turret = turrets[ti];
    const score = scoreForceFieldPanelTargetTurretFromTarget(target, ti, turret, ourUnitId);
    if (score <= 0) continue;
    if (best === null || score > best.score) {
      best = { turret, index: ti, score };
    }
  }
  return best;
}

export function pickTargetAimTurret(
  target: Entity,
  sourceEntityId: number | undefined = undefined,
): ForceFieldPanelTargetTurretPick | null {
  if (sourceEntityId !== undefined) {
    const directThreat = pickForceFieldPanelTargetTurret(target, sourceEntityId);
    if (directThreat) return directThreat;
  }

  const combat = target.combat;
  if (combat === null) return null;
  const turrets = combat.turrets;
  let best: ForceFieldPanelTargetTurretPick | null = null;
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

export function getForceFieldPanelTargetScore(target: Entity, ourUnitId: number): number {
  const pick = pickForceFieldPanelTargetTurret(target, ourUnitId);
  return pick !== null ? pick.score : 0;
}
