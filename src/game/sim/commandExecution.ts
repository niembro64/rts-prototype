import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
// Command execution - extracted from Simulation.ts
// Handles all player command types (select, move, build, queue, rally, dgun, repair)

import type {
  AttackAreaCommand,
  AttackCommand,
  AttackGroundCommand,
  CaptureCommand,
  ChangeFactoryUnitQuotaCommand,
  ClearQueuedOrdersCommand,
  Command,
  EditFactoryQueueCommand,
  FireDGunCommand,
  GuardCommand,
  LoadTransportCommand,
  ManualLaunchCommand,
  MoveCommand,
  PingCommand,
  ScanCommand,
  QueueUnitCommand,
  ReclaimCommand,
  ReclaimAreaCommand,
  RepairAreaCommand,
  RepairCommand,
  RemoveFactoryUnitProductionCommand,
  RemoveLastQueuedOrderCommand,
  ResurrectAreaCommand,
  ResurrectCommand,
  SelectCommand,
  SkipCurrentOrderCommand,
  SetFireEnabledCommand,
  SetBuildingActiveCommand,
  SetBuilderPriorityCommand,
  SetCarrierSpawnCommand,
  SetCloakStateCommand,
  SetRepeatQueueCommand,
  SetFactoryRepeatProductionCommand,
  SetTrajectoryModeCommand,
  SetUnitMoveStateCommand,
  SelfDestructCommand,
  SetTowerTargetCommand,
  SetFactoryGuardCommand,
  SetRallyPointCommand,
  StartBuildCommand,
  StopFactoryProductionCommand,
  StopCommand,
  UpgradeMetalExtractorAreaCommand,
  UpgradeMetalExtractorCommand,
  UnloadTransportCommand,
  WaitCommand,
} from './commands';
import type { CombatFireState, Entity, EntityId, PlayerId, ShotSource, Unit, UnitAction } from './types';
import { NO_ENTITY_ID } from './types';
import { isProjectileShot } from './types';
import type { WorldState } from './WorldState';
import type { SimEvent } from './combat';
import { magnitude, getTransformCosSin } from '../math';
import {
  getHostShotArmingRadius,
  isBallisticArcWeapon,
  updateWeaponWorldKinematics,
} from './combat/combatUtils';
import { economyManager } from './economy';
import { factoryProductionSystem } from './factoryProduction';
import { factoryCanProduceUnit } from './factoryProductionRoster';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_COMBAT_MODE, ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_TURRETS } from '../../types/network';
import { setBuildingActiveOpen } from './buildingActiveState';
import { resetDisabledTurretJsOnlyFields } from './combat/combatActivity';
import { getEntityTargetPoint } from './buildingAnchors';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import { getUnitBlueprint } from './blueprints';
import { DGUN_TERRAIN_FOLLOW_HEIGHT } from '../../config';
import { setUnitGroundNormalEmaMode } from './unitGroundNormal';
import {
  insertUnitAction,
  pushUnitAction,
  setUnitActions,
  shiftUnitAction,
  spliceUnitActions,
  unshiftUnitAction,
} from './unitActions';
import { dropTurretLockMidTick } from './combat/combatActivitySlab';
import { isAliveGuardTarget } from './guard';
import { isReclaimableTarget } from './reclaim';

const MAX_FACTORY_PRODUCTION_QUOTA = 64;
import { isCapturableTarget } from './capture';
import { isResurrectableWreck } from './wrecks';
import { canLoadTransport, isTransportUnit } from './transports';
import { isBuildInProgress } from './buildableHelpers';
import {
  ATTACK_AREA_MAX_RADIUS,
  RECLAIM_AREA_MAX_RADIUS,
  REPAIR_AREA_MAX_RADIUS,
} from './commandLimits';
import {
  getActionIntentStart,
  getFirstActionIntentEnd,
  getLastActionIntentFinalIndex,
  getUnitActionTargetId,
} from './unitActionIntents';
import type { BuildingGrid } from './buildGrid';
import { expandPathPoints, pathTerrainFilterForLocomotion } from './Pathfinder';
import { canBuilderUpgradeMetalExtractor, isUpgradeableMetalExtractorTarget } from './metalExtractorUpgrade';
import {
  entityHasBarAreaAttackCommand,
  entityHasBarCaptureCommand,
  entityHasBarMoveStateCommand,
  entityHasBarSetTargetCommand,
  entityHasCloakCommand,
} from './unitCommandCapabilities';

const _dgunMount = { x: 0, y: 0, z: 0 };
const MIN_GROUP_FORMATION_SPACING = 40;
const COLLISION_GROUP_FORMATION_SPACING_MULTIPLIER = 2.25;

type ResolvedFormationTarget = {
  x: number;
  y: number;
  z: number;
};

type GroupFormationSlot = {
  unit: Entity;
  offsetX: number;
  offsetY: number;
};

function commandQueuesInFront(command: { queue: boolean; queueFront?: boolean }): boolean {
  return command.queue && command.queueFront === true;
}

function commandQueueInsertIndex(command: { queue: boolean; queueFront?: boolean; queueInsertIndex?: number }): number | undefined {
  if (!command.queue || command.queueFront === true) return undefined;
  return command.queueInsertIndex;
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
    case 'skipCurrentOrder':
      executeSkipCurrentOrderCommand(ctx, command);
      break;
    case 'setRepeatQueue':
      executeSetRepeatQueueCommand(ctx, command);
      break;
    case 'setBuilderPriority':
      executeSetBuilderPriorityCommand(ctx, command);
      break;
    case 'setCarrierSpawn':
      executeSetCarrierSpawnCommand(ctx, command);
      break;
    case 'setUnitMoveState':
      executeSetUnitMoveStateCommand(ctx, command);
      break;
    case 'setTrajectoryMode':
      executeSetTrajectoryModeCommand(ctx, command);
      break;
    case 'setCloakState':
      executeSetCloakStateCommand(ctx, command);
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
    case 'upgradeMetalExtractor':
      executeUpgradeMetalExtractorCommand(ctx, command);
      break;
    case 'upgradeMetalExtractorArea':
      executeUpgradeMetalExtractorAreaCommand(ctx, command);
      break;
    case 'queueUnit':
      executeQueueUnitCommand(ctx, command);
      break;
    case 'editFactoryQueue':
      executeEditFactoryQueueCommand(ctx, command);
      break;
    case 'removeFactoryUnitProduction':
      executeRemoveFactoryUnitProductionCommand(ctx, command);
      break;
    case 'stopFactoryProduction':
      executeStopFactoryProductionCommand(ctx, command);
      break;
    case 'setFactoryRepeatProduction':
      executeSetFactoryRepeatProductionCommand(ctx, command);
      break;
    case 'changeFactoryUnitQuota':
      executeChangeFactoryUnitQuotaCommand(ctx, command);
      break;
    case 'setRallyPoint':
      executeSetRallyPointCommand(ctx, command);
      break;
    case 'setFactoryGuard':
      executeSetFactoryGuardCommand(ctx, command);
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
    case 'reclaimArea':
      executeReclaimAreaCommand(ctx, command);
      break;
    case 'capture':
      executeCaptureCommand(ctx, command);
      break;
    case 'resurrect':
      executeResurrectCommand(ctx, command);
      break;
    case 'resurrectArea':
      executeResurrectAreaCommand(ctx, command);
      break;
    case 'loadTransport':
      executeLoadTransportCommand(ctx, command);
      break;
    case 'unloadTransport':
      executeUnloadTransportCommand(ctx, command);
      break;
    case 'attack':
      executeAttackCommand(ctx, command);
      break;
    case 'attackGround':
      executeAttackGroundCommand(ctx, command);
      break;
    case 'manualLaunch':
      executeManualLaunchCommand(ctx, command);
      break;
    case 'attackArea':
      executeAttackAreaCommand(ctx, command);
      break;
    case 'guard':
      executeGuardCommand(ctx, command);
      break;
    case 'setUnitGroundNormalEmaMode':
      setUnitGroundNormalEmaMode(command.mode);
      break;
    case 'setMaxTotalUnits':
      ctx.world.maxTotalUnits = command.maxTotalUnits;
      break;
    case 'setTurretShieldPanelsEnabled':
      executeSetTurretShieldPanelsEnabledCommand(ctx, command.enabled);
      break;
    case 'setTurretShieldSpheresEnabled':
      executeSetTurretShieldSpheresEnabledCommand(ctx, command.enabled);
      break;
    case 'setForceFieldsVisible':
      ctx.world.forceFieldsVisible = command.enabled;
      break;
    case 'setShieldsObstructSight':
      ctx.world.shieldsObstructSight = command.enabled;
      break;
    case 'setShieldReflectionMode':
      ctx.world.shieldReflectionMode = command.mode;
      break;
    case 'setFogOfWarEnabled':
      ctx.world.fogOfWarEnabled = command.enabled;
      break;
    case 'setSlopePathMode':
      if (ctx.world.slopePathMode !== command.mode) {
        ctx.world.slopePathMode = command.mode;
        // Reroute in-flight units under the new slope rule.
        ctx.world.invalidateAllActivePaths();
      }
      break;
    case 'setConverterTax':
      ctx.world.converterTax = command.tax;
      break;
    case 'setPaused':
    case 'setSendGridInfo':
    case 'setBackgroundUnitBlueprintEnabled':
    case 'setBackgroundBuildingBlueprintEnabled':
    case 'setBackgroundTowerBlueprintEnabled':
      break;
  }
}

