import type { ConcreteGraphicsQuality } from './graphics';
import type {
  UnitShape,
  LegStyle,
  BeamStyle,
  ForceFieldStyle,
  ProjectileStyle,
  FireExplosionStyle,
  DeathExplosionStyle,
  TurretStyle,
  ForceTurretStyle,
  UnitRenderMode,
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

/** PLAYER CLIENT signals that can be toggled. */
export type LodSignalStates = {
  zoom: SignalState;
  tps: SignalState;
  fps: SignalState;
  units: SignalState;
};

export type LodTierMap<T> = Record<ConcreteGraphicsQuality, T>;

export type LodThresholds = Record<Exclude<ConcreteGraphicsQuality, 'min'>, number>;

export type LodAutoModeConfig = {
  zoom: LodThresholds;
  tps: LodThresholds;
  fps: LodThresholds;
  /** Unit-fullness thresholds. The ratio fed in is
   *      (1 − unitCount / unitCap)
   *  so 1.0 = empty world, 0.0 = at the cap. Same direction as tps/fps:
   *  ratio >= threshold means tier is eligible — a sparser world earns
   *  a higher tier. Expressing thresholds as fractions of the player's
   *  configured cap means the LOD ladder works the same whether the
   *  cap is 1k or 16k. */
  units: LodThresholds;
};

export type LodHysteresis = {
  zoom: number;
  tps: number;
  fps: number;
  /** Hysteresis on the unit-fullness ratio (also a 0–1 number). */
  units: number;
};

export type LodEmaSource = {
  tps: EmaStat;
  fps: EmaStat;
};

export type GraphicsDetailConfig = {
  UNIT_RENDER_MODE: LodTierMap<UnitRenderMode>;
  RICH_UNIT_CAP: LodTierMap<number>;
  RICH_UNIT_SCREEN_RADIUS_PX: LodTierMap<number>;
  HUD_FRAME_STRIDE: LodTierMap<number>;
  EFFECT_FRAME_STRIDE: LodTierMap<number>;
  CAPTURE_TILE_SUBDIV: LodTierMap<number>;
  CAPTURE_TILE_FRAME_STRIDE: LodTierMap<number>;
  CAPTURE_TILE_SIDE_WALLS: LodTierMap<boolean>;
  WATER_SUBDIVISIONS: LodTierMap<number>;
  WATER_FRAME_STRIDE: LodTierMap<number>;
  WATER_WAVE_AMPLITUDE: LodTierMap<number>;
  WATER_OPACITY: LodTierMap<number>;
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
  BURN_MARK_ALPHA_CUTOFF: LodTierMap<number>;
  BURN_MARK_FRAMES_SKIP: LodTierMap<number>;
  BEAM_PATH_FRAMES_SKIP: LodTierMap<number>;
  PROJECTILE_STYLE: LodTierMap<ProjectileStyle>;
  FIRE_EXPLOSION_STYLE: LodTierMap<FireExplosionStyle>;
  DEATH_EXPLOSION_STYLE: LodTierMap<DeathExplosionStyle>;
  FORCE_FIELD_STYLE: LodTierMap<ForceFieldStyle>;
};
