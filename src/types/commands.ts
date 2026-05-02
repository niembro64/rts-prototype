// Command types extracted from game/sim/commands.ts

import type { EntityId, WaypointType, BuildingType } from './sim';

export type CommandType =
  | 'select'
  | 'move'
  | 'clearSelection'
  | 'startBuild'
  | 'queueUnit'
  | 'cancelQueueItem'
  | 'setRallyPoint'
  | 'setFactoryWaypoints'
  | 'fireDGun'
  | 'repair'
  | 'attack'
  | 'setSnapshotRate'
  | 'setKeyframeRatio'
  | 'setTickRate'
  | 'setSendGridInfo'
  | 'setBackgroundUnitType'
  | 'setMaxTotalUnits'
  | 'setFfAccelUnits'
  | 'setFfAccelShots'
  | 'setMirrorsEnabled'
  | 'setForceFieldsEnabled'
  | 'setSimQuality'
  | 'setSimSignalStates';

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

export type ClearSelectionCommand = BaseCommand & {
  type: 'clearSelection';
};

export type StartBuildCommand = BaseCommand & {
  type: 'startBuild';
  builderId: EntityId;
  buildingType: BuildingType;
  gridX: number;
  gridY: number;
  queue: boolean;
};

export type QueueUnitCommand = BaseCommand & {
  type: 'queueUnit';
  factoryId: EntityId;
  unitId: string;
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

export type RepairCommand = BaseCommand & {
  type: 'repair';
  commanderId: EntityId;
  targetId: EntityId;
  queue: boolean;
};

export type AttackCommand = BaseCommand & {
  type: 'attack';
  entityIds: EntityId[];
  targetId: EntityId;
  queue: boolean;
};

export type SetSnapshotRateCommand = BaseCommand & {
  type: 'setSnapshotRate';
  rate: number | 'none';
};

export type SetKeyframeRatioCommand = BaseCommand & {
  type: 'setKeyframeRatio';
  ratio: number | 'ALL' | 'NONE';
};

export type SetTickRateCommand = BaseCommand & {
  type: 'setTickRate';
  rate: number;
};

export type SetSendGridInfoCommand = BaseCommand & {
  type: 'setSendGridInfo';
  enabled: boolean;
};

export type SetBackgroundUnitTypeCommand = BaseCommand & {
  type: 'setBackgroundUnitType';
  unitType: string;
  enabled: boolean;
};

export type SetMaxTotalUnitsCommand = BaseCommand & {
  type: 'setMaxTotalUnits';
  maxTotalUnits: number;
};

export type SetFfAccelUnitsCommand = BaseCommand & {
  type: 'setFfAccelUnits';
  enabled: boolean;
};

export type SetFfAccelShotsCommand = BaseCommand & {
  type: 'setFfAccelShots';
  enabled: boolean;
};

export type SetMirrorsEnabledCommand = BaseCommand & {
  type: 'setMirrorsEnabled';
  enabled: boolean;
};

export type SetForceFieldsEnabledCommand = BaseCommand & {
  type: 'setForceFieldsEnabled';
  enabled: boolean;
};

export type SetSimQualityCommand = BaseCommand & {
  type: 'setSimQuality';
  // Stored as the raw string union — keeps the wire format simple
  // and lets msgpack delta-encode by reference.
  quality: string;
};

export type SetSimSignalStatesCommand = BaseCommand & {
  type: 'setSimSignalStates';
  // Each field is one of 'off' | 'active' | 'solo'. Sent whenever
  // the host client cycles a signal's state.
  tps?: string;
  cpu?: string;
  units?: string;
};

export type Command =
  | SelectCommand
  | MoveCommand
  | ClearSelectionCommand
  | StartBuildCommand
  | QueueUnitCommand
  | CancelQueueItemCommand
  | SetRallyPointCommand
  | SetFactoryWaypointsCommand
  | FireDGunCommand
  | RepairCommand
  | AttackCommand
  | SetSnapshotRateCommand
  | SetKeyframeRatioCommand
  | SetTickRateCommand
  | SetSendGridInfoCommand
  | SetBackgroundUnitTypeCommand
  | SetMaxTotalUnitsCommand
  | SetFfAccelUnitsCommand
  | SetFfAccelShotsCommand
  | SetMirrorsEnabledCommand
  | SetForceFieldsEnabledCommand
  | SetSimQualityCommand
  | SetSimSignalStatesCommand;
