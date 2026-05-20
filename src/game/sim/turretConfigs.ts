import type { TurretConfig, TurretRanges } from './types';
import { isProjectileShot } from './types';
import { buildAllTurretConfigs } from './blueprints';
import { GRAVITY } from '../../config';

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

function usesBallisticArc(config: TurretConfig): boolean {
  const angleType = config.aimStyle.angleType;
  return (
    angleType === 'ballisticArcLow' ||
    angleType === 'ballisticArcLowOnlyUnder' ||
    angleType === 'ballisticArcHigh'
  );
}

function effectiveBallisticBaseRange(config: TurretConfig): number {
  if (!usesBallisticArc(config)) return config.range;
  // A drop mortar mounted far above its targets is limited by the
  // ballistic solver, not by flat-ground reach. The flat-ground clamp
  // would reject targets directly below a high-flying Dragonfly even
  // though a low-force shell can simply fall onto them.
  if (config.id === 'droppingMortarTurret') return config.range;
  const shot = config.shot;
  if (!shot || !isProjectileShot(shot) || shot.mass <= 1e-6) return config.range;
  const speed = shot.launchForce / shot.mass;
  if (!Number.isFinite(speed) || speed <= 1e-6 || GRAVITY <= 0) return config.range;
  const flatGroundMaxRange = (speed * speed) / GRAVITY;
  if (!Number.isFinite(flatGroundMaxRange) || flatGroundMaxRange <= 0) return config.range;
  return Math.min(config.range, flatGroundMaxRange);
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
// own `range` so doubling `range` doubles every shell at once.
export function computeTurretRanges(config: TurretConfig): TurretRanges {
  const baseRange = effectiveBallisticBaseRange(config);
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
