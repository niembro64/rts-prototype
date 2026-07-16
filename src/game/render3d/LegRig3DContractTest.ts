import {
  constrainLegStepDirectionOutward,
  legStepNeedsReplant,
  legStepCanRearm,
  legFootTrailsMovement,
  legSurfaceWithinReach,
  legStepNeedsSwing,
  legSwingArcHeight,
  resolveLegStepDirection,
} from './LegGait3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[leg rig contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  assertContract(Math.abs(actual - expected) < 1e-9, `${message}: got ${actual}`);
}

export function runLegRig3DContractTest(): void {
  assertContract(
    !legStepNeedsReplant(81, 10, 0.995, true),
    'a shortened armed leg remains world-fixed',
  );
  assertContract(
    legStepNeedsReplant(9.96 * 9.96, 10, 0.995, true),
    'an armed leg starts its step only at near-full extension',
  );
  assertContract(
    !legStepNeedsReplant(10 * 10, 10, 0.995, false),
    'a newly landed fully extended leg cannot immediately tap again',
  );
  assertContract(
    legStepCanRearm(9.3 * 9.3, 10, 0.94),
    'the foot rearms after the hip has meaningfully shortened the leg',
  );
  assertContract(
    !legStepCanRearm(9.5 * 9.5, 10, 0.94),
    'the rearm latch retains hysteresis above its shortened stance',
  );
  assertContract(
    legFootTrailsMovement(-4, 0, 2, 0, 0.05),
    'a direction reversal rearms a now-trailing fully extended foot',
  );
  assertContract(
    !legFootTrailsMovement(4, 0, 2, 0, 0.05),
    'a newly landed forward foot remains disarmed',
  );
  assertContract(
    !legFootTrailsMovement(-4, 0, 0.001, 0, 0.05),
    'idle velocity noise cannot rearm a foot',
  );
  assertNear(legSwingArcHeight(0, 4), 0, 'a step starts on its support surface');
  assertNear(legSwingArcHeight(0.5, 4), 4, 'a step clears the surface at mid-swing');
  assertNear(legSwingArcHeight(1, 4), 0, 'a step lands on its target surface');
  assertContract(
    legSurfaceWithinReach(9.98 * 9.98, 10, 0.999),
    'a nearly straight authored leg can reacquire reachable terrain',
  );
  assertContract(
    !legSurfaceWithinReach(10.01 * 10.01, 10, 0.999),
    'terrain outside physical reach remains unsupported',
  );

  const direction = { x: 0, z: 0 };
  assertContract(
    resolveLegStepDirection(3, 4, -1, 0, 0.05, direction),
    'moving legs resolve a stride direction',
  );
  assertNear(direction.x, 0.6, 'stride follows body movement X');
  assertNear(direction.z, 0.8, 'stride follows body movement Z');
  assertContract(
    resolveLegStepDirection(0, 0, -2, 0, 0.05, direction),
    'rotation-only boundary crossings retain an opposite-side stride',
  );
  assertNear(direction.x, -1, 'rotation-only stride opposes the escape direction');
  assertNear(direction.z, 0, 'rotation-only stride remains normalized');
  assertContract(
    !resolveLegStepDirection(0, 0, 0, 0, 0.05, direction),
    'an idle centered foot has no fabricated stride direction',
  );
  assertContract(
    constrainLegStepDirectionOutward(1, 1, 1, 0, direction),
    'an outward-forward request remains a usable stride',
  );
  assertNear(direction.x, Math.SQRT1_2, 'outward stride component is preserved');
  assertNear(direction.z, Math.SQRT1_2, 'tangential stride component is preserved');
  assertContract(
    constrainLegStepDirectionOutward(-1, 1, 1, 0, direction),
    'a mixed inward-sideways request retains its safe tangential component',
  );
  assertNear(direction.x, 0, 'inward stride component is projected away');
  assertNear(direction.z, 1, 'safe tangential stride remains');
  assertContract(
    !constrainLegStepDirectionOutward(-1, 0, 1, 0, direction),
    'a purely inward request falls back to the authored outward rest ray',
  );
  assertNear(direction.x, 0, 'pure inward request cannot cross the hip in X');
  assertNear(direction.z, 0, 'pure inward request cannot fabricate a tangent');

  assertContract(
    !legStepNeedsSwing(0.01, 0.2),
    'a microscopic idle correction does not produce a visible tap',
  );
  assertContract(
    legStepNeedsSwing(4, 0.2),
    'a meaningful stride still produces a swing cycle',
  );
}
