// Command execution - extracted from Simulation.ts
// Handles all player command types (select, move, build, queue, rally, dgun, repair)

import type {
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
  CancelQueueItemCommand,
  ClearQueuedOrdersCommand,
  Command,
  FireDGunCommand,
  GuardCommand,
  MoveCommand,
  PingCommand,
  ScanCommand,
  QueueUnitCommand,
  ReclaimCommand,
  RepairAreaCommand,
  RepairCommand,
  RemoveLastQueuedOrderCommand,
  SelectCommand,
  SetFactoryWaypointsCommand,
  SetFireEnabledCommand,
  SetJumpEnabledCommand,
  SetRallyPointCommand,
  StartBuildCommand,
  StopCommand,
  WaitCommand,
} from './commands';
import type { Entity, PlayerId, Unit, UnitAction } from './types';
import { isProjectileShot } from './types';
import type { WorldState } from './WorldState';
import type { SimEvent } from './combat';
import { magnitude, getTransformCosSin } from '../math';
import { getProjectileLaunchSpeed, updateWeaponWorldKinematics } from './combat/combatUtils';
import { economyManager } from './economy';
import { factoryProductionSystem } from './factoryProduction';
import { expandPathActions, type PathTerrainFilter } from './Pathfinder';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_COMBAT_MODE, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_JUMP, ENTITY_CHANGED_TURRETS } from '../../types/network';
import { getEntityTargetPoint } from './buildingAnchors';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import { getUnitBlueprint } from './blueprints';
import { DGUN_TERRAIN_FOLLOW_HEIGHT } from '../../config';
import { setUnitJumpEnabled } from './unitJump';
import { pushUnitAction, setUnitActions, shiftUnitAction, spliceUnitActions, unshiftUnitAction } from './unitActions';
import { clearCombatActivityFlags } from './combat/combatActivity';
import { setWeaponTarget } from './combat/targetIndex';
import { isAliveGuardTarget } from './guard';
import { isReclaimableTarget } from './reclaim';
import {
  getActionIntentStart,
  getFirstActionIntentEnd,
  getLastActionIntentFinalIndex,
  getUnitActionTargetId,
} from './unitActionIntents';

const _dgunMount = { x: 0, y: 0, z: 0 };
const _dgunMountVelocity = { x: 0, y: 0, z: 0 };
const REPAIR_AREA_MAX_RADIUS = 500;
const ATTACK_AREA_MAX_RADIUS = 700;

function pathTerrainFilterForUnit(unit: Entity): PathTerrainFilter | undefined {
  const minSurfaceNormalZ = unit.unit?.locomotion.minSurfaceNormalZ;
  return minSurfaceNormalZ !== undefined ? { minSurfaceNormalZ } : undefined;
}

function refreshPatrolStartIndex(unit: Unit): void {
  const index = unit.actions.findIndex((action) => action.type === 'patrol');
  unit.patrolStartIndex = index >= 0 ? index : null;
}

function getCommanderDGunTurretId(commander: Entity): string | null {
  const unitType = commander.unit?.unitType;
  if (!unitType) return null;
  try {
    return getUnitBlueprint(unitType).dgun?.turretId ?? null;
  } catch {
    return null;
  }
}

export type { CommandContext } from '@/types/ui';
import type { CommandContext } from '@/types/ui';

export function executeCommand(ctx: CommandContext, command: Command): void {
  switch (command.type) {
    case 'select':
      executeSelectCommand(ctx, command);
      break;
    case 'move':
      executeMoveCommand(ctx, command);
      break;
    case 'stop':
      executeStopCommand(ctx, command);
      break;
    case 'clearQueuedOrders':
      executeClearQueuedOrdersCommand(ctx, command);
      break;
    case 'removeLastQueuedOrder':
      executeRemoveLastQueuedOrderCommand(ctx, command);
      break;
    case 'wait':
      executeWaitCommand(ctx, command);
      break;
    case 'clearSelection':
      ctx.world.clearSelection();
      break;
    case 'ping':
      executePingCommand(ctx, command);
      break;
    case 'scan':
      executeScanCommand(ctx, command);
      break;
    case 'startBuild':
      executeStartBuildCommand(ctx, command);
      break;
    case 'queueUnit':
      executeQueueUnitCommand(ctx, command);
      break;
    case 'cancelQueueItem':
      executeCancelQueueItemCommand(ctx, command);
      break;
    case 'setRallyPoint':
      executeSetRallyPointCommand(ctx, command);
      break;
    case 'setFactoryWaypoints':
      executeSetFactoryWaypointsCommand(ctx, command);
      break;
    case 'fireDGun':
      executeFireDGunCommand(ctx, command);
      break;
    case 'setJumpEnabled':
      executeSetJumpEnabledCommand(ctx, command);
      break;
    case 'setFireEnabled':
      executeSetFireEnabledCommand(ctx, command);
      break;
    case 'repair':
      executeRepairCommand(ctx, command);
      break;
    case 'repairArea':
      executeRepairAreaCommand(ctx, command);
      break;
    case 'reclaim':
      executeReclaimCommand(ctx, command);
      break;
    case 'attack':
      executeAttackCommand(ctx, command);
      break;
    case 'attackGround':
      executeAttackGroundCommand(ctx, command);
      break;
    case 'attackArea':
      executeAttackAreaCommand(ctx, command);
      break;
    case 'guard':
      executeGuardCommand(ctx, command);
      break;
  }
}

