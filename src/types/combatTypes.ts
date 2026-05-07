// Combat range primitives shared by runtime turrets and blueprints.

// A single hysteresis pair. For outer/max ranges, acquire < release
// prevents flicker at the far edge. For minimum preference ranges,
// acquire is the distance where a new target becomes preferred and
// release is the smaller distance where an existing preferred target
// stops being preferred.
export type HysteresisRange = {
  acquire: number;
  release: number;
  /** Precomputed squares for hot-path distance checks. */
  acquireSq?: number;
  releaseSq?: number;
};

// Multiplier pair authored directly on each turret blueprint.
export type HysteresisRangeMultiplier = {
  acquire: number;
  release: number;
};

// Computed absolute targeting envelope. `max` is the hard outer fire
// range. `min` is an optional soft inner preference: targets outside
// min are preferred, but targets inside min remain valid fallbacks when
// no preferred target exists.
export type FireEnvelope = {
  min: HysteresisRange | null;
  max: HysteresisRange;
};

// Computed absolute targeting ranges for weapon states.
export type TurretRanges = {
  tracking: HysteresisRange | null;
  fire: FireEnvelope;
};

// Per-weapon range multipliers authored directly on each turret blueprint.
export type TurretRangeOverrides = {
  engageRangeMax: HysteresisRangeMultiplier;
  engageRangeMin: HysteresisRangeMultiplier | null;
  trackingRange: HysteresisRangeMultiplier | null;
};
