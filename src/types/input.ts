// Input system types extracted from game/input/ files

import type { Entity, EntityId, PlayerId, WaypointType, BuildingType } from './sim';

// Point in world space (sim coords). `z` is the altitude of the
// rendered 3D ground at this XY (from CursorGround.pickSim) and is
// optional — 2D-only callers and synthetic interior points (path
// distribution interpolations) can omit it; renderers fall back to a
// terrain sample when missing.
export type WorldPoint = {
  x: number;
  y: number;
  z?: number;
};

// Entity source for input detection
export type InputEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
  getEntity(id: EntityId): Entity | undefined;
  getAllEntities(): Entity[];
};

// Provides tick and player info
export type InputContext = {
  getTick(): number;
  activePlayerId: PlayerId;
};

// Shared mutable state for all input controllers
export type InputState = {
  isDraggingSelection: boolean;
  /** Selection drag is tracked in **screen** pixels (not world), so
   *  rotation + zoom don't warp the drag rect and projecting each
   *  entity to screen space makes the containment test trivial. */
  selectionStartScreenX: number;
  selectionStartScreenY: number;
  selectionEndScreenX: number;
  selectionEndScreenY: number;
  isPanningCamera: boolean;
  panStartX: number;
  panStartY: number;
  cameraStartX: number;
  cameraStartY: number;
  /** Alt + middle-drag rotates the 2D camera around the viewport center
   *  (mirrors the 3D orbit's yaw drag). rotStartX/Y are screen-space
   *  pixel coords at drag start; rotStartAngle is the camera's
   *  rotation at drag start — delta (screen x) * rotateSpeed yields
   *  the new rotation, so the view feels "grabbed and spun". */
  isRotatingCamera: boolean;
  rotStartX: number;
  rotStartY: number;
  rotStartAngle: number;
  /** True while the right mouse button is drawing a line-path /
   *  factory-waypoint. The points and target list themselves live in
   *  the shared LinePathAccumulator owned by the command handler;
   *  this flag is only a lightweight signal for peer controllers
   *  (edge-scroll / pan-arrow) to suppress their own input. */
  isDrawingLinePath: boolean;
  waypointMode: WaypointType;
  isBuildMode: boolean;
  selectedBuildingType: BuildingType | null;
  buildGhostX: number;
  buildGhostY: number;
  canPlaceBuilding: boolean;
  isDGunMode: boolean;
};

// Entity source for selection queries
export type SelectionEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
};

// Entity source for repair target queries
export type RepairEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
};

// Entity source for attack target queries
export type AttackEntitySource = {
  getUnits(): Entity[];
  getBuildings(): Entity[];
};
