import { rollingWheelAngularVelocity } from './LocomotionRigShared3D';

function assertEqual(actual: number, expected: number, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `[rolling locomotion contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

export function runRollingLocomotionContractTest(): void {
  assertEqual(
    rollingWheelAngularVelocity(12, 3),
    -4,
    'forward chassis travel rotates the contact surface rearward',
  );
  assertEqual(
    rollingWheelAngularVelocity(-12, 3),
    4,
    'reverse chassis travel reverses wheel rotation',
  );
  assertEqual(
    rollingWheelAngularVelocity(12, 0),
    -12,
    'invalid tiny radii retain the shared one-world-unit safety floor',
  );
}
