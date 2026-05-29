// Command types extracted from game/sim/commands.ts

import type { EntityId, WaypointType, BuildingBlueprintId, PlayerId } from './sim';
import type { KeyframeRatio, SnapshotRate, TickRate } from './server';
import type { ForceFieldReflectionMode } from './shotTypes';
import type { UnitGroundNormalEmaMode } from '../shellConfig';

export type CommandType =
  | 'select'
  | 'move'
  | 'stop'
  | 'clearQueuedOrders'
  | 'removeLastQueuedOrder'
  | 'clearSelection'
  | 'ping'
  | 'scan'
  | 'startBuild'
  | 'queueUnit'
  | 'cancelQueueItem'
  | 'setRallyPoint'
  | 'setFactoryWaypoints'
  | 'fireDGun'
  | 'setFireEnabled'
  | 'setBuildingActive'
  | 'selfDestruct'
  | 'setTowerTarget'
  | 'repair'
  | 'repairArea'
  | 'reclaim'
  | 'wait'
  | 'attack'
  | 'attackGround'
  | 'attackArea'
  | 'guard'
  | 'setSnapshotRate'
  | 'setKeyframeRatio'
  | 'setTickRate'
  | 'setUnitGroundNormalEmaMode'
  | 'setSendGridInfo'
  | 'setBackgroundUnitBlueprintEnabled'
  | 'setMaxTotalUnits'
  | 'setTurretForceFieldPanelsEnabled'
  | 'setTurretForceFieldSpheresEnabled'
  | 'setForceFieldsObstructSight'
  | 'setForceFieldReflectionMode'
  | 'setFogOfWarEnabled'
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
  waypointType: WaypointType;
  queue: boolean;
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
  queue: boolean;
};

export type QueueUnitCommand = BaseCommand & {
  type: 'queueUnit';
  factoryId: EntityId;
  unitBlueprintId: string;
};

export type CancelQueueItemCommand = BaseCommand & {
  type: 'cancelQueueItem';
  factoryId: EntityId;
  index: number;
};

export type SetRallyPointCommand = BaseCommand & {
  type: 'setRallyPoint';
  factoryId: EntityId;
  rallyX: number;
  rallyY: number;
};

export type FactoryWaypoint = {
  x: number;
  y: number;
  z?: number;
  type: WaypointType;
};

export type SetFactoryWaypointsCommand = BaseCommand & {
  type: 'setFactoryWaypoints';
  factoryId: EntityId;
  waypoints: FactoryWaypoint[];
  queue: boolean;
};

export type FireDGunCommand = BaseCommand & {
  type: 'fireDGun';
  commanderId: EntityId;
  targetX: number;
  targetY: number;
  targetZ?: number;
};

export type SetFireEnabledCommand = BaseCommand & {
  type: 'setFireEnabled';
  entityIds: EntityId[];
  enabled: boolean;
};

/** Producer-building ON/OFF toggle. ON = producing + normal damage;
 *  OFF = not producing + 10x damage resistance. Targets buildings whose
 *  BuildingBlueprintId uses the active-state mechanic (solar/wind/extractor/radar/resourceConverter);
 *  other entity ids in the list are silently skipped. */
export type SetBuildingActiveCommand = BaseCommand & {
  type: 'setBuildingActive';
  entityIds: EntityId[];
  open: boolean;
};

/** Demolish the listed entities (units, towers, buildings) on the
 *  authoritative sim. Sets hp to 0 so the per-tick death/cleanup path
 *  emits a synthetic death event and removes the entity. */
export type SelfDestructCommand = BaseCommand & {
  type: 'selfDestruct';
  entityIds: EntityId[];
};

/** Set (or clear) a tower's host-level lock-on target. Writes
 *  CombatComponent.priorityTargetId directly; host-directed turrets
 *  inherit the target through the normal acquisition flow, gated by
 *  their own exclusion masks. `targetId === null` clears the lock-on
 *  and the tower reverts to autonomous acquisition. */
export type SetTowerTargetCommand = BaseCommand & {
  type: 'setTowerTarget';
  entityIds: EntityId[];
  targetId: EntityId | null;
};

export type RepairCommand = BaseCommand & {
  type: 'repair';
  commanderId: EntityId;
  targetId: EntityId;
  queue: boolean;
};

export type RepairAreaCommand = BaseCommand & {
  type: 'repairArea';
  commanderId: EntityId;
  targetX: number;
  targetY: number;
  targetZ?: number;
  radius: number;
  queue: boolean;
};