function executeSelectCommand(ctx: CommandContext, command: SelectCommand): void {
  if (!command.additive) {
    ctx.world.clearSelection();
  }
  ctx.world.selectEntities(command.entityIds);
}

function executePingCommand(ctx: CommandContext, command: PingCommand): void {
  const x = Math.max(0, Math.min(command.targetX, ctx.world.mapWidth));
  const y = Math.max(0, Math.min(command.targetY, ctx.world.mapHeight));
  const z = command.targetZ ?? ctx.world.getGroundZ(x, y);
  const event: SimEvent = {
    type: 'ping',
    turretId: '',
    sourceType: 'system',
    sourceKey: 'ping',
    playerId: command.playerId,
    pos: { x, y, z },
  };
  ctx.onSimEvent?.(event);
  ctx.pendingSimEvents.push(event);
}

/** Scan duration in ticks. With the 60 Hz tick rate this is a
 *  ~6-second sweep — long enough to see who's there, short enough
 *  that the player needs to commit a real probe (a scout, a radar)
 *  for sustained coverage. */
const SCAN_PULSE_DURATION_TICKS = 360;
/** Reveal radius for a scanner sweep. Tuned slightly larger than a
 *  unit's vision so the sweep meaningfully exposes a chunk of the
 *  map rather than spotting a single tank. */
const SCAN_PULSE_RADIUS = 1400;

function executeScanCommand(ctx: CommandContext, command: ScanCommand): void {
  if (command.playerId === undefined) return;
  const x = Math.max(0, Math.min(command.targetX, ctx.world.mapWidth));
  const y = Math.max(0, Math.min(command.targetY, ctx.world.mapHeight));
  const z = ctx.world.getGroundZ(x, y);
  ctx.world.addScanPulse({
    playerId: command.playerId,
    x,
    y,
    z,
    radius: SCAN_PULSE_RADIUS,
    expiresAtTick: ctx.world.getTick() + SCAN_PULSE_DURATION_TICKS,
  });
  // Pulse the marker visual through the existing ping channel so the
  // player sees where their sweep landed without a separate renderer.
  // The ping author is the scanning player, so isAuthoredByRecipient
  // already team-shares the marker (kept in mind for FOW-06 allies).
  const event: SimEvent = {
    type: 'ping',
    turretId: '',
    sourceType: 'system',
    sourceKey: 'scan',
    playerId: command.playerId,
    pos: { x, y, z },
  };
  ctx.onSimEvent?.(event);
  ctx.pendingSimEvents.push(event);
}

function executeMoveCommand(ctx: CommandContext, command: MoveCommand): void {
  // Collect valid units without .map/.filter allocation
  const entityIds = command.entityIds;
  let unitCount = 0;

  // First pass: count valid units to size the iteration
  for (let i = 0; i < entityIds.length; i++) {
    const e = ctx.world.getEntity(entityIds[i]);
    if (e !== undefined && e.type === 'unit') unitCount++;
  }

  if (unitCount === 0) return;

  // Handle individual targets (line move)
  if (command.individualTargets && command.individualTargets.length === entityIds.length) {
    for (let i = 0; i < entityIds.length; i++) {
      const unit = ctx.world.getEntity(entityIds[i]);
      if (!unit || unit.type !== 'unit' || !unit.unit) continue;
      const target = command.individualTargets[i];
      addPathActions(unit, target.x, target.y, command.waypointType, command.queue, ctx, target.z);
    }
  } else if (command.targetX !== undefined && command.targetY !== undefined) {
    // Group move with formation spreading
    const spacing = 40;
    const unitsPerRow = Math.ceil(Math.sqrt(unitCount));

    let index = 0;
    for (let i = 0; i < entityIds.length; i++) {
      const unit = ctx.world.getEntity(entityIds[i]);
      if (!unit || unit.type !== 'unit' || !unit.unit) continue;

      // Grid formation offset
      const row = Math.floor(index / unitsPerRow);
      const col = index % unitsPerRow;
      const offsetX = (col - (unitsPerRow - 1) / 2) * spacing;
      const offsetY = (row - (unitCount / unitsPerRow - 1) / 2) * spacing;

      // Click altitude is shared by the formation centre — every
      // unit's per-cell offset stays at the same z plane. The
      // pathfinder only consults `goalZ` when the goal cell wasn't
      // snapped, so an offset that happens to land on a blocked cell
      // still gets a terrain-sampled altitude for its final waypoint.
      addPathActions(
        unit,
        command.targetX! + offsetX,
        command.targetY! + offsetY,
        command.waypointType,
        command.queue,
        ctx,
        command.targetZ,
      );
      index++;
    }
  }
}

