import type { TurretConfig, TurretRanges } from './types';
import { buildAllTurretConfigs, getSubmunitionTurretConfig, TURRET_BLUEPRINTS } from './blueprints';

/** Prefix for synthetic turret IDs emitted by the submunition/cluster
 *  system. Encoded as `__sub:<childShotId>` — submunitions just clone
 *  the child shot blueprint as-is (no per-spawn overrides), so the
 *  child shot id is the only thing that needs to ride on the wire.
 *  Both the server (to build the sim-side projectile config) and the
 *  client (to render the spawned projectiles) resolve these through
 *  getTurretConfig, which delegates to getSubmunitionTurretConfig. */
export const SUBMUNITION_TURRET_ID_PREFIX = '__sub:';

export function encodeSubmunitionTurretId(childShotId: string): string {
  return SUBMUNITION_TURRET_ID_PREFIX + childShotId;
}

// Union type of all registered turret config keys (derived from blueprints)
export type WeaponId = keyof typeof TURRET_BLUEPRINTS;

// Turret configurations — built from blueprints at init time
export const TURRET_CONFIGS: Record<string, TurretConfig> =
  buildAllTurretConfigs();

export function refreshHysteresisRangeSquares(range: { acquire: number; release: number; acquireSq?: number; releaseSq?: number }): void {
  range.acquireSq = range.acquire * range.acquire;
  range.releaseSq = range.release * range.release;
}

function makeHysteresisRange(acquire: number, release: number): { acquire: number; release: number; acquireSq: number; releaseSq: number } {
  return {
    acquire,
    release,
    acquireSq: acquire * acquire,
    releaseSq: release * release,
  };
}

// Compute hysteresis range pairs for a turret. Base turret range is the
// tracking/awareness range; each blueprint owns its full firing envelope.
export function computeTurretRanges(config: TurretConfig): TurretRanges {
  const baseRange = config.range;
  const m = config.rangeOverrides;
  const tracking = makeHysteresisRange(baseRange, baseRange);
  const engage = makeHysteresisRange(
    baseRange * m.engageRangeMax.acquire,
    baseRange * m.engageRangeMax.release,
  );
  const engageMin = makeHysteresisRange(
    baseRange * m.engageRangeMin.acquire,
    baseRange * m.engageRangeMin.release,
  );
  return {
    tracking,
    engage,
    fire: { min: engageMin, max: engage },
  };
}

// Helper to get a turret config by ID. Synthetic submunition IDs
// (encoded via encodeSubmunitionTurretId) bypass TURRET_CONFIGS and
// resolve through the blueprint-level helper, which caches by
// childShotId so both sides of the network get the same object
// identity.
export function getTurretConfig(id: string): TurretConfig {
  if (id.startsWith(SUBMUNITION_TURRET_ID_PREFIX)) {
    const childShotId = id.slice(SUBMUNITION_TURRET_ID_PREFIX.length);
    return { ...getSubmunitionTurretConfig(childShotId) };
  }
  const config = TURRET_CONFIGS[id];
  if (!config) {
    throw new Error(`Unknown turret config: ${id}`);
  }
  return { ...config }; // Return a copy
}

// Helper to create a custom turret config
export function createTurretConfig(
  base: Partial<TurretConfig> & {
    id: string;
    angular: { turnAccel: number; drag: number };
    rangeOverrides: TurretConfig['rangeOverrides'];
  },
): TurretConfig {
  return {
    range: 100,
    cooldown: 1000,
    color: 0xffffff,
    eventsSmooth: false,
    shot: { type: 'projectile' as const, id: 'unknown', mass: 1, launchForce: 100, collision: { radius: 5 } },
    ...base,
  };
}

