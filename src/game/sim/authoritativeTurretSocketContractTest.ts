import { getTransformCosSin } from '../math';
import {
  resolveBotWeaponArmSocketPose,
  type BotArmSocketPose,
} from '../math/BotHostSocketGeometry';
import { deterministicMath as DMath } from './deterministicMath';
import {
  resolveWeaponEmissionSocket,
  updateAuthoritativeHostAttachmentKinematics,
} from './combat/combatUtils';
import {
  getCombatTargetingStateViews,
  readCombatTargetingTurretMountInto,
  stampCombatTargetingPool,
} from './combat/targetingInputStamping';
import {
  CT_TURRET_STATE_ENGAGED,
  CT_TURRET_STATE_IDLE,
  getSimWasm,
} from '../sim-wasm/init';
import { entitySlotRegistry } from './EntitySlotRegistry';
import type { PlayerId } from './types';
import { updateTurretRotation } from './combat/turretSystem';
import { getUnitGroundZ } from './unitGeometry';
import { WorldState } from './WorldState';
import { getUnitBlueprint } from './blueprints';

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`[authoritative turret sockets] ${message}`);
}

function assertNear(actual: number, expected: number, message: string, epsilon = 1e-5): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > epsilon) {
    throw new Error(
      `[authoritative turret sockets] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

const _emission = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  forward: { x: 1, y: 0, z: 0 },
};
const _secondEmission = {
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  forward: { x: 1, y: 0, z: 0 },
};
const _armAimPose: BotArmSocketPose = {
  elbowX: 0,
  elbowY: 0,
  elbowZ: 0,
  handX: 0,
  handY: 0,
  handZ: 0,
  aimX: 1,
  aimY: 0,
  aimZ: 0,
};

function resolveLane(
  world: WorldState,
  host: NonNullable<ReturnType<WorldState['getEntity']>>,
  turretIndex: number,
  laneIndex: number,
  out: typeof _emission,
): typeof _emission {
  const turret = host.combat?.turrets[turretIndex];
  if (turret === undefined || host.unit === null) {
    throw new Error('[authoritative turret sockets] fixture turret is missing');
  }
  const { cos, sin } = getTransformCosSin(host.transform);
  return resolveWeaponEmissionSocket(
    host,
    turret,
    turretIndex,
    laneIndex,
    cos,
    sin,
    {
      currentTick: world.getTick(),
      dtMs: 50,
      unitGroundZ: getUnitGroundZ(host),
      surfaceN: host.unit.surfaceNormal,
    },
    out,
  );
}

export function runAuthoritativeTurretSocketContractTest(): void {
  const humanBlueprint = getUnitBlueprint('unitHuman');
  assertContract(humanBlueprint.unitLocomotion.type === 'bot', 'arm solver fixture is a bot');
  const expectedArmYaw = -0.4;
  const expectedArmPitch = 0.7;
  resolveBotWeaponArmSocketPose(
    humanBlueprint.unitLocomotion.config.arms,
    humanBlueprint.radius.other,
    'rightArm',
    humanBlueprint.radius.other *
      humanBlueprint.unitLocomotion.config.arms.shoulder.zUnitRadiusRatio,
    expectedArmPitch,
    expectedArmYaw,
    DMath,
    _armAimPose,
  );
  assertNear(
    DMath.atan2(_armAimPose.aimY, _armAimPose.aimX),
    expectedArmYaw,
    'visible forearm yaw equals its authoritative local station yaw',
  );
  assertNear(
    DMath.atan2(
      _armAimPose.aimZ,
      DMath.hypot(_armAimPose.aimX, _armAimPose.aimY),
    ),
    expectedArmPitch,
    'visible forearm pitch equals its authoritative local station pitch',
  );

  const rigidHostWorld = new WorldState(91230, 1024, 1024);
  const rigidHost = rigidHostWorld.createUnitFromBlueprint(
    140,
    160,
    1 as PlayerId,
    'unitJackal',
  );
  rigidHostWorld.addEntity(rigidHost);
  const rigidTurret = rigidHost.combat?.turrets[0];
  assertContract(rigidTurret !== undefined, 'rigid vehicle fixture exposes its weapon station');
  rigidTurret.localYaw = 0.25;
  rigidTurret.rotation = 0.25;
  rigidTurret.articulationIdleMs = 0;
  rigidHost.transform.rotation = 0.6;
  updateTurretRotation(rigidHostWorld, 50, [rigidHost]);
  assertNear(
    rigidTurret.localYaw,
    0.25,
    'idle station holds local yaw during its restore delay',
  );
  assertNear(
    rigidTurret.rotation,
    0.85,
    'turning a rigid host carries its turret instead of leaving it world-locked',
  );

  const humanWorld = new WorldState(91231, 1024, 1024);
  while (humanWorld.getNextEntityId() < 48000) humanWorld.generateEntityId();
  const human = humanWorld.createUnitFromBlueprint(
    240,
    260,
    1 as PlayerId,
    'unitHuman',
  );
  humanWorld.addEntity(human);
  const humanGun = human.combat?.turrets[0];
  assertContract(humanGun !== undefined, 'Human exposes its arm-mounted gun');
  humanGun.rotation = 0;
  humanGun.pitch = 0;
  updateAuthoritativeHostAttachmentKinematics(
    humanWorld.getArmedEntities(),
    humanWorld.getTick(),
    50,
    'tickStart',
  );
  const firstPivot = { ...humanGun.worldPos };
  const firstEmission = resolveLane(humanWorld, human, 0, 0, _emission);
  assertNear(
    firstEmission.position.x - firstPivot.x,
    9,
    'Human QueryWeapon offset comes from its explicit unit-blueprint socket',
  );
  assertNear(firstEmission.position.y, firstPivot.y, 'zero-y socket stays on barrel axis');
  assertNear(firstEmission.position.z, firstPivot.z, 'zero-z socket stays on barrel axis');

  stampCombatTargetingPool(humanWorld);
  humanGun.state = 'engaged';
  const sim = getSimWasm();
  assertContract(sim !== undefined, 'sim-wasm is initialized for torso FSM fixture');
  const humanSlot = entitySlotRegistry.getEntitySlot(human);
  assertContract(humanSlot >= 0, 'Human fixture owns a targeting slot');
  getCombatTargetingStateViews(sim).state[
    humanSlot * sim.combatTargeting.maxTurretsPerEntity()
  ] = CT_TURRET_STATE_ENGAGED;
  humanGun.aimTargetYaw = 0.2;
  humanGun.rotation = 0.2;
  updateAuthoritativeHostAttachmentKinematics(
    humanWorld.getArmedEntities(),
    humanWorld.getTick(),
    50,
    'hostAim',
  );
  updateAuthoritativeHostAttachmentKinematics(
    humanWorld.getArmedEntities(),
    humanWorld.getTick(),
    50,
    'postAim',
  );
  const slabPivot = { x: 0, y: 0, z: 0 };
  assertContract(
    readCombatTargetingTurretMountInto(
      human,
      0,
      humanWorld.getTick(),
      slabPivot,
    ),
    'post-aim host piece overwrites its already-stamped targeting row',
  );
  assertNear(slabPivot.x, humanGun.worldPos.x, 'targeting slab reads final hand x');
  assertNear(slabPivot.y, humanGun.worldPos.y, 'targeting slab reads final hand y');
  assertNear(slabPivot.z, humanGun.worldPos.z, 'targeting slab reads final hand z');
  assertContract(
    humanGun.hostPieceYaw > 0 && humanGun.hostPieceYaw < humanGun.rotation,
    'authoritative Human waist begins turning toward aim without snapping to it',
  );
  const aimedWaistYaw = humanGun.hostPieceYaw;
  getCombatTargetingStateViews(sim).state[
    humanSlot * sim.combatTargeting.maxTurretsPerEntity()
  ] = CT_TURRET_STATE_IDLE;
  humanGun.state = 'idle';
  updateAuthoritativeHostAttachmentKinematics(
    humanWorld.getArmedEntities(),
    humanWorld.getTick(),
    50,
    'hostAim',
  );
  assertNear(
    humanGun.hostPieceYaw,
    aimedWaistYaw,
    'idle bot upper body holds its pose during the authored restore delay',
  );
  updateAuthoritativeHostAttachmentKinematics(
    humanWorld.getArmedEntities(),
    humanWorld.getTick(),
    1800,
    'hostAim',
  );
  assertContract(
    Math.abs(humanGun.hostPieceYaw) < Math.abs(aimedWaistYaw),
    'bot upper body returns toward lower-body forward after its restore delay',
  );

  humanWorld.incrementTick();
  humanGun.aimTargetYaw = Math.PI * 0.5;
  humanGun.rotation = Math.PI * 0.5;
  humanGun.pitch = 0.55;
  updateAuthoritativeHostAttachmentKinematics(
    humanWorld.getArmedEntities(),
    humanWorld.getTick(),
    50,
    'tickStart',
  );
  const raisedEmission = resolveLane(humanWorld, human, 0, 0, _emission);
  const pivotTravel = DMath.hypot(
    humanGun.worldPos.x - firstPivot.x,
    humanGun.worldPos.y - firstPivot.y,
    humanGun.worldPos.z - firstPivot.z,
  );
  assertContract(
    pivotTravel > human.unit!.radius.other * 0.1,
    'arm AimFrom pivot follows authoritative torso yaw and arm pitch',
  );
  assertNear(
    DMath.hypot(
      raisedEmission.position.x - humanGun.worldPos.x,
      raisedEmission.position.y - humanGun.worldPos.y,
      raisedEmission.position.z - humanGun.worldPos.z,
    ),
    9,
    'muzzle remains rigid to the moving Human AimFrom pivot',
  );
  assertNear(
    raisedEmission.forward.z,
    DMath.sin(humanGun.pitch),
    'QueryWeapon publishes the same authoritative pitch as the turret',
  );

  const rexWorld = new WorldState(91232, 2048, 2048);
  while (rexWorld.getNextEntityId() < 49000) rexWorld.generateEntityId();
  const rex = rexWorld.createUnitFromBlueprint(
    700,
    700,
    1 as PlayerId,
    'unitRex',
  );
  rexWorld.addEntity(rex);
  const rexTurrets = rex.combat?.turrets;
  assertContract(rexTurrets !== undefined, 'Rex exposes runtime turrets');
  const primaryIndex = rexTurrets.findIndex((turret) => turret.mountId === 'beamMega');
  const gatlingIndex = rexTurrets.findIndex((turret) => turret.mountId === 'gatlingRight');
  const rightAntiAirIndex = rexTurrets.findIndex((turret) => turret.mountId === 'antiAirRight');
  const leftAntiAirIndex = rexTurrets.findIndex((turret) => turret.mountId === 'antiAirLeft');
  assertContract(
    primaryIndex >= 0 && gatlingIndex >= 0 &&
      rightAntiAirIndex >= 0 && leftAntiAirIndex >= 0,
    'Rex socket fixtures exist',
  );
  const gatling = rexTurrets[gatlingIndex];
  assertContract(
    gatling.emissionSockets.length === 5,
    'Rex gatling materializes one QueryWeapon socket per logical lane',
  );
  assertContract(
    rexTurrets[rightAntiAirIndex].emissionSockets.length === 3 &&
      rexTurrets[leftAntiAirIndex].emissionSockets.length === 3,
    'both Rex fast-rocket launchers materialize all three QueryWeapon lanes',
  );
  const rightFastRocket = rexTurrets[rightAntiAirIndex];
  rexTurrets[primaryIndex].aimTargetYaw = 0.35;
  rexTurrets[primaryIndex].rotation = 0.35;
  rexTurrets[primaryIndex].state = 'engaged';
  gatling.rotation = 0.8;
  gatling.pitch = 0.2;
  updateAuthoritativeHostAttachmentKinematics(
    rexWorld.getArmedEntities(),
    rexWorld.getTick(),
    50,
    'tickStart',
  );
  updateAuthoritativeHostAttachmentKinematics(
    rexWorld.getArmedEntities(),
    rexWorld.getTick(),
    50,
    'hostAim',
  );
  updateAuthoritativeHostAttachmentKinematics(
    rexWorld.getArmedEntities(),
    rexWorld.getTick(),
    50,
    'postAim',
  );
  const primaryBeam = rexTurrets[primaryIndex];
  const beamOrigin = resolveLane(rexWorld, rex, primaryIndex, 0, _emission);
  assertContract(
    primaryBeam.emissionSockets.length === 1 &&
      primaryBeam.emissionSockets[0].x === 0 &&
      primaryBeam.emissionSockets[0].y === 0 &&
      primaryBeam.emissionSockets[0].z === 0,
    'beam QueryWeapon stays at the broad base of its pilot light',
  );
  assertNear(beamOrigin.position.x, primaryBeam.worldPos.x, 'beam origin shares AimFrom x');
  assertNear(beamOrigin.position.y, primaryBeam.worldPos.y, 'beam origin shares AimFrom y');
  assertNear(beamOrigin.position.z, primaryBeam.worldPos.z, 'beam origin shares AimFrom z');
  const lane0 = resolveLane(rexWorld, rex, gatlingIndex, 0, _emission);
  const lane1 = resolveLane(rexWorld, rex, gatlingIndex, 1, _secondEmission);
  assertContract(
    DMath.hypot(
      lane0.position.x - lane1.position.x,
      lane0.position.y - lane1.position.y,
      lane0.position.z - lane1.position.z,
    ) < 1e-5,
    'all gatling lane identities resolve through one fixed firing socket',
  );
  assertContract(
    gatling.emissionSockets.every((socket) => (
      socket.x === gatling.emissionSockets[0].x && socket.y === 0 && socket.z === 0
    )),
    'gatling QueryWeapon sockets remain centered while the barrel cluster rotates below them',
  );

  const upperHandPivotBefore = { ...rightFastRocket.worldPos };
  rexWorld.incrementTick();
  rexTurrets[primaryIndex].aimTargetYaw = -0.45;
  rexTurrets[primaryIndex].rotation = -0.45;
  updateAuthoritativeHostAttachmentKinematics(
    rexWorld.getArmedEntities(),
    rexWorld.getTick(),
    50,
    'tickStart',
  );
  const torsoYawBeforeTurn = rexTurrets[primaryIndex].hostPieceYaw;
  updateAuthoritativeHostAttachmentKinematics(
    rexWorld.getArmedEntities(),
    rexWorld.getTick(),
    50,
    'hostAim',
  );
  updateAuthoritativeHostAttachmentKinematics(
    rexWorld.getArmedEntities(),
    rexWorld.getTick(),
    50,
    'postAim',
  );
  assertContract(
    DMath.hypot(
      rightFastRocket.worldPos.x - upperHandPivotBefore.x,
      rightFastRocket.worldPos.y - upperHandPivotBefore.y,
      rightFastRocket.worldPos.z - upperHandPivotBefore.z,
    ) > 1e-4,
    'Rex upper-hand fast-rocket AimFrom pivot follows its articulated arm and inertial upper body',
  );
  assertContract(
    Math.abs(rexTurrets[primaryIndex].hostPieceYaw - torsoYawBeforeTurn) <
      Math.abs(rexTurrets[primaryIndex].rotation - torsoYawBeforeTurn),
    'heavy Rex waist advances only partway toward an abrupt turret-yaw change',
  );
  assertContract(
    DMath.hypot(
      rightFastRocket.worldVelocity.x,
      rightFastRocket.worldVelocity.y,
      rightFastRocket.worldVelocity.z,
    ) > 0,
    'moving upper-body sockets publish launch-inheritance velocity',
  );
}
