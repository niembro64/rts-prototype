import * as THREE from 'three';
import { turretStateToCode } from '../../types/network';
import { getUnitBlueprint } from '../sim/blueprints';
import { BUILDING_BLUEPRINTS } from '../sim/blueprints/buildings';
import { getAllUnitBlueprints } from '../sim/blueprints/units';
import {
  createBuildingRuntimeTurrets,
  createUnitRuntimeTurrets,
} from '../sim/runtimeTurrets';
import type { Turret } from '../sim/types';
import type {
  ClientRenderTurretHostRows,
  ClientRenderTurretStateViews,
} from './ClientRenderTurretStateSlab';
import { readHostTurretAimSample3D } from './HostTurretAim3D';
import { getChassisLift } from './Locomotion3D';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import {
  buildStandingRig,
  poseStandingRigAtPreviewCycle,
  poseStandingRigAtRest,
  resolveStandingArmTurretRoot,
  type StandingMesh,
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

function assertStandingFeetFollowLegFacing(mesh: StandingMesh, label: string): void {
  mesh.upperBodyYaw = 0.35;
  mesh.hipYaw = -0.6;
  poseStandingRigAtRest(mesh);
  mesh.group.updateMatrixWorld(true);
  const hipForward = new THREE.Vector3(1, 0, 0).applyQuaternion(
    mesh.hips.getWorldQuaternion(new THREE.Quaternion()),
  );
  for (const leg of mesh.legs) {
    const footForward = new THREE.Vector3(1, 0, 0).applyQuaternion(
      leg.foot.getWorldQuaternion(new THREE.Quaternion()),
    );
    assertContract(
      hipForward.dot(footForward) > 1 - 1e-6 && Math.abs(leg.foot.rotation.y) < 1e-9,
      `${label} standing foot faces with its leg plane instead of preserving world yaw`,
    );
  }
  mesh.upperBodyYaw = 0;
  mesh.hipYaw = 0;
  poseStandingRigAtRest(mesh);
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

    poseStandingRigAtPreviewCycle(mesh, 0.25, 1);
    const first = {
      legX: leg.footLocalX - leg.hipX,
      handX: arm.handX,
    };
    poseStandingRigAtPreviewCycle(mesh, 0.75, 1);
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

function assertTurretLockOwnsOnlyItsArm(mesh: StandingMesh, label: string): void {
  const weaponArm = mesh.arms.find((arm) => arm.id === 'rightArm');
  const freeArm = mesh.arms.find((arm) => arm.id === 'leftArm');
  assertContract(weaponArm !== undefined && freeArm !== undefined, `${label} has both authored arms`);
  weaponArm.turretAimActive = true;
  weaponArm.turretAimPitch = 0.25;

  poseStandingRigAtPreviewCycle(mesh, 0.25, 1);
  const lockedWeaponX = weaponArm.handX;
  const firstFreeX = freeArm.handX;
  poseStandingRigAtPreviewCycle(mesh, 0.75, 1);
  assertNear(
    weaponArm.handX,
    lockedWeaponX,
    `${label} turret lock suppresses gait on the carrying arm`,
  );
  assertContract(
    Math.abs(freeArm.handX - firstFreeX) > 0.1,
    `${label} turret lock leaves the other arm available for gait`,
  );
}

export function runStandingHostTurretAim3DContractTest(): void {
  assertRosterTurretsPublishAim();
  const human = buildStanding('unitHuman');
  assertStandingFeetFollowLegFacing(human.mesh, 'Human');
  assertStableStandingUpperArmRoll(human.mesh, 'Human');
  assertContralateralStandingGait(human.mesh, 'Human');
  assertTurretLockOwnsOnlyItsArm(human.mesh, 'Human');
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
    human.mesh.hipYaw - human.mesh.upperBodyYaw,
    'standing hips counter-yaw so turret assistance moves the upper body, not the legs',
  );
  assertNear(humanGun.rotation, 0.6, 'host assistance does not rewrite Human turret yaw');
  assertNear(humanGun.pitch, 0.3, 'host assistance does not rewrite Human turret pitch');
  const assistedParent = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    humanYaw,
  );
  const turretRoot = new THREE.Group();
  const turretPitch = new THREE.Group();
  turretRoot.add(turretPitch);
  applyTurretAimPose3D(
    { root: turretRoot, pitchGroup: turretPitch },
    0,
    humanGun.rotation,
    humanGun.pitch,
    assistedParent,
  );
  const assistedDirection = new THREE.Vector3(1, 0, 0)
    .applyQuaternion(turretPitch.quaternion)
    .applyQuaternion(turretRoot.quaternion)
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

  const commander = buildStanding('unitCommander');
  assertStandingFeetFollowLegFacing(commander.mesh, 'Commander');
  assertStableStandingUpperArmRoll(commander.mesh, 'Commander');
  assertContralateralStandingGait(commander.mesh, 'Commander');
  assertTurretLockOwnsOnlyItsArm(commander.mesh, 'Commander');
  assertEveryTurretPublishesAim(commander.turrets);
  const beam = commander.turrets.find((turret) => turret.mountId === 'beam');
  const dgun = commander.turrets.find((turret) => turret.mountId === 'disruptor');
  assertContract(beam !== undefined && dgun !== undefined, 'Commander mounts beam and D-gun');
  assertContract(
    beam.config.hostAttachment?.arm === 'rightArm' &&
      dgun.config.hostAttachment?.arm === 'rightArm',
    'Commander beam and D-gun identify their shared weapon arm',
  );
  assertContract(
    resolveStandingArmTurretRoot(
      commander.mesh,
      'rightArm',
      beam.mountId,
      beam.config.radius.other,
    ) !== null,
    'Commander beam resolves from its authored standing-arm attachment',
  );

  beam.state = 'engaged';
  beam.rotation = 0.75;
  beam.pitch = 0.4;
  dgun.state = 'idle';
  dgun.rotation = 0;
  dgun.pitch = 0;
  updateStandingHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(commander.mesh.upperBodyYaw, -0.75, 'Commander torso follows engaged beam yaw');
  assertNear(
    commander.mesh.arms.find((arm) => arm.id === 'rightArm')?.turretAimPitch ?? NaN,
    0.4,
    'Commander weapon arm follows beam pitch',
  );

  // Initialize the manual-pose memory, then emulate the authoritative D-gun
  // snap. Its changed yaw/pitch must temporarily override the engaged beam.
  dgun.rotation = -0.9;
  dgun.pitch = -0.2;
  updateStandingHostTurretAim(commander.mesh, 0, undefined, commander.turrets, 0);
  assertNear(commander.mesh.upperBodyYaw, 0.9, 'changed manual D-gun yaw overrides beam assistance');
  assertNear(
    commander.mesh.arms.find((arm) => arm.id === 'rightArm')?.turretAimPitch ?? NaN,
    -0.2,
    'changed manual D-gun pitch overrides beam arm assistance',
  );
  assertNear(beam.rotation, 0.75, 'D-gun host priority does not rewrite beam yaw');
  assertNear(dgun.rotation, -0.9, 'host assistance does not rewrite D-gun yaw');
}