function executeSetTurretShieldPanelsEnabledCommand(ctx: CommandContext, enabled: boolean): void {
  if (ctx.world.turretShieldPanelsEnabled === enabled) return;
  ctx.world.turretShieldPanelsEnabled = enabled;
  if (enabled) return;
  for (const unit of ctx.world.getShieldPanelUnits()) {
    const combat = unit.combat;
    if (!combat) continue;
    const turrets = combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (!turret.config.passive) continue;
      turret.target = null;
      turret.state = 'idle';
      resetDisabledTurretJsOnlyFields(turret);
    }
    ctx.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
  }
}

function executeSetTurretShieldSpheresEnabledCommand(ctx: CommandContext, enabled: boolean): void {
  if (ctx.world.turretShieldSpheresEnabled === enabled) return;
  ctx.world.turretShieldSpheresEnabled = enabled;
  if (enabled) return;
  for (const unit of ctx.world.getShieldUnits()) {
    const combat = unit.combat;
    if (!combat) continue;
    for (const turret of combat.turrets) {
      const shot = turret.config.shot;
      if (shot === null || shot.type !== 'shield') continue;
      turret.target = null;
      turret.state = 'idle';
      resetDisabledTurretJsOnlyFields(turret);
    }
    ctx.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
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

/** Scan duration in simulation ticks. At the deterministic-lockstep
 *  default step this is about a six-second sweep — long enough to see
 *  who's there, short enough that the player needs to commit a real
 *  probe (a scout, a radar) for sustained coverage. */
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
  const validUnits: Entity[] = [];
  let unitCount = 0;

  // First pass: count valid units to size the iteration
  for (let i = 0; i < entityIds.length; i++) {
    const e = ctx.world.getEntity(entityIds[i]);
    if (e !== undefined && e.type === 'unit' && e.unit !== null) {
      validUnits.push(e);
      unitCount++;
    }
  }

  if (unitCount === 0) return;
  const speedLimitFactors = command.formationSpeed === 'slowest' && unitCount > 1
    ? computeSlowestFormationSpeedFactors(ctx.world, entityIds)
    : null;

  // Handle individual targets (line move)
  if (command.individualTargets && command.individualTargets.length === entityIds.length) {
    const queueFront = commandQueuesInFront(command);
    const buildingGrid = ctx.constructionSystem.getGrid();
    for (let i = 0; i < entityIds.length; i++) {
      const unit = ctx.world.getEntity(entityIds[i]);
      if (!unit || unit.type !== 'unit' || !unit.unit) continue;
      const target = command.individualTargets[i];
      const resolvedTarget = resolvePathableFormationTarget(
        ctx.world,
        buildingGrid,
        unit,
        target.x,
        target.y,
      );
      addPathActions(
        unit,
        resolvedTarget.x,
        resolvedTarget.y,
        command.waypointType,
        command.queue,
        ctx,
        resolvedTarget.z,
        queueFront,
        commandQueueInsertIndex(command),
        speedLimitFactors?.get(unit.id),
      );
    }
  } else if (command.targetX !== undefined && command.targetY !== undefined) {
    // Group move with formation spreading
    const queueFront = commandQueuesInFront(command);
    const buildingGrid = ctx.constructionSystem.getGrid();
    const slots = buildMassAwareGroupFormationSlots(validUnits);

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const unit = slot.unit;
      const target = resolvePathableFormationTarget(
        ctx.world,
        buildingGrid,
        unit,
        command.targetX! + slot.offsetX,
        command.targetY! + slot.offsetY,
      );
      addPathActions(
        unit,
        target.x,
        target.y,
        command.waypointType,
        command.queue,
        ctx,
        target.z,
        queueFront,
        commandQueueInsertIndex(command),
        speedLimitFactors?.get(unit.id),
      );
    }
  }
}

function clampToMap(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, value));
}

export function resolvePathableFormationTarget(
  world: WorldState,
  buildingGrid: BuildingGrid,
  unit: Entity,
  targetX: number,
  targetY: number,
): ResolvedFormationTarget {
  const unitComponent = unit.unit;
  const x = clampToMap(targetX, world.mapWidth);
  const y = clampToMap(targetY, world.mapHeight);
  if (unitComponent === null) {
    return { x, y, z: world.getGroundZ(x, y) };
  }

  const points = expandPathPoints(
    unit.transform.x,
    unit.transform.y,
    x,
    y,
    world.mapWidth,
    world.mapHeight,
    buildingGrid,
    world.getGroundZ(x, y),
    pathTerrainFilterForLocomotion(unitComponent.locomotion, unitComponent.mass),
    unitComponent.radius.collision,
    world.slopePathMode === 'symmetric',
  );
  const final = points[points.length - 1];
  return final !== undefined
    ? { x: final.x, y: final.y, z: final.z ?? world.getGroundZ(final.x, final.y) }
    : { x, y, z: world.getGroundZ(x, y) };
}

function groupFormationSpacing(maxCollisionRadius: number): number {
  if (!Number.isFinite(maxCollisionRadius) || maxCollisionRadius <= 0) {
    return MIN_GROUP_FORMATION_SPACING;
  }
  return Math.max(
    MIN_GROUP_FORMATION_SPACING,
    maxCollisionRadius * COLLISION_GROUP_FORMATION_SPACING_MULTIPLIER,
  );
}

type FormationLayoutUnit = {
  unit: Entity;
  originalIndex: number;
  radius: number;
  mass: number;
  placementWeight: number;
};

type FormationGridCoord = {
  row: number;
  col: number;
  centerDistanceSq: number;
};

type FormationGridAssignment = FormationGridCoord & {
  layoutUnit: FormationLayoutUnit;
};

function formationUnitRadius(unit: Entity): number {
  const radius = unit.unit?.radius.collision;
  return Number.isFinite(radius) && radius !== undefined && radius > 0
    ? radius
    : MIN_GROUP_FORMATION_SPACING / COLLISION_GROUP_FORMATION_SPACING_MULTIPLIER;
}

function formationUnitMass(unit: Entity): number {
  const mass = unit.unit?.mass;
  return Number.isFinite(mass) && mass !== undefined && mass > 0 ? mass : 1;
}

function formationPlacementWeight(radius: number, mass: number): number {
  return radius * 4 + Math.log2(Math.max(1, mass) + 1);
}

function compareFormationUnits(a: FormationLayoutUnit, b: FormationLayoutUnit): number {
  if (b.placementWeight !== a.placementWeight) return b.placementWeight - a.placementWeight;
  if (b.radius !== a.radius) return b.radius - a.radius;
  if (b.mass !== a.mass) return b.mass - a.mass;
  return a.originalIndex - b.originalIndex;
}

function compareGridCoordsByCenter(a: FormationGridCoord, b: FormationGridCoord): number {
  if (a.centerDistanceSq !== b.centerDistanceSq) return a.centerDistanceSq - b.centerDistanceSq;
  if (a.row !== b.row) return a.row - b.row;
  return a.col - b.col;
}

function slotPositionsFromSpans(spans: readonly number[]): number[] {
  let total = 0;
  for (let i = 0; i < spans.length; i++) total += spans[i];
  const positions: number[] = new Array(spans.length);
  let cursor = -total / 2;
  for (let i = 0; i < spans.length; i++) {
    positions[i] = cursor + spans[i] / 2;
    cursor += spans[i];
  }
  return positions;
}

