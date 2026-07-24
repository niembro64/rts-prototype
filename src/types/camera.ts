export type CameraAnchorScreen = 'cursor' | 'screen-center';

/** Camera anchors resolve only against the terrain bed. Water is a rendered
 * surface, not a camera input surface. */
export type CameraAnchorTerrain = 'plane-2d' | 'terrain-3d';

export type CameraAnchor = {
  readonly screen: CameraAnchorScreen;
  readonly terrain: CameraAnchorTerrain;
};

export type CameraMovementScaleMode =
  /** Recoil SpringController parity: distance-relative wheel law, controller-
   * distance pan rate, focus-on-terrain tracking, and BAR's cursor-in /
   * center-out zoom edge handling. Cardinal yaw locking is configured
   * separately. */
  | 'bar-spring'
  | 'anchor-distance-relative'
  | 'absolute-world'
  | 'absolute-world-momentum';

export type CameraWheelInputMode =
  /** Treat each browser wheel event from a notched wheel as one BAR/SDL wheel
   * unit (removes OS/browser acceleration). Continuous devices (trackpads,
   * free-spin wheels) are detected per event and keep fractional pixel
   * conversion so an inertial two-finger fling cannot become dozens of full
   * notches. */
  | 'bar-discrete-event'
  /** Preserve the previous raw DOM delta conversion for continuous devices. */
  | 'dom-continuous-delta';

/** How the battle camera's focus altitude behaves while moving.
 *
 *  - 'terrain-follow'     — BAR SpringController parity: the focus is glued to
 *                           the terrain bed plus a persistent elevation offset,
 *                           so panning over hills raises and lowers the camera
 *                           with the ground.
 *  - 'constant-altitude'  — the focus keeps its world height through pan,
 *                           orbit, and follow. Altitude changes only through
 *                           explicit height-pan, zoom translation toward the
 *                           anchor, and terrain-collision lift. Terrain acts as
 *                           a floor, never as a rail the camera rides. */
export type CameraFocusHeightMode = 'terrain-follow' | 'constant-altitude';

/** Rendered-camera transition applied after controller state changes. */
export type CameraTransitionMode =
  | 'bar-spring-dampened'
  | 'ema';

/** Select which controller changes receive the configured render transition. */
export type CameraTransitionScope =
  /** Preserve the previous behavior: pan, rotate, follow, and zoom all ease. */
  | 'all-movements'
  /** Ease discrete zoom changes; apply continuous camera controls immediately. */
  | 'zoom-only';

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
  readonly wheelInputMode: CameraWheelInputMode;
  /** Focus-altitude policy for bar-spring movement. 'constant-altitude' is
   * the canonical Budget Annihilation mode; 'terrain-follow' retains BAR's
   * bed-glued focus for comparison. */
  readonly focusHeightMode: CameraFocusHeightMode;
  /** Apply BAR's cardinal-direction yaw dead zones in bar-spring mode. */
  readonly cardinalYawLockEnabled: boolean;
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

export type CameraZoomDistanceSamplingMode = 'single' | 'nine' | 'seventeen';
/** How a configured zoom-sample neighborhood becomes one camera-distance
 *  scalar.
 *
 *  - 'min'     — nearest sample wins outright. Locks onto a peak beside the
 *                cursor, but a single spurious near sample (one foreground
 *                bump clipped by the ring) hijacks the whole zoom.
 *  - 'average' — mean of every sample. Smooth, but a silhouette
 *                neighborhood is bimodal (peak + valley behind) and the
 *                mean lands mid-air between the two surfaces.
 *  - 'average-of-shortest-N' (3 / 5 / 8) — mean of only the N nearest
 *                samples: stays on the near surface like 'min' while no
 *                single sample can dictate the depth. Lower N behaves more
 *                like 'min', higher N more like 'average'. */
export type CameraZoomDistanceAggregation =
  | 'min'
  | 'average'
  | 'average-of-shortest-3'
  | 'average-of-shortest-5'
  | 'average-of-shortest-8';

/** Screen-space terrain neighborhood sampled by relative camera zoom.
 *  The center anchor plus zero, one, or two configured rings resolve surface
 *  points whose camera distances are reduced to one configured scalar before
 *  zoom is applied. */
export type CameraZoomDistanceSamplingConfig = {
  /** single = center only; nine = center + inner ring; seventeen = center +
   *  inner and outer rings. */
  readonly pointMode: CameraZoomDistanceSamplingMode;
  /** Reduction from the sampled neighborhood to one depth scalar — see
   *  CameraZoomDistanceAggregation for each mode's trade-off. */
  readonly distanceAggregation: CameraZoomDistanceAggregation;
  /** Number of evenly spaced rays on each ring. Eight produces 9 samples
   *  with one ring or 17 with two. */
  readonly ringPointCount: number;
  readonly innerRadiusPixels: number;
  readonly outerRadiusPixels: number;
  /** Keep at least this fraction of the center anchor distance after one
   *  zoom-in event, even if nearby terrain depths are extremely different. */
  readonly minCenterDistanceFraction: number;
  readonly debugPointSizePixels: number;
  readonly debugVisibleMilliseconds: number;
  readonly debugCenterColor: string;
  readonly debugInnerColor: string;
  readonly debugOuterColor: string;
  /** Highlight color for the point selected by min aggregation. */
  readonly debugSelectedColor: string;
};

export type CameraZoomInLimitMode = 'none' | 'zoom-max';

export type CameraTargetBoundsMode = 'none' | 'map-padding';

export type CameraConstraintConfig = {
  /** 'zoom-max' enables the configured closest orbit-distance rail. */
  readonly zoomInLimit: CameraZoomInLimitMode;
  /** 'map-padding' keeps the orbit target inside the padded map region. */
  readonly targetBounds: CameraTargetBoundsMode;
};

/** Automatic recovery for the exceptional case where the camera viewport no
 * longer contains any rendered map surface. */
export type CameraLostTerrainRecoveryConfig = {
  /** Turn automatic map recovery on/off without changing normal camera input. */
  readonly enabled: boolean;
  /** EMA time constant for both camera pose position and view angle while
   * returning the map origin to the viewport. */
  readonly emaTauSeconds: number;
};

/** How the orbit camera resolves a frame where the eye would sit below
 *  terrain. Every mode keeps the camera looking at the orbit target:
 *
 *  - 'none'       — no clearance; the eye may pass under the heightfield.
 *  - 'raiseEye'   — lift only the eye's Y until it clears. Keeps the
 *                   eye's horizontal footprint and the focus centered;
 *                   the true eye→target distance grows and the view
 *                   steepens, so the eye leaves the orbit sphere.
 *  - 'clampPitch' — steepen the pitch (swing the eye up the orbit arc)
 *                   until it clears. Keeps the eye ON the orbit sphere at
 *                   the stored distance and the focus centered; only the
 *                   effective pitch diverges from the stored pitch.
 *  - 'persistRaiseEye' — translate eye and focus upward together and commit
 *                   that translation as ordinary state. It never lowers the
 *                   camera later and stores no pre-collision recovery pose. */
export type CameraTerrainCollisionMode =
  | 'none'
  | 'raiseEye'
  | 'clampPitch'
  | 'persistRaiseEye';
