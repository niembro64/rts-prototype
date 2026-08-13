import type { TurretConfig, TurretRanges } from './types';
import { buildAllTurretConfigs } from './blueprints';
import { cloneSensorCapabilityConfig } from './sensorConfig';

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
//   `fire.max`  — hard outer firing envelope, always present
//   `fire.min`  — optional soft inner preference; targets outside it
//                 are preferred, but close targets remain valid fallbacks
//   `tracking`  — optional pre-rotation shell strictly outside the
//                 fire envelope; `null` when the turret doesn't need
//                 to be aware of enemies beyond its fire range
//
// The blueprint authors all of these as multipliers of the turret's
// engagement range so doubling that range doubles every shell at once.
export function computeTurretRanges(config: TurretConfig): TurretRanges {
  const baseRange = config.targeting.engagement.range;
  const m = config.targeting.engagement.rangeOverrides;
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
  const rangeOverrides = config.targeting.engagement.rangeOverrides;
  return {
    ...config,
    angular: {
      ...config.angular,
      yaw: { ...config.angular.yaw },
      pitch: { ...config.angular.pitch },
    },
    articulation: {
      ...config.articulation,
      yaw: { ...config.articulation.yaw },
      pitch: { ...config.articulation.pitch },
    },
    targeting: {
      ...config.targeting,
      engagement: {
        ...config.targeting.engagement,
        rangeOverrides: {
          engageRangeMax: { ...rangeOverrides.engageRangeMax },
          engageRangeMin: rangeOverrides.engageRangeMin
            ? { ...rangeOverrides.engageRangeMin }
            : null,
          trackingRange: rangeOverrides.trackingRange
            ? { ...rangeOverrides.trackingRange }
            : null,
        },
      },
      observation: {
        ...config.targeting.observation,
        sensors: cloneSensorCapabilityConfig(config.targeting.observation.sensors),
      },
      effect: { ...config.targeting.effect },
    },
  };
}
