import {
  legChoppedSphereNeedsStep,
  legSurfaceWithinReach,
  resolveLegChoppingSphereRadius,
  resolveLegChoppedSphereVelocityTarget,
  resolveLegSnapRayOrigin,
  resolveLegSnapRayPointVelocity,
  resolveLegSnapSphereLocal,
} from './LegGait3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[leg rig contract] ${message}`);
}

export function runLegRig3DContractTest(): void {
  const pointVelocity = { x: 0, z: 0 };
  resolveLegSnapRayPointVelocity(13, 24, 10, 20, 500, pointVelocity);
  assertContract(pointVelocity.x === 6 && pointVelocity.z === 8,
    'snap targeting measures the ray-origin point own frame-to-frame velocity');
  assertContract(
    resolveLegChoppingSphereRadius(15, 0.4) === 6,
    'chopping radius is the authored ratio of total leg length',
  );
  const sphere = {
    centerX: 0,
    centerZ: 0,
    outwardX: 0,
    outwardZ: 0,
    radius: 0,
  };
  resolveLegSnapSphereLocal(3, 4, 10, 0.5, 0.5, sphere);
  assertContract(sphere.centerX === 6 && sphere.centerZ === 8,
    'sphere center is halfway from the attachment to full extension');
  assertContract(sphere.outwardX === 9 && sphere.outwardZ === 12,
    'outward sphere surface is one total leg length beyond the attachment');
  assertContract(sphere.radius === 5,
    'sphere radius is half of total leg length');
  resolveLegSnapSphereLocal(3, 4, 10, 0.25, 0.2, sphere);
  assertContract(
    Math.abs(sphere.centerX - 4.5) < 1e-9 && Math.abs(sphere.centerZ - 6) < 1e-9,
    'authored origin ratio positions the sphere along the attachment-to-extension ray');
  assertContract(
    sphere.outwardX === 9 && sphere.outwardZ === 12 && Math.abs(sphere.radius - 2) < 1e-9,
    'authored radius ratio does not change the maximum-extension point');
  const velocityTarget = { x: 0, y: 0, z: 0 };
  const fallbackTarget = { x: 0, y: 0, z: 0 };
  const rayOrigin = { x: 0, y: 0, z: 0 };
  resolveLegSnapRayOrigin(
    { x: 10, y: 0, z: 0 },
    5,
    { x: 0, y: 0, z: 0 },
    8,
    0.9,
    rayOrigin,
  );
  assertContract(Math.abs(rayOrigin.x - 14.3) < 1e-9 && rayOrigin.z === 0,
    'snap-ray origin is 90% from the chopping boundary to the outer foot boundary');
  resolveLegChoppedSphereVelocityTarget(
    rayOrigin,
    { x: 10, y: 0, z: 0 },
    5,
    { x: 0, y: 0, z: 0 },
    8,
    1,
    0,
    { x: 15, y: 0, z: 0 },
    velocityTarget,
  );
  assertContract(
    velocityTarget.x === 15 && velocityTarget.y === 0 && velocityTarget.z === 0,
    'an outward velocity ray reaches the outer foot-sphere boundary',
  );
  resolveLegChoppedSphereVelocityTarget(
    rayOrigin,
    { x: 10, y: 0, z: 0 },
    5,
    { x: 0, y: 0, z: 0 },
    8,
    -1,
    0,
    { x: 15, y: 0, z: 0 },
    fallbackTarget,
  );
  assertContract(fallbackTarget.x === 8 && fallbackTarget.y === 0 && fallbackTarget.z === 0,
    'an inward velocity ray stops at the central exclusion boundary');
  assertContract(
    !legChoppedSphereNeedsStep(9.99 * 9.99, 10, 10.01 * 10.01, 10),
    'a foot inside the outer sphere and outside the inner sphere remains planted',
  );
  assertContract(
    !legChoppedSphereNeedsStep(10 * 10, 10, 10 * 10, 10),
    'both chopped-envelope boundaries remain valid planting sites',
  );
  assertContract(
    legChoppedSphereNeedsStep(10.01 * 10.01, 10, 10.01 * 10.01, 10),
    'a foot outside its outer sphere starts a grounded step',
  );
  assertContract(
    legChoppedSphereNeedsStep(9.99 * 9.99, 10, 9.99 * 9.99, 10),
    'a foot inside the central exclusion sphere starts a grounded step',
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