export function buildMassAwareGroupFormationSlots(units: readonly Entity[]): GroupFormationSlot[] {
  const unitCount = units.length;
  if (unitCount === 0) return [];

  const colCount = Math.ceil(DMath.sqrt(unitCount));
  const rowCount = Math.ceil(unitCount / colCount);
  const rowCenter = (rowCount - 1) / 2;
  const colCenter = (colCount - 1) / 2;

  const coords: FormationGridCoord[] = [];
  for (let index = 0; index < unitCount; index++) {
    const row = Math.floor(index / colCount);
    const col = index % colCount;
    const rowDelta = row - rowCenter;
    const colDelta = col - colCenter;
    coords.push({
      row,
      col,
      centerDistanceSq: rowDelta * rowDelta + colDelta * colDelta,
    });
  }
  coords.sort(compareGridCoordsByCenter);

  const layoutUnits = new Array<FormationLayoutUnit>(units.length);
  for (let originalIndex = 0; originalIndex < units.length; originalIndex++) {
    const unit = units[originalIndex];
    const radius = formationUnitRadius(unit);
    const mass = formationUnitMass(unit);
    layoutUnits[originalIndex] = {
      unit,
      originalIndex,
      radius,
      mass,
      placementWeight: formationPlacementWeight(radius, mass),
    };
  }
  layoutUnits.sort(compareFormationUnits);

  const assignments: FormationGridAssignment[] = [];
  const colSpans = new Array<number>(colCount).fill(MIN_GROUP_FORMATION_SPACING);
  const rowSpans = new Array<number>(rowCount).fill(MIN_GROUP_FORMATION_SPACING);
  for (let i = 0; i < layoutUnits.length; i++) {
    const coord = coords[i];
    if (coord === undefined) continue;
    const layoutUnit = layoutUnits[i];
    const spacing = groupFormationSpacing(layoutUnit.radius);
    colSpans[coord.col] = Math.max(colSpans[coord.col], spacing);
    rowSpans[coord.row] = Math.max(rowSpans[coord.row], spacing);
    assignments.push({ ...coord, layoutUnit });
  }

  const colPositions = slotPositionsFromSpans(colSpans);
  const rowPositions = slotPositionsFromSpans(rowSpans);
  const slots = new Array<GroupFormationSlot>(assignments.length);
  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i];
    slots[i] = {
      unit: assignment.layoutUnit.unit,
      offsetX: colPositions[assignment.col],
      offsetY: rowPositions[assignment.row],
    };
  }
  return slots;
}

function unitFormationAcceleration(entity: Entity): number {
  const unit = entity.unit;
  const locomotion = unit?.locomotion;
  if (unit === null || locomotion === undefined) return 0;
  const mass = Number.isFinite(unit.mass) && unit.mass > 0 ? unit.mass : 1;
  // Match the physics solver's relative behavior: bigger engines help,
  // but heavier bodies still accelerate more slowly for a given force.
  return (locomotion.driveForce * locomotion.traction) / mass;
}

function computeSlowestFormationSpeedFactors(
  world: WorldState,
  entityIds: readonly EntityId[],
): Map<EntityId, number> | null {
  let slowestAcceleration = Number.POSITIVE_INFINITY;
  for (let i = 0; i < entityIds.length; i++) {
    const entity = world.getEntity(entityIds[i]);
    if (entity === undefined || entity.type !== 'unit' || entity.unit === null) continue;
    const acceleration = unitFormationAcceleration(entity);
    if (
      Number.isFinite(acceleration) &&
      acceleration > 0 &&
      acceleration < slowestAcceleration
    ) {
      slowestAcceleration = acceleration;
    }
  }
  if (!Number.isFinite(slowestAcceleration) || slowestAcceleration <= 0) return null;

  let factors: Map<EntityId, number> | null = null;
  for (let i = 0; i < entityIds.length; i++) {
    const entity = world.getEntity(entityIds[i]);
    if (entity === undefined || entity.type !== 'unit' || entity.unit === null) continue;
    const acceleration = unitFormationAcceleration(entity);
    if (!Number.isFinite(acceleration) || acceleration <= slowestAcceleration) continue;
    const factor = slowestAcceleration / acceleration;
    if (factor >= 0.999) continue;
    if (factors === null) factors = new Map<EntityId, number>();
    factors.set(entity.id, factor);
  }
  return factors;
}

function executeStopCommand(ctx: CommandContext, command: StopCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined || entity.unit === null) continue;

    // Stop disarms a pending self-destruct (BAR: stop cancels self-d).
    if (ctx.world.armedSelfDestructs.delete(entity.id)) {
      emitSelfDestructEvent(ctx, entity, false);
    }

    setUnitActions(entity.unit, []);
    entity.unit.patrolStartIndex = null;
    entity.unit.stuckTicks = 0;
    resetFlyingLoiterToCurrentPosition(entity, ctx.world);
    entity.unit.thrustDirX = 0;
    entity.unit.thrustDirY = 0;
    entity.unit.headingDirX = 0;
    entity.unit.headingDirY = 0;
    if (entity.builder) entity.builder.currentBuildTarget = NO_ENTITY_ID;
    if (entity.combat) {
      entity.combat.priorityTargetId = null;
      entity.combat.priorityTargetPoint = null;
      entity.combat.manualLaunchActive = false;
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

function executeSkipCurrentOrderCommand(ctx: CommandContext, command: SkipCurrentOrderCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const unit = entity !== undefined ? entity.unit : null;
    if (entity === undefined || unit === null) continue;

    const activeIntentEnd = getFirstActionIntentEnd(unit.actions);
    if (activeIntentEnd < 0) continue;

    const removedActions = spliceUnitActions(unit, 0, activeIntentEnd + 1);
    clearBuilderTargetIfRemoved(entity, removedActions);
    refreshPatrolStartIndex(unit);
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

function executeSetRepeatQueueCommand(ctx: CommandContext, command: SetRepeatQueueCommand): void {
  const enabled = command.enabled === true;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const unit = entity !== undefined ? entity.unit : null;
    if (entity === undefined || unit === null) continue;
    if (unit.repeatQueue === enabled) continue;
    unit.repeatQueue = enabled;
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

function executeSetBuilderPriorityCommand(ctx: CommandContext, command: SetBuilderPriorityCommand): void {
  const lowPriority = command.lowPriority === true;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined) continue;
    if (entity.builder !== null && entity.builder.lowPriority !== lowPriority) {
      entity.builder.lowPriority = lowPriority;
      ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
    }
    if (entity.factory !== null && entity.factory.lowPriority !== lowPriority) {
      entity.factory.lowPriority = lowPriority;
      ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_FACTORY);
    }
  }
}

function executeSetCarrierSpawnCommand(ctx: CommandContext, command: SetCarrierSpawnCommand): void {
  const enabled = command.enabled === true;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined || entity.type !== 'unit' || entity.factory === null) continue;
    if (entity.factory.carrierSpawnEnabled === enabled) continue;
    entity.factory.carrierSpawnEnabled = enabled;
    if (!enabled && entity.factory.currentShellId === null) {
      entity.factory.isProducing = false;
      entity.factory.currentBuildProgress = 0;
    }
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeSetUnitMoveStateCommand(ctx: CommandContext, command: SetUnitMoveStateCommand): void {
  const moveState = command.moveState;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const unit = entity !== undefined ? entity.unit : null;
    if (entity === undefined || unit === null) continue;
    if (!entityHasBarMoveStateCommand(entity)) continue;
    if (unit.moveState === moveState) continue;
    unit.moveState = moveState;
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

function executeSetTrajectoryModeCommand(ctx: CommandContext, command: SetTrajectoryModeCommand): void {
  const trajectoryMode = command.trajectoryMode;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const combat = entity !== undefined ? entity.combat : null;
    if (entity === undefined || combat === null) continue;
    let hasBallisticWeapon = false;
    for (let wi = 0; wi < combat.turrets.length; wi++) {
      if (isBallisticArcWeapon(combat.turrets[wi])) {
        hasBallisticWeapon = true;
        break;
      }
    }
    if (!hasBallisticWeapon || combat.trajectoryMode === trajectoryMode) continue;
    combat.trajectoryMode = trajectoryMode;
    combat.nextCombatProbeTick = -1;
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE | ENTITY_CHANGED_TURRETS);
  }
}

