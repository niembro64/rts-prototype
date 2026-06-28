import { WorldState } from './WorldState';
import { CommandQueue } from './commands';
import type { Entity, EntityId, PlayerId, Unit, UnitAction, UnitPathPoint } from './types';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { magnitude } from '../math';
import { executeCommand, type CommandContext } from './commandExecution';
import { distributeEnergy, createEnergyBuffers, resetEnergyBuffers, type EnergyBuffers } from './energyDistribution';
import { resourceMovementSystem } from './resourceMovement';
import {
  type SimEvent,
  type DeathContext,
  type ProjectileSpawnEvent,
  type ProjectileDespawnEvent,
  type ProjectileVelocityUpdateEvent,
} from './combat';
import { DamageSystem } from './damage';
import { economyManager } from './economy';
import { ConstructionSystem } from './construction';
import { factoryProductionSystem } from './factoryProduction';
import { updateConstructionLifecycle } from './constructionLifecycle';
import { isBuildBlockingActivation } from './buildableHelpers';
import { commanderAbilitiesSystem, type SprayTarget } from './commanderAbilities';
import { updateUnitGroundNormal } from './unitGroundNormal';
import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';
import { transitionPhase } from '@/gamePhase';
import { ENTITY_CHANGED_ACTIONS } from '@/types/network';
import type { GamePhase } from '@/types/network';
import { updateAiProduction } from './aiProduction';
import {
  expandPathPoints,
  pathTerrainFilterForLocomotion,
  type PathTerrainFilter,
} from './Pathfinder';
import { getTerrainVersion } from './Terrain';
import { updateBuildingActiveStates } from './buildingActiveState';
import { getEntityTargetPoint } from './buildingAnchors';
import { getGuardFollowRadius, isFriendlyGuardTarget, resolveGuardServiceTarget } from './guard';
import { isTransportLoadInRange, updateTransportActions } from './transports';
import { WindPowerTracker, sampleWindState, sampleWindStateInto, type WindState } from './wind';
import { isBuildTargetInRange } from './builderRange';
import { setUnitMovementAcceleration } from './unitMovementAcceleration';
import {
  rotateFirstUnitActionToEnd,
  refreshUnitActionHash,
  shiftUnitAction,
} from './unitActions';
import {
  getFirstActionIntentEnd,
  hasQueuedActionIntents,
} from './unitActionIntents';
import { SimulationEventQueues } from './SimulationEventQueues';
import { resolveCommanderGameOverWinner } from './SimulationGameOver';
import { SimulationDeathExplosionPlanner } from './SimulationDeathExplosionPlanner';
import { SimulationDeadEntityCleanup } from './SimulationDeadEntityCleanup';
import { SimulationCombatController } from './SimulationCombatController';
import { SimulationActionQueueMaintenance } from './SimulationActionQueueMaintenance';
import {
  ARRIVAL_RADIUS,
  SimulationArrivalController,
} from './SimulationArrivalController';
import {
  SimulationFlyingLoiterController,
} from './SimulationFlyingLoiterController';
import { SimulationCombatHaltController } from './SimulationCombatHaltController';
import {
  REPLAN_FAILURE_COOLDOWN,
  SimulationStuckReplanController,
} from './SimulationStuckReplanController';
import {
  SimulationUnitActionPlanner,
  UNIT_ACTION_FLAG_COMBAT_STOP_ANY,
  UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT,
  UNIT_ACTION_FLAG_GUARD_FRIENDLY,
  UNIT_ACTION_FLAG_GUARD_SERVICE,
  UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE,
  UNIT_ACTION_FLAG_LOAD_IN_RANGE,
  UNIT_ACTION_FLAG_MOVE_STATE_HOLD,
  UNIT_ACTION_FLAG_MOVE_STATE_ROAM,
  UNIT_ACTION_FLAG_TARGET_PRESENT,
  UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE,
  UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD,
  UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE,
  UNIT_ACTION_PLAN_ATTACK_HOLD,
  UNIT_ACTION_PLAN_ATTACK_MOVE,
  UNIT_ACTION_PLAN_BUILD_HOLD,
  UNIT_ACTION_PLAN_BUILD_MOVE,
  UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD,
  UNIT_ACTION_PLAN_GUARD_ADVANCE,
  UNIT_ACTION_PLAN_GUARD_FOLLOW,
  UNIT_ACTION_PLAN_GUARD_HOLD,
  UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD,
  UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE,
  UNIT_ACTION_PLAN_IDLE_LOITER,
  UNIT_ACTION_PLAN_LOAD_HOLD,
  UNIT_ACTION_PLAN_LOAD_MOVE,
  UNIT_ACTION_PLAN_MOVE_COMPLETION,
  UNIT_ACTION_PLAN_UNLOAD_ADVANCE,
  UNIT_ACTION_PLAN_UNLOAD_MOVE,
  UNIT_ACTION_PLAN_WAIT_LOITER,
} from './SimulationUnitActionPlanner';

type ActiveMovementTarget = UnitPathPoint & {
  isFinalActionPoint: boolean;
};

type GatherWaitGroup = {
  key: string;
  groupId: number;
  members: Entity[];
};

