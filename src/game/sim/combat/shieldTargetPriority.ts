import type { Entity, Turret } from '../types';
import { isAttackEmitter, isManualEmitterConfig } from '../emitterKinds';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
  type CombatTargetingTurretStateCode,
} from './targetingInputStamping';

type ShieldPanelTargetTurretPick = {
  turret: Turret;
  index: number;
  score: number;
};

const _shieldPanelTargetFsm: CombatTargetingTurretFsmOut = {
  stateCode: 0 as CombatTargetingTurretStateCode,
  targetId: -1,
};

/** Sustained DPS for a turret, precomputed from its static shot config
 *  at runtime-turret construction. Force shots and turrets without a
 *  damaging shot return 0 and are filtered out. */
function turretDps(turret: Turret): number {
  return turret.sustainedDps;
}

function threatTargetsShieldPanel(
  threatTargetId: number,
  ourUnitId: number,
  ourTurretId: number | undefined,
): boolean {
  return threatTargetId === ourUnitId ||
    (ourTurretId !== undefined && threatTargetId === ourTurretId);
}

/** A turretShieldPanel only locks onto an enemy turret whose lock is
 *  pointed at our own host or shield-panel turret.
 *  Score equals sustained DPS so the most dangerous incoming turret
 *  wins when several enemy turrets target the same protector. Reads the
 *  Rust combat-targeting slab tuple when stamped, falling back to JS
 *  Turret state on non-sim client paths. */
function scoreShieldPanelTargetTurretFromTarget(
  target: Entity,
  turretIndex: number,
  turret: Turret,
  ourUnitId: number,
  ourTurretId: number | undefined,
): number {
  if (turret.config.passive) return 0;
  if (!isAttackEmitter(turret)) return 0;
  if (isManualEmitterConfig(turret.config)) return 0;
  if (readCombatTargetingTurretFsmInto(target, turretIndex, _shieldPanelTargetFsm)) {
    if (!threatTargetsShieldPanel(_shieldPanelTargetFsm.targetId, ourUnitId, ourTurretId)) {
      return 0;
    }
    return turretDps(turret);
  }
  if (turret.target === null || !threatTargetsShieldPanel(turret.target, ourUnitId, ourTurretId)) {
    return 0;
  }
  return turretDps(turret);
}

function pickShieldPanelTargetTurret(
  target: Entity,
  ourUnitId: number,
  ourTurretId: number | undefined = undefined,
): ShieldPanelTargetTurretPick | null {
  if (target.combat === null) return null;
  const turrets = target.combat.turrets;
  let best: ShieldPanelTargetTurretPick | null = null;
  for (let ti = 0; ti < turrets.length; ti++) {
    const turret = turrets[ti];
    const score = scoreShieldPanelTargetTurretFromTarget(
      target,
      ti,
      turret,
      ourUnitId,
      ourTurretId,
    );
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
  sourceTurretId: number | undefined = undefined,
): ShieldPanelTargetTurretPick | null {
  if (sourceEntityId !== undefined) {
    const directThreat = pickShieldPanelTargetTurret(target, sourceEntityId, sourceTurretId);
    if (directThreat) return directThreat;
  }

  const combat = target.combat;
  if (combat === null) return null;
  const turrets = combat.turrets;
  let best: ShieldPanelTargetTurretPick | null = null;
  for (let ti = 0; ti < turrets.length; ti++) {
    const turret = turrets[ti];
    if (turret.config.passive) continue;
    if (!isAttackEmitter(turret)) continue;
    if (isManualEmitterConfig(turret.config)) continue;
    const score = turretDps(turret);
    if (score <= 0) continue;
    if (best === null || score > best.score) {
      best = { turret, index: ti, score };
    }
  }
  return best;
}
