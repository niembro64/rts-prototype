export type { InputState } from '@/types/input';
import type { InputState } from '@/types/input';

export function createInitialInputState(): InputState {
  return {
    isDraggingSelection: false,
    selectionStartScreenX: 0,
    selectionStartScreenY: 0,
    selectionEndScreenX: 0,
    selectionEndScreenY: 0,
    isPanningCamera: false,
    panStartX: 0,
    panStartY: 0,
    cameraStartX: 0,
    cameraStartY: 0,
    isRotatingCamera: false,
    rotStartX: 0,
    rotStartY: 0,
    rotStartAngle: 0,
    isDrawingLinePath: false,
    waypointMode: 'move',
    isBuildMode: false,
    selectedBuildingType: null,
    buildGhostX: 0,
    buildGhostY: 0,
    canPlaceBuilding: false,
    isDGunMode: false,
  };
}