export type ReclaimCommand = BaseCommand & {
  type: 'reclaim';
  commanderId: EntityId;
  targetId: EntityId;
  queue: boolean;
};

export type WaitCommand = BaseCommand & {
  type: 'wait';
  entityIds: EntityId[];
  queue: boolean;
};

export type AttackCommand = BaseCommand & {
  type: 'attack';
  entityIds: EntityId[];
  targetId: EntityId;
  queue: boolean;
};

export type AttackGroundCommand = BaseCommand & {
  type: 'attackGround';
  entityIds: EntityId[];
  targetX: number;
  targetY: number;
  targetZ?: number;
  queue: boolean;
};

export type AttackAreaCommand = BaseCommand & {
  type: 'attackArea';
  entityIds: EntityId[];
  targetX: number;
  targetY: number;
  targetZ?: number;
  radius: number;
  queue: boolean;
};

export type GuardCommand = BaseCommand & {
  type: 'guard';
  entityIds: EntityId[];
  targetId: EntityId;
  queue: boolean;
};

export type SetSnapshotRateCommand = BaseCommand & {
  type: 'setSnapshotRate';
  rate: SnapshotRate;
};

export type SetKeyframeRatioCommand = BaseCommand & {
  type: 'setKeyframeRatio';
  ratio: KeyframeRatio;
};

export type SetTickRateCommand = BaseCommand & {
  type: 'setTickRate';
  rate: TickRate;
};

/** Pick the smoothing strength for the per-unit ground normal EMA
 *  (see updateUnitGroundNormal). SNAP = no smoothing (raw triangle-edge);
 *  FAST/MID/SLOW = increasing half-life. Goes through the regular
 *  command queue so host + every connected client run with the same
 *  effective EMA, just like setTickRate / setSnapshotRate. */
export type SetUnitGroundNormalEmaModeCommand = BaseCommand & {
  type: 'setUnitGroundNormalEmaMode';
  mode: UnitGroundNormalEmaMode;
};

export type SetSendGridInfoCommand = BaseCommand & {
  type: 'setSendGridInfo';
  enabled: boolean;
};

export type SetBackgroundUnitBlueprintEnabledCommand = BaseCommand & {
  type: 'setBackgroundUnitBlueprintEnabled';
  unitBlueprintId: string;
  enabled: boolean;
};

export type SetMaxTotalUnitsCommand = BaseCommand & {
  type: 'setMaxTotalUnits';
  maxTotalUnits: number;
};

export type SetTurretForceFieldPanelsEnabledCommand = BaseCommand & {
  type: 'setTurretForceFieldPanelsEnabled';
  enabled: boolean;
};

export type SetTurretForceFieldSpheresEnabledCommand = BaseCommand & {
  type: 'setTurretForceFieldSpheresEnabled';
  enabled: boolean;
};

export type SetForceFieldsObstructSightCommand = BaseCommand & {
  type: 'setForceFieldsObstructSight';
  enabled: boolean;
};

export type SetForceFieldReflectionModeCommand = BaseCommand & {
  type: 'setForceFieldReflectionMode';
  mode: ForceFieldReflectionMode;
};

export type SetFogOfWarEnabledCommand = BaseCommand & {
  type: 'setFogOfWarEnabled';
  enabled: boolean;
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
  | ClearSelectionCommand
  | PingCommand
  | ScanCommand
  | StartBuildCommand
  | QueueUnitCommand
  | CancelQueueItemCommand
  | SetRallyPointCommand
  | SetFactoryWaypointsCommand
  | FireDGunCommand
  | SetFireEnabledCommand
  | SetBuildingActiveCommand
  | SelfDestructCommand
  | SetTowerTargetCommand
  | RepairCommand
  | RepairAreaCommand
  | ReclaimCommand
  | WaitCommand
  | AttackCommand
  | AttackGroundCommand
  | AttackAreaCommand
  | GuardCommand
  | SetSnapshotRateCommand
  | SetKeyframeRatioCommand
  | SetTickRateCommand
  | SetUnitGroundNormalEmaModeCommand
  | SetSendGridInfoCommand
  | SetBackgroundUnitBlueprintEnabledCommand
  | SetMaxTotalUnitsCommand
  | SetTurretForceFieldPanelsEnabledCommand
  | SetTurretForceFieldSpheresEnabledCommand
  | SetForceFieldsObstructSightCommand
  | SetForceFieldReflectionModeCommand
  | SetFogOfWarEnabledCommand
  | SetConverterTaxCommand;
