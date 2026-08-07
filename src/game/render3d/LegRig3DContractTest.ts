import * as THREE from 'three';
import {
  legChoppedSphereNeedsStep,
  legSurfaceWithinReach,
  resolveLegChoppingSphereRadius,
  resolveLegChoppedSphereVelocityTarget,
  resolveLegSnapRayOrigin,
  resolveLegSnapRayPointVelocity,
  resolveLegSnapSphereLocal,
} from './LegGait3D';
import { locomotionTerrainModeForSupportHeight } from './LocomotionTerrainSampler';
import { WATER_LEVEL } from '../sim/Terrain';
import {
  resolveContactLockedFootOrientation,
  resolveKneeJointQuaternion,
  resolveLegFootSurfaceQuaternion,
  resolveLegSegmentRight,
} from './LegRig3D';
import {
  kneeFromIK,
  LEG_ATTACHMENT_RADIUS_MULTIPLIER,
  LEG_ATTACHMENT_SPHERE_RADIUS_MULTIPLIER,
  LEG_FOOT_RADIUS_MULTIPLIER,
  LEG_FOOT_TAPER_LENGTH_MULTIPLIER,
  LEG_KNEE_SPHERE_RADIUS_MULTIPLIER,
  resolveLegFootYaw,
  resolveLowerLegFootTaperStart,
} from './LocomotionRigShared3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[leg rig contract] ${message}`);
}

