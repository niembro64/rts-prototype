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
  persistentTerrainRaise,
  zoomAggregationShortestCount,
} from './OrbitCamera';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[orbit camera contract] ${message}`);
}

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= 1e-9;
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

  const firstLift = persistentTerrainRaise(90, 100, 5);
  assertContract(
    close(firstLift, 15),
    'terrain penetration must resolve to exactly the missing vertical clearance',
  );
  assertContract(
    close(persistentTerrainRaise(90 + firstLift, 100, 5), 0),
    'a committed terrain lift must not accumulate on the next frame',
  );
  assertContract(
    close(persistentTerrainRaise(90 + firstLift, 80, 5), 0),
    'clearing the mountain must never synthesize a downward recovery',
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
}
