import * as THREE from 'three';
import {
  CAMERA_CONSTRAINTS,
  CAMERA_MOVEMENT_CONFIG,
  CAMERA_ROTATE_ANCHOR,
  CAMERA_SMOOTH_TAU_SECONDS,
  CAMERA_TERRAIN_COLLISION,
  CAMERA_TRANSITION_SCOPE,
  CAMERA_ZOOM_IN_ANCHOR,
  CAMERA_ZOOM_OUT_ANCHOR,
  ZOOM_STEP_FRACTION,
  ZOOM_TRAVEL_CLAMP_FRACTION,
} from '../../config';
import {
  averageOfShortestDistances,
  barCameraLockedYaw,
  barCameraYaw,
  barCameraRelativeZoomFactor,
  barCameraTravelClampedZoomFactor,
  barCameraWheelEventIsNotched,
  barCameraZoomElevationOffset,
  barSpringDamperStep,
  barCameraWheelTicks,
  cameraMouseDragModeForModifiers,
  OrbitCamera,
  terrainClearanceRaise,
  zoomAggregationShortestCount,
  zoomPivotTravelBudgetFraction,
} from './OrbitCamera';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[orbit camera contract] ${message}`);
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9;
}

/** A detached element reports a zero-size bounding rect, and `screen-center`
 *  anchors (the canonical rotate anchor) resolve to null on one — the gesture
 *  then silently falls back to focus-relative rotation. Give the stand-in a
 *  real viewport so anchored paths under test are the ones that actually run. */
function createStandInCanvas(widthPx: number, heightPx: number): HTMLElement {
  const canvas = document.createElement('div');
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: widthPx });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: heightPx });
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, widthPx, heightPx);
  return canvas;
}

export function runOrbitCameraContractTest(): void {
  assertContract(
    cameraMouseDragModeForModifiers(false, false) === 'pan'
      && cameraMouseDragModeForModifiers(false, true) === 'height-pan',
    'Ctrl+MMB must switch ordinary forward/back pan to world-height pan',
  );
  assertContract(
    cameraMouseDragModeForModifiers(true, true) === 'orbit',
    'Alt+MMB orbit must take precedence when Ctrl is also held',
  );

  assertContract(
    close(barCameraWheelTicks(100, 0, 'dom-continuous-delta'), 1)
      && close(barCameraWheelTicks(-100, 0, 'dom-continuous-delta'), -1),
    '100 DOM pixels must equal one signed BAR/Recoil wheel unit',
  );
  assertContract(
    close(barCameraWheelTicks(3, 1, 'dom-continuous-delta'), 1)
      && close(barCameraWheelTicks(-3, 1, 'dom-continuous-delta'), -1),
    'three DOM lines must equal one signed BAR/Recoil wheel unit',
  );
  assertContract(
    close(barCameraWheelTicks(1, 2, 'dom-continuous-delta'), 1)
      && close(barCameraWheelTicks(-1, 2, 'dom-continuous-delta'), -1),
    'one DOM page must equal one signed BAR/Recoil wheel unit',
  );
  assertContract(
    close(barCameraWheelTicks(25, 0, 'dom-continuous-delta'), 0.25),
    'trackpad pixel deltas must retain fractional wheel movement',
  );
  assertContract(
    close(barCameraWheelTicks(4, 0, 'bar-discrete-event'), 1)
      && close(barCameraWheelTicks(480, 0, 'bar-discrete-event'), 1)
      && close(barCameraWheelTicks(-960, 0, 'bar-discrete-event'), -1),
    'BAR discrete wheel clicks must ignore accelerated DOM delta magnitude',
  );
  const spacedClicks = [4, 4, 4, 4, 4].reduce(
    (sum, delta) => sum + barCameraWheelTicks(delta, 0, 'bar-discrete-event'),
    0,
  );
  const rapidClicks = [4, 16, 52, 180, 480].reduce(
    (sum, delta) => sum + barCameraWheelTicks(delta, 0, 'bar-discrete-event'),
    0,
  );
  assertContract(
    close(spacedClicks, 5) && close(rapidClicks, 5),
    'five rapid clicks and five spaced clicks must deliver the same BAR input',
  );

  assertContract(
    barCameraWheelEventIsNotched(1, undefined)
      && barCameraWheelEventIsNotched(2, undefined),
    'line and page wheel deltas only come from real notched wheels',
  );
  assertContract(
    barCameraWheelEventIsNotched(0, 120)
      && barCameraWheelEventIsNotched(0, -240),
    'legacy wheelDelta multiples of 120 must classify as notched clicks',
  );
  assertContract(
    !barCameraWheelEventIsNotched(0, -7.5)
      && !barCameraWheelEventIsNotched(0, 100)
      && !barCameraWheelEventIsNotched(0, 0)
      && !barCameraWheelEventIsNotched(0, undefined),
    'trackpad-style pixel streams must classify as continuous input',
  );
  assertContract(
    close(barCameraWheelTicks(4, 0, 'bar-discrete-event', false), 0.04)
      && close(barCameraWheelTicks(-25, 0, 'bar-discrete-event', false), -0.25),
    'continuous devices in discrete mode must keep fractional pixel ticks '
      + 'so a trackpad fling cannot become dozens of full notches',
  );

  assertContract(
    close(barCameraTravelClampedZoomFactor(0.825, 1000, 1000, 0.5), 0.825),
    'ordinary zoom (anchor near orbit distance) must pass through unclamped',
  );
  assertContract(
    close(barCameraTravelClampedZoomFactor(0.825, 100000, 1000, 0.5), 0.995),
    'a silhouette/fallback anchor at pathological depth must be limited to '
      + 'the configured travel fraction of the orbit distance',
  );
  assertContract(
    close(barCameraTravelClampedZoomFactor(1.175, 100000, 1000, 0.5), 1.005),
    'outward zoom against a distant anchor must respect the same ceiling',
  );
  const clampedInwardTravel = (1 - barCameraTravelClampedZoomFactor(0.825, 50000, 2000, 0.5)) * 50000;
  assertContract(
    close(clampedInwardTravel, 0.5 * 2000),
    'clamped eye travel must equal exactly the fraction of orbit distance',
  );
  assertContract(
    close(barCameraTravelClampedZoomFactor(0.825, 100000, 1000, 0), 0.825),
    'a zero travel-clamp fraction must disable the ceiling entirely',
  );

  // THE TRAVEL BUDGET SPENDS THE PIVOT BEFORE IT SPENDS THE FACTOR. Both
  // clamps below are handed the same pathological anchor; the pivot version
  // keeps the gesture full strength by giving up the pin, which is what stops
  // a wheel notch from going dead at shallow pitch and out past the coast.
  //
  // Geometry throughout: focus at the origin, eye 1000 above it, so a centre
  // zoom moves the eye |1 − factor| · 1000 and the budget is 0.5 · 1000.
  assertContract(
    close(
      zoomPivotTravelBudgetFraction(0, 1000, 0, 0, 0, 0, 0, 0, 900, 1.175, 1000, 0.5),
      1,
    ),
    'an anchor whose gesture already fits the travel budget must not be moved',
  );
  const farAnchorFraction = zoomPivotTravelBudgetFraction(
    0, 1000, 0, 0, 0, 0, 0, 0, 100000, 1.175, 1000, 0.5,
  );
  assertContract(
    farAnchorFraction > 0 && farAnchorFraction < 1,
    'a grazing-ray anchor must slide down the focus → anchor segment',
  );
  // The resolved pivot must sit exactly on the budget sphere: the eye travels
  // the full allowance and not one unit more.
  const resolvedPivotZ = 100000 * farAnchorFraction;
  const resolvedAnchorDistance = Math.hypot(1000, resolvedPivotZ);
  assertContract(
    Math.abs(0.175 * resolvedAnchorDistance - 0.5 * 1000) <= 1e-6,
    'the resolved pivot must spend exactly the configured travel budget',
  );
  assertContract(
    Math.abs(
      barCameraTravelClampedZoomFactor(1.175, resolvedAnchorDistance, 1000, 0.5) - 1.175,
    ) <= 1e-9,
    'after the pivot gives way the factor clamp must be inert — the whole '
      + 'requested distance change survives a distant anchor',
  );
  // The one case the pivot cannot rescue: a notch so large that even a centre
  // zoom overshoots. There the factor clamp is still the honest answer.
  assertContract(
    close(
      zoomPivotTravelBudgetFraction(0, 1000, 0, 0, 0, 0, 0, 0, 5000, 2.5, 1000, 0.5),
      0,
    ),
    'a step too large for even a centre zoom must collapse the pivot onto the '
      + 'focus and leave the factor clamp to throttle it',
  );
  assertContract(
    close(
      zoomPivotTravelBudgetFraction(0, 1000, 0, 0, 0, 0, 0, 0, 100000, 1.175, 1000, 0),
      1,
    ),
    'a zero travel-clamp fraction must disable the pivot budget too',
  );
  assertContract(
    close(
      zoomPivotTravelBudgetFraction(0, 1000, 0, 0, 0, 0, 0, 0, 100000, 1, 1000, 0.5),
      1,
    ),
    'a no-op zoom factor moves the eye nowhere, so its pivot is unconstrained',
  );

  assertContract(
    zoomAggregationShortestCount('average-of-shortest-3') === 3
      && zoomAggregationShortestCount('average-of-shortest-5') === 5
      && zoomAggregationShortestCount('average-of-shortest-8') === 8
      && zoomAggregationShortestCount('min') === 1,
    'every average-of-shortest mode must map to its named sample count',
  );
  // Silhouette neighborhood: peak surface near, valley floor far behind.
  const silhouette = [520, 480, 500, 9000, 9400, 8800, 9100, 9600, 9200];
  const silhouetteFlags = new Uint8Array(silhouette.length);
  const nearTail = averageOfShortestDistances(silhouette, silhouette.length, 3, silhouetteFlags);
  assertContract(
    close(nearTail, (480 + 500 + 520) / 3),
    'average-of-shortest-3 must average exactly the three nearest samples',
  );
  assertContract(
    silhouetteFlags[0] === 1 && silhouetteFlags[1] === 1 && silhouetteFlags[2] === 1
      && silhouetteFlags[3] === 0 && silhouetteFlags[8] === 0,
    'contributing samples must be flagged for the debug overlay, others not',
  );
  assertContract(
    nearTail < 1000,
    'the near-tail mean must stay on the peak surface a full average abandons',
  );
  const flagsK1 = new Uint8Array(silhouette.length);
  assertContract(
    close(averageOfShortestDistances(silhouette, silhouette.length, 1, flagsK1), 480),
    'average-of-shortest with k=1 must degenerate to min',
  );
  const flagsAll = new Uint8Array(silhouette.length);
  const fullMean = silhouette.reduce((a, b) => a + b, 0) / silhouette.length;
  assertContract(
    close(
      averageOfShortestDistances(silhouette, silhouette.length, 99, flagsAll),
      fullMean,
    ),
    'k beyond the sample count must degenerate to the plain average',
  );
  const withOutlier = [30, 5000, 5100, 5200];
  const outlierFlags = new Uint8Array(withOutlier.length);
  assertContract(
    close(
      averageOfShortestDistances(withOutlier, withOutlier.length, 3, outlierFlags),
      (30 + 5000 + 5100) / 3,
    ),
    'one spurious near sample must be diluted instead of dictating the depth',
  );
  const nanFlags = new Uint8Array(3);
  assertContract(
    close(averageOfShortestDistances([Number.NaN, 700, 900], 3, 2, nanFlags), 800)
      && nanFlags[0] === 0,
    'non-finite samples must never contribute to the near-tail mean',
  );

  assertContract(
    close(barCameraRelativeZoomFactor(-1, 0.175), 0.825),
    'BAR default scroll-in must multiply controller distance by 0.825',
  );
  assertContract(
    close(barCameraRelativeZoomFactor(1, 0.175), 1.175),
    'BAR default scroll-out must multiply controller distance by 1.175',
  );
  assertContract(
    barCameraRelativeZoomFactor(-100, 0.175) > 0,
    'batched inward wheel input must remain a valid positive zoom factor',
  );
  assertContract(
    close(barCameraZoomElevationOffset(100, 1000, 825, true), 82.5),
    'zoom-in must consume Ctrl-pan height together with orbit distance',
  );
  assertContract(
    close(barCameraZoomElevationOffset(100, 1000, 1175, false), 100),
    'ordinary zoom-out must not synthesize additional focus height',
  );

  const halfPi = Math.PI * 0.5;
  assertContract(
    close(barCameraLockedYaw(halfPi * 0.05), 0)
      && close(barCameraLockedYaw(-halfPi * 0.05), 0),
    'BAR cardinal lock must retain a symmetric dead zone around a cardinal',
  );
  assertContract(
    close(barCameraLockedYaw(halfPi * 1.1), halfPi)
      && close(barCameraLockedYaw(-halfPi * 1.1), -halfPi),
    'BAR cardinal lock must land exactly on positive and negative cardinals',
  );
  assertContract(
    close(barCameraYaw(halfPi * 0.05, false), halfPi * 0.05)
      && close(barCameraYaw(-halfPi * 1.1, false), -halfPi * 1.1),
    'disabled cardinal lock must preserve uninterrupted raw yaw',
  );
  assertContract(
    close(barCameraYaw(halfPi * 0.05, true), 0),
    'enabled cardinal lock must retain BAR yaw behavior',
  );

  const firstLift = terrainClearanceRaise(90, 100, 5);
  assertContract(
    close(firstLift, 15),
    'terrain penetration must resolve to exactly the missing vertical clearance',
  );
  assertContract(
    close(terrainClearanceRaise(90 + firstLift, 100, 5), 0),
    'a resolved terrain lift must not accumulate on the next frame',
  );
  assertContract(
    close(terrainClearanceRaise(90 + firstLift, 80, 5), 0),
    'clearing the mountain must never synthesize a downward recovery',
  );
  assertContract(
    close(terrainClearanceRaise(90, Number.NaN, 5), 0),
    'an unknown terrain sample must leave the eye where the orbit state put it',
  );
  assertContract(
    (CAMERA_TERRAIN_COLLISION.mode as string) !== 'persistRaiseEye',
    'terrain clearance must stay render-only — committing the lift ratchets the focus and kills zoom-in',
  );

  const springStep = barSpringDamperStep(0, 0, 10, 0.1, 0.016);
  assertContract(
    close(springStep.value, 0.20977523036288304)
      && close(springStep.velocity, 24.638872833929465),
    'BAR transition must match Recoil SpringDampers.cpp for position and velocity',
  );
  const continuedStep = barSpringDamperStep(
    springStep.value,
    springStep.velocity,
    10,
    0.1,
    0.016,
  );
  assertContract(
    continuedStep.value > springStep.value && continuedStep.velocity > 0,
    'BAR transition must retain velocity between render frames',
  );
  const snappedStep = barSpringDamperStep(2, -50, 7, 0, 0.016);
  assertContract(
    close(snappedStep.value, 7) && close(snappedStep.velocity, 0),
    'zero BAR half-life must snap and clear transition velocity',
  );

  assertContract(
    CAMERA_TRANSITION_SCOPE === 'all-movements',
    'canonical camera transition scope must EMA every movement channel',
  );
  assertContract(
    close(CAMERA_SMOOTH_TAU_SECONDS.fast, 0.04)
      && close(CAMERA_SMOOTH_TAU_SECONDS.mid, 0.06)
      && close(CAMERA_SMOOTH_TAU_SECONDS.slow, 0.2),
    'EMA presets must use the doubled response rate (half the prior tau)',
  );

  const canvas = createStandInCanvas(1000, 1000);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  const orbit = new OrbitCamera(camera, canvas, {
    transitionMode: 'ema',
    transitionScope: 'all-movements',
    movementConfig: CAMERA_MOVEMENT_CONFIG,
    rotateAnchor: CAMERA_ROTATE_ANCHOR,
    terrainCollisionMode: 'none',
  });
  try {
    orbit.setState({
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      distance: 1000,
      yaw: 0,
      pitch: 0.5,
    });
    orbit.setTransitionSeconds(CAMERA_SMOOTH_TAU_SECONDS.fast);
    orbit.panByWorldDelta(100, 50);
    orbit.rotateYawBy(0.4);
    orbit.moveByKeyboardScreenDirection('orbit', 0, 1);
    orbit.setDistance(800);
    orbit.setFovDegrees(60);

    assertContract(
      close(orbit.target.x, 0)
        && close(orbit.target.z, 0)
        && close(orbit.distance, 1000)
        && close(orbit.yaw, 0)
        && close(orbit.pitch, 0.5)
        && close(camera.fov, 45),
      'pan, zoom, yaw, pitch, and FOV inputs must not bypass the shared EMA',
    );

    orbit.tick(CAMERA_SMOOTH_TAU_SECONDS.fast);
    assertContract(
      orbit.target.x > 0 && orbit.target.x < 100
        && orbit.target.z > 0 && orbit.target.z < 50
        && orbit.distance < 1000 && orbit.distance > 800
        && orbit.yaw > 0 && orbit.yaw < 0.4
        && orbit.pitch < 0.5 && orbit.pitch > 0.26
        && camera.fov > 45 && camera.fov < 60,
      'one EMA tick must advance every camera channel without snapping',
    );

    for (let i = 0; i < 20; i++) {
      orbit.tick(CAMERA_SMOOTH_TAU_SECONDS.fast);
    }
    assertContract(
      close(orbit.target.x, 100)
        && close(orbit.target.z, 50)
        && close(orbit.distance, 800)
        && close(orbit.yaw, 0.4)
        && close(orbit.pitch, 0.26)
        && close(camera.fov, 60),
      'all shared EMA channels must converge to their controller destinations',
    );

    orbit.setCursorPicker(() => new THREE.Vector3(0, 0, 0));
    const beforePivotTarget = orbit.target.clone();
    const beforePivotYaw = orbit.yaw;
    const beforePivotPitch = orbit.pitch;
    canvas.dispatchEvent(new MouseEvent('mousedown', {
      button: 1,
      altKey: true,
      clientX: 100,
      clientY: 100,
    }));
    window.dispatchEvent(new MouseEvent('mousemove', {
      buttons: 4,
      altKey: true,
      clientX: 120,
      clientY: 110,
    }));
    assertContract(
      orbit.target.equals(beforePivotTarget)
        && close(orbit.yaw, beforePivotYaw)
        && close(orbit.pitch, beforePivotPitch),
      'anchored pointer orbit must write only the shared EMA destination',
    );
    orbit.tick(CAMERA_SMOOTH_TAU_SECONDS.fast);
    assertContract(
      !orbit.target.equals(beforePivotTarget)
        && !close(orbit.yaw, beforePivotYaw)
        && !close(orbit.pitch, beforePivotPitch),
      'anchored target translation, yaw, and pitch must advance together',
    );
    window.dispatchEvent(new MouseEvent('mouseup', { button: 1 }));
  } finally {
    orbit.destroy();
  }

  assertStatelessTerrainClearance();
  assertRailConstrainsWholeZoom();
}

/** The focus rail is a constraint on the WHOLE gesture. A pan only moves the
 *  focus, so clamping X and Z after the fact is the whole story; a zoom ships a
 *  coupled (focus, altitude) pair derived from one pivot, and truncating the
 *  two horizontal axes while keeping the altitude left the camera in a pose no
 *  gesture could have produced. Because a zoom scales the focus/anchor height
 *  gap by its own factor, that banked altitude compounded per notch instead of
 *  settling — the accumulation behind a camera that "gets weird" after panning
 *  to an edge and scrolling around out there.
 *
 *  The rail must also not become a second dead zoom: refusing the focus step
 *  is not a reason to refuse the distance step, which no rail governs. */
function assertRailConstrainsWholeZoom(): void {
  const canvas = createStandInCanvas(1000, 1000);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
  const orbit = new OrbitCamera(camera, canvas, {
    movementConfig: CAMERA_MOVEMENT_CONFIG,
    zoomInAnchor: CAMERA_ZOOM_IN_ANCHOR,
    zoomOutAnchor: CAMERA_ZOOM_OUT_ANCHOR,
    zoomStepFraction: ZOOM_STEP_FRACTION,
    zoomTravelClampFraction: ZOOM_TRAVEL_CLAMP_FRACTION,
    terrainCollisionMode: 'none',
  });
  const wheelOut = (): void => {
    canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: 100,
      deltaMode: 0,
      clientX: 500,
      clientY: 500,
      bubbles: true,
      cancelable: true,
    }));
  };
  try {
    const railMaxZ = 5000;
    const anchorDrop = 400;
    const anchorAhead = 500;
    // No terrain sampler at all, so the focus altitude band stands down and
    // this measures the gesture rather than the floor. The anchor is kept near
    // the focus throughout so the travel budget never engages and the rail is
    // the only thing under test.
    const anchor = new THREE.Vector3();
    orbit.setCursorPicker(() => anchor);
    orbit.setTransitionSeconds(0);
    orbit.setTargetBounds(-railMaxZ, -railMaxZ, railMaxZ, railMaxZ);
    orbit.setState({
      targetX: 0,
      targetY: 0,
      targetZ: railMaxZ,
      distance: 1000,
      yaw: 0,
      pitch: 0.5,
    });

    // The focus is parked against the +Z wall with its anchor short of it and
    // below it, so an unclamped zoom-out — which pushes the focus AWAY from
    // its anchor — would drive the focus through the wall and lift its
    // altitude by ZOOM_STEP_FRACTION · anchorDrop on the way.
    const wallZ = orbit.target.z;
    anchor.set(0, -anchorDrop, wallZ - anchorAhead);
    wheelOut();
    assertContract(
      close(orbit.target.z, wallZ),
      'a focus already against the rail must not slide through it',
    );
    assertContract(
      close(orbit.target.y, 0),
      'a focus step the rail refuses must not deliver its ALTITUDE either — '
        + 'that leftover is what compounds into a runaway focus',
    );
    assertContract(
      close(orbit.distance, 1000 * (1 + ZOOM_STEP_FRACTION)),
      'the rail governs the focus, not the distance: a blocked zoom-out must '
        + 'still deliver its whole step as a plain centre zoom',
    );

    // The same gesture with room to move must be entirely unaffected: the rail
    // may only ever take away what it actually blocks.
    orbit.setState({
      targetX: 0,
      targetY: 0,
      targetZ: 0,
      distance: 1000,
      yaw: 0,
      pitch: 0.5,
    });
    anchor.set(0, -anchorDrop, -anchorAhead);
    wheelOut();
    // The resolved pivot rides the zoom's shared sample buffer, whose depths
    // are Float32 for the debug renderer, so the anchored focus step carries
    // that buffer's ~1e-7 relative precision and no more.
    const nearlyExact = (actual: number, expected: number): boolean =>
      Math.abs(actual - expected) <= Math.abs(expected) * 1e-5;
    assertContract(
      close(orbit.distance, 1000 * (1 + ZOOM_STEP_FRACTION))
        && nearlyExact(orbit.target.z, ZOOM_STEP_FRACTION * anchorAhead),
      'a zoom-out with rail clearance must deliver its whole requested step',
    );
    assertContract(
      nearlyExact(orbit.target.y, ZOOM_STEP_FRACTION * anchorDrop),
      'with clearance, the anchored focus altitude step must arrive in full',
    );
  } finally {
    orbit.destroy();
  }
}

/** The camera's pose must be a pure function of its controller state and the
 *  heightfield. Terrain clearance is the one place that has repeatedly broken
 *  that: when the resolved lift was committed back into the focus, brushing a
 *  hill ratcheted the focus altitude upward every frame, and a zoom-in was
 *  cancelled by the same lift it caused — the gesture read as dead. These cases
 *  pin the eye under a wall of terrain and check that nothing survives it. */
function assertStatelessTerrainClearance(): void {
  assertContract(
    CAMERA_CONSTRAINTS.zoomInLimit === 'none',
    'the canonical closest approach must be terrain clearance alone, not a fixed orbit-distance rail',
  );

  const canvas = createStandInCanvas(1000, 1000);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
  const orbit = new OrbitCamera(camera, canvas, {
    movementConfig: CAMERA_MOVEMENT_CONFIG,
    rotateAnchor: CAMERA_ROTATE_ANCHOR,
    terrainCollisionMode: CAMERA_TERRAIN_COLLISION.mode,
    minTerrainClearance: CAMERA_TERRAIN_COLLISION.minClearance,
  });
  try {
    // A wall behind the focus: flat ground under the focus, so the focus floor
    // stays out of this, and terrain far above the eye where the eye actually
    // sits (yaw 0 puts it at -Z).
    const wallHeight = 2000;
    let wallPresent = true;
    orbit.setTerrainSampler((_x, z) => (wallPresent && z < -100 ? wallHeight : 0));
    orbit.setTransitionSeconds(0);
    orbit.setState({ targetX: 0, targetY: 0, targetZ: 0, distance: 1000, yaw: 0, pitch: 0.5 });

    const clearedEyeY = wallHeight + CAMERA_TERRAIN_COLLISION.minClearance;
    assertContract(
      close(camera.position.y, clearedEyeY),
      'an eye inside terrain must be lifted to the clearance height',
    );

    for (let i = 0; i < 60; i++) orbit.tick(0.016);
    assertContract(
      close(orbit.target.y, 0) && close(orbit.distance, 1000),
      'holding the eye against terrain must not ratchet the focus altitude or the orbit distance',
    );

    // Zoom in while the eye is still pinned. The lift used to grow by exactly
    // what each step gave back, so distance stopped responding.
    let distance = orbit.distance;
    for (let i = 0; i < 12; i++) {
      distance *= 0.825;
      orbit.setDistance(distance);
      orbit.tick(0.016);
    }
    assertContract(
      close(orbit.distance, distance) && distance < 150,
      'zoom-in must keep closing while terrain clearance is holding the eye up',
    );
    assertContract(
      close(orbit.target.y, 0),
      'zooming against terrain must not push the focus into the sky',
    );

    // Drop the wall: with nothing committed, the eye falls straight back to the
    // pose the controller state alone describes.
    wallPresent = false;
    orbit.tick(0.016);
    assertContract(
      close(camera.position.y, orbit.target.y + orbit.distance * Math.cos(orbit.pitch)),
      'clearing the terrain must return the eye to its uncommitted orbit pose',
    );
  } finally {
    orbit.destroy();
  }
}
