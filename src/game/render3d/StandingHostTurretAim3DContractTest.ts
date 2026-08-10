import * as THREE from 'three';
import { turretStateToCode } from '../../types/network';
import { getUnitBlueprint } from '../sim/blueprints';
import { BUILDING_BLUEPRINTS } from '../sim/blueprints/buildings';
import { getAllUnitBlueprints } from '../sim/blueprints/units';
import {
  createBuildingRuntimeTurrets,
  createUnitRuntimeTurrets,
} from '../sim/runtimeTurrets';
import type { Entity, Turret } from '../sim/types';
import type {
  ClientRenderTurretHostRows,
  ClientRenderTurretStateViews,
} from './ClientRenderTurretStateSlab';
import { readHostTurretAimSample3D } from './HostTurretAim3D';
import type { LocomotionRenderPose } from './LocomotionRigShared3D';
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import {
  applyLocomotionState,
  captureLocomotionState,
  getChassisLift,
} from './Locomotion3D';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import {
  buildStandingRig,
  poseStandingRigAtPreviewCycle,
  poseStandingRigAtRest,
  resolveStandingArmTurretRoot,
  type StandingMesh,
  updateStandingRig,
  updateStandingHostTurretAim,
} from './StandingRig3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[standing host turret aim] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) <= 1e-5) return;
  throw new Error(
    `[standing host turret aim] ${message}: expected ${expected}, got ${actual}`,
  );
}

function buildStanding(unitBlueprintId: 'unitHuman' | 'unitCommander') {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  assertContract(
    blueprint.unitLocomotion.type === 'standing',
    `${unitBlueprintId} fixture must use standing locomotion`,
  );
  const root = new THREE.Group();
  const mesh = buildStandingRig(
    root,
    blueprint.radius.other,
    blueprint.unitLocomotion.config.legs,
    blueprint.unitLocomotion.config.arms,
    getChassisLift(blueprint, blueprint.radius.other),
    undefined,
    'far',
    unitBlueprintId,
  );
  poseStandingRigAtRest(mesh);
  return {
    mesh,
    turrets: createUnitRuntimeTurrets(unitBlueprintId, blueprint.radius.other),
  };
}

function slabRows(yaw: number, pitch: number): ClientRenderTurretHostRows {
  const views = {
    rotation: new Float32Array([yaw]),
    pitch: new Float32Array([pitch]),
    stateCode: new Uint8Array([turretStateToCode('engaged')]),
  } as unknown as ClientRenderTurretStateViews;
  return { hostSlot: 0, start: 0, count: 1, views };
}

function assertEveryTurretPublishesAim(turrets: readonly Turret[]): void {
  const sample = { turretIndex: -1, yaw: 0, pitch: 0, state: 'idle' as const };
  for (let i = 0; i < turrets.length; i++) {
    turrets[i].rotation = 0.2 + i * 0.3;
    turrets[i].pitch = -0.1 + i * 0.2;
    assertContract(
      readHostTurretAimSample3D(undefined, turrets, i, sample),
      `turret ${i} must expose a host-readable aim sample`,
    );
    assertNear(sample.yaw, turrets[i].rotation, `turret ${i} publishes yaw`);
    assertNear(sample.pitch, turrets[i].pitch, `turret ${i} publishes pitch`);
  }

  if (turrets.length === 0) return;
  const rows = slabRows(0.91, -0.37);
  assertContract(
    readHostTurretAimSample3D(rows, turrets, 0, sample),
    'render-slab turret aim must remain host-readable',
  );
  assertNear(sample.yaw, 0.91, 'host reads the same slab yaw as turret presentation');
  assertNear(sample.pitch, -0.37, 'host reads the same slab pitch as turret presentation');
}

function assertRosterTurretsPublishAim(): void {
  let turretCount = 0;
  for (const blueprint of getAllUnitBlueprints()) {
    const turrets = createUnitRuntimeTurrets(
      blueprint.unitBlueprintId,
      blueprint.radius.other,
    );
    turretCount += turrets.length;
    assertEveryTurretPublishesAim(turrets);
  }
  for (const blueprint of Object.values(BUILDING_BLUEPRINTS)) {
    const turrets = createBuildingRuntimeTurrets(blueprint.buildingBlueprintId);
    turretCount += turrets.length;
    assertEveryTurretPublishesAim(turrets);
  }
  assertContract(turretCount > 0, 'roster fixture must exercise mounted turrets');
}

function assertStandingHipsCenteredUnderTorso(mesh: StandingMesh, label: string): void {
  const shoulderX = mesh.arms[0]?.shoulderX;
  assertContract(shoulderX !== undefined, `${label} has an authored shoulder line`);
  for (const leg of mesh.legs) assertContract(
    Math.abs(leg.hipX - shoulderX) <= mesh.unitRadius * 0.06,
    `${label} hip support line remains centered beneath the upper-body mass`,
  );
}

function standingKneeDistanceFromLegLine(mesh: StandingMesh, legIndex: number): number {
  const leg = mesh.legs[legIndex];
  const footDx = leg.foot.position.x - leg.hipX;
  const footDy = leg.foot.position.y - leg.hipY;
  const footDz = leg.foot.position.z - leg.hipZ;
  const kneeDx = leg.knee.position.x - leg.hipX;
  const kneeDy = leg.knee.position.y - leg.hipY;
  const kneeDz = leg.knee.position.z - leg.hipZ;
  const crossX = footDy * kneeDz - footDz * kneeDy;
  const crossY = footDz * kneeDx - footDx * kneeDz;
  const crossZ = footDx * kneeDy - footDy * kneeDx;
  return Math.hypot(crossX, crossY, crossZ) /
    Math.max(1e-6, Math.hypot(footDx, footDy, footDz));
}

