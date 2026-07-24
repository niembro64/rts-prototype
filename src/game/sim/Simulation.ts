import { WorldState } from './WorldState';
import { CommandQueue } from './commands';
import type { Entity, EntityId, PlayerId, Unit, UnitAction, UnitPathPoint } from './types';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { magnitude } from '../math';
import { executeCommand, SELF_DESTRUCT_COUNTDOWN_TICKS, type CommandContext } from './commandExecution';
import { distributeEnergy, createEnergyBuffers, resetEnergyBuffers, type EnergyBuffers } from './energyDistribution';
import { resourceMovementSystem } from './resourceMovement';
import {
  type SimEvent,
  type DeathContext,
  type ProjectileSpawnEvent,
  type ProjectileDespawnEvent,
  type ProjectileMotionUpdateEvent,
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
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_HP } from '@/types/network';
import type { GamePhase } from '@/types/network';
import { updateAiProduction } from './aiProduction';
import {
  expandPathPlan,
  isPathPlanTraversable,
  isPathSegmentTraversable,
  type ExpandedPathPlan,
} from './Pathfinder';
import {
  pathTerrainFilterCacheKey,
  pathTerrainFilterForLocomotion,
  type PathTerrainFilter,
} from './pathfindingTraversal';
import { getTerrainVersion, isWaterAt } from './Terrain';
import {
  PATHFINDING_CHASE_REPATH_COOLDOWN_TICKS,
  PATHFINDING_CHASE_REPATH_DRIFT_DISTANCE_FRACTION,
  PATHFINDING_CHASE_REPATH_DRIFT_MIN_WU,
  PATHFINDING_DIRECT_PLAN_MAX_DISTANCE_WU,
  PATHFINDING_PARTIAL_PLAN_RETRY_TICKS,
} from './pathfindingTuning';
import {
  PATH_REQUEST_FRESH,
  PATH_REQUEST_NONE,
  PATH_REQUEST_REFRESH,
  SimulationPathPlanScheduler,
} from './SimulationPathPlanScheduler';
import { getUnitLocomotionTraversalCapabilities } from './unitLocomotion';
import { updateBuildingActiveStates } from './buildingActiveState';
import { getEntityTargetPoint } from './buildingAnchors';
import { getGuardFollowRadius, isFriendlyGuardTarget, resolveGuardServiceTarget } from './guard';
import { getRecentHostileAttacker } from './aggression';
import { updateTransportActions } from './transports';
import { WindPowerTracker, sampleWindState, sampleWindStateInto, type WindState } from './wind';
import { entitySlotRegistry } from './EntitySlotRegistry';
import {
  clearMovementAnchorSatisfied,
  isMovementAnchorAction,
  isSatisfiedMovementAnchorAction,
  rotateFirstUnitActionToEnd,
  refreshUnitActionHash,
  refreshUnitActionHashPreservingActivePath,
  shiftUnitAction,
  unshiftUnitAction,
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
import { SimulationIdleBuilderAutoRepair } from './SimulationIdleBuilderAutoRepair';
import {
  ARRIVAL_RADIUS,
  SimulationArrivalController,
} from './SimulationArrivalController';
import { isBuildTargetInRange } from './builderRange';
import { isReclaimableTarget } from './reclaim';
import {
  SimulationFlyingLoiterController,
} from './SimulationFlyingLoiterController';
import { SimulationCombatHaltController } from './SimulationCombatHaltController';
import {
  REPLAN_COOLDOWN,
  REPLAN_FAILURE_COOLDOWN,
  SimulationStuckReplanController,
} from './SimulationStuckReplanController';
import {
  SimulationUnitActionPlanner,
  UNIT_ACTION_FLAG_COMBAT_STOP_ANY,
  UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT,
  UNIT_ACTION_FLAG_GUARD_FRIENDLY,
  UNIT_ACTION_FLAG_GUARD_SERVICE,
  UNIT_ACTION_FLAG_MOVE_STATE_HOLD,
  UNIT_ACTION_FLAG_MOVE_STATE_ROAM,
  UNIT_ACTION_FLAG_TARGET_PRESENT,
  UNIT_ACTION_FLAG_TRANSPORT_EMPTY,
  UNIT_ACTION_RANGE_KIND_BUILD,
  UNIT_ACTION_RANGE_KIND_GUARD_SERVICE,
  UNIT_ACTION_RANGE_KIND_LOAD,
  UNIT_ACTION_RANGE_KIND_NONE,
  UNIT_ACTION_PLAN_ATTACK_GROUND_HOLD,
  UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE,
  UNIT_ACTION_PLAN_ATTACK_HOLD,
  UNIT_ACTION_PLAN_ATTACK_MOVE,
  UNIT_ACTION_PLAN_BUILD_HOLD,
  UNIT_ACTION_PLAN_BUILD_MOVE,
  UNIT_ACTION_PLAN_FIGHT_PATROL_HOLD,
  UNIT_ACTION_PLAN_GUARD_ADVANCE,
  UNIT_ACTION_PLAN_GUARD_FOLLOW,
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
import {
  SimulationUnitActionMovementPlanner,
  UNIT_ACTION_MOVEMENT_DECISION_ADVANCE_PATH,
  UNIT_ACTION_MOVEMENT_DECISION_HOLD,
  UNIT_ACTION_MOVEMENT_DECISION_THRUST,
} from './SimulationUnitActionMovementPlanner';

type ActiveMovementTarget = UnitPathPoint & {
  isFinalActionPoint: boolean;
  /** Largest safe radius for advancing this transient point. Intermediate
   *  corners use the broad arrival radius only when the current position has
   *  a hard-clearance LOS to the following point. */
  pathAdvanceRadius: number;
};

type GatherWaitGroup = {
  key: string;
  groupId: number;
  members: Entity[];
};

type FormationRouteMetadata = {
  startX: number;
  startY: number;
  goalX: number;
  goalY: number;
  offsetX: number;
  offsetY: number;
  radius: number;
};

// ── Stuck-detection / replanning ─────────────────────────────────
//
// A unit that wants to move (thrust set) but isn't actually moving
// is a strong signal its current path is stale — terrain changed, an
// explosion knocked it sideways, or another unit is
// physically blocking the next waypoint. Replanning from the unit's
// CURRENT position to the trip's final destination produces a fresh
// route that respects the new world state.
//
// Replans aren't cheap (each is a bounded A* run), so ALL plan
// computations — new commands, chase-drift refreshes, and stuck
// replans — are funded from one SimulationPathPlanScheduler budget
// (fixed per player per tick plus a global ceiling, both lockstep
// constants). Requests past the budget queue and drain at the start
// of each movement pass; planless units drive an interim straight
// line toward the action point and stale-but-usable chase plans keep
// steering until their replacement is funded.

/** Action types the plan scheduler will serve — every dispatch case that
 *  resolves an active movement target. Hold/wait-style actions never
 *  consume plan budget; a queued request whose action changed to one of
 *  those is dropped at serve time. */
const PATH_PLAN_SERVE_ACTION_TYPES: ReadonlySet<UnitAction['type']> = new Set([
  'move',
  'fight',
  'patrol',
  'attack',
  'attackGround',
  'guard',
  'loadTransport',
  'unloadTransport',
  'build',
  'repair',
  'reclaim',
  'capture',
  'resurrect',
]);

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private constructionSystem: ConstructionSystem;
  private damageSystem: DamageSystem;
  private deathExplosionPlanner: SimulationDeathExplosionPlanner;
  private combatController: SimulationCombatController;
  private actionQueueMaintenance: SimulationActionQueueMaintenance;
  private idleBuilderAutoRepair: SimulationIdleBuilderAutoRepair;
  private deadEntityCleanup: SimulationDeadEntityCleanup;
  private arrivalController: SimulationArrivalController;
  private combatHaltController: SimulationCombatHaltController;
  private flyingLoiter: SimulationFlyingLoiterController;
  private stuckReplanController: SimulationStuckReplanController;
  private unitActionPlanner: SimulationUnitActionPlanner = new SimulationUnitActionPlanner();
  private unitActionMovementPlanner: SimulationUnitActionMovementPlanner = new SimulationUnitActionMovementPlanner();
  private forceAccumulator: ForceAccumulator = new ForceAccumulator();
  private readonly formationRouteCache = new Map<string, ExpandedPathPlan>();
  private readonly pathPlanScheduler = new SimulationPathPlanScheduler();
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
  private _movingUnitSlotsBuf: number[] = [];
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
    this.idleBuilderAutoRepair = new SimulationIdleBuilderAutoRepair(this.world);
    this.arrivalController = new SimulationArrivalController(this.world, {
      advanceAction: (entity) => this.advanceAction(entity),
      advanceActivePathPoint: (entity) => this.advanceActivePathPoint(entity),
      queueFlyingLoiter: (entity) => this.flyingLoiter.queue(entity),
    });
    this.combatHaltController = new SimulationCombatHaltController(this.world);
    this.flyingLoiter = new SimulationFlyingLoiterController(this.world);
    this.stuckReplanController = new SimulationStuckReplanController(
      (entity) => this.pathPlanScheduler.requestFresh(entity, true),
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

  // Get and clear pending projectile motion update events (double-buffered)
  getAndClearProjectileMotionUpdates(): ProjectileMotionUpdateEvent[] {
    return this.eventQueues.getAndClearProjectileMotionUpdates();
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

    // Fire due self-destruct countdowns AFTER command processing so a
    // Stop or re-toggle arriving on the fire tick wins the tie. The
    // zero-hp write routes the blast through the normal death path.
    this.fireDueSelfDestructs(tick);

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

    // BAR unit_auto_repair_idle_builders.lua parity: idle mobile builders
    // periodically take a nearby damaged allied unit, then return to the
    // recorded idle point when the repair finishes or becomes invalid.
    this.idleBuilderAutoRepair.update(tick);

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

  /** Hard validity: the plan belongs to this exact action and the unit can
   *  legally start from its current medium. Chase actions (live-target
   *  attack/guard) deliberately exclude the goal coordinates: per-tick
   *  approach re-aims are absorbed by drift-based refresh instead of
   *  invalidating the route outright. Terrain version is also soft — a
   *  stale-terrain route keeps steering while its replacement is funded. */
  private isActivePathHardValid(
    entity: Entity,
    unit: Unit,
    action: UnitAction,
    isChase: boolean,
  ): boolean {
    const plan = unit.activePath;
    if (plan === null) return false;
    if (!this.isUnitAtValidPathingStart(entity)) return false;
    if (plan.actionHash !== unit.actionHash) return false;
    if (
      plan.actionType !== action.type ||
      plan.targetId !== action.targetId ||
      plan.buildingId !== action.buildingId
    ) {
      return false;
    }
    if (isChase) return true;
    return plan.goalX === action.x && plan.goalY === action.y && plan.goalZ === action.z;
  }

  /** Soft staleness: keep steering on the current plan, but fund a newer
   *  one. Chase drift compares the live approach point against the goal the
   *  plan was actually computed toward (2D only — the planner is 2D; a
   *  bobbing target's z must never thrash routes), with a
   *  distance-proportional threshold and a per-unit cooldown. On the final
   *  leg the stale route has nothing left to give, so any drift past
   *  arrival tolerance repaths at cooldown cadence. */
  private activePathWantsRefresh(
    entity: Entity,
    plan: NonNullable<Unit['activePath']>,
    action: UnitAction,
    isChase: boolean,
    terrainVersion: number,
  ): boolean {
    if (plan.terrainVersion !== terrainVersion) return true;
    const age = this.world.getTick() - plan.plannedAtTick;
    if (isChase && age >= PATHFINDING_CHASE_REPATH_COOLDOWN_TICKS) {
      const drift = magnitude(action.x - plan.goalX, action.y - plan.goalY);
      const onFinalLeg = plan.index >= plan.points.length - 1;
      const threshold = onFinalLeg
        ? ARRIVAL_RADIUS
        : Math.max(
            PATHFINDING_CHASE_REPATH_DRIFT_MIN_WU,
            PATHFINDING_CHASE_REPATH_DRIFT_DISTANCE_FRACTION *
              magnitude(action.x - entity.transform.x, action.y - entity.transform.y),
          );
      if (drift > threshold) return true;
    }
    return plan.resolution === 'partial' && age >= PATHFINDING_PARTIAL_PLAN_RETRY_TICKS;
  }

  /** Cached routes remain usable from any physically move-valid surface.
   * Waypoint validity is intentionally irrelevant here: a physics displacement
   * may put a unit in a recovery-only medium from which it must path back. */
  private isUnitAtValidPathingStart(entity: Entity): boolean {
    const unit = entity.unit;
    if (unit === null) return false;
    const capabilities = getUnitLocomotionTraversalCapabilities(unit.locomotion).move;
    const overWater = isWaterAt(
      entity.transform.x,
      entity.transform.y,
      this.world.mapWidth,
      this.world.mapHeight,
    );
    return overWater
      ? capabilities.allowInWater || capabilities.allowInAir
      : capabilities.allowOnGround || capabilities.allowInAir;
  }

  private getFormationRouteMetadata(action: UnitAction): FormationRouteMetadata | null {
    const {
      formationRouteStartX,
      formationRouteStartY,
      formationRouteGoalX,
      formationRouteGoalY,
      formationRouteOffsetX,
      formationRouteOffsetY,
      formationRouteRadius,
    } = action;
    if (
      typeof formationRouteStartX !== 'number' ||
      typeof formationRouteStartY !== 'number' ||
      typeof formationRouteGoalX !== 'number' ||
      typeof formationRouteGoalY !== 'number' ||
      typeof formationRouteOffsetX !== 'number' ||
      typeof formationRouteOffsetY !== 'number' ||
      typeof formationRouteRadius !== 'number' ||
      !Number.isFinite(formationRouteStartX) ||
      !Number.isFinite(formationRouteStartY) ||
      !Number.isFinite(formationRouteGoalX) ||
      !Number.isFinite(formationRouteGoalY) ||
      !Number.isFinite(formationRouteOffsetX) ||
      !Number.isFinite(formationRouteOffsetY) ||
      !Number.isFinite(formationRouteRadius) ||
      formationRouteRadius <= 0
    ) {
      return null;
    }
    return {
      startX: formationRouteStartX,
      startY: formationRouteStartY,
      goalX: formationRouteGoalX,
      goalY: formationRouteGoalY,
      offsetX: formationRouteOffsetX,
      offsetY: formationRouteOffsetY,
      radius: formationRouteRadius,
    };
  }

  private formationRouteCacheKey(
    metadata: FormationRouteMetadata,
    terrainVersion: number,
    filter: PathTerrainFilter | null,
  ): string {
    return [
      terrainVersion,
      this.world.slopePathMode,
      pathTerrainFilterCacheKey(filter),
      metadata.radius,
      metadata.startX,
      metadata.startY,
      metadata.goalX,
      metadata.goalY,
    ].join(':');
  }

  private clampPathX(x: number): number {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(this.world.mapWidth, x));
  }

  private clampPathY(y: number): number {
    if (!Number.isFinite(y)) return 0;
    return Math.max(0, Math.min(this.world.mapHeight, y));
  }

  private offsetFormationRoutePlan(
    points: readonly UnitPathPoint[],
    offsetX: number,
    offsetY: number,
    resolution: ExpandedPathPlan['resolution'],
  ): ExpandedPathPlan {
    const out = new Array<UnitPathPoint>(points.length);
    for (let i = 0; i < points.length; i++) {
      const x = this.clampPathX(points[i].x + offsetX);
      const y = this.clampPathY(points[i].y + offsetY);
      out[i] = {
        x,
        y,
        z: this.world.getTerrainBedZ(x, y),
      };
    }
    return { points: out, resolution };
  }

  private expandFormationRoutePoints(
    action: UnitAction,
    metadata: FormationRouteMetadata,
    terrainVersion: number,
    terrainFilter: PathTerrainFilter | null,
    entity: Entity,
  ): ExpandedPathPlan | null {
    const key = this.formationRouteCacheKey(
      metadata,
      terrainVersion,
      terrainFilter,
    );
    let anchorPlan = this.formationRouteCache.get(key);
    if (anchorPlan === undefined) {
      if (this.formationRouteCache.size > 256) this.formationRouteCache.clear();
      anchorPlan = expandPathPlan(
        metadata.startX,
        metadata.startY,
        metadata.goalX,
        metadata.goalY,
        this.world.mapWidth,
        this.world.mapHeight,
        action.z ?? null,
        terrainFilter,
        metadata.radius,
        this.world.slopePathMode === 'symmetric',
      );
      this.formationRouteCache.set(key, anchorPlan);
    }
    const translated = this.offsetFormationRoutePlan(
      anchorPlan.points,
      metadata.offsetX,
      metadata.offsetY,
      anchorPlan.resolution,
    );
    const translatedFinal = translated.points[translated.points.length - 1];
    if (
      translated.resolution === 'complete' &&
      (translatedFinal === undefined || translatedFinal.x !== action.x || translatedFinal.y !== action.y)
    ) {
      translated.resolution = 'snapped';
    }
    const unit = entity.unit;
    if (unit === null) return null;
    return isPathPlanTraversable(
      entity.transform.x,
      entity.transform.y,
      translated.points,
      this.world.mapWidth,
      this.world.mapHeight,
      terrainFilter,
      unit.radius.collision,
      this.world.slopePathMode === 'symmetric',
    )
      ? translated
      : null;
  }

  /** Resolve the active plan for the current action under the per-tick plan
   *  budget. Hard-valid plans return immediately (with a possible funded or
   *  queued refresh); everything else is funded synchronously while budget
   *  remains this tick, or queued — planless units drive an interim straight
   *  line toward the action point (the null-plan fallback in
   *  resolveActiveMovementTarget) until their request is served. */
  private ensureActivePathPlan(entity: Entity, action: UnitAction): Unit['activePath'] {
    const unit = entity.unit;
    if (!unit) return null;

    const terrainVersion = getTerrainVersion();
    const isChase =
      action.targetId !== undefined &&
      (action.type === 'attack' || action.type === 'guard');

    if (this.isActivePathHardValid(entity, unit, action, isChase)) {
      const plan = unit.activePath as NonNullable<Unit['activePath']>;
      if (
        unit.pathRequestLane === PATH_REQUEST_NONE &&
        this.activePathWantsRefresh(entity, plan, action, isChase, terrainVersion)
      ) {
        // Stale-but-usable: a short validated straight segment replaces it
        // for free, a budget slot replaces it now, otherwise the refresh
        // lane replaces it in a coming tick — steering continues on the
        // stale plan meanwhile.
        const direct = this.tryInstallDirectPathPlan(entity, unit, action, terrainVersion);
        if (direct !== null) return direct;
        if (this.pathPlanScheduler.tryCharge(entity)) {
          return this.computeAndInstallActivePathPlan(entity, action, false);
        }
        this.pathPlanScheduler.requestRefresh(entity);
      }
      return unit.activePath;
    }

    const hadPlan = unit.activePath !== null;
    if (hadPlan) {
      unit.activePath = null;
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
    }
    if (unit.pathRequestLane === PATH_REQUEST_FRESH) return null;
    if (unit.pathRequestLane === PATH_REQUEST_REFRESH) {
      // The queued refresh was for a plan that no longer exists; promote it
      // to fresh priority (the superseded entry is skipped at serve time).
      this.pathPlanScheduler.requestFresh(entity, false);
      return null;
    }

    // Formation corridor first: cache hits are translate+validate only and
    // cost no plan budget; only the shared anchor's A* consumes a slot.
    const formationRoute = !hadPlan ? this.getFormationRouteMetadata(action) : null;
    if (formationRoute !== null) {
      const terrainFilter = this.pathTerrainFilterForUnit(entity);
      const cacheKey = this.formationRouteCacheKey(formationRoute, terrainVersion, terrainFilter);
      if (this.formationRouteCache.has(cacheKey) || this.pathPlanScheduler.tryCharge(entity)) {
        const translated = this.expandFormationRoutePoints(
          action,
          formationRoute,
          terrainVersion,
          terrainFilter,
          entity,
        );
        if (translated !== null) {
          return this.installActivePathPlan(entity, unit, action, translated, terrainVersion);
        }
        // Translation failed validation — fall through to a local plan.
      } else {
        this.pathPlanScheduler.requestFresh(entity, false);
        return null;
      }
    }

    const direct = this.tryInstallDirectPathPlan(entity, unit, action, terrainVersion);
    if (direct !== null) return direct;

    if (this.pathPlanScheduler.tryCharge(entity)) {
      return this.computeAndInstallActivePathPlan(entity, action, false);
    }
    this.pathPlanScheduler.requestFresh(entity, false);
    return null;
  }

  /** Compute and install a plan for the current action NOW. Callers own the
   *  budget decision (a tryCharge slot or a drained queue entry). */
  private computeAndInstallActivePathPlan(
    entity: Entity,
    action: UnitAction,
    forceLocalPlan: boolean,
  ): Unit['activePath'] {
    const unit = entity.unit;
    if (!unit) return null;

    const terrainVersion = getTerrainVersion();
    const terrainFilter = this.pathTerrainFilterForUnit(entity);
    const formationRoute = !forceLocalPlan && unit.activePath === null
      ? this.getFormationRouteMetadata(action)
      : null;
    let pathPlan = formationRoute !== null
      ? this.expandFormationRoutePoints(
          action,
          formationRoute,
          terrainVersion,
          terrainFilter,
          entity,
        )
      : null;
    if (pathPlan === null) {
      pathPlan = expandPathPlan(
        entity.transform.x,
        entity.transform.y,
        action.x,
        action.y,
        this.world.mapWidth,
        this.world.mapHeight,
        action.z ?? null,
        terrainFilter,
        unit.radius.collision,
        this.world.slopePathMode === 'symmetric',
      );
    }
    return this.installActivePathPlan(entity, unit, action, pathPlan, terrainVersion);
  }

  /** Try to complete the plan as one validated straight segment. The WASM
   *  validator runs the exact traversal rules the planner uses (move-domain
   *  edges, waypoint-domain endpoint), so a passing segment IS the finished
   *  route — no A*, no plan budget. Distance-gated so a long legal-but-slow
   *  beeline can't shadow a genuinely cheaper A* route around terrain. */
  private tryInstallDirectPathPlan(
    entity: Entity,
    unit: Unit,
    action: UnitAction,
    terrainVersion: number,
  ): Unit['activePath'] {
    const directDistance = magnitude(
      action.x - entity.transform.x,
      action.y - entity.transform.y,
    );
    if (directDistance > PATHFINDING_DIRECT_PLAN_MAX_DISTANCE_WU) return null;
    const direct: UnitPathPoint = {
      x: action.x,
      y: action.y,
      z: action.z ?? this.world.getTerrainBedZ(action.x, action.y),
    };
    if (
      !isPathSegmentTraversable(
        entity.transform.x,
        entity.transform.y,
        direct,
        this.world.mapWidth,
        this.world.mapHeight,
        this.pathTerrainFilterForUnit(entity),
        unit.radius.collision,
        this.world.slopePathMode === 'symmetric',
      )
    ) {
      return null;
    }
    return this.installActivePathPlan(
      entity,
      unit,
      action,
      { points: [direct], resolution: 'complete' },
      terrainVersion,
    );
  }

  private installActivePathPlan(
    entity: Entity,
    unit: Unit,
    action: UnitAction,
    pathPlan: ExpandedPathPlan,
    terrainVersion: number,
  ): NonNullable<Unit['activePath']> {
    unit.activePath = {
      points: pathPlan.points,
      resolution: pathPlan.resolution,
      index: 0,
      actionHash: unit.actionHash,
      terrainVersion,
      plannedAtTick: this.world.getTick(),
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

  /** Serve one queued plan request against live state. Returns true when a
   *  plan computation actually ran (charging the entry against the tick's
   *  budgets); stale entries — dead units, superseded lanes, actions that
   *  no longer move — are skipped for free. */
  private readonly servePathPlanRequest = (entityId: EntityId, lane: number): boolean => {
    const entity = this.world.getEntity(entityId);
    if (entity === undefined) return false;
    const unit = entity.unit;
    if (unit === null || unit.hp <= 0) return false;
    if (unit.pathRequestLane !== lane) return false;
    unit.pathRequestLane = PATH_REQUEST_NONE;
    const forceLocal = unit.pathRequestForceLocal;
    unit.pathRequestForceLocal = false;
    const action = unit.actions[0];
    if (action === undefined || !PATH_PLAN_SERVE_ACTION_TYPES.has(action.type)) return false;
    if (forceLocal) {
      // Stuck-replan semantics: plan from the live position, keep the old
      // route when the planner collapses to a worse stay-put fallback, and
      // hold detection quiet through the replan cooldown either way.
      unit.stuckTicks = this.tryReplan(entity) ? REPLAN_COOLDOWN : REPLAN_FAILURE_COOLDOWN;
      return true;
    }
    const terrainVersion = getTerrainVersion();
    if (this.tryInstallDirectPathPlan(entity, unit, action, terrainVersion) !== null) {
      // A validated straight segment costs no A*; don't charge the slot.
      return false;
    }
    this.computeAndInstallActivePathPlan(entity, action, false);
    return true;
  };

  private resolveActiveMovementTarget(entity: Entity, action: UnitAction): ActiveMovementTarget {
    const plan = this.ensureActivePathPlan(entity, action);
    if (plan === null || plan.points.length === 0) {
      return {
        x: action.x,
        y: action.y,
        z: action.z,
        isFinalActionPoint: true,
        pathAdvanceRadius: ARRIVAL_RADIUS,
      };
    }

    const startIndex = plan.index;
    while (plan.index < plan.points.length - 1) {
      const point = plan.points[plan.index];
      const dx = point.x - entity.transform.x;
      const dy = point.y - entity.transform.y;
      if (magnitude(dx, dy) > ARRIVAL_RADIUS) break;
      const nextPoint = plan.points[plan.index + 1];
      if (!this.isDirectPathPointReachable(entity, nextPoint)) break;
      plan.index++;
    }
    // Advancing past a preview point shrinks the serialized route; re-mark
    // actions so selected-unit waypoint visuals follow the unit forward.
    if (plan.index !== startIndex) {
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
    }

    const point = plan.points[plan.index];
    const isFinalActionPoint = plan.index >= plan.points.length - 1;
    const pointDx = point.x - entity.transform.x;
    const pointDy = point.y - entity.transform.y;
    const closeEnoughForBroadAdvance = magnitude(pointDx, pointDy) <= ARRIVAL_RADIUS;
    const pathAdvanceRadius = isFinalActionPoint || (
      closeEnoughForBroadAdvance &&
      this.isDirectPathPointReachable(entity, plan.points[plan.index + 1])
    ) ? ARRIVAL_RADIUS : 1;
    return {
      x: point.x,
      y: point.y,
      z: point.z,
      isFinalActionPoint,
      pathAdvanceRadius,
    };
  }

  private isDirectPathPointReachable(entity: Entity, point: UnitPathPoint): boolean {
    const unit = entity.unit;
    if (unit === null) return false;
    return isPathSegmentTraversable(
      entity.transform.x,
      entity.transform.y,
      point,
      this.world.mapWidth,
      this.world.mapHeight,
      this.pathTerrainFilterForUnit(entity),
      unit.radius.collision,
      this.world.slopePathMode === 'symmetric',
    );
  }

  private queueMovementCompletion(
    entity: Entity,
    action: UnitAction,
    target: ActiveMovementTarget,
    dx: number,
    dy: number,
  ): void {
    if (!target.isFinalActionPoint && target.pathAdvanceRadius < ARRIVAL_RADIUS) {
      const distance = magnitude(dx, dy);
      if (distance <= target.pathAdvanceRadius) {
        this.advanceActivePathPoint(entity);
      } else {
        this.arrivalController.queueThrust(entity, action, dx, dy, distance, false);
      }
      return;
    }
    this.arrivalController.queueCompletion(
      entity,
      action,
      dx,
      dy,
      target.isFinalActionPoint,
    );
  }

  private refreshPatrolStartIndex(unit: Unit): void {
    const patrolStartIndex = unit.actions.findIndex((action) => action.type === 'patrol');
    unit.patrolStartIndex = patrolStartIndex >= 0 ? patrolStartIndex : null;
  }

  private findPatrolReclaimTarget(builder: Entity): Entity | null {
    const playerId = builder.ownership?.playerId;
    if (playerId === undefined) return null;
    let best: Entity | null = null;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    const consider = (target: Entity): void => {
      if (!isReclaimableTarget(target) || target.id === builder.id) return;
      const targetPlayerId = target.ownership?.playerId;
      if (
        targetPlayerId !== undefined &&
        this.world.arePlayersAllied(playerId, targetPlayerId)
      ) return;
      if (!isBuildTargetInRange(builder, target)) return;
      const dx = target.transform.x - builder.transform.x;
      const dy = target.transform.y - builder.transform.y;
      const distanceSq = dx * dx + dy * dy;
      if (
        distanceSq < bestDistanceSq ||
        (distanceSq === bestDistanceSq && (best === null || target.id < best.id))
      ) {
        best = target;
        bestDistanceSq = distanceSq;
      }
    };
    const units = this.world.getUnits();
    for (let i = 0; i < units.length; i++) consider(units[i]);
    const buildings = this.world.getBuildings();
    for (let i = 0; i < buildings.length; i++) consider(buildings[i]);
    return best;
  }

  private handleSatisfiedMovementAnchor(entity: Entity, currentAction: UnitAction): boolean {
    const unit = entity.unit;
    if (!unit || !isSatisfiedMovementAnchorAction(currentAction)) return false;

    if (hasQueuedActionIntents(unit.actions)) {
      shiftUnitAction(unit);
      this.refreshPatrolStartIndex(unit);
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      return true;
    }

    const dx = currentAction.x - entity.transform.x;
    const dy = currentAction.y - entity.transform.y;
    if (magnitude(dx, dy) > ARRIVAL_RADIUS) {
      clearMovementAnchorSatisfied(currentAction);
      unit.activePath = null;
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      return false;
    }

    unit.activePath = null;
    unit.stuckTicks = 0;
    entitySlotRegistry.setUnitDriveInput(entity, 0, 0, 0, 0, entity.entitySlotId);
    return true;
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
    // Approach re-aim, not a queue edit: the active plan survives and its
    // hash re-syncs. Route freshness for chases is governed by drift
    // against the plan's stamped goal (activePathWantsRefresh), not by
    // discarding a whole A* route every time the target moves a step.
    refreshUnitActionHashPreservingActivePath(entity.unit);
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
  // unit.thrustDirX/Y is mirrored into native entity-state drive input for
  // UnitForceSystem — a (0, 0) means "no powered thrust this tick"; vector
  // magnitude scales maximum propulsive force. The authoritative physics velocity stays in
  // unit.velocityX/Y/Z and is only overwritten by syncFromPhysics, so
  // lead-prediction in turretSystem reads the real velocity, not this thrust
  // target.
  /** Detonate armed self-destructs whose countdown expired. Entries
   *  whose entity died or vanished by other means are dropped lazily
   *  here. Map iteration is insertion-ordered and the map is only
   *  mutated by deterministic commands + this pass, so peers agree. */
  private fireDueSelfDestructs(tick: number): void {
    const armed = this.world.armedSelfDestructs;
    if (armed.size === 0) return;
    for (const [entityId, fireTick] of armed) {
      const entity = this.world.getEntity(entityId);
      if (entity === undefined) {
        armed.delete(entityId);
        continue;
      }
      const hpState = entity.unit !== null ? entity.unit : entity.building;
      if (hpState === null || hpState.hp <= 0) {
        armed.delete(entityId);
        continue;
      }
      if (tick < fireTick) continue;
      // Zero hp routes through the shared pendingDeathCheck cleanup,
      // which emits the death event + explosion like normal damage.
      hpState.hp = 0;
      this.world.markSnapshotDirty(entityId, ENTITY_CHANGED_HP);
      armed.delete(entityId);
    }
  }

  private emitSelfDestructEvent(entity: Entity, armed: boolean): void {
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
    if (this.onSimEvent !== null) this.onSimEvent(event);
    this.eventQueues.simEvents.push(event);
  }

  private toggleSelfDestructCountdown(entity: Entity): void {
    const hpState = entity.unit !== null ? entity.unit : entity.building;
    if (hpState === null || hpState.hp <= 0) {
      this.world.armedSelfDestructs.delete(entity.id);
      return;
    }
    if (this.world.armedSelfDestructs.has(entity.id)) {
      this.world.armedSelfDestructs.delete(entity.id);
      this.emitSelfDestructEvent(entity, false);
    } else {
      this.world.armedSelfDestructs.set(entity.id, this.world.getTick() + SELF_DESTRUCT_COUNTDOWN_TICKS);
      this.emitSelfDestructEvent(entity, true);
    }
  }

  private activateQueuedSelfDestructAction(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null) return;
    this.toggleSelfDestructCountdown(entity);
    shiftUnitAction(unit);
    const patrolStartIndex = unit.actions.findIndex((action) => action.type === 'patrol');
    unit.patrolStartIndex = patrolStartIndex >= 0 ? patrolStartIndex : null;
    unit.activePath = null;
    unit.stuckTicks = 0;
    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }

  private updateUnits(dtSec: number): void {
    const movingUnits = this._movingUnitsBuf;
    movingUnits.length = 0;
    this.arrivalController.beginFrame();
    this.combatHaltController.prepare();
    this.releaseReadyGatherWaits();

    // Reset this tick's plan budgets, then serve queued path requests first
    // so freshly funded routes are consumed by this same movement pass.
    // Whatever budget the drain leaves over funds synchronous dispatch-time
    // planning below; the overflow queues for coming ticks.
    this.pathPlanScheduler.beginTick();
    this.pathPlanScheduler.drain(this.world.getTick(), this.servePathPlanRequest);

    const units = this.world.getUnits();
    const planner = this.unitActionPlanner;
    planner.begin(units.length);
    // Sync every unit's canonical slot state before flag gathering so the
    // native plan batch reads current slab positions for actors AND their
    // range targets (Phase 1 never mutates positions, so hoisting the
    // sweep is behavior-identical to the old interleaved order).
    for (let i = 0; i < units.length; i++) {
      spatialGrid.updateUnitSpatial(units[i]);
    }
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (!entity.unit) continue;

      const { unit } = entity;
      const entitySlot = entity.entitySlotId;
      if (!entity.body) {
        if (
          unit.hp > 0 &&
          !isBuildBlockingActivation(entity.buildable) &&
          unit.actions[0]?.type === 'selfDestruct'
        ) {
          this.activateQueuedSelfDestructAction(entity);
        }
        continue;
      }

      // Construction shells do not execute player actions or acquire
      // combat priority while incomplete, but their physics body remains
      // live. UnitForceSystem still applies contact locomotion/friction
      // so shells can fall, collide, and settle like ordinary units
      // before activation.
      if (isBuildBlockingActivation(entity.buildable)) {
        entitySlotRegistry.setUnitDriveInput(entity, 0, 0, 0, 0, entitySlot);
        if (entity.combat) {
          entity.combat.priorityTargetId = null;
          entity.combat.priorityTargetPoint = null;
          entity.combat.manualLaunchActive = false;
        }
        continue;
      }

      if (unit.hp <= 0) {
        entitySlotRegistry.setUnitDriveInput(entity, 0, 0, 0, 0, entitySlot);
        unit.stuckTicks = 0;
        if (entity.combat) {
          entity.combat.priorityTargetId = null;
          entity.combat.priorityTargetPoint = null;
          entity.combat.manualLaunchActive = false;
        }
        continue;
      }

      // Default: no thrust (contact braking/drag will slow or hold the unit)
      entitySlotRegistry.setUnitDriveInput(entity, 0, 0, 0, 0, entitySlot);

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

      // No actions - profiles with continuous idle air drive keep circling
      // their last destination, independent of their visual rig.
      if (unit.actions.length === 0) {
        if (!unit.locomotion.motionControl.cruiseWhenUncommanded) {
          unit.activePath = null;
          unit.stuckTicks = 0;
          continue;
        }
        planner.queue(entity, undefined, 0);
        continue;
      }

      this.actionQueueMaintenance.promoteReachableBuildAction(entity);

      // BAR constructor Patrol services nearby allies first (the energy pass
      // marks that above), then temporarily reclaims a nearby non-allied
      // entity before resuming its loop. The durable Patrol remains on the
      // host queue; turret locks are not used to choose construction work.
      let currentAction = unit.actions[0];
      if (
        currentAction.type === 'patrol' &&
        entity.builder !== null &&
        !this.energyBuffers.sweepServicingBuilderIds.has(entity.id)
      ) {
        const reclaimTarget = this.findPatrolReclaimTarget(entity);
        if (reclaimTarget !== null) {
          const targetPoint = getEntityTargetPoint(reclaimTarget);
          unshiftUnitAction(unit, {
            type: 'reclaim',
            x: targetPoint.x,
            y: targetPoint.y,
            z: targetPoint.z,
            targetId: reclaimTarget.id,
          });
          this.refreshPatrolStartIndex(unit);
          unit.activePath = null;
          currentAction = unit.actions[0];
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
        }
      }
      if (currentAction.type === 'selfDestruct') {
        this.activateQueuedSelfDestructAction(entity);
        continue;
      }
      if (this.handleSatisfiedMovementAnchor(entity, currentAction)) {
        continue;
      }
      this.flyingLoiter.rememberTarget(unit, currentAction);

      let flags = 0;
      let serviceTarget: Entity | null = null;
      // In-range checks resolve natively inside the plan batch from the
      // entity-state slab; Phase 1 only names the target slot and range.
      let rangeKind: number = UNIT_ACTION_RANGE_KIND_NONE;
      let rangeTargetSlot = -1;
      let rangeParam = 0;
      if (unit.moveState === 'roam') flags |= UNIT_ACTION_FLAG_MOVE_STATE_ROAM;
      if (unit.moveState === 'holdPosition') flags |= UNIT_ACTION_FLAG_MOVE_STATE_HOLD;

      if (currentAction.type === 'loadTransport') {
        if (currentAction.targetId !== undefined) {
          rangeKind = UNIT_ACTION_RANGE_KIND_LOAD;
          rangeTargetSlot = entitySlotRegistry.getSlot(currentAction.targetId);
        }
      } else if (currentAction.type === 'unloadTransport') {
        if (entity.transport?.loadedUnits.length === 0) {
          flags |= UNIT_ACTION_FLAG_TRANSPORT_EMPTY;
        }
      } else if (
        currentAction.type === 'build' ||
        currentAction.type === 'repair' ||
        currentAction.type === 'reclaim' ||
        currentAction.type === 'capture' ||
        currentAction.type === 'resurrect'
      ) {
        const targetId = currentAction.type === 'build'
          ? currentAction.buildingId
          : currentAction.targetId;
        if (targetId !== undefined) {
          rangeKind = UNIT_ACTION_RANGE_KIND_BUILD;
          rangeTargetSlot = entitySlotRegistry.getSlot(targetId);
          rangeParam = entity.builder !== null ? entity.builder.buildRange : 0;
        }
      } else if (currentAction.type === 'attack') {
        if (currentAction.targetId !== undefined) {
          flags |= UNIT_ACTION_FLAG_TARGET_PRESENT;
          // Set priority target for turret system.
          if (entity.combat && !entity.combat.manualLaunchActive) {
            entity.combat.priorityTargetId = currentAction.targetId;
          }
          // Attack Unit is a live entity intent, not a move to the point where
          // the target happened to be when the order was issued. Refresh the
          // durable approach point before path planning so movement and the
          // host-overridden turret consume the same target on this tick.
          const attackTarget = this.world.getEntity(currentAction.targetId);
          if (attackTarget !== undefined) {
            this.tryRefreshAttackApproach(
              entity,
              currentAction,
              getEntityTargetPoint(attackTarget),
            );
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
        const guardOwnerId = entity.ownership?.playerId;
        const isFriendlyGuard =
          guardOwnerId !== undefined &&
          isFriendlyGuardTarget(guardTarget, guardOwnerId, (a, b) => this.world.arePlayersAllied(a, b));
        if (isFriendlyGuard) {
          flags |= UNIT_ACTION_FLAG_GUARD_FRIENDLY;

          // Active defend (BAR): retaliate against the hostile root host that
          // recently damaged the protected ally. Do not copy the ally's own
          // attack order: guarding and focus-firing are distinct intents.
          if (entity.combat !== null && !entity.combat.manualLaunchActive) {
            entity.combat.priorityTargetId = getRecentHostileAttacker(
              this.world,
              guardTarget,
              guardOwnerId,
              this.world.getTick(),
            )?.id ?? null;
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
              rangeKind = UNIT_ACTION_RANGE_KIND_GUARD_SERVICE;
              rangeTargetSlot = entitySlotRegistry.getSlot(service.target.id);
              rangeParam = entity.builder.buildRange;
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
        // BAR patrol-service: the energy pass (which ran earlier this
        // tick) marked this builder as funding a sweep assist/heal —
        // hold it in place while it services, then resume the leg.
        if (
          entity.builder !== null &&
          this.energyBuffers.sweepServicingBuilderIds.has(entity.id)
        ) {
          flags |= UNIT_ACTION_FLAG_GUARD_SERVICE;
        }
      }

      planner.queue(
        entity,
        currentAction,
        flags,
        serviceTarget,
        rangeKind,
        rangeTargetSlot,
        rangeParam,
      );
    }

    const planCount = planner.compute();
    const movementPlanner = this.unitActionMovementPlanner;
    movementPlanner.begin(planCount);
    for (let i = 0; i < planCount; i++) {
      const entity = planner.entityAt(i);
      const unit = entity.unit;
      if (!unit || !entity.body) continue;
      const transform = entity.transform;
      const currentAction = planner.actionAt(i);
      const entitySlot = entity.entitySlotId >= 0
        ? entity.entitySlotId
        : spatialGrid.getEntitySlot(entity);

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
          movementPlanner.queue(
            entity,
            currentAction,
            UNIT_ACTION_PLAN_LOAD_MOVE,
            entitySlot,
            movementTarget.x,
            movementTarget.y,
            Math.min(1, movementTarget.pathAdvanceRadius),
            movementTarget.isFinalActionPoint,
          );
          break;
        }

        case UNIT_ACTION_PLAN_UNLOAD_MOVE: {
          if (currentAction === undefined) break;
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          movementPlanner.queue(
            entity,
            currentAction,
            UNIT_ACTION_PLAN_UNLOAD_MOVE,
            entitySlot,
            movementTarget.x,
            movementTarget.y,
            Math.min(15, movementTarget.pathAdvanceRadius),
            movementTarget.isFinalActionPoint,
          );
          break;
        }

        case UNIT_ACTION_PLAN_BUILD_MOVE: {
          if (currentAction === undefined) break;
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          movementPlanner.queue(
            entity,
            currentAction,
            UNIT_ACTION_PLAN_BUILD_MOVE,
            entitySlot,
            movementTarget.x,
            movementTarget.y,
            Math.min(1, movementTarget.pathAdvanceRadius),
            movementTarget.isFinalActionPoint,
          );
          break;
        }

        case UNIT_ACTION_PLAN_ATTACK_MOVE: {
          if (currentAction === undefined) break;
          if (currentAction.type !== 'attack' || currentAction.targetId === undefined) {
            const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
            this.queueMovementCompletion(
              entity,
              currentAction,
              movementTarget,
              movementTarget.x - transform.x,
              movementTarget.y - transform.y,
            );
            break;
          }
          const attackTarget = this.world.getEntity(currentAction.targetId);
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          if (attackTarget === undefined) {
            unit.stuckTicks = 0;
            break;
          }
          movementPlanner.queue(
            entity,
            currentAction,
            UNIT_ACTION_PLAN_ATTACK_MOVE,
            entitySlot,
            movementTarget.x,
            movementTarget.y,
            Math.min(15, movementTarget.pathAdvanceRadius),
            movementTarget.isFinalActionPoint,
          );
          break;
        }

        case UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE: {
          if (currentAction === undefined) break;
          const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
          movementPlanner.queue(
            entity,
            currentAction,
            UNIT_ACTION_PLAN_ATTACK_GROUND_MOVE,
            entitySlot,
            movementTarget.x,
            movementTarget.y,
            Math.min(15, movementTarget.pathAdvanceRadius),
            movementTarget.isFinalActionPoint,
          );
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
          movementPlanner.queue(
            entity,
            currentAction,
            UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE,
            entitySlot,
            sp.x,
            sp.y,
            15,
            true,
          );
          break;
        }

        case UNIT_ACTION_PLAN_GUARD_FOLLOW: {
          if (currentAction === undefined || currentAction.type !== 'guard' || currentAction.targetId === undefined) break;
          const guardTarget = this.world.getEntity(currentAction.targetId);
          if (
            !entity.ownership ||
            !isFriendlyGuardTarget(
              guardTarget,
              entity.ownership.playerId,
              (a, b) => this.world.arePlayersAllied(a, b),
            )
          ) {
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
          movementPlanner.queue(
            entity,
            currentAction,
            UNIT_ACTION_PLAN_GUARD_FOLLOW,
            entitySlot,
            movementTarget.x,
            movementTarget.y,
            Math.min(15, movementTarget.pathAdvanceRadius),
            movementTarget.isFinalActionPoint,
          );
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
          this.queueMovementCompletion(
            entity,
            currentAction,
            movementTarget,
            dx,
            dy,
          );
          break;
        }
      }
    }

    const movementCount = movementPlanner.compute();
    for (let i = 0; i < movementCount; i++) {
      const entity = movementPlanner.entityAt(i);
      const unit = entity.unit;
      if (!unit || !entity.body) continue;
      const action = movementPlanner.actionAt(i);
      const decision = movementPlanner.decisionAt(i);

      if (decision === UNIT_ACTION_MOVEMENT_DECISION_THRUST) {
        this.arrivalController.queueThrust(
          entity,
          action,
          movementPlanner.dxAt(i),
          movementPlanner.dyAt(i),
          movementPlanner.distanceAt(i),
          movementPlanner.isFinalActionPointAt(i),
        );
        continue;
      }

      if (decision === UNIT_ACTION_MOVEMENT_DECISION_ADVANCE_PATH) {
        this.advanceActivePathPoint(entity);
        unit.stuckTicks = 0;
        continue;
      }

      if (decision === UNIT_ACTION_MOVEMENT_DECISION_HOLD) {
        if (movementPlanner.planAt(i) === UNIT_ACTION_PLAN_ATTACK_MOVE) {
          if ((unit.stuckTicks ?? 0) < 0) {
            unit.stuckTicks = (unit.stuckTicks ?? 0) + 1;
            continue;
          }
          if (action.type !== 'attack' || action.targetId === undefined) {
            unit.stuckTicks = 0;
            continue;
          }
          const attackTarget = this.world.getEntity(action.targetId);
          if (attackTarget === undefined) {
            unit.stuckTicks = 0;
            continue;
          }
          const targetPoint = getEntityTargetPoint(attackTarget);
          if (!this.tryRefreshAttackApproach(entity, action, targetPoint)) {
            unit.stuckTicks = REPLAN_FAILURE_COOLDOWN;
            continue;
          }
        } else if (movementPlanner.planAt(i) === UNIT_ACTION_PLAN_GUARD_FOLLOW) {
          if (action.type !== 'guard' || action.targetId === undefined) {
            unit.stuckTicks = 0;
            continue;
          }
          const guardTarget = this.world.getEntity(action.targetId);
          if (
            !entity.ownership ||
            !isFriendlyGuardTarget(
              guardTarget,
              entity.ownership.playerId,
              (a, b) => this.world.arePlayersAllied(a, b),
            )
          ) {
            this.advanceAction(entity);
            unit.stuckTicks = 0;
            continue;
          }
          const targetPoint = getEntityTargetPoint(guardTarget);
          if (this.tryRefreshGuardApproach(entity, action, targetPoint)) {
            unit.stuckTicks = 0;
            continue;
          }
          const targetDx = targetPoint.x - entity.transform.x;
          const targetDy = targetPoint.y - entity.transform.y;
          this.arrivalController.queueThrust(
            entity,
            action,
            targetDx,
            targetDy,
            magnitude(targetDx, targetDy),
          );
          continue;
        }
        unit.stuckTicks = 0;
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
    this.refreshMovingUnitSlots(movingUnits);
  }

  private refreshMovingUnitSlots(movingUnits: readonly Entity[]): void {
    const slots = this._movingUnitSlotsBuf;
    slots.length = movingUnits.length;
    for (let i = 0; i < movingUnits.length; i++) {
      const entity = movingUnits[i];
      slots[i] = entity.entitySlotId >= 0
        ? entity.entitySlotId
        : entitySlotRegistry.getEntitySlot(entity);
    }
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
      action.type !== 'patrol' &&
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
    const nextPath = this.computeAndInstallActivePathPlan(entity, action, true);
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
      : pathTerrainFilterForLocomotion(
          entity.unit.locomotion,
          entity.unit.mass,
          entity.unit.supportPointOffsetZ,
        );
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

  getMovingUnitSlots(): readonly number[] {
    return this._movingUnitSlotsBuf;
  }

  // Advance to next action (with patrol loop support)
  private advanceAction(entity: Entity): void {
    if (!entity.unit) return;
    const unit = entity.unit;

    if (unit.actions.length === 0) return;

    const completedAction = unit.actions[0];

    if (unit.actions.length === 1 && isMovementAnchorAction(completedAction)) {
      completedAction.movementAnchorSatisfied = true;
      unit.activePath = null;
      unit.stuckTicks = 0;
      entitySlotRegistry.setUnitDriveInput(entity, 0, 0, 0, 0, entity.entitySlotId);
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      return;
    }

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
    this.pathPlanScheduler.reset();
    this.combatHaltController.reset();
    this.idleBuilderAutoRepair.reset();
    this.unitActionPlanner.reset();
    this.unitActionMovementPlanner.reset();
    this.world.clearPendingDeathCheckIds();
    resetEnergyBuffers(this.energyBuffers);
    this.spatialGridBuildingVersion = -1;
  }
}
