// UI component types extracted from Vue components and helpers

import type { PlayerId, EntityId, WaypointType, Entity, BuildingType } from './sim';
import type { Vec2 } from './vec2';

// Selection panel types
export type QueueItem = {
  unitId: string;
  label: string;
};

export type SelectionInfo = {
  unitCount: number;
  hasCommander: boolean;
  hasBuilder: boolean;
  hasDGun: boolean;
  hasFactory: boolean;
  factoryId?: number;
  commanderId?: number;
  waypointMode: WaypointType;
  isBuildMode: boolean;
  selectedBuildingType: string | null;
  isDGunMode: boolean;
  factoryQueue?: QueueItem[];
  factoryProgress?: number;
  factoryIsProducing?: boolean;
};

export type SelectionActions = {
  setWaypointMode: (mode: WaypointType) => void;
  startBuild: (buildingType: BuildingType) => void;
  cancelBuild: () => void;
  toggleDGun: () => void;
  queueUnit: (factoryId: number, unitId: string) => void;
  cancelQueueItem: (factoryId: number, index: number) => void;
};

// Economy info
export type EconomyInfo = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number; total: number };
  expenditure: number;
  netFlow: number;
  mana: {
    stockpile: { curr: number; max: number };
    income: { base: number; territory: number; total: number };
    expenditure: number;
    netFlow: number;
  };
  metal: {
    stockpile: { curr: number; max: number };
    income: { base: number; extraction: number; total: number };
    expenditure: number;
    netFlow: number;
  };
  units: { count: number; cap: number };
  buildings: { solar: number; wind: number; factory: number; extractor: number };
};

// Minimap types
export type MinimapEntity = {
  pos: Vec2;
  type: 'unit' | 'building';
  color: string;
  isSelected?: boolean;
};

/** One captured grid cell carried across to the minimap. Mirrors the
 *  3D floating cells overlay's per-tile data exactly so the two
 *  renderers can share a blend formula. cx / cy are integer cell
 *  indices into the `cellSize`-spaced grid; `heights` is a sparse
 *  per-team flag-height map (0–1). */
export type MinimapCaptureTile = {
  cx: number;
  cy: number;
  heights: Record<number, number>;
};

export type MinimapData = {
  /** Incremented whenever the minimap content layer changes. This lets
   *  callers reuse entity records without depending on array identity
   *  for redraws. */
  contentVersion: number;
  /** Incremented only when the terrain/capture background data changes.
   *  Entity position refreshes should not force the minimap to repaint
   *  the slow per-pixel terrain/capture layer. */
  captureVersion: number;
  mapWidth: number;
  mapHeight: number;
  entities: MinimapEntity[];
  /** World-space footprint of the camera view on the ground plane, as
   *  four corners in screen order: top-left, top-right, bottom-right,
   *  bottom-left. An axis-aligned rect for an unrotated 2D camera; a
   *  rotated rect for 2D with camera rotation; a trapezoid for a 3D
   *  perspective camera looking down at an angle. Drawn on the minimap
   *  as a polygon so the shape always matches the actual viewport,
   *  including the trapezoidal ground-plane projection in 3D. */
  cameraQuad: readonly [Vec2, Vec2, Vec2, Vec2];
  /** Orbit camera yaw in radians. Used by minimap instruments to draw
   *  world directions in current screen-space rather than map-space. */
  cameraYaw: number;

  /** Per-tile capture data, paralleled with the 3D floating cells
   *  overlay. Empty array when the GRID overlay is OFF — the minimap
   *  uses this as the signal to skip the team-color overlay (one
   *  switch keeps minimap brightness in lockstep with the 3D grid). */
  captureTiles: readonly MinimapCaptureTile[];
  /** World-units side length of a capture grid cell. 0 means "no
   *  capture data this frame" (e.g. server hasn't sent anything yet);
   *  the minimap renderer falls back to skipping the overlay. */
  captureCellSize: number;
  /** Lerp factor from neutral → dominant team color. Mirrors the
   *  PLAYER CLIENT GRID intensity (zero → 0, low → 0.04, medium →
   *  0.1, high → 0.8) so minimap brightness tracks the 3D scene's
   *  brightness exactly. */
  gridOverlayIntensity: number;
  /** Whether to draw the terrain (land + water) layer. This is no
   *  longer tied to GRID visibility; GRID only controls the capture
   *  color overlay. */
  showTerrain: boolean;
  wind?: { x: number; y: number; speed: number };
};

