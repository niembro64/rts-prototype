// OrbitCamera — RTS-style orbit camera controller for Three.js.
//
// Controls:
//   - Scroll wheel        → zoom (dolly along view direction)
//   - Ctrl + wheel        → zoom too (macOS trackpad pinch arrives as
//                           ctrl+wheel; treating it as anything else makes
//                           pinch do surprising things)
//   - Alt + wheel         → tilt (pitch step)
//   - Alt + middle drag   → orbit (yaw + pitch)
//   - Middle drag         → pan (slide target on the world ground)
//   - Ctrl + middle drag  → height pan (left/right on ground, up/down in world height)
//   - Touch 1 finger      → pan
//   - Touch 2 fingers     → centroid pan + pinch zoom + twist rotate
//
// Architecture: every input writes controller TO-STATE. The configured
// transition can use BAR's velocity spring or the legacy EMA. Its scope can
// cover all movements, or only discrete zoom; zoom-only carries the rendered
// eye by every continuous pan/rotation delta immediately without throwing
// away any zoom transition that is still settling.
//
// Cursor pinning is 3D-accurate when a `getCursorWorldPoint` callback
// is supplied: the scene raycasts the terrain bed instead of a flat y=0
// plane, so wheel zoom anchors at the real point under the cursor. Water
// never participates in camera input. In anchor-distance-relative
// movement mode, pan drag also uses the cursor's actual world depth
// to compute world-per-pixel. In absolute-world mode, the same
// pan/orbit directions are used with fixed world-unit movement
// amounts; absolute zoom moves a fixed distance along the configured
// zoom anchor ray so cursor zoom remains directional without letting
// terrain/anchor distance amplify the camera state.

import * as THREE from 'three';
import type {
  CameraAnchor,
  CameraAnchorTerrain,
  CameraFocusHeightMode,
  CameraInputMomentumConfig,
  CameraLostTerrainRecoveryConfig,
  CameraMovementConfig,
  CameraMovementScaleMode,
  CameraTerrainCollisionMode,
  CameraTransitionMode,
  CameraTransitionScope,
  CameraWheelInputMode,
  CameraZoomDistanceAggregation,
  CameraZoomDistanceSamplingConfig,
} from '../../types/camera';

const TOUCH_ROTATE_DEADZONE_RAD = 0.006;
const TOUCH_ROTATE_MAX_DELTA_RAD = 0.35;
const KEYBOARD_CAMERA_SCREEN_STEP_PX = 48;
const KEYBOARD_CAMERA_FAST_MULTIPLIER = 2.5;
const WHEEL_MOMENTUM_RESET_MS = 240;
const WHEEL_MOMENTUM_FALLBACK_DT_MS = 120;
// Recoil's Spring camera multiplies one SDL wheel unit by ScrollWheelSpeed=25;
// its 0.007 zoom coefficient therefore produces a 0.175 distance change per
// notch. These DOM-unit scales are retained only for the configurable
// continuous-delta path. Canonical BAR discrete input ignores accelerated
// browser magnitude and maps each event to one signed controller unit.
const WHEEL_PIXELS_PER_TICK = 100;
const WHEEL_LINES_PER_TICK = 3;
const BAR_FAST_POINTER_MULTIPLIER = 4;
const BAR_FAST_WHEEL_MULTIPLIER = 2;
const BAR_TILT_RADIANS_PER_WHEEL_TICK = 0.125;
const BAR_CARDINAL_LOCK_WIDTH = 0.2;
/** Eye travel from one wheel tick may never exceed this fraction of the
 *  current controller distance. See barCameraTravelClampedZoomFactor. */
const DEFAULT_ZOOM_TRAVEL_CLAMP_FRACTION = 0.5;
/** WebKit/Blink report legacy wheelDelta in multiples of 120 for notched
 *  wheels; trackpads and free-spin wheels produce other values. */
const LEGACY_NOTCHED_WHEEL_DELTA_UNIT = 120;
/** Rate-limited "camera invariant violated" diagnostics. */
const MAX_INVARIANT_WARNINGS = 8;

const DEFAULT_ZOOM_DISTANCE_SAMPLING_CONFIG: CameraZoomDistanceSamplingConfig = {
  pointMode: 'seventeen',
  distanceAggregation: 'min',
  ringPointCount: 8,
  innerRadiusPixels: 48,
  outerRadiusPixels: 96,
  minCenterDistanceFraction: 0.1,
  debugPointSizePixels: 10,
  debugVisibleMilliseconds: 500,
  debugCenterColor: '#ffffff',
  debugInnerColor: '#00d9ff',
  debugOuterColor: '#ffb000',
  debugSelectedColor: '#ff3030',
};

const DEFAULT_CAMERA_MOVEMENT_CONFIG: CameraMovementConfig = {
  scaleMode: 'anchor-distance-relative',
  wheelInputMode: 'dom-continuous-delta',
  focusHeightMode: 'constant-altitude',
  cardinalYawLockEnabled: false,
  centerClickPan: {
    absoluteWorldUnitsPerPixel: 2,
    momentum: {
      enabled: true,
      minGain: 0.35,
      maxGain: 3,
      velocityForMaxGain: 1800,
      curve: 1.35,
    },
  },
  zoomIn: {
    absoluteWorldUnitsPerWheelTick: 120,
    momentum: {
      enabled: true,
      minGain: 0.35,
      maxGain: 6,
      velocityForMaxGain: 5000,
      curve: 1.35,
    },
  },
  zoomOut: {
    absoluteWorldUnitsPerWheelTick: 120,
    momentum: {
      enabled: true,
      minGain: 0.35,
      maxGain: 6,
      velocityForMaxGain: 5000,
      curve: 1.35,
    },
  },
  altCenterClickOrbit: {
    radiansPerPixel: 0.005,
    momentum: {
      enabled: true,
      minGain: 0.35,
      maxGain: 1.25,
      velocityForMaxGain: 1800,
      curve: 1.35,
    },
  },
  ctrlCenterClickHeightPan: {
    absoluteWorldUnitsPerPixel: 2,
    momentum: {
      enabled: true,
      minGain: 0.35,
      maxGain: 3,
      velocityForMaxGain: 1800,
      curve: 1.35,
    },
  },
};

const DEFAULT_LOST_TERRAIN_RECOVERY_CONFIG: CameraLostTerrainRecoveryConfig = {
  enabled: false,
  emaTauSeconds: 0.35,
};

type OrbitCameraOptions = {
  /** Closest-approach zoom-in rail. Leave undefined for an effectively
   *  unbounded camera; terrain clearance is configured separately. */
  minDistance?: number;
  /** BAR/Recoil's map-relative far controller-distance rail. */
  maxDistance?: number;
  /** Farthest rendered camera-eye distance from an origin point. Used for
   *  the app's zoom-out rail. */
  maxCameraDistanceFromOrigin?: number;
  /** Origin point used by maxCameraDistanceFromOrigin. */
  cameraDistanceOrigin?: { readonly x: number; readonly y: number; readonly z: number };
  /** Reference far distance for HUD fade scaling — NOT a zoom-out cap.
   *  The camera can dolly past it freely; HUD elements key off this so
   *  the fade window tracks map size. */
  farReferenceDistance?: number;
  /** Recover a lost map view by EMAing the eye and view angle toward the
   * configured map-origin point. Disabled by default for standalone callers. */
  lostTerrainRecovery?: CameraLostTerrainRecoveryConfig;
  /** Render interpolation: Recoil's velocity spring or the prior EMA path. */
  transitionMode?: CameraTransitionMode;
  /** Whether smoothing applies to every movement or only discrete zoom. */
  transitionScope?: CameraTransitionScope;
  minPitch?: number;
  maxPitch?: number;
  /** Relative-mode per-wheel-tick zoom fraction. BAR's default wheel speed
   *  makes this 0.175: scroll-IN uses (1-f), scroll-OUT uses (1+f).
   *  Distance and target both scale by the resulting factor, which keeps the
   *  configured anchor pixel pinned through the move. */
  zoomStepFraction?: number;
  /** Per-tick eye-travel ceiling as a fraction of current orbit distance.
   *  See barCameraTravelClampedZoomFactor. */
  zoomTravelClampFraction?: number;
  /** Screen-space terrain neighborhood used to derive the distance scalar
   *  for relative zoom movement. */
  zoomDistanceSampling?: CameraZoomDistanceSamplingConfig;
  /** Full movement tuning, grouped by physical mouse gesture. */
  movementConfig?: CameraMovementConfig;
  /** Relative-mode multiplier applied on top of world-per-pixel when
   *  panning. Absolute-world mode uses its fixed pan scale directly. */
  panMultiplier?: number;
  /** OPTIONAL 3D cursor picker — if set, the orbit camera uses real
   *  raycasting against the scene to find the configured world anchor.
   *  Used for wheel zoom, orbit pivots, and pan grab-depth capture. */
  getCursorWorldPoint?: (
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
  ) => THREE.Vector3 | null;
  /** OPTIONAL optimized picker for the peripheral zoom-distance samples.
   *  The center anchor always uses getCursorWorldPoint's authoritative mesh
   *  raycast; this callback can resolve the surrounding rays from a cheaper
   *  heightfield representation. */
  getZoomSampleWorldPoint?: (
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
    referenceSurfaceHeight: number,
  ) => THREE.Vector3 | null;
  /** BAR controller-space ray trace: origin may be the destination eye while
   * direction comes from the rendered cursor ray. */
  traceWorldRay?: (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    terrainMode: CameraAnchorTerrain,
    fallbackPlaneHeight: number,
  ) => THREE.Vector3 | null;
  /** OPTIONAL terrain-height sampler used by focus tracking and by explicit
   *  terrain collision modes. */
  getTerrainHeight?: (x: number, z: number) => number;
  /** Minimum 3D gap between the camera and nearby terrain. */
  minTerrainClearance?: number;
  /** How the camera resolves a frame where the eye would dip below
   *  terrain — see CameraTerrainCollisionMode. Defaults to 'none'. */
  terrainCollisionMode?: CameraTerrainCollisionMode;
  /** Anchor pair for SCROLL-IN. */
  zoomInAnchor?: CameraAnchor;
  /** Anchor pair for SCROLL-OUT. */
  zoomOutAnchor?: CameraAnchor;
  /** Anchor pair for ALT + middle-click ORBIT. */
  rotateAnchor?: CameraAnchor;
  /** Anchor pair for drag-pan depth capture. */
  panAnchor?: CameraAnchor;
};

/** Fixed, allocation-free sample buffer shared with the zoom-points debug
 *  renderer. Positions use Three.js world axes and are the exact terrain
 *  points whose distances contributed to `aggregateDistance`. */
export type CameraZoomTerrainSampleSnapshot = {
  readonly positions: Float32Array;
  readonly distances: Float32Array;
  /** 1 where the sample contributed to the aggregate: the single winner in
   *  `min`, the N nearest in `average-of-shortest-N`, none in `average`
   *  (every sample contributes equally, so nothing is highlighted). */
  readonly selectedFlags: Uint8Array;
  readonly ringPointCount: number;
  count: number;
  aggregation: CameraZoomDistanceAggregation;
  aggregateDistance: number;
  appliedAggregateDistance: number;
  centerDistance: number;
  /** Index of the nearest contributing point; -1 for average mode. */
  selectedSampleIndex: number;
  sampledAtMilliseconds: number;
  version: number;
};

/** Sample count for the average-of-shortest family; 1 for every other mode
 * (making it degenerate to `min`). */
export function zoomAggregationShortestCount(
  aggregation: CameraZoomDistanceAggregation,
): number {
  switch (aggregation) {
    case 'average-of-shortest-3': return 3;
    case 'average-of-shortest-5': return 5;
    case 'average-of-shortest-8': return 8;
    default: return 1;
  }
}

/** Mean of the `k` smallest of the first `count` distances — the robust
 * near-surface depth estimator behind `average-of-shortest-N`. `min` is
 * hijacked by any single spurious near sample, while the full mean of a
 * bimodal silhouette neighborhood lands mid-air between peak and valley;
 * averaging only the near tail keeps the estimate on the near surface with
 * no single sample dictating it. Non-finite entries never contribute.
 * `outFlags` doubles as the selection state and the result: entries must
 * arrive 0 over the first `count` indices, and contributing indices are
 * marked 1. Allocation-free: k·count comparisons on the caller's buffers. */
export function averageOfShortestDistances(
  distances: ArrayLike<number>,
  count: number,
  k: number,
  outFlags: Uint8Array,
): number {
  const usable = Math.max(0, Math.min(count, distances.length, outFlags.length));
  if (usable === 0) return Number.NaN;
  const take = Math.max(1, Math.min(usable, Math.floor(k)));
  let sum = 0;
  let taken = 0;
  for (let pass = 0; pass < take; pass++) {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < usable; i++) {
      if (outFlags[i] === 1) continue;
      const distance = distances[i];
      if (!Number.isFinite(distance)) continue;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    outFlags[bestIndex] = 1;
    sum += bestDistance;
    taken += 1;
  }
  return taken > 0 ? sum / taken : Number.NaN;
}

/** Classify a wheel event as a notched-wheel click or a continuous-device
 * stream (trackpad two-finger scroll, Magic Mouse surface, free-spin wheel).
 *
 * Line/page delta modes only come from real wheels. In pixel mode the only
 * portable signal is the legacy `wheelDelta`, which WebKit/Blink emit in
 * exact multiples of 120 for notched clicks and in arbitrary values for
 * touch streams. Browsers without the legacy field (Firefox) report real
 * wheels in line mode, so their pixel events are continuous streams too. */
export function barCameraWheelEventIsNotched(
  deltaMode: number,
  legacyWheelDelta: number | undefined,
): boolean {
  if (deltaMode !== 0) return true;
  if (legacyWheelDelta === undefined || !Number.isFinite(legacyWheelDelta)) {
    return false;
  }
  if (legacyWheelDelta === 0) return false;
  return legacyWheelDelta % LEGACY_NOTCHED_WHEEL_DELTA_UNIT === 0;
}

/** Convert a DOM wheel delta into the platform-independent wheel unit used by
 * BAR/Recoil. Exported so the browser-input edge cases have a small, pure
 * contract surface independent of Three.js and the DOM event dispatcher.
 *
 * `notchedDevice` matters only to `bar-discrete-event`: a notched click is
 * exactly one signed BAR unit regardless of OS-accelerated magnitude, while a
 * continuous stream keeps fractional pixel conversion — a trackpad fling is
 * dozens of small events and must not become dozens of full notches. */
export function barCameraWheelTicks(
  delta: number,
  deltaMode: number,
  inputMode: CameraWheelInputMode = 'dom-continuous-delta',
  notchedDevice = true,
): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  // SDL hands BAR one signed wheel unit for an ordinary notched-wheel event.
  // Browser pixel deltas can grow when the OS accelerates rapid scrolling;
  // magnitude must not turn one physical click into several controller units.
  if (inputMode === 'bar-discrete-event' && notchedDevice) return Math.sign(delta);
  // WheelEvent.DOM_DELTA_LINE/PAGE are specified as 1 and 2. Use the numeric
  // values so this pure helper is also safe in Node-based contract tests.
  if (deltaMode === 1) return delta / WHEEL_LINES_PER_TICK;
  if (deltaMode === 2) return delta;
  // DOM_DELTA_PIXEL is zero. Unknown modes are safest treated as pixels too.
  return delta / WHEEL_PIXELS_PER_TICK;
}

export type CameraMouseDragMode = 'orbit' | 'pan' | 'height-pan';

/** Modifier contract for held middle-mouse camera control. Alt deliberately
 * wins when both modifiers are held. */
export function cameraMouseDragModeForModifiers(
  altKey: boolean,
  ctrlKey: boolean,
): CameraMouseDragMode {
  if (altKey) return 'orbit';
  return ctrlKey ? 'height-pan' : 'pan';
}

/** Recoil SpringController's default relative zoom law. It is intentionally
 * asymmetric: one notch in is x0.825 and one notch out is x1.175. */
export function barCameraRelativeZoomFactor(
  signedTicks: number,
  stepFraction: number,
): number {
  if (!Number.isFinite(signedTicks) || signedTicks === 0) return 1;
  const fraction = Math.max(0, Number.isFinite(stepFraction) ? stepFraction : 0);
  return Math.max(1e-6, 1 + signedTicks * fraction);
}

/** Bound an anchor-relative zoom factor so the eye's travel cannot exceed
 * `clampFraction` of the current orbit distance.
 *
 * Anchor-relative zoom moves the eye by |1 − factor| · anchorDistance, and
 * anchorDistance is a raycast depth that is discontinuous at terrain
 * silhouettes: the pixel on a peak and the pixel beside it can differ by two
 * orders of magnitude, and a fallback hit can be quasi-infinite. Clamping the
 * factor — never the anchor point — keeps the gesture aimed at the same
 * world point while making per-tick motion proportional to the camera's own
 * scale. Ordinary zooms (anchorDistance ≈ orbitDistance) are unaffected. */
export function barCameraTravelClampedZoomFactor(
  wantFactor: number,
  anchorDistance: number,
  orbitDistance: number,
  clampFraction: number,
): number {
  if (!Number.isFinite(wantFactor) || wantFactor <= 0) return 1;
  if (
    !Number.isFinite(anchorDistance)
    || !(anchorDistance > 0)
    || !Number.isFinite(orbitDistance)
    || !(orbitDistance > 0)
  ) {
    return wantFactor;
  }
  // Zero or negative disables the clamp entirely.
  const fraction = Number.isFinite(clampFraction)
    ? clampFraction
    : DEFAULT_ZOOM_TRAVEL_CLAMP_FRACTION;
  if (!(fraction > 0)) return wantFactor;
  const maxFactorDelta = (fraction * orbitDistance) / anchorDistance;
  if (wantFactor < 1) {
    return Math.max(wantFactor, Math.max(1e-6, 1 - maxFactorDelta));
  }
  return Math.min(wantFactor, 1 + maxFactorDelta);
}

