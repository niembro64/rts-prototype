import {
  rollingContact,
  rollingWheelAngularVelocity,
  sampleRollingContactPosition,
} from './LocomotionRigShared3D';

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

  const contact = rollingContact(2, 3);
  contact.phase = 17;
  sampleRollingContactPosition({
    baseX: 10,
    baseY: 20,
    baseZ: 30,
    quaternionX: 0,
    quaternionY: 0,
    quaternionZ: 0,
    quaternionW: 1,
    velocityX: 4,
    velocityY: 0,
    velocityZ: 0,
    yawRate: 0,
    waterFraction: 0,
    maxContinuousDistance: 100,
  }, contact);
  assertEqual(contact.worldX, 12, 'static Low contact still tracks world X');
  assertEqual(contact.worldZ, 33, 'static Low contact still tracks world Z');
  assertEqual(contact.phase, 17, 'static Low contact does not integrate rolling phase');
}