function executeStopCommand(ctx: CommandContext, command: StopCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (!entity?.unit) continue;

    setUnitActions(entity.unit, []);
    entity.unit.patrolStartIndex = null;
    entity.unit.stuckTicks = 0;
    entity.unit.thrustDirX = 0;
    entity.unit.thrustDirY = 0;
    if (entity.builder) entity.builder.currentBuildTarget = null;
    if (entity.combat) {
      entity.combat.priorityTargetId = undefined;
      entity.combat.priorityTargetPoint = undefined;
      entity.combat.nextCombatProbeTick = undefined;
    }
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

function clearBuilderTargetIfRemoved(entity: Entity, removedActions: readonly UnitAction[]): void {
  const builder = entity.builder;
  if (!builder || builder.currentBuildTarget === null) return;
  for (let i = 0; i < removedActions.length; i++) {
    if (getUnitActionTargetId(removedActions[i]) === builder.currentBuildTarget) {
      builder.currentBuildTarget = null;
      return;
    }
  }
}

function executeClearQueuedOrdersCommand(ctx: CommandContext, command: ClearQueuedOrdersCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const unit = entity?.unit;
    if (!entity || !unit) continue;

    const activeIntentEnd = getFirstActionIntentEnd(unit.actions);
    if (activeIntentEnd < 0 || activeIntentEnd === unit.actions.length - 1) continue;

    const removedActions = spliceUnitActions(
      unit,
      activeIntentEnd + 1,
      unit.actions.length - activeIntentEnd - 1,
    );
    clearBuilderTargetIfRemoved(entity, removedActions);
    refreshPatrolStartIndex(unit);
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

function executeRemoveLastQueuedOrderCommand(ctx: CommandContext, command: RemoveLastQueuedOrderCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const unit = entity?.unit;
    if (!entity || !unit) continue;

    const activeIntentEnd = getFirstActionIntentEnd(unit.actions);
    const lastIntentFinalIndex = getLastActionIntentFinalIndex(unit.actions);
    if (activeIntentEnd < 0 || lastIntentFinalIndex <= activeIntentEnd) continue;

    const lastIntentStart = getActionIntentStart(unit.actions, lastIntentFinalIndex);
    const removedActions = spliceUnitActions(
      unit,
      lastIntentStart,
      unit.actions.length - lastIntentStart,
    );
    clearBuilderTargetIfRemoved(entity, removedActions);
    refreshPatrolStartIndex(unit);
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

function executeWaitCommand(ctx: CommandContext, command: WaitCommand): void {
  const units: Entity[] = [];
  let allWaiting = true;

  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (!entity?.unit) continue;
    units.push(entity);
    if (entity.unit.actions[0]?.type !== 'wait') allWaiting = false;
  }
  if (units.length === 0) return;

  const releaseCurrentWait = !command.queue && allWaiting;
  for (let i = 0; i < units.length; i++) {
    const entity = units[i];
    const unit = entity.unit!;

    if (releaseCurrentWait) {
      shiftUnitAction(unit);
      refreshPatrolStartIndex(unit);
      ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      continue;
    }

    if (!command.queue && unit.actions[0]?.type === 'wait') continue;
    const anchor = command.queue ? unit.actions[unit.actions.length - 1] : undefined;
    const x = anchor?.x ?? entity.transform.x;
    const y = anchor?.y ?? entity.transform.y;
    const action: UnitAction = {
      type: 'wait',
      x,
      y,
      z: anchor?.z ?? ctx.world.getGroundZ(x, y),
    };

    if (command.queue) {
      pushUnitAction(unit, action);
    } else {
      unshiftUnitAction(unit, action);
    }
    refreshPatrolStartIndex(unit);
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

function executeStartBuildCommand(ctx: CommandContext, command: StartBuildCommand): void {
  const builder = ctx.world.getEntity(command.builderId);
  if (!builder?.builder || !builder.ownership || !builder.commander || !builder.unit) return;

  const playerId = builder.ownership.playerId;

  // Start the building (creates the ghost/under-construction building)
  const building = ctx.constructionSystem.startBuilding(
    ctx.world,
    command.buildingType,
    command.gridX,
    command.gridY,
    playerId,
    command.builderId
  );

  if (!building) {
    // Placement failed (invalid location)
    return;
  }

  // Create build action with building info. The building's transform.z
  // already reflects the actual ground altitude under its footprint
  // (set during construction-system placement), so the action's z
  // matches what the player sees — the build-rect overlay sits on
  // top of the ground at the build site.
  //
  // Route through pathfinding so the builder walks AROUND water /
  // mountain ridges to reach the build site instead of bee-lining
  // through them. The final waypoint inherits the build metadata so
  // the construction handler still fires once the unit arrives.
  const action: UnitAction = {
    type: 'build',
    x: building.transform.x,
    y: building.transform.y,
    z: building.transform.z,
    buildingType: command.buildingType,
    gridX: command.gridX,
    gridY: command.gridY,
    buildingId: building.id,
  };

  addPathActionsWithFinal(builder, action, command.queue, ctx);
}

function executeQueueUnitCommand(ctx: CommandContext, command: QueueUnitCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory || !factory.ownership) return;

  // Repeat-build: the selection persists even at unit cap so production
  // resumes automatically when an existing unit dies. Cap is enforced
  // at shell-spawn time inside the production loop.
  if (factoryProductionSystem.selectUnit(factory, command.unitId, ctx.world)) {
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeCancelQueueItemCommand(ctx: CommandContext, command: CancelQueueItemCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory) return;

  // Pass `world` so dequeueing the head with an active shell tears the
  // shell down and refunds the resources already paid in.
  if (factoryProductionSystem.dequeueUnit(factory, command.index, ctx.world)) {
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeSetRallyPointCommand(ctx: CommandContext, command: SetRallyPointCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory) return;

  factory.factory.rallyX = command.rallyX;
  factory.factory.rallyY = command.rallyY;
  ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
}

function executeSetFactoryWaypointsCommand(ctx: CommandContext, command: SetFactoryWaypointsCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory) return;

  if (command.queue) {
    // Add to existing waypoints (preserving the click-altitude `z`).
    for (const wp of command.waypoints) {
      factory.factory.waypoints.push({ x: wp.x, y: wp.y, z: wp.z, type: wp.type });
    }
  } else {
    // Replace waypoints (reuse array)
    factory.factory.waypoints.length = command.waypoints.length;
    for (let i = 0; i < command.waypoints.length; i++) {
      const wp = command.waypoints[i];
      factory.factory.waypoints[i] = { x: wp.x, y: wp.y, z: wp.z, type: wp.type };
    }
  }

  // Update rally point to first waypoint
  if (command.waypoints.length > 0) {
    factory.factory.rallyX = command.waypoints[0].x;
    factory.factory.rallyY = command.waypoints[0].y;
  }
  ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
}

function executeFireDGunCommand(ctx: CommandContext, command: FireDGunCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  if (!commander?.commander || !commander.ownership || !commander.combat) return;

  const playerId = commander.ownership.playerId;
  const dx = command.targetX - commander.transform.x;
  const dy = command.targetY - commander.transform.y;
  const dist = magnitude(dx, dy);
  if (!Number.isFinite(dist) || dist <= 1e-6) return;

  // Check if we have enough energy
  const dgunCost = commander.commander.dgunEnergyCost;
  if (!economyManager.canAffordEnergy(playerId, dgunCost)) {
    return;
  }

  // Find the D-gun turret from the unit blueprint; the command path
  // should not know or duplicate the concrete turret id string.
  const dgunTurretId = getCommanderDGunTurretId(commander);
  if (!dgunTurretId) return;
  const turrets = commander.combat.turrets;
  const dgunIdx = turrets.findIndex(w => w.config.id === dgunTurretId);
  if (dgunIdx < 0) return;
  const dgunTurret = turrets[dgunIdx];

  // Spend energy
  economyManager.spendInstant(playerId, dgunCost);

  // Calculate direction to target
  const fireAngle = Math.atan2(dy, dx);

  // Snap dgun turret to target direction
  dgunTurret.rotation = fireAngle;
  dgunTurret.pitch = 0;
  dgunTurret.angularVelocity = 0;
  dgunTurret.angularAcceleration = 0;
  dgunTurret.pitchVelocity = 0;
  dgunTurret.pitchAcceleration = 0;
  ctx.world.markSnapshotDirty(commander.id, ENTITY_CHANGED_TURRETS);

  const { cos, sin } = getTransformCosSin(commander.transform);

  // Resolve the d-gun's turret mount center. Surface normal comes from
  // the unit's smoothed-tilt EMA (updateUnitTilt) so the slope-tilted
  // mount doesn't snap when the commander crosses a terrain triangle
  // edge.
  const mount = updateWeaponWorldKinematics(
    commander, dgunTurret, dgunIdx,
    cos, sin,
    { currentTick: ctx.world.getTick(), surfaceN: commander.unit?.surfaceNormal },
    _dgunMount,
  );
  const spawnX = mount.x;
  const spawnY = mount.y;
  const dgunFireZ = ctx.world.getGroundZ(spawnX, spawnY) + DGUN_TERRAIN_FOLLOW_HEIGHT;

  // D-gun is a terrain-following wave: it travels horizontally in the
  // commanded direction and snaps to local terrain height during
  // integration. Keep horizontal mount-center inheritance so firing
  // from a moving commander still uses the turret's own motion, but
  // never let vertical mount velocity turn it into a ballistic shell.
  const dgunShot = dgunTurret.config.shot;
  if (!dgunShot || dgunShot.type === 'force') {
    throw new Error('D-gun turret must use a projectile, beam, or laser shot');
  }
  const speed = isProjectileShot(dgunShot) ? getProjectileLaunchSpeed(dgunShot) : 350;
  let velocityX = Math.cos(fireAngle) * speed;
  let velocityY = Math.sin(fireAngle) * speed;
  let velocityZ = 0;
  if (commander.unit) {
    // Manual D-gun shots update the same turret kinematics cache used
    // by automated weapons above, so inherited velocity is the turret
    // mount center's own 3D motion.
    const inherited = dgunTurret.worldVelocity;
    _dgunMountVelocity.x = inherited?.x ?? 0;
    _dgunMountVelocity.y = inherited?.y ?? 0;
    velocityX += _dgunMountVelocity.x;
    velocityY += _dgunMountVelocity.y;
  }

  // Create D-gun projectile
  const projectile = ctx.world.createDGunProjectile(
    spawnX,
    spawnY,
    velocityX,
    velocityY,
    playerId,
    commander.id,
    dgunTurret.config
  );

  projectile.transform.z = dgunFireZ;
  if (projectile.projectile) {
    projectile.projectile.velocityZ = velocityZ;
    projectile.projectile.lastSentVelZ = velocityZ;
  }

  ctx.world.addEntity(projectile);

  // Emit projectile spawn event for D-gun. Spawn XY comes from the
  // turret mount center; altitude remains terrain-following.
  ctx.pendingProjectileSpawns.push({
    id: projectile.id,
    pos: { x: spawnX, y: spawnY, z: dgunFireZ },
    rotation: fireAngle,
    velocity: { x: velocityX, y: velocityY, z: velocityZ },
    projectileType: 'projectile',
    maxLifespan: projectile.projectile?.maxLifespan,
    turretId: dgunTurret.config.id,
    shotId: dgunShot.id,
    sourceTurretId: dgunTurret.config.id,
    playerId,
    sourceEntityId: commander.id,
    turretIndex: dgunIdx,
    barrelIndex: 0,
    isDGun: true,
  });

  // Emit audio event at the authoritative projectile spawn.
  const dgunSimEvent: SimEvent = {
    type: 'fire',
    pos: { x: spawnX, y: spawnY, z: dgunFireZ },
    turretId: dgunTurret.config.id,
  };
  ctx.onSimEvent?.(dgunSimEvent);
  ctx.pendingSimEvents.push(dgunSimEvent);
}

function executeSetJumpEnabledCommand(ctx: CommandContext, command: SetJumpEnabledCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (!entity?.unit) continue;
    if (setUnitJumpEnabled(entity.unit, command.enabled)) {
      ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_JUMP);
    }
  }
}

function executeSetFireEnabledCommand(ctx: CommandContext, command: SetFireEnabledCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const combat = entity?.combat;
    if (!entity || !combat) continue;

    const enabled = command.enabled === true;
    if (combat.fireEnabled === enabled) continue;
    combat.fireEnabled = enabled;
    if (!enabled) {
      combat.priorityTargetId = undefined;
      combat.priorityTargetPoint = undefined;
      combat.nextCombatProbeTick = undefined;
      clearCombatActivityFlags(combat);
      for (let wi = 0; wi < combat.turrets.length; wi++) {
        const weapon = combat.turrets[wi];
        setWeaponTarget(weapon, entity, wi, null);
        weapon.state = 'idle';
      }
    }
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE | ENTITY_CHANGED_TURRETS);
  }
}

