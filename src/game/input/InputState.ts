// NOTE — InputState is the 2D (Pixi) input path's shared mutable state.
// The 3D (Three.js) path does NOT read or write this struct; Input3DManager
// keeps its own local fields (leftDown, dragStartScreen, rightDown, …) that
// live only while the 3D renderer is active.
//
// Fields here that are only meaningful to the 2D path (isDraggingSelection,
// isPanningCamera, isRotatingCamera, line-path flags, build-ghost flags) are
// therefore 2D-exclusive by design. A live 2D↔3D renderer swap rebuilds the
// scene + InputManager from scratch, so any in-flight drag / pan state
// drops on the swap — the user has to release the mouse and try again.
// That's accepted; don't try to serialize this across renderers.
//
// The cross-renderer selection/build/D-gun modes that DO need to survive a
// swap live on the scene (`currentWaypointMode`, `currentBuildType`, …)
// and on the SelectionPanel's computed UIInputState, not here.
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
