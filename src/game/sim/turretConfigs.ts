import type { TurretConfig, TurretRanges } from './types';
import { TURRET_RANGE_MULTIPLIERS } from '../../config';
import { buildAllTurretConfigs, getSubmunitionTurretConfig, TURRET_BLUEPRINTS } from './blueprints';

/** Prefix for synthetic turret IDs emitted by the submunition/cluster
 *  system. Encoded as `__sub:<childShotId>|<lifespanMs?>|<radius?>`.
 *  Both the server (to build the sim-side projectile config) and the
 *  client (to render the spawned projectiles) resolve these through
 *  getTurretConfig, which delegates to getSubmunitionTurretConfig.
 *  The '|' separator is safe — real shot IDs are alphanumeric
 *  identifiers with no pipes. */
export const SUBMUNITION_TURRET_ID_PREFIX = '__sub:';

export function encodeSubmunitionTurretId(
  childShotId: string,
  lifespanMs: number | undefined,
  collisionRadius: number | undefined,
): string {
  const parts: string[] = [childShotId];
  if (lifespanMs !== undefined || collisionRadius !== undefined) {
    parts.push(lifespanMs === undefined ? '' : String(lifespanMs));
  }
  if (collisionRadius !== undefined) {
    parts.push(String(collisionRadius));
  }
  return SUBMUNITION_TURRET_ID_PREFIX + parts.join('|');
}

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

// Helper to get a turret config by ID. Synthetic submunition IDs
// (encoded via encodeSubmunitionTurretId) bypass TURRET_CONFIGS and
// resolve through the blueprint-level helper, which caches by
// (childShotId, lifespanMs, radius) so both sides of the network get
// the same object identity for matching parameter sets.
export function getTurretConfig(id: string): TurretConfig {
  if (id.startsWith(SUBMUNITION_TURRET_ID_PREFIX)) {
    const rest = id.slice(SUBMUNITION_TURRET_ID_PREFIX.length);
    const parts = rest.split('|');
    const childShotId = parts[0];
    const lifespanMs = parts[1] ? Number(parts[1]) : undefined;
    const radius = parts[2] ? Number(parts[2]) : undefined;
    return { ...getSubmunitionTurretConfig(childShotId, lifespanMs, radius) };
  }
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