// Lobby player — re-exported from `types/network.ts` so the
// component layer and the network layer can't drift apart on
// schema (IP / location columns landed in network.ts and the
// duplicate that previously lived here was missing them).
export type { LobbyPlayer } from './network';

// UI entity source
export type UIEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  getUnitsAndBuildings(): Entity[];
  getSelectedUnits(): Entity[];
  getSelectedBuildings(): Entity[];
  getBuildingsByPlayer(playerId: PlayerId): Entity[];
  getUnitsByPlayer(playerId: PlayerId): Entity[];
};

// UI input state (minimal subset for UI updates)
export type UIInputState = {
  waypointMode: WaypointType;
  isBuildMode: boolean;
  selectedBuildingType: string | null;
  isDGunMode: boolean;
};

// Unit valuation
export type UnitValuation = {
  weaponValue: number;
  defensiveValue: number;
  mobilityValue: number;
  rawValue: number;
  suggestedCost: number;
};

// Grid cell
export type GridCell = {
  occupied: boolean;
  entityId: EntityId | null;
  playerId: PlayerId | null;
  blocksMovement?: boolean;
};

// Force contribution
export type ForceContribution = {
  force: Vec2;
  source: string;
};

// Spray target
export type SprayTarget = {
  source: { id: EntityId; pos: Vec2; z?: number; playerId: PlayerId };
  target: { id: EntityId; pos: Vec2; z?: number; dim?: Vec2; radius?: number };
  type: 'build' | 'heal';
  intensity: number;
  /** Optional particle travel speed in world units per second. Build
   *  sprays use this to move linearly from source to target; omitted
   *  heal sprays use the renderer's heal default. */
  speed?: number;
  /** Optional cosmetic particle radius. Build sprays use this so the
   *  construction emitter owns both travel speed and pellet size. */
  particleRadius?: number;
  /** Optional per-spray color override (RGB in [0..1]). When present
   *  the renderer paints particles in this color instead of the
   *  source's team-primary color. Used by the factory's per-resource
   *  build sprays so each pylon's stream reads as its resource
   *  (energy / mana / metal) regardless of team. */
  colorRGB?: { r: number; g: number; b: number };
};

// Commander abilities result
export type CommanderAbilitiesResult = {
  sprayTargets: SprayTarget[];
  completedBuildings: { commanderId: EntityId; buildingId: EntityId }[];
};

// Factory production result
export type FactoryProductionResult = {
  completedUnits: Entity[];
};

// Command context
export type CommandContext = {
  world: import('../game/sim/WorldState').WorldState;
  constructionSystem: import('../game/sim/construction').ConstructionSystem;
  pendingProjectileSpawns: import('./combat').ProjectileSpawnEvent[];
  pendingSimEvents: import('./combat').SimEvent[];
  onSimEvent?: (event: import('./combat').SimEvent) => void;
};

// Energy buffers
export type EnergyBuffers = {
  consumers: EnergyConsumer[];
  consumersByPlayer: Map<PlayerId, number[]>;
  buildTargetSet: Set<EntityId>;
  constructionRateByTarget: Map<EntityId, number>;
  /** Building IDs already added as a 'building' consumer this tick.
   *  Used by the commander pass to skip re-adding a target that a
   *  builder unit has already registered, in O(1) instead of an
   *  O(consumers-per-player) linear walk. */
  buildingConsumerIds: Set<EntityId>;
};

export type EnergyConsumer = {
  /** For 'build', the entity holding the in-progress Buildable (a
   *  unit shell from a factory, or a building under construction
   *  funded by a builder/commander). For 'heal', the unit being
   *  healed. */
  entity: Entity;
  type: 'build' | 'heal';
  /** Factory that spawned this shell, when this build consumer is a
   *  factory-produced unit. The shell owns resource truth, but the
   *  factory owns queue UI progress, so resource flow into the shell
   *  dirties the factory snapshot too. */
  sourceFactoryId?: EntityId;
  /** Remaining resource work this consumer needs to finish. Healing
   *  stores energy repair cost; building stores total construction
   *  resource remaining across energy, mana, and metal. */
  remainingCost: number;
  playerId: PlayerId;
  maxResourcePerTick: number;
};

