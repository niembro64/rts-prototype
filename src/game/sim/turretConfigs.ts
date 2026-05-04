import type { TurretConfig, TurretRanges } from './types';
import { buildAllTurretConfigs } from './blueprints';

// Turret configurations — built from blueprints at init time
export const TURRET_CONFIGS: Record<string, TurretConfig> =
  buildAllTurretConfigs();

function makeHysteresisRange(acquire: number, release: number): { acquire: number; release: number; acquireSq: number; releaseSq: number } {
  return {
    acquire,
    release,
    acquireSq: acquire * acquire,
    releaseSq: release * release,
  };
}

// Compute hysteresis range pairs for a turret.
//
//   `fire.max`  — outer firing envelope, always present
//   `fire.min`  — minimum firing distance (mortar dead zone); `null`
//                 when the turret can fire to point-blank
//   `tracking`  — optional pre-rotation shell strictly outside the
//                 fire envelope; `null` when the turret doesn't need
//                 to be aware of enemies beyond its fire range
//
// The blueprint authors all of these as multipliers of the turret's
// own `range` so doubling `range` doubles every shell at once.
export function computeTurretRanges(config: TurretConfig): TurretRanges {
  const baseRange = config.range;
  const m = config.rangeOverrides;
  const fireMax = makeHysteresisRange(
    baseRange * m.engageRangeMax.acquire,
    baseRange * m.engageRangeMax.release,
  );
  const fireMin = m.engageRangeMin
    ? makeHysteresisRange(
        baseRange * m.engageRangeMin.acquire,
        baseRange * m.engageRangeMin.release,
      )
    : null;
  const tracking = m.trackingRange
    ? makeHysteresisRange(
        baseRange * m.trackingRange.acquire,
        baseRange * m.trackingRange.release,
      )
    : null;
  return {
    tracking,
    fire: { min: fireMin, max: fireMax },
  };
}

// Helper to get a real turret config by turret blueprint ID.
export function getTurretConfig(id: string): TurretConfig {
  const config = TURRET_CONFIGS[id];
  if (!config) {
    throw new Error(`Unknown turret config: ${id}`);
  }
  return { ...config }; // Return a copy
}
