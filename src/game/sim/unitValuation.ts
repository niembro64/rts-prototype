import type { WeaponConfig } from './types';
import { UNIT_STATS, DEFAULT_TURRET_TURN_ACCEL, DEFAULT_TURRET_DRAG } from '../../config';
import { UNIT_DEFINITIONS, createWeaponsFromDefinition } from './unitDefinitions';

/**
 * Compute the offensive value of a single weapon instance.
 *
 * weaponValue = baseDPS * rangeFactor * deliveryFactor * turretFactor * aoeFactor + pullBonus
 */
export function getWeaponValue(config: WeaponConfig): number {
  // --- baseDPS ---
  let baseDPS: number;
  const isBeam = config.beamDuration !== undefined && !config.projectileSpeed;
  const isWave = !!config.isWaveWeapon;
  const isShotgun = (config.pelletCount ?? 0) > 1;
  const isBurst = (config.burstCount ?? 0) > 1;

  if (isWave) {
    // Sonic wave: damage field is base DPS, but scales with 1/distance.
    // Effective DPS at ~60% of fire range: baseDamage * (0.5 / 0.6)
    baseDPS = config.damage * (0.5 / 0.6);
  } else if (isBeam && config.cooldown === 0) {
    // Continuous beam: damage IS DPS
    baseDPS = config.damage;
  } else if (isShotgun) {
    // Shotgun: damage * pelletCount / cooldownSec
    const cooldownSec = config.cooldown / 1000;
    baseDPS = (config.damage * config.pelletCount!) / cooldownSec;
  } else if (isBurst) {
    // Burst: damage * burstCount / cooldownSec
    const cooldownSec = config.cooldown / 1000;
    baseDPS = (config.damage * config.burstCount!) / cooldownSec;
  } else if (isBeam) {
    // Hitscan flash (railgun): damage / cooldownSec
    const cooldownSec = config.cooldown / 1000;
    baseDPS = config.damage / cooldownSec;
  } else {
    // Standard projectile: damage / cooldownSec
    const cooldownSec = config.cooldown / 1000;
    baseDPS = config.damage / cooldownSec;
  }

  // --- rangeFactor --- normalized to reference range 150, sqrt scaling
  const referenceRange = 150;
  const rangeFactor = Math.sqrt(config.range / referenceRange);

  // --- deliveryFactor --- how reliably damage is delivered
  let deliveryFactor: number;
  if (isWave) {
    deliveryFactor = 0.6;
  } else if (isBeam) {
    // Hitscan (beam/railgun)
    deliveryFactor = 1.0;
  } else if (config.projectileSpeed !== undefined) {
    if (config.projectileSpeed > 500) {
      deliveryFactor = 0.85; // Fast projectile
    } else if (config.projectileSpeed >= 250) {
      deliveryFactor = 0.75; // Medium projectile
    } else {
      deliveryFactor = 0.65; // Slow projectile
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
  if (config.turretTurnAccel !== undefined && config.turretDrag !== undefined) {
    const accel = config.turretTurnAccel;
    const drag = config.turretDrag;
    const terminalVelocity = accel / (60 * drag);
    const referenceTerminal = DEFAULT_TURRET_TURN_ACCEL / (60 * DEFAULT_TURRET_DRAG);
    turretFactor = Math.max(0.5, Math.min(1.2, terminalVelocity / referenceTerminal));
  }
  // No-turret weapons (pure projectile, fire-and-forget) stay at 1.0

  // --- aoeFactor --- area effect multiplier
  let aoeFactor = 1.0;
  if (isWave) {
    aoeFactor = 2.0; // Hits all enemies in cone continuously
  } else if (config.splashRadius !== undefined && config.splashRadius > 0) {
    aoeFactor = 1 + (config.splashRadius / 100) * 0.8;
  } else if (config.piercing) {
    aoeFactor = 1.3;
  }

  // --- pullBonus --- flat bonus for sonic pull utility
  const pullBonus = (config.pullPower ?? 0) > 0 ? config.pullPower! * 0.05 : 0;

  return baseDPS * rangeFactor * deliveryFactor * turretFactor * aoeFactor + pullBonus;
}

export interface UnitValuation {
  weaponValue: number;
  defensiveValue: number;
  mobilityValue: number;
  rawValue: number;
  suggestedCost: number;
}

/**
 * Compute total unit value and derive a suggested cost.
 *
 * rawValue = totalWeaponValue * defensiveValue * mobilityValue / 10
 * suggestedCost = rawValue ^ 0.85   (concentration discount / Lanchester's Square Law)
 */
export function getUnitValue(unitId: string): UnitValuation {
  const def = UNIT_DEFINITIONS[unitId];
  if (!def) throw new Error(`Unknown unit: ${unitId}`);

  const stats = UNIT_STATS[unitId as keyof typeof UNIT_STATS];
  if (!stats) throw new Error(`No stats for unit: ${unitId}`);

  // Sum weapon values from the actual weapon array the unit spawns with
  const weapons = createWeaponsFromDefinition(unitId, def.collisionRadius);
  const weaponValue = weapons.reduce((sum, w) => sum + getWeaponValue(w.config), 0);

  // defensiveValue: sqrt(hp / 40) * 10  — normalized so jackal (40hp) = 10
  const defensiveValue = Math.sqrt(stats.hp / 40) * 10;

  // mobilityValue: 1 + (moveSpeed - 100) / 400 * 0.3
  const mobilityValue = 1 + ((stats.moveSpeed - 100) / 400) * 0.3;

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

  for (const unitId of Object.keys(UNIT_DEFINITIONS)) {
    const val = getUnitValue(unitId);
    const stats = UNIT_STATS[unitId as keyof typeof UNIT_STATS];
    const currentCost = stats.baseCost;

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
