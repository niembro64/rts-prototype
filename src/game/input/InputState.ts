export type { InputState } from '@/types/input';
import type { InputState } from '@/types/input';

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
    isRotatingCamera: false,
    rotStartX: 0,
    rotStartY: 0,
    rotStartAngle: 0,
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
