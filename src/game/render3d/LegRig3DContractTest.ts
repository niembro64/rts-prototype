import * as THREE from 'three';
import {
  clampPointToLegShell,
  legFootNeedsStep,
  legSurfaceWithinReach,
  resolveLegGroundAnnulus,
  resolveLegGroundRayOrigin,
  resolveLegGroundStepTarget,
  resolveLegOutwardGroundPointLocal,
  resolveLegReachShell,
  resolveLegSnapRayPointVelocity,
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
  // ── REACH IS A SHELL, NOT A CYLINDER ───────────────────────────────────
  //
  // A two-segment leg reaches [|A - B|, A + B] from its hip and nothing else.
  // The old envelope was horizontal discs on the ground with the hip's own
  // height discarded, which claimed a full leg length of sideways reach no
  // matter how tall the body stood.
  const shell = resolveLegReachShell(4, 6, 0.3);
  assertContract(
    shell.outerRadius === 10,
    'the outer bound is the leg straight — the two bones added, nothing else',
  );
  assertContract(
    shell.innerRadius === 3,
    'the authored gait margin sets the inner bound when it clears the fold limit',
  );
  const foldFloored = resolveLegReachShell(4, 9, 0.1);
  assertContract(
    foldFloored.innerRadius === 5,
    'the authored margin may shrink the envelope but never reach inside the '
      + 'fold limit |A - B|, which is a pose the knee cannot make',
  );

  // The correction itself: the reachable GROUND shrinks as the hip rises.
  const flat = resolveLegGroundAnnulus(shell, 0);
  assertContract(
    flat.reachable && Math.abs(flat.outerRadius - 10) < 1e-9,
    'a hip at ground level reaches a full leg length along the ground',
  );
  const raised = resolveLegGroundAnnulus(shell, 6);
  assertContract(
    raised.reachable && Math.abs(raised.outerRadius - 8) < 1e-9,
    'a hip 6 above the ground reaches sqrt(10^2 - 6^2) = 8 along it, not 10 — '
      + 'this is the cylinder-to-sphere fix in one number',
  );
  assertContract(
    raised.outerRadius < shell.outerRadius,
    'ground reach is strictly inside shell reach whenever the hip is raised',
  );
  assertContract(
    raised.innerRadius === 0,
    'once the vertical drop alone exceeds the fold limit the annulus has no '
      + 'hole — every horizontal offset is already far enough out',
  );
  assertContract(
    !resolveLegGroundAnnulus(shell, 10.0001).reachable,
    'ground further from the hip than the leg is long is NOT reachable, and '
      + 'must be reported as such rather than answered with a target',
  );

  // The trigger is a 3D shell test from the hip, both bounds.
  assertContract(
    !legFootNeedsStep(9.99 * 9.99, shell) && !legFootNeedsStep(3.01 * 3.01, shell),
    'a foot inside the shell stays planted',
  );
  assertContract(
    !legFootNeedsStep(100, shell) && !legFootNeedsStep(9, shell),
    'both shell boundaries remain valid planting sites',
  );
  assertContract(
    legFootNeedsStep(10.01 * 10.01, shell),
    'a foot past full extension starts a step',
  );
  assertContract(
    legFootNeedsStep(2.99 * 2.99, shell),
    'a foot folded inside the inner bound starts a step — the half of this '
      + 'test that a ground-projected disc could never see',
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
      && Math.abs(clamped.x - 3) < 1e-9,
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

  // The station is still authored; only the envelope stopped being flat.
  const station = { x: 0, z: 0 };
  resolveLegOutwardGroundPointLocal(3, 4, 5, station);
  assertContract(
    Math.abs(station.x - 6) < 1e-9 && Math.abs(station.z - 8) < 1e-9,
    'the outward station runs along the attachment ray from the attachment',
  );

  const groundRayOrigin = { x: 0, y: 0, z: 0 };
  resolveLegGroundRayOrigin(0, 0, 1, 0, { reachable: true, innerRadius: 4, outerRadius: 8 }, 0.5, groundRayOrigin);
  assertContract(
    Math.abs(groundRayOrigin.x - 6) < 1e-9 && groundRayOrigin.z === 0,
    'the ray origin spans the annulus along the outward ray',
  );
  const velocityTarget = { x: 0, y: 0, z: 0 };
  const annulus = { reachable: true, innerRadius: 4, outerRadius: 8 };
  resolveLegGroundStepTarget(6, 0, 0, 0, annulus, 1, 0, 8, 0, velocityTarget);
  assertContract(
    Math.abs(velocityTarget.x - 8) < 1e-9,
    'an outward velocity ray reaches the annulus outer edge',
  );
  resolveLegGroundStepTarget(6, 0, 0, 0, annulus, -1, 0, 8, 0, velocityTarget);
  assertContract(
    Math.abs(velocityTarget.x - 4) < 1e-9,
    'an inward velocity ray stops at the annulus inner edge',
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
