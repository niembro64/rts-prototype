// Command execution - extracted from Simulation.ts
// Handles all player command types (select, move, build, queue, rally, dgun, repair)

import type {
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
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
  SetFireEnabledCommand,
  SetBuildingActiveCommand,
  SelfDestructCommand,
  SetTowerTargetCommand,
  SetRallyPointCommand,
  StartBuildCommand,
  StopCommand,
  WaitCommand,
} from './commands';
import type { Entity, PlayerId, ShotSource, Unit, UnitAction } from './types';
import { NO_ENTITY_ID } from './types';
import { isProjectileShot } from './types';
import type { WorldState } from './WorldState';
import type { SimEvent } from './combat';
import { magnitude, getTransformCosSin } from '../math';
import { getProjectileLaunchSpeed, updateWeaponWorldKinematics } from './combat/combatUtils';
import { economyManager } from './economy';
import { factoryProductionSystem } from './factoryProduction';
import {
  expandPathActions,
  pathTerrainFilterForLocomotion,
  type PathTerrainFilter,
} from './Pathfinder';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_COMBAT_MODE, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_HP, ENTITY_CHANGED_TURRETS } from '../../types/network';
import { setBuildingActiveOpen } from './buildingActiveState';
import { getEntityTargetPoint } from './buildingAnchors';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import { getUnitBlueprint } from './blueprints';
import { DGUN_TERRAIN_FOLLOW_HEIGHT } from '../../config';
import { pushUnitAction, setUnitActions, shiftUnitAction, spliceUnitActions, unshiftUnitAction } from './unitActions';
import { dropTurretLockMidTick } from './combat/combatActivitySlab';
import { isAliveGuardTarget } from './guard';
import { isReclaimableTarget } from './reclaim';
import {
  ATTACK_AREA_MAX_RADIUS,
  REPAIR_AREA_MAX_RADIUS,
} from './commandLimits';
import {
  getActionIntentStart,
  getFirstActionIntentEnd,
  getLastActionIntentFinalIndex,
  getUnitActionTargetId,
} from './unitActionIntents';

const _dgunMount = { x: 0, y: 0, z: 0 };
function pathTerrainFilterForUnit(unit: Entity): PathTerrainFilter | null {
  return unit.unit === null
    ? null
    : pathTerrainFilterForLocomotion(unit.unit.locomotion);
}

function refreshPatrolStartIndex(unit: Unit): void {
  const index = unit.actions.findIndex((action) => action.type === 'patrol');
  unit.patrolStartIndex = index >= 0 ? index : null;
}

function resetFlyingLoiterToCurrentPosition(entity: Entity, world: WorldState): void {
  const unit = entity.unit;
  if (!unit || unit.locomotion.type !== 'flying') return;
  const x = Math.max(0, Math.min(world.mapWidth, entity.transform.x));
  const y = Math.max(0, Math.min(world.mapHeight, entity.transform.y));
  unit.flyingLoiterTargetX = x;
  unit.flyingLoiterTargetY = y;
  unit.flyingLoiterTargetZ = Number.isFinite(entity.transform.z)
    ? entity.transform.z
    : world.getGroundZ(x, y);
  unit.flyingLoiterTurnSign = null;
}

function getCommanderDGunTurretBlueprintId(commander: Entity): string | null {
  const unit = commander.unit;
  if (unit === null) return null;
  try {
    const dgun = getUnitBlueprint(unit.unitBlueprintId).dgun;
    return dgun !== null ? dgun.turretBlueprintId : null;
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
    case 'setRallyPoint':
      executeSetRallyPointCommand(ctx, command);
      break;
    case 'fireDGun':
      executeFireDGunCommand(ctx, command);
      break;
    case 'setFireEnabled':
      executeSetFireEnabledCommand(ctx, command);
      break;
    case 'setBuildingActive':
      executeSetBuildingActiveCommand(ctx, command);
      break;
    case 'selfDestruct':
      executeSelfDestructCommand(ctx, command);
      break;
    case 'setTowerTarget':
      executeSetTowerTargetCommand(ctx, command);
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
    turretBlueprintId: '',
    sourceType: 'system',
    sourceKey: 'ping',
    playerId: command.playerId,
    pos: { x, y, z },
  };
  if (ctx.onSimEvent !== null) ctx.onSimEvent(event);
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
    turretBlueprintId: '',
    sourceType: 'system',
    sourceKey: 'scan',
    playerId: command.playerId,
    pos: { x, y, z },
  };
  if (ctx.onSimEvent !== null) ctx.onSimEvent(event);
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
      addPathActions(unit, target.x, target.y, command.waypointType, command.queue, ctx, target.z ?? null);
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
        command.targetZ ?? null,
      );
      index++;
    }
  }
}

