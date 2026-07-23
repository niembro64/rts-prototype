// Command types extracted from game/sim/commands.ts

import type { EntityId, WaypointType, BuildingBlueprintId, PlayerId, UnitAirIdleState, UnitMoveState, CombatTrajectoryMode, CombatFireState } from './sim';
import type { ShieldReflectionMode } from './shotTypes';
import type { SlopePathMode } from './slopePathMode';
import type { UnitGroundNormalEmaMode } from '../shellConfig';

type CommandType =
  | 'select'
  | 'move'
  | 'stop'
  | 'clearQueuedOrders'
  | 'removeLastQueuedOrder'
  | 'skipCurrentOrder'
  | 'setRepeatQueue'
  | 'setBuilderPriority'
  | 'setCarrierSpawn'
  | 'setUnitMoveState'
  | 'setFactoryAirIdleState'
  | 'setTrajectoryMode'
  | 'setCloakState'
  | 'clearSelection'
  | 'ping'
  | 'scan'
  | 'startBuild'
  | 'upgradeMetalExtractor'
  | 'upgradeMetalExtractorArea'
  | 'queueUnit'
  | 'editFactoryQueue'
  | 'removeFactoryUnitProduction'
  | 'stopFactoryProduction'
  | 'setFactoryRepeatProduction'
  | 'changeFactoryUnitQuota'
  | 'setRallyPoint'
  | 'setFactoryGuard'
  | 'fireDGun'
  | 'setFireEnabled'
  | 'setBuildingActive'
  | 'selfDestruct'
  | 'setTowerTarget'
  | 'repair'
  | 'repairArea'
  | 'reclaim'
  | 'reclaimArea'
  | 'capture'
  | 'resurrect'
  | 'resurrectArea'
  | 'loadTransport'
  | 'unloadTransport'
  | 'wait'
  | 'attack'
  | 'attackGround'
  | 'attackArea'
  | 'manualLaunch'
  | 'guard'
  | 'setPaused'
  | 'adjustGameSpeed'
  | 'setUnitGroundNormalEmaMode'
  | 'setBackgroundUnitBlueprintEnabled'
  | 'setBackgroundBuildingBlueprintEnabled'
  | 'setMaxTotalUnits'
  | 'setTurretShieldPanelsEnabled'
  | 'setTurretShieldSpheresEnabled'
  | 'setForceFieldsVisible'
  | 'setShieldsObstructSight'
  | 'setShieldReflectionMode'
  | 'setFogOfWarEnabled'
  | 'setSlopePathMode'
  | 'setConverterTax';

export type BaseCommand = {
  type: CommandType;
  tick: number;
};

export type SelectCommand = BaseCommand & {
  type: 'select';
  entityIds: EntityId[];
  additive: boolean;
};

// `z` is the altitude of the actual 3D ground point the user clicked
// (from CursorGround.pickSim). Optional so server-issued / synthetic
// commands without a click source can omit it; downstream code falls
// back to terrain sampling when missing.
export type WaypointTarget = {
  x: number;
  y: number;
  z?: number;
};