function standingKneeForwardOfLegLine(mesh: StandingMesh, legIndex: number): number {
  const leg = mesh.legs[legIndex];
  const foot = leg.foot.position;
  const lineX = foot.x - leg.hipX;
  const lineY = foot.y - leg.hipY;
  const lineZ = foot.z - leg.hipZ;
  const lineLengthSq = lineX * lineX + lineY * lineY + lineZ * lineZ;
  const kneeX = leg.knee.position.x - leg.hipX;
  const kneeY = leg.knee.position.y - leg.hipY;
  const kneeZ = leg.knee.position.z - leg.hipZ;
  const along = (kneeX * lineX + kneeY * lineY + kneeZ * lineZ) /
    Math.max(1e-6, lineLengthSq);
  return leg.knee.position.x - (leg.hipX + lineX * along);
}

function assertStandingLegLengths(mesh: StandingMesh, label: string): void {
  for (const [index, leg] of mesh.legs.entries()) {
    const hip = new THREE.Vector3(leg.hipX, leg.hipY, leg.hipZ);
    assertNear(
      hip.distanceTo(leg.knee.position),
      leg.thighLength,
      `${label} leg ${index} keeps its fixed hip-to-knee length`,
    );
    assertNear(
      leg.knee.position.distanceTo(leg.foot.position),
      leg.shinLength,
      `${label} leg ${index} keeps its fixed knee-to-foot length`,
    );
  }
}

function assertStandingLegExtension(mesh: StandingMesh, label: string): void {
  poseStandingRigAtRest(mesh);
  assertStandingLegLengths(mesh, `${label} resting`);
  for (let i = 0; i < mesh.legs.length; i++) {
    const kneeOffset = standingKneeDistanceFromLegLine(mesh, i);
    assertContract(
      kneeOffset > mesh.unitRadius * 0.05 && kneeOffset < mesh.unitRadius * 0.25,
      `${label} resting leg ${i} has a slight, mechanically valid knee bend`,
    );
    assertContract(
      standingKneeForwardOfLegLine(mesh, i) > 0,
      `${label} resting leg ${i} bends its knee forward`,
    );
  }

  // At quarter phase the first leg is at peak recovery while its exact
  // half-cycle partner is loaded. Recovery should deepen the existing fold.
  poseStandingRigAtPreviewCycle(mesh, 0.25, 1);
  const liftedKneeOffset = standingKneeDistanceFromLegLine(mesh, 0);
  const plantedKneeOffset = standingKneeDistanceFromLegLine(mesh, 1);
  assertContract(
    liftedKneeOffset > plantedKneeOffset + mesh.unitRadius * 0.05 &&
      liftedKneeOffset < mesh.unitRadius * 0.4,
    `${label} recovery leg folds more than its straight-ish planted partner`,
  );
  assertStandingLegLengths(mesh, `${label} walking`);
  for (const [index, leg] of mesh.legs.entries()) assertNear(
    leg.foot.rotation.z,
    0,
    `${label} walking foot ${index} stays ground-parallel instead of heel/toe pitching`,
  );
}

function assertLongStandingStride(mesh: StandingMesh, label: string): void {
  const leg = mesh.legs[0];
  const legLength = leg.thighLength + leg.shinLength;
  poseStandingRigAtPreviewCycle(mesh, 0, 1);
  const rearX = leg.footLocalX;
  poseStandingRigAtPreviewCycle(mesh, 0.5, 1);
  const frontX = leg.footLocalX;
  const footTravel = Math.abs(frontX - rearX);
  assertContract(
    footTravel > legLength * 0.45 && footTravel < legLength * 0.5,
    `${label} standing gait uses a long stride without exceeding fixed leg reach`,
  );
}

function assertStandingStrutBetween(
  strut: StandingMesh['legs'][number]['thigh'],
  start: THREE.Vector3,
  end: THREE.Vector3,
  startInset: number,
  endInset: number,
  label: string,
): void {
  const direction = end.clone().sub(start);
  const length = direction.length();
  direction.normalize();
  const visibleLength = length - startInset - endInset;
  const midpoint = start.clone().addScaledVector(
    direction,
    startInset + visibleLength * 0.5,
  );
  const strutDirection = new THREE.Vector3(0, 1, 0)
    .applyQuaternion(strut.mesh.quaternion)
    .normalize();
  assertContract(
    strut.mesh.position.distanceTo(midpoint) < 1e-5,
    `${label} is centered between its two joint surfaces`,
  );
  assertNear(strut.mesh.scale.y, visibleLength, `${label} stops exactly at both joint surfaces`);
  assertContract(
    strutDirection.dot(direction) > 1 - 1e-6,
    `${label} points from its parent joint to its child joint`,
  );

  if (strut.armor !== undefined) {
    const armorAlong = strut.armor.position.clone().sub(start).dot(direction) - startInset;
    const armorHalfLength = strut.armor.scale.y * 0.5;
    assertContract(
      armorAlong - armorHalfLength >= -1e-5 &&
        armorAlong + armorHalfLength <= visibleLength + 1e-5,
      `${label} armour remains outside both joint volumes`,
    );
  }
}