function executeStopCommand(ctx: CommandContext, command: StopCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined || entity.unit === null) continue;

    setUnitActions(entity.unit, []);
    entity.unit.patrolStartIndex = null;
    entity.unit.stuckTicks = 0;
    resetFlyingLoiterToCurrentPosition(entity, ctx.world);
    entity.unit.thrustDirX = 0;
    entity.unit.thrustDirY = 0;
    if (entity.builder) entity.builder.currentBuildTarget = NO_ENTITY_ID;
    if (entity.combat) {
      entity.combat.priorityTargetId = null;
      entity.combat.priorityTargetPoint = null;
      entity.combat.nextCombatProbeTick = -1;
    }
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

function clearBuilderTargetIfRemoved(entity: Entity, removedActions: readonly UnitAction[]): void {
  const builder = entity.builder;
  if (!builder || builder.currentBuildTarget === NO_ENTITY_ID) return;
  for (let i = 0; i < removedActions.length; i++) {
    if (getUnitActionTargetId(removedActions[i]) === builder.currentBuildTarget) {
      builder.currentBuildTarget = NO_ENTITY_ID;
      return;
    }
  }
}

function executeClearQueuedOrdersCommand(ctx: CommandContext, command: ClearQueuedOrdersCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const unit = entity !== undefined ? entity.unit : null;
    if (entity === undefined || unit === null) continue;

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
    const unit = entity !== undefined ? entity.unit : null;
    if (entity === undefined || unit === null) continue;

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
    if (entity === undefined || entity.unit === null) continue;
    units.push(entity);
    const firstAction = entity.unit.actions.length > 0 ? entity.unit.actions[0] : undefined;
    if (firstAction === undefined || firstAction.type !== 'wait') allWaiting = false;
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

    const firstAction = unit.actions.length > 0 ? unit.actions[0] : undefined;
    if (!command.queue && firstAction !== undefined && firstAction.type === 'wait') continue;
    const anchor = command.queue && unit.actions.length > 0
      ? unit.actions[unit.actions.length - 1]
      : undefined;
    const x = anchor !== undefined ? anchor.x : entity.transform.x;
    const y = anchor !== undefined ? anchor.y : entity.transform.y;
    const action: UnitAction = {
      type: 'wait',
      x,
      y,
      z: anchor !== undefined && anchor.z !== undefined ? anchor.z : ctx.world.getGroundZ(x, y),
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
  if (
    builder === undefined ||
    builder.builder === null ||
    builder.ownership === null ||
    builder.unit === null
  ) return;

  const playerId = builder.ownership.playerId;

  // Start the building (creates the ghost/under-construction building)
  const building = ctx.constructionSystem.startBuilding(
    ctx.world,
    command.buildingBlueprintId,
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
    buildingBlueprintId: command.buildingBlueprintId,
    gridX: command.gridX,
    gridY: command.gridY,
    buildingId: building.id,
  };

  addPathActionsWithFinal(builder, action, command.queue, ctx);
}

function executeQueueUnitCommand(ctx: CommandContext, command: QueueUnitCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null || factory.ownership === null) return;

  // Repeat-build: the selection persists even at unit cap so production
  // resumes automatically when an existing unit dies. Cap is enforced
  // at shell-spawn time inside the production loop.
  if (factoryProductionSystem.selectUnit(factory, command.unitBlueprintId, ctx.world)) {
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeSetRallyPointCommand(ctx: CommandContext, command: SetRallyPointCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null) return;

  factory.factory.rallyX = command.rallyX;
  factory.factory.rallyY = command.rallyY;
  factory.factory.rallyZ = command.rallyZ ?? null;
  factory.factory.rallyType = command.waypointType;
  ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
}

function executeFireDGunCommand(ctx: CommandContext, command: FireDGunCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  if (
    commander === undefined ||
    commander.commander === null ||
    commander.ownership === null ||
    commander.combat === null
  ) return;

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
  // should not know or duplicate the concrete turret blueprint id string.
  const turretDisruptorId = getCommanderDGunTurretBlueprintId(commander);
  if (!turretDisruptorId) return;
  const turrets = commander.combat.turrets;
  const dgunIdx = turrets.findIndex(w => w.config.turretBlueprintId === turretDisruptorId);
  if (dgunIdx < 0) return;
  const turretDisruptor = turrets[dgunIdx];

  // Spend energy
  economyManager.spendInstant(ctx.world, playerId, dgunCost, commander.id, null, 'ability');

  // Calculate direction to target
  const fireAngle = Math.atan2(dy, dx);

  // Snap dgun turret to target direction
  turretDisruptor.rotation = fireAngle;
  turretDisruptor.pitch = 0;
  turretDisruptor.angularVelocity = 0;
  turretDisruptor.angularAcceleration = 0;
  turretDisruptor.pitchVelocity = 0;
  turretDisruptor.pitchAcceleration = 0;
  ctx.world.markSnapshotDirty(commander.id, ENTITY_CHANGED_TURRETS);

  const { cos, sin } = getTransformCosSin(commander.transform);

  // Resolve the d-gun's turret mount center. Surface normal comes from
  // the unit ground normal EMA (updateUnitGroundNormal) so the slope-tilted
  // mount doesn't snap when the commander crosses a terrain triangle
  // edge.
  const mount = updateWeaponWorldKinematics(
    commander, turretDisruptor, dgunIdx,
    cos, sin,
    {
      currentTick: ctx.world.getTick(),
      dtMs: undefined,
      unitGroundZ: undefined,
      surfaceN: commander.unit !== null ? commander.unit.surfaceNormal : undefined,
    },
    _dgunMount,
  );
  const spawnX = mount.x;
  const spawnY = mount.y;
  const dgunFireZ = ctx.world.getGroundZ(spawnX, spawnY) + DGUN_TERRAIN_FOLLOW_HEIGHT;

  // D-gun is a terrain-following wave: it travels horizontally in the
  // commanded direction while vertical thrust rides the local terrain.
  // Keep horizontal mount-center inheritance so firing from a moving
  // commander still uses the turret's own motion, but never let
  // vertical mount velocity turn it into a ballistic shell.
  const dgunShot = turretDisruptor.config.shot;
  if (!dgunShot || dgunShot.type === 'forceField') {
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
    velocityX += turretDisruptor.worldVelocity.x;
    velocityY += turretDisruptor.worldVelocity.y;
  }

  // Create D-gun projectile
  const shotSource: ShotSource = {
    sourceTurretEntityId: turretDisruptor.id !== NO_ENTITY_ID ? turretDisruptor.id : null,
    sourceHostEntityId: commander.id,
    sourceRootEntityId: turretDisruptor.rootHostId !== NO_ENTITY_ID ? turretDisruptor.rootHostId : commander.id,
    sourcePlayerId: playerId,
    sourceTeamId: ctx.world.getTeamId(playerId),
    sourceTurretBlueprintId: turretDisruptor.config.turretBlueprintId,
    sourceShotBlueprintId: dgunShot.shotBlueprintId,
    spawnTick: ctx.world.getTick(),
    parentShotEntityId: null,
  };
  const projectile = ctx.world.createDGunProjectile(
    spawnX,
    spawnY,
    velocityX,
    velocityY,
    playerId,
    commander.id,
    turretDisruptor.config,
    { shotBlueprintId: dgunShot.shotBlueprintId, shotSource },
  );

  projectile.transform.z = dgunFireZ;
  const projectileComponent = projectile.projectile;
  if (projectileComponent !== null) {
    projectileComponent.velocityZ = velocityZ;
    projectileComponent.lastSentVelZ = velocityZ;
  }
  const maxLifespan = projectileComponent !== null ? projectileComponent.maxLifespan : undefined;

  ctx.world.addEntity(projectile);

  // Emit projectile spawn event for D-gun. Spawn XY comes from the
  // turret mount center; altitude remains terrain-following.
  ctx.pendingProjectileSpawns.push({
    id: projectile.id,
    pos: { x: spawnX, y: spawnY, z: dgunFireZ },
    rotation: fireAngle,
    velocity: { x: velocityX, y: velocityY, z: velocityZ },
    projectileType: 'projectile',
    maxLifespan: typeof maxLifespan === 'number' && Number.isFinite(maxLifespan)
      ? maxLifespan
      : undefined,
    turretBlueprintId: turretDisruptor.config.turretBlueprintId,
    shotBlueprintId: dgunShot.shotBlueprintId,
    sourceTurretBlueprintId: turretDisruptor.config.turretBlueprintId,
    sourceTurretEntityId: shotSource.sourceTurretEntityId ?? undefined,
    sourceHostEntityId: shotSource.sourceHostEntityId,
    sourceRootEntityId: shotSource.sourceRootEntityId,
    sourceTeamId: shotSource.sourceTeamId,
    spawnTick: shotSource.spawnTick,
    parentShotEntityId: shotSource.parentShotEntityId,
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
    turretBlueprintId: turretDisruptor.config.turretBlueprintId,
    playerId,
    entityId: commander.id,
  };
  if (ctx.onSimEvent !== null) ctx.onSimEvent(dgunSimEvent);
  ctx.pendingSimEvents.push(dgunSimEvent);
}

function executeSetFireEnabledCommand(ctx: CommandContext, command: SetFireEnabledCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const combat = entity !== undefined ? entity.combat : null;
    if (entity === undefined || combat === null) continue;

    const enabled = command.enabled === true;
    if (combat.fireEnabled === enabled) continue;
    combat.fireEnabled = enabled;
    if (!enabled) {
      combat.priorityTargetId = null;
      combat.priorityTargetPoint = null;
      combat.nextCombatProbeTick = -1;
      // Drop every turret's lock everywhere in one call per turret:
      // JS Turret target + state, beam inverse index, and the slab
      // FSM tuple. The previous version only touched the JS Turret
      // side, leaving the slab with stale (target, state) that
      // same-tick slab-first readers would still see.
      for (let wi = 0; wi < combat.turrets.length; wi++) {
        dropTurretLockMidTick(entity, wi);
      }
    }
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE | ENTITY_CHANGED_TURRETS);
  }
}

