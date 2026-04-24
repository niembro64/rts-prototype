// Command execution - extracted from Simulation.ts
// Handles all player command types (select, move, build, queue, rally, dgun, repair)

import type { Command, MoveCommand, SelectCommand, StartBuildCommand, QueueUnitCommand, CancelQueueItemCommand, SetRallyPointCommand, SetFactoryWaypointsCommand, FireDGunCommand, RepairCommand, AttackCommand } from './commands';
import type { Entity, UnitAction } from './types';
import type { SimEvent } from './combat';
import { magnitude, getWeaponWorldPosition, getTransformCosSin } from '../math';
import { getBarrelTipWorldPos } from './combat/combatUtils';
import { economyManager } from './economy';
import { factoryProductionSystem } from './factoryProduction';
import { MUZZLE_HEIGHT_ABOVE_GROUND } from '../../config';

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
    case 'clearSelection':
      ctx.world.clearSelection();
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
    case 'repair':
      executeRepairCommand(ctx, command);
      break;
    case 'attack':
      executeAttackCommand(ctx, command);
      break;
  }
}

function executeSelectCommand(ctx: CommandContext, command: SelectCommand): void {
  if (!command.additive) {
    ctx.world.clearSelection();
  }
  ctx.world.selectEntities(command.entityIds);
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
      const action: UnitAction = {
        type: command.waypointType,
        x: target.x,
        y: target.y,
      };
      addActionToUnit(unit, action, command.queue);
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

      const action: UnitAction = {
        type: command.waypointType,
        x: command.targetX! + offsetX,
        y: command.targetY! + offsetY,
      };
      addActionToUnit(unit, action, command.queue);
      index++;
    }
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

  // Create build action with building info
  const action: UnitAction = {
    type: 'build',
    x: building.transform.x,
    y: building.transform.y,
    buildingType: command.buildingType,
    gridX: command.gridX,
    gridY: command.gridY,
    buildingId: building.id,
  };

  addActionToUnit(builder, action, command.queue);
}

function executeQueueUnitCommand(ctx: CommandContext, command: QueueUnitCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory || !factory.ownership) return;

  // Don't allow queueing if player is at unit cap (including already-queued units)
  if (!ctx.world.canPlayerQueueUnit(factory.ownership.playerId)) return;

  factoryProductionSystem.queueUnit(factory, command.unitId);
}

function executeCancelQueueItemCommand(ctx: CommandContext, command: CancelQueueItemCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory) return;

  factoryProductionSystem.dequeueUnit(factory, command.index);
}

function executeSetRallyPointCommand(ctx: CommandContext, command: SetRallyPointCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory) return;

  factory.factory.rallyX = command.rallyX;
  factory.factory.rallyY = command.rallyY;
}

function executeSetFactoryWaypointsCommand(ctx: CommandContext, command: SetFactoryWaypointsCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory) return;

  if (command.queue) {
    // Add to existing waypoints
    for (const wp of command.waypoints) {
      factory.factory.waypoints.push({ x: wp.x, y: wp.y, type: wp.type });
    }
  } else {
    // Replace waypoints (reuse array)
    factory.factory.waypoints.length = command.waypoints.length;
    for (let i = 0; i < command.waypoints.length; i++) {
      const wp = command.waypoints[i];
      factory.factory.waypoints[i] = { x: wp.x, y: wp.y, type: wp.type };
    }
  }

  // Update rally point to first waypoint
  if (command.waypoints.length > 0) {
    factory.factory.rallyX = command.waypoints[0].x;
    factory.factory.rallyY = command.waypoints[0].y;
  }
}