function executeRepairCommand(ctx: CommandContext, command: RepairCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  const target = ctx.world.getEntity(command.targetId);
  enqueueRepairAction(ctx, commander, target, command.queue);
}

function executeRepairAreaCommand(ctx: CommandContext, command: RepairAreaCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  if (!commander?.commander || !commander.unit || !commander.builder) return;

  const radius = clampRepairAreaRadius(command.radius);
  const target = findRepairAreaTarget(
    ctx,
    commander,
    command.targetX,
    command.targetY,
    radius,
  );
  enqueueRepairAction(ctx, commander, target, command.queue);
}

function executeReclaimCommand(ctx: CommandContext, command: ReclaimCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  const target = ctx.world.getEntity(command.targetId);
  enqueueReclaimAction(ctx, commander, target, command.queue);
}

function clampRepairAreaRadius(radius: number): number {
  if (!Number.isFinite(radius)) return REPAIR_AREA_MAX_RADIUS;
  return Math.max(1, Math.min(radius, REPAIR_AREA_MAX_RADIUS));
}

function isRepairableByCommander(commander: Entity, target: Entity | undefined): target is Entity {
  if (!commander.ownership || !target?.ownership) return false;
  if (target.ownership.playerId !== commander.ownership.playerId) return false;

  const isIncompleteBuilding = !!target.buildable &&
    !target.buildable.isComplete &&
    !target.buildable.isGhost;
  const isDamagedUnit = !!target.unit &&
    target.unit.hp < target.unit.maxHp &&
    target.unit.hp > 0;

  return isIncompleteBuilding || isDamagedUnit;
}

