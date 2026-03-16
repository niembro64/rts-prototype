export type AutoGraphicsQuality = 'auto' | 'auto-zoom' | 'auto-tps' | 'auto-fps';
export type ConcreteGraphicsQuality = 'min' | 'low' | 'medium' | 'high' | 'max';
export type GraphicsQuality = AutoGraphicsQuality | ConcreteGraphicsQuality;
export type RenderMode = 'window' | 'padded' | 'all';

export type BeamStyle = 'simple' | 'standard' | 'detailed' | 'complex';
export type ForceFieldStyle = 'minimal' | 'simple' | 'normal' | 'enhanced';
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
export type LegStyle = 'none' | 'simple' | 'full';

export type GraphicsConfig = {
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
  burnMarkAlphaCutoff: number;
  burnMarkFramesSkip: number;
  beamPathFramesSkip: number;
  forceFieldStyle: ForceFieldStyle;
  projectileStyle: ProjectileStyle;
  fireExplosionStyle: FireExplosionStyle;
  deathExplosionStyle: DeathExplosionStyle;
};
