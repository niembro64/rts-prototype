// Command types extracted from game/sim/commands.ts

import type { BuildingType } from './buildingTypes';
import type { WaypointType } from './commandTypes';
import type { EntityId, PlayerId } from './entityTypes';
import type { ForceFieldReflectionMode } from './shotTypes';

export const COMMAND_SCHEMA_VERSION = 1 as const;

// Keep command wire types independent of runtime config modules.
export type SnapshotRate = number | 'none';
export type KeyframeRatio = number | 'ALL' | 'NONE';
export type TickRate = number;
export type UnitGroundNormalEmaMode = 'snap' | 'fast' | 'mid' | 'slow';

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
  | 'setBackgroundUnitType'
  | 'setMaxTotalUnits'
  | 'setMirrorsEnabled'
  | 'setForceFieldsEnabled'
  | 'setForceFieldsObstructSight'
  | 'setForceFieldReflectionMode'
  | 'setFogOfWarEnabled'
  | 'setConverterTax';

export const COMMAND_TYPE_IDS = {
  select: 0,
  move: 1,
  stop: 2,
  clearQueuedOrders: 3,
  removeLastQueuedOrder: 4,
  clearSelection: 5,
  ping: 6,
  scan: 7,
  startBuild: 8,
  queueUnit: 9,
  cancelQueueItem: 10,
  setRallyPoint: 11,
  setFactoryWaypoints: 12,
  fireDGun: 13,
  setFireEnabled: 14,
  repair: 15,
  repairArea: 16,
  reclaim: 17,
  wait: 18,
  attack: 19,
  attackGround: 20,
  attackArea: 21,
  guard: 22,
  setSnapshotRate: 23,
  setKeyframeRatio: 24,
  setTickRate: 25,
  setUnitGroundNormalEmaMode: 26,
  setSendGridInfo: 27,
  setBackgroundUnitType: 28,
  setMaxTotalUnits: 29,
  setMirrorsEnabled: 30,
  setForceFieldsEnabled: 31,
  setForceFieldsObstructSight: 32,
  setForceFieldReflectionMode: 33,
  setFogOfWarEnabled: 34,
  setConverterTax: 35,
} as const satisfies Record<CommandType, number>;

export type CommandTypeId = typeof COMMAND_TYPE_IDS[CommandType];

export const COMMAND_TYPES_BY_ID = [
  'select',
  'move',
  'stop',
  'clearQueuedOrders',
  'removeLastQueuedOrder',
  'clearSelection',
  'ping',
  'scan',
  'startBuild',
  'queueUnit',
  'cancelQueueItem',
  'setRallyPoint',
  'setFactoryWaypoints',
  'fireDGun',
  'setFireEnabled',
  'repair',
  'repairArea',
  'reclaim',
  'wait',
  'attack',
  'attackGround',
  'attackArea',
  'guard',
  'setSnapshotRate',
  'setKeyframeRatio',
  'setTickRate',
  'setUnitGroundNormalEmaMode',
  'setSendGridInfo',
  'setBackgroundUnitType',
  'setMaxTotalUnits',
  'setMirrorsEnabled',
  'setForceFieldsEnabled',
  'setForceFieldsObstructSight',
  'setForceFieldReflectionMode',
  'setFogOfWarEnabled',
  'setConverterTax',
] as const satisfies readonly CommandType[];

export function commandTypeToId(type: CommandType): CommandTypeId {
  return COMMAND_TYPE_IDS[type];
}

export function commandTypeFromId(id: number): CommandType | null {
  return COMMAND_TYPES_BY_ID[id] ?? null;
}

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
  | SetBackgroundUnitTypeCommand
  | SetMaxTotalUnitsCommand
  | SetMirrorsEnabledCommand
  | SetForceFieldsEnabledCommand
  | SetForceFieldsObstructSightCommand
  | SetForceFieldReflectionModeCommand
  | SetFogOfWarEnabledCommand
  | SetConverterTaxCommand;

export type CommandBundle = {
  schemaVersion: typeof COMMAND_SCHEMA_VERSION;
  targetTick: number;
  peerId: PlayerId;
  seq: number;
  commands: Command[];
};