function entityAreaDistanceSq(target: Entity, x: number, y: number): number {
  if (target.building) {
    const halfW = target.building.width / 2;
    const halfH = target.building.height / 2;
    const dx = Math.max(Math.abs(target.transform.x - x) - halfW, 0);
    const dy = Math.max(Math.abs(target.transform.y - y) - halfH, 0);
    return dx * dx + dy * dy;
  }

  const dx = target.transform.x - x;
  const dy = target.transform.y - y;
  return dx * dx + dy * dy;
}

function findRepairAreaTarget(
  ctx: CommandContext,
  commander: Entity,
  x: number,
  y: number,
  radius: number,
): Entity | undefined {
  const radiusSq = radius * radius;
  let bestTarget: Entity | undefined;
  let bestDistanceSq = Infinity;

  const buildings = ctx.world.getBuildings();
  for (let i = 0; i < buildings.length; i++) {
    const target = buildings[i];
    if (!isRepairableByCommander(commander, target)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq || distSq >= bestDistanceSq) continue;
    bestDistanceSq = distSq;
    bestTarget = target;
  }

  const units = ctx.world.getUnits();
  for (let i = 0; i < units.length; i++) {
    const target = units[i];
    if (!isRepairableByCommander(commander, target)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq || distSq >= bestDistanceSq) continue;
    bestDistanceSq = distSq;
    bestTarget = target;
  }

  return bestTarget;
}