function executeSetBuildingActiveCommand(
  ctx: CommandContext,
  command: SetBuildingActiveCommand,
): void {
  const open = command.open === true;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined || entity.type !== 'building') continue;
    setBuildingActiveOpen(ctx.world, entity, open);
  }
}

function executeSetTowerTargetCommand(
  ctx: CommandContext,
  command: SetTowerTargetCommand,
): void {
  // Resolve the target entity once; null/-1 means "clear the lock".
  // The lock-on is only honored by host-directed turrets whose
  // exclusion policy accepts the candidate (see design_philosophy.html
  // "Host-directed turrets carry the host lock-on...").
  const target = command.targetId === null
    ? undefined
    : ctx.world.getEntity(command.targetId);
  // A valid lock target must exist and still be alive. Units carry hp on
  // the unit component; towers and buildings carry it on the building
  // component. Explicit guards (no optional chaining) so "no hp source"
  // is a deliberate reject rather than a silent 0.
  let resolvedTargetId: number | null = null;
  if (target !== undefined) {
    let targetHp = 0;
    if (target.unit !== null) targetHp = target.unit.hp;
    else if (target.building !== null) targetHp = target.building.hp;
    if (targetHp > 0) resolvedTargetId = target.id;
  }
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined || entity.type !== 'tower') continue;
    const combat = entity.combat;
    if (combat === null) continue;
    combat.priorityTargetId = resolvedTargetId;
    combat.priorityTargetPoint = null;
    combat.nextCombatProbeTick = -1;
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE);
  }
}

