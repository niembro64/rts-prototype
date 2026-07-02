import { GRAVITY } from '../../config';
import { getShotBlueprint } from './blueprints/shots';
import {
  getProjectileHomingEngagementScale,
  getProjectileHomingThrustAcceleration,
  getProjectileRocketCounterGravityCarryAcceleration,
} from './projectileMotion';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[projectile motion contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string, epsilon = 1e-9): void {
  assertContract(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
}

export function runProjectileMotionContractTest(): void {
  const rocket = getShotBlueprint('shotRocketLight');
  assertContract(rocket.type === 'rocket', 'shotRocketLight must stay on the rocket motion policy');
  assertContract(rocket.gravityForceMultiplier === 1, 'shotRocketLight must use real projectile gravity');

  const projectileGravity = GRAVITY * rocket.gravityForceMultiplier;
  const maxThrustAccel = getProjectileHomingThrustAcceleration(rocket);
  assertContract(maxThrustAccel > projectileGravity, 'light rocket homing thrust must be able to carry gravity');

  assertNear(
    getProjectileRocketCounterGravityCarryAcceleration(rocket, 0, projectileGravity),
    projectileGravity,
    'delayed rocket guidance must fully carry gravity before lateral steering starts',
  );
  assertNear(
    getProjectileRocketCounterGravityCarryAcceleration(rocket, 1, projectileGravity),
    0,
    'fully engaged rocket guidance must leave counter-gravity inside homing thrust',
  );

  const delayMs = rocket.homingDelayMs ?? 0;
  assertContract(
    getProjectileHomingEngagementScale(rocket, delayMs - 16, 16) === 0,
    'homing engagement must remain zero before the delay midpoint crosses',
  );

  const fixedStepMs = 1000 / 30;
  const firstPostDelayScale = getProjectileHomingEngagementScale(rocket, delayMs, fixedStepMs);
  assertContract(
    firstPostDelayScale > 0 && firstPostDelayScale < 0.001,
    `first 30Hz post-delay guidance step must be a very small soft-start; got ${firstPostDelayScale}`,
  );
  assertNear(
    getProjectileHomingEngagementScale(rocket, delayMs + 350 - fixedStepMs * 0.5, fixedStepMs),
    0.5,
    'rocket homing engagement should reach half strength halfway through the smootherstep ramp',
    1e-6,
  );
  assertContract(
    getProjectileHomingEngagementScale(rocket, delayMs + 700, fixedStepMs) === 1,
    'rocket homing engagement must reach full strength after the ramp',
  );
}
