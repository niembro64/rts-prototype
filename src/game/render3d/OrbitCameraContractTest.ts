import {
  barCameraLockedYaw,
  barCameraRelativeZoomFactor,
  barCameraWheelTicks,
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
    close(barCameraWheelTicks(100, 0), 1)
      && close(barCameraWheelTicks(-100, 0), -1),
    '100 DOM pixels must equal one signed BAR/Recoil wheel unit',
  );
  assertContract(
    close(barCameraWheelTicks(3, 1), 1)
      && close(barCameraWheelTicks(-3, 1), -1),
    'three DOM lines must equal one signed BAR/Recoil wheel unit',
  );
  assertContract(
    close(barCameraWheelTicks(1, 2), 1)
      && close(barCameraWheelTicks(-1, 2), -1),
    'one DOM page must equal one signed BAR/Recoil wheel unit',
  );
  assertContract(
    close(barCameraWheelTicks(25, 0), 0.25),
    'trackpad pixel deltas must retain fractional wheel movement',
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
}
