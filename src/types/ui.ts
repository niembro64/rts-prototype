// UI component types extracted from Vue components and helpers

import type { PlayerId, EntityId, WaypointType, Entity } from './sim';
import type { NetworkServerSnapshotCombatStats } from './network';
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
  startBuild: (buildingType: 'solar' | 'factory') => void;
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
  units: { count: number; cap: number };
  buildings: { solar: number; factory: number };
};

// Minimap types
export type MinimapEntity = {
  pos: Vec2;
  type: 'unit' | 'building';
  color: string;
  isSelected?: boolean;
};

/** One captured grid cell carried across to the minimap. Mirrors the
 *  3D CaptureTileRenderer3D's per-tile data exactly so the two
 *  renderers can share a blend formula. cx / cy are integer cell
 *  indices into the `cellSize`-spaced grid; `heights` is a sparse
 *  per-team flag-height map (0–1). */
export type MinimapCaptureTile = {
  cx: number;
  cy: number;
  heights: Record<number, number>;
};

export type MinimapData = {
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

  /** Per-tile capture data, paralleled with the 3D capture-tile
   *  renderer. Empty array when the GRID overlay is OFF — the minimap
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
  /** Whether the GRID setting is anything other than OFF — i.e. the
   *  3D capture-tile mesh is currently visible. The minimap mirrors
   *  this to decide whether to draw the terrain (land + water) layer
   *  at all: when GRID = OFF the 3D scene shows no land tiles, so the
   *  minimap skips the terrain pass too and just stamps the dark map
   *  background under the entity dots. */
  showTerrain: boolean;
};

// Lobby player — re-exported from `types/network.ts` so the
// component layer and the network layer can't drift apart on
// schema (IP / location columns landed in network.ts and the
// duplicate that previously lived here was missing them).
export type { LobbyPlayer } from './network';

// Combat stats
export type FriendlyFireMode = 'include' | 'ignore' | 'subHalf' | 'subtract';

export type StatsSnapshot = {
  timestamp: number;
  stats: NetworkServerSnapshotCombatStats;
};

// UI entity source
export type UIEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
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
  maxEnergyUseRateByTarget: Map<EntityId, number>;
};

export type EnergyConsumer = {
  entity: Entity;
  type: 'factory' | 'building' | 'heal';
  remainingCost: number;
  playerId: PlayerId;
  maxEnergyPerTick: number;
};

// Combat stats tracker types
export type UnitTypeStats = {
  damage: { dealt: { enemy: number; friendly: number }; received: number };
  kills: { enemy: number; friendly: number };
  units: { produced: number; lost: number; energyCost: number; manaCost: number };
};

export type CombatStatsSnapshot = {
  players: Record<number, Record<string, UnitTypeStats>>;
  global: Record<string, UnitTypeStats>;
};