/** Ctrl-height pan and persistent terrain clearance both become the same
 * ordinary focus-height offset. Explicit zoom-in scales that offset toward
 * the terrain together with orbit distance; zoom-out leaves it unchanged. */
export function barCameraZoomElevationOffset(
  elevationOffset: number,
  oldDistance: number,
  nextDistance: number,
  zoomingIn: boolean,
): number {
  if (!Number.isFinite(elevationOffset)) return 0;
  if (!zoomingIn || !(oldDistance > 0) || !Number.isFinite(nextDistance)) {
    return elevationOffset;
  }
  return elevationOffset * Math.min(1, Math.max(0, nextDistance / oldDistance));
}

/** Recoil's GetRotationWithCardinalLock, translated literally. The raw yaw is
 * retained separately; only the rendered/controller yaw passes through this
 * dead-zone mapping. */
export function barCameraLockedYaw(rawYaw: number): number {
  if (!Number.isFinite(rawYaw)) return 0;
  const quarterTurn = Math.PI * 0.5;
  const scaled = rawYaw / quarterTurn;
  const moved = Math.abs(scaled) - BAR_CARDINAL_LOCK_WIDTH * 0.5;
  const whole = Math.trunc(moved);
  const fraction = moved - whole;
  const b = 1 / (1 - BAR_CARDINAL_LOCK_WIDTH);
  const c = 1 - b;
  const eased = fraction > BAR_CARDINAL_LOCK_WIDTH ? fraction * b + c : 0;
  const sign = scaled < 0 || Object.is(scaled, -0) ? -1 : 1;
  return sign * (whole + eased) * quarterTurn;
}

/** Resolve BAR-mode yaw while keeping its cardinal dead zones independently
 * configurable from the rest of the SpringController movement contract. */
export function barCameraYaw(rawYaw: number, cardinalLockEnabled: boolean): number {
  if (!Number.isFinite(rawYaw)) return 0;
  return cardinalLockEnabled ? barCameraLockedYaw(rawYaw) : rawYaw;
}

/** Permanent terrain response requested for Budget Annihilation. Returning
 * only the missing vertical clearance makes the resolved pose canonical: the
 * caller adds it to rendered and destination focus state exactly once. */
export function persistentTerrainRaise(
  eyeY: number,
  terrainY: number,
  clearance: number,
): number {
  if (!Number.isFinite(eyeY) || !Number.isFinite(terrainY)) return 0;
  return Math.max(0, terrainY + Math.max(0, clearance) - eyeY);
}

export type BarSpringDamperStep = {
  value: number;
  velocity: number;
};

/** Literal scalar port of Recoil SpringDampers.cpp. `halfLifeSeconds` and
 * `dtSeconds` use seconds instead of the engine's milliseconds; their ratio,
 * and therefore the result, is identical. Pass `out` on hot paths. */
export function barSpringDamperStep(
  value: number,
  velocity: number,
  goal: number,
  halfLifeSeconds: number,
  dtSeconds: number,
  out: BarSpringDamperStep = { value: 0, velocity: 0 },
): BarSpringDamperStep {
  const halfLife = Math.max(0, halfLifeSeconds);
  const dt = Math.max(0, dtSeconds);
  if (halfLife <= 0 || dt <= 0) {
    out.value = halfLife <= 0 ? goal : value;
    out.velocity = halfLife <= 0 ? 0 : velocity;
    return out;
  }
  // Recoil: damping = (4*ln(2)/(halflife+eps))/2. Scale its 1e-5ms
  // epsilon into seconds so the browser port follows the same edge behavior.
  const damping = (2 * Math.LN2) / (halfLife + 1e-8);
  const x = damping * dt;
  const eydt = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const j0 = value - goal;
  const j1 = velocity + j0 * damping;
  out.value = eydt * (j0 + j1 * dt) + goal;
  out.velocity = eydt * (velocity - j1 * damping * dt);
  return out;
}

export class OrbitCamera {
  public camera: THREE.PerspectiveCamera;

  // RENDERED state — what the camera is at right now. Read by `apply()`
  // to position the THREE camera.
  public target = new THREE.Vector3(0, 0, 0);
  public distance = 1500;
  /** Yaw (rotation around world-Y), radians. */
  public yaw = 0;
  /** Unfiltered BAR yaw retained for optional cardinal-lock dead zones. */
  private barRawYaw = 0;
  /** Pitch (tilt from vertical), radians. 0 = straight down, PI/2 = horizontal. */
  public pitch = Math.PI * 0.25;

  // TO state — what the camera is heading toward. Inputs (wheel, pan
  // drag, setTarget) write here; tick() lerps the rendered state
  // toward it. In snap mode (tau == 0) inputs also apply directly.
  // Y is tracked alongside X/Z because the cursor-pin formula needs
  // to blend target.y toward the cursor world point's altitude every
  // wheel tick — without that, zooming over terrain at any height
  // ≠ target.y drifts the cursor pin vertically by (1-α)·(p0.y -
  // target.y) per scroll, and the drift accumulates until the cursor
  // pin is permanently broken.
  private toDistance = 1500;
  private toTargetX = 0;
  private toTargetY = 0;
  private toTargetZ = 0;
  // Controller rotation destination. EMA mode normally keeps pitch direct;
  // BAR spring-dampened mode transitions the active camera's rotation toward
  // both values while preserving independent angular velocity.
  private toYaw = 0;
  private toPitch = this.pitch;

  /** Selected transition scalar in seconds: EMA time constant in `ema` mode,
   * Recoil spring half-life in `bar-spring-dampened`, or 0 for snap. */
  public transitionSeconds = 0;
  private transitionMode: CameraTransitionMode = 'ema';
  private transitionScope: CameraTransitionScope = 'all-movements';
  private barRenderInitialized = false;
  private readonly barPositionVelocity = new THREE.Vector3();
  private barYawVelocity = 0;
  private barPitchVelocity = 0;
  private barFovGoalDegrees = 45;
  private barFovVelocity = 0;
  private readonly barDamperStepScratch = { value: 0, velocity: 0 };
  /** Controller goal before a continuous input mutation. Reused so panning
   * can move the rendered eye immediately without discarding zoom lag. */
  private readonly continuousGoalBefore = new THREE.Vector3();
  private continuousTargetXBefore = 0;
  private continuousTargetYBefore = 0;
  private continuousTargetZBefore = 0;

  private minDistance = 1e-6;
  private maxDistance = Infinity;
  private maxCameraDistanceFromOrigin = Infinity;
  private cameraDistanceOrigin = new THREE.Vector3();
  /** HUD-fade far reference (see getFarReferenceDistance). Not a clamp. */
  private farReferenceDistance: number;
  private lostTerrainRecovery: CameraLostTerrainRecoveryConfig =
    DEFAULT_LOST_TERRAIN_RECOVERY_CONFIG;
  /** Receives a camera frustum and reports whether the terrain bounds
   * intersect it. Installed by the scene once terrain exists. */
  private surfaceVisibilityChecker?: (frustum: THREE.Frustum) => boolean;
  private mapRecoveryActive = false;
  private mapRecoveryPitch = this.pitch;
  private mapRecoveryDistance = this.distance;
  private mapRecoveryYaw = this.yaw;
  private readonly mapRecoveryTarget = new THREE.Vector3();
  private minPitch: number;
  private maxPitch: number;
  private targetMinX = -Infinity;
  private targetMaxX = Infinity;
  private targetMinZ = -Infinity;
  private targetMaxZ = Infinity;
  private zoomStepFraction: number;
  private zoomTravelClampFraction = DEFAULT_ZOOM_TRAVEL_CLAMP_FRACTION;
  private invariantWarningCount = 0;
  private zoomDistanceSampling: CameraZoomDistanceSamplingConfig;
  private zoomTerrainSamples: CameraZoomTerrainSampleSnapshot;
  private movementScaleMode: CameraMovementScaleMode = 'anchor-distance-relative';
  private movementConfig: CameraMovementConfig = DEFAULT_CAMERA_MOVEMENT_CONFIG;
  private panMultiplier: number;
  private getCursorWorldPoint?: (
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
  ) => THREE.Vector3 | null;
  private getZoomSampleWorldPoint?: (
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
    referenceSurfaceHeight: number,
  ) => THREE.Vector3 | null;
  private traceWorldRay?: (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    terrainMode: CameraAnchorTerrain,
    fallbackPlaneHeight: number,
  ) => THREE.Vector3 | null;
  private getTerrainHeight?: (x: number, z: number) => number;
  /** Minimum 3D gap between the camera and nearby terrain when an
   *  explicit collision mode is enabled. The default app camera does
   *  not use terrain clearance. */
  public minTerrainClearance = 0;
  private terrainCollisionMode: CameraTerrainCollisionMode = 'none';

  /** Anchor pair for each gesture. The wheel handler reads
   *  `zoomInAnchor` vs `zoomOutAnchor` based on scroll direction so
   *  the two halves of the zoom can use different anchors. Defaults
   *  may use cursor for both. The orbit drag and touch twist use
   *  `rotateAnchor`, and pan uses
   *  `panAnchor` for its grab-depth capture. */
  private zoomInAnchor: CameraAnchor = { screen: 'cursor', terrain: 'terrain-3d' };
  private zoomOutAnchor: CameraAnchor = { screen: 'cursor', terrain: 'terrain-3d' };
  private rotateAnchor: CameraAnchor = { screen: 'screen-center', terrain: 'terrain-3d' };
  private panAnchorMode: CameraAnchor = { screen: 'cursor', terrain: 'terrain-3d' };

  private dragMode: 'none' | 'orbit' | 'pan' | 'height-pan' = 'none';
  private lastMouseX = 0;
  private lastMouseY = 0;
  private lastMouseTimeMs = Number.NEGATIVE_INFINITY;
  private lastWheelTimeMs = Number.NEGATIVE_INFINITY;
  private touchMode: 'none' | 'pan' | 'pinch' = 'none';
  private touchLastCenterX = 0;
  private touchLastCenterY = 0;
  private touchLastDistance = 0;
  private touchLastAngle = 0;
  private previousTouchAction = '';

  /** 3D anchor point captured at drag-start (pan) — the actual
   *  rendered ground point the cursor was over when the user pressed
   *  the middle button. The pan rate is computed using the camera-
   *  to-anchor distance so the pan magnitude is right for the depth
   *  the user grabbed (not the orbit target depth) — bounded at all
   *  camera pitches, no per-pixel anomalies near horizontal views. */
  private panAnchor = new THREE.Vector3();
  private panAnchorValid = false;
  /** Distance from camera to panAnchor at drag-start, used as the
   *  reference depth for worldPerPixel during the pan. Locked at
   *  drag-start so EMA-driven camera motion during the drag doesn't
   *  feed back into the pan rate. */
  private panAnchorDistance = 0;

  /** Rigid-tumble orbit state — preserves camera position AND
   *  orientation at orbit drag-start. Subsequent yaw/pitch deltas
   *  rotate the camera around `orbitPivot` rigidly: pivot stays
   *  exactly where it was on screen, no re-centering snap on the
   *  first frame. After the drag ends, the orbit state (target,
   *  yaw, pitch, distance) is synthesized from the new camera
   *  position so future pan/zoom/apply behave normally. */
  private orbitPivotActive = false;
  private orbitPivot = new THREE.Vector3();
  private orbitStartCamPos = new THREE.Vector3();
  private orbitStartYaw = 0;
  private orbitStartPitch = 0;
  private orbitStartDistance = 0;
  private orbitYawAccum = 0;
  private orbitPitchAccum = 0;

  // Reusable scratch objects so the wheel handler does no per-event
  // allocations (zoom is the highest-frequency input on a trackpad).
  private _orbitOffsetTmp = new THREE.Vector3();
  private _orbitYawQuatTmp = new THREE.Quaternion();
  private _orbitPitchQuatTmp = new THREE.Quaternion();
  private _orbitRightTmp = new THREE.Vector3();
  private _cameraPosTmp = new THREE.Vector3();
  private _cameraLookAtTmp = new THREE.Vector3();
  private _zoomCenterTmp = new THREE.Vector3();
  private _zoomSampleCenterTmp = new THREE.Vector3();
  private _zoomPivotTmp = new THREE.Vector3();
  private _zoomScreenAnchorTmp = new THREE.Vector2();
  private _barControllerEyeTmp = new THREE.Vector3();
  private _barRenderedRayTmp = new THREE.Vector3();
  private _barScreenRayPointTmp = new THREE.Vector3();
  private _barViewForwardTmp = new THREE.Vector3();
  private _barWantedEyeTmp = new THREE.Vector3();
  private _barTraceOriginTmp = new THREE.Vector3();
  private _barTraceHitTmp = new THREE.Vector3();
  private _barGoalEyeTmp = new THREE.Vector3();
  private _barLookDirectionTmp = new THREE.Vector3();
  private _mapRecoveryOriginClipTmp = new THREE.Vector3();
  private _mapRecoveryEyeOffsetTmp = new THREE.Vector3();
  private _surfaceVisibilityFrustum = new THREE.Frustum();
  private _surfaceVisibilityProjectionTmp = new THREE.Matrix4();
  private static _ORBIT_WORLD_Y = new THREE.Vector3(0, 1, 0);