function executeSetCloakStateCommand(ctx: CommandContext, command: SetCloakStateCommand): void {
  const enabled = command.enabled === true;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const unit = entity !== undefined ? entity.unit : null;
    if (entity === undefined || unit === null) continue;
    if (!entityHasCloakCommand(entity)) continue;

    if (enabled) {
      if (unit.cloakRestoreFireState === null) {
        unit.cloakRestoreFireState = entity.combat?.fireState ?? 'holdFire';
      }
      const cloakStateChanged = unit.wantCloak !== true || unit.cloaked !== true;
      unit.wantCloak = true;
      unit.cloaked = true;
      applyCombatFireState(ctx, entity, 'holdFire');
      if (cloakStateChanged) {
        ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE | ENTITY_CHANGED_ACTIONS);
      }
      continue;
    }

    if (unit.wantCloak !== true && unit.cloaked !== true && unit.cloakRestoreFireState === null) continue;
    const restoreFireState = unit.cloakRestoreFireState ?? 'holdFire';
    unit.wantCloak = false;
    unit.cloaked = false;
    unit.cloakRestoreFireState = null;
    applyCombatFireState(ctx, entity, restoreFireState);
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE | ENTITY_CHANGED_ACTIONS);
  }
}

function resolveGatherWaitGroupId(command: WaitCommand): number {
  const provided = command.waitGroupId;
  if (
    typeof provided === 'number' &&
    Number.isInteger(provided) &&
    provided >= 0 &&
    provided <= 0x7FFF_FFFF
  ) {
    return provided;
  }
  let hash = Math.imul(command.tick | 0, 0x45D9F3B) >>> 0;
  for (let i = 0; i < command.entityIds.length; i++) {
    hash = Math.imul(hash ^ command.entityIds[i], 0x01000193) >>> 0;
  }
  hash = Math.imul(hash ^ (command.queue ? 0x9E3779B1 : 0), 0x01000193) >>> 0;
  hash = Math.imul(hash ^ (command.queueFront ? 0x85EBCA6B : 0), 0x01000193) >>> 0;
  hash = Math.imul(hash ^ (command.queueInsertIndex ?? 0), 0x01000193) >>> 0;
  return hash & 0x7FFF_FFFF;
}

function executeWaitCommand(ctx: CommandContext, command: WaitCommand): void {
  const units: Entity[] = [];
  let allWaiting = true;
  const gatherWait = command.gather === true;
  const waitGroupId = gatherWait ? resolveGatherWaitGroupId(command) : undefined;

  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined || entity.unit === null) continue;
    units.push(entity);
    const firstAction = entity.unit.actions.length > 0 ? entity.unit.actions[0] : undefined;
    if (firstAction === undefined || firstAction.type !== 'wait') allWaiting = false;
  }
  if (units.length === 0) return;

  const releaseCurrentWait = !command.queue && allWaiting;
  const queueFront = commandQueuesInFront(command);
  const queueInsertIndex = commandQueueInsertIndex(command);
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
    if (gatherWait) {
      action.waitGather = true;
      action.waitGroupId = waitGroupId;
    }

    if (command.queue) {
      addQueuedActionToUnit(unit, action, queueFront, queueInsertIndex);
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
    command.builderId,
    command.rotation ?? 0,
  );

  if (!building) {
    // Placement failed (invalid location)
    return;
  }

  enqueueBuildActionForBuilding(
    ctx,
    builder,
    building,
    command.buildingBlueprintId,
    command.gridX,
    command.gridY,
    command.queue,
    commandQueuesInFront(command),
    commandQueueInsertIndex(command),
  );
}

function executeUpgradeMetalExtractorCommand(
  ctx: CommandContext,
  command: UpgradeMetalExtractorCommand,
): void {
  const builder = ctx.world.getEntity(command.builderId);
  if (
    builder === undefined ||
    builder.builder === null ||
    builder.ownership === null ||
    builder.unit === null ||
    !canBuilderUpgradeMetalExtractor(builder)
  ) return;
  const playerId = builder.ownership.playerId;
  if (!isUpgradeableMetalExtractorTarget(ctx.world.getEntity(command.targetId), playerId)) return;

  const building = ctx.constructionSystem.startMetalExtractorUpgrade(
    ctx.world,
    command.targetId,
    playerId,
    command.builderId,
  );
  if (!building || building.buildingBlueprintId === null) return;
  const grid = ctx.constructionSystem.getBuildingGridPosition(building);
  if (grid === null) return;
  enqueueBuildActionForBuilding(
    ctx,
    builder,
    building,
    building.buildingBlueprintId,
    grid.gridX,
    grid.gridY,
    command.queue,
    commandQueuesInFront(command),
    commandQueueInsertIndex(command),
  );
}

function executeUpgradeMetalExtractorAreaCommand(
  ctx: CommandContext,
  command: UpgradeMetalExtractorAreaCommand,
): void {
  const builders: Entity[] = [];
  const playerIdByBuilderId = new Map<EntityId, PlayerId>();
  for (let i = 0; i < command.builderIds.length; i++) {
    const builder = ctx.world.getEntity(command.builderIds[i]);
    if (
      builder === undefined ||
      builder.builder === null ||
      builder.ownership === null ||
      builder.unit === null ||
      !canBuilderUpgradeMetalExtractor(builder)
    ) continue;
    builders.push(builder);
    playerIdByBuilderId.set(builder.id, builder.ownership.playerId);
  }
  if (builders.length === 0) return;
  const playerId = builders[0].ownership?.playerId;
  if (playerId === undefined) return;
  const targets = findMetalExtractorUpgradeTargetsInArea(
    ctx,
    playerId,
    command.targetX,
    command.targetY,
    command.radius,
  );
  if (targets.length === 0) return;

  const perBuilderCounts = new Map<EntityId, number>();
  for (let i = 0; i < targets.length; i++) {
    const builder = builders[i % builders.length];
    if (playerIdByBuilderId.get(builder.id) !== playerId) continue;
    const assignedCount = perBuilderCounts.get(builder.id) ?? 0;
    perBuilderCounts.set(builder.id, assignedCount + 1);
    const queue = assignedCount === 0 ? command.queue : true;
    const queueFront = assignedCount === 0 ? commandQueuesInFront(command) : false;
    const queueInsertIndex = commandQueueInsertIndex(command);
    const building = ctx.constructionSystem.startMetalExtractorUpgrade(
      ctx.world,
      targets[i].id,
      playerId,
      builder.id,
    );
    if (!building || building.buildingBlueprintId === null) continue;
    const grid = ctx.constructionSystem.getBuildingGridPosition(building);
    if (grid === null) continue;
    enqueueBuildActionForBuilding(
      ctx,
      builder,
      building,
      building.buildingBlueprintId,
      grid.gridX,
      grid.gridY,
      queue,
      queueFront,
      queueInsertIndex !== undefined ? queueInsertIndex + assignedCount : undefined,
    );
  }
}

function enqueueBuildActionForBuilding(
  ctx: CommandContext,
  builder: Entity,
  building: Entity,
  buildingBlueprintId: Entity['buildingBlueprintId'],
  gridX: number,
  gridY: number,
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex: number | undefined,
): void {
  if (buildingBlueprintId === null) return;
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
    buildingBlueprintId,
    gridX,
    gridY,
    buildingId: building.id,
  };
  addPathActionsWithFinal(
    builder,
    action,
    queue,
    ctx,
    queueFront,
    queueInsertIndex,
  );
}

function findMetalExtractorUpgradeTargetsInArea(
  ctx: CommandContext,
  playerId: PlayerId,
  x: number,
  y: number,
  radius: number,
): Entity[] {
  const radiusSq = Math.max(1, radius) * Math.max(1, radius);
  const targets: Entity[] = [];
  const buildings = ctx.world.getBuildingsByPlayer(playerId);
  for (let i = 0; i < buildings.length; i++) {
    const building = buildings[i];
    if (!isUpgradeableMetalExtractorTarget(building, playerId)) continue;
    const dx = building.transform.x - x;
    const dy = building.transform.y - y;
    if (dx * dx + dy * dy > radiusSq) continue;
    targets.push(building);
  }
  targets.sort((a, b) => {
    const adx = a.transform.x - x;
    const ady = a.transform.y - y;
    const bdx = b.transform.x - x;
    const bdy = b.transform.y - y;
    const distanceDelta = (adx * adx + ady * ady) - (bdx * bdx + bdy * bdy);
    return distanceDelta !== 0 ? distanceDelta : a.id - b.id;
  });
  return targets;
}