function executeSelfDestructCommand(ctx: CommandContext, command: SelfDestructCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined) continue;
    // Set hp to 0 and mark the row dirty on the HP field. The shared
    // pendingDeathCheck queue picks the row up in the next cleanup
    // pass, which emits the synthetic death event + removes the entity
    // through the same path normal damage takes.
    if (entity.unit !== null && entity.unit.hp > 0) {
      entity.unit.hp = 0;
      ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
    } else if (entity.building !== null && entity.building.hp > 0) {
      entity.building.hp = 0;
      ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_HP);
    }
  }
}

function executeRepairCommand(ctx: CommandContext, command: RepairCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  const target = ctx.world.getEntity(command.targetId);
  enqueueRepairAction(ctx, commander, target, command.queue);
}

function executeRepairAreaCommand(ctx: CommandContext, command: RepairAreaCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  if (
    commander === undefined ||
    commander.commander === null ||
    commander.unit === null ||
    commander.builder === null
  ) return;

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
  if (commander.ownership === null || target === undefined || target.ownership === null) return false;
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
  if (
    commander === undefined ||
    commander.commander === null ||
    commander.unit === null ||
    commander.builder === null
  ) return;
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
  if (
    commander === undefined ||
    commander.commander === null ||
    commander.unit === null ||
    commander.builder === null
  ) return;
  if (target !== undefined && commander.id === target.id) return;
  if (!isReclaimableTarget(target)) return;

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
  if (target === undefined || target.ownership === null) return;

  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined || entity.unit === null || entity.ownership === null) continue;
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
    if (entity !== undefined && entity.unit !== null && entity.ownership !== null) {
      return entity.ownership.playerId;
    }
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
    target.ownership !== null &&
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
export function addActionToUnit(
  entity: Entity,
  action: UnitAction,
  queue: boolean,
  world: WorldState | undefined = undefined,
): void {
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

  if (world !== undefined) {
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
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
  goalZ: number | null,
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
    const unitComponent = unit.unit;
    const beforeLen = unitComponent !== null ? unitComponent.actions.length : 0;
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
    const unitComponent = unit.unit;
    const afterLen = unitComponent !== null ? unitComponent.actions.length : 0;
    debugLog(true, '  [plan]   unit #%d actions.length now = %d', unit.id, afterLen);
  }
}

