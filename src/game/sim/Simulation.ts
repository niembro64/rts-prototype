import { WorldState } from './WorldState';
import { CommandQueue } from './commands';
import type { Entity, EntityId, PlayerId, Unit, UnitAction, UnitPathPoint } from './types';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { magnitude } from '../math';
import { executeCommand, selfDestructCountdownTicks, type CommandContext } from './commandExecution';
import { distributeEnergy, createEnergyBuffers, resetEnergyBuffers, type EnergyBuffers } from './energyDistribution';
import {
  releaseBuilderWorkStation,
  updateArticulatedWorkStations,
} from './workStationSystem';
import { syncBuilderActiveBuildTarget } from './builderBuildTarget';
import { resourceMovementSystem } from './resourceMovement';
import {
  type SimEvent,
  type DeathContext,
  type ProjectileSpawnEvent,
  type ProjectileDespawnEvent,
} from './combat';
import { DamageSystem } from './damage';
import { economyManager } from './economy';
import { ConstructionSystem } from './construction';
import { factoryProductionSystem } from './factoryProduction';
import { updateConstructionLifecycle } from './constructionLifecycle';
import { isBuildInProgress } from './buildableHelpers';
import { commanderAbilitiesSystem, type SprayTarget } from './commanderAbilities';
import { updateUnitGroundNormal } from './unitGroundNormal';
import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';
import { transitionPhase } from '@/gamePhase';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_HP } from '@/types/network';
import type { GamePhase } from '@/types/network';
import { updateAiProduction } from './aiProduction';
import {
  advancePathPlanSlice,
  decayPathfindingTrafficHeat,
  resetPathfinderMatchState,
  type PathSearchStrategy,
  cancelPathPlanSlice,
  isPathPlanSuffixTraversable,
  isPathPlanTraversable,
  isPathSegmentTraversable,
  type ExpandedPathPlan,
} from './Pathfinder';
import {
  pathTerrainFilterCacheKey,
  pathTerrainFilterForLocomotion,
  applyLiquidHazardPathPolicy,
  type PathTerrainFilter,
} from './pathfindingTraversal';
import { getTerrainVersion, isWaterAt, WATER_LEVEL } from './Terrain';
import {
  PATHFINDING_CHASE_REPATH_COOLDOWN_TICKS,
  PATHFINDING_CHASE_REPATH_DRIFT_DISTANCE_FRACTION,
  PATHFINDING_CHASE_REPATH_DRIFT_MIN_WU,
  PATHFINDING_DIRECT_PLAN_MAX_DISTANCE_WU,
  PATHFINDING_INTERMEDIATE_CORRIDOR_WU,
  PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS,
  PATHFINDING_PARTIAL_PLAN_RETRY_TICKS,
  PATHFINDING_A_STAR_EXPANSIONS_PER_TICK,
  PATHFINDING_TRAFFIC_HEAT_DECAY_TICKS,
  PATHFINDING_PATH_FAILURE_BACKOFF_TICKS,
  PATHFINDING_PATH_FAILURE_BACKOFF_MAX_TICKS,
  PATHFINDING_FIRST_LEG_MAX_DISTANCE_WU,
  PATHFINDING_FIRST_LEG_MIN_DISTANCE_WU,
} from './pathfindingTuning';
import { RollingTickStat, type PathfindingTelemetry } from './pathfindingTelemetry';
import {
  PATH_QUEUE_ROUTE,
  PATH_REQUEST_FRESH,
  PATH_REQUEST_NONE,
  PATH_REQUEST_REFINE,
  PATH_REQUEST_REFRESH,
  SimulationPathPlanScheduler,
  pathPlanPlayerId,
  type PathPlanSchedulerStats,
} from './SimulationPathPlanScheduler';
import { registerPathfinderBuildingOccupancy } from './pathfinderTerrainCache';
import { BUILD_GRID_CELL_SIZE } from './buildGrid';
import { pathPlanSuffixNearBuildingChange } from './pathPlanBuildingChangeGate';
import { getUnitLocomotionTraversalCapabilities } from './unitLocomotion';
import { updateBuildingActiveStates } from './buildingActiveState';
import { applyLavaSurfaceDamage } from './lavaSurfaceDamage';
import { getEntityTargetPoint } from './buildingAnchors';
import {
  buildGuardRetaliationAttack,
  calculateGuardFollowPlan,
  isFriendlyGuardTarget,
  isGuardRetaliationAttackAction,
  isValidGuardRetaliationAttack,
  resolveGuardServiceTarget,
  shouldRefreshGuardFollowGoal,
} from './guard';
import { resetTransportModuleState, updateTransportActions } from './transports';
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
import { createSelfDestructEvent } from './selfDestructEvent';
import {
  getBuildApproachMeasure,
  getBuildFootprintClearanceApproachPoint,
  isBuilderClearOfBuildFootprint,
  isBuildRadiusTargetInRange,
  isBuildTargetInRange,
} from './builderRange';
import { SIM_TICK_INSTRUMENTATION } from '../perf/SimTickInstrumentation';
import {
  isReclaimableTarget,
  makeEntityReclaimTarget,
  makeVegetationReclaimTarget,
  isReclaimTargetInBuildRange,
  type ReclaimTarget,
} from './reclaim';
import {
  getLiveVegetationPropByTargetId,
  getVegetationProp,
  queryVegetationInCircle,
} from './vegetation';
import {
  SimulationAirborneLoiterController,
} from './SimulationAirborneLoiterController';
import { SimulationWaypointOrbitController } from './SimulationWaypointOrbitController';
import { SimulationCombatHaltController } from './SimulationCombatHaltController';
import {
  replanCooldownFor,
  SimulationStuckReplanController,
} from './SimulationStuckReplanController';
import {
  SimulationUnitActionPlanner,
  UNIT_ACTION_FLAG_COMBAT_STOP_ANY,
  UNIT_ACTION_FLAG_COMBAT_STOP_FIGHT,
  UNIT_ACTION_FLAG_BUILD_FOOTPRINT_CLEAR,
  UNIT_ACTION_FLAG_GUARD_FRIENDLY,
  UNIT_ACTION_FLAG_GUARD_SERVICE,
  UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE,
  UNIT_ACTION_FLAG_MOVE_STATE_HOLD,
  UNIT_ACTION_FLAG_MOVE_STATE_ROAM,
  UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE,
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
  /** cos of the bend angle between the approach leg and the outgoing leg at
   *  this point; 1 (straight) disables corner speed shaping. */
  cornerBendCos: number;
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

/** Outcome of the translate+validate cache pass a queued request runs
 *  before any search: either a route was installed, or the inputs the search
 *  job needs (the terrain filter, the shared formation anchor and its cache
 *  key, the navigation goal, the shared-route cache key). */
type CachedRouteAdoption =
  | { installed: true }
  | {
      installed: false;
      terrainFilter: PathTerrainFilter | null;
      formationRoute: FormationRouteMetadata | null;
      formationCacheKey: string | null;
      navGoal: { x: number; y: number } | null;
      sharedRouteKey: string | null;
    };

/** Wall clock for telemetry only (never lockstep state). */
function telemetryNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}

/** Building changes farther than this (build-grid cells, Chebyshev) from a
 *  route-blocked body cannot change whether it can leave its cell. Two
 *  hierarchy clusters: generous, and cheap to test. */
const PATH_FAILURE_BUILDING_CHANGE_REACH_CELLS = 32;

/** Work charged for one validated line walk, mirroring the WASM smoothing
 *  charge (one unit per eight supercover cells, at least one). */
const LINE_WALK_CELLS_PER_WORK_UNIT = 8;
function lineWalkWorkUnits(x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.abs(Math.floor(x1 / BUILD_GRID_CELL_SIZE) - Math.floor(x0 / BUILD_GRID_CELL_SIZE));
  const dy = Math.abs(Math.floor(y1 / BUILD_GRID_CELL_SIZE) - Math.floor(y0 / BUILD_GRID_CELL_SIZE));
  return Math.max(1, Math.ceil((Math.max(dx, dy) + 1) / LINE_WALK_CELLS_PER_WORK_UNIT));
}

/** An air body: both its movement and its stopping domains include air, so
 *  it overflies terrain and buildings alike. */
function isAirborneTerrainFilter(filter: PathTerrainFilter | null): boolean {
  return filter !== null &&
    filter.navigation.move.allowInAir &&
    filter.navigation.waypoint.allowInAir;
}

