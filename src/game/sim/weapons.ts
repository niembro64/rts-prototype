import type { WeaponConfig, TurretRanges } from './types';
import { TURRET_RANGE_MULTIPLIERS } from '../../config';
import { buildAllWeaponConfigs, TURRET_BLUEPRINTS } from './blueprints';

// Union type of all registered weapon config keys (derived from blueprints)
export type WeaponId = keyof typeof TURRET_BLUEPRINTS;

// Turret configurations — built from blueprints at init time
// Same shape as before, just derived from the blueprint single source of truth
export const TURRET_CONFIGS: Record<string, WeaponConfig> =
  buildAllWeaponConfigs();

// Compute hysteresis range pairs for a weapon, using per-weapon overrides with global fallback
export function computeWeaponRanges(config: WeaponConfig): TurretRanges {
  const baseRange = config.range;
  const m = config.rangeMultiplierOverrides;
  const d = TURRET_RANGE_MULTIPLIERS;
  return {
    tracking: {
      acquire: baseRange * (m?.tracking.acquire ?? d.tracking.acquire),
      release: baseRange * (m?.tracking.release ?? d.tracking.release),
    },
    engage: {
      acquire: baseRange * (m?.engage.acquire ?? d.engage.acquire),
      release: baseRange * (m?.engage.release ?? d.engage.release),
    },
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
export function createWeaponConfig(
  base: Partial<WeaponConfig> & { id: string },
): WeaponConfig {
  return {
    damage: 10,
    range: 100,
    cooldown: 1000,
    color: 0xffffff,
    ...base,
  };
}