// ── Stuck-detection / replanning constants ────────────────────────
//
// A unit that wants to move (thrust set) but isn't actually moving
// is a strong signal its current path is stale — a building went up
// across it, an explosion knocked it sideways, or another unit is
// physically blocking the next waypoint. Replanning from the unit's
// CURRENT position to the trip's final destination produces a fresh
// route that respects the new world state.
//
// Replans aren't cheap (each is a bounded A* run), so we cap them
// per tick so the steady-state cost stays bounded even when many
// units are simultaneously stuck (e.g. a chokepoint pile-up). Stuck
// units that don't get a replan slot this tick keep their counter
// at the threshold and try again next tick.

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private constructionSystem: ConstructionSystem;
  private damageSystem: DamageSystem;
  private deathExplosionPlanner: SimulationDeathExplosionPlanner;
  private combatController: SimulationCombatController;
  private actionQueueMaintenance: SimulationActionQueueMaintenance;
  private deadEntityCleanup: SimulationDeadEntityCleanup;
  private arrivalController: SimulationArrivalController;
  private combatHaltController: SimulationCombatHaltController;
  private flyingLoiter: SimulationFlyingLoiterController;
  private stuckReplanController: SimulationStuckReplanController;
  private unitActionPlanner: SimulationUnitActionPlanner = new SimulationUnitActionPlanner();
  private forceAccumulator: ForceAccumulator = new ForceAccumulator();
  private windState: WindState = sampleWindState(0);
  private windPowerTracker = new WindPowerTracker();
  // Accumulated sim time (ms). Drives deterministic systems like wind
  // that used to read Date.now(); now they advance only with the
  // simulation tick, so replays and host-migration produce the same
  // wave phase regardless of wall-clock drift.
  private simElapsedMs = 0;

  // Current spray targets for rendering (build/heal effects)
  private currentSprayTargets: SprayTarget[] = [];

  // Player IDs participating in this game
  private playerIds: PlayerId[] = [1, 2];
  /** Last WorldState building-version reflected into the spatial
   *  grid. Buildings are static, so we only need to rescan them when
   *  one is added or removed instead of every simulation tick. */
  private spatialGridBuildingVersion = -1;

  // Track if game is over
  private gameOverWinnerId: PlayerId | null = null;

  // Game phase FSM
  private gamePhase: GamePhase = 'init';

  // Pending audio/projectile events for network broadcast. The helper
  // owns double-buffer swaps so snapshot drains don't allocate.
  private eventQueues = new SimulationEventQueues();

  private _movingUnitsBuf: Entity[] = [];
  private _gatherWaitGroups: Map<string, GatherWaitGroup> = new Map();
  private readonly _gatherWaitGroupList: GatherWaitGroup[] = [];
  private readonly _gatherWaitGroupPool: GatherWaitGroup[] = [];

  // Reusable buffers for shared energy distribution (avoid per-tick allocations)
  private energyBuffers: EnergyBuffers = createEnergyBuffers();

  // Callback for when units die (to clean up physics bodies)
  // deathContexts contains info about the killing blow for directional explosions
  public onUnitDeath: ((deadUnitIds: EntityId[], deathContexts: Map<EntityId, DeathContext> | null) => void) | null = null;

  // Callback for when units are spawned (to create physics bodies)
  public onUnitSpawn: ((newUnits: Entity[]) => void) | null = null;

  // Callback for when runtime static entities are spawned (to create physics bodies)
  public onBuildingSpawn: ((newBuildings: Entity[]) => void) | null = null;

  // Callback for when buildings are destroyed
  public onBuildingDeath: ((deadBuildingIds: EntityId[]) => void) | null = null;

  // Callback for audio events
  public onSimEvent: ((event: SimEvent) => void) | null = null;

  // Callback for game over (passes winner ID)
  public onGameOver: ((winnerId: PlayerId) => void) | null = null;

  constructor(
    world: WorldState,
    commandQueue: CommandQueue,
    terrainBuildabilityGrid: TerrainBuildabilityGrid | null = null,
  ) {
    this.world = world;
    this.commandQueue = commandQueue;
    this.constructionSystem = new ConstructionSystem(
      world.mapWidth,
      world.mapHeight,
      terrainBuildabilityGrid,
    );
    this.damageSystem = new DamageSystem(world);
    this.deathExplosionPlanner = new SimulationDeathExplosionPlanner(
      this.world,
      this.damageSystem,
      this.forceAccumulator,
    );
    this.deadEntityCleanup = new SimulationDeadEntityCleanup(
      this.world,
      this.eventQueues,
      this.deathExplosionPlanner,
    );
    this.combatController = new SimulationCombatController(
      this.world,
      this.damageSystem,
      this.forceAccumulator,
      this.eventQueues,
      this.deathExplosionPlanner,
    );
    this.actionQueueMaintenance = new SimulationActionQueueMaintenance(
      this.world,
      (entity) => this.advanceAction(entity),
    );
    this.arrivalController = new SimulationArrivalController(this.world, {
      advanceAction: (entity) => this.advanceAction(entity),
      advanceActivePathPoint: (entity) => this.advanceActivePathPoint(entity),
      queueFlyingLoiter: (entity) => this.flyingLoiter.queue(entity),
    });
    this.combatHaltController = new SimulationCombatHaltController(this.world);
    this.flyingLoiter = new SimulationFlyingLoiterController(this.world);
    this.stuckReplanController = new SimulationStuckReplanController(
      (entity) => this.tryReplan(entity),
    );
  }

  // AI player IDs (for auto-production)
  private aiPlayerIds: Set<PlayerId> = new Set();
  private aiAllowedUnitBlueprintIds: ReadonlySet<string> | null = null;

  // Set the player IDs for this game
  setPlayerIds(playerIds: PlayerId[]): void {
    this.playerIds = playerIds;
  }

  // Set which players are AI-controlled (factories auto-queue units)
  setAiPlayerIds(ids: PlayerId[]): void {
    this.aiPlayerIds = new Set(ids);
  }

  // Set allowed unit blueprints for AI production (null = all allowed)
  setAiAllowedUnitBlueprintIds(types: ReadonlySet<string> | null | undefined = null): void {
    this.aiAllowedUnitBlueprintIds = types ?? null;
  }

  // Get the winner ID (null if game not over)
  getWinnerId(): PlayerId | null {
    return this.gameOverWinnerId;
  }

  // Get current game phase
  getGamePhase(): GamePhase {
    return this.gamePhase;
  }

  setPaused(paused: boolean): void {
    if (this.gamePhase === 'gameOver') return;
    if (paused) {
      if (this.gamePhase === 'init') {
        this.gamePhase = transitionPhase('init', 'battle');
      }
      if (this.gamePhase === 'battle') {
        this.gamePhase = transitionPhase('battle', 'paused');
      }
    } else if (this.gamePhase === 'paused') {
      this.gamePhase = transitionPhase('paused', 'battle');
    }
  }

  // Get construction system (for placement validation)
  getConstructionSystem(): ConstructionSystem {
    return this.constructionSystem;
  }

  // Get current spray targets for rendering
  getSprayTargets(): SprayTarget[] {
    return this.currentSprayTargets;
  }

  // Get and clear pending audio events (double-buffer swap, zero allocation)
  getAndClearEvents(): SimEvent[] {
    return this.eventQueues.getAndClearEvents();
  }

  // Get and clear pending projectile spawn events (double-buffer swap)
  getAndClearProjectileSpawns(): ProjectileSpawnEvent[] {
    return this.eventQueues.getAndClearProjectileSpawns();
  }

  // Get and clear pending projectile despawn events (double-buffer swap)
  getAndClearProjectileDespawns(): ProjectileDespawnEvent[] {
    return this.eventQueues.getAndClearProjectileDespawns();
  }

  // Get and clear pending projectile velocity update events (double-buffered)
  getAndClearProjectileVelocityUpdates(): ProjectileVelocityUpdateEvent[] {
    return this.eventQueues.getAndClearProjectileVelocityUpdates();
  }

  hasPendingProjectilePresentationEvents(): boolean {
    return this.eventQueues.hasPendingProjectilePresentationEvents();
  }

  getWindState(): WindState {
    return this.windState;
  }

  getSimElapsedMs(): number {
    return this.simElapsedMs;
  }

  // Run one simulation step with the given timestep
  update(dtMs: number): void {
    if (this.gamePhase === 'init') this.gamePhase = transitionPhase('init', 'battle');

    this.stuckReplanController.beginFrame();
    resourceMovementSystem.beginTick(this.world);
    this.forceAccumulator.clear();

    this.simElapsedMs += dtMs;
    const tick = this.world.getTick();

    // Prune temporary vision pulses whose duration has elapsed
    // (FOW-14). Done before commands so a new scan command
    // this tick lands in a clean list.
    this.world.pruneExpiredScanPulses(tick);

    // Process commands for this tick
    const cmdCtx: CommandContext = {
      world: this.world,
      constructionSystem: this.constructionSystem,
      pendingProjectileSpawns: this.eventQueues.projectileSpawns,
      pendingSimEvents: this.eventQueues.simEvents,
      onSimEvent: this.onSimEvent,
    };
    const commands = this.commandQueue.getCommandsForTick(tick);
    for (let i = 0; i < commands.length; i++) {
      executeCommand(cmdCtx, commands[i]);
    }

    // Solar collectors, wind turbines, and metal extractors share a
    // fortifiable-producer lifecycle: a 2 s grace timer arms on the
    // first hit, the building snaps closed once it expires, and a
    // 5 s quiet debounce reopens it. Production follows the open flag.
    updateBuildingActiveStates(this.world, dtMs);
    sampleWindStateInto(this.windState, this.simElapsedMs);
    this.windPowerTracker.update(this.world, this.windState);

    // Update economy income and production.
    economyManager.update(this.world, dtMs, this.windState.speed);

    // Update each unit's smoothed surface normal BEFORE the systems
    // that read it (commanderAbilitiesSystem, turret kinematics inside
    // updateUnits / the targeting scheduler bridge). The EMA owns the
    // single canonical normal source so the renderer, sim turret
    // mounts, and locomotion can never read disagreeing per-unit normals.
    updateUnitGroundNormal(this.world, dtMs);

    // Distribute energy equally among all active consumers (factories, construction, commander)
    distributeEnergy(this.world, dtMs, this.energyBuffers);

    // Resource converters are one-way energy -> metal makers. Run after
    // construction/factory energy distribution so converters consume the
    // leftover post-construction stockpile instead of deepening stalls.
    economyManager.processConverters(this.world, dtMs);

    // Shared construction lifecycle for both building shells and
    // factory unit shells: HP growth, paid-full completion, building
    // completion effects, and dirty flags all flow through one pass.
    const constructionResult = updateConstructionLifecycle(this.world);
    this.actionQueueMaintenance.advanceCompletedConstructionActions(
      constructionResult.completedBuildings,
    );

    // AI auto-queues units at idle factories
    updateAiProduction(this.world, this.aiPlayerIds, this.aiAllowedUnitBlueprintIds);

    // Update factory production
    const productionResult = factoryProductionSystem.update(
      this.world, dtMs,
      this.constructionSystem.getGrid(),
      this.forceAccumulator,
      this.windState,
    );
    // Notify about newly spawned unit shells immediately so their
    // elevated initial position can fall/settle during construction.
    if (productionResult.spawnedUnits.length > 0) {
      const onUnitSpawn = this.onUnitSpawn;
      if (onUnitSpawn !== null) onUnitSpawn(productionResult.spawnedUnits);
    }
    // Completed shells should already have bodies, but keep the
    // activation notification as a defensive fallback for old paths.
    if (productionResult.completedUnits.length > 0) {
      const onUnitSpawn = this.onUnitSpawn;
      if (onUnitSpawn !== null) onUnitSpawn(productionResult.completedUnits);
    }

    // Update commander auto-build and auto-heal
    const commanderResult = commanderAbilitiesSystem.update(this.world, dtMs);
    this.currentSprayTargets = commanderResult.sprayTargets;
    if (commanderResult.resurrectedUnits.length > 0) {
      const onUnitSpawn = this.onUnitSpawn;
      if (onUnitSpawn !== null) onUnitSpawn(commanderResult.resurrectedUnits);
    }

    const transportResult = updateTransportActions(this.world);
    if (transportResult.unloadedUnits.length > 0) {
      const onUnitSpawn = this.onUnitSpawn;
      if (onUnitSpawn !== null) onUnitSpawn(transportResult.unloadedUnits);
    }

    // Handle completed build/repair actions - advance commander action queues
    for (let i = 0; i < commanderResult.completedBuildings.length; i++) {
      const commander = this.world.getEntity(commanderResult.completedBuildings[i].commanderId);
      if (commander) {
        this.advanceAction(commander);
      }
    }

    // Beam index is maintained incrementally:
    // - addBeam() called on beam creation in fireTurrets()
    // - removeBeam() called on beam expiry/orphan in updateProjectiles/checkProjectileCollisions

    // Update all units movement (calculates target velocities) and
    // refresh their spatial-grid cells in the same pass.
    this.updateUnits(dtMs / 1000);

    // Update non-unit spatial indices. Unit cells are refreshed inside
    // updateUnits() to avoid another full unit walk.
    this.updateSpatialGrid();

    // Update combat systems (targeting, firing, projectile collisions)
    this.combatController.update(
      dtMs,
      this.windState,
      this.onSimEvent,
      this.onUnitDeath,
      this.onBuildingDeath,
    );
    // Safety cleanup - remove any dead entities that slipped through.
    // WorldState records ids whose HP changed, so this drains only
    // those candidates instead of walking every unit/building.
    this.deadEntityCleanup.run(this.onUnitDeath, this.onBuildingDeath, this.onBuildingSpawn);

    // Finalize force accumulator (sums all contributions)
    this.forceAccumulator.finalize();

    // Check for game over (commander death)
    this.checkGameOver();

    this.world.incrementTick();
  }

  // Update spatial grid incrementally
  private updateSpatialGrid(): void {
    // Ensure buildings are tracked (addBuilding skips if already present)
    const buildingVersion = this.world.getBuildingVersion();
    if (buildingVersion !== this.spatialGridBuildingVersion) {
      const buildings = this.world.getBuildings();
      for (let i = 0; i < buildings.length; i++) {
        const building = buildings[i];
        if (building.building && building.building.hp > 0) {
          spatialGrid.addBuilding(building);
        }
      }
      this.spatialGridBuildingVersion = buildingVersion;
    }

    // Update traveling projectile positions for projectile broadphase
    // queries. Beam/laser line shots are handled by beam pathing.
    spatialGrid.updateProjectiles(this.world.getTravelingProjectiles());
  }

  // Check for game over - last commander standing wins
  private checkGameOver(): void {
    if (this.gameOverWinnerId !== null) return; // Already over
    const winnerId = resolveCommanderGameOverWinner(this.world, this.playerIds);
    if (winnerId === null) return;

    this.gameOverWinnerId = winnerId;
    this.gamePhase = transitionPhase(this.gamePhase, 'gameOver');
    const onGameOver = this.onGameOver;
    if (onGameOver !== null) onGameOver(winnerId);
  }

  private isActivePathValid(
    unit: Unit,
    action: UnitAction,
    terrainVersion: number,
    buildingGridVersion: number,
  ): boolean {
    const plan = unit.activePath;
    return plan !== null &&
      plan.actionHash === unit.actionHash &&
      plan.terrainVersion === terrainVersion &&
      plan.buildingGridVersion === buildingGridVersion &&
      plan.goalX === action.x &&
      plan.goalY === action.y &&
      plan.goalZ === action.z &&
      plan.actionType === action.type &&
      plan.targetId === action.targetId &&
      plan.buildingId === action.buildingId;
  }

  private ensureActivePathPlan(entity: Entity, action: UnitAction): Unit['activePath'] {
    const unit = entity.unit;
    if (!unit) return null;

    const buildingGrid = this.constructionSystem.getGrid();
    const terrainVersion = getTerrainVersion();
    const buildingGridVersion = buildingGrid.getVersion();
    if (this.isActivePathValid(unit, action, terrainVersion, buildingGridVersion)) {
      return unit.activePath;
    }

    const points = expandPathPoints(
      entity.transform.x,
      entity.transform.y,
      action.x,
      action.y,
      this.world.mapWidth,
      this.world.mapHeight,
      buildingGrid,
      action.z ?? null,
      this.pathTerrainFilterForUnit(entity),
      unit.radius.collision,
      this.world.slopePathMode === 'symmetric',
    );
    unit.activePath = {
      points,
      index: 0,
      actionHash: unit.actionHash,
      terrainVersion,
      buildingGridVersion,
      goalX: action.x,
      goalY: action.y,
      goalZ: action.z,
      actionType: action.type,
      targetId: action.targetId,
      buildingId: action.buildingId,
    };
    // The route preview rides the (presentation-only) actions channel, so a
    // repath has to re-mark actions dirty even though the durable queue is
    // unchanged — otherwise delta snapshots would keep shipping the old path.
    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
    return unit.activePath;
  }

  private resolveActiveMovementTarget(entity: Entity, action: UnitAction): ActiveMovementTarget {
    const plan = this.ensureActivePathPlan(entity, action);
    if (plan === null || plan.points.length === 0) {
      return {
        x: action.x,
        y: action.y,
        z: action.z,
        isFinalActionPoint: true,
      };
    }

    const startIndex = plan.index;
    while (plan.index < plan.points.length - 1) {
      const point = plan.points[plan.index];
      const dx = point.x - entity.transform.x;
      const dy = point.y - entity.transform.y;
      if (magnitude(dx, dy) > ARRIVAL_RADIUS) break;
      plan.index++;
    }
    // Advancing past a preview point shrinks the serialized route; re-mark
    // actions so selected-unit waypoint visuals follow the unit forward.
    if (plan.index !== startIndex) {
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
    }

    const point = plan.points[plan.index];
    return {
      x: point.x,
      y: point.y,
      z: point.z,
      isFinalActionPoint: plan.index >= plan.points.length - 1,
    };
  }

  private advanceActivePathPoint(entity: Entity): void {
    const unit = entity.unit;
    const plan = unit?.activePath ?? null;
    if (plan === null) return;
    if (plan.index < plan.points.length - 1) {
      plan.index++;
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
    }
  }

  private updateCurrentActionApproach(
    entity: Entity,
    currentAction: UnitAction,
    targetPoint: { x: number; y: number; z: number },
  ): void {
    if (!entity.unit) return;
    currentAction.x = targetPoint.x;
    currentAction.y = targetPoint.y;
    currentAction.z = targetPoint.z;
    refreshUnitActionHash(entity.unit);
    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }

  private gatherWaitGroupIdForAction(action: UnitAction | undefined): number | undefined {
    if (
      action === undefined ||
      action.type !== 'wait' ||
      action.waitGather !== true ||
      action.waitGroupId === undefined ||
      !Number.isInteger(action.waitGroupId)
    ) return undefined;
    return action.waitGroupId;
  }

  private findQueuedGatherWaitGroupId(unit: Unit): number | undefined {
    for (let i = 0; i < unit.actions.length; i++) {
      const groupId = this.gatherWaitGroupIdForAction(unit.actions[i]);
      if (groupId !== undefined) return groupId;
    }
    return undefined;
  }

  private releaseReadyGatherWaits(): void {
    const groups = this._gatherWaitGroups;
    const sortedGroups = this._gatherWaitGroupList;
    groups.clear();
    sortedGroups.length = 0;
    const units = this.world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      const unit = entity.unit;
      if (unit === null || unit.hp <= 0) continue;
      const groupId = this.findQueuedGatherWaitGroupId(unit);
      if (groupId === undefined) continue;
      const ownerId = entity.ownership?.playerId ?? 0;
      const groupKey = `${ownerId}:${groupId}`;
      let group = groups.get(groupKey);
      if (group === undefined) {
        group = this.acquireGatherWaitGroup(groupKey, groupId);
        groups.set(groupKey, group);
        sortedGroups.push(group);
      }
      group.members.push(entity);
    }

    sortedGroups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (let groupIndex = 0; groupIndex < sortedGroups.length; groupIndex++) {
      const { groupId, members } = sortedGroups[groupIndex];
      let ready = members.length > 0;
      for (let i = 0; i < members.length; i++) {
        const unit = members[i].unit;
        if (unit === null || this.gatherWaitGroupIdForAction(unit.actions[0]) !== groupId) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;
      for (let i = 0; i < members.length; i++) {
        const entity = members[i];
        const unit = entity.unit;
        if (unit === null || this.gatherWaitGroupIdForAction(unit.actions[0]) !== groupId) continue;
        shiftUnitAction(unit);
        unit.stuckTicks = 0;
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      }
    }
    groups.clear();
    this.releaseGatherWaitGroups(sortedGroups);
  }

  private acquireGatherWaitGroup(key: string, groupId: number): GatherWaitGroup {
    const group = this._gatherWaitGroupPool.pop();
    if (group !== undefined) {
      group.key = key;
      group.groupId = groupId;
      group.members.length = 0;
      return group;
    }
    return { key, groupId, members: [] };
  }

  private releaseGatherWaitGroups(groups: GatherWaitGroup[]): void {
    const pool = this._gatherWaitGroupPool;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      group.members.length = 0;
      pool.push(group);
    }
    groups.length = 0;
  }

  // Update unit movement with action queue processing.
  // unit.thrustDirX/Y is what GameServer.applyForces reads — a (0, 0)
  // means "no powered thrust this tick"; vector magnitude scales drive
  // force. The authoritative physics velocity stays in unit.velocityX/Y/Z
  // and is only overwritten by syncFromPhysics, so lead-prediction in
  // turretSystem reads the real velocity, not this thrust target.
  private updateUnits(dtSec: number): void {
    const movingUnits = this._movingUnitsBuf;
    movingUnits.length = 0;
    this.arrivalController.beginFrame();
    this.combatHaltController.prepare();
    this.releaseReadyGatherWaits();

    const units = this.world.getUnits();
    const planner = this.unitActionPlanner;
    planner.begin(units.length);
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      spatialGrid.updateUnit(entity);
      if (!entity.unit || !entity.body) continue;

      const { unit } = entity;

      // Construction shells do not execute player actions or acquire
      // combat priority while incomplete, but their physics body remains
      // live. UnitForceSystem still applies contact locomotion/friction
      // so shells can fall, collide, and settle like ordinary units
      // before activation.
      if (isBuildBlockingActivation(entity.buildable)) {
        unit.thrustDirX = 0;
        unit.thrustDirY = 0;
        // Acceleration is sim-only state now (not shipped on the
        // wire); reset it without flagging a delta.
        setUnitMovementAcceleration(unit, 0, 0, 0);
        if (entity.combat) {
          entity.combat.priorityTargetId = null;
          entity.combat.priorityTargetPoint = null;
          entity.combat.manualLaunchActive = false;
        }
        continue;
      }

      if (unit.hp <= 0) {
        unit.thrustDirX = 0;
        unit.thrustDirY = 0;
        setUnitMovementAcceleration(unit, 0, 0, 0);
        unit.stuckTicks = 0;
        if (entity.combat) {
          entity.combat.priorityTargetId = null;
          entity.combat.priorityTargetPoint = null;
          entity.combat.manualLaunchActive = false;
        }
        continue;
      }

      // Default: no thrust (contact braking/drag will slow or hold the unit)
      unit.thrustDirX = 0;
      unit.thrustDirY = 0;
      setUnitMovementAcceleration(unit, 0, 0, 0);

      // Clear priority target — re-set below by attack / attack-ground actions.
      if (entity.combat) {
        if (!entity.combat.manualLaunchActive) {
          entity.combat.priorityTargetId = null;
          entity.combat.priorityTargetPoint = null;
        }
      }

      // Sweep targeted intents whose target disappeared or no longer
      // needs work. The action queue holds durable command waypoints;
      // transient pathfinding points live in unit.activePath and are
      // discarded automatically when the queue changes.
      if (this.actionQueueMaintenance.sweepInvalidTargetActions(entity)) {
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      }

      // No actions - flying units keep circling their last destination.
      if (unit.actions.length === 0) {
        planner.queue(entity, undefined, 0);
        continue;
      }

      this.actionQueueMaintenance.promoteReachableBuildAction(entity);

      // Get current action
      const currentAction = unit.actions[0];
      this.flyingLoiter.rememberTarget(unit, currentAction);

      let flags = 0;
      let serviceTarget: Entity | null = null;
      if (unit.moveState === 'roam') flags |= UNIT_ACTION_FLAG_MOVE_STATE_ROAM;
      if (unit.moveState === 'holdPosition') flags |= UNIT_ACTION_FLAG_MOVE_STATE_HOLD;

      if (currentAction.type === 'loadTransport') {
        const target = currentAction.targetId !== undefined
          ? this.world.getEntity(currentAction.targetId)
          : undefined;
        if (target !== undefined && isTransportLoadInRange(entity, target)) {
          flags |= UNIT_ACTION_FLAG_LOAD_IN_RANGE;
        }
      } else if (currentAction.type === 'unloadTransport') {
        if (entity.transport?.loadedUnits.length === 0) {
          this.advanceAction(entity);
          unit.stuckTicks = 0;
          continue;
        }
      } else if (
        currentAction.type === 'build' ||
        currentAction.type === 'repair' ||
        currentAction.type === 'reclaim' ||
        currentAction.type === 'capture' ||
        currentAction.type === 'resurrect'
      ) {
        // For build/repair/reclaim actions, check if we're in range.
        const targetId = currentAction.type === 'build'
          ? currentAction.buildingId
          : currentAction.targetId;
        const target = targetId !== undefined ? this.world.getEntity(targetId) : undefined;
        if (target && isBuildTargetInRange(entity, target)) {
          flags |= UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE;
        }
      } else if (currentAction.type === 'attack') {
        if (currentAction.targetId !== undefined) {
          flags |= UNIT_ACTION_FLAG_TARGET_PRESENT;
          // Set priority target for turret system.
          if (entity.combat && !entity.combat.manualLaunchActive) {
            entity.combat.priorityTargetId = currentAction.targetId;
          }
          // Stop if any turret is engaged.
          if (unit.moveState !== 'roam' && this.combatHaltController.shouldStopForEngagedCombat(entity)) {
            flags |= UNIT_ACTION_FLAG_COMBAT_STOP_ANY;
          }
        }
      } else if (currentAction.type === 'attackGround') {
        if (entity.combat && !entity.combat.manualLaunchActive) {
          const targetPoint = entity.combat.priorityTargetPoint ??
            (entity.combat.priorityTargetPoint = { x: 0, y: 0, z: 0 });
          targetPoint.x = currentAction.x;
          targetPoint.y = currentAction.y;
          targetPoint.z = currentAction.z ?? this.world.getGroundZ(currentAction.x, currentAction.y);
        }

        if (unit.moveState !== 'roam' && this.combatHaltController.shouldStopForEngagedCombat(entity)) {
          flags |= UNIT_ACTION_FLAG_COMBAT_STOP_ANY;
        }
      } else if (currentAction.type === 'guard' && currentAction.targetId !== undefined) {
        flags |= UNIT_ACTION_FLAG_TARGET_PRESENT;
        const guardTarget = this.world.getEntity(currentAction.targetId);
        if (!entity.ownership || !isFriendlyGuardTarget(guardTarget, entity.ownership.playerId)) {
          this.advanceAction(entity);
          unit.stuckTicks = 0;
          continue;
        }
        flags |= UNIT_ACTION_FLAG_GUARD_FRIENDLY;

        // Active defend (BAR): a guarding unit helps fight whatever its
        // guarded ally is currently engaging — prioritize that enemy so the
        // guard's turrets and combat-halt engage it; cleared when the ally
        // isn't fighting (turrets fall back to opportunistic acquisition).
        if (entity.combat !== null && !entity.combat.manualLaunchActive) {
          let defendId: EntityId | null = null;
          const allyTargetId = guardTarget.combat !== null ? guardTarget.combat.priorityTargetId : null;
          if (allyTargetId !== null) {
            const allyTarget = this.world.getEntity(allyTargetId);
            if (
              allyTarget !== undefined &&
              allyTarget.ownership !== null &&
              allyTarget.ownership.playerId !== entity.ownership.playerId &&
              ((allyTarget.unit !== null && allyTarget.unit.hp > 0) ||
                (allyTarget.building !== null && allyTarget.building.hp > 0))
            ) {
              defendId = allyTargetId;
            }
          }
          entity.combat.priorityTargetId = defendId;
        }

        if (unit.moveState !== 'roam' && this.combatHaltController.shouldStopForEngagedCombat(entity)) {
          flags |= UNIT_ACTION_FLAG_COMBAT_STOP_ANY;
        }

        // BAR: a guarding builder continuously services its target — assist
        // its construction, assist a guarded factory's production, or repair
        // a damaged ally. Approach the serviced thing within build range so
        // the energy pass can fund it (the funding itself happens there);
        // otherwise fall through to plain follow.
        if (entity.builder !== null) {
          const service = resolveGuardServiceTarget(this.world, entity);
          if (service !== null) {
            flags |= UNIT_ACTION_FLAG_GUARD_SERVICE;
            serviceTarget = service.target;
            if (isBuildTargetInRange(entity, service.target)) {
              flags |= UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE;
            }
          }
        }
      } else if (currentAction.type === 'fight' || currentAction.type === 'patrol') {
        // Fight/patrol halt is per-mount: unit blueprints mark the exact
        // turret mount(s) that must be engaged before the unit stops and
        // brawls. If no mount is marked, the unit keeps moving while
        // weapons engage opportunistically.
        if (unit.moveState !== 'roam' && this.combatHaltController.shouldStopForFightCombat(entity)) {
          flags |= UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT;
        }
      }

      planner.queue(entity, currentAction, flags, serviceTarget);
    }

    const planCount = planner.compute();
    for (let i = 0; i < planCount; i++) {
      const entity = planner.entityAt(i);
      const unit = entity.unit;
      if (!unit || !entity.body) continue;
      const transform = entity.transform;
      const currentAction = planner.actionAt(i);

      switch (planner.planAt(i)) {
        case UNIT_ACTION_PLAN_IDLE_LOITER:
        case UNIT_ACTION_PLAN_WAIT_LOITER:
          unit.activePath = null;
          unit.stuckTicks = 0;
          this.flyingLoiter.queue(entity);
          break;

        case UNIT_ACTION_PLAN_LOAD_HOLD:
        case UNIT_ACTION_PLAN_BUILD_HOLD:
        case UNIT_ACTION_PLAN_ATTACK_HOLD:
        case UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD:
        case UNIT_ACTION_PLAN_GUARD_HOLD:
        case UNIT_ACTION_PLAN_GUARD_SERVICE_HOLD:
        case UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD:
          unit.stuckTicks = 0;
          break;

        case UNIT_ACTION_PLAN_UNLOAD_ADVANCE:
        case UNIT_ACTION_PLAN_GUARD_ADVANCE:
          this.advanceAction(entity);
          unit.stuckTicks = 0;
          break;

        case UNIT_ACTION_PLAN_LOAD_MOVE: {
          if (currentAction === undefined) break;
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          const dx = movementTarget.x - transform.x;
          const dy = movementTarget.y - transform.y;
          const distance = magnitude(dx, dy);
          if (distance <= 1) {
            if (!movementTarget.isFinalActionPoint) this.advanceActivePathPoint(entity);
            unit.stuckTicks = 0;
          } else {
            this.arrivalController.queueThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
          }
          break;
        }

        case UNIT_ACTION_PLAN_UNLOAD_MOVE: {
          if (currentAction === undefined) break;
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          const dx = movementTarget.x - transform.x;
          const dy = movementTarget.y - transform.y;
          const distance = magnitude(dx, dy);
          if (distance > 15) {
            this.arrivalController.queueThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
          } else if (!movementTarget.isFinalActionPoint) {
            this.advanceActivePathPoint(entity);
            unit.stuckTicks = 0;
          } else {
            unit.stuckTicks = 0;
          }
          break;
        }

        case UNIT_ACTION_PLAN_BUILD_MOVE: {
          if (currentAction === undefined) break;
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          const dx = movementTarget.x - transform.x;
          const dy = movementTarget.y - transform.y;
          const distance = magnitude(dx, dy);
          if (distance <= 1) {
            if (!movementTarget.isFinalActionPoint) this.advanceActivePathPoint(entity);
            unit.stuckTicks = 0;
          } else {
            this.arrivalController.queueThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
          }
          break;
        }

        case UNIT_ACTION_PLAN_ATTACK_MOVE: {
          if (currentAction === undefined) break;
          if (currentAction.type !== 'attack' || currentAction.targetId === undefined) {
            const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
            this.arrivalController.queueCompletion(
              entity,
              currentAction,
              movementTarget.x - transform.x,
              movementTarget.y - transform.y,
              movementTarget.isFinalActionPoint,
            );
            break;
          }
          const attackTarget = this.world.getEntity(currentAction.targetId);
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          const dx = movementTarget.x - transform.x;
          const dy = movementTarget.y - transform.y;
          const distance = magnitude(dx, dy);
          if (distance > 15) {
            this.arrivalController.queueThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
          } else if (!movementTarget.isFinalActionPoint) {
            this.advanceActivePathPoint(entity);
            unit.stuckTicks = 0;
          } else if (attackTarget === undefined) {
            unit.stuckTicks = 0;
          } else {
            if ((unit.stuckTicks ?? 0) < 0) {
              unit.stuckTicks = (unit.stuckTicks ?? 0) + 1;
              break;
            }
            const targetPoint = getEntityTargetPoint(attackTarget);
            if (!this.tryRefreshAttackApproach(entity, currentAction, targetPoint)) {
              unit.stuckTicks = REPLAN_FAILURE_COOLDOWN;
              break;
            }
            unit.stuckTicks = 0;
          }
          break;
        }

        case UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE: {
          if (currentAction === undefined) break;
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          const dx = movementTarget.x - transform.x;
          const dy = movementTarget.y - transform.y;
          const distance = magnitude(dx, dy);
          if (distance > 15) {
            this.arrivalController.queueThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
          } else if (!movementTarget.isFinalActionPoint) {
            this.advanceActivePathPoint(entity);
            unit.stuckTicks = 0;
          } else {
            unit.stuckTicks = 0;
          }
          break;
        }

        case UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE: {
          if (currentAction === undefined) break;
          const target = planner.serviceTargetAt(i);
          if (target === null) {
            unit.stuckTicks = 0;
            break;
          }
          const sp = getEntityTargetPoint(target);
          const sdx = sp.x - transform.x;
          const sdy = sp.y - transform.y;
          const sdist = magnitude(sdx, sdy);
          if (sdist > 15) {
            this.arrivalController.queueThrust(entity, currentAction, sdx, sdy, sdist, true);
          }
          unit.stuckTicks = 0;
          break;
        }

        case UNIT_ACTION_PLAN_GUARD_FOLLOW: {
          if (currentAction === undefined || currentAction.type !== 'guard' || currentAction.targetId === undefined) break;
          const guardTarget = this.world.getEntity(currentAction.targetId);
          if (!entity.ownership || !isFriendlyGuardTarget(guardTarget, entity.ownership.playerId)) {
            this.advanceAction(entity);
            unit.stuckTicks = 0;
            break;
          }
          const targetPoint = getEntityTargetPoint(guardTarget);
          const targetDx = targetPoint.x - transform.x;
          const targetDy = targetPoint.y - transform.y;
          const targetDistance = magnitude(targetDx, targetDy);
          if (targetDistance <= getGuardFollowRadius(entity, guardTarget)) {
            unit.stuckTicks = 0;
            break;
          }

          // Pin the path goal to the guarded ally's LIVE position every tick so
          // the guard tracks a moving target continuously, instead of walking to
          // where the ally was and only re-pathing on arrival. sameActionApproachTarget
          // no-ops when the ally hasn't moved, so a stationary guard never thrashes pathing.
          this.tryRefreshGuardApproach(entity, currentAction, targetPoint);

          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          const dx = movementTarget.x - transform.x;
          const dy = movementTarget.y - transform.y;
          const distance = magnitude(dx, dy);
          if (distance > 15) {
            this.arrivalController.queueThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
          } else if (!movementTarget.isFinalActionPoint) {
            this.advanceActivePathPoint(entity);
            unit.stuckTicks = 0;
          } else if (this.tryRefreshGuardApproach(entity, currentAction, targetPoint)) {
            unit.stuckTicks = 0;
          } else {
            this.arrivalController.queueThrust(entity, currentAction, targetDx, targetDy, targetDistance);
          }
          break;
        }

        case UNIT_ACTION_PLAN_MOVE_COMPLETION: {
          if (currentAction === undefined) break;
          // Calculate direction to the current transient path point for
          // this durable waypoint.
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          const dx = movementTarget.x - transform.x;
          const dy = movementTarget.y - transform.y;

          // Completion classification is batched below so Rust reads the
          // current body velocity and applies the final-waypoint brake gate.
          this.arrivalController.queueCompletion(
            entity,
            currentAction,
            dx,
            dy,
            movementTarget.isFinalActionPoint,
          );
          break;
        }
      }
    }

    this.arrivalController.flushCompletion();
    this.flyingLoiter.flush(movingUnits);
    this.arrivalController.flushThrust(movingUnits, dtSec);

    // Stuck-detection / replan pass — runs after every unit has had
    // its thrust set this tick. Looking at thrust + actual physics
    // velocity tells us "this unit wants to move but isn't getting
    // anywhere," which is the canonical sign that its planned route
    // has gone stale (a building went up, an explosion knocked it
    // sideways, a chokepoint pile-up, etc.). Capped at
    // MAX_REPLANS_PER_TICK so a 100-unit pile-up doesn't burn the
    // tick budget on planning — units that don't get a slot this
    // tick stay at the threshold and try again next tick.
    this.stuckReplanController.evaluate(movingUnits);
  }

  /** Replan the given unit's active route from its current position to
   *  the current durable waypoint. Returns true on a successful active
   *  path refresh, false when the action type isn't replan-eligible or
   *  when the planner collapses to a worse stay-put fallback. */
  private tryReplan(entity: Entity): boolean {
    const unit = entity.unit;
    if (!unit) return false;
    const actions = unit.actions;
    if (actions.length === 0) return false;
    const action = actions[0];
    if (
      action.type !== 'move' &&
      action.type !== 'fight' &&
      action.type !== 'attack' &&
      action.type !== 'attackGround' &&
      action.type !== 'guard' &&
      action.type !== 'loadTransport' &&
      action.type !== 'unloadTransport'
    ) {
      return false;
    }

    const previousPath = unit.activePath;
    unit.activePath = null;
    const nextPath = this.ensureActivePathPlan(entity, action);
    if (nextPath === null || nextPath.points.length === 0) {
      unit.activePath = previousPath;
      return false;
    }
    if (
      previousPath !== null &&
      previousPath.points.length > 1 &&
      nextPath.points.length <= 1
    ) {
      unit.activePath = previousPath;
      return false;
    }
    return true;
  }

  private tryRefreshAttackApproach(
    entity: Entity,
    currentAction: UnitAction,
    targetPoint: { x: number; y: number; z: number },
  ): boolean {
    if (!entity.unit || currentAction.type !== 'attack' || currentAction.targetId === undefined) {
      return false;
    }
    if (this.sameActionApproachTarget(currentAction, targetPoint)) {
      return false;
    }

    this.updateCurrentActionApproach(entity, currentAction, targetPoint);
    return true;
  }

  private sameActionApproachTarget(
    action: UnitAction,
    targetPoint: { x: number; y: number; z: number },
  ): boolean {
    return (
      Math.abs(action.x - targetPoint.x) < 1 &&
      Math.abs(action.y - targetPoint.y) < 1 &&
      Math.abs((action.z ?? 0) - targetPoint.z) < 1
    );
  }

  private tryRefreshGuardApproach(
    entity: Entity,
    currentAction: UnitAction,
    targetPoint: { x: number; y: number; z: number },
  ): boolean {
    if (!entity.unit || currentAction.type !== 'guard' || currentAction.targetId === undefined) {
      return false;
    }
    if (this.sameActionApproachTarget(currentAction, targetPoint)) {
      return false;
    }

    this.updateCurrentActionApproach(entity, currentAction, targetPoint);
    return true;
  }

  private pathTerrainFilterForUnit(entity: Entity): PathTerrainFilter | null {
    return entity.unit === null
      ? null
      : pathTerrainFilterForLocomotion(entity.unit.locomotion, entity.unit.mass);
  }

  // Get force accumulator for external force application (used by RtsScene)
  getForceAccumulator(): ForceAccumulator {
    return this.forceAccumulator;
  }

  // Units that received thrust during the latest movement pass.
  // Reference is valid until the next update(); callers must not mutate.
  getMovingUnits(): readonly Entity[] {
    return this._movingUnitsBuf;
  }

  // Advance to next action (with patrol loop support)
  private advanceAction(entity: Entity): void {
    if (!entity.unit) return;
    const unit = entity.unit;

    if (unit.actions.length === 0) return;

    const completedAction = unit.actions[0];

    // Check if we're in patrol mode and should loop
    if (completedAction.type === 'patrol' && unit.patrolStartIndex !== null) {
      // Move completed patrol action to end of queue (after all patrol actions)
      rotateFirstUnitActionToEnd(unit);
    } else if (unit.repeatQueue && hasQueuedActionIntents(unit.actions)) {
      const activeIntentEnd = getFirstActionIntentEnd(unit.actions);
      const actions = unit.actions;
      const repeatCount = activeIntentEnd + 1;
      this.rotateUnitActionsLeft(actions, repeatCount);
      refreshUnitActionHash(unit);
    } else {
      // Remove completed action
      shiftUnitAction(unit);

      // If we just finished the last non-patrol action and hit patrol section
      if (unit.actions.length > 0 && unit.actions[0].type === 'patrol') {
        unit.patrolStartIndex = 0;
      }
    }

    // Clear patrol start index if no more actions
    if (unit.actions.length === 0) {
      unit.patrolStartIndex = null;
    } else if (completedAction.type !== 'patrol') {
      const patrolStartIndex = unit.actions.findIndex((action) => action.type === 'patrol');
      unit.patrolStartIndex = patrolStartIndex >= 0 ? patrolStartIndex : null;
    }

    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }

  private rotateUnitActionsLeft(actions: UnitAction[], count: number): void {
    const length = actions.length;
    if (count <= 0 || count >= length) return;
    this.reverseUnitActionRange(actions, 0, count - 1);
    this.reverseUnitActionRange(actions, count, length - 1);
    this.reverseUnitActionRange(actions, 0, length - 1);
  }

  private reverseUnitActionRange(actions: UnitAction[], left: number, right: number): void {
    while (left < right) {
      const action = actions[left];
      actions[left] = actions[right];
      actions[right] = action;
      left++;
      right--;
    }
  }

  // Reset all session state (call between game sessions to free stale references)
  resetSessionState(): void {
    this.forceAccumulator.reset();
    this.eventQueues.reset();
    this.combatController.reset();
    this.deadEntityCleanup.reset();
    this.arrivalController.reset();
    this.flyingLoiter.reset();
    this.stuckReplanController.reset();
    this.combatHaltController.reset();
    this.unitActionPlanner.reset();
    this.world.clearPendingDeathCheckIds();
    resetEnergyBuffers(this.energyBuffers);
    this.spatialGridBuildingVersion = -1;
  }
}