type ActivePathPlanJob = {
  entityId: EntityId;
  lane: number;
  forceLocal: boolean;
  actionHash: number;
  actionSnapshot: UnitAction;
  terrainVersion: number;
  buildingGridVersion: number;
  startX: number;
  startY: number;
  goalX: number;
  goalY: number;
  goalZ: number | null;
  terrainFilter: PathTerrainFilter | null;
  unitRadius: number;
  symmetricSlope: boolean;
  formationRoute: FormationRouteMetadata | null;
  formationCacheKey: string | null;
  /** Shared-route cache key (start cluster -> goal cluster for this body
   *  class); a completed hierarchical route is stored under it. */
  sharedRouteKey: string | null;
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
// Replans consume a deterministic expansion quantum for one ally team per
// tick. Each team may retain one difficult fine-grid A* frontier between its
// round-robin turns; all other requests wait in per-player fresh/refresh
// lanes. A planless unit holds under normal physics until a validated route
// exists.

/** Broadphase slack for the patrol auto-reclaim vegetation sweep. The
 *  circle query tests prop CENTERS, while the build-range test that
 *  follows measures to a prop's surface, so the sweep is widened by the
 *  largest plausible prop radius and then filtered exactly. */
const PATROL_RECLAIM_VEGETATION_RADIUS_PADDING = 200;

/** Scratch for that sweep. One builder is considered at a time inside a
 *  single-threaded tick, and the padded build-range disc bounds how many
 *  props can land in it. */
const _patrolVegetationQueryScratch = new Uint32Array(256);

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
  private airborneLoiter: SimulationAirborneLoiterController;
  private waypointOrbit: SimulationWaypointOrbitController;
  private stuckReplanController: SimulationStuckReplanController;
  private unitActionPlanner: SimulationUnitActionPlanner = new SimulationUnitActionPlanner();
  private unitActionMovementPlanner: SimulationUnitActionMovementPlanner = new SimulationUnitActionMovementPlanner();
  private forceAccumulator: ForceAccumulator = new ForceAccumulator();
  private readonly formationRouteCache = new Map<string, ExpandedPathPlan>();
  /** Completed hierarchical routes keyed by (navigation versions, body
   *  class, start cluster, goal cluster). A later unit of the same class
   *  leaving the same 320 wu cluster for the same goal cluster adopts the
   *  route — its own goal replaces the last point and the whole polyline is
   *  validated from its own position — instead of searching again. A blob
   *  of a thousand units ordered across the map is a few dozen searches,
   *  not a thousand. Derived lockstep state: per-Simulation, never
   *  serialized, identical on every peer. */
  private readonly sharedRouteCache = new Map<string, ExpandedPathPlan>();
  private readonly pathPlanScheduler: SimulationPathPlanScheduler;
  private readonly activePathPlanJobs = new Map<PlayerId, ActivePathPlanJob>();
  private readonly pathQueryOutcomes: PathQueryOutcomeStats = createEmptyPathQueryOutcomeStats();
  /** Telemetry for the SERVER bar: request-to-route latency (ticks) and the
   *  pathfinding phase's wall time per tick (ms). Never hashed. */
  private readonly pathRouteLatencyStat = new RollingTickStat();
  private readonly pathfindingMsStat = new RollingTickStat();
  private windState: WindState = sampleWindState(0);
  private windPowerTracker = new WindPowerTracker();
  // Accumulated sim time (ms). Drives deterministic systems like wind
  // that used to read Date.now(); now they advance only with the
  // simulation tick, so replays and host-migration produce the same
  // wave phase regardless of wall-clock drift.
  private simElapsedMs = 0;

  // Current spray targets for rendering (build/heal effects)
  private currentSprayTargets: SprayTarget[] = [];
  /** Commander sprays + transport beam sprays for ticks where both
   *  exist; reused so the merge never allocates. */
  private readonly _combinedSprayTargets: SprayTarget[] = [];

  // Player IDs participating in this game
  private playerIds: PlayerId[] = [1, 2];
  /** Last WorldState building-version reflected into the spatial
   *  grid. Buildings are static, so we only need to rescan them when
   *  one is added or removed instead of every simulation tick. */
  private spatialGridBuildingVersion = -1;

  // Track if game is over
  private gameOverWinnerId: PlayerId | null = null;
  /** P1-13: last observed commander-list length; a change means someone's
   *  commander left the world and victory must be re-evaluated now. */
  private lastGameOverCommanderCount = -1;

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
    this.pathPlanScheduler = new SimulationPathPlanScheduler(
      () => this.world.simulationTickRateHz,
      () => this.world.getTick(),
    );
    this.constructionSystem = new ConstructionSystem(
      world.mapWidth,
      world.mapHeight,
      terrainBuildabilityGrid,
    );
    // Grounded building footprints are a dynamic obstacle layer in the WASM
    // locomotion grid. The cache pulls the cell set whenever the grid
    // version moves; hovering structures never report cells (their
    // blocksMovement is authored false at placement).
    registerPathfinderBuildingOccupancy({
      getVersion: () => this.constructionSystem.getGrid().getVersion(),
      forEachBlockedCell: (visit) => {
        for (const { gx, gy } of this.constructionSystem.getGrid().occupiedCells()) {
          visit(gx, gy);
        }
      },
    });
    // A new simulation is a new match: every peer starts the planner cold.
    resetPathfinderMatchState();
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
      queueAirborneLoiter: (entity) => this.airborneLoiter.queue(entity),
    });
    this.combatHaltController = new SimulationCombatHaltController(this.world);
    this.airborneLoiter = new SimulationAirborneLoiterController(this.world);
    this.waypointOrbit = new SimulationWaypointOrbitController({
      advanceAction: (entity) => this.advanceAction(entity),
      advanceActivePathPoint: (entity) => this.advanceActivePathPoint(entity),
    });
    this.stuckReplanController = new SimulationStuckReplanController(
      this.world,
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
  /** Deterministic path-plan admission counters (diagnostics, never hashed). */
  /** Death-explosion chain telemetry: blasts carried past the per-tick cap
   *  and blasts detonated on the current tick. Never hashed. */
  getDeathExplosionPlannerStats(): { pendingBlasts: number; detonationsThisTick: number } {
    return {
      pendingBlasts: this.deathExplosionPlanner.getPendingBlastCount(),
      detonationsThisTick: this.deathExplosionPlanner.getDetonationsOnTick(this.world.getTick() - 1),
    };
  }

  getPathPlanSchedulerStats(): PathPlanSchedulerStats {
    return this.pathPlanScheduler.getStats();
  }

  /** Per-player queue depths and rolling latency/cost scalars for the
   *  SERVER bar. Allocates; called on the rich-snapshot cadence only. */
  getPathfindingTelemetry(): PathfindingTelemetry {
    const depths = this.pathPlanScheduler.getQueueDepths();
    const wait = this.pathPlanScheduler.getWaitStat();
    return {
      players: depths.players,
      route: depths.route,
      refine: depths.refine,
      refresh: depths.refresh,
      waitAvg: wait.average(),
      waitWorst: wait.worst(),
      routeAvg: this.pathRouteLatencyStat.average(),
      routeWorst: this.pathRouteLatencyStat.worst(),
      msAvg: this.pathfindingMsStat.average(),
      msWorst: this.pathfindingMsStat.worst(),
    };
  }

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

    // A structure placed by a command this tick becomes a physical obstacle
    // immediately, exactly like one placed at boot. The build-grid footprint
    // already blocked pathing at placement; without the body a unit standing
    // on the site was never pushed off it and ended up inside the finished
    // building with no route out.
    this.flushPendingBuildingBodies();

    // Fire due self-destruct countdowns AFTER command processing so a
    // Stop or re-toggle arriving on the fire tick wins the tie. The
    // zero-hp write routes the blast through the normal death path.
    this.fireDueSelfDestructs(tick);

    // Right after the self-destruct pass, with the same direct-hp-drain
    // semantics, so every "the world killed me" rule resolves before anything
    // downstream reads hp this tick. A no-op unless LIQUID = LAVA.
    applyLavaSurfaceDamage(this.world, dtMs);
    SIM_TICK_INSTRUMENTATION.phase('sim.commands');

    // Solar collectors, wind turbines, and metal extractors share a
    // fortifiable-producer lifecycle: a 2 s grace timer arms on the
    // first hit, the building snaps closed once it expires, and a
    // 5 s quiet debounce reopens it. Production follows the open flag.
    updateBuildingActiveStates(this.world, dtMs);
    sampleWindStateInto(this.windState, this.simElapsedMs);
    this.windPowerTracker.update(this.world, this.windState);

    // Update economy income and production.
    economyManager.update(this.world, dtMs, this.windState.speed);
    SIM_TICK_INSTRUMENTATION.phase('sim.economy');

    // Update each unit's smoothed surface normal BEFORE the systems
    // that read it (commanderAbilitiesSystem, turret kinematics inside
    // updateUnits / the targeting scheduler bridge). The EMA owns the
    // single canonical normal source so the renderer, sim turret
    // mounts, and locomotion can never read disagreeing per-unit normals.
    updateUnitGroundNormal(this.world, dtMs);
    SIM_TICK_INSTRUMENTATION.phase('sim.groundNormal');

    // BAR unit_auto_repair_idle_builders.lua parity: idle mobile builders
    // periodically take a nearby damaged allied unit, then return to the
    // recorded idle point when the repair finishes or becomes invalid.
    this.idleBuilderAutoRepair.update(tick);
    SIM_TICK_INSTRUMENTATION.phase('sim.idleBuilderRepair');

    // QueryWork uses the same bounded local-joint contract as weapons. Run
    // before resource distribution so build/repair power is admitted only
    // after the visible mechanism is physically aligned.
    updateArticulatedWorkStations(this.world, dtMs);
    SIM_TICK_INSTRUMENTATION.phase('sim.workStations');

    // Distribute energy equally among all active consumers (factories, construction, commander)
    distributeEnergy(this.world, dtMs, this.energyBuffers);

    // Resource converters move whichever resource sits above its player's
    // auto-conversion slider point toward the other resource. Run after
    // construction/factory energy distribution so converters consume the
    // leftover post-construction stockpile instead of deepening stalls.
    economyManager.processConverters(this.world, dtMs);
    SIM_TICK_INSTRUMENTATION.phase('sim.energy');

    // Shared construction lifecycle for both building shells and
    // factory unit shells: HP growth, paid-full completion, building
    // completion effects, and dirty flags all flow through one pass.
    const constructionResult = updateConstructionLifecycle(this.world, dtMs);
    this.actionQueueMaintenance.advanceCompletedConstructionActions(
      constructionResult.completedBuildings,
    );
    if (constructionResult.decayedBuildings.length > 0) {
      this.removeDecayedConstructionShells(constructionResult.decayedBuildings);
    }
    SIM_TICK_INSTRUMENTATION.phase('sim.construction');

    // AI auto-queues units at idle factories
    updateAiProduction(this.world, this.aiPlayerIds, this.aiAllowedUnitBlueprintIds);

    // Update factory production
    const productionResult = factoryProductionSystem.update(
      this.world, dtMs,
      this.forceAccumulator,
      this.windState,
    );
    // Notify about newly spawned unit shells immediately so their physics
    // bodies exist while the production hold pins them at the ring center.
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
    SIM_TICK_INSTRUMENTATION.phase('sim.production');

    // Update commander auto-build and auto-heal
    const commanderResult = commanderAbilitiesSystem.update(this.world, dtMs);
    this.currentSprayTargets = commanderResult.sprayTargets;
    SIM_TICK_INSTRUMENTATION.phase('sim.commanderAbilities');

    // Transport beams: passengers never leave the world now, so a
    // release needs no spawn hook — the unit already has its body. The
    // beams' nano streams join the commander sprays for this tick.
    const transportResult = updateTransportActions(this.world, dtMs);
    if (transportResult.sprayTargets.length > 0) {
      this._combinedSprayTargets.length = 0;
      for (let i = 0; i < commanderResult.sprayTargets.length; i++) {
        this._combinedSprayTargets.push(commanderResult.sprayTargets[i]);
      }
      for (let i = 0; i < transportResult.sprayTargets.length; i++) {
        this._combinedSprayTargets.push(transportResult.sprayTargets[i]);
      }
      this.currentSprayTargets = this._combinedSprayTargets;
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

    SIM_TICK_INSTRUMENTATION.phase('sim.transport');

    // Update all units movement (calculates target velocities) and
    // refresh their spatial-grid cells in the same pass.
    this.updateUnits(dtMs / 1000);
    SIM_TICK_INSTRUMENTATION.phase('sim.updateUnits');

    // Update non-unit spatial indices. Unit cells are refreshed inside
    // updateUnits() to avoid another full unit walk.
    this.updateSpatialGrid();
    SIM_TICK_INSTRUMENTATION.phase('sim.spatialGrid');

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
    this.deadEntityCleanup.run(this.onUnitDeath, this.onBuildingDeath);
    SIM_TICK_INSTRUMENTATION.phase('sim.deadCleanup');

    // Check for game over (commander death)
    this.checkGameOver();

    // Finalize force accumulator (sums all contributions)
    this.forceAccumulator.finalize();

    this.world.incrementTick();
    SIM_TICK_INSTRUMENTATION.phase('sim.finalize');
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

    // P0-03: traveling projectiles are NOT restamped here. The post-
    // integration batch in SimulationCombatController is the sole full
    // stamp — its tick-N output is exactly the correct pre-combat state at
    // tick N+1, spawns register through their launch-finalization path, and
    // reflections restamp individually. The old pre-combat full restamp
    // repeated all of that work every tick.
  }

  // Check for game over - last commander standing wins
  private checkGameOver(): boolean {
    if (this.gameOverWinnerId !== null) return false; // Already over
    // P1-13: victory can only change when a commander leaves the world
    // (death cleanup runs just before this and shrinks the cached
    // commander list the same tick the hp hits zero) — plus a 1 Hz
    // defensive scrub. Both signals are pure functions of lockstep state,
    // so every peer takes the same branch.
    const commanderCount = this.world.getCommanderUnits().length;
    const scrubDue = this.world.getTick() % 20 === 0;
    if (commanderCount === this.lastGameOverCommanderCount && !scrubDue) return false;
    this.lastGameOverCommanderCount = commanderCount;
    const winnerId = resolveCommanderGameOverWinner(this.world, this.playerIds);
    if (winnerId === null) return false;

    this.gameOverWinnerId = winnerId;
    this.gamePhase = transitionPhase(this.gamePhase, 'gameOver');
    const onGameOver = this.onGameOver;
    if (onGameOver !== null) onGameOver(winnerId);
    return true;
  }

  /** Hard validity: the plan belongs to this exact action and the unit can
   *  legally start from its current medium. Chase actions (live-target
   *  attack/guard) deliberately exclude the goal coordinates: per-tick
   *  approach re-aims are absorbed by drift-based refresh instead of
   *  invalidating the route outright. Terrain-version changes are hard safety
   *  invalidations because physical support or hazard domains may differ. */
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
    if (
      isChase &&
      age >= this.world.ticksForDefaultTicks(
        PATHFINDING_CHASE_REPATH_COOLDOWN_TICKS,
      )
    ) {
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
    return plan.resolution === 'partial' &&
      age >= this.world.ticksForDefaultTicks(
        PATHFINDING_PARTIAL_PLAN_RETRY_TICKS,
      );
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
      this.constructionSystem.getGrid().getVersion(),
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
    const anchorPlan = this.formationRouteCache.get(key);
    if (anchorPlan === undefined) return null;
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

  /** Resolve only validated movement. Commands and cheap direct/cache routes
   *  apply immediately; every real search waits in its OWNER's refine queue
   *  for that player's quantum. A unit with no safe route returns null and
   *  supplies no destination-directed drive this tick. */
  private ensureActivePathPlan(entity: Entity, action: UnitAction): Unit['activePath'] {
    const unit = entity.unit;
    if (!unit) return null;

    const terrainVersion = getTerrainVersion();
    const isChase =
      action.targetId !== undefined &&
      (action.type === 'attack' || action.type === 'guard');

    if (this.isActivePathHardValid(entity, unit, action, isChase)) {
      const plan = unit.activePath as NonNullable<Unit['activePath']>;
      // Terrain changes can alter physical support and hazard domains. Never
      // steer on an unvalidated old surface while its replacement is queued.
      if (plan.terrainVersion !== terrainVersion) {
        unit.activePath = null;
        this.pathPlanScheduler.requestFresh(entity, false);
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
        return null;
      }
      const buildingGrid = this.constructionSystem.getGrid();
      const buildingGridVersion = buildingGrid.getVersion();
      if (plan.buildingGridVersion !== buildingGridVersion) {
        // A change nowhere near the remaining route cannot have changed its
        // legality; only routes within clearance reach of the touched cells
        // re-walk their polyline. Unknown history (plan older than the
        // retained log) revalidates in full.
        const change = buildingGrid.changedBoundsSince(plan.buildingGridVersion);
        if (
          change !== null &&
          !pathPlanSuffixNearBuildingChange(entity, plan, change, unit.radius.collision)
        ) {
          plan.buildingGridVersion = buildingGridVersion;
        } else if (
          isPathPlanSuffixTraversable(
            entity.transform.x,
            entity.transform.y,
            plan.points,
            plan.index,
            this.world.mapWidth,
            this.world.mapHeight,
            this.pathTerrainFilterForUnit(entity),
            unit.radius.collision,
            this.world.slopePathMode === 'symmetric',
          )
        ) {
          plan.buildingGridVersion = buildingGridVersion;
        } else {
          unit.activePath = null;
          this.pathPlanScheduler.requestFresh(entity, false);
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
          return null;
        }
      }
      if (plan.resolution === 'coarse') {
        // A first leg is a promise of motion, not a route: the full route is
        // the owner's refine queue's job. A refine entry that was dropped (its
        // job invalidated by a version change) is re-queued here, and a unit
        // that reached the end of its leg while the refinement is still
        // queued takes the next validated leg instead of standing still.
        if (unit.pathRequestLane === PATH_REQUEST_NONE) {
          this.pathPlanScheduler.requestRefine(entity, false);
        }
        if (this.isAtCoarseLegEnd(entity, plan)) {
          const next = this.tryInstallFirstLegPlan(entity, unit, action, terrainVersion);
          if (next.plan !== null) return next.plan;
        }
        return plan;
      }
      if (
        unit.pathRequestLane === PATH_REQUEST_NONE &&
        this.activePathWantsRefresh(entity, plan, action, isChase, terrainVersion)
      ) {
        const direct = this.tryInstallDirectPathPlan(entity, unit, action, terrainVersion);
        if (direct !== null) return direct;
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
    if (unit.pathRequestLane === PATH_REQUEST_REFINE) {
      // The full route is already queued and plans from the live position
      // whenever it is served; a dropped first leg needs nothing more.
      return null;
    }
    if (unit.pathRequestLane === PATH_REQUEST_REFRESH) {
      // The queued refresh was for a plan that no longer exists; promote it
      // to fresh priority (the superseded entry is skipped at serve time).
      this.pathPlanScheduler.requestFresh(entity, false);
      return null;
    }

    // Formation cache hits are translate+validate only. A cache miss queues
    // its shared anchor as the next A* job rather than calculating inline.
    const formationRoute = !hadPlan ? this.getFormationRouteMetadata(action) : null;
    if (formationRoute !== null) {
      const terrainFilter = this.pathTerrainFilterForUnit(entity);
      const cacheKey = this.formationRouteCacheKey(formationRoute, terrainVersion, terrainFilter);
      if (this.formationRouteCache.has(cacheKey)) {
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
        // A shared corridor that cannot safely translate for this unit falls
        // through to a queued local calculation.
      }
    }

    const direct = this.tryInstallDirectPathPlan(entity, unit, action, terrainVersion);
    if (direct !== null) return direct;

    if (unit.pathFailureActionHash !== unit.actionHash) {
      this.clearPathFailure(unit);
      unit.pathFailureActionHash = unit.actionHash;
    }
    if (this.pathRetryHolds(entity, unit)) return null;
    if (this.isOutsideOwnMedium(entity, unit)) {
      // A hull on dry land, a land unit in water it cannot ford: nothing it
      // can do under its own power changes that, and no search would answer
      // differently. Never queue it — mark it route-blocked and look again
      // only when its cell changes (user rule 2026-08-26).
      this.pathQueryOutcomes.outOfMedium += 1;
      this.recordPathFailure(entity, unit);
      return null;
    }
    // A retry after a terminal result goes straight to the search: the
    // route queue's straight legs failed from this very cell already.
    if (unit.pathFailureStreak > 0) this.pathPlanScheduler.requestRefine(entity, false);
    else this.pathPlanScheduler.requestFresh(entity, false);
    return null;
  }

  /** The body's exact point lies outside its navigation domain: dry ground
   *  under a water-only body, or water deeper than a ground body's resting
   *  origin height (the planner's fording rule) under a body that cannot
   *  swim. Air bodies are at home anywhere. Mirrors the WASM start-cell
   *  domain test so the queue never carries a request the kernel would
   *  bail on. */
  private isOutsideOwnMedium(entity: Entity, unit: Unit): boolean {
    const filter = this.pathTerrainFilterForUnit(entity);
    if (filter === null) return false;
    const move = filter.navigation.move;
    if (move.allowInAir) return false;
    const x = entity.transform.x;
    const y = entity.transform.y;
    const wet = isWaterAt(x, y, this.world.mapWidth, this.world.mapHeight);
    if (wet) {
      if (move.allowInWater) return false;
      const depth = WATER_LEVEL - this.world.getTerrainBedZ(x, y);
      return !(move.allowOnGround && depth <= unit.supportPointOffsetZ);
    }
    return !move.allowOnGround;
  }

  /** Navigation-grid cell the body stands in, as one comparable key. */
  private pathCellKeyOf(entity: Entity): number {
    return Math.floor(entity.transform.x / BUILD_GRID_CELL_SIZE) +
      Math.floor(entity.transform.y / BUILD_GRID_CELL_SIZE) * 65536;
  }

  /** True while a failed request's backoff is in force AND nothing that
   *  could change the answer has changed: the unit still stands in the cell
   *  it failed from, on the same terrain version, against the same building
   *  layer. Any of those changing lifts the backoff at once — the backoff
   *  exists to stop identical inputs being recomputed every tick, not to
   *  make the unit wait. */
  private pathRetryHolds(entity: Entity, unit: Unit): boolean {
    if (unit.pathRetryAtTick <= this.world.getTick()) return false;
    if (unit.pathFailureCellKey !== this.pathCellKeyOf(entity)) return false;
    if (unit.pathFailureTerrainVersion !== getTerrainVersion()) return false;
    const buildingGrid = this.constructionSystem.getGrid();
    if (unit.pathFailureBuildingGridVersion !== buildingGrid.getVersion()) {
      // A footprint that went up or came down far from the body cannot have
      // changed whether the body can leave its cell; only changes within
      // reach of it lift the backoff. Unknown history (older than the
      // retained log) lifts it too.
      const change = buildingGrid.changedBoundsSince(unit.pathFailureBuildingGridVersion);
      if (change === null) return false;
      if (change.count > 0) {
        const cellX = Math.floor(entity.transform.x / BUILD_GRID_CELL_SIZE);
        const cellY = Math.floor(entity.transform.y / BUILD_GRID_CELL_SIZE);
        const reach = PATH_FAILURE_BUILDING_CHANGE_REACH_CELLS;
        if (
          cellX + reach >= change.minGx && cellX - reach <= change.maxGx &&
          cellY + reach >= change.minGy && cellY - reach <= change.maxGy
        ) {
          return false;
        }
      }
      unit.pathFailureBuildingGridVersion = buildingGrid.getVersion();
    }
    return true;
  }

  private clearPathFailure(unit: Unit): void {
    unit.pathFailureStreak = 0;
    unit.pathRetryAtTick = 0;
    unit.pathFailureCellKey = -1;
    unit.pathFailureTerrainVersion = -1;
    unit.pathFailureBuildingGridVersion = -1;
    unit.routeBlocked = false;
  }

  /** An unreachable/terminal result: the body cannot leave the cell it
   *  stands on, or nothing reachable exists. The order is NEVER dropped.
   *  Retrying next tick recomputes identical inputs, so back off
   *  exponentially — and remember exactly what the answer depended on, so
   *  the backoff lifts the moment any of it changes (pathRetryHolds). */
  private recordPathFailure(entity: Entity, unit: Unit): void {
    if (unit.pathFailureActionHash !== unit.actionHash) {
      unit.pathFailureStreak = 0;
      unit.pathFailureActionHash = unit.actionHash;
    }
    unit.pathFailureStreak += 1;
    this.pathQueryOutcomes.failures += 1;
    const exponent = Math.min(unit.pathFailureStreak - 1, 16);
    const delay = Math.min(
      PATHFINDING_PATH_FAILURE_BACKOFF_TICKS * 2 ** exponent,
      PATHFINDING_PATH_FAILURE_BACKOFF_MAX_TICKS,
    );
    unit.pathRetryAtTick = this.world.getTick() + delay;
    unit.pathFailureCellKey = this.pathCellKeyOf(entity);
    unit.pathFailureTerrainVersion = getTerrainVersion();
    unit.pathFailureBuildingGridVersion = this.constructionSystem.getGrid().getVersion();
    unit.routeBlocked = true;
  }

  /** A plan that the unit may keep steering on while a replacement is
   *  queued. A coarse first leg is not one: for cache adoption and formation
   *  routing it counts as "no route yet". */
  private hasUsableRoute(unit: Unit): boolean {
    return unit.activePath !== null && unit.activePath.resolution !== 'coarse';
  }

  private isAtCoarseLegEnd(entity: Entity, plan: NonNullable<Unit['activePath']>): boolean {
    if (plan.index < plan.points.length - 1) return false;
    const end = plan.points[plan.points.length - 1];
    return magnitude(end.x - entity.transform.x, end.y - entity.transform.y) <= ARRIVAL_RADIUS;
  }

  /** Route-queue tier 1 for a far goal: the longest validated straight leg
   *  toward the navigation goal, at most firstLegMaxDistanceWu, halved until
   *  it validates and never shorter than firstLegMinDistanceWu. Installed as
   *  a COARSE plan the unit drives at once; the full route stays queued in
   *  the owner's refine queue and replaces it. Returns the work charged
   *  (line cells walked, one unit per SMOOTHING_CELLS_PER_WORK_UNIT cells),
   *  whether or not a leg landed. */
  private tryInstallFirstLegPlan(
    entity: Entity,
    unit: Unit,
    action: UnitAction,
    terrainVersion: number,
  ): { plan: NonNullable<Unit['activePath']> | null; work: number } {
    const navGoal = this.resolveNavigationGoal(entity, action);
    const goalX = navGoal?.x ?? action.x;
    const goalY = navGoal?.y ?? action.y;
    const startX = entity.transform.x;
    const startY = entity.transform.y;
    const dx = goalX - startX;
    const dy = goalY - startY;
    const distance = magnitude(dx, dy);
    if (distance <= PATHFINDING_FIRST_LEG_MIN_DISTANCE_WU) return { plan: null, work: 0 };
    const terrainFilter = this.pathTerrainFilterForUnit(entity);
    const symmetric = this.world.slopePathMode === 'symmetric';
    let leg = Math.min(PATHFINDING_FIRST_LEG_MAX_DISTANCE_WU, distance);
    let work = 0;
    while (leg >= PATHFINDING_FIRST_LEG_MIN_DISTANCE_WU) {
      const scale = leg / distance;
      const x = startX + dx * scale;
      const y = startY + dy * scale;
      const point: UnitPathPoint = { x, y, z: this.world.getTerrainBedZ(x, y) };
      work += lineWalkWorkUnits(startX, startY, x, y);
      if (
        isPathSegmentTraversable(
          startX,
          startY,
          point,
          this.world.mapWidth,
          this.world.mapHeight,
          terrainFilter,
          unit.radius.collision,
          symmetric,
        )
      ) {
        return {
          plan: this.installActivePathPlan(
            entity,
            unit,
            action,
            { points: [point], resolution: 'coarse' },
            terrainVersion,
          ),
          work,
        };
      }
      leg *= 0.5;
    }
    return { plan: null, work };
  }

  private recordPathQueryOutcome(
    unit: Unit,
    resolution: ExpandedPathPlan['resolution'],
    strategy: PathSearchStrategy,
  ): void {
    if (resolution === 'coarse') return;
    const stats = this.pathQueryOutcomes;
    stats[resolution] += 1;
    if (strategy === 'direct') stats.direct += 1;
    else if (strategy === 'hierarchical') stats.hierarchical += 1;
    else if (strategy === 'local') stats.local += 1;
    if (resolution === 'unreachable') {
      const key = unit.unitBlueprintId;
      const counts = stats.unreachableByBlueprint;
      if (counts.has(key) || counts.size < 64) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  /** Deterministic route-outcome counters (diagnostics, never hashed). */
  getPathQueryOutcomeStats(): PathQueryOutcomeStats {
    const stats = this.pathQueryOutcomes;
    return {
      ...stats,
      unreachableByBlueprint: new Map(stats.unreachableByBlueprint),
    };
  }

  /** Navigation goal for the current action — usually the action point
   *  itself. Build-family orders on a BUILDING target instead aim at a
   *  stand-off inside build range along the builder→site line: the site's
   *  center cell is building-blocked, so a center goal always fails
   *  validation and gets clearance-snapped to open ground that can land far
   *  from the site — the classic "builder walks the long way around to a
   *  mex it could already reach" detour. The stand-off keeps the goal both
   *  passable and local. The STORED plan goal stays the action point (hard
   *  validity compares them); only where the route is computed toward moves. */
  private resolveNavigationGoal(
    entity: Entity,
    action: UnitAction,
  ): { x: number; y: number } | null {
    // A stand-off that already proved UNREACHABLE for this exact order (a
    // passable pocket on a steep face, a walled courtyard) is never offered
    // again: every consumer — direct probe, coarse first leg, cache keys,
    // the queued search — falls back to the authored action point, which
    // the kernel snaps to its nearest open ground.
    const unit = entity.unit;
    if (unit !== null && unit.pathNavGoalUnreachableActionHash === unit.actionHash) {
      return null;
    }
    // Attack orders approach to WEAPON range, not to the target's center —
    // BAR's move-goal-with-radius semantics. Without this a unit whose gun
    // is reloading or out of arc keeps walking into the target, and an
    // attack on a building paths at a building-blocked cell.
    if (action.type === 'attack') {
      if (action.targetId === undefined) return null;
      const target = this.world.getEntity(action.targetId);
      if (target === undefined) return null;
      const combat = entity.combat;
      if (combat === null || combat.turrets.length === 0) return null;
      let weaponRange = 0;
      for (let i = 0; i < combat.turrets.length; i++) {
        const fireMax = combat.turrets[i].ranges.fire.max.acquire;
        if (fireMax > weaponRange) weaponRange = fireMax;
      }
      if (weaponRange <= 0) return null;
      const dx = entity.transform.x - action.x;
      const dy = entity.transform.y - action.y;
      const dCenter = magnitude(dx, dy);
      if (dCenter <= 1e-6) return null;
      const targetExtent = target.building !== null
        ? Math.min(target.building.width, target.building.height) * 0.5
        : target.unit?.radius.collision ?? 0;
      const standOff = Math.min(dCenter, targetExtent + weaponRange * 0.8);
      return {
        x: action.x + dx * (standOff / dCenter),
        y: action.y + dy * (standOff / dCenter),
      };
    }
    if (
      action.type !== 'build' &&
      action.type !== 'repair' &&
      action.type !== 'reclaim' &&
      action.type !== 'capture'
    ) {
      return null;
    }
    const targetId = action.type === 'build' ? action.buildingId : action.targetId;
    if (targetId === undefined) return null;
    const target = this.world.getEntity(targetId);
    if (target === undefined || target.building === null) return null;
    if (action.type === 'build') {
      return getBuildFootprintClearanceApproachPoint(entity, target);
    }
    const measure = getBuildApproachMeasure(entity, target);
    if (measure === null) return null;
    const dx = entity.transform.x - action.x;
    const dy = entity.transform.y - action.y;
    const dCenter = magnitude(dx, dy);
    if (dCenter <= 1e-6) return null;
    // Distance from the site center to the footprint surface along this
    // approach direction, then half the build range of margin past it.
    const surfaceOffset = Math.max(0, dCenter - measure.surfaceDistance);
    const standOff = Math.min(dCenter, surfaceOffset + measure.range * 0.5);
    const scale = standOff / dCenter;
    return { x: action.x + dx * scale, y: action.y + dy * scale };
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
    const navGoal = this.resolveNavigationGoal(entity, action);
    const goalX = navGoal?.x ?? action.x;
    const goalY = navGoal?.y ?? action.y;
    const directDistance = magnitude(
      goalX - entity.transform.x,
      goalY - entity.transform.y,
    );
    const terrainFilter = this.pathTerrainFilterForUnit(entity);
    // Air bodies overfly every obstacle: their straight line validates at any
    // distance and they never enter a queue. Every other body keeps the
    // distance gate so a long legal-but-slow beeline cannot shadow a cheaper
    // route around terrain.
    if (
      directDistance > PATHFINDING_DIRECT_PLAN_MAX_DISTANCE_WU &&
      !isAirborneTerrainFilter(terrainFilter)
    ) {
      return null;
    }
    const direct: UnitPathPoint = {
      x: goalX,
      y: goalY,
      z: navGoal !== null
        ? this.world.getTerrainBedZ(goalX, goalY)
        : action.z ?? this.world.getTerrainBedZ(goalX, goalY),
    };
    if (
      !isPathSegmentTraversable(
        entity.transform.x,
        entity.transform.y,
        direct,
        this.world.mapWidth,
        this.world.mapHeight,
        terrainFilter,
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
    this.clearPathFailure(unit);
    if (pathPlan.resolution !== 'coarse' && unit.pathRequestedTick >= 0) {
      this.pathRouteLatencyStat.record(this.world.getTick() - unit.pathRequestedTick);
      unit.pathRequestedTick = -1;
    }
    unit.activePath = {
      points: pathPlan.points,
      resolution: pathPlan.resolution,
      index: 0,
      actionHash: unit.actionHash,
      terrainVersion,
      buildingGridVersion: this.constructionSystem.getGrid().getVersion(),
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

  /** Serve one route-queue entry for its owner: an exact direct segment, a
   *  cache adoption, or otherwise a validated straight first leg toward the
   *  goal installed as a COARSE plan. Nothing here searches; the full route
   *  is handed to the owner's refine queue either way. Returns the work
   *  charged (0 = the entry resolved free: stale, superseded, no order). */
  private serveRouteRequest(playerId: PlayerId, entityId: EntityId, lane: number): number {
    const entity = this.world.getEntity(entityId);
    if (entity === undefined) return 0;
    const unit = entity.unit;
    if (unit === null || unit.hp <= 0) return 0;
    if (unit.pathRequestLane !== lane) return 0;
    if (!this.rehomeIfOwnerChanged(entity, unit, playerId)) return 0;
    const forceLocal = unit.pathRequestForceLocal;
    const action = unit.actions[0];
    unit.pathRequestLane = PATH_REQUEST_NONE;
    unit.pathRequestForceLocal = false;
    if (action === undefined || !PATH_PLAN_SERVE_ACTION_TYPES.has(action.type)) return 0;
    const terrainVersion = getTerrainVersion();
    // One direct-segment probe is always paid for; it is the cheapest route.
    let work = 1;
    if (this.tryInstallDirectPathPlan(entity, unit, action, terrainVersion) !== null) {
      if (forceLocal) unit.stuckTicks = replanCooldownFor(this.world);
      return work;
    }
    const adoption = this.resolveCachedRouteAdoption(entity, unit, action, terrainVersion, forceLocal);
    work += 1;
    if (adoption.installed) {
      if (forceLocal) unit.stuckTicks = replanCooldownFor(this.world);
      return work;
    }
    // A stuck unit's straight leg is what it is stuck against: it goes to
    // the refine queue directly, from its live position.
    if (!forceLocal) {
      const leg = this.tryInstallFirstLegPlan(entity, unit, action, terrainVersion);
      work += leg.work;
      if (leg.plan !== null) this.pathQueryOutcomes.firstLegs += 1;
      else this.pathQueryOutcomes.firstLegMisses += 1;
    }
    this.pathPlanScheduler.requestRefine(entity, forceLocal);
    return work;
  }

  /** A unit captured while its entry waited sits in the OLD owner's queue.
   *  Re-queue it under the new owner and skip the stale entry for free. */
  private rehomeIfOwnerChanged(entity: Entity, unit: Unit, servedPlayerId: PlayerId): boolean {
    if (pathPlanPlayerId(entity) === servedPlayerId) return true;
    const lane = unit.pathRequestLane;
    const forceLocal = unit.pathRequestForceLocal;
    unit.pathRequestLane = PATH_REQUEST_NONE;
    unit.pathRequestForceLocal = false;
    if (lane === PATH_REQUEST_FRESH) this.pathPlanScheduler.requestFresh(entity, forceLocal);
    else if (lane === PATH_REQUEST_REFINE) this.pathPlanScheduler.requestRefine(entity, forceLocal);
    else if (lane === PATH_REQUEST_REFRESH) this.pathPlanScheduler.requestRefresh(entity);
    return false;
  }

  /** Formation-cache and shared cluster-pair adoption: translate + validate
   *  only, never a search. A unit on a coarse first leg counts as routeless
   *  here, so the second unit of a blob adopts the first unit's completed
   *  route instead of searching its own. */
  private resolveCachedRouteAdoption(
    entity: Entity,
    unit: Unit,
    action: UnitAction,
    terrainVersion: number,
    forceLocal: boolean,
  ): CachedRouteAdoption {
    const terrainFilter = this.pathTerrainFilterForUnit(entity);
    const routeless = !this.hasUsableRoute(unit);
    let formationRoute = !forceLocal && routeless
      ? this.getFormationRouteMetadata(action)
      : null;
    let formationCacheKey: string | null = null;
    if (formationRoute !== null) {
      formationCacheKey = this.formationRouteCacheKey(
        formationRoute,
        terrainVersion,
        terrainFilter,
      );
      if (this.formationRouteCache.has(formationCacheKey)) {
        const translated = this.expandFormationRoutePoints(
          action,
          formationRoute,
          terrainVersion,
          terrainFilter,
          entity,
        );
        if (translated !== null) {
          this.installActivePathPlan(entity, unit, action, translated, terrainVersion);
          return { installed: true };
        }
        formationRoute = null;
        formationCacheKey = null;
      }
    }

    const navGoal = formationRoute === null
      ? this.resolveNavigationGoal(entity, action)
      : null;
    let sharedRouteKey: string | null = null;
    if (!forceLocal && formationRoute === null && routeless) {
      const goalX = navGoal?.x ?? action.x;
      const goalY = navGoal?.y ?? action.y;
      sharedRouteKey = this.sharedRouteCacheKey(entity, unit, goalX, goalY, terrainVersion, terrainFilter);
      const shared = this.sharedRouteCache.get(sharedRouteKey);
      if (shared !== undefined) {
        const adopted = this.adoptSharedRoute(entity, unit, shared, goalX, goalY, terrainFilter);
        if (adopted !== null) {
          this.pathQueryOutcomes.sharedRouteHits += 1;
          this.installActivePathPlan(entity, unit, action, adopted, terrainVersion);
          return { installed: true };
        }
      }
    }
    return {
      installed: false,
      terrainFilter,
      formationRoute,
      formationCacheKey,
      navGoal,
      sharedRouteKey,
    };
  }

  /** Admit one refine-queue entry into its owner's continuation. Direct
   *  routes and cache hits are installed for free and return false so
   *  admission can keep scanning. */
  private admitPathPlanRequest(
    playerId: PlayerId,
    entityId: EntityId,
    lane: number,
  ): boolean {
    const entity = this.world.getEntity(entityId);
    if (entity === undefined) return false;
    const unit = entity.unit;
    if (unit === null || unit.hp <= 0) return false;
    if (unit.pathRequestLane !== lane) return false;
    if (!this.rehomeIfOwnerChanged(entity, unit, playerId)) return false;
    const forceLocal = unit.pathRequestForceLocal;
    const action = unit.actions[0];
    if (action === undefined || !PATH_PLAN_SERVE_ACTION_TYPES.has(action.type)) {
      unit.pathRequestLane = PATH_REQUEST_NONE;
      unit.pathRequestForceLocal = false;
      return false;
    }
    const terrainVersion = getTerrainVersion();
    if (this.tryInstallDirectPathPlan(entity, unit, action, terrainVersion) !== null) {
      unit.pathRequestLane = PATH_REQUEST_NONE;
      unit.pathRequestForceLocal = false;
      if (forceLocal) unit.stuckTicks = replanCooldownFor(this.world);
      return false;
    }
    const adoption = this.resolveCachedRouteAdoption(entity, unit, action, terrainVersion, forceLocal);
    if (adoption.installed) {
      unit.pathRequestLane = PATH_REQUEST_NONE;
      unit.pathRequestForceLocal = false;
      if (forceLocal) unit.stuckTicks = replanCooldownFor(this.world);
      return false;
    }
    const { terrainFilter, formationRoute, formationCacheKey, navGoal, sharedRouteKey } = adoption;
    this.activePathPlanJobs.set(playerId, {
      entityId,
      lane,
      forceLocal,
      actionHash: unit.actionHash,
      actionSnapshot: { ...action },
      terrainVersion,
      buildingGridVersion: this.constructionSystem.getGrid().getVersion(),
      startX: formationRoute?.startX ?? entity.transform.x,
      startY: formationRoute?.startY ?? entity.transform.y,
      goalX: formationRoute?.goalX ?? navGoal?.x ?? action.x,
      goalY: formationRoute?.goalY ?? navGoal?.y ?? action.y,
      goalZ: navGoal !== null ? null : action.z ?? null,
      terrainFilter,
      unitRadius: formationRoute?.radius ?? unit.radius.collision,
      symmetricSlope: this.world.slopePathMode === 'symmetric',
      formationRoute,
      formationCacheKey,
      sharedRouteKey,
    });
    return true;
  }

  private sharedRouteCacheKey(
    entity: Entity,
    unit: Unit,
    goalX: number,
    goalY: number,
    terrainVersion: number,
    filter: PathTerrainFilter | null,
  ): string {
    const clusterWu = PATHFINDING_HIERARCHICAL_CLUSTER_SIZE_CELLS * BUILD_GRID_CELL_SIZE;
    return [
      terrainVersion,
      this.constructionSystem.getGrid().getVersion(),
      this.world.slopePathMode,
      pathTerrainFilterCacheKey(filter),
      unit.radius.collision,
      Math.floor(entity.transform.x / clusterWu),
      Math.floor(entity.transform.y / clusterWu),
      Math.floor(goalX / clusterWu),
      Math.floor(goalY / clusterWu),
    ].join(':');
  }

  /** Re-aim a cached route at this unit's own goal and prove it from this
   *  unit's own position; null when any leg fails the unit's clearance. */
  private adoptSharedRoute(
    entity: Entity,
    unit: Unit,
    shared: ExpandedPathPlan,
    goalX: number,
    goalY: number,
    filter: PathTerrainFilter | null,
  ): ExpandedPathPlan | null {
    if (shared.points.length === 0) return null;
    const points = new Array<UnitPathPoint>(shared.points.length);
    for (let i = 0; i < shared.points.length - 1; i++) points[i] = shared.points[i];
    const x = this.clampPathX(goalX);
    const y = this.clampPathY(goalY);
    points[points.length - 1] = { x, y, z: this.world.getTerrainBedZ(x, y) };
    return isPathPlanTraversable(
      entity.transform.x,
      entity.transform.y,
      points,
      this.world.mapWidth,
      this.world.mapHeight,
      filter,
      unit.radius.collision,
      this.world.slopePathMode === 'symmetric',
    )
      ? { points, resolution: 'complete' }
      : null;
  }

  /** Resume or finish one team's path job. Invalid live intent is free, so the
   *  scheduler may admit a replacement in the same team turn. */
  private advanceActivePathPlanJob(
    playerId: PlayerId,
    expansionBudget: number,
  ): { status: 'invalid' | 'pending' | 'complete'; expansionsUsed: number } {
    const job = this.activePathPlanJobs.get(playerId);
    if (job === undefined) return { status: 'invalid', expansionsUsed: 0 };
    const entity = this.world.getEntity(job.entityId);
    const unit = entity?.unit ?? null;
    const action = unit?.actions[0];
    const isChase = action !== undefined && action.targetId !== undefined &&
      (action.type === 'attack' || action.type === 'guard');
    const actionStillMatches = action !== undefined &&
      action.type === job.actionSnapshot.type &&
      action.targetId === job.actionSnapshot.targetId &&
      action.buildingId === job.actionSnapshot.buildingId &&
      (isChase || unit?.actionHash === job.actionHash);
    // Building churn never cancels a job here: the WASM keeps or drops the
    // retained frontier by an exact corridor test, and a route that ends up
    // crossing a new footprint fails the install-time validation below. A
    // start-goal box test was tried first and cancelled nearly every long
    // route in a match with four building bots.
    const navigationStillMatches = getTerrainVersion() === job.terrainVersion;
    if (
      entity === undefined ||
      unit === null ||
      unit.hp <= 0 ||
      unit.pathRequestLane !== job.lane ||
      !actionStillMatches ||
      !navigationStillMatches
    ) {
      cancelPathPlanSlice(playerId);
      this.activePathPlanJobs.delete(playerId);
      if (unit !== null && unit.pathRequestLane === job.lane) {
        unit.pathRequestLane = PATH_REQUEST_NONE;
        unit.pathRequestForceLocal = false;
        if (action !== undefined && PATH_PLAN_SERVE_ACTION_TYPES.has(action.type)) {
          this.pathPlanScheduler.requestFresh(entity as Entity, job.forceLocal);
        }
      }
      return { status: 'invalid', expansionsUsed: 0 };
    }

    const result = advancePathPlanSlice(
      job.startX,
      job.startY,
      job.goalX,
      job.goalY,
      this.world.mapWidth,
      this.world.mapHeight,
      job.goalZ,
      job.terrainFilter,
      job.unitRadius,
      job.symmetricSlope,
      playerId,
      expansionBudget,
    );
    if (result.status === 'pending') {
      return { status: 'pending', expansionsUsed: result.expansionsUsed };
    }

    this.activePathPlanJobs.delete(playerId);
    unit.pathRequestLane = PATH_REQUEST_NONE;
    unit.pathRequestForceLocal = false;
    this.recordPathQueryOutcome(unit, result.plan.resolution, result.strategy);
    if (result.plan.resolution === 'unreachable') {
      // A search aimed at a DERIVED stand-off goal (build/attack approach
      // point) saying "unreachable" has only proven that the stand-off is
      // stranded — goal snapping requires a passable cell, not a connected
      // one. Retry at once aimed at the authored action point before
      // concluding anything about the order itself.
      const aimedAtDerivedGoal = job.formationRoute === null &&
        (job.goalX !== job.actionSnapshot.x || job.goalY !== job.actionSnapshot.y);
      if (aimedAtDerivedGoal && unit.pathNavGoalUnreachableActionHash !== unit.actionHash) {
        unit.pathNavGoalUnreachableActionHash = unit.actionHash;
        this.pathPlanScheduler.requestRefine(entity, job.forceLocal);
        return { status: 'complete', expansionsUsed: result.expansionsUsed };
      }
      // The body cannot leave where it stands (or nothing reachable exists).
      // Retrying next tick recomputes identical inputs; back off
      // exponentially and, past the give-up count, drop the order — BAR:
      // a unit that cannot get there stops instead of grinding forever.
      this.recordPathFailure(entity, unit);
      return { status: 'complete', expansionsUsed: result.expansionsUsed };
    }
    if (
      job.sharedRouteKey !== null &&
      result.plan.resolution === 'complete' &&
      result.strategy === 'hierarchical'
    ) {
      if (this.sharedRouteCache.size > 512) this.sharedRouteCache.clear();
      this.sharedRouteCache.set(job.sharedRouteKey, result.plan);
    }
    if (job.formationRoute !== null && job.formationCacheKey !== null) {
      if (this.formationRouteCache.size > 256) this.formationRouteCache.clear();
      this.formationRouteCache.set(job.formationCacheKey, result.plan);
      const translated = this.expandFormationRoutePoints(
        job.actionSnapshot,
        job.formationRoute,
        job.terrainVersion,
        job.terrainFilter,
        entity,
      );
      if (translated !== null) {
        this.installActivePathPlan(entity, unit, job.actionSnapshot, translated, job.terrainVersion);
      } else {
        // The shared anchor was valid but this offset corridor was not. A
        // local route gets the next available global job; never run twice now.
        this.pathPlanScheduler.requestFresh(entity, true);
      }
      return { status: 'complete', expansionsUsed: result.expansionsUsed };
    }

    const routeStillConnects = isPathPlanTraversable(
      entity.transform.x,
      entity.transform.y,
      result.plan.points,
      this.world.mapWidth,
      this.world.mapHeight,
      job.terrainFilter,
      unit.radius.collision,
      job.symmetricSlope,
    );
    if (!routeStillConnects) {
      this.pathPlanScheduler.requestFresh(entity, job.forceLocal);
      if (job.forceLocal) unit.stuckTicks = replanCooldownFor(this.world);
      return { status: 'complete', expansionsUsed: result.expansionsUsed };
    }
    if (
      job.forceLocal &&
      unit.activePath !== null &&
      unit.activePath.points.length > 1 &&
      result.plan.points.length <= 1
    ) {
      unit.stuckTicks = replanCooldownFor(this.world);
      return { status: 'complete', expansionsUsed: result.expansionsUsed };
    }
    this.installActivePathPlan(entity, unit, job.actionSnapshot, result.plan, job.terrainVersion);
    if (job.forceLocal) unit.stuckTicks = replanCooldownFor(this.world);
    return { status: 'complete', expansionsUsed: result.expansionsUsed };
  }

  private resolveActiveMovementTarget(entity: Entity, action: UnitAction): ActiveMovementTarget {
    const plan = this.ensureActivePathPlan(entity, action);
    if (plan === null || plan.points.length === 0) {
      return {
        // No self-propelled motion before a physically validated corridor.
        // The body remains fully dynamic under gravity, contact, impacts, and
        // passive friction; this is a controller hold, not a kinematic pin.
        x: entity.transform.x,
        y: entity.transform.y,
        z: entity.transform.z,
        isFinalActionPoint: false,
        pathAdvanceRadius: 0,
        cornerBendCos: 1,
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
    // A surviving intermediate point is one the loop above could not consume
    // (no validated shortcut to the point after it — switchback corners on
    // slopes). Passing it must not demand a pinpoint hit: once the unit
    // crosses the waypoint's perpendicular plane along the incoming leg,
    // inside a lateral corridor, the corner is done and steering may rotate
    // onto the next leg instead of oscillating around the point.
    if (
      plan.index < plan.points.length - 1 &&
      this.hasCrossedIntermediatePointPlane(entity, plan)
    ) {
      plan.index++;
    }
    // Advancing past a preview point shrinks the serialized route; re-mark
    // actions so selected-unit waypoint visuals follow the unit forward.
    if (plan.index !== startIndex) {
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
    }

    const point = plan.points[plan.index];
    const isLastPlanPoint = plan.index >= plan.points.length - 1;
    // A coarse first leg ends at an intermediate hold, never at the action's
    // arrival: the unit brakes there and waits for its refinement (or the
    // next leg) instead of completing the order short of the goal.
    const isFinalActionPoint = isLastPlanPoint && plan.resolution !== 'coarse';
    const pointDx = point.x - entity.transform.x;
    const pointDy = point.y - entity.transform.y;
    const closeEnoughForBroadAdvance = magnitude(pointDx, pointDy) <= ARRIVAL_RADIUS;
    const pathAdvanceRadius = isLastPlanPoint || (
      closeEnoughForBroadAdvance &&
      this.isDirectPathPointReachable(entity, plan.points[plan.index + 1])
    ) ? ARRIVAL_RADIUS : 1;
    // Corner speed shaping only matters for the tight (no-shortcut) corners;
    // broad-advance points are consumed 50 wu out and never steered at
    // closely. The approach leg is measured from the live position so a unit
    // rejoining the route after a slide still sees its true bend.
    let cornerBendCos = 1;
    if (!isFinalActionPoint && pathAdvanceRadius < ARRIVAL_RADIUS) {
      const next = plan.points[plan.index + 1];
      const outDx = next.x - point.x;
      const outDy = next.y - point.y;
      const inLength = magnitude(pointDx, pointDy);
      const outLength = magnitude(outDx, outDy);
      if (inLength > 1e-6 && outLength > 1e-6) {
        cornerBendCos = (pointDx * outDx + pointDy * outDy) / (inLength * outLength);
      }
    }
    return {
      x: point.x,
      y: point.y,
      z: point.z,
      isFinalActionPoint,
      pathAdvanceRadius,
      cornerBendCos,
    };
  }

  /** True when the unit has passed the current intermediate waypoint's
   *  perpendicular plane (measured along the incoming leg direction) while
   *  staying inside the leg's lateral corridor. The corridor keeps a unit
   *  that slid far off the planned line from skipping corners it never
   *  actually rounded; the plane test keeps a fast unit that stepped over
   *  the point in one tick from turning back to hunt a 1-wu bullseye. */
  private hasCrossedIntermediatePointPlane(
    entity: Entity,
    plan: NonNullable<Unit['activePath']>,
  ): boolean {
    const unit = entity.unit;
    if (unit === null) return false;
    const point = plan.points[plan.index];
    const px = entity.transform.x - point.x;
    const py = entity.transform.y - point.y;
    let legX: number;
    let legY: number;
    if (plan.index > 0) {
      const prev = plan.points[plan.index - 1];
      legX = point.x - prev.x;
      legY = point.y - prev.y;
    } else {
      // The first point has no incoming leg; the unit's motion direction is
      // the approach direction.
      legX = unit.velocityX;
      legY = unit.velocityY;
    }
    const legLength = magnitude(legX, legY);
    if (legLength <= 1e-6) return false;
    const invLegLength = 1 / legLength;
    const alongLeg = (px * legX + py * legY) * invLegLength;
    if (alongLeg < 0) return false;
    const lateral = Math.abs(px * legY - py * legX) * invLegLength;
    return lateral <= PATHFINDING_INTERMEDIATE_CORRIDOR_WU;
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
    // Every body-forward locomotion preset resolves pass-through waypoint
    // legs through the no-turn escape ring. Final stopping anchors still use
    // the ordinary critically damped arrival controller; cruise aircraft use
    // perpetual terminal pursuit as before.
    const unit = entity.unit;
    if (
      unit !== null &&
      unit.locomotion.motionControl.waypointDeadzone !== undefined &&
      this.waypointOrbit.queue(
        entity,
        action,
        target.isFinalActionPoint,
        target.pathAdvanceRadius,
        dx,
        dy,
      )
    ) {
      return;
    }
    if (!target.isFinalActionPoint && target.pathAdvanceRadius < ARRIVAL_RADIUS) {
      const distance = magnitude(dx, dy);
      if (distance <= target.pathAdvanceRadius) {
        this.advanceActivePathPoint(entity);
      } else {
        this.arrivalController.queueThrust(
          entity,
          action,
          dx,
          dy,
          distance,
          false,
          target.cornerBendCos,
        );
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

  /** BAR constructor Patrol picks up nearby reclaim on its own — including
   *  world features, which is how a patrolling con clears trees along its
   *  route. Vegetation therefore competes with hostile entities for the
   *  nearest-target slot, tie-broken by target id so every peer picks the
   *  same prop. */
  private findPatrolReclaimTarget(builder: Entity): ReclaimTarget | null {
    const playerId = builder.ownership?.playerId;
    if (playerId === undefined) return null;
    let best: ReclaimTarget | null = null;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    const offer = (candidate: ReclaimTarget, distanceSq: number): void => {
      if (
        distanceSq < bestDistanceSq ||
        (distanceSq === bestDistanceSq && (best === null || candidate.id < best.id))
      ) {
        best = candidate;
        bestDistanceSq = distanceSq;
      }
    };
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
      offer(makeEntityReclaimTarget(target), dx * dx + dy * dy);
    };
    // Spatial candidates instead of walking EVERY unit and building per
    // patrolling builder per tick (the vegetation half below already did
    // this). The query is a strict superset of the range test: 2D circle,
    // unit tests padded by target hitbox, buildings by AABB distance, and
    // maxVisibilityPadding bounds any target's collision/footprint extent.
    // The (distanceSq, id) reduction in offer() is order-independent, so
    // the different candidate order cannot change the winner.
    const candidateRange =
      (builder.builder?.buildRange ?? 0) + this.world.getMaxVisibilityPadding();
    const candidates = spatialGrid.queryEnemyEntitiesInCircle2D(
      builder.transform.x,
      builder.transform.y,
      candidateRange,
      playerId,
    );
    for (let i = 0; i < candidates.length; i++) consider(candidates[i]);

    const buildRange = builder.builder?.buildRange ?? 0;
    if (buildRange > 0) {
      const found = queryVegetationInCircle(
        builder.transform.x,
        builder.transform.y,
        buildRange + PATROL_RECLAIM_VEGETATION_RADIUS_PADDING,
        _patrolVegetationQueryScratch,
      );
      for (let i = 0; i < found; i++) {
        const prop = getVegetationProp(_patrolVegetationQueryScratch[i]);
        if (prop === undefined) continue;
        if (!isBuildRadiusTargetInRange(builder, prop.x, prop.y, prop.radius)) continue;
        const dx = prop.x - builder.transform.x;
        const dy = prop.y - builder.transform.y;
        offer(makeVegetationReclaimTarget(prop), dx * dx + dy * dy);
      }
    }
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

    // A cruise chassis never holds a satisfied anchor: its terminating
    // waypoint stays a permanently active pursuit goal (the plane always
    // turns toward it), so clear the flag and fall through to the ordinary
    // action handling that steers at it.
    if (unit.locomotion.motionControl.cruiseWhenUncommanded) {
      clearMovementAnchorSatisfied(currentAction);
      unit.activePath = null;
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      return false;
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
    // P1-08: the full unit/queue sweep only runs while a gather wait can
    // exist. The flag arms at the single creation site and clears when a
    // sweep proves the world empty of groups.
    if (!this.world.gatherWaitsMayExist) return;
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
    if (sortedGroups.length === 0) this.world.gatherWaitsMayExist = false;
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
  /** Hand every building added since the last drain to the host so it can
   *  build the static collision body. Entities that already have one (the
   *  bootstrap pass builds its own) are skipped, so this is idempotent. */
  private flushPendingBuildingBodies(): void {
    const pending = this.world.pendingBuildingBodySpawns;
    if (pending.length === 0) return;
    const spawned: Entity[] = [];
    for (let i = 0; i < pending.length; i++) {
      const entity = pending[i];
      if (entity.body !== null) continue;
      if (this.world.getEntity(entity.id) !== entity) continue;
      spawned.push(entity);
    }
    pending.length = 0;
    if (spawned.length === 0) return;
    const onBuildingSpawn = this.onBuildingSpawn;
    if (onBuildingSpawn !== null) onBuildingSpawn(spawned);
  }

  /** Retire shells that decayed back to zero progress. This is the same
   *  teardown the dead-building path runs (spatial grid, build-grid release
   *  through onBuildingDeath, entity removal) with no death event: a frame
   *  nobody paid for was never alive enough to explode. */
  private removeDecayedConstructionShells(shells: readonly Entity[]): void {
    const ids: EntityId[] = [];
    for (let i = 0; i < shells.length; i++) ids.push(shells[i].id);
    ids.sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) spatialGrid.removeBuilding(ids[i]);
    if (this.onBuildingDeath !== null) this.onBuildingDeath(ids);
    for (let i = 0; i < ids.length; i++) this.world.removeEntity(ids[i]);
  }

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
    const event = createSelfDestructEvent(entity, armed);
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
      this.world.armedSelfDestructs.set(
        entity.id,
        this.world.getTick() + selfDestructCountdownTicks(this.world),
      );
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

    // Every fixed tick funds one global work ceiling. Players with demand (a
    // retained frontier or an eligible queue entry) are visited round-robin
    // from a persistent cursor; each visited player's route queue and then
    // refine queue receive one quantum. A refine search that outlives its
    // quantum keeps its frontier in that player's own WASM arena and resumes
    // on the player's next visit; a player that runs dry hands the leftover
    // to the next player with demand in the same tick, and the pass repeats
    // while budget and demand remain. One player's flood never delays
    // another player's first motion. All selection state is derived
    // lockstep state.
    const roster = this.world.teamRoster;
    const scheduler = this.pathPlanScheduler;
    const activeJobs = this.activePathPlanJobs;
    // Traffic heat decays on a fixed cadence so spread-out routes relax back
    // to the shortest lane once traffic passes.
    if (this.world.getTick() % PATHFINDING_TRAFFIC_HEAT_DECAY_TICKS === 0) {
      decayPathfindingTrafficHeat();
    }
    let expansionsRemaining = PATHFINDING_A_STAR_EXPANSIONS_PER_TICK;
    let frontierPending = false;
    const pathfindingStartMs = telemetryNowMs();
    scheduler.beginTick(this.world.getTick(), roster, activeJobs);
    let turn = scheduler.nextTurn(roster, activeJobs);
    while (turn !== null && expansionsRemaining > 0) {
      const { playerId } = turn;
      let quantum = Math.min(turn.quantum, expansionsRemaining);
      const quantumOffered = quantum;
      if (turn.tier === PATH_QUEUE_ROUTE) {
        while (quantum > 0) {
          const used = scheduler.drainRoute(
            turn,
            (entityId, lane) => this.serveRouteRequest(playerId, entityId, lane),
          );
          if (used <= 0) break;
          quantum -= used;
          expansionsRemaining -= used;
        }
      } else {
        while (quantum > 0) {
          if (!activeJobs.has(playerId)) {
            const admitted = scheduler.drainRefine(
              turn,
              (entityId, lane) => this.admitPathPlanRequest(playerId, entityId, lane),
            );
            if (!admitted) break;
          }
          const outcome = this.advanceActivePathPlanJob(playerId, quantum);
          if (outcome.status === 'invalid') continue;
          // A query that resolves in direct/preflight work can close zero
          // fine nodes. Charge one deterministic admission unit so a stream
          // of zero-expansion completions cannot monopolize the quantum.
          const used = Math.max(1, outcome.expansionsUsed);
          quantum -= used;
          expansionsRemaining -= used;
          if (outcome.status === 'pending') {
            // This player's quantum is spent; the frontier waits in its own
            // arena for the player's next visit while the cursor moves on.
            frontierPending = true;
            break;
          }
        }
      }
      scheduler.chargeTurn(turn, quantumOffered - quantum);
      turn = expansionsRemaining > 0 ? scheduler.nextTurn(roster, activeJobs) : null;
    }
    scheduler.endTick(
      roster,
      activeJobs,
      PATHFINDING_A_STAR_EXPANSIONS_PER_TICK - expansionsRemaining,
      expansionsRemaining,
      frontierPending,
    );
    this.pathfindingMsStat.record(telemetryNowMs() - pathfindingStartMs);
    this.pathfindingMsStat.endTick(this.world.getTick());
    this.pathRouteLatencyStat.endTick(this.world.getTick());
    SIM_TICK_INSTRUMENTATION.phase('sim.pathfinding');

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
          !isBuildInProgress(entity.buildable) &&
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
      if (isBuildInProgress(entity.buildable)) {
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

      // A BEAM-CARRIED passenger drives nothing — the transport's tractor
      // spring owns its motion until release — but its weapons and combat
      // intent remain live. This matters when an enemy transport abducts an
      // armed unit: the visible, targetable passenger can shoot its carrier.
      // Non-combat orders stay parked for the drop.
      if (entity.transported !== null) {
        entitySlotRegistry.setUnitDriveInput(entity, 0, 0, 0, 0, entitySlot);
        const combat = entity.combat;
        if (combat !== null && !combat.manualLaunchActive) {
          combat.priorityTargetId = null;
          combat.priorityTargetPoint = null;
          const carriedAction = unit.actions[0];
          if (carriedAction?.type === 'attack' && carriedAction.targetId !== undefined) {
            combat.priorityTargetId = carriedAction.targetId;
          } else if (carriedAction?.type === 'attackGround') {
            combat.priorityTargetPoint = {
              x: carriedAction.x,
              y: carriedAction.y,
              z: carriedAction.z ?? this.world.getGroundZ(carriedAction.x, carriedAction.y),
            };
          }
        }
        continue;
      }

      // Default: no thrust (contact braking/damping will slow or hold the unit)
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
      const preSweepHead = unit.actions[0];
      if (this.actionQueueMaintenance.sweepInvalidTargetActions(
        entity,
        // P1-09: the executing head is validated every tick; the rest of
        // the queue heals on a 2.5 Hz stagger (offset from the P1-11
        // patrol stagger so the two full passes don't stack on one tick).
        ((this.world.getTick() + entity.id) & 7) !== 4,
      )) {
        const combat = entity.combat;
        if (
          isGuardRetaliationAttackAction(preSweepHead) &&
          combat !== null &&
          combat.priorityTargetId === preSweepHead.targetId
        ) {
          combat.priorityTargetId = null;
        }
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

      // P1-10: the reachable-service promotion is a linear queue scan with
      // range/target lookups; 10 Hz staggered by entity id keeps the
      // promotion within 50ms of eligibility at half the scan volume.
      if (((this.world.getTick() + entity.id) & 1) === 0) {
        this.actionQueueMaintenance.promoteReachableBuildAction(entity);
      }

      // BAR constructor Patrol services nearby allies first (the energy pass
      // marks that above), then temporarily reclaims a nearby non-allied
      // entity before resuming its loop. The durable Patrol remains on the
      // host queue; turret locks are not used to choose construction work.
      let currentAction = unit.actions[0];
      if (
        currentAction.type === 'patrol' &&
        entity.builder !== null &&
        !this.energyBuffers.sweepServicingBuilderIds.has(entity.id) &&
        // P1-11: patrol reclaim acquisition runs two spatial queries plus
        // candidate range tests; 2.5 Hz staggered by entity id bounds a
        // fresh acquisition at 400ms while approach/work stay fixed-tick.
        ((this.world.getTick() + entity.id) & 7) === 0
      ) {
        const reclaimTarget = this.findPatrolReclaimTarget(entity);
        if (reclaimTarget !== null) {
          const targetPoint = reclaimTarget.kind === 'entity'
            ? getEntityTargetPoint(reclaimTarget.entity)
            : reclaimTarget;
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
      if (currentAction.type === 'guard') {
        const retaliation = buildGuardRetaliationAttack(this.world, entity, currentAction);
        if (retaliation !== null) {
          unshiftUnitAction(unit, retaliation);
          currentAction = retaliation;
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
        }
      }
      if (
        isGuardRetaliationAttackAction(currentAction) &&
        !isValidGuardRetaliationAttack(this.world, entity, currentAction)
      ) {
        const combat = entity.combat;
        if (combat !== null && combat.priorityTargetId === currentAction.targetId) {
          combat.priorityTargetId = null;
        }
        this.advanceAction(entity);
        unit.stuckTicks = 0;
        continue;
      }
      if (currentAction.type === 'selfDestruct') {
        this.activateQueuedSelfDestructAction(entity);
        continue;
      }
      if (this.handleSatisfiedMovementAnchor(entity, currentAction)) {
        continue;
      }
      this.airborneLoiter.rememberTarget(unit, currentAction);

      let flags = 0;
      let serviceTarget: UnitPathPoint | null = null;
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
        currentAction.type === 'capture'
      ) {
        const targetId = currentAction.type === 'build'
          ? currentAction.buildingId
          : currentAction.targetId;
        if (targetId !== undefined) {
          const vegetationProp = currentAction.type === 'reclaim'
            ? getLiveVegetationPropByTargetId(targetId)
            : undefined;
          if (vegetationProp !== undefined) {
            // Vegetation has no entity slot for the native range pass to
            // read, but a prop never moves: resolve the surface-to-surface
            // build-range test here and hand the batch the same flag it
            // would have produced.
            if (
              entity.builder !== null &&
              isBuildRadiusTargetInRange(
                entity,
                vegetationProp.x,
                vegetationProp.y,
                vegetationProp.radius,
              )
            ) {
              flags |= UNIT_ACTION_FLAG_TARGET_IN_BUILD_RANGE;
            }
          } else {
            rangeKind = UNIT_ACTION_RANGE_KIND_BUILD;
            rangeTargetSlot = entitySlotRegistry.getSlot(targetId);
            rangeParam = entity.builder !== null ? entity.builder.buildRange : 0;
            if (currentAction.type === 'build') {
              const target = this.world.getEntity(targetId);
              if (target !== undefined && isBuilderClearOfBuildFootprint(entity, target)) {
                flags |= UNIT_ACTION_FLAG_BUILD_FOOTPRINT_CLEAR;
              }
            }
          }
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
          isFriendlyGuardTarget(guardTarget, guardOwnerId, this.arePlayersAlliedFn);
        if (isFriendlyGuard) {
          flags |= UNIT_ACTION_FLAG_GUARD_FRIENDLY;

          // BAR: a guarding builder continuously services its target — assist
          // its construction/production, repair it, or join the guarded
          // builder's reclaim. Approach that same work point
          // within build range; otherwise fall through to plain follow.
          if (entity.builder !== null) {
            const service = resolveGuardServiceTarget(this.world, entity);
            if (service !== null) {
              flags |= UNIT_ACTION_FLAG_GUARD_SERVICE;
              if (service.kind === 'reclaim') {
                serviceTarget = {
                  x: service.target.x,
                  y: service.target.y,
                  z: service.target.z,
                };
                if (service.target.kind === 'vegetation') {
                  if (isReclaimTargetInBuildRange(entity, service.target)) {
                    flags |= UNIT_ACTION_FLAG_GUARD_SERVICE_IN_RANGE;
                  }
                } else {
                  rangeKind = UNIT_ACTION_RANGE_KIND_GUARD_SERVICE;
                  rangeTargetSlot = entitySlotRegistry.getSlot(service.target.entity.id);
                  rangeParam = entity.builder.buildRange;
                }
              } else {
                serviceTarget = getEntityTargetPoint(service.target);
                rangeKind = UNIT_ACTION_RANGE_KIND_GUARD_SERVICE;
                rangeTargetSlot = entitySlotRegistry.getSlot(service.target.id);
                rangeParam = entity.builder.buildRange;
              }
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
          this.airborneLoiter.queue(entity);
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
          const servicePoint = 'transform' in target
            ? getEntityTargetPoint(target)
            : target;
          movementPlanner.queue(
            entity,
            currentAction,
            UNIT_ACTION_PLAN_GUARD_SERVICE_MOVE,
            entitySlot,
            servicePoint.x,
            servicePoint.y,
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
              this.arePlayersAlliedFn,
            )
          ) {
            this.advanceAction(entity);
            unit.stuckTicks = 0;
            break;
          }
          const followPlan = calculateGuardFollowPlan(entity, guardTarget);
          if (followPlan.mode === 'hold') {
            unit.stuckTicks = 0;
            break;
          }

          if (shouldRefreshGuardFollowGoal(entity, currentAction, followPlan)) {
            this.tryRefreshGuardApproach(entity, currentAction, followPlan);
          }

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
            followPlan.desiredVelocityX,
            followPlan.desiredVelocityY,
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
          1,
          movementPlanner.desiredVelocityXAt(i),
          movementPlanner.desiredVelocityYAt(i),
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
            unit.stuckTicks = replanCooldownFor(this.world);
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
              this.arePlayersAlliedFn,
            )
          ) {
            this.advanceAction(entity);
            unit.stuckTicks = 0;
            continue;
          }
          const followPlan = calculateGuardFollowPlan(entity, guardTarget);
          if (followPlan.mode === 'hold') {
            unit.stuckTicks = 0;
            continue;
          }
          if (
            shouldRefreshGuardFollowGoal(entity, action, followPlan) &&
            this.tryRefreshGuardApproach(entity, action, followPlan)
          ) {
            unit.stuckTicks = 0;
            continue;
          }
          const targetDx = followPlan.x - entity.transform.x;
          const targetDy = followPlan.y - entity.transform.y;
          this.arrivalController.queueThrust(
            entity,
            action,
            targetDx,
            targetDy,
            magnitude(targetDx, targetDy),
            true,
            1,
            followPlan.desiredVelocityX,
            followPlan.desiredVelocityY,
          );
          continue;
        }
        unit.stuckTicks = 0;
      }
    }

    this.arrivalController.flushCompletion();
    this.waypointOrbit.flush(movingUnits);
    this.airborneLoiter.flush(movingUnits);
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

  /** Memoized per (blueprint, mass, support offset, liquid mode): the
   *  filter is a pure function of those inputs, and the old shape
   *  allocated 3-4 nested objects >= 2x per MOVING unit per tick (it sits
   *  inside the waypoint-consume loop). Consumers only read the filter. */
  private readonly pathTerrainFilterMemo = new Map<string, PathTerrainFilter | null>();

  /** Hoisted alliance predicate — the inline arrow allocated a closure per
   *  guarding unit per tick at three call sites. */
  private readonly arePlayersAlliedFn = (a: PlayerId, b: PlayerId): boolean =>
    this.world.arePlayersAllied(a, b);

  private pathTerrainFilterForUnit(entity: Entity): PathTerrainFilter | null {
    const unit = entity.unit;
    if (unit === null) {
      return applyLiquidHazardPathPolicy(null, this.world.liquidSurfaceMode, 0);
    }
    const waterDamagePerSecond =
      unit.locomotion?.environmentalHazards?.waterDamagePerSecond ?? 0;
    const key = `${unit.unitBlueprintId}:${unit.mass}:${unit.supportPointOffsetZ}:${this.world.liquidSurfaceMode}:${waterDamagePerSecond}`;
    const cached = this.pathTerrainFilterMemo.get(key);
    if (cached !== undefined) return cached;
    const filter = applyLiquidHazardPathPolicy(
      pathTerrainFilterForLocomotion(
        unit.locomotion,
        unit.mass,
        unit.supportPointOffsetZ,
      ),
      this.world.liquidSurfaceMode,
      waterDamagePerSecond,
    );
    this.pathTerrainFilterMemo.set(key, filter);
    return filter;
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

    if (
      completedAction.type === 'build' ||
      completedAction.type === 'repair' ||
      completedAction.type === 'reclaim' ||
      completedAction.type === 'capture'
    ) {
      releaseBuilderWorkStation(this.world, entity);
    }

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
    } else if (
      !isGuardRetaliationAttackAction(completedAction) &&
      unit.repeatQueue &&
      hasQueuedActionIntents(unit.actions)
    ) {
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

    // currentBuildTarget is only a render/network mirror of the head action.
    // Refresh it in the completion tick so the finished buildee cannot survive
    // in snapshots until the next economy pass.
    syncBuilderActiveBuildTarget(this.world, entity);

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
    this.airborneLoiter.reset();
    this.waypointOrbit.reset();
    this.stuckReplanController.reset();
    resetPathfinderMatchState();
    this.activePathPlanJobs.clear();
    Object.assign(this.pathQueryOutcomes, createEmptyPathQueryOutcomeStats());
    this.formationRouteCache.clear();
    this.pathPlanScheduler.reset();
    this.pathRouteLatencyStat.reset();
    this.pathfindingMsStat.reset();
    this.combatHaltController.reset();
    this.idleBuilderAutoRepair.reset();
    this.unitActionPlanner.reset();
    this.unitActionMovementPlanner.reset();
    this.world.clearPendingDeathCheckIds();
    resetEnergyBuffers(this.energyBuffers);
    resetTransportModuleState();
    this.spatialGridBuildingVersion = -1;
  }
}

/** Always-on, deterministic route-outcome counters. */
export type PathQueryOutcomeStats = {
  complete: number;
  snapped: number;
  partial: number;
  unreachable: number;
  direct: number;
  hierarchical: number;
  /** Boxed fine searches (short routes, no hierarchy). */
  local: number;
  /** Requests refused without a search: the body stood outside its medium. */
  outOfMedium: number;
  /** Unreachable/terminal results that entered retry backoff. The order is
   *  never dropped; the backoff lifts when the unit's cell or the navigation
   *  layers change. */
  failures: number;
  /** Validated straight first legs installed by the route queue while the
   *  full route was still queued, and route-queue entries where no leg down
   *  to the minimum length validated (the unit held for its refinement). */
  firstLegs: number;
  firstLegMisses: number;
  /** Routes adopted from the shared cluster-pair cache (no search). */
  sharedRouteHits: number;
  unreachableByBlueprint: Map<string, number>;
};

function createEmptyPathQueryOutcomeStats(): PathQueryOutcomeStats {
  return {
    complete: 0,
    snapped: 0,
    partial: 0,
    unreachable: 0,
    direct: 0,
    hierarchical: 0,
    local: 0,
    outOfMedium: 0,
    failures: 0,
    firstLegs: 0,
    firstLegMisses: 0,
    sharedRouteHits: 0,
    unreachableByBlueprint: new Map(),
  };
}
