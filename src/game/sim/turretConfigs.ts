import type { TurretConfig, TurretRanges } from './types';
import { TURRET_RANGE_MULTIPLIERS } from '../../config';
import { buildAllTurretConfigs, TURRET_BLUEPRINTS } from './blueprints';

// Union type of all registered turret config keys (derived from blueprints)
export type WeaponId = keyof typeof TURRET_BLUEPRINTS;

// Turret configurations — built from blueprints at init time
export const TURRET_CONFIGS: Record<string, TurretConfig> =
  buildAllTurretConfigs();

// Compute hysteresis range pairs for a turret, using per-turret overrides with global fallback
export function computeTurretRanges(config: TurretConfig): TurretRanges {
  const baseRange = config.range;
  const m = config.rangeOverrides;
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

// Helper to get a turret config by ID
export function getTurretConfig(id: string): TurretConfig {
  const config = TURRET_CONFIGS[id];
  if (!config) {
    throw new Error(`Unknown turret config: ${id}`);
  }
  return { ...config }; // Return a copy
}

// Helper to create a custom turret config
export function createTurretConfig(
  base: Partial<TurretConfig> & { id: string; angular: { turnAccel: number; drag: number } },
): TurretConfig {
  return {
    range: 100,
    cooldown: 1000,
    color: 0xffffff,
    shot: { type: 'projectile' as const, id: 'unknown', mass: 1, launchForce: 100, collision: { radius: 5, damage: 10 } },
    ...base,
  };
}

