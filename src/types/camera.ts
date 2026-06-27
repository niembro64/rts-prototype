export type CameraAnchorScreen = 'cursor' | 'screen-center';

export type CameraAnchorTerrain = 'plane-2d' | 'terrain-3d' | 'terrain-3d-water';

export type CameraAnchor = {
  readonly screen: CameraAnchorScreen;
  readonly terrain: CameraAnchorTerrain;
};

export type CameraMovementScaleMode =
  | 'anchor-distance-relative'
  | 'absolute-world'
  | 'absolute-world-momentum';

export type CameraInputMomentumConfig = {
  /** false = no velocity gain; the gesture always uses gain 1. */
  readonly enabled: boolean;
  readonly minGain: number;
  readonly maxGain: number;
  /** Pixels/sec for mouse gestures, wheel-delta/sec for wheel gestures. */
  readonly velocityForMaxGain: number;
  readonly curve: number;
};

export type CameraPanMovementConfig = {
  readonly absoluteWorldUnitsPerPixel: number;
  readonly momentum: CameraInputMomentumConfig;
};

export type CameraZoomMovementConfig = {
  readonly absoluteWorldUnitsPerWheelTick: number;
  readonly momentum: CameraInputMomentumConfig;
};

export type CameraOrbitMovementConfig = {
  readonly radiansPerPixel: number;
  readonly momentum: CameraInputMomentumConfig;
};

export type CameraMovementConfig = {
  readonly scaleMode: CameraMovementScaleMode;
  /** Middle-click drag pan. */
  readonly centerClickPan: CameraPanMovementConfig;
  /** Wheel zoom-in. */
  readonly zoomIn: CameraZoomMovementConfig;
  /** Wheel zoom-out. */
  readonly zoomOut: CameraZoomMovementConfig;
  /** Alt + middle-click orbit/tumble. */
  readonly altCenterClickOrbit: CameraOrbitMovementConfig;
  /** Ctrl + middle-click horizontal + vertical pan. */
  readonly ctrlCenterClickHeightPan: CameraPanMovementConfig;
};

export type CameraZoomInLimitMode = 'none' | 'zoom-max';

export type CameraTargetBoundsMode = 'none' | 'map-padding';

export type CameraConstraintConfig = {
  /** 'zoom-max' derives the closest orbit distance from zoom.max. */
  readonly zoomInLimit: CameraZoomInLimitMode;
  /** 'map-padding' keeps the orbit target inside the padded map region. */
  readonly targetBounds: CameraTargetBoundsMode;
};

/** How the orbit camera resolves a frame where the eye would sit below
 *  terrain. Every mode keeps the camera looking at the orbit target, and
 *  NONE of them write terrain back into the orbit state (so zoom limits
 *  stay absolute and history-independent). They differ only in which
 *  rendered quantity absorbs the clearance:
 *
 *  - 'none'       — no clearance; the eye may pass under the heightfield.
 *  - 'raiseEye'   — lift only the eye's Y until it clears. Keeps the
 *                   eye's horizontal footprint and the focus centered;
 *                   the true eye→target distance grows and the view
 *                   steepens, so the eye leaves the orbit sphere.
 *  - 'clampPitch' — steepen the pitch (swing the eye up the orbit arc)
 *                   until it clears. Keeps the eye ON the orbit sphere at
 *                   the stored distance and the focus centered; only the
 *                   effective pitch diverges from the stored pitch. */
export type CameraTerrainCollisionMode = 'none' | 'raiseEye' | 'clampPitch';
