// AUTO is the meta-mode; specific signals are toggled per-signal via
// their tri-state ('off' | 'active' | 'solo'). The legacy
// 'auto-zoom' / 'auto-tps' / 'auto-fps' / 'auto-units' values were
// effectively single-signal SOLO modes; they're folded into the
// signal-state model now and migrated at load time.
export type AutoGraphicsQuality = 'auto';
export type ConcreteGraphicsQuality = 'min' | 'low' | 'medium' | 'high' | 'max';
export type GraphicsQuality = AutoGraphicsQuality | ConcreteGraphicsQuality;
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

export type CameraSphereRadii = {
  /** Innermost sphere: full rich object visuals. */
  rich: number;
  /** Second sphere: simplified rich meshes. */
  simple: number;
  /** Third sphere: mass-renderer/detail-reduced visuals. */
  mass: number;
  /** Outermost simplified-shape sphere. Outside this, objects render as cheap markers. */
  impostor: number;
};

/** Per-entity render LOD bands the LOD resolver may select. Lives in
 *  this types module (not under render3d/) so that GraphicsConfig can
 *  reference it without a render-into-types layering inversion.
 *  RenderObjectLod.ts re-exports this name unchanged. */
export type RenderObjectLodTier =
  | 'marker'
  | 'impostor'
  | 'mass'
  | 'simple'
  | 'rich'
  | 'hero';

export type GraphicsConfig = {
  /** The concrete tier this config was resolved to. Lets renderers
   *  branch on the *level* (e.g. 3D draws units as plain spheres at
   *  min/low) without having to reverse-engineer it from individual
   *  field combinations. */
  tier: ConcreteGraphicsQuality;
  unitRenderMode: UnitRenderMode;
  cameraSphereRadii: CameraSphereRadii;
  /** PLAYER CLIENT "BASE" mode override. When set, every entity / cell
   *  renders at this single tier — the per-frame LOD resolver returns
   *  it directly instead of consulting cameraSphereRadii distances. The
   *  shell radii in this config are all zero in that case so that any
   *  callsite that still walks the shells (e.g. ground debug rings)
   *  draws nothing rather than stale-but-active bands. Undefined =
   *  classic camera-sphere-resolved behaviour. */
  forcedObjectTier?: RenderObjectLodTier;
  objectLodCellSize: number;
  hudFrameStride: number;
  effectFrameStride: number;
  clientPhysicsPredictionFramesSkip: number;
  captureTileSubdiv: number;
  captureTileFrameStride: number;
  captureTileSideWalls: boolean;
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
  burnMarkAlphaCutoff: number;
  burnMarkFramesSkip: number;
  smokeTrailFramesSkip: number;
  projectileStyle: ProjectileStyle;
  fireExplosionStyle: FireExplosionStyle;
  materialExplosionStyle: DeathExplosionStyle;
  materialExplosionPieceBudget: number;
  materialExplosionPhysicsFramesSkip: number;
  deathExplosionStyle: DeathExplosionStyle;
};