function enqueueRepairAction(
  ctx: CommandContext,
  commander: Entity | undefined,
  target: Entity | undefined,
  queue: boolean,
): void {
  if (!commander?.commander || !commander.unit || !commander.builder) return;
  if (!isRepairableByCommander(commander, target)) return;

  // The action's z is the target's actual altitude (already correct on
  // the entity transform), not a terrain re-sample at (x, y). For a
  // damaged unit this tracks the unit's current altitude; for a building
  // it sits on the ground above its footprint.
  //
  // Route through pathfinding so the commander walks around water to reach
  // the repair target. The final waypoint keeps targetId so the repair
  // handler fires when the commander arrives.
  const targetPoint = getEntityTargetPoint(target);
  const action: UnitAction = {
    type: 'repair',
    x: targetPoint.x,
    y: targetPoint.y,
    z: targetPoint.z,
    targetId: target.id,
  };

  addPathActionsWithFinal(commander, action, queue, ctx);
}

function enqueueReclaimAction(
  ctx: CommandContext,
  commander: Entity | undefined,
  target: Entity | undefined,
  queue: boolean,
): void {
  if (!commander?.commander || !commander.unit || !commander.builder) return;
  if (commander.id === target?.id || !isReclaimableTarget(target)) return;

  const targetPoint = getEntityTargetPoint(target);
  const action: UnitAction = {
    type: 'reclaim',
    x: targetPoint.x,
    y: targetPoint.y,
    z: targetPoint.z,
    targetId: target.id,
  };

  addPathActionsWithFinal(commander, action, queue, ctx);
}

function executeAttackCommand(ctx: CommandContext, command: AttackCommand): void {
  const target = ctx.world.getEntity(command.targetId);
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    enqueueAttackAction(ctx, entity, target, command.queue);
  }
}

function executeAttackGroundCommand(ctx: CommandContext, command: AttackGroundCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    enqueueAttackGroundAction(
      ctx,
      entity,
      command.targetX,
      command.targetY,
      command.targetZ,
      command.queue,
    );
  }
}

function executeAttackAreaCommand(ctx: CommandContext, command: AttackAreaCommand): void {
  const radius = clampAttackAreaRadius(command.radius);
  const playerId = getCommandUnitPlayerId(ctx, command.entityIds);
  if (playerId === undefined) return;

  const target = findAttackAreaTarget(
    ctx,
    playerId,
    command.targetX,
    command.targetY,
    radius,
  );

  if (!target) {
    executeMoveCommand(ctx, {
      type: 'move',
      tick: command.tick,
      entityIds: command.entityIds,
      targetX: command.targetX,
      targetY: command.targetY,
      targetZ: command.targetZ,
      waypointType: 'fight',
      queue: command.queue,
    });
    return;
  }

  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    enqueueAttackAction(ctx, entity, target, command.queue);
  }
}

function executeGuardCommand(ctx: CommandContext, command: GuardCommand): void {
  const target = ctx.world.getEntity(command.targetId);
  if (!target?.ownership) return;

  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (!entity?.unit || !entity.ownership) continue;
    if (entity.id === target.id) continue;
    if (entity.ownership.playerId !== target.ownership.playerId) continue;

    if (entity.commander && isRepairableByCommander(entity, target)) {
      enqueueRepairAction(ctx, entity, target, command.queue);
      continue;
    }

    enqueueGuardAction(ctx, entity, target, command.queue);
  }
}

function clampAttackAreaRadius(radius: number): number {
  if (!Number.isFinite(radius)) return ATTACK_AREA_MAX_RADIUS;
  return Math.max(1, Math.min(radius, ATTACK_AREA_MAX_RADIUS));
}

function getCommandUnitPlayerId(ctx: CommandContext, entityIds: readonly number[]): PlayerId | undefined {
  for (let i = 0; i < entityIds.length; i++) {
    const entity = ctx.world.getEntity(entityIds[i]);
    if (entity?.unit && entity.ownership) return entity.ownership.playerId;
  }
  return undefined;
}

function isAliveAttackTarget(target: Entity | undefined): target is Entity {
  if (!target) return false;
  if (target.unit) return target.unit.hp > 0;
  if (target.building) return target.building.hp > 0;
  return false;
}

function isAttackableEnemyTargetForPlayer(target: Entity | undefined, playerId: PlayerId): target is Entity {
  return isAliveAttackTarget(target) &&
    target.ownership !== undefined &&
    target.ownership.playerId !== playerId;
}

