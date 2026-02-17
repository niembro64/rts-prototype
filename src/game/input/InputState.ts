import type { EntityId, WaypointType, BuildingType } from '../sim/types';
import type { WorldPoint } from './helpers';

/**
 * InputState - Shared mutable state for all input controllers.
 * Owned by InputManager, passed by reference to controllers.
 */
export interface InputState {
  isDraggingSelection: boolean;
  // Selection stored in WORLD coordinates (not screen)
  selectionStartWorldX: number;
  selectionStartWorldY: number;
  selectionEndWorldX: number;
  selectionEndWorldY: number;
  isPanningCamera: boolean;
  panStartX: number;
  panStartY: number;
  cameraStartX: number;
  cameraStartY: number;
  // Line move state
  isDrawingLinePath: boolean;
  linePathPoints: WorldPoint[];
  linePathTargets: WorldPoint[]; // Calculated positions for each unit
  // Waypoint mode
  waypointMode: WaypointType;
  // Track previous selection to detect changes
  previousSelectedIds: Set<EntityId>;
  // Building placement mode
  isBuildMode: boolean;
  selectedBuildingType: BuildingType | null;
  buildGhostX: number;
  buildGhostY: number;
  canPlaceBuilding: boolean;
  // D-gun mode
  isDGunMode: boolean;
}

export function createInitialInputState(): InputState {
  return {
    isDraggingSelection: false,
    selectionStartWorldX: 0,
    selectionStartWorldY: 0,
    selectionEndWorldX: 0,
    selectionEndWorldY: 0,
    isPanningCamera: false,
    panStartX: 0,
    panStartY: 0,
    cameraStartX: 0,
    cameraStartY: 0,
    isDrawingLinePath: false,
    linePathPoints: [],
    linePathTargets: [],
    waypointMode: 'move',
    previousSelectedIds: new Set(),
    isBuildMode: false,
    selectedBuildingType: null,
    buildGhostX: 0,
    buildGhostY: 0,
    canPlaceBuilding: false,
    isDGunMode: false,
  };
}
