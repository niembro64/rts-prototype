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
import {
  applyLocomotionState,
  captureLocomotionState,
  getChassisLift,
} from './Locomotion3D';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import {
  buildBotRig,
  poseBotRigAtPreviewCycle,
  poseBotRigAtRest,
  resolveBotArmTurretAim,
  resolveBotArmTurretRoot,
  botFootPitch,
  type BotMesh,
  updateBotRig,
  updateBotHostTurretAim,
} from './BotRig3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[bot host turret aim] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) <= 1e-5) return;
  throw new Error(
    `[bot host turret aim] ${message}: expected ${expected}, got ${actual}`,
  );
}

function buildBot(unitBlueprintId: 'unitHuman' | 'unitCommander' | 'unitRex') {
  const blueprint = getUnitBlueprint(unitBlueprintId);
  assertContract(
    blueprint.unitLocomotion.type === 'bot',
    `${unitBlueprintId} fixture must use bot locomotion`,
  );
  const root = new THREE.Group();
  const mesh = buildBotRig(
    root,
    blueprint.radius.other,
    blueprint.mass,
    blueprint.unitLocomotion.physics.ground.maxPropulsiveForce,
    blueprint.unitLocomotion.config.legs,
    blueprint.unitLocomotion.config.arms,
    getChassisLift(blueprint, blueprint.radius.other),
    undefined,
    'far',
    unitBlueprintId,
  );
  poseBotRigAtRest(mesh);
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

function assertBotHipsCenteredUnderTorso(mesh: BotMesh, label: string): void {
  const shoulderX = mesh.arms[0]?.shoulderX;
  assertContract(shoulderX !== undefined, `${label} has an authored shoulder line`);
  for (const leg of mesh.legs) assertContract(
    Math.abs(leg.hipX - shoulderX) <= mesh.unitRadius * 0.06,
    `${label} hip support line remains centered beneath the upper-body mass`,
  );
}

function botKneeDistanceFromLegLine(mesh: BotMesh, legIndex: number): number {
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

function botKneeForwardOfLegLine(mesh: BotMesh, legIndex: number): number {
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

function assertBotLegLengths(mesh: BotMesh, label: string): void {
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

function assertBotLegExtension(mesh: BotMesh, label: string): void {
  poseBotRigAtRest(mesh);
  assertBotLegLengths(mesh, `${label} resting`);
  for (let i = 0; i < mesh.legs.length; i++) {
    const kneeOffset = botKneeDistanceFromLegLine(mesh, i);
    assertContract(
      kneeOffset > mesh.unitRadius * 0.05 && kneeOffset < mesh.unitRadius * 0.25,
      `${label} resting leg ${i} has a slight, mechanically valid knee bend`,
    );
    assertContract(
      botKneeForwardOfLegLine(mesh, i) > 0,
      `${label} resting leg ${i} bends its knee forward`,
    );
  }

  // At quarter phase the first leg is at peak recovery while its exact
  // half-cycle partner is loaded. Recovery should deepen the existing fold.
  poseBotRigAtPreviewCycle(mesh, 0.25, 1);
  const liftedKneeOffset = botKneeDistanceFromLegLine(mesh, 0);
  const plantedKneeOffset = botKneeDistanceFromLegLine(mesh, 1);
  assertContract(
    liftedKneeOffset > plantedKneeOffset + mesh.unitRadius * 0.05 &&
      liftedKneeOffset < mesh.unitRadius * 0.4,
    `${label} recovery leg folds more than its straight-ish planted partner`,
  );
  assertBotLegLengths(mesh, `${label} walking`);
  assertContract(
    mesh.legs[0].foot.rotation.z < -1e-3,
    `${label} recovery shoe uses a restrained authored ankle pitch`,
  );
  assertNear(
    mesh.legs[1].foot.rotation.z,
    0,
    `${label} planted shoe stays flat through stance`,
  );
  for (const [index, leg] of mesh.legs.entries()) {
    assertNear(leg.foot.rotation.x, 0, `${label} walking foot ${index} has no terrain roll`);
    assertNear(leg.foot.rotation.y, 0, `${label} walking foot ${index} keeps lower-body heading`);
  }
}

function assertLongBotStride(mesh: BotMesh, label: string): void {
  const leg = mesh.legs[0];
  const legLength = leg.thighLength + leg.shinLength;
  poseBotRigAtPreviewCycle(mesh, 0, 1);
  const rearX = leg.footLocalX;
  poseBotRigAtPreviewCycle(mesh, 0.5, 1);
  const frontX = leg.footLocalX;
  const footTravel = Math.abs(frontX - rearX);
  assertContract(
    footTravel > legLength * 0.45 && footTravel < legLength * 0.5,
    `${label} bot gait uses a long stride without exceeding fixed leg reach`,
  );
}

function assertBotStrutBetween(
  strut: BotMesh['legs'][number]['thigh'],
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

function assertBotLimbChains(mesh: BotMesh, label: string): void {
  for (const phase of [0, 0.13, 0.25, 0.5, 0.72, 0.91]) {
    poseBotRigAtPreviewCycle(mesh, phase, 1);
    assertBotLegLengths(mesh, `${label} phase ${phase}`);
    for (const [index, leg] of mesh.legs.entries()) {
      const hip = new THREE.Vector3(leg.hipX, leg.hipY, leg.hipZ);
      assertBotStrutBetween(
        leg.thigh,
        hip,
        leg.knee.position,
        leg.hipJoint.scale.x,
        leg.knee.scale.x,
        `${label} phase ${phase} upper leg ${index}`,
      );
      assertBotStrutBetween(
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
      assertBotStrutBetween(
        arm.upper,
        shoulder,
        arm.elbow.position,
        boxSurfaceDistanceAlong(arm.shoulderJoint, shoulder, arm.elbow.position),
        arm.elbow.scale.x,
        `${label} phase ${phase} ${arm.id} upper arm`,
      );
      assertBotStrutBetween(
        arm.forearm,
        arm.elbow.position,
        hand,
        arm.elbow.scale.x,
        arm.wrist.visible ? arm.wrist.scale.y * 0.5 : 0,
        `${label} phase ${phase} ${arm.id} forearm`,
      );
      assertContract(
        botElbowAngle(arm) >= THREE.MathUtils.degToRad(28),
        `${label} phase ${phase} ${arm.id} retains a BAR-style elbow fold`,
      );
    }
  }
}

function assertBotFeetFollowLegFacing(mesh: BotMesh, label: string): void {
  const host = mesh.group.parent;
  assertContract(host !== null, `${label} bot rig has its lifted host root`);
  mesh.upperBodyYaw = 0.35;
  // Mirror the renderer: the host root receives torso assistance while the
  // hips cancel it. The feet must remain on ordinary unit-forward, proving
  // that turret aim is not another locomotion-facing input.
  host.rotation.y = mesh.upperBodyYaw;
  poseBotRigAtRest(mesh);
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
      `${label} bot foot keeps ordinary unit facing while the torso aims`,
    );
  }
  mesh.upperBodyYaw = 0;
  host.rotation.y = 0;
  poseBotRigAtRest(mesh);
}

function assertBotFootAnimationKeys(): void {
  assertNear(botFootPitch(0), 0, 'bot shoe starts recovery flat');
  assertContract(
    botFootPitch(0.1) < THREE.MathUtils.degToRad(-13),
    'bot shoe rolls toe-down through BAR-style push-off',
  );
  assertNear(
    botFootPitch(0.275),
    0,
    'bot shoe passes through neutral at mid-recovery',
  );
  assertContract(
    botFootPitch(0.41) > THREE.MathUtils.degToRad(9),
    'bot shoe raises its toe before heel strike',
  );
  assertNear(botFootPitch(0.5), 0, 'bot shoe lands flat');
  assertNear(botFootPitch(0.75), 0, 'bot shoe stays flat through stance');
  assertNear(botFootPitch(1), 0, 'bot shoe cycle closes without a snap');
}

function assertBotFeetHaveShoeVolume(mesh: BotMesh, label: string): void {
  for (const [index, leg] of mesh.legs.entries()) {
    assertContract(leg.foot.userData.botShoe === true, `${label} foot ${index} is a shoe rig`);
    let upper: THREE.Mesh | undefined;
    let toe: THREE.Mesh | undefined;
    leg.foot.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (object.userData.botShoeUpper === true) upper = object;
      if (object.userData.botShoeToe === true) toe = object;
    });
    assertContract(upper !== undefined && toe !== undefined, `${label} foot ${index} has an upper and toe box`);
    assertContract(
      upper.scale.y > toe.scale.y,
      `${label} foot ${index} rises into a boot quarter instead of reading as a flat plate`,
    );
  }
}

function botElbowAngle(arm: BotMesh['arms'][number]): number {
  const upper = arm.elbow.position.clone().sub(
    new THREE.Vector3(arm.shoulderX, arm.shoulderY, arm.shoulderZ),
  ).normalize();
  const forearm = new THREE.Vector3(arm.handX, arm.handY, arm.handZ)
    .sub(arm.elbow.position)
    .normalize();
  return upper.angleTo(forearm);
}

function assertJointedOpenBotPose(mesh: BotMesh, label: string): void {
  poseBotRigAtRest(mesh);
  assertContract(
    mesh.stanceForward > 0 && mesh.stanceOutward > 0,
    `${label} authors forward and outward stopped-stance offsets`,
  );
  const pelvisTop = mesh.pelvis.position.y + mesh.pelvis.scale.y * 0.5;
  assertContract(
    mesh.pelvis.userData.botPelvis === true &&
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
      leg.hipJoint.userData.botHipJoint === true &&
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
      botKneeDistanceFromLegLine(mesh, mesh.legs.indexOf(leg)) <
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
      arm.shoulderJoint.userData.botShoulderJoint === true &&
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
      botElbowAngle(arm) >= THREE.MathUtils.degToRad(27.5),
      `${label} ${arm.id} keeps a visible elbow fold instead of hanging fully extended`,
    );
  }
}

function assertStableBotUpperArmRoll(mesh: BotMesh, label: string): void {
  const lateralReference = new THREE.Vector3(0, 0, 1);
  const fallbackReference = new THREE.Vector3(1, 0, 0);
  for (const arm of mesh.arms) {
    let previousDepth: THREE.Vector3 | undefined;
    for (const phase of [0.08, 0.31, 0.58, 0.83]) {
      poseBotRigAtPreviewCycle(mesh, phase, 1);
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

function assertContralateralBotGait(mesh: BotMesh, label: string): void {
  for (const side of [-1, 1] as const) {
    const leg = mesh.legs.find((candidate) => candidate.side === side);
    const arm = mesh.arms.find((candidate) => candidate.side === side);
    assertContract(leg !== undefined && arm !== undefined, `${label} has paired limbs on side ${side}`);

    poseBotRigAtPreviewCycle(mesh, 0, 1);
    const first = {
      legX: leg.footLocalX - leg.hipX,
      handX: arm.handX,
    };
    poseBotRigAtPreviewCycle(mesh, 0.5, 1);
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

function assertPlantedFootMatchesTravelSpeed(mesh: BotMesh, label: string): void {
  const stanceStart = 0.57;
  const phaseDelta = 0.11;
  const plantedLeg = mesh.legs.find((leg) => leg.side < 0);
  assertContract(plantedLeg !== undefined, `${label} has a planted-foot gait sample`);

  poseBotRigAtPreviewCycle(mesh, stanceStart, 1);
  const firstFootX = plantedLeg.footLocalX;
  assertNear(
    plantedLeg.foot.position.y,
    mesh.groundLocalY,
    `${label} calibrated stance sample is planted`,
  );

  poseBotRigAtPreviewCycle(mesh, stanceStart + phaseDelta, 1);
  const localBackwardTravel = firstFootX - plantedLeg.footLocalX;
  const matchingGroundTravel = mesh.gaitCycleDistance * phaseDelta;
  assertNear(
    localBackwardTravel,
    matchingGroundTravel,
    `${label} planted foot moves backward at chassis travel speed`,
  );
  assertNear(
    plantedLeg.foot.position.y,
    mesh.groundLocalY,
    `${label} foot remains planted across its calibrated stance interval`,
  );
}

function movingBotPose(
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

function assertRuntimeTravelClocksPlantedFoot(mesh: BotMesh, label: string): void {
  const startPhase = 0.57;
  const phaseDelta = 0.11;
  const dtMs = 100;
  const groundTravel = mesh.gaitCycleDistance * phaseDelta;
  const velocity = groundTravel / (dtMs / 1000);
  const rootY = 0;
  const entity = { builder: null } as Entity;
  const plantedLeg = mesh.legs.find((leg) => leg.side < 0);
  assertContract(plantedLeg !== undefined, `${label} has a runtime planted-foot sample`);

  mesh.contact.initialized = false;
  mesh.gaitPhase = startPhase;
  mesh.gait = 1;
  updateBotRig(mesh, entity, movingBotPose(0, rootY, velocity), 0);
  const firstFootX = plantedLeg.footLocalX;
  updateBotRig(
    mesh,
    entity,
    movingBotPose(groundTravel, rootY, velocity),
    dtMs,
  );

  assertNear(
    mesh.gaitPhase,
    startPhase + phaseDelta,
    `${label} runtime gait phase advances from measured ground travel`,
  );
  assertNear(
    firstFootX - plantedLeg.footLocalX,
    groundTravel,
    `${label} runtime planted foot cancels measured chassis travel`,
  );
}

function assertCoupledBotLegPhase(mesh: BotMesh, label: string): void {
  assertContract(mesh.legs.length === 2, `${label} bot gait owns exactly two legs`);
  for (const phase of [0, 0.08, 0.17, 0.25, 0.39, 0.5, 0.64, 0.75, 0.91]) {
    poseBotRigAtPreviewCycle(mesh, phase, 1);
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

    poseBotRigAtPreviewCycle(mesh, phase + 0.5, 1);
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

function assertAnyTurretLockSuppressesArmGait(mesh: BotMesh, label: string): void {
  const carryingArm = mesh.arms.find((arm) => arm.role === 'weapon') ?? mesh.arms[0];
  const otherArm = mesh.arms.find((arm) => arm !== carryingArm);
  assertContract(carryingArm !== undefined && otherArm !== undefined, `${label} has both authored arms`);
  mesh.turretLockActive = true;
  carryingArm.turretAimActive = true;
  carryingArm.turretAimPitch = 0.25;

  poseBotRigAtPreviewCycle(mesh, 0, 1);
  const firstCarryingX = carryingArm.handX;
  const firstOtherX = otherArm.handX;
  poseBotRigAtPreviewCycle(mesh, 0.5, 1);
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
    botElbowAngle(arm) >= THREE.MathUtils.degToRad(27.5),
    `${label} ${arm.id} remains elbow-bent while a turret owns the host pose`,
  );
  mesh.turretLockActive = false;
  carryingArm.turretAimActive = false;
  poseBotRigAtRest(mesh);
}

function assertUnlockedTorsoTracksLegs(
  mesh: BotMesh,
  turrets: readonly Turret[],
  label: string,
): void {
  for (const turret of turrets) turret.state = 'idle';
  mesh.upperBodyYaw = 0;
  mesh.upperBodyWorldYaw = null;
  updateBotHostTurretAim(mesh, 0, undefined, turrets, 0);

  const lowerBodyTurn = Math.PI * 0.5;
  const initialRelativeYaw = updateBotHostTurretAim(
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

  const easedRelativeYaw = updateBotHostTurretAim(
    mesh,
    lowerBodyTurn,
    undefined,
    turrets,
    100,
  );
  assertContract(
    easedRelativeYaw > 0 && easedRelativeYaw < initialRelativeYaw,
    `${label} unlocked torso inertially follows the new locomotion-forward heading`,
  );

  mesh.upperBodyYaw = 0;
  mesh.upperBodyWorldYaw = null;
  mesh.upperBodyYawVelocity = 0;
  poseBotRigAtRest(mesh);
}

function assertMassiveBotTorsoTurnsSlower(): void {
  const human = buildBot('unitHuman');
  const rex = buildBot('unitRex');
  const targetYaw = Math.PI * 0.5;

  const turnFor = (fixture: ReturnType<typeof buildBot>): number => {
    for (const turret of fixture.turrets) turret.state = 'idle';
    const primary = fixture.turrets.find((turret) =>
      turret.config.requiredEngagedForFightStop
    );
    assertContract(primary !== undefined, 'bot turn fixture has a primary host turret');
    primary.state = 'engaged';
    primary.rotation = targetYaw;
    fixture.mesh.upperBodyYaw = 0;
    fixture.mesh.upperBodyWorldYaw = 0;
    fixture.mesh.upperBodyYawVelocity = 0;
    updateBotHostTurretAim(
      fixture.mesh,
      0,
      undefined,
      fixture.turrets,
      100,
    );
    return Math.abs(fixture.mesh.upperBodyWorldYaw ?? 0);
  };

  const humanTurn = turnFor(human);
  const rexTurn = turnFor(rex);
  assertContract(
    rex.mesh.upperBodyYawSpringGain < human.mesh.upperBodyYawSpringGain &&
      rexTurn < humanTurn * 0.05,
    'mass/radius/force-derived inertia makes Rex torso acceleration materially slower than Human',
  );
}

function assertTorsoAimSurvivesLodRebuild(
  mesh: BotMesh,
  label: string,
): void {
  mesh.upperBodyYaw = 0.42;
  mesh.upperBodyWorldYaw = 1.17;
  mesh.upperBodyYawVelocity = 0.29;
  mesh.gaitPhase = 0.37;
  mesh.gaitDirection = -1;
  mesh.gait = 0.76;
  mesh.legs[0].foot.rotation.set(0.2, 0.3, 0.4);
  const snapshot = captureLocomotionState(mesh);
  assertContract(snapshot?.type === 'bot', `${label} captures bot locomotion state`);

  mesh.upperBodyYaw = 0;
  mesh.upperBodyWorldYaw = null;
  mesh.upperBodyYawVelocity = 0;
  mesh.gaitPhase = 0;
  mesh.gaitDirection = 1;
  mesh.gait = 0;
  mesh.legs[0].foot.quaternion.identity();
  applyLocomotionState(mesh, snapshot);
  assertNear(mesh.upperBodyYaw, 0.42, `${label} preserves torso aim across LOD rebuild`);
  assertNear(
    mesh.upperBodyWorldYaw ?? NaN,
    1.17,
    `${label} preserves the torso world heading across LOD rebuild`,
  );
  assertNear(
    mesh.upperBodyYawVelocity,
    0.29,
    `${label} preserves torso angular velocity across LOD rebuild`,
  );
  assertNear(mesh.gaitPhase, 0.37, `${label} preserves its coupled gait phase across LOD rebuild`);
  assertNear(
    mesh.gaitDirection,
    -1,
    `${label} preserves gait direction across LOD rebuild`,
  );
  assertNear(mesh.gait, 0.76, `${label} preserves gait amplitude across LOD rebuild`);
  assertContract(
    mesh.legs[0].foot.quaternion.angleTo(new THREE.Quaternion()) < 1e-9,
    `${label} does not retain obsolete per-foot contact orientation across LOD rebuild`,
  );

  mesh.upperBodyYaw = 0;
  mesh.upperBodyWorldYaw = null;
  mesh.upperBodyYawVelocity = 0;
  mesh.gaitDirection = 1;
  poseBotRigAtRest(mesh);
}

function assertCommanderEquipmentSides(mesh: BotMesh): void {
  const rightArm = mesh.arms.find((arm) => arm.id === 'rightArm');
  const leftArm = mesh.arms.find((arm) => arm.id === 'leftArm');
  assertContract(
    rightArm?.role === 'construction' && leftArm?.role === 'weapon',
    'Commander separates right-arm construction from its left-arm beam',
  );
  let constructionToolVisible = false;
  rightArm.attachment.traverse((object) => {
    if (object.userData.botConstructionTool === true) constructionToolVisible = true;
  });
  assertContract(constructionToolVisible, 'Commander right arm carries visible construction-tool geometry');
}

function assertCommanderScale(mesh: BotMesh): void {
  const blueprint = getUnitBlueprint('unitCommander');
  assertContract(
    blueprint.radius.other === 41.6 &&
      blueprint.radius.hitbox === 41.6 &&
      blueprint.radius.collision === 41.6 &&
      blueprint.supportPointOffsetZ === 62.4,
    'Commander body, physical envelope, and support height share the authored 2.08x scale',
  );
  assertNear(mesh.unitRadius, 41.6, 'Commander bot rig consumes its 2.08x body radius');
  assertNear(mesh.legs[0].thigh.width, 17.472, 'Commander leg thickness scales by 2.08x');
  assertNear(mesh.arms[0].upper.width, 18.304, 'Commander arm thickness scales by 2.08x');
}

/** A gun held in a bot host's hand is rigid to that hand: its rendered
 *  direction IS the carrying arm's direction, and the turret contributes no
 *  articulation of its own. The turret's authority is untouched — this only
 *  pins which of the two bodies expresses the aim on screen. */
function assertHeldGunTakesItsArmPose(
  human: ReturnType<typeof buildBot>,
  humanGun: Turret,
): void {
  const armId = 'rightArm';
  const carryingArm = human.mesh.arms.find((arm) => arm.id === armId);
  assertContract(carryingArm !== undefined, 'Human has the arm carrying its gun');

  const heldAim = resolveBotArmTurretAim(human.mesh, armId, { yaw: 0, pitch: 0 });
  assertContract(heldAim !== null, 'an arm-held gun resolves a pose from its arm');
  const heldYaw = new THREE.Group();
  const heldPitch = new THREE.Group();
  heldYaw.add(heldPitch);
  heldYaw.rotation.y = heldAim.yaw;
  heldPitch.rotation.z = heldAim.pitch;
  const heldDirection = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(heldPitch.quaternion)
    .applyQuaternion(heldYaw.quaternion);
  assertNear(heldDirection.x, carryingArm.aimX, 'a held gun points along its forearm (x)');
  assertNear(heldDirection.y, carryingArm.aimY, 'a held gun points along its forearm (y)');
  assertNear(heldDirection.z, carryingArm.aimZ, 'a held gun points along its forearm (z)');

  // The arm is what carries elevation, so a different turret pitch has to
  // reach the gun through the arm rather than around it.
  const restingPitch = heldAim.pitch;
  const restoreTurretPitch = humanGun.pitch;
  humanGun.pitch = restoreTurretPitch + 0.6;
  updateBotHostTurretAim(human.mesh, 0, undefined, human.turrets, 0);
  poseBotRigAtRest(human.mesh);
  const raisedAim = resolveBotArmTurretAim(human.mesh, armId, { yaw: 0, pitch: 0 });
  assertContract(raisedAim !== null, 'the raised arm still resolves a held pose');
  assertContract(
    Math.abs(raisedAim.pitch - restingPitch) > 1e-3,
    'a held gun follows its arm when turret pitch moves that arm',
  );

  humanGun.pitch = restoreTurretPitch;
  updateBotHostTurretAim(human.mesh, 0, undefined, human.turrets, 0);
  poseBotRigAtRest(human.mesh);
}

export function runBotHostTurretAim3DContractTest(): void {
  assertRosterTurretsPublishAim();
  assertBotFootAnimationKeys();
  assertMassiveBotTorsoTurnsSlower();
  const human = buildBot('unitHuman');
  assertBotHipsCenteredUnderTorso(human.mesh, 'Human');
  assertBotLegExtension(human.mesh, 'Human');
  assertLongBotStride(human.mesh, 'Human');
  assertBotFeetFollowLegFacing(human.mesh, 'Human');
  assertBotFeetHaveShoeVolume(human.mesh, 'Human');
  assertJointedOpenBotPose(human.mesh, 'Human');
  assertStableBotUpperArmRoll(human.mesh, 'Human');
  assertBotLimbChains(human.mesh, 'Human');
  assertCoupledBotLegPhase(human.mesh, 'Human');
  assertPlantedFootMatchesTravelSpeed(human.mesh, 'Human');
  assertRuntimeTravelClocksPlantedFoot(human.mesh, 'Human');
  assertContralateralBotGait(human.mesh, 'Human');
  assertAnyTurretLockSuppressesArmGait(human.mesh, 'Human');
  assertUnlockedTorsoTracksLegs(human.mesh, human.turrets, 'Human');
  assertTorsoAimSurvivesLodRebuild(human.mesh, 'Human');
  assertEveryTurretPublishesAim(human.turrets);
  const humanGun = human.turrets[0];
  assertContract(
    humanGun.config.hostAttachment?.kind === 'botArm' &&
      humanGun.config.hostAttachment.arm === 'rightArm',
    'Human gun mount identifies the arm carrying it',
  );
  humanGun.state = 'tracking';
  humanGun.rotation = 0.6;
  humanGun.pitch = 0.3;
  const humanYaw = updateBotHostTurretAim(
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
  const lockedTurnRelativeYaw = updateBotHostTurretAim(
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
  updateBotHostTurretAim(human.mesh, 0, undefined, human.turrets, 0);
  poseBotRigAtRest(human.mesh);
  const humanRightArm = human.mesh.arms.find((arm) => arm.id === 'rightArm');
  assertContract(humanRightArm !== undefined, 'Human has its authored right arm');
  const raisedHandY = humanRightArm.handY;
  humanGun.pitch = -0.3;
  updateBotHostTurretAim(human.mesh, 0, undefined, human.turrets, 0);
  poseBotRigAtRest(human.mesh);
  const loweredHandY = humanRightArm.handY;
  assertContract(
    Math.abs(raisedHandY - loweredHandY) > 0.1,
    'different turret pitches materially move the carrying arm',
  );
  humanGun.pitch = 0.3;
  updateBotHostTurretAim(human.mesh, 0, undefined, human.turrets, 0);
  poseBotRigAtRest(human.mesh);
  assertNear(
    human.mesh.hips.rotation.y,
    -human.mesh.upperBodyYaw,
    'bot hips counter-yaw so turret assistance moves the upper body, not the legs',
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
  // The ordinary turret pose still owns every mount that is not held in a
  // hand — hull mounts on every other host, and a bot head attachment.
  assertNear(
    assistedDirection.x,
    Math.cos(humanGun.rotation) * Math.cos(humanGun.pitch),
    'an unheld turret self-yaws through host upper-body assistance',
  );
  assertNear(
    assistedDirection.y,
    Math.sin(humanGun.pitch),
    'an unheld turret self-pitches through host arm/upper-body assistance',
  );
  assertNear(
    assistedDirection.z,
    Math.sin(humanGun.rotation) * Math.cos(humanGun.pitch),
    'an unheld turret retains its authoritative world heading after the host turns',
  );
  assertHeldGunTakesItsArmPose(human, humanGun);
  const aimedTorsoYaw = human.mesh.upperBodyYaw;
  humanGun.state = 'idle';
  const returningTorsoYaw = updateBotHostTurretAim(
    human.mesh,
    0,
    undefined,
    human.turrets,
    100,
  );
  assertContract(
    Math.abs(returningTorsoYaw) < Math.abs(aimedTorsoYaw),
    'an unlocked bot torso inertially follows locomotion-forward',
  );

  const commander = buildBot('unitCommander');
  assertCommanderScale(commander.mesh);
  assertBotHipsCenteredUnderTorso(commander.mesh, 'Commander');
  assertBotLegExtension(commander.mesh, 'Commander');
  assertLongBotStride(commander.mesh, 'Commander');
  assertBotFeetFollowLegFacing(commander.mesh, 'Commander');
  assertBotFeetHaveShoeVolume(commander.mesh, 'Commander');
  assertJointedOpenBotPose(commander.mesh, 'Commander');
  assertStableBotUpperArmRoll(commander.mesh, 'Commander');
  assertBotLimbChains(commander.mesh, 'Commander');
  assertCoupledBotLegPhase(commander.mesh, 'Commander');
  assertPlantedFootMatchesTravelSpeed(commander.mesh, 'Commander');
  assertRuntimeTravelClocksPlantedFoot(commander.mesh, 'Commander');
  assertContralateralBotGait(commander.mesh, 'Commander');
  assertAnyTurretLockSuppressesArmGait(commander.mesh, 'Commander');
  assertUnlockedTorsoTracksLegs(commander.mesh, commander.turrets, 'Commander');
  assertTorsoAimSurvivesLodRebuild(commander.mesh, 'Commander');
  assertCommanderEquipmentSides(commander.mesh);
  assertEveryTurretPublishesAim(commander.turrets);
  const beam = commander.turrets.find((turret) => turret.mountId === 'beam');
  const dgun = commander.turrets.find((turret) => turret.mountId === 'disruptor');
  assertContract(beam !== undefined && dgun !== undefined, 'Commander mounts beam and D-gun');
  assertContract(
    beam.config.hostAttachment?.kind === 'botArm' &&
      beam.config.hostAttachment.arm === 'leftArm' &&
      dgun.config.hostAttachment?.kind === 'botHead',
    'Commander beam uses its left arm while the D-gun uses the head',
  );
  assertContract(
    resolveBotArmTurretRoot(
      commander.mesh,
      'leftArm',
      beam.mountId,
      beam.presentation.headRadius ?? 0,
    ) !== null,
    'Commander beam resolves from its authored bot-arm attachment',
  );

  beam.state = 'engaged';
  beam.rotation = Math.PI;
  beam.pitch = 0.4;
  dgun.state = 'idle';
  dgun.rotation = 0;
  dgun.pitch = 0;
  updateBotHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(
    Math.abs(commander.mesh.upperBodyYaw),
    Math.PI,
    'Commander torso can follow a locked turret directly backward',
  );
  beam.rotation = 0.75;
  updateBotHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(commander.mesh.upperBodyYaw, -0.75, 'Commander torso follows engaged beam yaw');
  const commanderTurnYaw = 1.2;
  const commanderLockedTurnYaw = updateBotHostTurretAim(
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
  updateBotHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(
    commander.mesh.arms.find((arm) => arm.id === 'leftArm')?.turretAimPitch ?? NaN,
    0.4,
    'Commander left weapon arm follows beam pitch',
  );

  // Initialize the manual-pose memory, then emulate the authoritative D-gun
  // snap. Its changed yaw/pitch must temporarily override the engaged beam.
  dgun.rotation = -0.9;
  dgun.pitch = -0.2;
  updateBotHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
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
    updateBotHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 100);
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