function findAttackAreaTarget(
  ctx: CommandContext,
  playerId: PlayerId,
  x: number,
  y: number,
  radius: number,
): Entity | undefined {
  const radiusSq = radius * radius;
  let bestTarget: Entity | undefined;
  let bestDistanceSq = Infinity;

  const units = ctx.world.getUnits();
  for (let i = 0; i < units.length; i++) {
    const target = units[i];
    if (!isAttackableEnemyTargetForPlayer(target, playerId)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq || distSq >= bestDistanceSq) continue;
    bestDistanceSq = distSq;
    bestTarget = target;
  }

  const buildings = ctx.world.getBuildings();
  for (let i = 0; i < buildings.length; i++) {
    const target = buildings[i];
    if (!isAttackableEnemyTargetForPlayer(target, playerId)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq || distSq >= bestDistanceSq) continue;
    bestDistanceSq = distSq;
    bestTarget = target;
  }

  return bestTarget;
}

function enqueueAttackAction(
  ctx: CommandContext,
  entity: Entity | undefined,
  target: Entity | undefined,
  queue: boolean,
): void {
  if (!entity || entity.type !== 'unit' || !entity.unit) return;
  if (!entity.ownership || !isAttackableEnemyTargetForPlayer(target, entity.ownership.playerId)) return;

  // Route the approach through pathfinding so the unit walks around water
  // and mountains. The final waypoint keeps targetId so the targeting
  // handler engages the right entity once the unit is in range.
  const targetPoint = getEntityTargetPoint(target);
  const action: UnitAction = {
    type: 'attack',
    x: targetPoint.x,
    y: targetPoint.y,
    z: targetPoint.z,
    targetId: target.id,
  };
  addPathActionsWithFinal(entity, action, queue, ctx);
}

function enqueueAttackGroundAction(
  ctx: CommandContext,
  entity: Entity | undefined,
  targetX: number,
  targetY: number,
  targetZ: number | undefined,
  queue: boolean,
): void {
  if (!entity || entity.type !== 'unit' || !entity.unit || !entity.combat) return;
  const action: UnitAction = {
    type: 'attackGround',
    x: targetX,
    y: targetY,
    z: targetZ,
  };
  addPathActionsWithFinal(entity, action, queue, ctx);
}

function enqueueGuardAction(
  ctx: CommandContext,
  entity: Entity,
  target: Entity,
  queue: boolean,
): void {
  if (!isAliveGuardTarget(target)) return;
  const targetPoint = getEntityTargetPoint(target);
  const action: UnitAction = {
    type: 'guard',
    x: targetPoint.x,
    y: targetPoint.y,
    z: targetPoint.z,
    targetId: target.id,
  };
  addPathActionsWithFinal(entity, action, queue, ctx);
}

// Add an action to a unit (respecting queue flag)
export function addActionToUnit(entity: Entity, action: UnitAction, queue: boolean, world?: WorldState): void {
  if (!entity.unit) return;

  if (!queue) {
    // Replace all actions
    setUnitActions(entity.unit, [action]);
    entity.unit.patrolStartIndex = null;
  } else {
    // Add to existing actions
    pushUnitAction(entity.unit, action);
  }

  // Update patrol start index if this is a patrol action
  if (action.type === 'patrol' && entity.unit.patrolStartIndex === null) {
    // Mark the start of patrol loop
    entity.unit.patrolStartIndex = entity.unit.actions.length - 1;
  }

  world?.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
}

/** Plan a path from the unit's current position to (goalX, goalY) and
 *  enqueue one action per smoothed waypoint. All waypoints share the
 *  same `type` — fight/patrol intermediates still let the unit engage
 *  along the way, which is what the player's chosen mode implies.
 *  Falls through to the legacy single-waypoint behaviour when the
 *  pathfinder returns one waypoint (no obstacles between unit and
 *  goal, or no path under the planning budget). `goalZ` is the
 *  click-derived altitude (from CursorGround.pickSim → MoveCommand);
 *  threaded into expandPathActions so the final waypoint records the
 *  click's z when the goal cell wasn't snapped. */