export function runLegRig3DContractTest(): void {
  assertContract(
    LEG_ATTACHMENT_RADIUS_MULTIPLIER === 2,
    'the body attachment is exactly twice the shared knee/foot radius',
  );
  assertContract(
    LEG_ATTACHMENT_SPHERE_RADIUS_MULTIPLIER === 2.5,
    'the attachment sphere is exactly 2.5x the shared knee/foot radius',
  );
  assertContract(
    LEG_KNEE_SPHERE_RADIUS_MULTIPLIER === 0.75,
    'the knee sphere is exactly 0.75x the shared segment radius',
  );
  assertContract(
    LEG_FOOT_RADIUS_MULTIPLIER === 1.5,
    'the foot hemisphere is exactly 1.5x the shared segment radius',
  );
  assertContract(
    LEG_FOOT_TAPER_LENGTH_MULTIPLIER === 2,
    'the pointed lower-leg section is exactly two foot radii long',
  );
  const taperStart = { x: 0, y: 0, z: 0 };
  const realizedTaperLength = resolveLowerLegFootTaperStart(
    0, 10, 0,
    0, 0, 0,
    1.5,
    taperStart,
  );
  assertContract(
    realizedTaperLength === 3 && taperStart.x === 0 && taperStart.y === 3 && taperStart.z === 0,
    'the lower-leg taper begins two foot radii up from the foot endpoint',
  );
  const chassisUpLength = Math.hypot(0.2, 0.8, 0.56);
  const chassisUp = {
    x: 0.2 / chassisUpLength,
    y: 0.8 / chassisUpLength,
    z: 0.56 / chassisUpLength,
  };
  const hip = { x: 2, y: 15, z: -4 };
  const foot = { x: 18, y: 1, z: 9 };
  const knee = kneeFromIK(
    hip.x, hip.y, hip.z,
    foot.x, foot.y, foot.z,
    18, 20,
    chassisUp.x, chassisUp.y, chassisUp.z,
  );
  const segmentRight = { x: 0, y: 0, z: 0 };
  resolveLegSegmentRight(
    hip.x, hip.y, hip.z,
    foot.x, foot.y, foot.z,
    chassisUp.x, chassisUp.y, chassisUp.z,
    segmentRight,
  );
  const upperRightDot =
    segmentRight.x * (knee.x - hip.x) +
    segmentRight.y * (knee.y - hip.y) +
    segmentRight.z * (knee.z - hip.z);
  const lowerRightDot =
    segmentRight.x * (foot.x - knee.x) +
    segmentRight.y * (foot.y - knee.y) +
    segmentRight.z * (foot.z - knee.z);
  assertContract(
    Math.abs(upperRightDot) < 1e-9 && Math.abs(lowerRightDot) < 1e-9,
    'upper and lower leg segments share one roll axis through the knee',
  );
  assertContract(
    Math.abs(Math.hypot(segmentRight.x, segmentRight.y, segmentRight.z) - 1) < 1e-9,
    'the shared leg roll axis remains normalized on a tilted chassis',
  );
  const footYaw = resolveLegFootYaw(
    segmentRight.x,
    segmentRight.z,
    foot.x - knee.x,
    foot.z - knee.z,
  );
  const footQuaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    footYaw,
  );
  const footLocalRight = new THREE.Vector3(1, 0, 0).applyQuaternion(footQuaternion);
  const expectedHorizontalRight = new THREE.Vector3(
    segmentRight.x, 0, segmentRight.z,
  ).normalize();
  const footLocalDown = new THREE.Vector3(0, -1, 0).applyQuaternion(footQuaternion);
  assertContract(
    footLocalRight.dot(expectedHorizontalRight) > 1 - 1e-9,
    'the swinging-foot yaw candidate follows the leg segments shared horizontal roll axis',
  );
  assertContract(
    footLocalDown.y < -1 + 1e-9 && Math.abs(footLocalDown.x) < 1e-9 && Math.abs(footLocalDown.z) < 1e-9,
    'the yawed foot keeps its flat cap normal pointing world-down',
  );
  const slopeNormal = new THREE.Vector3(0.2, 0.93, 0.3).normalize();
  const slopeQuaternion = resolveLegFootSurfaceQuaternion(
    0.5,
    slopeNormal.x,
    slopeNormal.y,
    slopeNormal.z,
    new THREE.Quaternion(),
  );
  const slopeFootUp = new THREE.Vector3(0, 1, 0).applyQuaternion(slopeQuaternion);
  const slopeFootDown = new THREE.Vector3(0, -1, 0).applyQuaternion(slopeQuaternion);
  assertContract(
    slopeFootUp.dot(slopeNormal) > 1 - 1e-9 &&
      slopeFootDown.dot(slopeNormal.clone().multiplyScalar(-1)) > 1 - 1e-9,
    'the foot flat cap lies tangent to its touchdown terrain normal',
  );
  const footOrientationState = {
    contactState: 'stepping' as 'planted' | 'stepping' | 'free',
    footQuaternionX: 0,
    footQuaternionY: 0,
    footQuaternionZ: 0,
    footQuaternionW: 1,
    plantedFootOrientationLocked: false,
  };
  resolveContactLockedFootOrientation(
    footOrientationState,
    0.25,
    slopeNormal.x,
    slopeNormal.y,
    slopeNormal.z,
  );
  const swingQuaternion = new THREE.Quaternion(
    footOrientationState.footQuaternionX,
    footOrientationState.footQuaternionY,
    footOrientationState.footQuaternionZ,
    footOrientationState.footQuaternionW,
  );
  assertContract(
    new THREE.Vector3(0, 1, 0).applyQuaternion(swingQuaternion).y > 1 - 1e-9 &&
      !footOrientationState.plantedFootOrientationLocked,
    'a stepping foot follows leg yaw while remaining world-up and unlocked',
  );
  footOrientationState.contactState = 'planted';
  resolveContactLockedFootOrientation(
    footOrientationState,
    0.5,
    slopeNormal.x,
    slopeNormal.y,
    slopeNormal.z,
  );
  const touchdownQuaternion = new THREE.Quaternion(
    footOrientationState.footQuaternionX,
    footOrientationState.footQuaternionY,
    footOrientationState.footQuaternionZ,
    footOrientationState.footQuaternionW,
  );
  assertContract(
    new THREE.Vector3(0, 1, 0).applyQuaternion(touchdownQuaternion).dot(slopeNormal) > 1 - 1e-9 &&
      footOrientationState.plantedFootOrientationLocked,
    'touchdown captures the complete terrain-aligned foot orientation',
  );
  const plantedQuaternion = touchdownQuaternion.toArray();
  resolveContactLockedFootOrientation(footOrientationState, 1.25, 0, 1, 0);
  assertContract(
    footOrientationState.footQuaternionX === plantedQuaternion[0] &&
      footOrientationState.footQuaternionY === plantedQuaternion[1] &&
      footOrientationState.footQuaternionZ === plantedQuaternion[2] &&
      footOrientationState.footQuaternionW === plantedQuaternion[3],
    'a planted foot ignores later leg-yaw and terrain-normal changes',
  );
  footOrientationState.contactState = 'stepping';
  resolveContactLockedFootOrientation(footOrientationState, 1.25, 0, 1, 0);
  assertContract(
    !footOrientationState.plantedFootOrientationLocked,
    'lifting the foot releases its orientation lock for the next step',
  );
  footOrientationState.contactState = 'planted';
  const nextSlopeNormal = new THREE.Vector3(-0.35, 0.9, 0.2).normalize();
  resolveContactLockedFootOrientation(
    footOrientationState,
    1.5,
    nextSlopeNormal.x,
    nextSlopeNormal.y,
    nextSlopeNormal.z,
  );
  const nextTouchdownQuaternion = new THREE.Quaternion(
    footOrientationState.footQuaternionX,
    footOrientationState.footQuaternionY,
    footOrientationState.footQuaternionZ,
    footOrientationState.footQuaternionW,
  );
  assertContract(
    new THREE.Vector3(0, 1, 0).applyQuaternion(nextTouchdownQuaternion).dot(nextSlopeNormal) > 1 - 1e-9 &&
      footOrientationState.plantedFootOrientationLocked,
    'the next touchdown captures its new local terrain orientation',
  );
  const kneeQuaternion = resolveKneeJointQuaternion(
    hip.x, hip.y, hip.z,
    knee.x, knee.y, knee.z,
    foot.x, foot.y, foot.z,
    segmentRight.x, segmentRight.y, segmentRight.z,
    new THREE.Quaternion(),
  );
  const kneeLocalRight = new THREE.Vector3(1, 0, 0).applyQuaternion(kneeQuaternion);
  const kneeLocalUp = new THREE.Vector3(0, 1, 0).applyQuaternion(kneeQuaternion);
  const expectedKneeTangent = new THREE.Vector3(
    knee.x - hip.x,
    knee.y - hip.y,
    knee.z - hip.z,
  ).normalize().add(new THREE.Vector3(
    foot.x - knee.x,
    foot.y - knee.y,
    foot.z - knee.z,
  ).normalize()).normalize();
  assertContract(
    kneeLocalRight.dot(new THREE.Vector3(
      segmentRight.x, segmentRight.y, segmentRight.z,
    )) > 1 - 1e-9,
    'the knee sphere keeps the roll axis shared by both leg segments',
  );
  assertContract(
    kneeLocalUp.dot(expectedKneeTangent) > 1 - 1e-9,
    'the knee sphere follows the upper/lower segment direction bisector',
  );
  assertContract(
    locomotionTerrainModeForSupportHeight(WATER_LEVEL - 0.01) === 'terrainBed',
    'a submerged physical support makes leg feet sample the terrain bed',
  );
  assertContract(
    locomotionTerrainModeForSupportHeight(WATER_LEVEL) === 'visibleSurface',
    'support on the water plane retains visible-surface locomotion sampling',
  );
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
