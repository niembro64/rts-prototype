export type AutoGraphicsQuality = 'auto' | 'auto-zoom' | 'auto-tps' | 'auto-fps' | 'auto-units';
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
export type LegStyle = 'none' | 'simple' | 'animated' | 'full';

export type GraphicsConfig = {
  /** The concrete tier this config was resolved to. Lets renderers
   *  branch on the *level* (e.g. 3D draws units as plain spheres at
   *  min/low) without having to reverse-engineer it from individual
   *  field combinations. */
  tier: ConcreteGraphicsQuality;
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