function executeQueueUnitCommand(ctx: CommandContext, command: QueueUnitCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null || factory.ownership === null) return;
  if (!factoryCanProduceUnit(factory, command.unitBlueprintId)) return;

  // Repeat-build selections persist even at unit cap so production resumes
  // automatically when an existing unit dies. One-shot selections clear after
  // the active shell completes. Cap is enforced at shell-spawn time inside the
  // production loop.
  if (factoryProductionSystem.selectUnit(
    factory,
    command.unitBlueprintId,
    ctx.world,
    command.repeat !== false,
    command.count ?? 1,
  )) {
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeEditFactoryQueueCommand(ctx: CommandContext, command: EditFactoryQueueCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null || factory.ownership === null) return;

  if (factoryProductionSystem.editQueue(
    factory,
    command.operation,
    command.index,
    command.length ?? 1,
    command.toIndex,
    command.count,
  )) {
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeRemoveFactoryUnitProductionCommand(
  ctx: CommandContext,
  command: RemoveFactoryUnitProductionCommand,
): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null || factory.ownership === null) return;

  if (factoryProductionSystem.removeUnitProduction(
    factory,
    ctx.world,
    command.unitBlueprintId,
    command.count ?? 1,
  )) {
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeStopFactoryProductionCommand(ctx: CommandContext, command: StopFactoryProductionCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null || factory.ownership === null) return;

  if (factoryProductionSystem.stopProduction(factory, ctx.world)) {
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
  }
}

function executeSetFactoryRepeatProductionCommand(
  ctx: CommandContext,
  command: SetFactoryRepeatProductionCommand,
): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null || factory.ownership === null) return;
  const enabled = command.enabled === true;
  if (factory.factory.repeatProduction === enabled) return;
  factory.factory.repeatProduction = enabled;
  ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
}

function executeChangeFactoryUnitQuotaCommand(ctx: CommandContext, command: ChangeFactoryUnitQuotaCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null || factory.ownership === null) return;
  if (!factoryCanProduceUnit(factory, command.unitBlueprintId)) return;
  const quotas = factory.factory.productionQuotas;
  const current = Math.max(0, Math.floor(quotas[command.unitBlueprintId] ?? 0));
  const next = Math.max(0, Math.min(MAX_FACTORY_PRODUCTION_QUOTA, current + command.delta));
  if (next === current) return;
  if (next === 0) delete quotas[command.unitBlueprintId];
  else quotas[command.unitBlueprintId] = next;
  ctx.world.syncFactoryProductionQuotaCounts(factory);
  ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
}

function executeSetRallyPointCommand(ctx: CommandContext, command: SetRallyPointCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null) return;

  factory.factory.guardTargetId = null;
  factory.factory.rallyX = command.rallyX;
  factory.factory.rallyY = command.rallyY;
  factory.factory.rallyZ = command.rallyZ ?? null;
  factory.factory.rallyType = command.waypointType;
  factory.factory.defaultWaypoints = null;
  ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
}

function executeSetFactoryGuardCommand(ctx: CommandContext, command: SetFactoryGuardCommand): void {
  const factory = ctx.world.getEntity(command.factoryId);
  if (factory === undefined || factory.factory === null || factory.ownership === null) return;

  if (command.targetId === null) {
    factory.factory.guardTargetId = null;
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
    return;
  }

  const target = ctx.world.getEntity(command.targetId);
  if (
    target === undefined ||
    target.ownership === null ||
    factory.ownership.playerId !== target.ownership.playerId
  ) return;

  if (target.id === factory.id) {
    factory.factory.guardTargetId = factory.id;
    ctx.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
    return;
  }

  const targetPoint = getEntityTargetPoint(target);
  factory.factory.guardTargetId = target.id;
  factory.factory.defaultWaypoints = null;
  factory.factory.rallyX = targetPoint.x;
  factory.factory.rallyY = targetPoint.y;
  factory.factory.rallyZ = targetPoint.z;
  factory.factory.rallyType = 'move';
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
  const fireAngle = DMath.atan2(dy, dx);

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
  // Authored turret velocity inheritance applies horizontally only:
  // vertical mount velocity must not turn it into a ballistic shell.
  const dgunShot = turretDisruptor.config.shot;
  if (!dgunShot || !isProjectileShot(dgunShot)) {
    throw new Error('D-gun turret must use a projectile shot');
  }
  const speed = Number.isFinite(dgunShot.mass) && dgunShot.mass > 1e-6
    ? turretDisruptor.config.launchForce / dgunShot.mass
    : 0;
  let velocityX = DMath.cos(turretDisruptor.rotation) * speed;
  let velocityY = DMath.sin(turretDisruptor.rotation) * speed;
  let velocityZ = 0;
  if (commander.unit && turretDisruptor.config.addTurretVelocityToEmissionLaunch) {
    // Manual D-gun shots update the same turret kinematics cache used
    // by automated weapons above, so inherited horizontal velocity is
    // the turret mount center's own motion.
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
    {
      shotBlueprintId: dgunShot.shotBlueprintId,
      shotSource,
      shotArmingRadius: getHostShotArmingRadius(commander),
    },
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
  // turret origin; altitude remains terrain-following.
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
    homingTurnRate: dgunShot.homingTurnRate ?? undefined,
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
  const fireState: CombatFireState = command.fireState ??
    (command.enabled === false ? 'holdFire' : 'fireAtWill');
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined) continue;
    applyCombatFireState(ctx, entity, fireState);
  }
}

function applyCombatFireState(ctx: CommandContext, entity: Entity, fireState: CombatFireState): boolean {
  const combat = entity.combat;
  if (combat === null) return false;

  const enabled = fireState !== 'holdFire';
  const stateChanged = combat.fireState !== fireState || combat.fireEnabled !== enabled;
  if (stateChanged) {
    combat.fireState = fireState;
    combat.fireEnabled = enabled;
  }
  if (fireState === 'holdFire') {
    combat.priorityTargetId = null;
    combat.priorityTargetPoint = null;
    combat.manualLaunchActive = false;
    combat.nextCombatProbeTick = -1;
    clearHoldFireAttackActions(ctx, entity);
    // Drop every turret's lock everywhere in one call per turret:
    // JS Turret target + state, beam inverse index, and the slab
    // FSM tuple. The previous version only touched the JS Turret
    // side, leaving the slab with stale (target, state) that
    // same-tick slab-first readers would still see.
    for (let wi = 0; wi < combat.turrets.length; wi++) {
      dropTurretLockMidTick(entity, wi);
    }
  } else if (stateChanged) {
    combat.nextCombatProbeTick = -1;
  } else {
    return false;
  }
  ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE | ENTITY_CHANGED_TURRETS);
  return true;
}

function clearHoldFireAttackActions(ctx: CommandContext, entity: Entity): void {
  const unit = entity.unit;
  if (unit === null || unit.actions.length === 0) return;
  let removed = false;
  const keptActions: UnitAction[] = [];
  for (let i = 0; i < unit.actions.length; i++) {
    const action = unit.actions[i];
    if (action.type === 'attack' || action.type === 'attackGround') {
      removed = true;
      continue;
    }
    keptActions.push(action);
  }
  if (!removed) return;
  setUnitActions(unit, keptActions);
  refreshPatrolStartIndex(unit);
  ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
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
  // Resolve the target once. Entity targets go through the normal target
  // validation; ground targets store a point directly on the combat host.
  // The lock-on is honored by host-directed turrets whose exclusion policy
  // accepts the candidate (see budget_design_philosophy.html
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
  const targetX = command.targetX;
  const targetY = command.targetY;
  const targetZ = command.targetZ;
  const resolvedTargetPoint = command.targetId === null &&
    typeof targetX === 'number' &&
    typeof targetY === 'number' &&
    typeof targetZ === 'number' &&
    Number.isFinite(targetX) &&
    Number.isFinite(targetY) &&
    Number.isFinite(targetZ)
    ? { x: targetX, y: targetY, z: targetZ }
    : null;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined) continue;
    const combat = entity.combat;
    if (combat === null || !entityHasBarSetTargetCommand(entity)) continue;
    combat.priorityTargetId = resolvedTargetId;
    combat.priorityTargetPoint = resolvedTargetPoint === null
      ? null
      : { x: resolvedTargetPoint.x, y: resolvedTargetPoint.y, z: resolvedTargetPoint.z };
    combat.manualLaunchActive = false;
    combat.nextCombatProbeTick = -1;
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE);
  }
}

