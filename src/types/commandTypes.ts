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
  | 'wait'
  | 'selfDestruct'
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
  /** Sim-authored BAR Guard retaliation provenance. An Attack carrying this
   *  field was temporarily inserted ahead of the matching Guard and must
   *  return to that Guard without participating in Repeat rotation. */
  guardReturnTargetId?: EntityId;
  isPathExpansion?: boolean;
  /** Sim-local marker for a final move/fight command whose destination has
   *  been reached. The waypoint remains durable so displacement can rearm it. */
  movementAnchorSatisfied?: boolean;
  waitGather?: boolean;
  waitGroupId?: number;
  /** Sim-local formation route metadata. These fields are intentionally
   *  omitted from network action serialization; clients only need the
   *  authored waypoint while the server sim uses them to share one
   *  initial path corridor across a group move. */
  formationRouteStartX?: number;
  formationRouteStartY?: number;
  formationRouteGoalX?: number;
  formationRouteGoalY?: number;
  formationRouteOffsetX?: number;
  formationRouteOffsetY?: number;
  formationRouteRadius?: number;
};

export type UnitPathPoint = {
  x: number;
  y: number;
  z?: number;
};

export type UnitPathPlan = {
  points: UnitPathPoint[];
  /** How the planner resolved the requested endpoint. COMPLETE reaches the
   *  authored goal; SNAPPED reaches a nearby legal goal; PARTIAL reaches the
   *  closest discovered point; UNREACHABLE is a stay-put result. */
  resolution: 'complete' | 'snapped' | 'partial' | 'unreachable';
  index: number;
  actionHash: number;
  terrainVersion: number;
  /** BuildingGrid version the plan was validated against. On mismatch the
   *  remaining route is re-validated against current building occupancy and
   *  either restamped (still clear) or refreshed (now crosses a footprint). */
  buildingGridVersion: number;
  /** World tick this plan was installed. Chase drift/cooldown refresh and
   *  partial-plan retries measure plan age against this stamp. */
  plannedAtTick: number;
  goalX: number;
  goalY: number;
  goalZ?: number;
  actionType: ActionType;
  targetId?: EntityId;
  buildingId?: EntityId;
};