function boxSurfaceDistanceAlong(
  box: THREE.Mesh,
  start: THREE.Vector3,
  end: THREE.Vector3,
): number {
  const direction = end.clone().sub(start).normalize();
  let distance = Infinity;
  if (Math.abs(direction.x) > 1e-8) {
    distance = Math.min(distance, box.scale.x * 0.5 / Math.abs(direction.x));
  }
  if (Math.abs(direction.y) > 1e-8) {
    distance = Math.min(distance, box.scale.y * 0.5 / Math.abs(direction.y));
  }
  if (Math.abs(direction.z) > 1e-8) {
    distance = Math.min(distance, box.scale.z * 0.5 / Math.abs(direction.z));
  }
  return distance;
}

function assertStandingLimbChains(mesh: StandingMesh, label: string): void {
  for (const phase of [0, 0.13, 0.25, 0.5, 0.72, 0.91]) {
    poseStandingRigAtPreviewCycle(mesh, phase, 1);
    assertStandingLegLengths(mesh, `${label} phase ${phase}`);
    for (const [index, leg] of mesh.legs.entries()) {
      const hip = new THREE.Vector3(leg.hipX, leg.hipY, leg.hipZ);
      assertStandingStrutBetween(
        leg.thigh,
        hip,
        leg.knee.position,
        leg.hipJoint.scale.x,
        leg.knee.scale.x,
        `${label} phase ${phase} upper leg ${index}`,
      );
      assertStandingStrutBetween(
        leg.shin,
        leg.knee.position,
        leg.foot.position,
        leg.knee.scale.x,
        0,
        `${label} phase ${phase} lower leg ${index}`,
      );
    }
    for (const arm of mesh.arms) {
      const shoulder = new THREE.Vector3(arm.shoulderX, arm.shoulderY, arm.shoulderZ);
      const hand = new THREE.Vector3(arm.handX, arm.handY, arm.handZ);
      assertNear(
        shoulder.distanceTo(arm.elbow.position),
        arm.upperLength,
        `${label} phase ${phase} ${arm.id} keeps its upper-arm length`,
      );
      assertNear(
        arm.elbow.position.distanceTo(hand),
        arm.forearmLength,
        `${label} phase ${phase} ${arm.id} keeps its forearm length`,
      );
      assertStandingStrutBetween(
        arm.upper,
        shoulder,
        arm.elbow.position,
        boxSurfaceDistanceAlong(arm.shoulderJoint, shoulder, arm.elbow.position),
        arm.elbow.scale.x,
        `${label} phase ${phase} ${arm.id} upper arm`,
      );
      assertStandingStrutBetween(
        arm.forearm,
        arm.elbow.position,
        hand,
        arm.elbow.scale.x,
        arm.wrist.visible ? arm.wrist.scale.y * 0.5 : 0,
        `${label} phase ${phase} ${arm.id} forearm`,
      );
      assertContract(
        standingElbowAngle(arm) >= THREE.MathUtils.degToRad(28),
        `${label} phase ${phase} ${arm.id} retains a BAR-style elbow fold`,
      );
    }
  }
}

function assertStandingFeetFollowLegFacing(mesh: StandingMesh, label: string): void {
  const host = mesh.group.parent;
  assertContract(host !== null, `${label} standing rig has its lifted host root`);
  mesh.upperBodyYaw = 0.35;
  // Mirror the renderer: the host root receives torso assistance while the
  // hips cancel it. The feet must remain on ordinary unit-forward, proving
  // that turret aim is not another locomotion-facing input.
  host.rotation.y = mesh.upperBodyYaw;
  poseStandingRigAtRest(mesh);
  host.updateMatrixWorld(true);
  assertNear(
    mesh.hips.rotation.y,
    -mesh.upperBodyYaw,
    `${label} hips only cancel the temporary upper-body yaw`,
  );
  const locomotionForward = new THREE.Vector3(1, 0, 0);
  const pelvisForward = new THREE.Vector3(1, 0, 0).applyQuaternion(
    mesh.pelvis.getWorldQuaternion(new THREE.Quaternion()),
  );
  assertContract(
    locomotionForward.dot(pelvisForward) > 1 - 1e-6,
    `${label} pelvis follows the leg frame instead of turret-assisted upper-body yaw`,
  );
  const upperForward = new THREE.Vector3(1, 0, 0).applyAxisAngle(
    new THREE.Vector3(0, 1, 0),
    mesh.upperBodyYaw,
  );
  const shoulderForward = new THREE.Vector3(1, 0, 0).applyQuaternion(
    mesh.arms[0].shoulderJoint.getWorldQuaternion(new THREE.Quaternion()),
  );
  assertContract(
    upperForward.dot(shoulderForward) > 1 - 1e-6,
    `${label} shoulder and torso remain on the upper-body side above the pelvis`,
  );
  for (const leg of mesh.legs) {
    const footForward = new THREE.Vector3(1, 0, 0).applyQuaternion(
      leg.foot.getWorldQuaternion(new THREE.Quaternion()),
    );
    assertContract(
      locomotionForward.dot(footForward) > 1 - 1e-6 && Math.abs(leg.foot.rotation.y) < 1e-9,
      `${label} standing foot keeps ordinary unit facing while the torso aims`,
    );
  }
  mesh.upperBodyYaw = 0;
  host.rotation.y = 0;
  poseStandingRigAtRest(mesh);
}

function assertStandingFeetHaveShoeVolume(mesh: StandingMesh, label: string): void {
  for (const [index, leg] of mesh.legs.entries()) {
    assertContract(leg.foot.userData.standingShoe === true, `${label} foot ${index} is a shoe rig`);
    let upper: THREE.Mesh | undefined;
    let toe: THREE.Mesh | undefined;
    leg.foot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object.userData.standingShoeUpper === true) upper = object;
      if (object.userData.standingShoeToe === true) toe = object;
    });
    assertContract(upper !== undefined && toe !== undefined, `${label} foot ${index} has an upper and toe box`);
    assertContract(
      upper.scale.y > toe.scale.y,
      `${label} foot ${index} rises into a boot quarter instead of reading as a flat plate`,
    );
  }
}