/** BAR-style self-destruct countdown, in simulation ticks (~5s at the
 *  lockstep 30 Hz step). The blast itself still goes through the
 *  normal zero-hp death path (Simulation.fireDueSelfDestructs) when
 *  the countdown expires. */
export const SELF_DESTRUCT_COUNTDOWN_TICKS = 150;

function emitSelfDestructEvent(ctx: CommandContext, entity: Entity, armed: boolean): void {
  const event: SimEvent = {
    type: armed ? 'selfDestructArmed' : 'selfDestructDisarmed',
    turretBlueprintId: '',
    sourceType: 'system',
    sourceKey: 'selfDestruct',
    playerId: entity.ownership !== null ? entity.ownership.playerId : undefined,
    entityId: entity.id,
    pos: {
      x: entity.transform.x,
      y: entity.transform.y,
      z: entity.transform.z,
    },
  };
  if (ctx.onSimEvent !== null) ctx.onSimEvent(event);
  ctx.pendingSimEvents.push(event);
}

function executeSelfDestructCommand(ctx: CommandContext, command: SelfDestructCommand): void {
  const armed = ctx.world.armedSelfDestructs;
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined) continue;
    const alive =
      (entity.unit !== null && entity.unit.hp > 0) ||
      (entity.building !== null && entity.building.hp > 0);
    if (!alive) {
      armed.delete(entity.id);
      continue;
    }
    // BAR semantics: self-destruct arms a visible countdown instead of
    // detonating instantly; issuing it again (or Stop, for units)
    // cancels. The zero-hp detonation happens in Simulation's per-tick
    // pass once the countdown expires.
    if (armed.has(entity.id)) {
      armed.delete(entity.id);
      emitSelfDestructEvent(ctx, entity, false);
    } else {
      armed.set(entity.id, ctx.world.getTick() + SELF_DESTRUCT_COUNTDOWN_TICKS);
      emitSelfDestructEvent(ctx, entity, true);
    }
  }
}

function executeRepairCommand(ctx: CommandContext, command: RepairCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  const target = ctx.world.getEntity(command.targetId);
  enqueueRepairAction(ctx, commander, target, command.queue, commandQueuesInFront(command), commandQueueInsertIndex(command));
}

function executeRepairAreaCommand(ctx: CommandContext, command: RepairAreaCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  if (
    commander === undefined ||
    commander.unit === null ||
    commander.builder === null
  ) return;

  const radius = clampRepairAreaRadius(command.radius);
  const targets = findRepairAreaTargets(
    ctx,
    commander,
    command.targetX,
    command.targetY,
    radius,
  );
  enqueueAreaTargetActionsInOrder(
    targets,
    command.queue,
    commandQueuesInFront(command),
    commandQueueInsertIndex(command),
    (target, queue, queueFront, queueInsertIndex) => enqueueRepairAction(ctx, commander, target, queue, queueFront, queueInsertIndex),
  );
}

function executeReclaimCommand(ctx: CommandContext, command: ReclaimCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  const target = ctx.world.getEntity(command.targetId);
  enqueueReclaimAction(ctx, commander, target, command.queue, commandQueuesInFront(command), commandQueueInsertIndex(command));
}

function executeReclaimAreaCommand(ctx: CommandContext, command: ReclaimAreaCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  if (
    commander === undefined ||
    commander.commander === null ||
    commander.unit === null ||
    commander.builder === null
  ) return;

  const radius = clampReclaimAreaRadius(command.radius);
  const targets = findReclaimAreaTargets(
    ctx,
    commander,
    command.targetX,
    command.targetY,
    radius,
  );
  enqueueAreaTargetActionsInOrder(
    targets,
    command.queue,
    commandQueuesInFront(command),
    commandQueueInsertIndex(command),
    (target, queue, queueFront, queueInsertIndex) => enqueueReclaimAction(ctx, commander, target, queue, queueFront, queueInsertIndex),
  );
}

function executeResurrectCommand(ctx: CommandContext, command: ResurrectCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  const target = ctx.world.getEntity(command.targetId);
  enqueueResurrectAction(ctx, commander, target, command.queue, commandQueuesInFront(command), commandQueueInsertIndex(command));
}

function executeResurrectAreaCommand(ctx: CommandContext, command: ResurrectAreaCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  if (
    commander === undefined ||
    commander.commander === null ||
    commander.unit === null ||
    commander.builder === null
  ) return;

  const radius = clampRepairAreaRadius(command.radius);
  const targets = findResurrectAreaTargets(
    ctx,
    command.targetX,
    command.targetY,
    radius,
  );
  enqueueAreaTargetActionsInOrder(
    targets,
    command.queue,
    commandQueuesInFront(command),
    commandQueueInsertIndex(command),
    (target, queue, queueFront, queueInsertIndex) => enqueueResurrectAction(ctx, commander, target, queue, queueFront, queueInsertIndex),
  );
}

function executeLoadTransportCommand(ctx: CommandContext, command: LoadTransportCommand): void {
  const transport = ctx.world.getEntity(command.transportId);
  const target = ctx.world.getEntity(command.targetId);
  if (transport === undefined || target === undefined || !canLoadTransport(transport, target)) return;
  const targetPoint = getEntityTargetPoint(target);
  const action: UnitAction = {
    type: 'loadTransport',
    x: targetPoint.x,
    y: targetPoint.y,
    z: targetPoint.z,
    targetId: target.id,
  };
  addPathActionsWithFinal(
    transport,
    action,
    command.queue,
    ctx,
    commandQueuesInFront(command),
    commandQueueInsertIndex(command),
  );
}

function executeUnloadTransportCommand(ctx: CommandContext, command: UnloadTransportCommand): void {
  const queueFront = commandQueuesInFront(command);
  const queueInsertIndex = commandQueueInsertIndex(command);
  const targetX = clampToMap(command.targetX, ctx.world.mapWidth);
  const targetY = clampToMap(command.targetY, ctx.world.mapHeight);
  const action: UnitAction = {
    type: 'unloadTransport',
    x: targetX,
    y: targetY,
    z: command.targetZ ?? ctx.world.getGroundZ(targetX, targetY),
  };

  for (let i = 0; i < command.transportIds.length; i++) {
    const transport = ctx.world.getEntity(command.transportIds[i]);
    if (!isTransportUnit(transport)) continue;
    addPathActionsWithFinal(
      transport,
      action,
      command.queue,
      ctx,
      queueFront,
      queueInsertIndex,
    );
  }
}

function clampRepairAreaRadius(radius: number): number {
  if (!Number.isFinite(radius)) return REPAIR_AREA_MAX_RADIUS;
  return Math.max(1, Math.min(radius, REPAIR_AREA_MAX_RADIUS));
}

function clampReclaimAreaRadius(radius: number): number {
  if (!Number.isFinite(radius)) return RECLAIM_AREA_MAX_RADIUS;
  return Math.max(1, Math.min(radius, RECLAIM_AREA_MAX_RADIUS));
}