function addPathActions(
  unit: Entity,
  goalX: number, goalY: number,
  type: UnitAction['type'],
  queue: boolean,
  ctx: CommandContext,
  goalZ?: number,
): void {
  // When appending to an existing queue (queue=true), plan from the
  // END of the current queue, not from the unit's CURRENT position.
  // By the time the unit starts executing this new path it will
  // already be at the last queued waypoint — planning from
  // `unit.transform` would give the planner the wrong start, and
  // the connecting chord between consecutive queued goals would
  // never get pathfinder-checked. That manifests as the visualised
  // chain dipping through water between two queued goals on
  // opposite sides of a divider valley (each individual segment was
  // planned correctly, but the connecting hop between them was
  // never planned at all).
  let planStartX = unit.transform.x;
  let planStartY = unit.transform.y;
  if (queue && unit.unit && unit.unit.actions.length > 0) {
    const last = unit.unit.actions[unit.unit.actions.length - 1];
    planStartX = last.x;
    planStartY = last.y;
  }
  const actions = expandPathActions(
    planStartX, planStartY,
    goalX, goalY, type,
    ctx.world.mapWidth, ctx.world.mapHeight,
    ctx.constructionSystem.getGrid(),
    goalZ,
    pathTerrainFilterForUnit(unit),
  );
  if (GAME_DIAGNOSTICS.commandPlans) {
    // Diagnostic: dump the plan for player-issued move commands so we
    // can correlate "I clicked here" -> "the unit got these waypoints".
    const beforeLen = unit.unit?.actions.length ?? 0;
    debugLog(
      true,
      '[plan] unit #%d (%d,%d)->(%d,%d) type=%s queue=%s: prev queue had %d action(s), planner emits %d waypoint(s)',
      unit.id,
      Math.round(unit.transform.x), Math.round(unit.transform.y),
      Math.round(goalX), Math.round(goalY),
      type,
      queue,
      beforeLen,
      actions.length,
    );
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      debugLog(
        true,
        '  [plan]   wp %d: (%d, %d, %d)%s',
        i, Math.round(a.x), Math.round(a.y),
        a.z !== undefined ? Math.round(a.z) : -1,
        a.isPathExpansion ? ' [intermediate]' : '',
      );
    }
  }
  // First action either replaces the queue (queue=false) or appends.
  // The remaining waypoints always append regardless — they belong
  // to the same "do this trip" intent and queue:true keeps them
  // ordered after the first.
  for (let i = 0; i < actions.length; i++) {
    addActionToUnit(unit, actions[i], i === 0 ? queue : true, ctx.world);
  }
  if (GAME_DIAGNOSTICS.commandPlans) {
    const afterLen = unit.unit?.actions.length ?? 0;
    debugLog(true, '  [plan]   unit #%d actions.length now = %d', unit.id, afterLen);
  }
}

/** Plan a path to (goalX, goalY) and enqueue intermediate `move`
 *  waypoints + a single FINAL waypoint that carries the action-
 *  specific type and metadata (targetId / buildingType / buildingId
 *  / etc). Used by attack / repair / build commands so the unit
 *  pathfinds AROUND water and obstacles to reach the action's
 *  target instead of writing a single bee-line action that walks
 *  the unit straight at the target's coordinates.
 *
 *  Why this matters: a `repair` / `attack` / `build` action whose
 *  (x, y) is across water made the unit press into the shoreline
 *  with the water-pusher catching them, while the visualized line
 *  cut straight across the valley — exactly the "paths over water"
 *  artifact the user reported. Routing through `expandPathActions`
 *  here makes the planner do its job (water/building/mountain
 *  avoidance) and the visualized path matches what the unit
 *  actually walks. The final waypoint inherits the original
 *  action's metadata so the per-action handler at the destination
 *  (attack the target, repair the target, build the building)
 *  still runs as before. */
function addPathActionsWithFinal(
  unit: Entity,
  finalAction: UnitAction,
  queue: boolean,
  ctx: CommandContext,
): void {
  // Same queue-tail planning fix as addPathActions: when appending
  // to an existing queue, plan from the last queued waypoint
  // instead of from the unit's current position. Otherwise the
  // implicit chord between two consecutively queued goals is
  // never pathfinder-checked and can cross water.
  let planStartX = unit.transform.x;
  let planStartY = unit.transform.y;
  if (queue && unit.unit && unit.unit.actions.length > 0) {
    const last = unit.unit.actions[unit.unit.actions.length - 1];
    planStartX = last.x;
    planStartY = last.y;
  }
  const actions = expandPathActions(
    planStartX, planStartY,
    finalAction.x, finalAction.y, 'move',
    ctx.world.mapWidth, ctx.world.mapHeight,
    ctx.constructionSystem.getGrid(),
    finalAction.z,
    pathTerrainFilterForUnit(unit),
  );
  if (actions.length === 0) return;
  // Promote the LAST waypoint to the original action's type and
  // copy its metadata across (targetId / buildingType / buildingId
  // / gridX / gridY). The (x, y, z) on the last waypoint were
  // already set by the planner — when the goal was snapped to a
  // reachable cell, we use that cell's centre instead of the
  // target's own position so the unit stops on the dry-land
  // approach to the target rather than pushing into water.
  const last = actions[actions.length - 1];
  last.type = finalAction.type;
  if (finalAction.targetId !== undefined) last.targetId = finalAction.targetId;
  if (finalAction.buildingType !== undefined) last.buildingType = finalAction.buildingType;
  if (finalAction.buildingId !== undefined) last.buildingId = finalAction.buildingId;
  if (finalAction.gridX !== undefined) last.gridX = finalAction.gridX;
  if (finalAction.gridY !== undefined) last.gridY = finalAction.gridY;
  // The last waypoint is the user-issued endpoint, not a planner
  // intermediate, so make sure the SIMPLE-mode renderer marks it
  // as such.
  last.isPathExpansion = undefined;
  for (let i = 0; i < actions.length; i++) {
    addActionToUnit(unit, actions[i], i === 0 ? queue : true, ctx.world);
  }
}
