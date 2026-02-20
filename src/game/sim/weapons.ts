import type { WeaponConfig } from './types';
import { RANGE_MULTIPLIERS } from '../../config';
import { buildAllWeaponConfigs, WEAPON_BLUEPRINTS } from './blueprints';

// Union type of all registered weapon config keys (derived from blueprints)
export type WeaponId = keyof typeof WEAPON_BLUEPRINTS;

// Turret configurations — built from blueprints at init time
// Same shape as before, just derived from the blueprint single source of truth
export const TURRET_CONFIGS: Record<string, WeaponConfig> = buildAllWeaponConfigs();

// Compute all range tiers for a weapon, using per-weapon overrides with global fallback
export function computeWeaponRanges(config: WeaponConfig) {
  const fireRange = config.range;
  const m = config.rangeMultiplierOverrides;
  return {
    seeRange:       fireRange * (m?.see ?? RANGE_MULTIPLIERS.see),
    fireRange,
    releaseRange:   fireRange * (m?.release ?? RANGE_MULTIPLIERS.release),
    lockRange:      fireRange * (m?.lock ?? RANGE_MULTIPLIERS.lock),
    fightstopRange: fireRange * (m?.fightstop ?? RANGE_MULTIPLIERS.fightstop),
  };
}

// Helper to get a weapon config by ID
export function getWeaponConfig(id: string): WeaponConfig {
  const config = TURRET_CONFIGS[id];
  if (!config) {
    throw new Error(`Unknown weapon config: ${id}`);
  }
  return { ...config }; // Return a copy
}

// Helper to create a custom weapon config
export function createWeaponConfig(base: Partial<WeaponConfig> & { id: string }): WeaponConfig {
  return {
    damage: 10,
    range: 100,
    cooldown: 1000,
    color: 0xffffff,
    ...base,
  };
}
