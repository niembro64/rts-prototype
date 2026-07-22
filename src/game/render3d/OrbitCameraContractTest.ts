import {
  barCameraLockedYaw,
  barCameraYaw,
  barCameraRelativeZoomFactor,
  barCameraZoomElevationOffset,
  barSpringDamperStep,
  barCameraWheelTicks,
  cameraMouseDragModeForModifiers,
  persistentTerrainRaise,
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