function standingElbowAngle(arm: StandingMesh['arms'][number]): number {
  const upper = arm.elbow.position.clone().sub(
    new THREE.Vector3(arm.shoulderX, arm.shoulderY, arm.shoulderZ),
  ).normalize();
  const forearm = new THREE.Vector3(arm.handX, arm.handY, arm.handZ)
    .sub(arm.elbow.position)
    .normalize();
  return upper.angleTo(forearm);
}

function assertJointedOpenStandingPose(mesh: StandingMesh, label: string): void {
  poseStandingRigAtRest(mesh);
  assertContract(
    mesh.stanceForward > 0 && mesh.stanceOutward > 0,
    `${label} authors forward and outward stopped-stance offsets`,
  );
  const pelvisTop = mesh.pelvis.position.y + mesh.pelvis.scale.y * 0.5;
  assertContract(
    mesh.pelvis.userData.standingPelvis === true &&
      mesh.pelvis.parent === mesh.hips &&
      mesh.arms.every((arm) => arm.shoulderY > pelvisTop),
    `${label} central pelvis belongs to the leg frame and the upper body begins above it`,
  );
  for (const leg of mesh.legs) {
    assertContract(
      leg.knee.geometry.type === 'CylinderGeometry' &&
        Math.abs(leg.knee.rotation.x - Math.PI * 0.5) < 1e-9,
      `${label} side ${leg.side} knee is a lateral cylindrical hinge`,
    );
    assertContract(
      leg.hipJoint.userData.standingHipJoint === true &&
        leg.hipJoint.geometry.type === 'CylinderGeometry' &&
        Math.abs(leg.hipJoint.rotation.x - Math.PI * 0.5) < 1e-9 &&
        leg.hipJoint.parent === mesh.hips &&
        leg.hipJoint.position.distanceTo(new THREE.Vector3(leg.hipX, leg.hipY, leg.hipZ)) < 1e-6,
      `${label} side ${leg.side} has a lateral cylindrical hip socket on the lower-body frame`,
    );
    assertContract(
      leg.foot.position.x > leg.hipX &&
        (leg.foot.position.z - leg.hipZ) * leg.side > 0,
      `${label} side ${leg.side} stopped leg opens forward and outward from its hip`,
    );
    assertContract(
      standingKneeDistanceFromLegLine(mesh, mesh.legs.indexOf(leg)) <
        mesh.unitRadius * 0.25,
      `${label} opened stopped leg remains straight-ish while preserving both bone lengths`,
    );
  }

  for (const arm of mesh.arms) {
    assertContract(
      arm.elbow.geometry.type === 'CylinderGeometry' &&
        Math.abs(arm.elbow.rotation.x - Math.PI * 0.5) < 1e-9,
      `${label} ${arm.id} elbow is a lateral cylindrical hinge`,
    );
    assertContract(
      arm.shoulderJoint.userData.standingShoulderJoint === true &&
        arm.shoulderJoint.parent === mesh.group &&
        arm.shoulderJoint.position.distanceTo(
          new THREE.Vector3(arm.shoulderX, arm.shoulderY, arm.shoulderZ),
        ) < 1e-6,
      `${label} ${arm.id} has a visible shoulder socket at its attachment`,
    );
    assertContract(
      arm.upper.armor === undefined,
      `${label} ${arm.id} upper arm has no oversized armour sleeve`,
    );
    assertContract(
      (arm.elbow.position.z - arm.shoulderZ) * arm.side > 0 &&
        (arm.handZ - arm.elbow.position.z) * arm.side > 0,
      `${label} ${arm.id} upper and lower arm remain angled away from the body`,
    );
    assertContract(
      standingElbowAngle(arm) >= THREE.MathUtils.degToRad(27.5),
      `${label} ${arm.id} keeps a visible elbow fold instead of hanging fully extended`,
    );
  }
}

function assertStableStandingUpperArmRoll(mesh: StandingMesh, label: string): void {
  const lateralReference = new THREE.Vector3(0, 0, 1);
  const fallbackReference = new THREE.Vector3(1, 0, 0);
  for (const arm of mesh.arms) {
    let previousDepth: THREE.Vector3 | undefined;
    for (const phase of [0.08, 0.31, 0.58, 0.83]) {
      poseStandingRigAtPreviewCycle(mesh, phase, 1);
      const direction = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(arm.upper.mesh.quaternion)
        .normalize();
      const actualDepth = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(arm.upper.mesh.quaternion)
        .normalize();
      const reference = Math.abs(lateralReference.dot(direction)) < 1 - 1e-6
        ? lateralReference
        : fallbackReference;
      const expectedDepth = reference.clone()
        .addScaledVector(direction, -reference.dot(direction))
        .normalize();
      assertContract(
        actualDepth.dot(expectedDepth) > 1 - 1e-6,
        `${label} ${arm.id} upper arm keeps a stable lateral cross-section`,
      );
      if (previousDepth !== undefined) assertContract(
        actualDepth.dot(previousDepth) > 0,
        `${label} ${arm.id} upper arm does not roll-flip during its walk arc`,
      );
      previousDepth = actualDepth;
    }
  }
}

