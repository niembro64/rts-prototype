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

export type MinimapData = {
  mapWidth: number;
  mapHeight: number;
  entities: MinimapEntity[];
  cameraX: number;
  cameraY: number;
  cameraWidth: number;
  cameraHeight: number;
};

// Lobby player (used in both component and network)
export type LobbyPlayer = {
  playerId: PlayerId;
  name: string;
  isHost: boolean;
};

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
};

// Force contribution
export type ForceContribution = {
  force: Vec2;
  source: string;
};

// Spray target
export type SprayTarget = {
  source: { id: EntityId; pos: Vec2; playerId: PlayerId };
  target: { id: EntityId; pos: Vec2; dim?: Vec2; radius?: number };
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
