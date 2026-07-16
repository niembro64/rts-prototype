import { legRestSphereNeedsStep, legSurfaceWithinReach } from './LegGait3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[leg rig contract] ${message}`);
}

export function runLegRig3DContractTest(): void {
  assertContract(
    !legRestSphereNeedsStep(9.99 * 9.99, 10),
    'a foot inside its authored rest sphere remains planted',
  );
  assertContract(
    !legRestSphereNeedsStep(10 * 10, 10),
    'a foot on the rest-sphere boundary remains planted',
  );
  assertContract(
    legRestSphereNeedsStep(10.01 * 10.01, 10),
    'a foot outside its authored rest sphere starts a grounded step',
  );
  assertContract(
    legSurfaceWithinReach(9.98 * 9.98, 10, 0.999),
    'a nearly straight leg can reacquire reachable terrain',
  );
  assertContract(
    !legSurfaceWithinReach(10.01 * 10.01, 10, 0.999),
    'terrain outside physical reach remains unsupported',
  );
}