function assertContralateralStandingGait(mesh: StandingMesh, label: string): void {
  for (const side of [-1, 1] as const) {
    const leg = mesh.legs.find((candidate) => candidate.side === side);
    const arm = mesh.arms.find((candidate) => candidate.side === side);
    assertContract(leg !== undefined && arm !== undefined, `${label} has paired limbs on side ${side}`);

    poseStandingRigAtPreviewCycle(mesh, 0, 1);
    const first = {
      legX: leg.footLocalX - leg.hipX,
      handX: arm.handX,
    };
    poseStandingRigAtPreviewCycle(mesh, 0.5, 1);
    const second = {
      legX: leg.footLocalX - leg.hipX,
      handX: arm.handX,
    };
    const forward = first.legX > second.legX ? first : second;
    const backward = first.legX > second.legX ? second : first;
    assertContract(
      forward.legX > 0 && backward.legX < 0,
      `${label} preview samples put side ${side} leg both ahead of and behind its hip`,
    );
    assertContract(
      forward.handX < backward.handX - 0.1,
      `${label} side ${side} arm swings backward when its same-side leg is forward`,
    );
  }
}

function assertPlantedFootMatchesTerrainSpeed(mesh: StandingMesh, label: string): void {
  const stanceStart = 0.57;
  const phaseDelta = 0.11;
  const plantedLeg = mesh.legs.find((leg) => leg.side < 0);
  assertContract(plantedLeg !== undefined, `${label} has a planted-foot gait sample`);

  poseStandingRigAtPreviewCycle(mesh, stanceStart, 1);
  const firstFootX = plantedLeg.footLocalX;
  assertNear(
    plantedLeg.foot.position.y,
    mesh.groundLocalY,
    `${label} calibrated stance sample is planted`,
  );

  poseStandingRigAtPreviewCycle(mesh, stanceStart + phaseDelta, 1);
  const localBackwardTravel = firstFootX - plantedLeg.footLocalX;
  const matchingTerrainTravel = mesh.gaitCycleDistance * phaseDelta;
  assertNear(
    localBackwardTravel,
    matchingTerrainTravel,
    `${label} planted foot moves backward at terrain traversal speed`,
  );
  assertNear(
    plantedLeg.foot.position.y,
    mesh.groundLocalY,
    `${label} foot remains planted across its calibrated stance interval`,
  );
}

function movingStandingPose(
  rootX: number,
  rootY: number,
  velocityX: number,
): LocomotionRenderPose {
  return {
    baseX: rootX,
    baseY: 0,
    baseZ: 0,
    rootX,
    rootY,
    rootZ: 0,
    quaternionX: 0,
    quaternionY: 0,
    quaternionZ: 0,
    quaternionW: 1,
    velocityX,
    velocityY: 0,
    velocityZ: 0,
    yawRate: 0,
    waterFraction: 0,
    maxContinuousDistance: 10_000,
  };
}

function assertRuntimeTravelClocksPlantedFoot(mesh: StandingMesh, label: string): void {
  const startPhase = 0.57;
  const phaseDelta = 0.11;
  const dtMs = 100;
  const terrainTravel = mesh.gaitCycleDistance * phaseDelta;
  const velocity = terrainTravel / (dtMs / 1000);
  const rootY = getLocomotionSurfaceHeight(0, 0, 1, 1, 0) - mesh.groundLocalY;
  const entity = { builder: null } as Entity;
  const plantedLeg = mesh.legs.find((leg) => leg.side < 0);
  assertContract(plantedLeg !== undefined, `${label} has a runtime planted-foot sample`);

  mesh.contact.initialized = false;
  mesh.gaitPhase = startPhase;
  mesh.gait = 1;
  updateStandingRig(mesh, entity, movingStandingPose(0, rootY, velocity), 0, 1, 1);
  const firstFootX = plantedLeg.footLocalX;
  updateStandingRig(
    mesh,
    entity,
    movingStandingPose(terrainTravel, rootY, velocity),
    dtMs,
    1,
    1,
  );

  assertNear(
    mesh.gaitPhase,
    startPhase + phaseDelta,
    `${label} runtime gait phase advances from measured terrain travel`,
  );
  assertNear(
    firstFootX - plantedLeg.footLocalX,
    terrainTravel,
    `${label} runtime planted foot cancels measured chassis travel`,
  );
}

function assertCoupledStandingLegPhase(mesh: StandingMesh, label: string): void {
  assertContract(mesh.legs.length === 2, `${label} standing gait owns exactly two legs`);
  for (const phase of [0, 0.08, 0.17, 0.25, 0.39, 0.5, 0.64, 0.75, 0.91]) {
    poseStandingRigAtPreviewCycle(mesh, phase, 1);
    const firstOffset = mesh.legs[0].footLocalX - mesh.legs[0].hipX;
    const secondOffset = mesh.legs[1].footLocalX - mesh.legs[1].hipX;
    assertNear(
      firstOffset,
      -secondOffset,
      `${label} legs remain exact longitudinal opposites at phase ${phase}`,
    );
    for (const leg of mesh.legs) assertNear(
      leg.footLocalZ,
      leg.hipZ,
      `${label} walking leg closes its stopped lateral stance at phase ${phase}`,
    );

    const firstLift = mesh.legs[0].foot.position.y - mesh.groundLocalY;
    const secondLift = mesh.legs[1].foot.position.y - mesh.groundLocalY;
    assertContract(
      Math.min(firstLift, secondLift) < 1e-5,
      `${label} half-cycle gait never lifts both feet at phase ${phase}`,
    );

    poseStandingRigAtPreviewCycle(mesh, phase + 0.5, 1);
    assertNear(
      mesh.legs[0].footLocalX - mesh.legs[0].hipX,
      -firstOffset,
      `${label} first leg reverses exactly after half a cycle at phase ${phase}`,
    );
    assertNear(
      mesh.legs[1].footLocalX - mesh.legs[1].hipX,
      -secondOffset,
      `${label} second leg reverses exactly after half a cycle at phase ${phase}`,
    );
  }
}

