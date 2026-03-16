// Render system types extracted from game/render/ files

import type { Entity, EntityId } from './sim';

// EntitySource - both WorldState and ClientViewState implement this
export type EntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  getProjectiles(): Entity[];
  getEntity(id: number): Entity | undefined;
};

// Explosion effect data
export type ExplosionEffect = {
  x: number;
  y: number;
  radius: number;
  color: number;
  lifetime: number;
  elapsed: number;
  type: 'impact' | 'death';
  velocityX?: number;
  velocityY?: number;
  velocityMag?: number;
  penetrationX?: number;
  penetrationY?: number;
  penetrationMag?: number;
  attackerX?: number;
  attackerY?: number;
  attackerMag?: number;
  combinedX?: number;
  combinedY?: number;
  combinedMag?: number;
  collisionRadius?: number;
  primaryRadius?: number;
  secondaryRadius?: number;
  entityCollisionRadius?: number;
};

// Color palette for unit rendering
export type ColorPalette = {
  base: number;
  light: number;
  dark: number;
};

// Ring-buffer of historical positions for projectile trail rendering
export type ProjectileTrail = {
  positions: Float32Array;
  head: number;
  count: number;
  capacity: number;
};

// Context passed to unit renderers
export type UnitRenderContext = {
  graphics: import('phaser').GameObjects.Graphics;
  x: number;
  y: number;
  radius: number;
  bodyRot: number;
  palette: ColorPalette;
  isSelected: boolean;
  entity: Entity;
  chassisDetail: boolean;
};

// Context passed to building renderers
export type BuildingRenderContext = {
  graphics: import('phaser').GameObjects.Graphics;
  entity: Entity;
  left: number;
  top: number;
  width: number;
  height: number;
  playerColor: number;
  sprayParticleTime: number;
};

// Per-projectile random offsets for visual variety
export type BeamRandomOffsets = {
  phaseOffset: number;
  rotationOffset: number;
  sizeScale: number;
  pulseSpeed: number;
};

// Scorched earth burn mark
export type BurnMark = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  age: number;
  color: number;
};

// Death debris fragment
export type DebrisFragment = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  angularVel: number;
  length: number;
  width: number;
  color: number;
  baseColor: number;
  age: number;
  shape: 'line' | 'rect';
  cosR: number;
  sinR: number;
};

// Per-unit-type debris piece template
export type DebrisPieceTemplate = {
  localX: number;
  localY: number;
  length: number;
  width: number;
  angle: number;
  colorType: 'base' | 'dark' | 'light' | 'gray' | 'white';
  shape: 'line' | 'rect';
};

// Tread attachment config
export type TreadAttachConfig = {
  attachOffsetX: number;
  attachOffsetY: number;
  wheelRadius: number;
  rotationSpeedMultiplier: number;
};

// Tank tread pair setup
export type TankTreadSetup = {
  leftTread: import('../game/render/Tread').Tread;
  rightTread: import('../game/render/Tread').Tread;
};

// Vehicle wheel setup
export type VehicleWheelSetup = {
  wheels: import('../game/render/Tread').Tread[];
};

// Arachnid leg config (named differently from blueprint LegConfig to avoid collision)
export type ArachnidLegConfig = {
  attachOffsetX: number;
  attachOffsetY: number;
  upperLegLength: number;
  lowerLegLength: number;
  snapTriggerAngle: number;
  snapTargetAngle: number;
  snapDistanceMultiplier: number;
  extensionThreshold: number;
  lerpDuration?: number;
};

// Unit renderer function type
export type UnitRenderer = (ctx: UnitRenderContext) => void;

// Leg accessor for legged unit renderers
export type LegAccessor = {
  getOrCreateLegs: (entity: Entity, style: 'widow' | 'daddy' | 'tarantula') => import('../game/render/ArachnidLeg').ArachnidLeg[];
};

// Tread/wheel accessor for tracked/wheeled unit renderers
export type TreadAccessor = {
  getTankTreads: (entityId: EntityId) => TankTreadSetup | undefined;
  getVehicleWheels: (entityId: EntityId) => VehicleWheelSetup | undefined;
};

// Range circle visibility types
export type UnitRadiusVisibility = {
  visual: boolean;
  shot: boolean;
  push: boolean;
};

export type RangeVisibility = {
  trackAcquire: boolean;
  trackRelease: boolean;
  engageAcquire: boolean;
  engageRelease: boolean;
  build: boolean;
};
