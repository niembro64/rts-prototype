import type { TurretConfig } from './types';
import { getUnitBlueprint, UNIT_BLUEPRINTS } from './blueprints';
import { createTurretsFromDefinition } from './unitDefinitions';

/**
 * Compute the offensive value of a single weapon instance.
 *
 * weaponValue = baseDPS * rangeFactor * deliveryFactor * turretFactor * aoeFactor + pullBonus
 */
export function getWeaponValue(config: TurretConfig): number {
  // --- baseDPS ---
  let baseDPS: number;
  const shot = config.shot;
  const isBeam = shot.type === 'beam' || shot.type === 'laser';
  const isForceField = shot.type === 'force';
  const isShotgun = (config.spread?.pelletCount ?? 0) > 1;
  const isBurst = (config.burst?.count ?? 0) > 1;

  if (isForceField) {
    // Force field: estimate DPS from push/pull zone damage
    const push = shot.push;
    const pull = shot.pull;
    const maxDamage = Math.max(push?.damage ?? 0, pull?.damage ?? 0);
    baseDPS = maxDamage * (0.5 / 0.6);
  } else if (shot.type === 'beam') {
    // Continuous beam: dps IS dps
    baseDPS = shot.dps;
  } else if (isShotgun) {
    const cooldownSec = config.cooldown / 1000;
    baseDPS = ((shot as import('./types').ProjectileShot).collision.damage * config.spread!.pelletCount!) / cooldownSec;
  } else if (isBurst) {
    const cooldownSec = config.cooldown / 1000;
    baseDPS = ((shot as import('./types').ProjectileShot).collision.damage * config.burst!.count!) / cooldownSec;
  } else if (shot.type === 'laser') {
    // Pulsed laser: dps / cooldownSec
    const cooldownSec = config.cooldown / 1000;
    baseDPS = shot.dps / cooldownSec;
  } else {
    // Standard projectile: damage / cooldownSec
    const cooldownSec = config.cooldown / 1000;
    baseDPS = (shot as import('./types').ProjectileShot).collision.damage / cooldownSec;
  }

  // --- rangeFactor --- normalized to reference range 150, sqrt scaling
  const referenceRange = 150;
  const rangeFactor = Math.sqrt(config.range / referenceRange);

  // --- deliveryFactor --- how reliably damage is delivered
  let deliveryFactor: number;
  if (isForceField) {
    deliveryFactor = 0.6;
  } else if (isBeam) {
    deliveryFactor = 1.0;
  } else if (shot.type === 'projectile') {
    const speed = shot.launchForce / shot.mass;
    if (speed > 500) {
      deliveryFactor = 0.85;
    } else if (speed >= 250) {
      deliveryFactor = 0.75;
    } else {
      deliveryFactor = 0.65;
    }
  } else {
    deliveryFactor = 1.0;
  }
  // Shotgun spread penalty
  if (isShotgun) {
    deliveryFactor *= 0.7;
  }

  // --- turretFactor --- how well the weapon tracks targets
  let turretFactor = 1.0;
  if (config.angular.turnAccel !== undefined && config.angular.drag !== undefined) {
    const accel = config.angular.turnAccel;
    const drag = config.angular.drag;
    const terminalVelocity = accel / (60 * drag);
    const referenceTerminal = 40 / (60 * 0.15); // reference: accel=40, drag=0.15
    turretFactor = Math.max(0.5, Math.min(1.2, terminalVelocity / referenceTerminal));
  }
  // No-turret weapons (pure projectile, fire-and-forget) stay at 1.0

  // --- aoeFactor --- area effect multiplier
  let aoeFactor = 1.0;
  if (isForceField) {
    aoeFactor = 2.0; // Hits all enemies in cone continuously
  } else if (shot.type === 'projectile' && shot.explosion?.primary.radius !== undefined && shot.explosion.primary.radius > 0) {
    aoeFactor = 1 + (shot.explosion.primary.radius / 100) * 0.8;
  }

  // --- pullBonus --- flat bonus for force field pull/push utility
  let totalPower = 0;
  if (shot.type === 'force') {
    totalPower = ((shot.push?.power ?? 0) as number) + ((shot.pull?.power ?? 0) as number);
  }
  const pullBonus = totalPower > 0 ? totalPower * 0.05 : 0;

  return baseDPS * rangeFactor * deliveryFactor * turretFactor * aoeFactor + pullBonus;
}

export type { UnitValuation } from '@/types/ui';
import type { UnitValuation } from '@/types/ui';

/**
 * Compute total unit value and derive a suggested cost.
 *
 * rawValue = totalWeaponValue * defensiveValue * mobilityValue / 10
 * suggestedCost = rawValue ^ 0.85   (concentration discount / Lanchester's Square Law)
 */
export function getUnitValue(unitId: string): UnitValuation {
  const bp = getUnitBlueprint(unitId);

  // Sum weapon values from the actual weapon array the unit spawns with
  const weapons = createTurretsFromDefinition(unitId, bp.unitDrawScale);
  const weaponValue = weapons.reduce((sum, w) => sum + getWeaponValue(w.config), 0);

  // defensiveValue: sqrt(hp / 40) * 10  — normalized so jackal (40hp) = 10
  const defensiveValue = Math.sqrt(bp.hp / 40) * 10;

  // mobilityValue: 1 + (moveSpeed - 100) / 400 * 0.3
  const mobilityValue = 1 + ((bp.moveSpeed - 100) / 400) * 0.3;

  const rawValue = (weaponValue * defensiveValue * mobilityValue) / 10;

  // Concentration discount (Lanchester's Square Law): rawValue ^ 0.85
  const suggestedCost = Math.round(Math.pow(rawValue, 0.85));

  return { weaponValue, defensiveValue, mobilityValue, rawValue, suggestedCost };
}

/**
 * Print a comparison table of all units to the console.
 * Call from browser console: import('...').then(m => m.printUnitValuationTable())
 */
export function printUnitValuationTable(): void {
  const rows: Record<string, unknown>[] = [];

  for (const unitId of Object.keys(UNIT_BLUEPRINTS)) {
    const val = getUnitValue(unitId);
    const bp = getUnitBlueprint(unitId);
    const currentCost = bp.baseCost;

    const delta = ((val.suggestedCost - currentCost) / currentCost) * 100;

    rows.push({
      Unit: unitId,
      WeaponVal: Math.round(val.weaponValue * 10) / 10,
      DefVal: Math.round(val.defensiveValue * 10) / 10,
      MobVal: Math.round(val.mobilityValue * 100) / 100,
      RawVal: Math.round(val.rawValue),
      Suggested: val.suggestedCost,
      Current: currentCost,
      'Delta%': `${delta >= 0 ? '+' : ''}${Math.round(delta)}%`,
    });
  }

  console.table(rows);
}
