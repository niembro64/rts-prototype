import * as THREE from 'three';
import {
  clampPointToLegShell,
  legChoppedSphereNeedsStep,
  legSurfaceWithinReach,
  resolveLegChoppedSphereVelocityTarget,
  resolveLegChoppingSphereRadius,
  resolveLegOutwardGroundPointLocal,
  resolveLegReachShell,
  resolveLegSnapRayOrigin,
  resolveLegSnapRayPointVelocity,
  resolveLegSnapSphereLocal,
} from './LegGait3D';
import { locomotionTerrainModeForSupportHeight } from './LocomotionTerrainSampler';
import { WATER_LEVEL } from '../sim/Terrain';
import {
  resolveContactLockedFootOrientation,
  resolveLegAttachmentYawQuaternion,
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
  // ── NO BONE MAY EVER STRETCH ───────────────────────────────────────────
  //
  // The architecture has always assumed a leg segment is the length it was
  // authored. The solver honoured that for the UPPER bone — the knee is placed
  // at exactly `upperLen` — and quietly broke it for the lower one: it solved
  // the knee angle for `upperLen + lowerLen * 0.98` while the caller went on
  // drawing knee-to-the-requested-foot, so the lower bone absorbed the whole
  // difference. Two percent at full extension, and unbounded past it.
  //
  // Swept over reachable, exactly-straight and far-out-of-reach requests,
  // through the fold limit, and straight up the chassis-up axis where the
  // in-plane basis degenerates.
  for (const [upperLen, lowerLen] of [[18, 20], [20, 18], [10, 10], [4, 9]] as const) {
    for (const request of [
      { x: 18, y: 1, z: 9 },
      { x: 2, y: 15 - (upperLen + lowerLen), z: -4 },
      { x: 2 + (upperLen + lowerLen), y: 15, z: -4 },
      { x: 400, y: -300, z: 250 },
      { x: 2.0001, y: 15.0001, z: -4 },
      { x: 2, y: 15 + upperLen + lowerLen, z: -4 },
      { x: 2 + Math.abs(upperLen - lowerLen) * 0.5, y: 15, z: -4 },
    ]) {
      const solved = kneeFromIK(
        hip.x, hip.y, hip.z,
        request.x, request.y, request.z,
        upperLen, lowerLen,
        chassisUp.x, chassisUp.y, chassisUp.z,
      );
      const upperDrawn = Math.hypot(
        solved.x - hip.x, solved.y - hip.y, solved.z - hip.z,
      );
      const lowerDrawn = Math.hypot(
        solved.footX - solved.x, solved.footY - solved.y, solved.footZ - solved.z,
      );
      const label = `${upperLen}/${lowerLen} -> (${request.x},${request.y},${request.z})`;
      assertContract(
        Math.abs(upperDrawn - upperLen) < 1e-6,
        `upper bone drawn at ${upperDrawn.toFixed(4)}, authored ${upperLen} (${label})`,
      );
      assertContract(
        Math.abs(lowerDrawn - lowerLen) < 1e-6,
        `lower bone drawn at ${lowerDrawn.toFixed(4)}, authored ${lowerLen} (${label})`,
      );
      // ...and the foot it reports is on the hip ray at a reachable distance,
      // so a caller that draws to it can never place the foot out of reach.
      const reach = Math.hypot(
        solved.footX - hip.x, solved.footY - hip.y, solved.footZ - hip.z,
      );
      assertContract(
        reach <= upperLen + lowerLen + 1e-6,
        `solved foot ${reach.toFixed(4)} past full extension (${label})`,
      );
      const requested = Math.hypot(
        request.x - hip.x, request.y - hip.y, request.z - hip.z,
      );
      const fold = Math.abs(upperLen - lowerLen);
      assertContract(
        solved.clamped === (requested > upperLen + lowerLen + 1e-9 || requested < fold - 1e-9),
        `clamped flag must report exactly when the request left the shell (${label})`,
      );
      assertContract(
        reach >= fold - 1e-6,
        `solved foot ${reach.toFixed(4)} inside the fold limit ${fold} (${label})`,
      );
    }
  }

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
  const hipSocketQuaternion = resolveLegAttachmentYawQuaternion(
    hip.x, hip.z,
    knee.x, knee.z,
    new THREE.Quaternion(),
  );
  const hipSocketSlotAxis = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(hipSocketQuaternion);
  const expectedUpperLegYaw = new THREE.Vector3(
    knee.x - hip.x,
    0,
    knee.z - hip.z,
  ).normalize();
  assertContract(
    hipSocketSlotAxis.dot(expectedUpperLegYaw) > 1 - 1e-9,
    'the hip attachment black slot yaws into the upper leg travel plane',
  );
  const sweptHipSocketQuaternion = resolveLegAttachmentYawQuaternion(
    hip.x, hip.z,
    knee.x - 12, knee.z + 9,
    new THREE.Quaternion(),
  );
  assertContract(
    hipSocketQuaternion.angleTo(sweptHipSocketQuaternion) > 0.25,
    'the hip attachment visibly yaws when the leg sweeps forward or backward',
  );
  assertContract(
    new THREE.Vector3(0, 1, 0).applyQuaternion(hipSocketQuaternion).y > 1 - 1e-9,
    'hip attachment motion is yaw-only so its black travel slot stays vertical',
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
    footContactNormalX: 0,
    footContactNormalY: 1,
    footContactNormalZ: 0,
    footTargetNormalX: 0,
    footTargetNormalY: 1,
    footTargetNormalZ: 0,
    footContactOrientationCaptured: false,
    lerpProgress: 0,
  };
  const footSole = (): THREE.Vector3 => new THREE.Vector3(0, 1, 0).applyQuaternion(
    new THREE.Quaternion(
      footOrientationState.footQuaternionX,
      footOrientationState.footQuaternionY,
      footOrientationState.footQuaternionZ,
      footOrientationState.footQuaternionW,
    ),
  );
  const footHeading = (): THREE.Vector3 => new THREE.Vector3(1, 0, 0).applyQuaternion(
    new THREE.Quaternion(
      footOrientationState.footQuaternionX,
      footOrientationState.footQuaternionY,
      footOrientationState.footQuaternionZ,
      footOrientationState.footQuaternionW,
    ),
  );
  /** The heading a yaw lays into a plane: the yaw's horizontal direction made
   *  tangent to the normal. This is what the foot is allowed to follow. */
  const headingInPlane = (yawAngle: number, normal: THREE.Vector3): THREE.Vector3 =>
    new THREE.Vector3(Math.cos(yawAngle), 0, -Math.sin(yawAngle))
      .projectOnPlane(normal)
      .normalize();

  resolveContactLockedFootOrientation(
    footOrientationState,
    0.25,
    slopeNormal.x,
    slopeNormal.y,
    slopeNormal.z,
  );
  assertContract(
    footSole().y > 1 - 1e-9 && !footOrientationState.footContactOrientationCaptured,
    'a foot that has never touched ground stands on the flat world plane',
  );

  footOrientationState.contactState = 'planted';
  resolveContactLockedFootOrientation(
    footOrientationState,
    0.5,
    slopeNormal.x,
    slopeNormal.y,
    slopeNormal.z,
  );
  assertContract(
    footSole().dot(slopeNormal) > 1 - 1e-9 &&
      footOrientationState.footContactOrientationCaptured,
    'touchdown captures the contacted plane as the sole plane',
  );

  // Still planted, but the leg has swung to a new heading over ground whose
  // normal has changed underfoot. The foot turns; the plane does not.
  resolveContactLockedFootOrientation(footOrientationState, 1.25, 0, 1, 0);
  assertContract(
    footSole().dot(slopeNormal) > 1 - 1e-9,
    'a planted foot keeps its captured plane when the terrain normal changes',
  );
  assertContract(
    footHeading().dot(headingInPlane(1.25, slopeNormal)) > 1 - 1e-9,
    'a planted foot rotates within that plane to follow its leg heading',
  );

  // Lift-off already knows the next foothold. The foot begins at the old
  // terrain angle, reaches the angular midpoint at half progress, and arrives
  // at the new terrain angle before touchdown can introduce a discontinuity.
  const nextSlopeNormal = new THREE.Vector3(-0.35, 0.9, 0.2).normalize();
  footOrientationState.contactState = 'stepping';
  footOrientationState.footTargetNormalX = nextSlopeNormal.x;
  footOrientationState.footTargetNormalY = nextSlopeNormal.y;
  footOrientationState.footTargetNormalZ = nextSlopeNormal.z;
  footOrientationState.lerpProgress = 0;
  resolveContactLockedFootOrientation(footOrientationState, -2.4, 0, 1, 0);
  const swingStart = new THREE.Quaternion(
    footOrientationState.footQuaternionX,
    footOrientationState.footQuaternionY,
    footOrientationState.footQuaternionZ,
    footOrientationState.footQuaternionW,
  );
  const swingStartNormal = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(swingStart);
  const expectedSwingStart = resolveLegFootSurfaceQuaternion(
    -2.4,
    slopeNormal.x,
    slopeNormal.y,
    slopeNormal.z,
    new THREE.Quaternion(),
  );
  assertContract(
    footOrientationState.footContactOrientationCaptured &&
      swingStart.angleTo(expectedSwingStart) < 1e-9,
    'a lifted foot begins at the previous foothold angle',
  );

  const expectedSwingEnd = resolveLegFootSurfaceQuaternion(
    -2.4,
    nextSlopeNormal.x,
    nextSlopeNormal.y,
    nextSlopeNormal.z,
    new THREE.Quaternion(),
  );
  footOrientationState.lerpProgress = 0.5;
  resolveContactLockedFootOrientation(footOrientationState, -2.4, 0, 1, 0);
  const swingMid = new THREE.Quaternion(
    footOrientationState.footQuaternionX,
    footOrientationState.footQuaternionY,
    footOrientationState.footQuaternionZ,
    footOrientationState.footQuaternionW,
  );
  const swingMidNormal = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(swingMid);
  assertContract(
    Math.abs(
      swingStartNormal.angleTo(swingMidNormal) * 2 -
      swingStartNormal.angleTo(nextSlopeNormal)
    ) < 1e-9,
    'a stepping foot linearly interpolates half of its angular displacement at half progress',
  );
  assertContract(
    footHeading().dot(headingInPlane(-2.4, footSole())) > 1 - 1e-9,
    'an interpolating foot still follows the live leg heading within its current plane',
  );

  footOrientationState.lerpProgress = 1;
  resolveContactLockedFootOrientation(footOrientationState, -2.4, 0, 1, 0);
  const beforeTouchdown = new THREE.Quaternion(
    footOrientationState.footQuaternionX,
    footOrientationState.footQuaternionY,
    footOrientationState.footQuaternionZ,
    footOrientationState.footQuaternionW,
  );
  assertContract(
    beforeTouchdown.angleTo(expectedSwingEnd) < 1e-9 &&
      footSole().dot(nextSlopeNormal) > 1 - 1e-9,
    'the foot reaches the next foothold angle at the end of its swing',
  );

  // advanceGroundedLegSlide promotes the already-rendered target normal.
  // Rebuilding the planted pose from it must therefore be identical.
  footOrientationState.contactState = 'planted';
  footOrientationState.footContactNormalX = nextSlopeNormal.x;
  footOrientationState.footContactNormalY = nextSlopeNormal.y;
  footOrientationState.footContactNormalZ = nextSlopeNormal.z;
  resolveContactLockedFootOrientation(
    footOrientationState,
    -2.4,
    nextSlopeNormal.x,
    nextSlopeNormal.y,
    nextSlopeNormal.z,
  );
  assertContract(
    beforeTouchdown.angleTo(new THREE.Quaternion(
      footOrientationState.footQuaternionX,
      footOrientationState.footQuaternionY,
      footOrientationState.footQuaternionZ,
      footOrientationState.footQuaternionW,
    )) < 1e-9,
    'touchdown promotes the target angle without snapping to a new one',
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
  // ── AUTHORED GAIT ENVELOPE, MECHANICAL REACH SHELL ─────────────────────
  //
  // Gait stays outward-biased: the offset outer foot sphere selects a leg's
  // working region and the attachment-ground chopping sphere removes the
  // under-hull region. The hip-centred shell is an independent IK limit.
  const shell = resolveLegReachShell(4, 6);
  assertContract(
    shell.outerRadius === 10,
    'the outer bound is the leg straight — the two bones added, nothing else',
  );
  assertContract(
    shell.innerRadius === 2,
    'the mechanical inner bound is the true fold limit |upper - lower|',
  );
  const foldFloored = resolveLegReachShell(4, 9);
  assertContract(
    foldFloored.innerRadius === 5,
    'the shell never reaches inside |A - B|, which is a pose the knee cannot make',
  );

  // Clamping puts a point back on the shell, from either side.
  const clamped = { x: 0, y: 0, z: 0 };
  assertContract(
    clampPointToLegShell(0, 0, 0, 30, 0, 0, shell, clamped)
      && Math.abs(clamped.x - 10) < 1e-9,
    'a foot past full extension is pulled back to the outer bound',
  );
  assertContract(
    clampPointToLegShell(0, 0, 0, 1, 0, 0, shell, clamped)
      && Math.abs(clamped.x - 2) < 1e-9,
    'a foot inside the fold limit is pushed back out to the inner bound',
  );
  assertContract(
    !clampPointToLegShell(0, 0, 0, 0, -5, 0, shell, clamped) && clamped.y === -5,
    'a foot already inside the shell is left exactly where it is',
  );
  for (const [x, y, z] of [[7, -7, 3], [0.4, -0.2, 0.1], [-20, 5, 12], [0, -10, 0]]) {
    clampPointToLegShell(0, 0, 0, x, y, z, shell, clamped);
    const d = Math.hypot(clamped.x, clamped.y, clamped.z);
    assertContract(
      d <= shell.outerRadius + 1e-9 && d >= shell.innerRadius - 1e-9,
      `clamping must land inside the shell — ${d.toFixed(4)} from (${x},${y},${z})`,
    );
  }

  const gaitLocal = {
    centerX: 0,
    centerZ: 0,
    outwardX: 0,
    outwardZ: 0,
    radius: 0,
  };
  resolveLegSnapSphereLocal(2, 0, 10, 0.5, 0.5, gaitLocal);
  assertContract(
    gaitLocal.centerX === 7 && gaitLocal.centerZ === 0 &&
      gaitLocal.outwardX === 12 && gaitLocal.outwardZ === 0 &&
      gaitLocal.radius === 5,
    'the gait sphere remains offset outward from the hip by its authored station',
  );
  const choppingRadius = resolveLegChoppingSphereRadius(10, 0.3);
  assertContract(
    choppingRadius === 3,
    'the attachment-ground chopping radius remains independently authored',
  );
  assertContract(
    legChoppedSphereNeedsStep(5 * 5, 5, 0, choppingRadius),
    'a foot directly beneath its attachment enters the chopping sphere and must step',
  );
  assertContract(
    !legChoppedSphereNeedsStep(1, 5, 4 * 4, choppingRadius),
    'a foot inside the outward sphere and outside the chopping sphere stays planted',
  );

  const outerCenter = { x: 7, y: 0, z: 0 };
  const choppingCenter = { x: 2, y: 0, z: 0 };
  const outward = { x: 12, y: 0, z: 0 };
  const snapRayOrigin = { x: 0, y: 0, z: 0 };
  resolveLegSnapRayOrigin(
    outerCenter,
    gaitLocal.radius,
    choppingCenter,
    choppingRadius,
    0.5,
    snapRayOrigin,
  );
  assertContract(
    Math.abs(snapRayOrigin.x - 8.5) < 1e-9,
    'the ray origin spans the authored space between chopping and outer boundaries',
  );
  const velocityTarget = { x: 0, y: 0, z: 0 };
  resolveLegChoppedSphereVelocityTarget(
    snapRayOrigin, outerCenter, gaitLocal.radius,
    choppingCenter, choppingRadius,
    1, 0, outward, velocityTarget,
  );
  assertContract(
    Math.abs(velocityTarget.x - 12) < 1e-9,
    'outward motion plants on the outward foot-sphere boundary',
  );
  resolveLegChoppedSphereVelocityTarget(
    snapRayOrigin, outerCenter, gaitLocal.radius,
    choppingCenter, choppingRadius,
    -1, 0, outward, velocityTarget,
  );
  assertContract(
    Math.abs(velocityTarget.x - 5) < 1e-9,
    'inward motion stops on the chopping boundary before a foot can pass under the unit',
  );

  const station = { x: 0, z: 0 };
  resolveLegOutwardGroundPointLocal(3, 4, 5, station);
  assertContract(
    Math.abs(station.x - 6) < 1e-9 && Math.abs(station.z - 8) < 1e-9,
    'the outward station runs along the attachment ray from the attachment',
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
