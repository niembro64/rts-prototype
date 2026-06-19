import type { BuildingBlueprintId } from './buildingTypes';
import type { EntityId } from './entityTypes';

// Waypoint types for unit movement.
export type WaypointType = 'move' | 'fight' | 'patrol';

// Action types for unified action queue.
export type ActionType =
  | 'move'
  | 'fight'
  | 'patrol'
  | 'build'
  | 'repair'
  | 'reclaim'
  | 'capture'
  | 'resurrect'
  | 'wait'
  | 'attack'
  | 'attackGround'
  | 'guard'
  | 'loadTransport'
  | 'unloadTransport';

export type UnitAction = {
  type: ActionType;
  x: number;
  y: number;
  z?: number;
  /** Per-action force scalar in (0, 1], used by preserved-formation
   *  moves to keep faster units at the slowest selected unit's pace. */
  speedLimitFactor?: number;
  buildingBlueprintId?: BuildingBlueprintId;
  gridX?: number;
  gridY?: number;
  buildingId?: EntityId;
  targetId?: EntityId;
  isPathExpansion?: boolean;
  waitGather?: boolean;
  waitGroupId?: number;
};

export type UnitPathPoint = {
  x: number;
  y: number;
  z?: number;
};

export type UnitPathPlan = {
  points: UnitPathPoint[];
  index: number;
  actionHash: number;
  terrainVersion: number;
  buildingGridVersion: number;
  goalX: number;
  goalY: number;
  goalZ?: number;
  actionType: ActionType;
  targetId?: EntityId;
  buildingId?: EntityId;
};
