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
  combat.hasActiveCombat = false;
  combat.activeTurretMask = 0;
  combat.firingTurretMask = 0;
}

export function updateCombatActivityFlags(combat: CombatComponent): boolean {
  const weapons = combat.turrets;
  let activeMask = 0;
  let firingMask = 0;
  let overflowActive = false;
  let overflowFiring = false;
  let hasActiveCombat = false;

  for (let i = 0; i < weapons.length; i++) {
    const weapon = weapons[i];
    if (weapon.config.visualOnly) continue;

    if (hasTurretRenderActiveCombat(weapon)) {
      hasActiveCombat = true;
    }

    if (!hasTurretSimulationActiveCombat(weapon)) continue;

    const bit = turretBit(i);
    if (bit !== 0) activeMask |= bit;
    else overflowActive = true;

    if (isFiringCombatTurret(weapon)) {
      if (bit !== 0) firingMask |= bit;
      else overflowFiring = true;
    }
  }

  // Overflow entities are extremely unusual, but treating them as
  // all-turret-active is safer than dropping turret 31+ from combat.
  combat.hasActiveCombat = hasActiveCombat;
  combat.activeTurretMask = overflowActive ? -1 : activeMask;
  combat.firingTurretMask = overflowFiring ? -1 : firingMask;
  return activeMask !== 0 || overflowActive;
}