function executeFireDGunCommand(ctx: CommandContext, command: FireDGunCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  if (!commander?.commander || !commander.ownership || !commander.turrets) return;

  const playerId = commander.ownership.playerId;

  // Check if we have enough energy
  const dgunCost = commander.commander.dgunEnergyCost;
  if (!economyManager.canAfford(playerId, dgunCost)) {
    return;
  }

  // Find the dgun turret by config id
  const dgunIdx = commander.turrets.findIndex(w => w.config.id === 'dgunTurret');
  if (dgunIdx < 0) return;
  const dgunTurret = commander.turrets[dgunIdx];

  // Spend energy
  economyManager.spendInstant(playerId, dgunCost);

  // Calculate direction to target
  const dx = command.targetX - commander.transform.x;
  const dy = command.targetY - commander.transform.y;
  const dist = magnitude(dx, dy);

  if (dist === 0) return;

  const fireAngle = Math.atan2(dy, dx);

  // Snap dgun turret to target direction
  dgunTurret.rotation = fireAngle;
  dgunTurret.angularVelocity = 0;

  // Compute turret world position from unit transform + turret offset
  const { cos, sin } = getTransformCosSin(commander.transform);
  const weaponPos = getWeaponWorldPosition(
    commander.transform.x, commander.transform.y,
    cos, sin,
    dgunTurret.offset.x, dgunTurret.offset.y
  );

  const fireCos = Math.cos(fireAngle);
  const fireSin = Math.sin(fireAngle);

  // Spawn position at barrel tip
  const bt = getBarrelTipWorldPos(weaponPos.x, weaponPos.y, fireAngle, dgunTurret.config, commander.unit!.unitRadiusCollider.scale);
  const spawnX = bt.x;
  const spawnY = bt.y;

  // Calculate velocity with turret-tip inheritance
  const dgunShot = dgunTurret.config.shot;
  const speed = dgunShot.type === 'projectile' ? dgunShot.launchForce / dgunShot.mass : 350;
  let velocityX = fireCos * speed;
  let velocityY = fireSin * speed;
  if (ctx.world.projVelInherit && commander.unit) {
    // Unit linear velocity
    velocityX += commander.unit.velocityX ?? 0;
    velocityY += commander.unit.velocityY ?? 0;
    // Turret rotational velocity at fire point (tangential = omega * r)
    const barrelDx = bt.x - weaponPos.x;
    const barrelDy = bt.y - weaponPos.y;
    const omega = dgunTurret.angularVelocity;
    velocityX += -barrelDy * omega;
    velocityY += barrelDx * omega;
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

  ctx.world.addEntity(projectile);

  // Emit projectile spawn event for D-gun. D-gun fires horizontally
  // from the commander's barrel tip (not sphere center) so the
  // projectile emerges from the visible turret instead of the
  // commander's belly. Same muzzle-height formula the AI turrets
  // use in projectileSystem.ts.
  const commanderGroundZ = commander.transform.z -
    (commander.unit?.unitRadiusCollider.push ?? 0);
  const dgunFireZ = commanderGroundZ + MUZZLE_HEIGHT_ABOVE_GROUND;
  ctx.pendingProjectileSpawns.push({
    id: projectile.id,
    pos: { x: spawnX, y: spawnY, z: dgunFireZ },
    rotation: fireAngle,
    velocity: { x: velocityX, y: velocityY, z: 0 },
    projectileType: 'projectile',
    turretId: 'dgunTurret',
    playerId,
    sourceEntityId: commander.id,
    turretIndex: dgunIdx,
    isDGun: true,
  });

  // Emit audio event — muzzle-flash position matches the projectile
  // spawn z (commander ground-footprint + muzzle height) so the
  // visible flash aligns with where the shot actually came out.
  const dgunSimEvent: SimEvent = {
    type: 'fire',
    pos: { x: spawnX, y: spawnY, z: dgunFireZ },
    turretId: 'dgunTurret',
  };
  ctx.onSimEvent?.(dgunSimEvent);
  ctx.pendingSimEvents.push(dgunSimEvent);
}

function executeRepairCommand(ctx: CommandContext, command: RepairCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  const target = ctx.world.getEntity(command.targetId);

  if (!commander?.commander || !commander.unit || !commander.builder) return;
  if (!target) return;

  // Target must be a buildable (incomplete building) or a damaged unit
  const isIncompleteBuilding = target.buildable && !target.buildable.isComplete && !target.buildable.isGhost;
  const isDamagedUnit = target.unit && target.unit.hp < target.unit.maxHp && target.unit.hp > 0;

  if (!isIncompleteBuilding && !isDamagedUnit) return;

  // Create repair action
  const action: UnitAction = {
    type: 'repair',
    x: target.transform.x,
    y: target.transform.y,
    targetId: command.targetId,
  };

  addActionToUnit(commander, action, command.queue);
}

function executeAttackCommand(ctx: CommandContext, command: AttackCommand): void {
  const target = ctx.world.getEntity(command.targetId);
  if (!target) return;

  // Target must be alive (unit or building)
  const isAliveUnit = target.unit && target.unit.hp > 0;
  const isAliveBuilding = target.building && target.building.hp > 0;
  if (!isAliveUnit && !isAliveBuilding) return;

  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (!entity || entity.type !== 'unit' || !entity.unit) continue;

    const action: UnitAction = {
      type: 'attack',
      x: target.transform.x,
      y: target.transform.y,
      targetId: command.targetId,
    };
    addActionToUnit(entity, action, command.queue);
  }
}

// Add an action to a unit (respecting queue flag)
export function addActionToUnit(entity: Entity, action: UnitAction, queue: boolean): void {
  if (!entity.unit) return;

  if (!queue) {
    // Replace all actions
    entity.unit.actions = [action];
    entity.unit.patrolStartIndex = null;
  } else {
    // Add to existing actions
    entity.unit.actions.push(action);
  }

  // Update patrol start index if this is a patrol action
  if (action.type === 'patrol' && entity.unit.patrolStartIndex === null) {
    // Mark the start of patrol loop
    entity.unit.patrolStartIndex = entity.unit.actions.length - 1;
  }
}