function assertAnyTurretLockSuppressesArmGait(mesh: StandingMesh, label: string): void {
  const carryingArm = mesh.arms.find((arm) => arm.role === 'weapon') ?? mesh.arms[0];
  const otherArm = mesh.arms.find((arm) => arm !== carryingArm);
  assertContract(carryingArm !== undefined && otherArm !== undefined, `${label} has both authored arms`);
  mesh.turretLockActive = true;
  carryingArm.turretAimActive = true;
  carryingArm.turretAimPitch = 0.25;

  poseStandingRigAtPreviewCycle(mesh, 0, 1);
  const firstCarryingX = carryingArm.handX;
  const firstOtherX = otherArm.handX;
  poseStandingRigAtPreviewCycle(mesh, 0.5, 1);
  assertNear(
    carryingArm.handX,
    firstCarryingX,
    `${label} turret lock suppresses gait on its carrying arm`,
  );
  assertNear(
    otherArm.handX,
    firstOtherX,
    `${label} turret lock suppresses gait on the other arm too`,
  );
  for (const arm of mesh.arms) assertContract(
    standingElbowAngle(arm) >= THREE.MathUtils.degToRad(27.5),
    `${label} ${arm.id} remains elbow-bent while a turret owns the host pose`,
  );
  mesh.turretLockActive = false;
  carryingArm.turretAimActive = false;
  poseStandingRigAtRest(mesh);
}

function assertUnlockedTorsoTracksLegs(
  mesh: StandingMesh,
  turrets: readonly Turret[],
  label: string,
): void {
  for (const turret of turrets) turret.state = 'idle';
  mesh.upperBodyYaw = 0;
  mesh.upperBodyWorldYaw = null;
  updateStandingHostTurretAim(mesh, 0, undefined, turrets, 0);

  const lowerBodyTurn = Math.PI * 0.5;
  const initialRelativeYaw = updateStandingHostTurretAim(
    mesh,
    lowerBodyTurn,
    undefined,
    turrets,
    0,
  );
  assertNear(
    initialRelativeYaw,
    lowerBodyTurn,
    `${label} leg turn does not instantly drag the unlocked torso in world space`,
  );

  const easedRelativeYaw = updateStandingHostTurretAim(
    mesh,
    lowerBodyTurn,
    undefined,
    turrets,
    100,
  );
  assertContract(
    easedRelativeYaw > 1.24 && easedRelativeYaw < 1.28,
    `${label} unlocked torso EMA follows the new locomotion-forward heading`,
  );

  mesh.upperBodyYaw = 0;
  mesh.upperBodyWorldYaw = null;
  poseStandingRigAtRest(mesh);
}

function assertTorsoAimSurvivesLodRebuild(
  mesh: StandingMesh,
  label: string,
): void {
  mesh.upperBodyYaw = 0.42;
  mesh.upperBodyWorldYaw = 1.17;
  mesh.gaitPhase = 0.37;
  const snapshot = captureLocomotionState(mesh);
  assertContract(snapshot?.type === 'standing', `${label} captures standing locomotion state`);

  mesh.upperBodyYaw = 0;
  mesh.upperBodyWorldYaw = null;
  mesh.gaitPhase = 0;
  applyLocomotionState(mesh, snapshot);
  assertNear(mesh.upperBodyYaw, 0.42, `${label} preserves torso aim across LOD rebuild`);
  assertNear(
    mesh.upperBodyWorldYaw ?? NaN,
    1.17,
    `${label} preserves the torso world-heading EMA across LOD rebuild`,
  );
  assertNear(mesh.gaitPhase, 0.37, `${label} preserves its coupled gait phase across LOD rebuild`);

  mesh.upperBodyYaw = 0;
  mesh.upperBodyWorldYaw = null;
  poseStandingRigAtRest(mesh);
}

function assertCommanderEquipmentSides(mesh: StandingMesh): void {
  const rightArm = mesh.arms.find((arm) => arm.id === 'rightArm');
  const leftArm = mesh.arms.find((arm) => arm.id === 'leftArm');
  assertContract(
    rightArm?.role === 'construction' && leftArm?.role === 'weapon',
    'Commander separates right-arm construction from its left-arm beam',
  );
  let constructionToolVisible = false;
  rightArm.attachment.traverse((object) => {
    if (object.userData.standingConstructionTool === true) constructionToolVisible = true;
  });
  assertContract(constructionToolVisible, 'Commander right arm carries visible construction-tool geometry');
}

function assertCommanderScale(mesh: StandingMesh): void {
  const blueprint = getUnitBlueprint('unitCommander');
  assertContract(
    blueprint.radius.other === 32 &&
      blueprint.radius.hitbox === 32 &&
      blueprint.radius.collision === 32 &&
      blueprint.supportPointOffsetZ === 48,
    'Commander body, physical envelope, and support height share the authored 1.6x scale',
  );
  assertNear(mesh.unitRadius, 32, 'Commander standing rig consumes its 1.6x body radius');
  assertNear(mesh.legs[0].thigh.width, 13.44, 'Commander leg thickness scales by 1.6x');
  assertNear(mesh.arms[0].upper.width, 14.08, 'Commander arm thickness scales by 1.6x');
}

