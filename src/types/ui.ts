// UI component types extracted from Vue components and helpers

import type { PlayerId, EntityId, WaypointType, Entity, BuildingBlueprintId } from './sim';
import type { Vec2 } from './vec2';

// Selection panel types
export type FactorySelectionItem = {
  unitBlueprintId: string;
  label: string;
};

export type ControlGroupInfo = {
  index: number;
  count: number;
  active: boolean;
};

export type SelectionEntityType = 'unit' | 'tower' | 'building';

export type SelectionInfo = {
  // Per-type selection counts. The action panel branches on these so
  // each entity type gets its own uniform action set
  // (see design_philosophy.html "Selection Menus Are Uniform Per
  // Entity Type"). towerCount counts selected entities whose
  // entity.type === 'tower' (fabricators + shooting towers);
  // buildingCount counts selected entities whose
  // entity.type === 'building' (pure infrastructure: solar, wind,
  // extractor, radar, converter).
  unitCount: number;
  towerCount: number;
  buildingCount: number;
  hasCommander: boolean;
  hasBuilder: boolean;
  hasDGun: boolean;
  hasFireControl: boolean;
  fireEnabled: boolean;
  /** True iff the selection contains at least one building whose
   *  BuildingBlueprintId uses the ON/OFF active-state mechanic
   *  (solar/wind/extractor/radar/resourceConverter). Gates the ON/OFF button. */
  hasBuildingActiveControl: boolean;
  /** True when every active-state building in the selection is currently
   *  ON (open). Drives the ON/OFF button label. */
  buildingsActive: boolean;
  /** True when any selected entity belongs to the local player and can
   *  be removed by a self-destruct command. */
  hasSelfDestructable: boolean;
  /** True when the tower section's Set Target / Clear Target buttons
   *  should appear. Mirrors `towerCount > 0`. */
  hasTowerTargetControl: boolean;
  /** True when at least one selected tower has a host-level lock-on
   *  target set. Enables the Clear Target button. */
  hasTowerTargetActive: boolean;
  /** True while the user is in the click-to-pick mode for setting a
   *  tower's lock-on target. Highlights the Set Target button. */
  isTowerTargetMode: boolean;
  isWaiting: boolean;
  hasQueuedOrders: boolean;
  hasFactory: boolean;
  factoryId?: number;
  commanderId?: number;
  waypointMode: WaypointType;
  isBuildMode: boolean;
  selectedBuildingBlueprintId: string | null;
  isDGunMode: boolean;
  isRepairAreaMode: boolean;
  isAttackAreaMode: boolean;
  isAttackGroundMode: boolean;
  isGuardMode: boolean;
  isReclaimMode: boolean;
  isPingMode: boolean;
  factorySelectedUnit?: FactorySelectionItem | null;
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
  /** ON/OFF for producer buildings in the selection. */
  toggleBuildingActive: () => void;
  /** Demolish every owned entity in the selection. */
  selfDestructSelected: () => void;
  /** Narrow a mixed selection to one entity type. */
  selectOnlyEntityType: (entityType: SelectionEntityType) => void;
  /** Enter click-pick mode for setting the host lock-on target on the
   *  selected towers. Right-click / Esc cancels. */
  setTowerTargetMode: () => void;
  /** Clear the host lock-on target on the selected towers. */
  clearTowerTarget: () => void;
  toggleAttackArea: () => void;
  toggleAttackGround: () => void;
  toggleGuard: () => void;
  toggleReclaim: () => void;
  togglePing: () => void;
  storeControlGroup: (index: number) => void;
  recallControlGroup: (index: number, additive: boolean) => void;
  startBuild: (buildingBlueprintId: BuildingBlueprintId) => void;
  cancelBuild: () => void;
  toggleDGun: () => void;
  toggleRepairArea: () => void;
  queueUnit: (factoryId: number, unitBlueprintId: string) => void;
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
   *  radar coverage (FOW-03a). Minimap renderer should
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
  selectedBuildingBlueprintId: string | null;
  isDGunMode: boolean;
  isRepairAreaMode: boolean;
  isAttackAreaMode: boolean;
  isAttackGroundMode: boolean;
  isGuardMode: boolean;
  isReclaimMode: boolean;
  isPingMode: boolean;
  /** True while in the click-to-pick mode for setting a tower's host
   *  lock-on target. Mirrors the attack-area / guard mode pattern. */
  isTowerTargetMode: boolean;
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
  /** Optional waypoint for two-leg visual streams. Resource pylons use
   *  this as their conserved tip: particles travel root/world -> tip
   *  -> world/root instead of spawning or dying at the pylon head. */
  waypoint?: { pos: Vec2; z?: number };
  /** Optional second waypoint for conserved three-leg pylon streams.
   *  Converter arcs use this as the receiving pylon tip: particles can
   *  travel source-root -> source-tip -> target-tip -> target-root. */
  waypoint2?: { pos: Vec2; z?: number };
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
  /** Optional end color. When present, particles lerp from colorRGB
   *  (or the resolved source color) to this value in flight. */
  endColorRGB?: { r: number; g: number; b: number };
};

// Pylon tube-flow descriptor — a column of beads locked to a resource
// pylon's LIVE root->tip axis. Recomputed from these world endpoints
// every frame, so the column rides the (orbiting) construction-emitter
// pylon and the beads can never escape the transparent straw. World
// coordinates: x/z are ground plane, y is altitude.
export type PylonTubeFlow = {
  root: { x: number; y: number; z: number };
  tip: { x: number; y: number; z: number };
  /** true = beads travel root -> tip (consuming / up the tube); false =
   *  tip -> root (producing / down the tube). */
  up: boolean;
  /** 0..1 — drives how many beads fill the column and their alpha. */
  intensity: number;
  /** Bead travel speed in world units per second along the axis. */
  speed: number;
  beadRadius: number;
  colorRGB: { r: number; g: number; b: number };
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
  onSimEvent: ((event: import('./combat').SimEvent) => void) | null;
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

