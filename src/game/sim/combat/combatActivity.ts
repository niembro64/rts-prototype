import type { CombatComponent, Turret } from '../types';
import { turretBit } from './combatUtils';

const ACTIVE_ROTATION_EPSILON = 0.0001;

export function hasTurretRotationWork(weapon: Turret): boolean {
  return (
    Math.abs(weapon.angularVelocity) > ACTIVE_ROTATION_EPSILON ||
    Math.abs(weapon.pitchVelocity) > ACTIVE_ROTATION_EPSILON
  );
}

export function hasTurretRenderActiveCombat(weapon: Turret): boolean {
  return weapon.target !== null || weapon.state !== 'idle';
}

export function hasTurretSimulationActiveCombat(weapon: Turret): boolean {
  return hasTurretRenderActiveCombat(weapon) || hasTurretRotationWork(weapon);
}

export function isFiringCombatTurret(weapon: Turret): boolean {
  return (
    weapon.state === 'engaged' &&
    !weapon.config.passive &&
    weapon.config.shot?.type !== 'force'
  );
}

export function clearCombatActivityFlags(combat: CombatComponent): void {
  combat.activeTurretMask = 0;
  combat.firingTurretMask = 0;
}

/** JS-only activity-mask recomputation. Used by non-sim paths (entity
 *  construction in NetworkEntityFactory, host-driven mirror /
 *  force-field toggles in GameServer, fire-enabled commands in
 *  commandExecution) where the combat-targeting slab is either not
 *  initialized yet or about to be rebuilt by the next tick's input
 *  stamping pass. Sim hot paths (turretSystem, projectileSystem,
 *  targeting bridge writeback) use refreshSlabActivityMasksForUnit
 *  from combatActivitySlab.ts so the Rust mask kernel stays the
 *  single source of truth.
 *
 *  Note: with COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY = 8 the overflow
 *  branches below are unreachable; they survive only as a safety net
 *  for future capacity changes. */
export function updateCombatActivityFlags(combat: CombatComponent): boolean {
  const weapons = combat.turrets;
  let activeMask = 0;
  let firingMask = 0;
  let overflowActive = false;
  let overflowFiring = false;

  for (let i = 0; i < weapons.length; i++) {
    const weapon = weapons[i];
    if (weapon.config.visualOnly) continue;
    if (!hasTurretSimulationActiveCombat(weapon)) continue;

    const bit = turretBit(i);
    if (bit !== 0) activeMask |= bit;
    else overflowActive = true;

    if (isFiringCombatTurret(weapon)) {
      if (bit !== 0) firingMask |= bit;
      else overflowFiring = true;
    }
  }

  combat.activeTurretMask = overflowActive ? -1 : activeMask;
  combat.firingTurretMask = overflowFiring ? -1 : firingMask;
  return activeMask !== 0 || overflowActive;
}
