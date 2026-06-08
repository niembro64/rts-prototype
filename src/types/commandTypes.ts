import type { BuildingBlueprintId } from './buildingTypes';
import type { EntityId } from './entityTypes';

// Waypoint types for unit movement.
export type WaypointType = 'move' | 'fight' | 'patrol';

// Single waypoint in a unit's path queue. Altitude (`z`) is optional.
export type Waypoint = {
  x: number;
  y: number;
  z?: number;
  type: WaypointType;
};

// Action types for unified action queue.
export type ActionType =
  | 'move'
  | 'fight'
  | 'patrol'
  | 'build'
  | 'repair'
  | 'reclaim'
  | 'wait'
  | 'attack'
  | 'attackGround'
  | 'guard';

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
