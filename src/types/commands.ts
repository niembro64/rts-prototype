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
  | 'setProjVelInherit'
  | 'setFfAccelUnits'
  | 'setFfAccelShots';

export type BaseCommand = {
  type: CommandType;
  tick: number;
};

export type SelectCommand = BaseCommand & {
  type: 'select';
  entityIds: EntityId[];
  additive: boolean;
};

export type WaypointTarget = {
  x: number;
  y: number;
};

export type MoveCommand = BaseCommand & {
  type: 'move';
  entityIds: EntityId[];
  targetX?: number;
  targetY?: number;
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

export type SetProjVelInheritCommand = BaseCommand & {
  type: 'setProjVelInherit';
  enabled: boolean;
};

export type SetFfAccelUnitsCommand = BaseCommand & {
  type: 'setFfAccelUnits';
  enabled: boolean;
};

export type SetFfAccelShotsCommand = BaseCommand & {
  type: 'setFfAccelShots';
  enabled: boolean;
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
  | SetProjVelInheritCommand
  | SetFfAccelUnitsCommand
  | SetFfAccelShotsCommand;