  private canvas: HTMLElement;
  private onWheel: (e: WheelEvent) => void;
  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;
  private onWindowBlur: () => void;
  private onTouchStart: (e: TouchEvent) => void;
  private onTouchMove: (e: TouchEvent) => void;
  private onTouchEnd: (e: TouchEvent) => void;
  private onContextMenu: (e: MouseEvent) => void;

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLElement,
    opts: OrbitCameraOptions = {},
  ) {
    this.camera = camera;
    this.canvas = canvas;
    if (opts.minDistance !== undefined && Number.isFinite(opts.minDistance)) {
      this.minDistance = Math.max(1e-6, opts.minDistance);
    }
    if (opts.maxDistance !== undefined && Number.isFinite(opts.maxDistance)) {
      this.maxDistance = Math.max(this.minDistance, opts.maxDistance);
    }
    if (
      opts.maxCameraDistanceFromOrigin !== undefined &&
      Number.isFinite(opts.maxCameraDistanceFromOrigin)
    ) {
      this.maxCameraDistanceFromOrigin = Math.max(this.minDistance, opts.maxCameraDistanceFromOrigin);
    }
    if (opts.cameraDistanceOrigin !== undefined) {
      this.cameraDistanceOrigin.set(
        Number.isFinite(opts.cameraDistanceOrigin.x) ? opts.cameraDistanceOrigin.x : 0,
        Number.isFinite(opts.cameraDistanceOrigin.y) ? opts.cameraDistanceOrigin.y : 0,
        Number.isFinite(opts.cameraDistanceOrigin.z) ? opts.cameraDistanceOrigin.z : 0,
      );
    }
    this.farReferenceDistance = opts.farReferenceDistance ?? 8000;
    this.transitionMode = opts.transitionMode ?? this.transitionMode;
    this.transitionScope = opts.transitionScope ?? this.transitionScope;
    this.barFovGoalDegrees = this.camera.fov;
    const recovery = opts.lostTerrainRecovery;
    if (recovery !== undefined) {
      this.lostTerrainRecovery = {
        enabled: recovery.enabled === true,
        emaTauSeconds: Number.isFinite(recovery.emaTauSeconds)
          ? Math.max(0.01, recovery.emaTauSeconds)
          : DEFAULT_LOST_TERRAIN_RECOVERY_CONFIG.emaTauSeconds,
      };
    }
    this.minPitch = opts.minPitch ?? Math.PI * 0.01;
    this.maxPitch = opts.maxPitch ?? Math.PI * 0.49;
    this.zoomStepFraction = opts.zoomStepFraction ?? 0.175;
    if (
      opts.zoomTravelClampFraction !== undefined
      && Number.isFinite(opts.zoomTravelClampFraction)
    ) {
      this.zoomTravelClampFraction = Math.max(0, opts.zoomTravelClampFraction);
    }
    this.zoomDistanceSampling = opts.zoomDistanceSampling
      ?? DEFAULT_ZOOM_DISTANCE_SAMPLING_CONFIG;
    const zoomRingPointCount = Math.max(
      1,
      Math.floor(this.zoomDistanceSampling.ringPointCount),
    );
    const zoomSampleCount = 1 + zoomRingPointCount * 2;
    this.zoomTerrainSamples = {
      positions: new Float32Array(zoomSampleCount * 3),
      distances: new Float32Array(zoomSampleCount),
      selectedFlags: new Uint8Array(zoomSampleCount),
      ringPointCount: zoomRingPointCount,
      count: 0,
      aggregation: this.zoomDistanceSampling.distanceAggregation,
      aggregateDistance: 0,
      appliedAggregateDistance: 0,
      centerDistance: 0,
      selectedSampleIndex: -1,
      sampledAtMilliseconds: Number.NEGATIVE_INFINITY,
      version: 0,
    };
    this.movementConfig = opts.movementConfig ?? this.movementConfig;
    this.movementScaleMode = this.movementConfig.scaleMode;
    this.panMultiplier = opts.panMultiplier ?? 1.0;
    this.getCursorWorldPoint = opts.getCursorWorldPoint;
    this.getZoomSampleWorldPoint = opts.getZoomSampleWorldPoint;
    this.traceWorldRay = opts.traceWorldRay;
    this.getTerrainHeight = opts.getTerrainHeight;
    if (opts.minTerrainClearance !== undefined) {
      this.minTerrainClearance = Math.max(0, opts.minTerrainClearance);
    }
    if (opts.terrainCollisionMode !== undefined) {
      this.terrainCollisionMode = opts.terrainCollisionMode;
    }
    if (opts.zoomInAnchor !== undefined) this.zoomInAnchor = opts.zoomInAnchor;
    if (opts.zoomOutAnchor !== undefined) this.zoomOutAnchor = opts.zoomOutAnchor;
    if (opts.rotateAnchor !== undefined) this.rotateAnchor = opts.rotateAnchor;
    if (opts.panAnchor !== undefined) this.panAnchorMode = opts.panAnchor;

    this.toDistance = this.distance;
    this.toTargetX = this.target.x;
    this.toTargetY = this.target.y;
    this.toTargetZ = this.target.z;
    this.toYaw = this.yaw;
    this.toPitch = this.pitch;
    this.barRawYaw = this.yaw;
    this.previousTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';

    this.onWheel = (e) => {
      e.preventDefault();
      this.cancelMapRecovery();
      //   scroll up   (delta < 0)  → zoom in
      //   scroll down (delta > 0)  → zoom out
      //
      // Browsers commonly remap Shift + wheel into horizontal deltaX
      // scrolling. It is still BAR's movefast wheel gesture. WITHOUT Shift,
      // horizontal deltas are a sideways trackpad swipe and must not zoom.
      const wheelDelta = e.deltaY !== 0 ? e.deltaY : (e.shiftKey ? e.deltaX : 0);
      if (wheelDelta === 0) return;

      let signedTicks = barCameraWheelTicks(
        wheelDelta,
        e.deltaMode,
        this.movementConfig.wheelInputMode,
        barCameraWheelEventIsNotched(
          e.deltaMode,
          (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
        ),
      );
      if (signedTicks === 0) return;
      // BAR binds Shift to movefast. SpringController scales wheel input by
      // 2x and pointer movement by 4x with the engine defaults.
      if (e.shiftKey) signedTicks *= BAR_FAST_WHEEL_MULTIPLIER;

      // Wheel tilt lives on Alt so it shares the camera-angle modifier with
      // Alt+drag orbit. BAR's Ctrl+wheel tilt is deliberately not used:
      // macOS delivers trackpad pinch as Ctrl+wheel, and pinch must zoom.
      if (e.altKey) {
        const nextPitch = Math.min(
          this.maxPitch,
          Math.max(
            this.minPitch,
            this.controllerPitch() + signedTicks * BAR_TILT_RADIANS_PER_WHEEL_TICK,
          ),
        );
        if (this.usesBarSpringTransition()) {
          this.beginContinuousMovement();
          this.toPitch = nextPitch;
          this.finishContinuousMovement();
        } else {
          this.pitch = nextPitch;
          this.toPitch = nextPitch;
          this.apply();
        }
        return;
      }

      const zoomingIn = signedTicks < 0;
      const zoomMovement = zoomingIn
        ? this.movementConfig.zoomIn
        : this.movementConfig.zoomOut;
      const inputGain = this.wheelMomentumGain(e, signedTicks, zoomMovement.momentum);
      // Each zoom direction has its own configured anchor. BAR's battle
      // default is cursor-in and screen-center-out.
      const anchor = zoomingIn ? this.zoomInAnchor : this.zoomOutAnchor;
      this.zoomWheelAt(
        e.clientX,
        e.clientY,
        zoomingIn,
        Math.abs(signedTicks),
        inputGain,
        anchor,
        zoomMovement.absoluteWorldUnitsPerWheelTick,
      );
    };

    this.onMouseDown = (e) => {
      // Middle mouse button = camera control
      if (e.button !== 1) return;
      e.preventDefault();
      this.cancelMapRecovery();
      this.dragMode = this.mouseDragModeForModifiers(e.altKey, e.ctrlKey);
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.lastMouseTimeMs = e.timeStamp;
      if (this.dragMode === 'pan' || this.dragMode === 'height-pan') {
        this.capturePanAnchor(e.clientX, e.clientY);
      } else if (this.dragMode === 'orbit' && !this.usesBarSpringMovement()) {
        this.captureOrbitPivot(e.clientX, e.clientY);
      }
    };

    this.onMouseMove = (e) => {
      if (this.dragMode === 'none') return;
      // A release outside the canvas/window can occasionally miss mouseup.
      // MouseEvent.buttons is authoritative on the next movement, so cancel
      // immediately instead of leaving a latent drag mode.
      if ((e.buttons & 4) === 0) {
        this.dragMode = 'none';
        this.orbitPivotActive = false;
        this.panAnchorValid = false;
        return;
      }
      // Recoil reads moverotate/movetilt state for every motion event rather
      // than only on mouse-down. Changing Alt/Ctrl during a held drag must
      // switch modes without applying the accumulated delta from the old one.
      const requestedDragMode = this.mouseDragModeForModifiers(e.altKey, e.ctrlKey);
      if (requestedDragMode !== this.dragMode) {
        this.dragMode = requestedDragMode;
        if (requestedDragMode === 'orbit') {
          if (this.usesBarSpringMovement()) this.orbitPivotActive = false;
          else this.captureOrbitPivot(e.clientX, e.clientY);
        } else {
          this.orbitPivotActive = false;
          this.capturePanAnchor(e.clientX, e.clientY);
        }
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        this.lastMouseTimeMs = e.timeStamp;
        return;
      }
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      const momentum = this.pointerMomentumForDragMode(this.dragMode);
      let inputGain = this.mouseMomentumGain(
        dx,
        dy,
        e.timeStamp,
        this.lastMouseTimeMs,
        momentum,
      );
      if (e.shiftKey) inputGain *= BAR_FAST_POINTER_MULTIPLIER;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.lastMouseTimeMs = e.timeStamp;

      if (this.dragMode === 'orbit') {
        const scaledDx = dx * inputGain;
        const scaledDy = dy * inputGain;
        if (this.usesBarSpringMovement()) {
          if (this.usesBarSpringTransition()) this.beginContinuousMovement();
          const radiansPerPixel = this.orbitRadiansPerPixel();
          this.barRawYaw -= scaledDx * radiansPerPixel;
          const nextYaw = this.resolveBarYaw(this.barRawYaw);
          const nextPitch = Math.min(
            this.maxPitch,
            Math.max(this.minPitch, this.controllerPitch() + scaledDy * radiansPerPixel),
          );
          this.toYaw = nextYaw;
          this.toPitch = nextPitch;
          if (this.usesBarSpringTransition()) this.finishContinuousMovement();
          else {
            this.yaw = nextYaw;
            this.pitch = nextPitch;
            this.apply();
          }
          return;
        }
        // RIGID TUMBLE around the cursor's 3D ground pivot. The
        // total yaw/pitch deltas since drag-start are applied as a
        // single rigid rotation of the camera around `orbitPivot`:
        //
        //   1. Take the start offset (orbitStartCamPos − pivot).
        //   2. Rotate it around world Y by the world-rotation that
        //      corresponds to the yaw delta (= R_y(−Δyaw_value),
        //      since our orbit "yaw" increases as the camera swings
        //      counterclockwise around target → world rotation is
        //      negative-yaw-value).
        //   3. Then rotate it around the new yaw's right axis by
        //      the world-rotation that matches the pitch delta
        //      (= +Δpitch_value around right_world).
        //   4. New camera position = pivot + rotated offset.
        //   5. Camera looks at a SYNTHESIZED target = camera_pos −
        //      distance · dir(newYaw, newPitch). That target sits
        //      on the back-extension of the camera's view direction,
        //      and lookAt(target) reproduces the rigid-rotation
        //      orientation exactly. After drag-end, future pan/zoom
        //      operate on this target naturally.
        //
        // Net result: camera position AND orientation are unchanged
        // when the drag starts (Δ = 0 → R = identity → camera at
        // startCamPos, looking at startTarget). As the user drags,
        // both rotate rigidly around the pivot — pivot stays
        // exactly under the same screen pixel through the whole
        // drag.
        if (this.orbitPivotActive) {
          const radiansPerPixel = this.orbitRadiansPerPixel();
          this.orbitYawAccum -= scaledDx * radiansPerPixel;
          this.orbitPitchAccum += scaledDy * radiansPerPixel;
          // Clamp the EFFECTIVE pitch (start + accum) to the orbit
          // range so the camera can't flip upside-down.
          let newPitch = this.orbitStartPitch + this.orbitPitchAccum;
          if (newPitch < this.minPitch) {
            newPitch = this.minPitch;
            this.orbitPitchAccum = newPitch - this.orbitStartPitch;
          } else if (newPitch > this.maxPitch) {
            newPitch = this.maxPitch;
            this.orbitPitchAccum = newPitch - this.orbitStartPitch;
          }
          this.orbitYawAccum = OrbitCamera.normalizeAngleDelta(this.orbitYawAccum);
          const newYaw = OrbitCamera.normalizeAngleDelta(
            this.orbitStartYaw + this.orbitYawAccum,
          );

          // Rigid rotation: yaw around world Y, then pitch around
          // the (post-yaw) right axis. Apply to the start offset
          // from pivot; result is the new camera world position.
          this._orbitOffsetTmp.copy(this.orbitStartCamPos).sub(this.orbitPivot);
          // Yaw: world Y by −Δyaw_value (see header comment).
          this._orbitYawQuatTmp.setFromAxisAngle(
            OrbitCamera._ORBIT_WORLD_Y,
            -this.orbitYawAccum,
          );
          this._orbitOffsetTmp.applyQuaternion(this._orbitYawQuatTmp);
          // Pitch axis: right_world at the NEW yaw. For our orbit
          // convention, right_world(yaw) = (−cos(yaw), 0, −sin(yaw)).
          this._orbitRightTmp.set(-Math.cos(newYaw), 0, -Math.sin(newYaw));
          this._orbitPitchQuatTmp.setFromAxisAngle(
            this._orbitRightTmp,
            this.orbitPitchAccum,
          );
          this._orbitOffsetTmp.applyQuaternion(this._orbitPitchQuatTmp);

          // New camera position = pivot + rigid-rotated offset.
          // Synthesize target so that with new yaw/pitch/distance
          // (distance unchanged), apply() produces this same camera
          // position AND lookAt(target) gives the rigid orientation.
          this.yaw = newYaw;
          this.pitch = newPitch;
          // distance stays at orbitStartDistance — rigid rotation
          // preserves camera-to-pivot distance, but our orbit
          // distance is camera-to-target which is what apply() uses.
          this.distance = this.orbitStartDistance;
          this.toDistance = this.orbitStartDistance;
          const cx = this.orbitPivot.x + this._orbitOffsetTmp.x;
          const cy = this.orbitPivot.y + this._orbitOffsetTmp.y;
          const cz = this.orbitPivot.z + this._orbitOffsetTmp.z;
          // dir(yaw, pitch) — the unit vector from target → camera.
          const sinP = Math.sin(this.pitch);
          const cosP = Math.cos(this.pitch);
          const dirX = sinP * Math.sin(this.yaw);
          const dirY = cosP;
          const dirZ = sinP * -Math.cos(this.yaw);
          // target = camera − distance · dir.
          this.target.set(
            cx - this.distance * dirX,
            cy - this.distance * dirY,
            cz - this.distance * dirZ,
          );
          this.toTargetX = this.target.x;
          this.toTargetY = this.target.y;
          this.toTargetZ = this.target.z;
          this.toYaw = this.yaw;
          // apply() will write camera.position = target + d·dir = (cx,cy,cz)
          // and camera.lookAt(target) = lookAt the synthesized point,
          // giving the rigid-rotation orientation.
          this.apply();
        } else {
          // Fallback: no pivot — orbit around the existing target
          // exactly the way the camera always did before this fix.
          const radiansPerPixel = this.orbitRadiansPerPixel();
          this.yaw = OrbitCamera.normalizeAngleDelta(this.yaw - scaledDx * radiansPerPixel);
          this.pitch += scaledDy * radiansPerPixel;
          this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch));
          this.toYaw = this.yaw;
          this.apply();
        }
      } else if (this.dragMode === 'pan') {
        this.panByScreenDelta(dx * inputGain, dy * inputGain, 'pan');
      } else if (this.dragMode === 'height-pan') {
        this.panHeightByScreenDelta(dx * inputGain, dy * inputGain);
      }
    };

    this.onMouseUp = (e) => {
      if (e.button !== 1) return;
      // Battle-camera MMB is deliberately hold-to-pan only. BAR exposes its
      // quick-click locked-scroll behavior as an optional setting; enabling
      // that in a browser hides the pointer and makes short drags look stuck.
      this.dragMode = 'none';
      this.orbitPivotActive = false;
      this.panAnchorValid = false;
    };

    this.onWindowBlur = () => {
      // A lost mouse-up must never leave the camera consuming movements when
      // the player returns to the tab.
      this.dragMode = 'none';
      this.orbitPivotActive = false;
      this.panAnchorValid = false;
    };

    this.onTouchStart = (e) => {
      if (e.touches.length === 0) return;
      e.preventDefault();
      this.cancelMapRecovery();
      this.dragMode = 'none';
      this.orbitPivotActive = false;
      this.beginTouchGesture(e);
    };

    this.onTouchMove = (e) => {
      if (this.touchMode === 'none' || e.touches.length === 0) return;
      e.preventDefault();
      const nextMode = e.touches.length >= 2 ? 'pinch' : 'pan';
      if (nextMode !== this.touchMode) {
        this.beginTouchGesture(e);
        return;
      }

      const center = this.touchCenter(e);
      const dx = center.x - this.touchLastCenterX;
      const dy = center.y - this.touchLastCenterY;
      this.panByTouchScreenDelta(dx, dy);

      if (nextMode === 'pinch') {
        const dist = this.touchDistance(e);
        const angle = this.touchAngle(e);
        if (dist > 1 && this.touchLastDistance > 1) {
          // Fingers apart means zoom in. Clamp the per-event factor
          // so browser event bursts cannot create a jarring snap.
          const factor = Math.min(1.25, Math.max(0.8, this.touchLastDistance / dist));
          if (this.usesAbsoluteWorldMovement()) {
            this.zoomByWorldStepAt(center.x, center.y, this.worldStepForZoomFactor(factor));
          } else {
            this.zoomByFactorAt(center.x, center.y, factor);
          }
        }
        if (Number.isFinite(angle) && Number.isFinite(this.touchLastAngle)) {
          const twist = OrbitCamera.normalizeAngleDelta(angle - this.touchLastAngle);
          if (Math.abs(twist) >= TOUCH_ROTATE_DEADZONE_RAD) {
            const clampedTwist = Math.max(
              -TOUCH_ROTATE_MAX_DELTA_RAD,
              Math.min(TOUCH_ROTATE_MAX_DELTA_RAD, twist),
            );
            // Screen-space clockwise twist should rotate the map clockwise,
            // which is camera-yaw negative in this orbit convention.
            this.rotateYawAroundScreenPoint(center.x, center.y, -clampedTwist);
          }
        }
        this.touchLastDistance = dist;
        this.touchLastAngle = angle;
      }

      this.touchLastCenterX = center.x;
      this.touchLastCenterY = center.y;
    };

    this.onTouchEnd = (e) => {
      e.preventDefault();
      if (e.touches.length === 0) {
        this.touchMode = 'none';
        this.panAnchorValid = false;
        return;
      }
      this.beginTouchGesture(e);
    };

    this.onContextMenu = (e) => {
      e.preventDefault();
    };

    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('blur', this.onWindowBlur);
    canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);

    this.apply();
  }

  private applyDestinationIfSnap(): void {
    if (this.usesBarSpringTransition()) {
      if (this.transitionSeconds === 0) this.snapBarRenderToController();
      return;
    }
    // Snap mode applies inputs directly to the rendered state.
    // EMA mode leaves the rendered state and lets tick() ease.
    if (this.transitionSeconds !== 0) return;
    this.distance = this.toDistance;
    this.target.x = this.toTargetX;
    this.target.y = this.toTargetY;
    this.target.z = this.toTargetZ;
    // toYaw === yaw for every input except a follow driver, so this is a
    // no-op for ordinary pan/zoom and an instant behind-snap when following.
    this.yaw = this.toYaw;
    this.apply();
  }

  /** Capture the controller pose before a continuous input changes it. In
   * zoom-only mode the matching finish call carries the rendered pose by the
   * exact controller delta, preserving any outstanding zoom transition. */
  private beginContinuousMovement(): void {
    if (this.transitionScope !== 'zoom-only') return;
    if (this.usesBarSpringTransition()) {
      this.continuousGoalBefore.copy(this.prepareBarControllerGoal());
      return;
    }
    this.continuousTargetXBefore = this.toTargetX;
    this.continuousTargetYBefore = this.toTargetY;
    this.continuousTargetZBefore = this.toTargetZ;
  }

  private finishContinuousMovement(): void {
    if (this.transitionScope !== 'zoom-only') {
      this.applyDestinationIfSnap();
      return;
    }

    if (this.usesBarSpringTransition()) {
      const goal = this.prepareBarControllerGoal();
      if (!this.barRenderInitialized || this.transitionSeconds <= 0) {
        this.snapBarRenderToController();
        return;
      }
      // Translate by the controller's exact eye delta. The remaining offset
      // and velocity belong only to the earlier discrete zoom and continue
      // converging normally on subsequent ticks.
      this.camera.position.add(goal).sub(this.continuousGoalBefore);
      this.yaw = this.toYaw;
      this.pitch = this.toPitch;
      this.barYawVelocity = 0;
      this.barPitchVelocity = 0;
      this.resolveBarRenderedTerrainCollision(goal);
      this.applyBarRenderedPose();
      return;
    }

    // EMA fallback: carry the rendered target by the exact destination delta
    // while leaving its outstanding zoom distance/anchor residual intact.
    this.target.x += this.toTargetX - this.continuousTargetXBefore;
    this.target.y += this.toTargetY - this.continuousTargetYBefore;
    this.target.z += this.toTargetZ - this.continuousTargetZBefore;
    this.yaw = this.toYaw;
    this.pitch = this.toPitch;
    this.apply();
  }

  private zoomWheelAt(
    clientX: number,
    clientY: number,
    zoomingIn: boolean,
    wheelTicks: number,
    inputGain: number,
    anchor: CameraAnchor,
    absoluteWorldUnitsPerWheelTick: number,
  ): void {
    if (this.usesBarSpringMovement() && this.usesTerrainFollowFocus()) {
      const signedTicks = zoomingIn ? -wheelTicks : wheelTicks;
      this.zoomBarSpringAt(clientX, clientY, signedTicks, anchor);
      return;
    }
    if (this.usesAbsoluteWorldMovement()) {
      const step = Math.max(0, absoluteWorldUnitsPerWheelTick) * wheelTicks * inputGain;
      this.zoomByWorldStepAt(clientX, clientY, zoomingIn ? -step : step, anchor);
      return;
    }

    // Relative wheel zoom scales distance against the broad distance
    // rails and shifts the target by the same factor around the
    // selected anchor. Absolute modes take the branch above so in/out
    // use the same fixed world-step path with only the sign flipped.
    //
    // Constant-altitude bar-spring zoom deliberately shares this path: eye
    // and focus contract toward (or expand away from) the 3D anchor by
    // BAR's asymmetric factor, so distance still scales 0.825/1.175 per
    // notch while focus altitude changes only through that anchor
    // translation. When the anchor ray finds no terrain, the factor is
    // applied around the focus itself — a plain center zoom — instead of
    // anchoring on a fallback plane at quasi-infinite depth.
    const signedTicks = zoomingIn ? -wheelTicks : wheelTicks;
    const factor = barCameraRelativeZoomFactor(signedTicks, this.zoomStepFraction);
    this.zoomByFactorAt(clientX, clientY, factor, anchor);
  }

  private usesAbsoluteWorldMovement(): boolean {
    return this.movementScaleMode === 'absolute-world'
      || this.movementScaleMode === 'absolute-world-momentum';
  }

  private usesBarSpringMovement(): boolean {
    return this.movementScaleMode === 'bar-spring';
  }

  private focusHeightMode(): CameraFocusHeightMode {
    return this.movementConfig.focusHeightMode;
  }

  /** BAR-parity focus handling: focus glued to the terrain bed with a
   * persistent elevation offset. Only meaningful under bar-spring movement. */
  private usesTerrainFollowFocus(): boolean {
    return this.usesBarSpringMovement()
      && this.focusHeightMode() === 'terrain-follow';
  }

  private resolveBarYaw(rawYaw: number): number {
    return barCameraYaw(rawYaw, this.movementConfig.cardinalYawLockEnabled);
  }

  private usesBarSpringTransition(): boolean {
    return this.usesBarSpringMovement()
      && this.transitionMode === 'bar-spring-dampened';
  }

  private controllerYaw(): number {
    return this.usesBarSpringTransition() ? this.toYaw : this.yaw;
  }

  private controllerPitch(): number {
    return this.usesBarSpringTransition() ? this.toPitch : this.pitch;
  }

  private usesMomentumGain(): boolean {
    return this.movementScaleMode === 'absolute-world-momentum';
  }

  private orbitRadiansPerPixel(): number {
    return Math.max(0, this.movementConfig.altCenterClickOrbit.radiansPerPixel);
  }

  private pointerMomentumForDragMode(
    mode: 'none' | 'orbit' | 'pan' | 'height-pan',
  ): CameraInputMomentumConfig {
    if (mode === 'orbit') {
      return this.movementConfig.altCenterClickOrbit.momentum;
    }
    if (mode === 'height-pan') {
      return this.movementConfig.ctrlCenterClickHeightPan.momentum;
    }
    return this.movementConfig.centerClickPan.momentum;
  }

  private mouseDragModeForModifiers(
    altKey: boolean,
    ctrlKey: boolean,
  ): CameraMouseDragMode {
    // Intentional Budget Annihilation extension: BAR uses Ctrl only for wheel
    // tilt, but Ctrl+MMB keeps our horizontal/world-height drag plane.
    return cameraMouseDragModeForModifiers(altKey, ctrlKey);
  }

  private momentumGainForVelocity(
    velocity: number,
    momentum: CameraInputMomentumConfig,
  ): number {
    if (!this.usesMomentumGain() || !momentum.enabled) return 1;
    const minGain = Number.isFinite(momentum.minGain)
      ? Math.max(0, momentum.minGain)
      : 1;
    const maxGain = Number.isFinite(momentum.maxGain)
      ? Math.max(minGain, momentum.maxGain)
      : minGain;
    const maxVelocity = Number.isFinite(momentum.velocityForMaxGain)
      ? Math.max(1, momentum.velocityForMaxGain)
      : 1;
    const curve = Number.isFinite(momentum.curve)
      ? Math.max(0.01, momentum.curve)
      : 1;
    const t = Math.min(1, Math.max(0, velocity / maxVelocity));
    return minGain + (maxGain - minGain) * Math.pow(t, curve);
  }

  private mouseMomentumGain(
    dx: number,
    dy: number,
    timeMs: number,
    previousTimeMs: number,
    momentum: CameraInputMomentumConfig,
  ): number {
    if (!this.usesMomentumGain() || !momentum.enabled) return 1;
    const distancePx = Math.hypot(dx, dy);
    if (distancePx <= 0) return this.momentumGainForVelocity(0, momentum);
    const dtMs = Number.isFinite(timeMs) && Number.isFinite(previousTimeMs)
      ? timeMs - previousTimeMs
      : 0;
    const dtSec = dtMs > 0 ? dtMs / 1000 : 1 / 60;
    const velocity = distancePx / Math.max(dtSec, 1 / 240);
    return this.momentumGainForVelocity(velocity, momentum);
  }

  private wheelMomentumGain(
    e: WheelEvent,
    wheelDelta: number,
    momentum: CameraInputMomentumConfig,
  ): number {
    if (!this.usesMomentumGain() || !momentum.enabled) return 1;
    const nowMs = e.timeStamp;
    const elapsedMs = Number.isFinite(nowMs) && Number.isFinite(this.lastWheelTimeMs)
      ? nowMs - this.lastWheelTimeMs
      : Number.NaN;
    this.lastWheelTimeMs = nowMs;
    const dtMs = Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs <= WHEEL_MOMENTUM_RESET_MS
      ? elapsedMs
      : WHEEL_MOMENTUM_FALLBACK_DT_MS;
    const velocity = Math.abs(wheelDelta) / Math.max(dtMs / 1000, 1 / 240);
    return this.momentumGainForVelocity(velocity, momentum);
  }

  /** BAR/Recoil SpringController::MouseWheelMove + ZoomIn/ZoomOut. The
   * controller destination changes immediately; the rendered pose may still
   * transition toward it through tick(). Default zoom-out is screen-centered
   * and therefore changes only controller distance. */
  private zoomBarSpringAt(
    clientX: number,
    clientY: number,
    signedTicks: number,
    anchor: CameraAnchor,
  ): void {
    if (!Number.isFinite(signedTicks) || signedTicks === 0) return;
    const factor = barCameraRelativeZoomFactor(signedTicks, this.zoomStepFraction);
    const oldDistance = this.toDistance;
    const scaledDistance = this.clampBarDistance(oldDistance * factor);
    const elevationOffset = this.barFocusElevationOffset(
      this.toTargetX,
      this.toTargetY,
      this.toTargetZ,
    );
    const zoomElevationOffset = barCameraZoomElevationOffset(
      elevationOffset,
      oldDistance,
      scaledDistance,
      signedTicks < 0,
    );
    const applyDistanceOnly = (): void => {
      this.toDistance = scaledDistance;
      this.toTargetY = this.barFocusSurfaceHeight(
        this.toTargetX,
        this.toTargetZ,
        zoomElevationOffset,
        this.toTargetY,
      );
      this.clearZoomTerrainSamples();
      this.applyDestinationIfSnap();
    };

    // BAR's default cursorZoomOut=false: zooming out from screen center keeps
    // the focus fixed. A screen-center zoom-in likewise follows camera forward
    // and needs no focus translation.
    if (anchor.screen === 'screen-center') {
      applyDistanceOnly();
      return;
    }

    const controllerEye = this.cameraPositionForState(
      this.toTargetX,
      this.toTargetY,
      this.toTargetZ,
      oldDistance,
      this.toYaw,
      this.controllerPitch(),
      this._barControllerEyeTmp,
    );
    const renderedRay = this.barScreenRayDirection(clientX, clientY, anchor);
    if (!renderedRay || !this.traceWorldRay) {
      applyDistanceOnly();
      return;
    }

    const rayHit = this.traceWorldRay(
      controllerEye,
      renderedRay,
      anchor.terrain,
      this.toTargetY - elevationOffset,
    );
    if (!rayHit) {
      applyDistanceOnly();
      return;
    }
    const cursorDistance = controllerEye.distanceTo(rayHit);
    if (!(cursorDistance > 0)) {
      applyDistanceOnly();
      return;
    }

    this._barViewForwardTmp.set(
      this.toTargetX - controllerEye.x,
      this.toTargetY - controllerEye.y,
      this.toTargetZ - controllerEye.z,
    ).normalize();

    const maxZoomInFraction = oldDistance > 0
      ? Math.max(0, (oldDistance - this.minDistance) / oldDistance)
      : 0;
    const baseTravelFraction = signedTicks < 0
      ? Math.min(1 - factor, maxZoomInFraction)
      : 1 - factor;

    // The cursor-ray depth is discontinuous at silhouettes and its plane
    // fallback can be quasi-infinite; a single tick must never travel more
    // than the configured fraction of the current controller distance.
    const requestedTravel = Math.abs(baseTravelFraction) * cursorDistance;
    const maxTravel = this.zoomTravelClampFraction > 0
      ? this.zoomTravelClampFraction * oldDistance
      : Number.POSITIVE_INFINITY;
    const anchorTravelDistance = requestedTravel > maxTravel && requestedTravel > 0
      ? cursorDistance * (maxTravel / requestedTravel)
      : cursorDistance;

    const attempt = (travelScale: number): { distance: number; target: THREE.Vector3 } | null => {
      const wantedEye = this._barWantedEyeTmp.copy(controllerEye).addScaledVector(
        renderedRay,
        anchorTravelDistance * baseTravelFraction * travelScale,
      );
      const target = this.traceBarFocusSurface(
        wantedEye,
        this._barViewForwardTmp,
        anchor.terrain,
        zoomElevationOffset,
        this.toTargetY - elevationOffset,
      );
      if (!target) return null;
      return {
        distance: wantedEye.distanceTo(target),
        target: this._barTraceHitTmp.copy(target),
      };
    };

    let result = attempt(1);
    if (signedTicks > 0 && result && result.distance > this.maxDistance) {
      // Literal BAR edge behavior: retry cursor zoom-out at half travel; if it
      // still exceeds maxDist, reject the event rather than leaving a clipped
      // target/distance pair that can wedge at the rail.
      result = attempt(0.5);
      if (result && result.distance > this.maxDistance) result = null;
    }
    if (!result || !(result.distance > 0)) {
      if (signedTicks < 0) applyDistanceOnly();
      else this.applyDestinationIfSnap();
      return;
    }

    this.toTargetX = Math.min(this.targetMaxX, Math.max(this.targetMinX, result.target.x));
    this.toTargetZ = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, result.target.z));
    this.toTargetY = this.barFocusSurfaceHeight(
      this.toTargetX,
      this.toTargetZ,
      zoomElevationOffset,
      result.target.y,
    );
    this.toDistance = this.clampBarDistance(result.distance);
    this.clearZoomTerrainSamples();
    this.applyDestinationIfSnap();
  }

  private clampBarDistance(distance: number): number {
    return Math.min(
      this.maxDistance,
      Math.max(this.minDistance, Number.isFinite(distance) ? distance : this.minDistance),
    );
  }

  /** Direction of BAR's currently rendered cursor ray. This does not require
   * a terrain hit: SpringController still uses its horizontal focus-plane
   * fallback when the cursor points beyond the rendered map mesh. */
  private barScreenRayDirection(
    clientX: number,
    clientY: number,
    anchor: CameraAnchor,
  ): THREE.Vector3 | null {
    const screenPoint = this._anchorScreenPoint(
      clientX,
      clientY,
      anchor,
      this._zoomScreenAnchorTmp,
    );
    if (!screenPoint) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this._barScreenRayPointTmp.set(
      ((screenPoint.x - rect.left) / rect.width) * 2 - 1,
      -((screenPoint.y - rect.top) / rect.height) * 2 + 1,
      0.5,
    ).unproject(this.camera);
    this._barRenderedRayTmp.copy(this._barScreenRayPointTmp).sub(this.camera.position);
    if (this._barRenderedRayTmp.lengthSq() <= 1e-12) return null;
    return this._barRenderedRayTmp.normalize();
  }

  private barFocusElevationOffset(x: number, y: number, z: number): number {
    const ground = this.getTerrainHeight?.(x, z);
    return ground !== undefined && Number.isFinite(ground) ? y - ground : 0;
  }

  private barFocusSurfaceHeight(
    x: number,
    z: number,
    elevationOffset: number,
    fallback: number,
  ): number {
    const ground = this.getTerrainHeight?.(x, z);
    return ground !== undefined && Number.isFinite(ground)
      ? ground + elevationOffset
      : fallback;
  }

  /** Trace the terrain translated vertically by the controller's persistent
   * elevation offset. Translating the ray origin down, tracing real terrain,
   * then translating the hit back up is exact for a vertical translation. */
  private traceBarFocusSurface(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    terrainMode: CameraAnchorTerrain,
    elevationOffset: number,
    fallbackBaseHeight: number,
  ): THREE.Vector3 | null {
    if (!this.traceWorldRay) return null;
    const translatedOrigin = this._barTraceOriginTmp.copy(origin);
    translatedOrigin.y -= elevationOffset;
    const hit = this.traceWorldRay(
      translatedOrigin,
      direction,
      terrainMode,
      fallbackBaseHeight,
    );
    if (!hit) return null;
    return this._barTraceHitTmp.copy(hit).setY(hit.y + elevationOffset);
  }

  private zoomByFactorAt(
    clientX: number,
    clientY: number,
    wantFactor: number,
    anchor?: CameraAnchor,
  ): void {
    if (!Number.isFinite(wantFactor) || wantFactor <= 0 || this.toDistance <= 0) return;
    const resolvedAnchor = anchor ?? (wantFactor < 1 ? this.zoomInAnchor : this.zoomOutAnchor);
    const centerHit = this._anchorWorldPoint(clientX, clientY, resolvedAnchor);
    if (!centerHit) {
      this.clearZoomTerrainSamples();
      this.zoomByResolvedAnchorFactor(wantFactor, null);
      return;
    }

    // CursorGround returns shared scratch storage, so retain the exact center
    // anchor before resolving the uniform 17-probe distance set below.
    this._zoomCenterTmp.copy(centerHit);
    const pivot = this.resolveAveragedZoomPivot(
      clientX,
      clientY,
      wantFactor,
      resolvedAnchor,
      this._zoomCenterTmp,
    );
    this.zoomByResolvedAnchorFactor(wantFactor, pivot);
  }

  /** Resolve the center plus zero, one, or two screen-space rings, then place
   *  the actual scale pivot on the center ray at the selected aggregate depth.
   *  All aggregation probes use the same fast heightfield ray solver — mixing
   *  one mesh intersection with sixteen height samples biased MIN toward the
   *  center on cliffs/occluded terrain. Scaling camera + target around a point
   *  on the center ray keeps the center terrain point on the same pixel while
   *  making travel depend on the configured neighborhood scalar. */
  private resolveAveragedZoomPivot(
    clientX: number,
    clientY: number,
    wantFactor: number,
    anchor: CameraAnchor,
    center: THREE.Vector3,
  ): THREE.Vector3 {
    const screenAnchor = this._anchorScreenPoint(
      clientX,
      clientY,
      anchor,
      this._zoomScreenAnchorTmp,
    );
    // The exact mesh hit supplied by zoomByFactorAt is retained only as a
    // fallback. The central distance probe must go through the same solver as
    // all sixteen neighbors, otherwise MIN compares different surfaces and
    // the center can win simply because it was sampled more accurately.
    const sampledCenterHit = screenAnchor && this.getZoomSampleWorldPoint
      ? this.getZoomSampleWorldPoint(
          screenAnchor.x,
          screenAnchor.y,
          anchor.terrain,
          center.y,
        )
      : center;
    const sampledCenter = this._zoomSampleCenterTmp.copy(sampledCenterHit ?? center);
    const samples = this.zoomTerrainSamples;
    const motionCamera = this.cameraPositionForState(
      this.toTargetX,
      this.toTargetY,
      this.toTargetZ,
      this.toDistance,
      this.toYaw,
      this.pitch,
      this._cameraPosTmp,
    );
    // The 17 sample rays originate at the rendered camera, so compare their
    // distances from that same camera. Using the smooth TO-state here mixed
    // two camera poses during an EMA zoom and could make the center look like
    // it always won the min reduction.
    const sampleCamera = this.camera.position;
    const centerDistance = sampleCamera.distanceTo(sampledCenter);
    const motionCenterDistance = motionCamera.distanceTo(sampledCenter);

    let sum = this.writeZoomTerrainSample(0, sampledCenter, sampleCamera);
    let minDistance = samples.distances[0];
    let minSampleIndex = 0;
    let sampleIndex = 1;
    const ringPointCount = samples.ringPointCount;
    const sampledRingCount = this.zoomDistanceSampling.pointMode === 'single'
      ? 0
      : this.zoomDistanceSampling.pointMode === 'nine'
        ? 1
        : 2;
    const targetSampleCount = 1 + sampledRingCount * ringPointCount;
    const innerRadius = Math.max(0, this.zoomDistanceSampling.innerRadiusPixels);
    const outerRadius = Math.max(innerRadius, this.zoomDistanceSampling.outerRadiusPixels);

    if (screenAnchor && sampledRingCount > 0) {
      for (let ring = 0; ring < sampledRingCount; ring++) {
        const radius = ring === 0 ? innerRadius : outerRadius;
        for (let i = 0; i < ringPointCount; i++) {
          const angle = (i / ringPointCount) * Math.PI * 2;
          const sampleClientX = screenAnchor.x + Math.cos(angle) * radius;
          const sampleClientY = screenAnchor.y + Math.sin(angle) * radius;
          const hit = this.getZoomSampleWorldPoint
            ? this.getZoomSampleWorldPoint(
                sampleClientX,
                sampleClientY,
                anchor.terrain,
                sampledCenter.y,
              )
            : this._worldPointForScreenPoint(
                sampleClientX,
                sampleClientY,
                anchor.terrain,
              );
          // A peripheral ray can miss the rendered surface at a very low
          // pitch or canvas edge. Reusing the center gives every zoom event
          // the configured equal weights without introducing a stale or
          // arbitrary distance. The shared debug buffer records that exact
          // fallback position too.
          const distance = this.writeZoomTerrainSample(
            sampleIndex,
            hit ?? sampledCenter,
            sampleCamera,
          );
          sum += distance;
          if (distance < minDistance) {
            minDistance = distance;
            minSampleIndex = sampleIndex;
          }
          sampleIndex += 1;
        }
      }
    } else {
      while (sampleIndex < targetSampleCount) {
        const distance = this.writeZoomTerrainSample(
          sampleIndex,
          sampledCenter,
          sampleCamera,
        );
        sum += distance;
        if (distance < minDistance) {
          minDistance = distance;
          minSampleIndex = sampleIndex;
        }
        sampleIndex += 1;
      }
    }

    const aggregation = this.zoomDistanceSampling.distanceAggregation;
    const flags = samples.selectedFlags;
    flags.fill(0);
    let aggregateDistance: number;
    if (aggregation === 'average') {
      aggregateDistance = sum / sampleIndex;
    } else if (aggregation === 'min') {
      aggregateDistance = minDistance;
      flags[minSampleIndex] = 1;
    } else {
      aggregateDistance = averageOfShortestDistances(
        samples.distances,
        sampleIndex,
        zoomAggregationShortestCount(aggregation),
        flags,
      );
      if (!Number.isFinite(aggregateDistance)) aggregateDistance = minDistance;
    }
    let appliedAggregateDistance = aggregateDistance;
    if (wantFactor < 1 && motionCenterDistance > 1e-6) {
      // A deep valley beside an extremely close peak can otherwise ask one
      // tick to cross the center anchor. Keep a small, configured amount of
      // center-ray depth while preserving the selected aggregate in every
      // normal case.
      const retained = Math.min(
        0.99,
        Math.max(0, this.zoomDistanceSampling.minCenterDistanceFraction),
      );
      const maxTravel = motionCenterDistance * (1 - retained);
      const maxAggregateDistance = maxTravel / Math.max(1e-6, 1 - wantFactor);
      appliedAggregateDistance = Math.min(aggregateDistance, maxAggregateDistance);
    }

    samples.count = sampleIndex;
    samples.aggregation = aggregation;
    samples.aggregateDistance = aggregateDistance;
    samples.appliedAggregateDistance = appliedAggregateDistance;
    samples.centerDistance = centerDistance;
    samples.selectedSampleIndex = aggregation === 'average' ? -1 : minSampleIndex;
    samples.sampledAtMilliseconds = performance.now();
    samples.version += 1;

    if (!(motionCenterDistance > 1e-6) || !Number.isFinite(appliedAggregateDistance)) {
      return center;
    }
    const depthScale = appliedAggregateDistance / motionCenterDistance;
    return this._zoomPivotTmp.set(
      motionCamera.x + (sampledCenter.x - motionCamera.x) * depthScale,
      motionCamera.y + (sampledCenter.y - motionCamera.y) * depthScale,
      motionCamera.z + (sampledCenter.z - motionCamera.z) * depthScale,
    );
  }

  private writeZoomTerrainSample(
    index: number,
    point: THREE.Vector3,
    cameraPosition: THREE.Vector3,
  ): number {
    const offset = index * 3;
    const positions = this.zoomTerrainSamples.positions;
    positions[offset] = point.x;
    positions[offset + 1] = point.y;
    positions[offset + 2] = point.z;
    const distance = cameraPosition.distanceTo(point);
    this.zoomTerrainSamples.distances[index] = distance;
    return distance;
  }

  private clearZoomTerrainSamples(): void {
    this.zoomTerrainSamples.count = 0;
    this.zoomTerrainSamples.selectedFlags.fill(0);
    this.zoomTerrainSamples.aggregateDistance = 0;
    this.zoomTerrainSamples.appliedAggregateDistance = 0;
    this.zoomTerrainSamples.centerDistance = 0;
    this.zoomTerrainSamples.selectedSampleIndex = -1;
    this.zoomTerrainSamples.sampledAtMilliseconds = performance.now();
    this.zoomTerrainSamples.version += 1;
  }

  private zoomByWorldStepAt(
    clientX: number,
    clientY: number,
    worldStep: number,
    anchor?: CameraAnchor,
  ): void {
    if (!Number.isFinite(worldStep) || worldStep === 0 || !Number.isFinite(this.toDistance)) {
      return;
    }
    const resolvedAnchor = anchor ?? (worldStep < 0 ? this.zoomInAnchor : this.zoomOutAnchor);
    const cam = this.cameraPositionForState(
      this.toTargetX,
      this.toTargetY,
      this.toTargetZ,
      this.toDistance,
      this.toYaw,
      this.pitch,
      this._cameraPosTmp,
    );
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const targetToCameraX = sinP * Math.sin(this.toYaw);
    const targetToCameraY = cosP;
    const targetToCameraZ = sinP * -Math.cos(this.toYaw);
    let moveX = worldStep < 0 ? -targetToCameraX : targetToCameraX;
    let moveY = worldStep < 0 ? -targetToCameraY : targetToCameraY;
    let moveZ = worldStep < 0 ? -targetToCameraZ : targetToCameraZ;

    const p0 = this._anchorWorldPoint(clientX, clientY, resolvedAnchor);
    if (p0) {
      const anchorDx = p0.x - cam.x;
      const anchorDy = p0.y - cam.y;
      const anchorDz = p0.z - cam.z;
      const anchorDistance = Math.hypot(anchorDx, anchorDy, anchorDz);
      if (anchorDistance > 1e-6) {
        const anchorDirSign = worldStep < 0 ? 1 : -1;
        moveX = (anchorDx / anchorDistance) * anchorDirSign;
        moveY = (anchorDy / anchorDistance) * anchorDirSign;
        moveZ = (anchorDz / anchorDistance) * anchorDirSign;
      }
    }

    const cameraTravel = Math.abs(worldStep);
    this.toTargetX += moveX * cameraTravel;
    this.toTargetY += moveY * cameraTravel;
    this.toTargetZ += moveZ * cameraTravel;
    this.toDistance = this.constrainOrbitDistance(
      this.toDistance,
      this.toTargetX,
      this.toTargetY,
      this.toTargetZ,
      this.toYaw,
      this.pitch,
    );
    this.applyDestinationIfSnap();
  }

  private zoomByResolvedAnchorFactor(
    wantFactor: number,
    p0: THREE.Vector3 | null,
  ): void {
    if (!Number.isFinite(wantFactor) || wantFactor <= 0 || this.toDistance <= 0) return;
    // Bound this tick's eye travel by the camera's own scale first: the
    // anchor stays where it is, but a silhouette or fallback anchor at
    // pathological depth can only pull the eye a configured fraction of the
    // current distance per tick.
    let travelSafeFactor = wantFactor;
    if (p0) {
      const controllerEye = this.cameraPositionForState(
        this.toTargetX,
        this.toTargetY,
        this.toTargetZ,
        this.toDistance,
        this.toYaw,
        this.pitch,
        this._cameraPosTmp,
      );
      travelSafeFactor = barCameraTravelClampedZoomFactor(
        wantFactor,
        controllerEye.distanceTo(p0),
        this.toDistance,
        this.zoomTravelClampFraction,
      );
    }
    // Clamp the factor BEFORE it translates target + eye around an anchor,
    // so an outward zoom ends exactly on the eye-distance rail instead of
    // leaving an impossible target/rail combination for the distance solver.
    const railSafeFactor = p0
      ? this.constrainZoomFactorToCameraRail(travelSafeFactor, p0)
      : travelSafeFactor;
    const wantedDistance = this.toDistance * railSafeFactor;
    const startTargetX = this.toTargetX;
    const startTargetY = this.toTargetY;
    const startTargetZ = this.toTargetZ;
    let nextDistance = Math.max(this.minDistance, wantedDistance);
    let actualFactor = nextDistance / this.toDistance;
    let nextTargetX = startTargetX;
    let nextTargetY = startTargetY;
    let nextTargetZ = startTargetZ;
    const resolveTarget = (): void => {
      nextTargetX = startTargetX;
      nextTargetY = startTargetY;
      nextTargetZ = startTargetZ;
      if (!p0) return;
      const k = 1 - actualFactor;
      // Blend ALL THREE target axes toward p0 — Y matters because
      // the cursor pin invariant is c'_new = α·c + (1-α)·p0 in 3D,
      // not just XZ. Skipping Y leaves newCamera.y at α·c.y +
      // (1-α)·target.y instead of α·c.y + (1-α)·p0.y, and the
      // cursor pin drifts vertically by (1-α)·(p0.y - target.y)
      // per scroll / pinch whenever the user zooms over terrain at
      // a different height than target.y.
      nextTargetX = actualFactor * startTargetX + k * p0.x;
      nextTargetY = actualFactor * startTargetY + k * p0.y;
      nextTargetZ = actualFactor * startTargetZ + k * p0.z;
    };
    resolveTarget();

    for (let i = 0; i < 3; i++) {
      const constrainedDistance = this.constrainOrbitDistance(
        nextDistance,
        nextTargetX,
        nextTargetY,
        nextTargetZ,
        this.toYaw,
        this.pitch,
      );
      if (constrainedDistance === nextDistance) break;
      nextDistance = constrainedDistance;
      actualFactor = nextDistance / this.toDistance;
      resolveTarget();
    }

    if (
      nextDistance === this.toDistance &&
      nextTargetX === startTargetX &&
      nextTargetY === startTargetY &&
      nextTargetZ === startTargetZ
    ) {
      return;
    }

    // No terrain clip-test here: eye clearance is resolved by the configured
    // terrain-collision mode in apply(), and the focus floor/ceiling by
    // constrainTargets(), so the committed state passes through the same
    // invariants as every other gesture.
    this.toTargetX = nextTargetX;
    this.toTargetY = nextTargetY;
    this.toTargetZ = nextTargetZ;
    this.toDistance = nextDistance;

    this.applyDestinationIfSnap();
  }

  private worldStepForZoomFactor(factor: number): number {
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return 0;
    const baseInFraction = Math.max(1e-6, Math.min(0.95, this.zoomStepFraction));
    if (factor < 1) {
      return -(
        this.movementConfig.zoomIn.absoluteWorldUnitsPerWheelTick
        * ((1 - factor) / baseInFraction)
      );
    }
    const baseOutFactor = 1 + baseInFraction;
    return (
      this.movementConfig.zoomOut.absoluteWorldUnitsPerWheelTick
      * ((factor - 1) / (baseOutFactor - 1))
    );
  }

  /** Capture the complete start pose for the philosophy's anchored rigid
   * tumble. Keeping this in one path is important because BAR permits Alt to
   * be pressed or released while middle mouse remains held. */
  private captureOrbitPivot(clientX: number, clientY: number): void {
    const hit = this._anchorWorldPoint(clientX, clientY, this.rotateAnchor);
    if (!hit) {
      this.orbitPivotActive = false;
      return;
    }
    this.orbitPivot.copy(hit);
    this.apply();
    this.orbitStartCamPos.copy(this.camera.position);
    this.orbitStartYaw = this.yaw;
    this.orbitStartPitch = this.pitch;
    this.orbitStartDistance = this.distance;
    this.orbitYawAccum = 0;
    this.orbitPitchAccum = 0;
    this.orbitPivotActive = true;
  }

  private capturePanAnchor(clientX: number, clientY: number): void {
    // Capture the cursor's 3D ground point + camera-to-anchor
    // distance. The distance is what worldPerPixel keys off during
    // the drag — bounded at every camera pitch (no blowup at
    // near-horizontal views), and accurate to the depth the user
    // actually grabbed.
    const hit = this._anchorWorldPoint(clientX, clientY, this.panAnchorMode);
    if (hit) {
      this.panAnchor.copy(hit);
      const dxh = this.camera.position.x - hit.x;
      const dyh = this.camera.position.y - hit.y;
      const dzh = this.camera.position.z - hit.z;
      this.panAnchorDistance = Math.hypot(dxh, dyh, dzh);
      this.panAnchorValid = true;
    } else {
      this.panAnchorValid = false;
      this.panAnchorDistance = this.distance;
    }
  }

  private panWorldScale(mode: 'pan' | 'height-pan' = 'pan'): number {
    if (this.usesAbsoluteWorldMovement()) {
      const movement = mode === 'height-pan'
        ? this.movementConfig.ctrlCenterClickHeightPan
        : this.movementConfig.centerClickPan;
      return Math.max(0, movement.absoluteWorldUnitsPerPixel);
    }
    // SpringController derives pixel size from curDist, never from the depth
    // under the cursor. Use the destination controller distance so a smooth
    // transition cannot feed back into the next input event.
    const refDist = this.usesBarSpringMovement()
      ? this.toDistance
      : this.panAnchorValid ? this.panAnchorDistance : this.distance;
    // A zero-height canvas (mid-layout, detached tab) would make this
    // Infinity and poison the target state through one drag event.
    const canvasHeight = this.canvas.clientHeight;
    if (!(canvasHeight > 0)) return 0;
    const vFovRad = (this.camera.fov * Math.PI) / 180;
    const worldPerPixel =
      (2 * Math.tan(vFovRad / 2) * refDist) / canvasHeight;
    return worldPerPixel * this.panMultiplier;
  }

  private panByScreenDelta(dx: number, dy: number, mode: 'pan' | 'height-pan' = 'pan'): void {
    if (dx === 0 && dy === 0) return;
    this.beginContinuousMovement();
    // Move-the-camera pan with bounded magnitude: world-per-pixel
    // is keyed to the camera-to-anchor distance captured at
    // drag-start (not the orbit target distance, not the current
    // rendered distance). That gives the right pan rate for the
    // depth the user grabbed, but stays bounded at every camera
    // pitch — no exact-3D plane-raycast blowup when the camera is
    // near horizontal. Drag direction is RTS / 2D-camera convention:
    // cursor drag direction = camera drag direction in world.
    const scale = this.panWorldScale(mode);
    const panYaw = this.controllerYaw();
    const rx = Math.cos(panYaw);
    const rz = Math.sin(panYaw);
    const fx = Math.sin(panYaw);
    const fz = -Math.cos(panYaw);
    const elevationOffset = this.usesTerrainFollowFocus()
      ? this.barFocusElevationOffset(this.toTargetX, this.toTargetY, this.toTargetZ)
      : 0;
    this.toTargetX -= dx * scale * rx - dy * scale * fx;
    this.toTargetZ -= dx * scale * rz - dy * scale * fz;
    if (this.usesBarSpringMovement()) {
      this.toTargetX = Math.min(this.targetMaxX, Math.max(this.targetMinX, this.toTargetX));
      this.toTargetZ = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, this.toTargetZ));
      // Constant-altitude flight: pan never changes focus height. Only the
      // terrain-follow mode reseats Y onto the bed-plus-offset surface.
      if (this.usesTerrainFollowFocus()) {
        this.toTargetY = this.barFocusSurfaceHeight(
          this.toTargetX,
          this.toTargetZ,
          elevationOffset,
          this.toTargetY,
        );
      }
    }
    this.finishContinuousMovement();
  }

  private panHeightByScreenDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.beginContinuousMovement();
    const scale = this.panWorldScale('height-pan');
    const panYaw = this.controllerYaw();
    const rx = Math.cos(panYaw);
    const rz = Math.sin(panYaw);
    const elevationOffset = this.usesTerrainFollowFocus()
      ? this.barFocusElevationOffset(this.toTargetX, this.toTargetY, this.toTargetZ)
      : 0;
    // Sim calls this vertical axis Z; Three.js stores it as world Y.
    // Dragging up (negative screen Y delta) raises the target.
    this.toTargetX -= dx * scale * rx;
    this.toTargetZ -= dx * scale * rz;
    this.toTargetY -= dy * scale;
    if (this.usesBarSpringMovement()) {
      this.toTargetX = Math.min(this.targetMaxX, Math.max(this.targetMinX, this.toTargetX));
      this.toTargetZ = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, this.toTargetZ));
      // Constant-altitude mode keeps the direct world-height change; the
      // focus floor/ceiling in constrainTargets bounds it. Terrain-follow
      // folds the change into its persistent bed offset.
      if (this.usesTerrainFollowFocus()) {
        this.toTargetY = this.barFocusSurfaceHeight(
          this.toTargetX,
          this.toTargetZ,
          elevationOffset - dy * scale,
          this.toTargetY,
        );
      }
    }
    this.finishContinuousMovement();
  }

  private panByTouchScreenDelta(dx: number, dy: number): void {
    // Mobile uses the standard map gesture: the world follows the
    // finger. Desktop middle-drag still uses the configured
    // CAMERA_PAN_MULTIPLIER, but touch should feel 1:1, so divide it
    // out before going through the shared pan math.
    if (this.usesAbsoluteWorldMovement()) {
      this.panByScreenDelta(-dx, -dy, 'pan');
      return;
    }
    const multiplier = this.panMultiplier > 0 ? this.panMultiplier : 1;
    this.panByScreenDelta(-dx / multiplier, -dy / multiplier, 'pan');
  }

  moveByKeyboardScreenDirection(
    mode: 'pan' | 'height-pan' | 'orbit',
    screenX: number,
    screenY: number,
    fast = false,
  ): void {
    const magnitude = Math.hypot(screenX, screenY);
    if (magnitude <= 0) return;
    this.cancelMapRecovery();
    const x = screenX / magnitude;
    const y = screenY / magnitude;
    const step = KEYBOARD_CAMERA_SCREEN_STEP_PX * (fast ? KEYBOARD_CAMERA_FAST_MULTIPLIER : 1);
    if (mode === 'pan') {
      this.panByScreenDelta(-x * step, -y * step, 'pan');
      return;
    }
    if (mode === 'height-pan') {
      this.panHeightByScreenDelta(-x * step, -y * step);
      return;
    }
    this.orbitByScreenDelta(x * step, -y * step);
  }

  private orbitByScreenDelta(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (this.usesBarSpringTransition()) this.beginContinuousMovement();
    const radiansPerPixel = this.orbitRadiansPerPixel();
    if (this.usesBarSpringMovement()) {
      this.barRawYaw -= dx * radiansPerPixel;
      this.toYaw = this.resolveBarYaw(this.barRawYaw);
      this.toPitch = Math.min(
        this.maxPitch,
        Math.max(this.minPitch, this.controllerPitch() + dy * radiansPerPixel),
      );
      if (!this.usesBarSpringTransition()) {
        this.yaw = this.toYaw;
        this.pitch = this.toPitch;
      }
    } else {
      this.yaw -= dx * radiansPerPixel;
      this.pitch += dy * radiansPerPixel;
      this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch));
      this.toYaw = this.yaw;
      this.toPitch = this.pitch;
    }
    if (this.usesBarSpringTransition()) this.finishContinuousMovement();
    else this.apply();
  }

  private rotateYawAroundScreenPoint(clientX: number, clientY: number, yawDelta: number): void {
    if (!Number.isFinite(yawDelta) || yawDelta === 0) return;
    if (this.usesBarSpringMovement()) {
      if (this.usesBarSpringTransition()) this.beginContinuousMovement();
      this.barRawYaw += yawDelta;
      this.toYaw = this.resolveBarYaw(this.barRawYaw);
      if (this.usesBarSpringTransition()) this.finishContinuousMovement();
      else {
        this.yaw = this.toYaw;
        this.apply();
      }
      return;
    }
    const oldYaw = this.yaw;
    const newYaw = oldYaw + yawDelta;
    const pivot = this._anchorWorldPoint(clientX, clientY, this.rotateAnchor);
    if (!pivot) {
      this.yaw = newYaw;
      this.toYaw = this.yaw;
      this.apply();
      return;
    }

    this.apply();
    const sinP = Math.sin(this.pitch);
    const cosP = Math.cos(this.pitch);
    const oldDirX = sinP * Math.sin(oldYaw);
    const oldDirY = cosP;
    const oldDirZ = sinP * -Math.cos(oldYaw);
    const newDirX = sinP * Math.sin(newYaw);
    const newDirY = cosP;
    const newDirZ = sinP * -Math.cos(newYaw);

    this._orbitYawQuatTmp.setFromAxisAngle(OrbitCamera._ORBIT_WORLD_Y, -yawDelta);

    // Rotate the rendered camera around the configured rotate anchor,
    // then synthesize the target that preserves that new camera pose
    // for the normal orbit state.
    this._orbitOffsetTmp.copy(this.camera.position).sub(pivot);
    this._orbitOffsetTmp.applyQuaternion(this._orbitYawQuatTmp);
    const camX = pivot.x + this._orbitOffsetTmp.x;
    const camY = pivot.y + this._orbitOffsetTmp.y;
    const camZ = pivot.z + this._orbitOffsetTmp.z;
    this.target.set(
      camX - this.distance * newDirX,
      camY - this.distance * newDirY,
      camZ - this.distance * newDirZ,
    );

    // Mirror the same rigid rotation into the smooth destination so
    // zoom easing continues from the rotated endpoint instead of
    // pulling the view back toward the pre-twist heading.
    const toCamX = this.toTargetX + this.toDistance * oldDirX;
    const toCamY = this.toTargetY + this.toDistance * oldDirY;
    const toCamZ = this.toTargetZ + this.toDistance * oldDirZ;
    this._orbitOffsetTmp.set(toCamX - pivot.x, toCamY - pivot.y, toCamZ - pivot.z);
    this._orbitOffsetTmp.applyQuaternion(this._orbitYawQuatTmp);
    const toRotCamX = pivot.x + this._orbitOffsetTmp.x;
    const toRotCamY = pivot.y + this._orbitOffsetTmp.y;
    const toRotCamZ = pivot.z + this._orbitOffsetTmp.z;
    this.toTargetX = toRotCamX - this.toDistance * newDirX;
    this.toTargetY = toRotCamY - this.toDistance * newDirY;
    this.toTargetZ = toRotCamZ - this.toDistance * newDirZ;

    this.yaw = newYaw;
    this.toYaw = this.yaw;
    this.apply();
  }

  private touchCenter(e: TouchEvent): { x: number; y: number } {
    const a = e.touches[0];
    const b = e.touches.length >= 2 ? e.touches[1] : null;
    if (!b) return { x: a.clientX, y: a.clientY };
    return {
      x: (a.clientX + b.clientX) * 0.5,
      y: (a.clientY + b.clientY) * 0.5,
    };
  }

  private touchDistance(e: TouchEvent): number {
    if (e.touches.length < 2) return 0;
    const a = e.touches[0];
    const b = e.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  private touchAngle(e: TouchEvent): number {
    if (e.touches.length < 2) return Number.NaN;
    const a = e.touches[0];
    const b = e.touches[1];
    return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
  }

  /** Single choke point for every state commit: sanitize, then clamp
   *  rendered and smooth-destination state to the active camera rails.
   *  Keeping both states constrained avoids a smoothing tug-of-war at
   *  map edges and zoom rails, and makes an impossible camera pose
   *  unrepresentable regardless of which gesture or driver wrote it. */
  private constrainTargets(): void {
    this.sanitizeCameraState();
    if (this.usesBarSpringTransition()) {
      const elevationOffset = this.usesTerrainFollowFocus()
        ? this.barFocusElevationOffset(this.toTargetX, this.toTargetY, this.toTargetZ)
        : 0;
      this.toTargetX = Math.min(this.targetMaxX, Math.max(this.targetMinX, this.toTargetX));
      this.toTargetZ = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, this.toTargetZ));
      this.toTargetY = this.usesTerrainFollowFocus()
        ? this.barFocusSurfaceHeight(
            this.toTargetX,
            this.toTargetZ,
            elevationOffset,
            this.toTargetY,
          )
        : this.clampFocusAltitude(this.toTargetX, this.toTargetZ, this.toTargetY);
      this.toPitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.toPitch));
      // SpringController has no map-center eye sphere. Its focus is map-bound
      // and curDist is independently clamped to minDist/maxDist.
      this.toDistance = this.clampBarDistance(this.toDistance);
      // BAR exposes controller focus/distance immediately while the active
      // camera's eye and rotation transition independently toward them.
      this.target.set(this.toTargetX, this.toTargetY, this.toTargetZ);
      this.distance = this.toDistance;
      return;
    }
    const renderedElevationOffset = this.usesTerrainFollowFocus()
      ? this.barFocusElevationOffset(this.target.x, this.target.y, this.target.z)
      : 0;
    const destinationElevationOffset = this.usesTerrainFollowFocus()
      ? this.barFocusElevationOffset(this.toTargetX, this.toTargetY, this.toTargetZ)
      : 0;
    if (Number.isFinite(this.targetMinX) || Number.isFinite(this.targetMaxX)) {
      this.target.x = Math.min(this.targetMaxX, Math.max(this.targetMinX, this.target.x));
      this.toTargetX = Math.min(this.targetMaxX, Math.max(this.targetMinX, this.toTargetX));
    }
    if (Number.isFinite(this.targetMinZ) || Number.isFinite(this.targetMaxZ)) {
      this.target.z = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, this.target.z));
      this.toTargetZ = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, this.toTargetZ));
    }
    if (this.usesTerrainFollowFocus()) {
      this.target.y = this.barFocusSurfaceHeight(
        this.target.x,
        this.target.z,
        renderedElevationOffset,
        this.target.y,
      );
      this.toTargetY = this.barFocusSurfaceHeight(
        this.toTargetX,
        this.toTargetZ,
        destinationElevationOffset,
        this.toTargetY,
      );
    } else {
      this.target.y = this.clampFocusAltitude(this.target.x, this.target.z, this.target.y);
      this.toTargetY = this.clampFocusAltitude(this.toTargetX, this.toTargetZ, this.toTargetY);
    }
    this.toPitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.toPitch));
    this.pitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.pitch));
    if (this.usesBarSpringMovement()) {
      this.distance = this.clampBarDistance(this.distance);
      this.toDistance = this.clampBarDistance(this.toDistance);
    } else {
      this.distance = this.constrainOrbitDistance(
        this.distance,
        this.target.x,
        this.target.y,
        this.target.z,
        this.yaw,
        this.pitch,
      );
      this.toDistance = this.constrainOrbitDistance(
        this.toDistance,
        this.toTargetX,
        this.toTargetY,
        this.toTargetZ,
        this.toYaw,
        this.pitch,
      );
    }
  }

  /** Focus altitude band for every mode that does not glue the focus to the
   *  terrain: never below the bed beneath it (the basin floor under water —
   *  the water surface is not a camera constraint), and never further above
   *  that bed than the zoom-out distance rail. The upper bound is what stops
   *  height-pan plus committed collision lift from ratcheting the camera
   *  into a sky-only view; the lower bound is what stops minimap jumps and
   *  ping cuts from parking the focus inside a mountain. */
  private clampFocusAltitude(x: number, z: number, y: number): number {
    const ground = this.getTerrainHeight?.(x, z);
    if (ground === undefined || !Number.isFinite(ground)) return y;
    const ceiling = Number.isFinite(this.maxDistance)
      ? ground + this.maxDistance
      : Number.POSITIVE_INFINITY;
    return Math.min(ceiling, Math.max(ground, y));
  }

  /** Replace any non-finite camera field with a safe value. This should be
   *  unreachable; when it fires, something upstream produced NaN/Infinity,
   *  so the first few occurrences are reported loudly instead of being
   *  silently absorbed into a "camera randomly broke" mystery. */
  private sanitizeCameraState(): void {
    const fallbackX = Number.isFinite(this.targetMinX) && Number.isFinite(this.targetMaxX)
      ? (this.targetMinX + this.targetMaxX) * 0.5
      : 0;
    const fallbackZ = Number.isFinite(this.targetMinZ) && Number.isFinite(this.targetMaxZ)
      ? (this.targetMinZ + this.targetMaxZ) * 0.5
      : 0;
    this.toTargetX = this.finiteOr(this.toTargetX, fallbackX, 'toTargetX');
    this.toTargetZ = this.finiteOr(this.toTargetZ, fallbackZ, 'toTargetZ');
    this.target.x = this.finiteOr(this.target.x, this.toTargetX, 'target.x');
    this.target.z = this.finiteOr(this.target.z, this.toTargetZ, 'target.z');
    if (!Number.isFinite(this.toTargetY)) {
      const ground = this.getTerrainHeight?.(this.toTargetX, this.toTargetZ);
      this.toTargetY = this.finiteOr(
        this.toTargetY,
        ground !== undefined && Number.isFinite(ground) ? ground : 0,
        'toTargetY',
      );
    }
    this.target.y = this.finiteOr(this.target.y, this.toTargetY, 'target.y');
    this.toDistance = this.finiteOr(this.toDistance, this.farReferenceDistance, 'toDistance');
    this.distance = this.finiteOr(this.distance, this.toDistance, 'distance');
    this.toYaw = this.finiteOr(this.toYaw, 0, 'toYaw');
    this.yaw = this.finiteOr(this.yaw, this.toYaw, 'yaw');
    this.barRawYaw = this.finiteOr(this.barRawYaw, this.toYaw, 'barRawYaw');
    this.toPitch = this.finiteOr(this.toPitch, Math.PI * 0.25, 'toPitch');
    this.pitch = this.finiteOr(this.pitch, this.toPitch, 'pitch');
    // Endlessly wound yaw (hours of lobby auto-rotate) slowly loses float
    // precision. Renormalize all yaw fields together, far outside one turn,
    // so no in-flight transition ever sees a synthetic delta.
    if (Math.abs(this.yaw) > 4 * Math.PI || Math.abs(this.toYaw) > 4 * Math.PI) {
      this.yaw = OrbitCamera.normalizeAngleDelta(this.yaw);
      this.toYaw = OrbitCamera.normalizeAngleDelta(this.toYaw);
      this.barRawYaw = OrbitCamera.normalizeAngleDelta(this.barRawYaw);
    }
  }

  private finiteOr(value: number, fallback: number, field: string): number {
    if (Number.isFinite(value)) return value;
    if (this.invariantWarningCount < MAX_INVARIANT_WARNINGS) {
      this.invariantWarningCount += 1;
      console.error(
        `[OrbitCamera] non-finite ${field} replaced with ${fallback} — upstream camera-input bug`,
      );
    }
    return fallback;
  }

  private constrainOrbitDistance(
    distance: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    yaw: number,
    pitch: number,
  ): number {
    const baseDistance = Number.isFinite(distance) ? distance : this.minDistance;
    const minClamped = Math.min(
      this.maxDistance,
      Math.max(this.minDistance, baseDistance),
    );
    if (!Number.isFinite(this.maxCameraDistanceFromOrigin)) return minClamped;

    const sinP = Math.sin(pitch);
    const dirX = sinP * Math.sin(yaw);
    const dirY = Math.cos(pitch);
    const dirZ = sinP * -Math.cos(yaw);
    const relX = targetX - this.cameraDistanceOrigin.x;
    const relY = targetY - this.cameraDistanceOrigin.y;
    const relZ = targetZ - this.cameraDistanceOrigin.z;
    const b = relX * dirX + relY * dirY + relZ * dirZ;
    const c =
      relX * relX +
      relY * relY +
      relZ * relZ -
      this.maxCameraDistanceFromOrigin * this.maxCameraDistanceFromOrigin;
    const discriminant = b * b - c;
    // The target can transiently be outside the eye-distance sphere (for
    // example after a horizon-facing gesture). There is then no valid orbit
    // distance along this yaw/pitch ray. Preserve the current requested
    // distance rather than snapping to minDistance, which teleported the view
    // under/away from the map and made a normal zoom-in feel dead.
    if (discriminant < 0) return minClamped;

    const maxOrbitDistance = -b + Math.sqrt(discriminant);
    if (!Number.isFinite(maxOrbitDistance) || maxOrbitDistance <= 0) return minClamped;
    return Math.min(minClamped, Math.max(this.minDistance, maxOrbitDistance));
  }

  /** Restrict a cursor-pinned zoom factor so the resulting destination eye
   *  stays inside maxCameraDistanceFromOrigin. The camera motion caused by a
   *  factor is a straight segment:
   *
   *    eye' = factor·eye + (1−factor)·anchor
   *
   *  so a simple segment/sphere intersection gives the largest legal fraction
   *  of the requested gesture. This is applied before target movement, unlike
   *  constrainOrbitDistance(), and therefore cannot create a contradictory
   *  far-away target with a tiny forced orbit distance. */
  private constrainZoomFactorToCameraRail(
    wantFactor: number,
    anchor: THREE.Vector3,
  ): number {
    if (!Number.isFinite(this.maxCameraDistanceFromOrigin)) return wantFactor;
    const eye = this.cameraPositionForState(
      this.toTargetX,
      this.toTargetY,
      this.toTargetZ,
      this.toDistance,
      this.toYaw,
      this.pitch,
      this._cameraPosTmp,
    );
    const nextEyeX = wantFactor * eye.x + (1 - wantFactor) * anchor.x;
    const nextEyeY = wantFactor * eye.y + (1 - wantFactor) * anchor.y;
    const nextEyeZ = wantFactor * eye.z + (1 - wantFactor) * anchor.z;
    const origin = this.cameraDistanceOrigin;
    const startX = eye.x - origin.x;
    const startY = eye.y - origin.y;
    const startZ = eye.z - origin.z;
    const endX = nextEyeX - origin.x;
    const endY = nextEyeY - origin.y;
    const endZ = nextEyeZ - origin.z;
    const radiusSq = this.maxCameraDistanceFromOrigin * this.maxCameraDistanceFromOrigin;
    const startRadiusSq = startX * startX + startY * startY + startZ * startZ;
    const endRadiusSq = endX * endX + endY * endY + endZ * endZ;
    if (endRadiusSq <= radiusSq) return wantFactor;

    // If a stale/legacy state is already beyond the rail, never let an
    // outward zoom make it worse; allow inward zooms unchanged so the player
    // can always recover without using the minimap.
    if (startRadiusSq >= radiusSq) {
      return endRadiusSq < startRadiusSq ? wantFactor : 1;
    }

    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const deltaZ = endZ - startZ;
    const a = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    if (!(a > 1e-12)) return 1;
    const b = 2 * (startX * deltaX + startY * deltaY + startZ * deltaZ);
    const c = startRadiusSq - radiusSq;
    const discriminant = b * b - 4 * a * c;
    if (!(discriminant >= 0)) return 1;
    const exitT = (-b + Math.sqrt(discriminant)) / (2 * a);
    const clampedT = Math.min(1, Math.max(0, exitT));
    return 1 + (wantFactor - 1) * clampedT;
  }

  private static normalizeAngleDelta(delta: number): number {
    return Math.atan2(Math.sin(delta), Math.cos(delta));
  }

  private beginTouchGesture(e: TouchEvent): void {
    const center = this.touchCenter(e);
    this.touchMode = e.touches.length >= 2 ? 'pinch' : 'pan';
    this.touchLastCenterX = center.x;
    this.touchLastCenterY = center.y;
    this.touchLastDistance = this.touchMode === 'pinch' ? this.touchDistance(e) : 0;
    this.touchLastAngle = this.touchMode === 'pinch' ? this.touchAngle(e) : Number.NaN;
    this.capturePanAnchor(center.x, center.y);
  }

  private _worldPointForScreenPoint(
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
  ): THREE.Vector3 | null {
    return this.getCursorWorldPoint?.(clientX, clientY, terrainMode) ?? null;
  }

  private _anchorScreenPoint(
    clientX: number,
    clientY: number,
    anchor: CameraAnchor,
    out: THREE.Vector2,
  ): THREE.Vector2 | null {
    if (anchor.screen === 'cursor') return out.set(clientX, clientY);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return out.set(
      rect.left + rect.width * 0.5,
      rect.top + rect.height * 0.5,
    );
  }

  /** Resolve the gesture's anchor world point from its configured
   *  screen axis and terrain axis. */
  private _anchorWorldPoint(
    clientX: number,
    clientY: number,
    anchor: CameraAnchor,
  ): THREE.Vector3 | null {
    const screenPoint = this._anchorScreenPoint(
      clientX,
      clientY,
      anchor,
      this._zoomScreenAnchorTmp,
    );
    if (!screenPoint) return null;
    return this._worldPointForScreenPoint(screenPoint.x, screenPoint.y, anchor.terrain);
  }

  private cameraPositionForState(
    targetX: number,
    targetY: number,
    targetZ: number,
    distance: number,
    yaw: number,
    pitch: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    const sinP = Math.sin(pitch);
    const cosP = Math.cos(pitch);
    out.set(
      targetX + distance * sinP * Math.sin(yaw),
      targetY + distance * cosP,
      targetZ + distance * sinP * -Math.cos(yaw),
    );
    return out;
  }

  /** Largest pitch ≤ the authored pitch (i.e. closest to it, steepening
   *  toward minPitch) at which the eye — held on the orbit sphere at the
   *  given distance — clears terrain by minTerrainClearance.
   *
   *  When the authored pitch already clears, or the sampler returns NaN
   *  (off-map / before terrain loads), the authored pitch is returned
   *  unchanged. Steepening (decreasing pitch toward straight-down) both
   *  raises the eye and pulls its footprint toward the target, so it
   *  trends toward clearing; we march down from the authored pitch to the
   *  first clearing sample, then binary-search the surface. Bottoms out at
   *  minPitch in the degenerate case (target buried in a peak). Pure read
   *  — never mutates camera state. */
  private clearedPitch(
    sample: (x: number, z: number) => number,
    distance: number,
    yaw: number,
    pitch: number,
  ): number {
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    // clearance(p) = eyeY(p) − (terrain beneath eye(p) + clearance). ≥0
    // clears, <0 penetrates; NaN propagates and counts as clearing via
    // every `!(c < 0)` test below.
    const clearance = (p: number): number => {
      const sinP = Math.sin(p);
      const ex = this.target.x + distance * sinP * sinYaw;
      const ez = this.target.z + distance * sinP * -cosYaw;
      const ey = this.target.y + distance * Math.cos(p);
      return ey - (sample(ex, ez) + this.minTerrainClearance);
    };
    if (!(clearance(pitch) < 0)) return pitch;

    const loP = this.minPitch;
    if (pitch <= loP) return loP;
    const STEPS = 24;
    const step = (pitch - loP) / STEPS;
    let blocked = pitch; // penetrates here (shallower / less steep)
    let cleared = -1;
    for (let i = 1; i <= STEPS; i++) {
      const p = pitch - i * step;
      if (!(clearance(p) < 0)) {
        cleared = p;
        break;
      }
      blocked = p;
    }
    if (cleared < 0) return loP; // even straight-down can't clear

    // Refine between the steeper clearing pitch and the shallower blocked
    // one. lo clears, hi penetrates; converge to the largest (least
    // steepened) pitch that still clears.
    let lo = cleared;
    let hi = blocked;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) * 0.5;
      if (!(clearance(mid) < 0)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Recompute the rendered camera position from the orbit state
   *  (target + yaw + pitch + distance) and aim it at the target.
   *
   *  Terrain clearance is resolved per `terrainCollisionMode`:
   *
   *  - 'none'       — render the eye exactly where the orbit state puts
   *                   it; it may pass under the heightfield.
   *  - 'raiseEye'   — lift only the eye's Y to the clearance height. The
   *                   eye keeps its horizontal footprint and leaves the
   *                   orbit sphere (true distance grows, view steepens).
   *                   pos.y = max(naturalY, floorY) is continuous, so
   *                   riding over a ridge has no pop.
   *  - 'clampPitch' — steepen the pitch so the eye stays ON the orbit
   *                   sphere at the stored distance; only the effective
   *                   pitch diverges from the stored pitch.
   *  - 'persistRaiseEye' — lift eye and focus together, committing the lift
   *                   into the ordinary controller state. There is no
   *                   recovery flag or remembered pre-collision height, so
   *                   clearing a ridge cannot pull the camera back down.
   *
   *  An earlier version pushed the camera along terrain normals and
   *  recovered yaw / pitch / distance from the adjusted position — which
   *  made the view spin and ratchet its zoom as the camera brushed hills
   *  while panning. The persistent mode only translates Y and never recovers
   *  yaw, pitch, or distance from a collision-adjusted pose. */
  apply(): void {
    if (this.usesBarSpringTransition()) {
      this.prepareBarControllerGoal();
      if (!this.barRenderInitialized || this.transitionSeconds <= 0) {
        this.snapBarRenderToController();
      } else {
        this.applyBarRenderedPose();
      }
      return;
    }
    this.constrainTargets();
    // Resolve the sampler once; undefined disables clearance (mode 'none',
    // no sampler installed, or zero clearance).
    const sample =
      this.terrainCollisionMode !== 'none' && this.minTerrainClearance > 0
        ? this.getTerrainHeight
        : undefined;
    // clampPitch resolves BEFORE building the eye (it changes the angle).
    const renderPitch =
      sample && this.terrainCollisionMode === 'clampPitch'
        ? this.clearedPitch(sample, this.distance, this.yaw, this.pitch)
        : this.pitch;
    const pos = this.cameraPositionForState(
      this.target.x,
      this.target.y,
      this.target.z,
      this.distance,
      this.yaw,
      renderPitch,
      this._cameraPosTmp,
    );
    if (sample && this.terrainCollisionMode === 'persistRaiseEye') {
      // The clearance floor is the terrain bed alone — under water that is
      // the basin floor, so the camera may submerge freely.
      const terrainY = sample(pos.x, pos.z);
      const lift = persistentTerrainRaise(pos.y, terrainY, this.minTerrainClearance);
      if (lift > 0) {
        // This is the one intentional difference from BAR's render-only
        // max(eyeY, terrainY + 5): make the resolved height canonical.
        this.target.y += lift;
        this.toTargetY += lift;
        pos.y += lift;
      }
    }
    // raiseEye resolves AFTER building the eye (it lifts only Y). NaN-safe:
    // a NaN sample (off-map / before terrain loads) makes the comparison
    // false, so the eye is left where the orbit state put it.
    if (sample && this.terrainCollisionMode === 'raiseEye') {
      const floorY = sample(pos.x, pos.z) + this.minTerrainClearance;
      if (pos.y < floorY) pos.y = floorY;
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(this._cameraLookAtTmp.copy(this.target));
    // Input can deliver several wheel/mouse events before the next render.
    // Keep cursor-ray construction on the pose just applied instead of the
    // previous frame's matrixWorld.
    this.camera.updateMatrixWorld();
  }

  /** Resolve BAR controller state into its desired eye. Terrain clearance is
   * part of controller GetPos; the active camera transitions toward this pose
   * separately in tick(). */
  private prepareBarControllerGoal(): THREE.Vector3 {
    this.constrainTargets();
    const goal = this.cameraPositionForState(
      this.toTargetX,
      this.toTargetY,
      this.toTargetZ,
      this.toDistance,
      this.toYaw,
      this.toPitch,
      this._barGoalEyeTmp,
    );
    const sample = this.minTerrainClearance > 0 ? this.getTerrainHeight : undefined;
    if (sample && this.terrainCollisionMode === 'persistRaiseEye') {
      const floorY = sample(goal.x, goal.z);
      const lift = persistentTerrainRaise(goal.y, floorY, this.minTerrainClearance);
      if (lift > 0) {
        this.toTargetY += lift;
        this.target.y = this.toTargetY;
        goal.y += lift;
      }
    } else if (sample && this.terrainCollisionMode === 'raiseEye') {
      const floorY = sample(goal.x, goal.z);
      goal.y += persistentTerrainRaise(goal.y, floorY, this.minTerrainClearance);
    }
    return goal;
  }

  private snapBarRenderToController(): void {
    const goal = this.prepareBarControllerGoal();
    this.camera.position.copy(goal);
    this.yaw = this.toYaw;
    this.pitch = this.toPitch;
    this.barPositionVelocity.set(0, 0, 0);
    this.barYawVelocity = 0;
    this.barPitchVelocity = 0;
    this.camera.fov = this.barFovGoalDegrees;
    this.barFovVelocity = 0;
    this.camera.updateProjectionMatrix();
    this.barRenderInitialized = true;
    this.applyBarRenderedPose();
  }

  private applyBarRenderedPose(): void {
    const sinPitch = Math.sin(this.pitch);
    this._barLookDirectionTmp.set(
      -sinPitch * Math.sin(this.yaw),
      -Math.cos(this.pitch),
      sinPitch * Math.cos(this.yaw),
    );
    this._cameraLookAtTmp.copy(this.camera.position).add(this._barLookDirectionTmp);
    this.camera.lookAt(this._cameraLookAtTmp);
    this.camera.updateMatrixWorld();
  }

  /** Resolve terrain against the active, transitioning eye, not just the
   * controller destination. This covers a spring path crossing a ridge whose
   * endpoint is already on clear terrain. In the persistent mode, only any
   * height beyond the controller's already-resolved goal is committed. That
   * avoids double-counting a destination lift, and clearing the ridge later
   * has no prior height or downward velocity to recover. */
  private resolveBarRenderedTerrainCollision(goal: THREE.Vector3): void {
    if (this.minTerrainClearance <= 0 || this.terrainCollisionMode === 'none') return;
    const sample = this.getTerrainHeight;
    if (!sample) return;
    const terrainY = sample(this.camera.position.x, this.camera.position.z);
    const lift = persistentTerrainRaise(
      this.camera.position.y,
      terrainY,
      this.minTerrainClearance,
    );
    if (!(lift > 0)) return;

    this.camera.position.y += lift;
    if (this.terrainCollisionMode !== 'persistRaiseEye') return;

    const controllerLift = Math.max(0, this.camera.position.y - goal.y);
    if (controllerLift > 0) {
      this.toTargetY += controllerLift;
      this.target.y = this.toTargetY;
      goal.y += controllerLift;
    }
    // The collision is now ordinary controller height. Retaining a downward
    // spring velocity here would be hidden recovery memory and can repeatedly
    // drive the eye back into the same ridge.
    this.barPositionVelocity.y = 0;
  }

  /** Set orbit target (and the to-target) without changing
   *  distance/yaw/pitch. Useful for explicit camera centers — e.g.
   *  centerCameraOnCommander — that should NOT animate via EMA
   *  (they're meant to be hard cuts). */
  setTarget(x: number, y: number, z: number): void {
    this.target.set(x, y, z);
    this.toTargetX = x;
    this.toTargetY = y;
    this.toTargetZ = z;
    if (this.usesBarSpringTransition()) this.barRenderInitialized = false;
    this.apply();
  }

  /** Per-frame follow driver. Points the controller target at (x, y, z).
   *  In zoom-only transition scope this follows immediately while retaining
   *  any outstanding zoom residual. Distance and pitch are left untouched,
   *  so the camera keeps its current standoff and tilt.
   *
   *  `behindYaw` is the yaw destination for "follow behind" — the
   *  caller computes the angle that parks the camera behind the unit.
   *  Pass `null` for plain follow, which pins `toYaw` to the current
   *  yaw so the yaw EMA stays inert and the player keeps manual orbit
   *  control.
   *
   *  With `all-movements`, follow retains the prior shared transition.
   *  With `zoom-only`, position and yaw apply immediately. */
  followStep(x: number, y: number, z: number, behindYaw: number | null): void {
    this.beginContinuousMovement();
    // Constant-altitude follow tracks the unit's true center, aircraft
    // included; the focus floor and eye clearance keep it out of terrain.
    const followsTerrainOffset = this.usesTerrainFollowFocus()
      && this.terrainCollisionMode === 'persistRaiseEye';
    const elevationOffset = followsTerrainOffset
      ? this.barFocusElevationOffset(this.toTargetX, this.toTargetY, this.toTargetZ)
      : 0;
    this.toTargetX = x;
    this.toTargetZ = z;
    this.toTargetY = followsTerrainOffset
      ? Math.max(y, this.barFocusSurfaceHeight(x, z, elevationOffset, y))
      : y;
    if (behindYaw !== null && this.usesBarSpringMovement()) {
      this.barRawYaw = behindYaw;
      this.toYaw = this.resolveBarYaw(behindYaw);
    } else {
      this.toYaw = behindYaw
        ?? (this.usesBarSpringTransition() ? this.toYaw : this.yaw);
    }
    this.finishContinuousMovement();
  }

  /** Keyboard and UI camera nudges use the same continuous-movement policy
   *  as mouse pan. */
  panByWorldDelta(dx: number, dz: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    if (dx === 0 && dz === 0) return;
    this.beginContinuousMovement();
    const elevationOffset = this.usesTerrainFollowFocus()
      ? this.barFocusElevationOffset(this.toTargetX, this.toTargetY, this.toTargetZ)
      : 0;
    this.toTargetX += dx;
    this.toTargetZ += dz;
    if (this.usesBarSpringMovement()) {
      this.toTargetX = Math.min(this.targetMaxX, Math.max(this.targetMinX, this.toTargetX));
      this.toTargetZ = Math.min(this.targetMaxZ, Math.max(this.targetMinZ, this.toTargetZ));
      if (this.usesTerrainFollowFocus()) {
        this.toTargetY = this.barFocusSurfaceHeight(
          this.toTargetX,
          this.toTargetZ,
          elevationOffset,
          this.toTargetY,
        );
      }
    }
    this.finishContinuousMovement();
  }

  /** Pin the eased-yaw destination to the current yaw. Outside
   *  follow-behind this keeps the yaw EMA inert; the follow controller
   *  calls it whenever it is NOT driving yaw so a just-ended
   *  follow-behind ease stops cleanly instead of chasing a stale
   *  target. Cheap no-op when already equal. */
  syncToYaw(): void {
    if (this.usesBarSpringTransition()) return;
    this.toYaw = this.yaw;
  }

  setDistance(distance: number): void {
    if (!Number.isFinite(distance)) return;
    const d = this.usesBarSpringMovement()
      ? this.clampBarDistance(distance)
      : this.constrainOrbitDistance(
          distance,
          this.target.x,
          this.target.y,
          this.target.z,
          this.controllerYaw(),
          this.controllerPitch(),
        );
    this.toDistance = d;
    if (this.usesBarSpringTransition()) {
      // BAR exposes controller distance immediately; the active eye remains
      // independent and receives the same zoom transition as wheel steps.
      this.distance = d;
    }
    this.applyDestinationIfSnap();
  }

  /** Set the controller FOV. Recoil's spring transition treats FOV as a
   * third active-camera channel beside position and rotation. */
  setFovDegrees(fovDegrees: number): void {
    const next = Math.min(179, Math.max(1, fovDegrees));
    if (!Number.isFinite(next)) return;
    if (this.usesBarSpringTransition()) {
      if (Math.abs(this.barFovGoalDegrees - next) < 0.001) return;
      this.barFovGoalDegrees = next;
      if (this.transitionSeconds === 0) this.snapBarRenderToController();
      return;
    }
    if (Math.abs(this.camera.fov - next) < 0.001) return;
    this.camera.fov = next;
    this.barFovGoalDegrees = next;
    this.camera.updateProjectionMatrix();
  }

  /** Far reference distance for HUD fade — keyed to map size so the fade
   *  window scales instead of using a fixed number. This is not a zoom
   *  rail: the camera can dolly past it; HUD elements are just fully
   *  faded by the time it reaches here. */
  getFarReferenceDistance(): number {
    return this.farReferenceDistance;
  }

  setOrbitAngles(yaw: number, pitch: number): void {
    this.barRawYaw = yaw;
    this.toYaw = this.usesBarSpringMovement() ? this.resolveBarYaw(yaw) : yaw;
    this.toPitch = Math.min(this.maxPitch, Math.max(this.minPitch, pitch));
    this.yaw = this.toYaw;
    this.pitch = this.toPitch;
    if (this.usesBarSpringTransition()) this.barRenderInitialized = false;
    this.apply();
  }

  /** Relative azimuth input, retaining unfiltered yaw when BAR's optional
   * cardinal dead zones are enabled. */
  rotateYawBy(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    if (this.usesBarSpringTransition()) this.beginContinuousMovement();
    if (this.usesBarSpringMovement()) {
      this.barRawYaw += delta;
      this.toYaw = this.resolveBarYaw(this.barRawYaw);
      if (!this.usesBarSpringTransition()) this.yaw = this.toYaw;
    } else {
      this.yaw += delta;
      this.toYaw = this.yaw;
    }
    if (this.usesBarSpringTransition()) this.finishContinuousMovement();
    else this.apply();
  }

  setTargetBounds(minX: number, minZ: number, maxX: number, maxZ: number): void {
    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minZ) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxZ)
    ) {
      this.targetMinX = -Infinity;
      this.targetMaxX = Infinity;
      this.targetMinZ = -Infinity;
      this.targetMaxZ = Infinity;
      this.apply();
      return;
    }
    const rawMinX = Math.min(minX, maxX);
    const rawMaxX = Math.max(minX, maxX);
    const rawMinZ = Math.min(minZ, maxZ);
    const rawMaxZ = Math.max(minZ, maxZ);
    const edgeInset = this.usesBarSpringMovement() ? 0.01 : 0;
    this.targetMinX = Math.min(rawMaxX, rawMinX + edgeInset);
    this.targetMaxX = Math.max(this.targetMinX, rawMaxX - edgeInset);
    this.targetMinZ = Math.min(rawMaxZ, rawMinZ + edgeInset);
    this.targetMaxZ = Math.max(this.targetMinZ, rawMaxZ - edgeInset);
    this.apply();
  }

  setState(state: {
    targetX: number;
    targetY: number;
    targetZ: number;
    distance: number;
    yaw: number;
    pitch: number;
  }): void {
    this.target.set(state.targetX, state.targetY, state.targetZ);
    this.toTargetX = state.targetX;
    this.toTargetY = state.targetY;
    this.toTargetZ = state.targetZ;
    const requestedDistance = Number.isFinite(state.distance) ? state.distance : this.minDistance;
    this.distance = this.usesBarSpringMovement()
      ? this.clampBarDistance(requestedDistance)
      : this.constrainOrbitDistance(
          requestedDistance,
          state.targetX,
          state.targetY,
          state.targetZ,
          state.yaw,
          state.pitch,
        );
    this.toDistance = this.distance;
    this.barRawYaw = state.yaw;
    this.toYaw = this.usesBarSpringMovement()
      ? this.resolveBarYaw(state.yaw)
      : state.yaw;
    this.toPitch = Math.min(this.maxPitch, Math.max(this.minPitch, state.pitch));
    this.yaw = this.toYaw;
    this.pitch = this.toPitch;
    if (this.usesBarSpringTransition()) this.barRenderInitialized = false;
    this.apply();
  }

  /** Set the selected transition duration scalar: BAR half-life or EMA time
   * constant. Setting 0 mid-transition snaps and clears spring velocity. */
  setTransitionSeconds(seconds: number): void {
    const clamped = Math.max(0, seconds);
    if (this.transitionSeconds === clamped) return;
    this.transitionSeconds = clamped;
    if (clamped === 0) {
      if (this.usesBarSpringTransition()) {
        this.snapBarRenderToController();
        return;
      }
      this.distance = this.toDistance;
      this.target.x = this.toTargetX;
      this.target.y = this.toTargetY;
      this.target.z = this.toTargetZ;
      this.yaw = this.toYaw;
      this.apply();
    }
  }

  /** Per-frame integration step. Lerps the rendered state toward
   *  the to-state via EMA: alpha = 1 − exp(−dt / tau). Cheap no-op
   *  when tau is 0 or already converged. */
  tick(dtSec: number): void {
    if (this.usesBarSpringTransition()) {
      this.tickBarSpringTransition(dtSec);
      return;
    }
    const recoveringMap = this.updateLostTerrainRecovery();
    const tau = recoveringMap
      ? this.lostTerrainRecovery.emaTauSeconds
      : this.transitionSeconds;
    if (tau <= 0) return;
    const dDist = this.toDistance - this.distance;
    const dX = this.toTargetX - this.target.x;
    const dY = this.toTargetY - this.target.y;
    const dZ = this.toTargetZ - this.target.z;
    // Yaw eases along the SHORTEST arc — normalize the raw delta into
    // [-PI, PI] so a follow-behind target on the far side of the wrap
    // doesn't spin the long way round. Normalization is two trig calls,
    // so skip it on the common in-window case (and on the inert
    // toYaw === yaw path where the raw delta is exactly 0).
    let dYaw = this.toYaw - this.yaw;
    if (dYaw > Math.PI || dYaw < -Math.PI) {
      dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    }
    const dPitch = recoveringMap ? this.mapRecoveryPitch - this.pitch : 0;
    // Settled — snap to exact and stop spinning the integrator.
    if (
      Math.abs(dDist) < 1e-3 &&
      Math.abs(dX) < 1e-3 &&
      Math.abs(dY) < 1e-3 &&
      Math.abs(dZ) < 1e-3 &&
      Math.abs(dYaw) < 1e-4 &&
      Math.abs(dPitch) < 1e-4
    ) {
      if (
        dDist !== 0 || dX !== 0 || dY !== 0 || dZ !== 0 || dYaw !== 0
        || dPitch !== 0
      ) {
        this.distance = this.toDistance;
        this.target.x = this.toTargetX;
        this.target.y = this.toTargetY;
        this.target.z = this.toTargetZ;
        // Add the (tiny) normalized residual rather than assigning toYaw
        // outright, so a yaw that converged across a 2PI wrap doesn't
        // jump its raw value by a full turn (visually identical, but
        // other readers of `yaw` see a clean number).
        this.yaw += dYaw;
        this.pitch += dPitch;
        this.apply();
      }
      return;
    }
    const alpha = 1 - Math.exp(-dtSec / tau);
    this.distance += dDist * alpha;
    this.target.x += dX * alpha;
    this.target.y += dY * alpha;
    this.target.z += dZ * alpha;
    this.yaw += dYaw * alpha;
    this.pitch += dPitch * alpha;
    this.apply();
  }

  /** Recoil UpdateTransitionSpringDampened, applied to the actual rendered
   * eye and rotation. Controller state is already current in the to-fields. */
  private tickBarSpringTransition(dtSec: number): void {
    this.updateLostTerrainRecovery();
    if (!(dtSec > 0)) return;
    if (this.transitionSeconds <= 0 || !this.barRenderInitialized) {
      this.snapBarRenderToController();
      return;
    }
    const goal = this.prepareBarControllerGoal();
    const halfLife = this.transitionSeconds;
    const step = this.barDamperStepScratch;

    barSpringDamperStep(
      this.camera.position.x,
      this.barPositionVelocity.x,
      goal.x,
      halfLife,
      dtSec,
      step,
    );
    this.camera.position.x = step.value;
    this.barPositionVelocity.x = step.velocity;
    barSpringDamperStep(
      this.camera.position.y,
      this.barPositionVelocity.y,
      goal.y,
      halfLife,
      dtSec,
      step,
    );
    this.camera.position.y = step.value;
    this.barPositionVelocity.y = step.velocity;
    barSpringDamperStep(
      this.camera.position.z,
      this.barPositionVelocity.z,
      goal.z,
      halfLife,
      dtSec,
      step,
    );
    this.camera.position.z = step.value;
    this.barPositionVelocity.z = step.velocity;

    this.resolveBarRenderedTerrainCollision(goal);

    barSpringDamperStep(
      this.yaw,
      this.barYawVelocity,
      this.toYaw,
      halfLife,
      dtSec,
      step,
    );
    this.yaw = step.value;
    this.barYawVelocity = step.velocity;
    barSpringDamperStep(
      this.pitch,
      this.barPitchVelocity,
      this.toPitch,
      halfLife,
      dtSec,
      step,
    );
    this.pitch = step.value;
    this.barPitchVelocity = step.velocity;

    barSpringDamperStep(
      this.camera.fov,
      this.barFovVelocity,
      this.barFovGoalDegrees,
      halfLife,
      dtSec,
      step,
    );
    if (this.camera.fov !== step.value) {
      this.camera.fov = step.value;
      this.camera.updateProjectionMatrix();
    }
    this.barFovVelocity = step.velocity;

    this.applyBarRenderedPose();
  }

  /**
   * Install the scene-owned, allocation-free surface visibility test. It is
   * deliberately a frustum test over terrain bounds instead of a screen-center
   * ray: terrain in a viewport corner still counts as visible and must not
   * trigger recovery. Water never prevents camera recovery.
   */
  setSurfaceVisibilityChecker(
    checker: ((frustum: THREE.Frustum) => boolean) | undefined,
  ): void {
    this.surfaceVisibilityChecker = checker;
    if (checker === undefined) this.mapRecoveryActive = false;
  }

  /** User input takes the camera back from an in-progress automatic map
   *  recovery immediately: the fixer must never fight the player's hands. */
  private cancelMapRecovery(): void {
    this.mapRecoveryActive = false;
  }

  private updateLostTerrainRecovery(): boolean {
    if (!this.lostTerrainRecovery.enabled || this.surfaceVisibilityChecker === undefined) {
      this.mapRecoveryActive = false;
      return false;
    }

    const originVisible = this.isMapOriginInViewport();
    if (this.mapRecoveryActive) {
      if (originVisible) {
        this.mapRecoveryActive = false;
        return false;
      }
      // Follow/focus/input code writes the regular to-state before tick().
      // Reassert the recovery destination here so recovery owns the pose only
      // until the origin becomes visible again.
      this.toTargetX = this.mapRecoveryTarget.x;
      this.toTargetY = this.mapRecoveryTarget.y;
      this.toTargetZ = this.mapRecoveryTarget.z;
      this.toDistance = this.mapRecoveryDistance;
      this.toYaw = this.mapRecoveryYaw;
      return true;
    }

    if (originVisible || this.hasVisibleMapSurface()) return false;
    this.beginLostTerrainRecovery();
    return true;
  }

  private prepareCameraVisibilityMatrices(): void {
    this.camera.updateMatrixWorld(true);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
  }

  private isMapOriginInViewport(): boolean {
    this.prepareCameraVisibilityMatrices();
    const clip = this._mapRecoveryOriginClipTmp
      .copy(this.cameraDistanceOrigin)
      .applyMatrix4(this.camera.matrixWorldInverse);
    // Three cameras face down local -Z. Check the unprojected view-space
    // depth first so a point behind the eye cannot appear to be in the NDC
    // rectangle after perspective division.
    if (
      !Number.isFinite(clip.z)
      || clip.z > -this.camera.near
      || clip.z < -this.camera.far
    ) {
      return false;
    }
    clip.applyMatrix4(this.camera.projectionMatrix);
    return Number.isFinite(clip.x)
      && Number.isFinite(clip.y)
      && Number.isFinite(clip.z)
      && clip.x >= -1 && clip.x <= 1
      && clip.y >= -1 && clip.y <= 1
      && clip.z >= -1 && clip.z <= 1;
  }

  private hasVisibleMapSurface(): boolean {
    this.prepareCameraVisibilityMatrices();
    this._surfaceVisibilityProjectionTmp.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    this._surfaceVisibilityFrustum.setFromProjectionMatrix(
      this._surfaceVisibilityProjectionTmp,
    );
    return this.surfaceVisibilityChecker?.(this._surfaceVisibilityFrustum) ?? true;
  }

  private beginLostTerrainRecovery(): void {
    const origin = this.cameraDistanceOrigin;
    const eyeOffset = this._mapRecoveryEyeOffsetTmp
      .copy(this.camera.position)
      .sub(origin);
    const eyeRadius = eyeOffset.length();
    const safeRadius = Number.isFinite(eyeRadius) && eyeRadius > 1e-6
      ? Math.max(this.minDistance, Math.min(eyeRadius, this.farReferenceDistance))
      : Math.max(this.minDistance, Math.min(this.distance, this.farReferenceDistance));

    this.mapRecoveryTarget.copy(origin);
    this.mapRecoveryDistance = safeRadius;
    if (Number.isFinite(eyeRadius) && eyeRadius > 1e-6) {
      const elevation = Math.max(-1, Math.min(1, eyeOffset.y / eyeRadius));
      this.mapRecoveryPitch = Math.min(
        this.maxPitch,
        Math.max(this.minPitch, Math.acos(elevation)),
      );
      if (eyeOffset.x * eyeOffset.x + eyeOffset.z * eyeOffset.z > 1e-8) {
        this.mapRecoveryYaw = Math.atan2(eyeOffset.x, -eyeOffset.z);
      } else {
        this.mapRecoveryYaw = this.yaw;
      }
    } else {
      this.mapRecoveryPitch = this.pitch;
      this.mapRecoveryYaw = this.yaw;
    }
    this.toTargetX = origin.x;
    this.toTargetY = origin.y;
    this.toTargetZ = origin.z;
    this.toDistance = this.mapRecoveryDistance;
    this.toYaw = this.mapRecoveryYaw;
    this.mapRecoveryActive = true;
  }

  /** Shared read-only view for the CLIENT ZOOM POINTS overlay. The typed
   *  position buffer is stable for this OrbitCamera's lifetime and is updated
   *  in place on each relative wheel/pinch zoom event. */
  getZoomTerrainSampleSnapshot(): Readonly<CameraZoomTerrainSampleSnapshot> {
    return this.zoomTerrainSamples;
  }

  /** Install / replace the 3D cursor picker callback. The scene calls
   *  this once it has its terrain mesh ready; the orbit camera then
   *  uses the picker for all zoom + pan cursor pinning. */
  setCursorPicker(
    cb: ((
      clientX: number,
      clientY: number,
      terrainMode: CameraAnchorTerrain,
    ) => THREE.Vector3 | null) | undefined,
  ): void {
    this.getCursorWorldPoint = cb;
  }

  /** Install / replace the optimized peripheral zoom-sample picker. Keeping
   *  this separate from the authoritative center picker ensures cursor
   *  pinning still uses exact rendered geometry while the optional rings do
   *  not multiply full terrain-mesh raycasts per wheel event. */
  setZoomSamplePicker(
    cb: ((
      clientX: number,
      clientY: number,
      terrainMode: CameraAnchorTerrain,
      referenceSurfaceHeight: number,
    ) => THREE.Vector3 | null) | undefined,
  ): void {
    this.getZoomSampleWorldPoint = cb;
  }

  /** Install / replace BAR's controller-origin world-ray tracer. */
  setWorldRayTracer(
    cb: ((
      origin: THREE.Vector3,
      direction: THREE.Vector3,
      terrainMode: CameraAnchorTerrain,
      fallbackPlaneHeight: number,
    ) => THREE.Vector3 | null) | undefined,
  ): void {
    this.traceWorldRay = cb;
  }

  /** Install / replace the terrain-height sampler. While set, every
   *  apply() resolves the camera against nearby terrain with the
   *  configured 3D clearance. */
  setTerrainSampler(
    cb: ((x: number, z: number) => number) | undefined,
  ): void {
    this.getTerrainHeight = cb;
  }

  destroy(): void {
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.canvas.removeEventListener('touchstart', this.onTouchStart);
    this.canvas.removeEventListener('touchmove', this.onTouchMove);
    this.canvas.removeEventListener('touchend', this.onTouchEnd);
    this.canvas.removeEventListener('touchcancel', this.onTouchEnd);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.style.touchAction = this.previousTouchAction;
  }
}
