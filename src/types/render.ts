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
  graphics: import('../game/render/Graphics').IGraphics;
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
  graphics: import('../game/render/Graphics').IGraphics;
  entity: Entity;
  left: number;
  top: number;
  width: number;
  height: number;
  playerColor: number;
  sprayParticleTime: number;
  detail: boolean;
};

// Per-projectile random offsets for visual variety
export type BeamRandomOffsets = {
  phaseOffset: number;
  rotationOffset: number;
  sizeScale: number;
  pulseSpeed: number;
};

/**
 * Scorched-earth burn mark — stored as a quad (4 vertices in CCW order).
 *
 *   x0,y0 ── x3,y3    (end side: x2,y2 — x3,y3)
 *     │        │
 *   x1,y1 ── x2,y2    (start side: x0,y0 — x1,y1; left—right)
 *
 * A free (non-joined) endpoint uses a square cap (perpendicular to segment
 * direction). When a subsequent mark appends to the same beam, both the
 * previous mark's end vertices AND the new mark's start vertices are set
 * to the bisector of the two segments, so adjacent quads share an edge
 * and produce no overlap or gap along the trail.
 */
export type BurnMark = {
  // Start-side vertices (left + right of segment start).
  x0: number; y0: number;
  x1: number; y1: number;
  // End-side vertices (right + left of segment end).
  x2: number; y2: number;
  x3: number; y3: number;
  // Segment direction (unit vector) — stored so a subsequent mark can
  // compute the bisector without re-deriving from vertex positions.
  dirX: number;
  dirY: number;
  // Beam width used at creation (for reference; vertices already encode it).
  width: number;
  age: number;
  color: number;
  alpha: number;
  /** Set to true when the mark is culled so any per-beam state still
   *  holding a reference knows not to reach back into a dead quad. */
  removed: boolean;
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
