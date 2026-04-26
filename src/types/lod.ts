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
} from './graphics';

export type EmaStat = 'avg' | 'low';

export type LodTierMap<T> = Record<ConcreteGraphicsQuality, T>;

export type LodThresholds = Record<Exclude<ConcreteGraphicsQuality, 'min'>, number>;

export type LodAutoModeConfig = {
  zoom: LodThresholds;
  tps: LodThresholds;
  fps: LodThresholds;
  /** Unit-count thresholds, interpreted as MAXIMUM unit count for the
   *  given tier. count <= threshold means eligible for that tier or
   *  better. (Inverse of zoom/tps/fps where ratio >= threshold.) */
  units: LodThresholds;
};

export type LodHysteresis = {
  zoom: number;
  tps: number;
  fps: number;
  /** Hysteresis band on the unit-count thresholds. Same units as the
   *  thresholds themselves (raw unit count). */
  units: number;
};

export type LodEmaSource = {
  tps: EmaStat;
  fps: EmaStat;
};

export type GraphicsDetailConfig = {
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
