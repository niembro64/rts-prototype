export type ConcreteGraphicsQuality = 'min' | 'low' | 'medium' | 'high' | 'max';
export type RenderMode = 'window' | 'padded' | 'all';

export type BeamStyle = 'simple' | 'standard' | 'detailed' | 'complex';
export type ProjectileStyle = 'dot' | 'core' | 'trail' | 'glow' | 'full';
export type FireExplosionStyle =
  | 'flash'
  | 'spark'
  | 'burst'
  | 'blaze'
  | 'inferno';
export type DeathExplosionStyle =
  | 'puff'
  | 'scatter'
  | 'shatter'
  | 'detonate'
  | 'obliterate';
export type TurretStyle = 'none' | 'simple' | 'full';
export type ForceTurretStyle = 'none' | 'simple' | 'full';
export type UnitShape = 'circles' | 'full';
export type LegStyle = 'none' | 'simple' | 'animated' | 'full';
export type UnitRenderMode = 'mass' | 'hybrid' | 'rich';

export type GraphicsConfig = {
  /** Single frontend graphics tier. The player client no longer
   *  resolves per-object/camera-distance tiers. */
  tier: ConcreteGraphicsQuality;
  unitRenderMode: UnitRenderMode;
  hudFrameStride: number;
  effectFrameStride: number;
  terrainTileFrameStride: number;
  terrainTileSideWalls: boolean;
  waterSubdivisions: number;
  waterFrameStride: number;
  waterWaveAmplitude: number;
  waterOpacity: number;
  unitShape: UnitShape;
  legs: LegStyle;
  treadsAnimated: boolean;
  chassisDetail: boolean;
  paletteShading: boolean;
  turretStyle: TurretStyle;
  forceTurretStyle: ForceTurretStyle;
  barrelSpin: boolean;
  beamStyle: BeamStyle;
  beamGlow: boolean;
  antialias: boolean;
  /** Unified density knob (0..1) for beam-scorch burn marks. The
   *  renderer derives its active-count cap, frame-skip stride, and
   *  per-mark lifetime multiplier from this single value, so a tier
   *  flip moves all three throttles together. 0 = effect disabled. */
  burnMarkDensity: number;
  /** Unified density knob (0..1) for wheel/tread/foot ground prints.
   *  Same role as burnMarkDensity but for the GroundPrint3D pipeline. */
  groundPrintDensity: number;
  projectileStyle: ProjectileStyle;
  fireExplosionStyle: FireExplosionStyle;
  materialExplosionStyle: DeathExplosionStyle;
  materialExplosionPieceBudget: number;
  materialExplosionPhysicsFramesSkip: number;
  deathExplosionStyle: DeathExplosionStyle;
};
