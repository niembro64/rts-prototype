// Command types extracted from game/sim/commands.ts

import type { EntityId, WaypointType, BuildingType, PlayerId } from './sim';
import type { RenderMode } from './graphics';

export type CommandType =
  | 'select'
  | 'move'
  | 'stop'
  | 'clearSelection'
  | 'startBuild'
  | 'queueUnit'
  | 'cancelQueueItem'
  | 'setRallyPoint'
  | 'setFactoryWaypoints'
  | 'fireDGun'
  | 'setJumpEnabled'
  | 'setFireEnabled'
  | 'repair'
  | 'repairArea'
  | 'attack'
  | 'attackArea'
  | 'guard'
  | 'setSnapshotRate'
  | 'setKeyframeRatio'
  | 'setTickRate'
  | 'setTiltEmaMode'
  | 'setSendGridInfo'
  | 'setBackgroundUnitType'
  | 'setMaxTotalUnits'
  | 'setMirrorsEnabled'
  | 'setForceFieldsEnabled'
  | 'setSimQuality'
  | 'setSimSignalStates'
  | 'setCameraAoi';

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

export type SetJumpEnabledCommand = BaseCommand & {
  type: 'setJumpEnabled';
  entityIds: EntityId[];
  enabled: boolean;
};

export type SetFireEnabledCommand = BaseCommand & {
  type: 'setFireEnabled';
  entityIds: EntityId[];
  enabled: boolean;
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

export type AttackCommand = BaseCommand & {
  type: 'attack';
  entityIds: EntityId[];
  targetId: EntityId;
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

/** Pick the smoothing strength for the per-unit chassis-tilt EMA
 *  (see updateUnitTilt). SNAP = no smoothing (raw triangle-jump);
 *  FAST/MID/SLOW = increasing half-life. Goes through the regular
 *  command queue so host + every connected client run with the same
 *  effective EMA, just like setTickRate / setSnapshotRate. */
export type SetTiltEmaModeCommand = BaseCommand & {
  type: 'setTiltEmaMode';
  mode: 'snap' | 'fast' | 'mid' | 'slow';
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

export type CameraAoiPoint = { x: number; y: number };

export type CameraAoiBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

export type SetCameraAoiCommand = BaseCommand & {
  type: 'setCameraAoi';
  mode: RenderMode;
  playerId?: PlayerId;
  quad?: readonly [CameraAoiPoint, CameraAoiPoint, CameraAoiPoint, CameraAoiPoint];
  bounds?: CameraAoiBounds;
};

export type Command =
  | SelectCommand
  | MoveCommand
  | StopCommand
  | ClearSelectionCommand
  | StartBuildCommand
  | QueueUnitCommand
  | CancelQueueItemCommand
  | SetRallyPointCommand
  | SetFactoryWaypointsCommand
  | FireDGunCommand
  | SetJumpEnabledCommand
  | SetFireEnabledCommand
  | RepairCommand
  | RepairAreaCommand
  | AttackCommand
  | AttackAreaCommand
  | GuardCommand
  | SetSnapshotRateCommand
  | SetKeyframeRatioCommand
  | SetTickRateCommand
  | SetTiltEmaModeCommand
  | SetSendGridInfoCommand
  | SetBackgroundUnitTypeCommand
  | SetMaxTotalUnitsCommand
  | SetMirrorsEnabledCommand
  | SetForceFieldsEnabledCommand
  | SetSimQualityCommand
  | SetSimSignalStatesCommand
  | SetCameraAoiCommand;
