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
};

export type LodHysteresis = {
  zoom: number;
  tps: number;
  fps: number;
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
  PROJECTILE_STYLE: LodTierMap<ProjectileStyle>;
  FIRE_EXPLOSION_STYLE: LodTierMap<FireExplosionStyle>;
  DEATH_EXPLOSION_STYLE: LodTierMap<DeathExplosionStyle>;
  FORCE_FIELD_STYLE: LodTierMap<ForceFieldStyle>;
};