/** Plan a path to (goalX, goalY) and enqueue intermediate `move`
 *  waypoints + a single FINAL waypoint that carries the action-
 *  specific type and metadata (targetId / buildingBlueprintId / buildingId
 *  / etc). Used by attack / repair / build commands so the unit
 *  runs through the unit's movement filter to reach the action's
 *  target instead of writing a single bee-line action that walks
 *  terrain-bound units straight at the target's coordinates.
 *
 *  Why this matters: a `repair` / `attack` / `build` action whose
 *  (x, y) is across water made the unit press into the shoreline
 *  with the water-pusher catching them, while the visualized line
 *  cut straight across the valley — exactly the "paths over water"
 *  artifact the user reported. Routing through `expandPathActions`
 *  here makes the planner do its job for the unit's locomotion:
 *  ground profiles avoid water/buildings/mountains, while airborne
 *  profiles ignore terrain blocking and route over land or water.
 *  The visualized path matches what the unit actually walks or flies.
 *  The final waypoint inherits the original action's metadata so the
 *  per-action handler at the destination (attack the target, repair
 *  the target, build the building) still runs as before. */
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
    finalAction.z ?? null,
    pathTerrainFilterForUnit(unit),
  );
  if (actions.length === 0) return;
  // Promote the LAST waypoint to the original action's type and
  // copy its metadata across (targetId / buildingBlueprintId / buildingId
  // / gridX / gridY). The (x, y, z) on the last waypoint were
  // already set by the planner — when the goal was snapped to a
  // reachable cell, we use that cell's centre instead of the
  // target's own position so the unit stops on the dry-land
  // approach to the target rather than pushing into water.
  const last = actions[actions.length - 1];
  last.type = finalAction.type;
  if (finalAction.targetId !== undefined) last.targetId = finalAction.targetId;
  if (finalAction.buildingBlueprintId !== undefined) last.buildingBlueprintId = finalAction.buildingBlueprintId;
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