function isRepairableByCommander(commander: Entity, target: Entity | undefined): target is Entity {
  if (commander.ownership === null || target === undefined || target.ownership === null) return false;
  if (target.ownership.playerId !== commander.ownership.playerId) return false;

  const isIncompleteBuilding = isBuildInProgress(target.buildable);
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

type AreaTarget = {
  entity: Entity;
  distanceSq: number;
};

function compareAreaTargets(a: AreaTarget, b: AreaTarget): number {
  return a.distanceSq - b.distanceSq || a.entity.id - b.entity.id;
}

function enqueueAreaTargetActionsInOrder(
  targets: readonly Entity[],
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex: number | undefined,
  enqueue: (target: Entity, queue: boolean, queueFront: boolean, queueInsertIndex?: number) => void,
): void {
  if (targets.length === 0) return;
  if (queueFront) {
    for (let i = targets.length - 1; i >= 0; i--) {
      enqueue(targets[i], true, true);
    }
    return;
  }
  for (let i = 0; i < targets.length; i++) {
    enqueue(
      targets[i],
      queue || i > 0,
      false,
      queueInsertIndex !== undefined ? queueInsertIndex + i : undefined,
    );
  }
}

function findRepairAreaTargets(
  ctx: CommandContext,
  commander: Entity,
  x: number,
  y: number,
  radius: number,
): Entity[] {
  const radiusSq = radius * radius;
  const targets: AreaTarget[] = [];

  const buildings = ctx.world.getBuildings();
  for (let i = 0; i < buildings.length; i++) {
    const target = buildings[i];
    if (!isRepairableByCommander(commander, target)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq) continue;
    targets.push({ entity: target, distanceSq: distSq });
  }

  const units = ctx.world.getUnits();
  for (let i = 0; i < units.length; i++) {
    const target = units[i];
    if (!isRepairableByCommander(commander, target)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq) continue;
    targets.push({ entity: target, distanceSq: distSq });
  }

  targets.sort(compareAreaTargets);
  return sortedAreaTargetEntities(targets);
}

function findReclaimAreaTargets(
  ctx: CommandContext,
  commander: Entity,
  x: number,
  y: number,
  radius: number,
): Entity[] {
  const radiusSq = radius * radius;
  const targets: AreaTarget[] = [];

  const buildings = ctx.world.getBuildings();
  for (let i = 0; i < buildings.length; i++) {
    const target = buildings[i];
    if (target.id === commander.id || !isReclaimableTarget(target)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq) continue;
    targets.push({ entity: target, distanceSq: distSq });
  }

  const units = ctx.world.getUnits();
  for (let i = 0; i < units.length; i++) {
    const target = units[i];
    if (target.id === commander.id || !isReclaimableTarget(target)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq) continue;
    targets.push({ entity: target, distanceSq: distSq });
  }

  targets.sort(compareAreaTargets);
  return sortedAreaTargetEntities(targets);
}

function findResurrectAreaTargets(
  ctx: CommandContext,
  x: number,
  y: number,
  radius: number,
): Entity[] {
  const radiusSq = radius * radius;
  const targets: AreaTarget[] = [];

  const buildings = ctx.world.getBuildings();
  for (let i = 0; i < buildings.length; i++) {
    const target = buildings[i];
    if (!isResurrectableWreck(target)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq) continue;
    targets.push({ entity: target, distanceSq: distSq });
  }

  targets.sort(compareAreaTargets);
  return sortedAreaTargetEntities(targets);
}

function sortedAreaTargetEntities(targets: readonly AreaTarget[]): Entity[] {
  const entities = new Array<Entity>(targets.length);
  for (let i = 0; i < targets.length; i++) entities[i] = targets[i].entity;
  return entities;
}

function enqueueRepairAction(
  ctx: CommandContext,
  commander: Entity | undefined,
  target: Entity | undefined,
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex?: number,
): void {
  if (
    commander === undefined ||
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

  addPathActionsWithFinal(commander, action, queue, ctx, queueFront, queueInsertIndex);
}

function enqueueReclaimAction(
  ctx: CommandContext,
  commander: Entity | undefined,
  target: Entity | undefined,
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex?: number,
): void {
  // Any builder can reclaim (BAR: reclaim is a default constructor capability),
  // not just commanders.
  if (
    commander === undefined ||
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

  addPathActionsWithFinal(commander, action, queue, ctx, queueFront, queueInsertIndex);
}

function enqueueResurrectAction(
  ctx: CommandContext,
  commander: Entity | undefined,
  target: Entity | undefined,
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex?: number,
): void {
  if (
    commander === undefined ||
    commander.commander === null ||
    commander.unit === null ||
    commander.builder === null
  ) return;
  if (!isResurrectableWreck(target)) return;

  const targetPoint = getEntityTargetPoint(target);
  const action: UnitAction = {
    type: 'resurrect',
    x: targetPoint.x,
    y: targetPoint.y,
    z: targetPoint.z,
    targetId: target.id,
  };

  addPathActionsWithFinal(commander, action, queue, ctx, queueFront, queueInsertIndex);
}

function enqueueCaptureAction(
  ctx: CommandContext,
  commander: Entity | undefined,
  target: Entity | undefined,
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex?: number,
): void {
  if (
    commander === undefined ||
    commander.commander === null ||
    commander.unit === null ||
    commander.builder === null ||
    commander.ownership === null ||
    !entityHasBarCaptureCommand(commander)
  ) return;
  if (!isCapturableTarget(target, commander.ownership.playerId)) return;

  const targetPoint = getEntityTargetPoint(target);
  const action: UnitAction = {
    type: 'capture',
    x: targetPoint.x,
    y: targetPoint.y,
    z: targetPoint.z,
    targetId: target.id,
  };

  addPathActionsWithFinal(commander, action, queue, ctx, queueFront, queueInsertIndex);
}

function executeCaptureCommand(ctx: CommandContext, command: CaptureCommand): void {
  const commander = ctx.world.getEntity(command.commanderId);
  const target = ctx.world.getEntity(command.targetId);
  enqueueCaptureAction(
    ctx,
    commander,
    target,
    command.queue,
    commandQueuesInFront(command),
    commandQueueInsertIndex(command),
  );
}

function executeAttackCommand(ctx: CommandContext, command: AttackCommand): void {
  const target = ctx.world.getEntity(command.targetId);
  const queueFront = commandQueuesInFront(command);
  const queueInsertIndex = commandQueueInsertIndex(command);
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    enqueueAttackAction(ctx, entity, target, command.queue, queueFront, queueInsertIndex);
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
      commandQueuesInFront(command),
      commandQueueInsertIndex(command),
    );
  }
}

function executeManualLaunchCommand(ctx: CommandContext, command: ManualLaunchCommand): void {
  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    const combat = entity?.combat ?? null;
    if (entity === undefined || combat === null || !hasManualLaunchWeapon(entity)) continue;
    const targetPoint = combat.priorityTargetPoint ?? (combat.priorityTargetPoint = { x: 0, y: 0, z: 0 });
    targetPoint.x = command.targetX;
    targetPoint.y = command.targetY;
    targetPoint.z = command.targetZ ?? ctx.world.getGroundZ(command.targetX, command.targetY);
    combat.priorityTargetId = null;
    combat.manualLaunchActive = true;
    combat.nextCombatProbeTick = -1;
    for (let weaponIndex = 0; weaponIndex < combat.turrets.length; weaponIndex++) {
      dropTurretLockMidTick(entity, weaponIndex);
    }
    ctx.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_COMBAT_MODE | ENTITY_CHANGED_TURRETS);
  }
}

function hasManualLaunchWeapon(entity: Entity): boolean {
  return entityHasBarSetTargetCommand(entity);
}

function executeAttackAreaCommand(ctx: CommandContext, command: AttackAreaCommand): void {
  const radius = clampAttackAreaRadius(command.radius);
  const entities = getAttackAreaCommandEntities(ctx, command.entityIds);
  if (entities.length === 0) return;

  const playerId = entities[0].ownership?.playerId;
  if (playerId === undefined) return;

  // BAR area attack queues an attack on EVERY target inside the dragged
  // circle, nearest-to-farthest, so the unit sweeps the area instead of
  // stopping after one kill. No targets degrades to a fight-move.
  const targets = findAttackAreaTargets(
    ctx,
    playerId,
    command.targetX,
    command.targetY,
    radius,
  );

  if (targets.length === 0) {
    executeMoveCommand(ctx, {
      type: 'move',
      tick: command.tick,
      entityIds: entityIdsFromEntities(entities),
      targetX: command.targetX,
      targetY: command.targetY,
      targetZ: command.targetZ,
      waypointType: 'fight',
      queue: command.queue,
      queueFront: command.queueFront,
      queueInsertIndex: command.queueInsertIndex,
    });
    return;
  }

  const queueFront = commandQueuesInFront(command);
  const queueInsertIndex = commandQueueInsertIndex(command);
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    enqueueAreaTargetActionsInOrder(
      targets,
      command.queue,
      queueFront,
      queueInsertIndex,
      (target, queue, targetQueueFront, targetQueueInsertIndex) =>
        enqueueAttackAction(ctx, entity, target, queue, targetQueueFront, targetQueueInsertIndex),
    );
  }
}