export type MoveCommand = BaseCommand & {
  type: 'move';
  entityIds: EntityId[];
  targetX?: number;
  targetY?: number;
  targetZ?: number;
  individualTargets?: WaypointTarget[];
  formationSpeed?: 'slowest';
  waypointType: WaypointType;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type StopCommand = BaseCommand & {
  type: 'stop';
  entityIds: EntityId[];
};

export type ClearQueuedOrdersCommand = BaseCommand & {
  type: 'clearQueuedOrders';
  entityIds: EntityId[];
};

export type RemoveLastQueuedOrderCommand = BaseCommand & {
  type: 'removeLastQueuedOrder';
  entityIds: EntityId[];
};

export type SkipCurrentOrderCommand = BaseCommand & {
  type: 'skipCurrentOrder';
  entityIds: EntityId[];
};

export type SetRepeatQueueCommand = BaseCommand & {
  type: 'setRepeatQueue';
  entityIds: EntityId[];
  enabled: boolean;
};

export type SetBuilderPriorityCommand = BaseCommand & {
  type: 'setBuilderPriority';
  entityIds: EntityId[];
  lowPriority: boolean;
};

export type SetCarrierSpawnCommand = BaseCommand & {
  type: 'setCarrierSpawn';
  entityIds: EntityId[];
  enabled: boolean;
};

export type SetUnitMoveStateCommand = BaseCommand & {
  type: 'setUnitMoveState';
  entityIds: EntityId[];
  moveState: UnitMoveState;
};

export type SetFactoryAirIdleStateCommand = BaseCommand & {
  type: 'setFactoryAirIdleState';
  factoryId: EntityId;
  airIdleState: UnitAirIdleState;
};

export type SetTrajectoryModeCommand = BaseCommand & {
  type: 'setTrajectoryMode';
  entityIds: EntityId[];
  trajectoryMode: CombatTrajectoryMode;
};

export type SetCloakStateCommand = BaseCommand & {
  type: 'setCloakState';
  entityIds: EntityId[];
  enabled: boolean;
};

export type ClearSelectionCommand = BaseCommand & {
  type: 'clearSelection';
};

export type PingCommand = BaseCommand & {
  type: 'ping';
  targetX: number;
  targetY: number;
  targetZ?: number;
  playerId?: PlayerId;
};

/** Drop a temporary full-vision pulse at the target point. The pulse
 *  is owned by the issuing playerId and expires after a fixed
 *  duration (FOW-14 — the canonical Starcraft scanner sweep / SupCom
 *  recon drone). All clients on the issuer's team see whatever falls
 *  inside the pulse for as long as it's live. */
export type ScanCommand = BaseCommand & {
  type: 'scan';
  targetX: number;
  targetY: number;
  playerId?: PlayerId;
};

export type StartBuildCommand = BaseCommand & {
  type: 'startBuild';
  builderId: EntityId;
  buildingBlueprintId: BuildingBlueprintId;
  gridX: number;
  gridY: number;
  rotation?: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type UpgradeMetalExtractorCommand = BaseCommand & {
  type: 'upgradeMetalExtractor';
  builderId: EntityId;
  targetId: EntityId;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type UpgradeMetalExtractorAreaCommand = BaseCommand & {
  type: 'upgradeMetalExtractorArea';
  builderIds: EntityId[];
  targetX: number;
  targetY: number;
  targetZ?: number;
  radius: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type QueueUnitCommand = BaseCommand & {
  type: 'queueUnit';
  factoryId: EntityId;
  unitBlueprintId: string;
  repeat?: boolean;
  count?: number;
};

export type EditFactoryQueueCommand = BaseCommand & {
  type: 'editFactoryQueue';
  factoryId: EntityId;
  operation: 'remove' | 'move' | 'setCount';
  index: number;
  length?: number;
  toIndex?: number;
  count?: number;
};

export type RemoveFactoryUnitProductionCommand = BaseCommand & {
  type: 'removeFactoryUnitProduction';
  factoryId: EntityId;
  unitBlueprintId: string;
  count?: number;
};

export type StopFactoryProductionCommand = BaseCommand & {
  type: 'stopFactoryProduction';
  factoryId: EntityId;
};

export type SetFactoryRepeatProductionCommand = BaseCommand & {
  type: 'setFactoryRepeatProduction';
  factoryId: EntityId;
  enabled: boolean;
};

export type ChangeFactoryUnitQuotaCommand = BaseCommand & {
  type: 'changeFactoryUnitQuota';
  factoryId: EntityId;
  unitBlueprintId: string;
  delta: number;
};

export type SetRallyPointCommand = BaseCommand & {
  type: 'setRallyPoint';
  factoryId: EntityId;
  rallyX: number;
  rallyY: number;
  rallyZ?: number;
  waypointType: WaypointType;
};

export type SetFactoryGuardCommand = BaseCommand & {
  type: 'setFactoryGuard';
  factoryId: EntityId;
  targetId: EntityId | null;
};

export type FireDGunCommand = BaseCommand & {
  type: 'fireDGun';
  commanderId: EntityId;
  /** BAR's DGun command is ICON_UNIT_OR_MAP. When present, resolve the
   *  target entity's current point at execution time; targetX/Y/Z remain
   *  the fallback point if the entity is gone by then. */
  targetId?: EntityId;
  targetX: number;
  targetY: number;
  targetZ?: number;
};

export type SetFireEnabledCommand = BaseCommand & {
  type: 'setFireEnabled';
  entityIds: EntityId[];
  enabled?: boolean;
  fireState?: CombatFireState;
};

/** Producer-building ON/OFF toggle. ON = producing + normal damage;
 *  OFF = not producing + 10x damage resistance. Targets buildings whose
 *  BuildingBlueprintId uses the active-state mechanic (solar/wind/extractor/radar/sonar/resourceConverter);
 *  other entity ids in the list are silently skipped. */
export type SetBuildingActiveCommand = BaseCommand & {
  type: 'setBuildingActive';
  entityIds: EntityId[];
  open: boolean;
};

/** Demolish the listed entities (units and buildings) on the
 *  authoritative sim. Sets hp to 0 so the per-tick death/cleanup path
 *  emits a synthetic death event and removes the entity. */
export type SelfDestructCommand = BaseCommand & {
  type: 'selfDestruct';
  entityIds: EntityId[];
  queue?: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

/** Set (or clear) a combat entity's host-level lock-on target. Entity
 *  targets write CombatComponent.priorityTargetId; ground targets write
 *  CombatComponent.priorityTargetPoint. Host-directed turrets inherit the
 *  target through the normal acquisition flow, gated by their own
 *  exclusion masks. `targetId === null` with no targetX/targetY clears
 *  the lock-on and reverts to autonomous acquisition. */
export type SetTowerTargetCommand = BaseCommand & {
  type: 'setTowerTarget';
  entityIds: EntityId[];
  targetId: EntityId | null;
  targetX?: number;
  targetY?: number;
  targetZ?: number;
};

export type RepairCommand = BaseCommand & {
  type: 'repair';
  commanderId: EntityId;
  targetId: EntityId;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

/** Broad target buckets for BAR-style area-command filters
 *  (cmd_area_commands_filter.lua). BAR distinguishes units from
 *  features (wrecks); ours adds buildings since our area commands
 *  can target them too. */
export type AreaCommandFilterCategory = 'unit' | 'building' | 'wreck';

/** Optional BAR cmd_area_commands_filter parity fields shared by the
 *  area repair/reclaim/resurrect commands. Both derive from the entity
 *  hovered at the area-drag anchor; absent = unfiltered (default).
 *  - Ctrl (BAR: "targets all units in the area / all wrecks of the same
 *    tech level"): `filterCategory` keeps only targets in the hovered
 *    target's broad category.
 *  - Alt (BAR: "targets all units that share the same unitDefId"):
 *    `filterBlueprintId` keeps only targets with the hovered target's
 *    exact blueprint (wrecks match on their source blueprint). */
type AreaCommandFilterFields = {
  filterCategory?: AreaCommandFilterCategory;
  filterBlueprintId?: string;
};

export type RepairAreaCommand = BaseCommand & AreaCommandFilterFields & {
  type: 'repairArea';
  commanderId: EntityId;
  targetX: number;
  targetY: number;
  targetZ?: number;
  radius: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type ReclaimCommand = BaseCommand & {
  type: 'reclaim';
  commanderId: EntityId;
  targetId: EntityId;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type ReclaimAreaCommand = BaseCommand & AreaCommandFilterFields & {
  type: 'reclaimArea';
  commanderId: EntityId;
  targetX: number;
  targetY: number;
  targetZ?: number;
  radius: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type CaptureCommand = BaseCommand & {
  type: 'capture';
  commanderId: EntityId;
  targetId: EntityId;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type ResurrectCommand = BaseCommand & {
  type: 'resurrect';
  commanderId: EntityId;
  targetId: EntityId;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type ResurrectAreaCommand = BaseCommand & AreaCommandFilterFields & {
  type: 'resurrectArea';
  commanderId: EntityId;
  targetX: number;
  targetY: number;
  targetZ?: number;
  radius: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type LoadTransportTargetCommand = BaseCommand & {
  type: 'loadTransport';
  transportId: EntityId;
  targetId: EntityId;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type LoadTransportAreaCommand = BaseCommand & {
  type: 'loadTransport';
  transportIds: EntityId[];
  targetX: number;
  targetY: number;
  targetZ?: number;
  radius: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type LoadTransportCommand = LoadTransportTargetCommand | LoadTransportAreaCommand;

export type UnloadTransportCommand = BaseCommand & {
  type: 'unloadTransport';
  transportIds: EntityId[];
  targetX: number;
  targetY: number;
  targetZ?: number;
  /** BAR cmd_area_unload.lua applies deterministic spread only for
   *  unload areas with radius >= 64. Omitted means a point unload. */
  radius?: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type WaitCommand = BaseCommand & {
  type: 'wait';
  entityIds: EntityId[];
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
  gather?: boolean;
  waitGroupId?: number;
};

export type AttackCommand = BaseCommand & {
  type: 'attack';
  entityIds: EntityId[];
  targetId: EntityId;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type AttackGroundCommand = BaseCommand & {
  type: 'attackGround';
  entityIds: EntityId[];
  targetX: number;
  targetY: number;
  targetZ?: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type ManualLaunchCommand = BaseCommand & {
  type: 'manualLaunch';
  entityIds: EntityId[];
  targetX: number;
  targetY: number;
  targetZ?: number;
};

export type AttackAreaCommand = BaseCommand & {
  type: 'attackArea';
  entityIds: EntityId[];
  targetX: number;
  targetY: number;
  targetZ?: number;
  radius: number;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type GuardCommand = BaseCommand & {
  type: 'guard';
  entityIds: EntityId[];
  targetId: EntityId;
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type SetPausedCommand = BaseCommand & {
  type: 'setPaused';
  paused: boolean;
};

export type AdjustGameSpeedCommand = BaseCommand & {
  type: 'adjustGameSpeed';
  direction: 1 | -1;
};

/** Pick the smoothing strength for the per-unit ground normal EMA
 *  (see updateUnitGroundNormal). SNAP = no smoothing (raw triangle-edge);
 *  FAST/MID/SLOW = increasing half-life. Goes through the regular
 *  command queue so host + every connected client run with the same
 *  effective EMA. */
export type SetUnitGroundNormalEmaModeCommand = BaseCommand & {
  type: 'setUnitGroundNormalEmaMode';
  mode: UnitGroundNormalEmaMode;
};

export type SetBackgroundUnitBlueprintEnabledCommand = BaseCommand & {
  type: 'setBackgroundUnitBlueprintEnabled';
  unitBlueprintId: string;
  enabled: boolean;
};

export type SetBackgroundBuildingBlueprintEnabledCommand = BaseCommand & {
  type: 'setBackgroundBuildingBlueprintEnabled';
  buildingBlueprintId: string;
  enabled: boolean;
};

export type SetMaxTotalUnitsCommand = BaseCommand & {
  type: 'setMaxTotalUnits';
  maxTotalUnits: number;
};

export type SetTurretShieldPanelsEnabledCommand = BaseCommand & {
  type: 'setTurretShieldPanelsEnabled';
  enabled: boolean;
};

export type SetTurretShieldSpheresEnabledCommand = BaseCommand & {
  type: 'setTurretShieldSpheresEnabled';
  enabled: boolean;
};

export type SetShieldsObstructSightCommand = BaseCommand & {
  type: 'setShieldsObstructSight';
  enabled: boolean;
};

export type SetForceFieldsVisibleCommand = BaseCommand & {
  type: 'setForceFieldsVisible';
  enabled: boolean;
};

export type SetShieldReflectionModeCommand = BaseCommand & {
  type: 'setShieldReflectionMode';
  mode: ShieldReflectionMode;
};

export type SetFogOfWarEnabledCommand = BaseCommand & {
  type: 'setFogOfWarEnabled';
  enabled: boolean;
};

export type SetSlopePathModeCommand = BaseCommand & {
  type: 'setSlopePathMode';
  mode: SlopePathMode;
};

export type SetConverterTaxCommand = BaseCommand & {
  type: 'setConverterTax';
  tax: number;
};

export type Command =
  | SelectCommand
  | MoveCommand
  | StopCommand
  | ClearQueuedOrdersCommand
  | RemoveLastQueuedOrderCommand
  | SkipCurrentOrderCommand
  | SetRepeatQueueCommand
  | SetBuilderPriorityCommand
  | SetCarrierSpawnCommand
  | SetUnitMoveStateCommand
  | SetFactoryAirIdleStateCommand
  | SetTrajectoryModeCommand
  | SetCloakStateCommand
  | ClearSelectionCommand
  | PingCommand
  | ScanCommand
  | StartBuildCommand
  | UpgradeMetalExtractorCommand
  | UpgradeMetalExtractorAreaCommand
  | QueueUnitCommand
  | EditFactoryQueueCommand
  | RemoveFactoryUnitProductionCommand
  | StopFactoryProductionCommand
  | SetFactoryRepeatProductionCommand
  | ChangeFactoryUnitQuotaCommand
  | SetRallyPointCommand
  | SetFactoryGuardCommand
  | FireDGunCommand
  | SetFireEnabledCommand
  | SetBuildingActiveCommand
  | SelfDestructCommand
  | SetTowerTargetCommand
  | RepairCommand
  | RepairAreaCommand
  | ReclaimCommand
  | ReclaimAreaCommand
  | CaptureCommand
  | ResurrectCommand
  | ResurrectAreaCommand
  | LoadTransportCommand
  | UnloadTransportCommand
  | WaitCommand
  | AttackCommand
  | AttackGroundCommand
  | AttackAreaCommand
  | ManualLaunchCommand
  | GuardCommand
  | SetPausedCommand
  | AdjustGameSpeedCommand
  | SetUnitGroundNormalEmaModeCommand
  | SetBackgroundUnitBlueprintEnabledCommand
  | SetBackgroundBuildingBlueprintEnabledCommand
  | SetMaxTotalUnitsCommand
  | SetTurretShieldPanelsEnabledCommand
  | SetTurretShieldSpheresEnabledCommand
  | SetForceFieldsVisibleCommand
  | SetShieldsObstructSightCommand
  | SetShieldReflectionModeCommand
  | SetFogOfWarEnabledCommand
  | SetSlopePathModeCommand
  | SetConverterTaxCommand;
