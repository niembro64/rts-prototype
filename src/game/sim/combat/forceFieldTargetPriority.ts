import type { Entity, Turret } from '../types';
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

/** Sustained DPS for a turret, precomputed from its static shot config
 *  at runtime-turret construction. Force shots and turrets without a
 *  damaging shot return 0 and are filtered out. */
export function turretDps(turret: Turret): number {
  return turret.sustainedDps;
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