export function runStandingHostTurretAim3DContractTest(): void {
  assertRosterTurretsPublishAim();
  const human = buildStanding('unitHuman');
  assertStandingHipsCenteredUnderTorso(human.mesh, 'Human');
  assertStandingLegExtension(human.mesh, 'Human');
  assertLongStandingStride(human.mesh, 'Human');
  assertStandingFeetFollowLegFacing(human.mesh, 'Human');
  assertStandingFeetHaveShoeVolume(human.mesh, 'Human');
  assertJointedOpenStandingPose(human.mesh, 'Human');
  assertStableStandingUpperArmRoll(human.mesh, 'Human');
  assertStandingLimbChains(human.mesh, 'Human');
  assertCoupledStandingLegPhase(human.mesh, 'Human');
  assertPlantedFootMatchesTerrainSpeed(human.mesh, 'Human');
  assertRuntimeTravelClocksPlantedFoot(human.mesh, 'Human');
  assertContralateralStandingGait(human.mesh, 'Human');
  assertAnyTurretLockSuppressesArmGait(human.mesh, 'Human');
  assertUnlockedTorsoTracksLegs(human.mesh, human.turrets, 'Human');
  assertTorsoAimSurvivesLodRebuild(human.mesh, 'Human');
  assertEveryTurretPublishesAim(human.turrets);
  const humanGun = human.turrets[0];
  assertContract(
    humanGun.config.hostAttachment?.kind === 'standingArm' &&
      humanGun.config.hostAttachment.arm === 'rightArm',
    'Human gun mount identifies the arm carrying it',
  );
  humanGun.state = 'tracking';
  humanGun.rotation = 0.6;
  humanGun.pitch = 0.3;
  const humanYaw = updateStandingHostTurretAim(
    human.mesh,
    0,
    undefined,
    human.turrets,
    0,
  );
  assertNear(humanYaw, -0.6, 'Human upper body echoes its gun yaw');
  assertContract(
    human.mesh.arms.find((arm) => arm.id === 'rightArm')?.turretAimActive === true,
    'Human gun pitch activates its authored right arm',
  );
  assertNear(
    human.mesh.arms.find((arm) => arm.id === 'rightArm')?.turretAimPitch ?? NaN,
    0.3,
    'Human right arm receives the gun pitch',
  );
  const turnedHostYaw = 1.1;
  const lockedTurnRelativeYaw = updateStandingHostTurretAim(
    human.mesh,
    turnedHostYaw,
    undefined,
    human.turrets,
    100,
  );
  assertNear(
    turnedHostYaw - lockedTurnRelativeYaw,
    humanGun.rotation,
    'a leg-frame turn cannot shake a turret-locked torso off its world heading',
  );
  updateStandingHostTurretAim(human.mesh, 0, undefined, human.turrets, 0);
  poseStandingRigAtRest(human.mesh);
  const humanRightArm = human.mesh.arms.find((arm) => arm.id === 'rightArm');
  assertContract(humanRightArm !== undefined, 'Human has its authored right arm');
  const raisedHandY = humanRightArm.handY;
  humanGun.pitch = -0.3;
  updateStandingHostTurretAim(human.mesh, 0, undefined, human.turrets, 0);
  poseStandingRigAtRest(human.mesh);
  const loweredHandY = humanRightArm.handY;
  assertContract(
    Math.abs(raisedHandY - loweredHandY) > 0.1,
    'different turret pitches materially move the carrying arm',
  );
  humanGun.pitch = 0.3;
  updateStandingHostTurretAim(human.mesh, 0, undefined, human.turrets, 0);
  poseStandingRigAtRest(human.mesh);
  assertNear(
    human.mesh.hips.rotation.y,
    -human.mesh.upperBodyYaw,
    'standing hips counter-yaw so turret assistance moves the upper body, not the legs',
  );
  assertNear(humanGun.rotation, 0.6, 'host assistance does not rewrite Human turret yaw');
  assertNear(humanGun.pitch, 0.3, 'host assistance does not rewrite Human turret pitch');
  const assistedParent = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    humanYaw,
  );
  const turretRoot = new THREE.Group();
  const turretYaw = new THREE.Group();
  const turretPitch = new THREE.Group();
  turretRoot.add(turretYaw);
  turretYaw.add(turretPitch);
  applyTurretAimPose3D(
    { yawGroup: turretYaw, pitchGroup: turretPitch },
    0,
    humanGun.rotation,
    humanGun.pitch,
    assistedParent,
  );
  const assistedDirection = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(turretPitch.quaternion)
    .applyQuaternion(turretYaw.quaternion)
    .applyQuaternion(assistedParent);
  assertNear(
    assistedDirection.x,
    Math.cos(humanGun.rotation) * Math.cos(humanGun.pitch),
    'turret self-yaw survives host upper-body assistance',
  );
  assertNear(
    assistedDirection.y,
    Math.sin(humanGun.pitch),
    'turret self-pitch survives host arm/upper-body assistance',
  );
  assertNear(
    assistedDirection.z,
    Math.sin(humanGun.rotation) * Math.cos(humanGun.pitch),
    'turret retains its authoritative world heading after the host turns',
  );
  const aimedTorsoYaw = human.mesh.upperBodyYaw;
  humanGun.state = 'idle';
  const returningTorsoYaw = updateStandingHostTurretAim(
    human.mesh,
    0,
    undefined,
    human.turrets,
    100,
  );
  assertContract(
    Math.abs(returningTorsoYaw) < Math.abs(aimedTorsoYaw) &&
      Math.abs(returningTorsoYaw) > Math.abs(aimedTorsoYaw) * 0.78 &&
      Math.abs(returningTorsoYaw) < Math.abs(aimedTorsoYaw) * 0.82,
    'an unlocked standing torso quickly follows locomotion-forward',
  );

  const commander = buildStanding('unitCommander');
  assertCommanderScale(commander.mesh);
  assertStandingHipsCenteredUnderTorso(commander.mesh, 'Commander');
  assertStandingLegExtension(commander.mesh, 'Commander');
  assertLongStandingStride(commander.mesh, 'Commander');
  assertStandingFeetFollowLegFacing(commander.mesh, 'Commander');
  assertStandingFeetHaveShoeVolume(commander.mesh, 'Commander');
  assertJointedOpenStandingPose(commander.mesh, 'Commander');
  assertStableStandingUpperArmRoll(commander.mesh, 'Commander');
  assertStandingLimbChains(commander.mesh, 'Commander');
  assertCoupledStandingLegPhase(commander.mesh, 'Commander');
  assertPlantedFootMatchesTerrainSpeed(commander.mesh, 'Commander');
  assertRuntimeTravelClocksPlantedFoot(commander.mesh, 'Commander');
  assertContralateralStandingGait(commander.mesh, 'Commander');
  assertAnyTurretLockSuppressesArmGait(commander.mesh, 'Commander');
  assertUnlockedTorsoTracksLegs(commander.mesh, commander.turrets, 'Commander');
  assertTorsoAimSurvivesLodRebuild(commander.mesh, 'Commander');
  assertCommanderEquipmentSides(commander.mesh);
  assertEveryTurretPublishesAim(commander.turrets);
  const beam = commander.turrets.find((turret) => turret.mountId === 'beam');
  const dgun = commander.turrets.find((turret) => turret.mountId === 'disruptor');
  assertContract(beam !== undefined && dgun !== undefined, 'Commander mounts beam and D-gun');
  assertContract(
    beam.config.hostAttachment?.kind === 'standingArm' &&
      beam.config.hostAttachment.arm === 'leftArm' &&
      dgun.config.hostAttachment?.kind === 'standingHead',
    'Commander beam uses its left arm while the D-gun uses the head',
  );
  assertContract(
    resolveStandingArmTurretRoot(
      commander.mesh,
      'leftArm',
      beam.mountId,
      beam.presentation.headRadius ?? 0,
    ) !== null,
    'Commander beam resolves from its authored standing-arm attachment',
  );

  beam.state = 'engaged';
  beam.rotation = Math.PI;
  beam.pitch = 0.4;
  dgun.state = 'idle';
  dgun.rotation = 0;
  dgun.pitch = 0;
  updateStandingHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(
    Math.abs(commander.mesh.upperBodyYaw),
    Math.PI,
    'Commander torso can follow a locked turret directly backward',
  );
  beam.rotation = 0.75;
  updateStandingHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(commander.mesh.upperBodyYaw, -0.75, 'Commander torso follows engaged beam yaw');
  const commanderTurnYaw = 1.2;
  const commanderLockedTurnYaw = updateStandingHostTurretAim(
    commander.mesh,
    commanderTurnYaw,
    undefined,
    commander.turrets,
    100,
  );
  assertNear(
    commanderTurnYaw - commanderLockedTurnYaw,
    beam.rotation,
    'Commander leg-frame turns cannot shake its beam-locked torso world heading',
  );
  updateStandingHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(
    commander.mesh.arms.find((arm) => arm.id === 'leftArm')?.turretAimPitch ?? NaN,
    0.4,
    'Commander left weapon arm follows beam pitch',
  );

  // Initialize the manual-pose memory, then emulate the authoritative D-gun
  // snap. Its changed yaw/pitch must temporarily override the engaged beam.
  dgun.rotation = -0.9;
  dgun.pitch = -0.2;
  updateStandingHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(commander.mesh.upperBodyYaw, 0.9, 'changed manual D-gun yaw overrides beam assistance');
  assertContract(
    commander.mesh.turretLockActive &&
      commander.mesh.arms.every((arm) => !arm.turretAimActive),
    'head-mounted D-gun owns torso yaw and suppresses gait without pitching either arm',
  );
  assertNear(beam.rotation, 0.75, 'D-gun host priority does not rewrite beam yaw');
  assertNear(dgun.rotation, -0.9, 'host assistance does not rewrite D-gun yaw');

  // Releasing every real lock must also release the host, even while client
  // interpolation is still delivering small changes from the one D-gun snap.
  // Those changes are presentation of the same event, not new manual shots.
  beam.state = 'idle';
  const dgunInterpolationStep = 0.01;
  for (let i = 0; i < 5; i++) {
    dgun.rotation -= dgunInterpolationStep;
    updateStandingHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 100);
  }
  const commanderWeaponArm = commander.mesh.arms.find((arm) => arm.id === 'leftArm');
  assertContract(
    !commander.mesh.turretLockActive &&
      commander.mesh.arms.every((arm) => !arm.turretAimActive),
    'one interpolated D-gun snap cannot perpetually renew Commander host ownership',
  );
  assertNear(
    commanderWeaponArm?.turretAimPitch ?? NaN,
    0,
    'Commander clears the released weapon-arm pitch proposal',
  );
  assertContract(
    Math.abs(commander.mesh.upperBodyYaw) < 0.9,
    'Commander torso starts returning to locomotion-forward after all turret ownership releases',
  );
}
