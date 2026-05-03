// Command execution - extracted from Simulation.ts
// Handles all player command types (select, move, build, queue, rally, dgun, repair)

import type { Command, MoveCommand, SelectCommand, StartBuildCommand, QueueUnitCommand, CancelQueueItemCommand, SetRallyPointCommand, SetFactoryWaypointsCommand, FireDGunCommand, RepairCommand, AttackCommand } from './commands';
import type { Entity, UnitAction } from './types';
import type { WorldState } from './WorldState';
import type { SimEvent } from './combat';
import { magnitude, getTransformCosSin, getBarrelTip } from '../math';
import { computeTurretPointVelocity, getProjectileLaunchSpeed, updateWeaponWorldKinematics } from './combat/combatUtils';
import { economyManager } from './economy';
import { factoryProductionSystem } from './factoryProduction';
import { expandPathActions } from './Pathfinder';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_TURRETS } from '../../types/network';
import { getEntityTargetPoint } from './buildingAnchors';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';

const _dgunMount = { x: 0, y: 0, z: 0 };
const _dgunMuzzleVelocity = { x: 0, y: 0, z: 0 };

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

  // Don't allow queueing if player is at unit cap (including already-queued units)
  if (!ctx.world.canPlayerQueueUnit(factory.ownership.playerId)) return;

  if (factoryProductionSystem.queueUnit(factory, command.unitId)) {
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeCancelQueueItemCommand(ctx: CommandContext, command: CancelQueueItemCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (!factory?.factory) return;

  if (factoryProductionSystem.dequeueUnit(factory, command.index)) {
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
  ctx.world.markSnapshotDirty(commander.id, ENTITY_CHANGED_TURRETS);

  const { cos, sin } = getTransformCosSin(commander.transform);

  // Resolve the d-gun's barrel tip + direction through the shared
  // primitive — exactly the same call AI turrets use — so the
  // commander-fired shot emerges from the same point and axis the
  // renderer draws.
  const surfaceN = ctx.world.getCachedSurfaceNormal(
    commander.transform.x, commander.transform.y,
  );
  const mount = updateWeaponWorldKinematics(
    commander, dgunTurret, dgunIdx,
    cos, sin,
    { currentTick: ctx.world.getTick(), surfaceN },
    _dgunMount,
  );
  const tip = getBarrelTip(
    mount.x, mount.y, mount.z,
    fireAngle, dgunTurret.pitch,
    dgunTurret.config,
    commander.unit!.bodyRadius,
    0,
  );
  const spawnX = tip.x;
  const spawnY = tip.y;
  const dgunFireZ = tip.z;

  // Calculate velocity with turret-tip inheritance
  const dgunShot = dgunTurret.config.shot;
  const speed = dgunShot.type === 'projectile' ? getProjectileLaunchSpeed(dgunShot) : 350;
  let velocityX = tip.dirX * speed;
  let velocityY = tip.dirY * speed;
  let velocityZ = tip.dirZ * speed;
  if (commander.unit) {
    // Manual D-gun shots update the same turret kinematics cache used
    // by automated weapons above, so inherited velocity is the turret's
    // own 3D motion plus yaw/pitch tangential muzzle motion.
    const inherited = computeTurretPointVelocity(
      dgunTurret,
      mount.x, mount.y, mount.z,
      tip.x, tip.y, tip.z,
      _dgunMuzzleVelocity,
    );
    velocityX += inherited.x;
    velocityY += inherited.y;
    velocityZ += inherited.z;
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

  // Emit projectile spawn event for D-gun. Spawn pos + altitude came
  // from the shared BarrelGeometry primitive (see getBarrelTip call
  // above) so the event lines up with the visible barrel tip.
  ctx.pendingProjectileSpawns.push({
    id: projectile.id,
    pos: { x: spawnX, y: spawnY, z: dgunFireZ },
    rotation: fireAngle,
    velocity: { x: velocityX, y: velocityY, z: velocityZ },
    projectileType: 'projectile',
    maxLifespan: projectile.projectile?.maxLifespan,
    turretId: 'dgunTurret',
    playerId,
    sourceEntityId: commander.id,
    turretIndex: dgunIdx,
    barrelIndex: 0,
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

  // Create repair action — the action's z is the target's actual
  // altitude (already correct on the entity's transform), not a
  // re-sample of the terrain at (x, y). For a damaged unit this
  // tracks the unit's current altitude; for a building it sits on
  // the ground above its footprint.
  //
  // Route through pathfinding so the commander walks AROUND water
  // to reach the repair target — straight lines toward a target
  // across a lake used to push the commander into the shore. The
  // final waypoint keeps targetId so the repair handler fires when
  // the commander arrives.
  const targetPoint = getEntityTargetPoint(target);
  const action: UnitAction = {
    type: 'repair',
    x: targetPoint.x,
    y: targetPoint.y,
    z: targetPoint.z,
    targetId: command.targetId,
  };

  addPathActionsWithFinal(commander, action, command.queue, ctx);
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

    // Route the approach through pathfinding so the unit walks
    // AROUND water / mountains to reach the attack target. Without
    // this, an `attack` action whose (x, y) is the target's
    // position bee-lined the unit straight at the target — even
    // through a lake — leaving the visualized line cutting across
    // water while the unit pressed into the shore. The final
    // waypoint keeps targetId so the targeting handler engages
    // the right entity once the unit is in range.
    const targetPoint = getEntityTargetPoint(target);
    const action: UnitAction = {
      type: 'attack',
      x: targetPoint.x,
      y: targetPoint.y,
      z: targetPoint.z,
      targetId: command.targetId,
    };
    addPathActionsWithFinal(entity, action, command.queue, ctx);
  }
}

// Add an action to a unit (respecting queue flag)
export function addActionToUnit(entity: Entity, action: UnitAction, queue: boolean, world?: WorldState): void {
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
  // opposite sides of a divider lake (each individual segment was
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
 *  cut straight across the lake — exactly the "paths over water"
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
  if (finalAction.type === 'attack') {
    last.x = finalAction.x;
    last.y = finalAction.y;
    last.z = finalAction.z;
  }
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
