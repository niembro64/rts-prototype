// Command types extracted from game/sim/commands.ts

import type { EntityId, WaypointType, BuildingBlueprintId, PlayerId, UnitMoveState, CombatTrajectoryMode } from './sim';
import type { KeyframeRatio, SnapshotRate, TickRate } from './server';
import type { ShieldReflectionMode } from './shotTypes';
import type { UnitGroundNormalEmaMode } from '../shellConfig';

export type CommandType =
  | 'select'
  | 'move'
  | 'stop'
  | 'clearQueuedOrders'
  | 'removeLastQueuedOrder'
  | 'skipCurrentOrder'
  | 'setRepeatQueue'
  | 'setUnitMoveState'
  | 'setTrajectoryMode'
  | 'clearSelection'
  | 'ping'
  | 'scan'
  | 'startBuild'
  | 'queueUnit'
  | 'editFactoryQueue'
  | 'stopFactoryProduction'
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
  | 'wait'
  | 'attack'
  | 'attackGround'
  | 'attackArea'
  | 'guard'
  | 'setSnapshotRate'
  | 'setKeyframeRatio'
  | 'setTickRate'
  | 'setPaused'
  | 'setUnitGroundNormalEmaMode'
  | 'setSendGridInfo'
  | 'setBackgroundUnitBlueprintEnabled'
  | 'setMaxTotalUnits'
  | 'setTurretShieldPanelsEnabled'
  | 'setTurretShieldSpheresEnabled'
  | 'setShieldsObstructSight'
  | 'setShieldReflectionMode'
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

export type SetUnitMoveStateCommand = BaseCommand & {
  type: 'setUnitMoveState';
  entityIds: EntityId[];
  moveState: UnitMoveState;
};

export type SetTrajectoryModeCommand = BaseCommand & {
  type: 'setTrajectoryMode';
  entityIds: EntityId[];
  trajectoryMode: CombatTrajectoryMode;
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

export type StopFactoryProductionCommand = BaseCommand & {
  type: 'stopFactoryProduction';
  factoryId: EntityId;
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

/** Set (or clear) a combat entity's host-level lock-on target. Writes
 *  CombatComponent.priorityTargetId directly; host-directed turrets
 *  inherit the target through the normal acquisition flow, gated by
 *  their own exclusion masks. `targetId === null` clears the lock-on
 *  and the entity reverts to autonomous acquisition. */
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
  queueFront?: boolean;
  queueInsertIndex?: number;
};

export type RepairAreaCommand = BaseCommand & {
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

export type ReclaimAreaCommand = BaseCommand & {
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

export type WaitCommand = BaseCommand & {
  type: 'wait';
  entityIds: EntityId[];
  queue: boolean;
  queueFront?: boolean;
  queueInsertIndex?: number;
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

export type SetPausedCommand = BaseCommand & {
  type: 'setPaused';
  paused: boolean;
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

export type SetShieldReflectionModeCommand = BaseCommand & {
  type: 'setShieldReflectionMode';
  mode: ShieldReflectionMode;
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
  | SkipCurrentOrderCommand
  | SetRepeatQueueCommand
  | SetUnitMoveStateCommand
  | SetTrajectoryModeCommand
  | ClearSelectionCommand
  | PingCommand
  | ScanCommand
  | StartBuildCommand
  | QueueUnitCommand
  | EditFactoryQueueCommand
  | StopFactoryProductionCommand
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
  | WaitCommand
  | AttackCommand
  | AttackGroundCommand
  | AttackAreaCommand
  | GuardCommand
  | SetSnapshotRateCommand
  | SetKeyframeRatioCommand
  | SetTickRateCommand
  | SetPausedCommand
  | SetUnitGroundNormalEmaModeCommand
  | SetSendGridInfoCommand
  | SetBackgroundUnitBlueprintEnabledCommand
  | SetMaxTotalUnitsCommand
  | SetTurretShieldPanelsEnabledCommand
  | SetTurretShieldSpheresEnabledCommand
  | SetShieldsObstructSightCommand
  | SetShieldReflectionModeCommand
  | SetFogOfWarEnabledCommand
  | SetConverterTaxCommand;
