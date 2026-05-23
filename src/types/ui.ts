// UI component types extracted from Vue components and helpers

import type { PlayerId, EntityId, WaypointType, Entity, BuildingType } from './sim';
import type { Vec2 } from './vec2';

// Selection panel types
export type QueueItem = {
  unitId: string;
  label: string;
};

export type ControlGroupInfo = {
  index: number;
  count: number;
  active: boolean;
};

export type SelectionInfo = {
  unitCount: number;
  hasCommander: boolean;
  hasBuilder: boolean;
  hasDGun: boolean;
  hasFireControl: boolean;
  fireEnabled: boolean;
  isWaiting: boolean;
  hasQueuedOrders: boolean;
  hasFactory: boolean;
  factoryId?: number;
  commanderId?: number;
  waypointMode: WaypointType;
  isBuildMode: boolean;
  selectedBuildingType: string | null;
  isDGunMode: boolean;
  isRepairAreaMode: boolean;
  isAttackAreaMode: boolean;
  isAttackGroundMode: boolean;
  isGuardMode: boolean;
  isReclaimMode: boolean;
  isPingMode: boolean;
  factoryQueue?: QueueItem[];
  factoryProgress?: number;
  factoryIsProducing?: boolean;
  controlGroups: ControlGroupInfo[];
};

export type SelectionActions = {
  setWaypointMode: (mode: WaypointType) => void;
  stopSelectedUnits: () => void;
  clearQueuedOrders: () => void;
  removeLastQueuedOrder: () => void;
  toggleSelectedWait: () => void;
  toggleSelectedFire: () => void;
  toggleAttackArea: () => void;
  toggleAttackGround: () => void;
  toggleGuard: () => void;
  toggleReclaim: () => void;
  togglePing: () => void;
  storeControlGroup: (index: number) => void;
  recallControlGroup: (index: number, additive: boolean) => void;
  startBuild: (buildingType: BuildingType) => void;
  cancelBuild: () => void;
  toggleDGun: () => void;
  toggleRepairArea: () => void;
  queueUnit: (factoryId: number, unitId: string) => void;
  cancelQueueItem: (factoryId: number, index: number) => void;
};

// Economy info
export type EconomyInfo = {
  stockpile: { curr: number; max: number };
  income: { base: number; production: number; total: number };
  expenditure: number;
  netFlow: number;
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
  /** True when the recipient only knows about this entity through
   *  radar coverage (issues.txt FOW-03a). Minimap renderer should
   *  draw a generic positional blip rather than the identifiable
   *  team-colored marker. */
  radarOnly?: boolean;
};

export type MinimapData = {
  /** Incremented whenever the minimap content layer changes. This lets
   *  callers reuse entity records without depending on array identity
   *  for redraws. */
  contentVersion: number;
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

  /** Whether to draw the terrain (land + water) layer. */
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
  isRepairAreaMode: boolean;
  isAttackAreaMode: boolean;
  isAttackGroundMode: boolean;
  isGuardMode: boolean;
  isReclaimMode: boolean;
  isPingMode: boolean;
  controlGroups: ControlGroupInfo[];
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
  /** Optional vertical force component for 3D pushes (knockback lift,
   *  gravity gun, etc.). Omitted/0 for the common horizontal-only
   *  case. ForceAccumulator sums this into finalFz alongside finalFx
   *  and finalFy. */
  forceZ?: number;
  source: string;
};

// Spray target
export type SprayFlowMode = 'direct' | 'randomInbound' | 'randomOutbound';

export type SprayTarget = {
  source: { id: EntityId; pos: Vec2; z?: number; playerId: PlayerId };
  target: { id: EntityId; pos: Vec2; z?: number; dim?: Vec2; radius?: number };
  type: 'build' | 'heal';
  intensity: number;
  /** Separates multiple streams between the same entity pair, e.g.
   *  energy and metal pylons spraying at the same build target. */
  channel: number;
  /** Direct sprays fly source -> target. Random pylon flows use the
   *  source point as their pylon head and generate per-particle random
   *  world offsets inward or outward from that point. */
  flow: SprayFlowMode;
  flowRadius: number;
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
   *  (energy / metal) regardless of team. */
  colorRGB?: { r: number; g: number; b: number };
};

// Commander abilities result
export type CommanderAbilitiesResult = {
  sprayTargets: SprayTarget[];
  completedBuildings: { commanderId: EntityId; buildingId: EntityId }[];
};

// Factory production result
export type FactoryProductionResult = {
  spawnedUnits: Entity[];
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
  constructionSourceHeadByTarget: Map<EntityId, number>;
  constructionSourceTailByTarget: Map<EntityId, number>;
  constructionSources: EnergySource[];
  /** Building IDs already added as a 'building' consumer this tick.
   *  Used by the commander pass to skip re-adding a target that a
   *  builder unit has already registered, in O(1) instead of an
   *  O(consumers-per-player) linear walk. */
  buildingConsumerIds: Set<EntityId>;
};

export type EnergySource = {
  sourceEntityId: EntityId;
  maxResourcePerTick: number;
  nextIndex: number;
};

export type EnergyConsumer = {
  /** For 'build', the entity holding the in-progress Buildable (a
   *  unit shell from a factory, or a building under construction
   *  funded by a builder/commander). For 'heal', the unit being
   *  healed. */
  entity: Entity;
  type: 'build' | 'heal';
  /** Direct pylon host when a single factory or commander funds this
   *  consumer. Null when the consumer uses the target-keyed builder
   *  source breakdown. */
  sourceEntityId: EntityId | null;
  /** Build target whose builder-source linked list should receive this
   *  consumer's resource flow. Null for direct-source consumers. */
  sourceBreakdownTargetId: EntityId | null;
  /** Remaining resource work this consumer needs to finish. Healing
   *  stores energy repair cost; building stores total construction
   *  resource remaining across energy and metal. */
  remainingCost: number;
  playerId: PlayerId;
  maxResourcePerTick: number;
};