function getAttackAreaCommandEntities(ctx: CommandContext, entityIds: readonly number[]): Entity[] {
  const entities: Entity[] = [];
  for (let i = 0; i < entityIds.length; i++) {
    const entity = ctx.world.getEntity(entityIds[i]);
    if (entity === undefined || entity.ownership === null) continue;
    if (!entityHasBarAreaAttackCommand(entity)) continue;
    entities.push(entity);
  }
  return entities;
}

function entityIdsFromEntities(entities: readonly Entity[]): EntityId[] {
  const entityIds: EntityId[] = new Array(entities.length);
  for (let i = 0; i < entities.length; i++) entityIds[i] = entities[i].id;
  return entityIds;
}

function executeGuardCommand(ctx: CommandContext, command: GuardCommand): void {
  const target = ctx.world.getEntity(command.targetId);
  if (target === undefined || target.ownership === null) return;

  for (let i = 0; i < command.entityIds.length; i++) {
    const entity = ctx.world.getEntity(command.entityIds[i]);
    if (entity === undefined || entity.unit === null || entity.ownership === null) continue;
    if (entity.id === target.id) continue;
    if (entity.ownership.playerId !== target.ownership.playerId) continue;

    const queueFront = commandQueuesInFront(command);
    const queueInsertIndex = commandQueueInsertIndex(command);
    // Every guarder — commander or plain builder — gets the same guard
    // action and follows the target; what it then does for the target
    // (assist its construction, heal it, or defend it) is resolved per the
    // guarder's own capabilities in the construction/energy pass, so guard
    // behaves identically across builders (BAR-style).
    enqueueGuardAction(ctx, entity, target, command.queue, queueFront, queueInsertIndex);
  }
}

function clampAttackAreaRadius(radius: number): number {
  if (!Number.isFinite(radius)) return ATTACK_AREA_MAX_RADIUS;
  return Math.max(1, Math.min(radius, ATTACK_AREA_MAX_RADIUS));
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

function findAttackAreaTargets(
  ctx: CommandContext,
  playerId: PlayerId,
  x: number,
  y: number,
  radius: number,
): Entity[] {
  const radiusSq = radius * radius;
  const targets: AreaTarget[] = [];

  const units = ctx.world.getUnits();
  for (let i = 0; i < units.length; i++) {
    const target = units[i];
    if (!isAttackableEnemyTargetForPlayer(target, playerId)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq) continue;
    targets.push({ entity: target, distanceSq: distSq });
  }

  const buildings = ctx.world.getBuildings();
  for (let i = 0; i < buildings.length; i++) {
    const target = buildings[i];
    if (!isAttackableEnemyTargetForPlayer(target, playerId)) continue;
    const distSq = entityAreaDistanceSq(target, x, y);
    if (distSq > radiusSq) continue;
    targets.push({ entity: target, distanceSq: distSq });
  }

  targets.sort(compareAreaTargets);
  return sortedAreaTargetEntities(targets);
}

function enqueueAttackAction(
  ctx: CommandContext,
  entity: Entity | undefined,
  target: Entity | undefined,
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex?: number,
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
  addPathActionsWithFinal(entity, action, queue, ctx, queueFront, queueInsertIndex);
}

function enqueueAttackGroundAction(
  ctx: CommandContext,
  entity: Entity | undefined,
  targetX: number,
  targetY: number,
  targetZ: number | undefined,
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex?: number,
): void {
  if (!entity || entity.type !== 'unit' || !entity.unit || !entity.combat) return;
  const action: UnitAction = {
    type: 'attackGround',
    x: targetX,
    y: targetY,
    z: targetZ,
  };
  addPathActionsWithFinal(entity, action, queue, ctx, queueFront, queueInsertIndex);
}

function enqueueGuardAction(
  ctx: CommandContext,
  entity: Entity,
  target: Entity,
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex?: number,
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
  addPathActionsWithFinal(entity, action, queue, ctx, queueFront, queueInsertIndex);
}

function addQueuedActionToUnit(
  unit: Unit,
  action: UnitAction,
  queueFront: boolean,
  queueInsertIndex?: number,
): void {
  if (queueFront) {
    const activeIntentEnd = getFirstActionIntentEnd(unit.actions);
    insertUnitAction(unit, activeIntentEnd >= 0 ? activeIntentEnd + 1 : 0, action);
  } else if (queueInsertIndex !== undefined) {
    const index = Math.max(0, Math.min(Math.floor(queueInsertIndex), unit.actions.length));
    insertUnitAction(unit, index, action);
  } else {
    pushUnitAction(unit, action);
  }
}

// Add an action to a unit (respecting queue flag)
function addActionToUnit(
  entity: Entity,
  action: UnitAction,
  queue: boolean,
  world: WorldState | undefined = undefined,
  queueFront = false,
  queueInsertIndex?: number,
): void {
  if (!entity.unit) return;

  if (!queue) {
    // Replace all actions
    setUnitActions(entity.unit, [action]);
  } else {
    removeBuilderBlockingGuardActions(entity, action);
    addQueuedActionToUnit(entity.unit, action, queueFront, queueInsertIndex);
  }

  refreshPatrolStartIndex(entity.unit);

  if (world !== undefined) {
    world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }
}

// BAR "Guard Remove" (luaui/Widgets/cmd_guard_remove.lua): a shift-queued
// order on a builder strips the non-terminating guard/patrol orders already
// in its queue, so the new order actually runs instead of sitting behind an
// infinite guard. A queued patrol keeps the existing patrol orders (patrol
// chains are sequential in BAR); any other order — including a new guard —
// clears both. Non-builder combat units are untouched.
function removeBuilderBlockingGuardActions(entity: Entity, nextAction: UnitAction): void {
  const unit = entity.unit;
  if (unit === null || entity.builder === null || entity.factory !== null) return;
  const keepPatrolChain = nextAction.type === 'patrol';
  let removed = false;
  const keptActions: UnitAction[] = [];
  for (let i = 0; i < unit.actions.length; i++) {
    const action = unit.actions[i];
    if (action.type === 'guard' || (action.type === 'patrol' && !keepPatrolChain)) {
      removed = true;
      continue;
    }
    keptActions.push(action);
  }
  if (!removed) return;
  setUnitActions(unit, keptActions);
  refreshPatrolStartIndex(unit);
}

/** Enqueue one durable command waypoint. Route resolution between
 *  waypoints is sim-local and happens lazily when this action becomes
 *  active, so the action queue remains the player's authored command
 *  list rather than a serialized pathfinder result. */
function addPathActions(
  unit: Entity,
  goalX: number, goalY: number,
  type: UnitAction['type'],
  queue: boolean,
  ctx: CommandContext,
  goalZ: number | null,
  queueFront = false,
  queueInsertIndex?: number,
  speedLimitFactor?: number,
): void {
  const action: UnitAction = { type, x: goalX, y: goalY };
  if (goalZ !== null) action.z = goalZ;
  if (speedLimitFactor !== undefined) action.speedLimitFactor = speedLimitFactor;
  if (GAME_DIAGNOSTICS.commandPlans) {
    const unitComponent = unit.unit;
    const beforeLen = unitComponent !== null ? unitComponent.actions.length : 0;
    debugLog(
      true,
      '[plan] unit #%d authored waypoint (%d,%d,%d) type=%s queue=%s: prev queue had %d action(s)',
      unit.id,
      Math.round(goalX), Math.round(goalY),
      goalZ !== null ? Math.round(goalZ) : -1,
      type,
      queue,
      beforeLen,
    );
  }
  addActionToUnit(unit, action, queue, ctx.world, queueFront, queueInsertIndex);
  if (GAME_DIAGNOSTICS.commandPlans) {
    const unitComponent = unit.unit;
    const afterLen = unitComponent !== null ? unitComponent.actions.length : 0;
    debugLog(true, '  [plan]   unit #%d actions.length now = %d', unit.id, afterLen);
  }
}

/** Enqueue one durable typed waypoint. Target/build metadata stays on
 *  the authored action; transient movement points are computed by the
 *  simulation only while this action is active. */
function addPathActionsWithFinal(
  unit: Entity,
  finalAction: UnitAction,
  queue: boolean,
  ctx: CommandContext,
  queueFront = false,
  queueInsertIndex?: number,
): void {
  const action: UnitAction = { ...finalAction };
  delete action.isPathExpansion;
  addActionToUnit(unit, action, queue, ctx.world, queueFront, queueInsertIndex);
}
