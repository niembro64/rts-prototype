import type { ConcreteGraphicsQuality } from './graphics';
import type {
  UnitShape,
  LegStyle,
  BeamStyle,
  ProjectileStyle,
  FireExplosionStyle,
  DeathExplosionStyle,
  TurretStyle,
  ForceTurretStyle,
  UnitRenderMode,
  CameraSphereRadii,
} from './graphics';

export type EmaStat = 'avg' | 'low';

/** Per-signal state in the LOD ladder. The user click-cycles each
 *  signal through these:
 *    - 'off'   — signal doesn't contribute to the AUTO min.
 *    - 'active' — contributes (with all other actives).
 *    - 'solo'  — overrides every other signal; only this one drives
 *                the rank. At most one signal can be SOLO at a time;
 *                clicking a signal to SOLO demotes any prior SOLO
 *                back to ACTIVE.
 *  Identical shape on the HOST SERVER side (see types/serverSimLod.ts). */
export type SignalState = 'off' | 'active' | 'solo';

/** Runtime guard for `SignalState` — used at every persistence /
 *  snapshot boundary that decodes a stored or wire-side value back
 *  into a SignalState. The string set is closed and shared between
 *  PLAYER CLIENT and HOST SERVER bars, so the predicate lives next to
 *  the type, not in any one bar config. */
export function isSignalState(value: unknown): value is SignalState {
  return value === 'off' || value === 'active' || value === 'solo';
}

/** PLAYER CLIENT signals that can be toggled. */
export type LodSignalStates = {
  zoom: SignalState;
  serverTps: SignalState;
  renderTps: SignalState;
  units: SignalState;
};

export type LodTierMap<T> = Record<ConcreteGraphicsQuality, T>;

export type LodThresholds = Record<Exclude<ConcreteGraphicsQuality, 'min'>, number>;

/** Dev-time guard: every LodThresholds-shaped object must have its
 *  four rungs (low < medium < high < max) finite AND strictly
 *  increasing. The shared resolver (ratioToRank in clientBarConfig
 *  for client signals, the server-sim auto resolver for host
 *  signals) walks the array in order and stops at the highest index
 *  whose threshold is met — a non-monotonic table either silently
 *  skips a tier (e.g. medium > high → tier 'high' never picked) or
 *  promotes too eagerly. We caught one such config drift by hand;
 *  this assertion catches the next one before any resolver runs.
 *
 *  Same shape works for both LodThresholds and ServerSimLodThresholds
 *  since both are Record<'low' | 'medium' | 'high' | 'max', number>. */
export function assertMonotonicLodThresholds(
  name: string,
  t: Record<'low' | 'medium' | 'high' | 'max', number>,
): void {
  const rungs = [
    ['low', t.low],
    ['medium', t.medium],
    ['high', t.high],
    ['max', t.max],
  ] as const;
  for (const [key, val] of rungs) {
    if (!Number.isFinite(val)) {
      throw new Error(
        `LodThresholds[${name}] rung '${key}' must be finite, got ${val}`,
      );
    }
  }
  for (let i = 1; i < rungs.length; i++) {
    const [prevKey, prev] = rungs[i - 1];
    const [curKey, cur] = rungs[i];
    if (cur <= prev) {
      throw new Error(
        `LodThresholds[${name}] must be strictly increasing: ` +
        `${prevKey}=${prev} >= ${curKey}=${cur}`,
      );
    }
  }
}

export type LodAutoModeConfig = {
  zoom: LodThresholds;
  serverTps: LodThresholds;
  renderTps: LodThresholds;
  /** Unit-fullness thresholds. The ratio fed in is
   *      (1 − unitCount / unitCap)
   *  so 1.0 = empty world, 0.0 = at the cap. Same direction as tps:
   *  ratio >= threshold means tier is eligible — a sparser world earns
   *  a higher tier. Expressing thresholds as fractions of the player's
   *  configured cap means the LOD ladder works the same whether the
   *  cap is 1k or 16k. */
  units: LodThresholds;
};

export type LodHysteresis = {
  zoom: number;
  serverTps: number;
  renderTps: number;
  /** Hysteresis on the unit-fullness ratio (also a 0–1 number). */
  units: number;
};

export type LodEmaSource = {
  serverTps: EmaStat;
  renderTps: EmaStat;
};

export type GraphicsDetailConfig = {
  UNIT_RENDER_MODE: LodTierMap<UnitRenderMode>;
  CAMERA_SPHERE_RADII: LodTierMap<CameraSphereRadii>;
  OBJECT_LOD_CELL_SIZE: number;
  HUD_FRAME_STRIDE: LodTierMap<number>;
  EFFECT_FRAME_STRIDE: LodTierMap<number>;
  CLIENT_PHYSICS_PREDICTION_FRAMES_SKIP: LodTierMap<number>;
  CAPTURE_TILE_FRAME_STRIDE: LodTierMap<number>;
  CAPTURE_TILE_SIDE_WALLS: LodTierMap<boolean>;
  WATER_SUBDIVISIONS: LodTierMap<number>;
  WATER_FRAME_STRIDE: LodTierMap<number>;
  WATER_WAVE_AMPLITUDE: LodTierMap<number>;
  UNIT_SHAPE: LodTierMap<UnitShape>;
  CIRCLES_DRAW_PUSH: boolean;
  CIRCLES_DRAW_SHOT: boolean;
  LEGS: LodTierMap<LegStyle>;
  TREADS_ANIMATED: LodTierMap<boolean>;
  BEAM_STYLE: LodTierMap<BeamStyle>;
  BEAM_GLOW: LodTierMap<boolean>;
  ANTIALIAS: LodTierMap<boolean>;
  CHASSIS_DETAIL: LodTierMap<boolean>;
  PALETTE_SHADING: LodTierMap<boolean>;
  TURRET_STYLE: LodTierMap<TurretStyle>;
  FORCE_TURRET_STYLE: LodTierMap<ForceTurretStyle>;
  BARREL_SPIN: LodTierMap<boolean>;
  BURN_MARK_DENSITY: LodTierMap<number>;
  GROUND_PRINT_DENSITY: LodTierMap<number>;
  SMOKE_TRAIL_FRAMES_SKIP: LodTierMap<number>;
  PROJECTILE_STYLE: LodTierMap<ProjectileStyle>;
  FIRE_EXPLOSION_STYLE: LodTierMap<FireExplosionStyle>;
  MATERIAL_EXPLOSION_STYLE: LodTierMap<DeathExplosionStyle>;
  MATERIAL_EXPLOSION_PIECE_BUDGET: LodTierMap<number>;
  MATERIAL_EXPLOSION_PHYSICS_FRAMES_SKIP: LodTierMap<number>;
  DEATH_EXPLOSION_STYLE: LodTierMap<DeathExplosionStyle>;
};
