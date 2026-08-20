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
  advancePathPlanSlice,
  cancelAllPathPlanSlices,
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
import { getTerrainVersion, isWaterAt } from './Terrain';
import {
  PATHFINDING_CHASE_REPATH_COOLDOWN_TICKS,
  PATHFINDING_CHASE_REPATH_DRIFT_DISTANCE_FRACTION,
  PATHFINDING_CHASE_REPATH_DRIFT_MIN_WU,
  PATHFINDING_DIRECT_PLAN_MAX_DISTANCE_WU,
  PATHFINDING_INTERMEDIATE_CORRIDOR_WU,
  PATHFINDING_PARTIAL_PLAN_RETRY_TICKS,
  PATHFINDING_A_STAR_EXPANSIONS_PER_TEAM_TURN,
} from './pathfindingTuning';
import {
  PATH_REQUEST_FRESH,
  PATH_REQUEST_NONE,
  PATH_REQUEST_REFRESH,
  selectPathPlanTeamTurn,
  SimulationPathPlanScheduler,
} from './SimulationPathPlanScheduler';
import { registerPathfinderBuildingOccupancy } from './pathfinderTerrainCache';
import { getAllyTeamId, type AllyTeamId } from './teamRoster';
import { getUnitLocomotionTraversalCapabilities } from './unitLocomotion';
import { updateBuildingActiveStates } from './buildingActiveState';
import { applyLavaSurfaceDamage } from './lavaSurfaceDamage';
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
import { createSelfDestructEvent } from './selfDestructEvent';
import { isBuildRadiusTargetInRange, isBuildTargetInRange } from './builderRange';
import { SIM_TICK_INSTRUMENTATION } from '../perf/SimTickInstrumentation';
import {
  isReclaimableTarget,
  makeEntityReclaimTarget,
  makeVegetationReclaimTarget,
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
import { SimulationCombatHaltController } from './SimulationCombatHaltController';
import {
  replanCooldownFor,
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
  private airborneLoiter: SimulationAirborneLoiterController;
  private stuckReplanController: SimulationStuckReplanController;
  private unitActionPlanner: SimulationUnitActionPlanner = new SimulationUnitActionPlanner();
  private unitActionMovementPlanner: SimulationUnitActionMovementPlanner = new SimulationUnitActionMovementPlanner();
  private forceAccumulator: ForceAccumulator = new ForceAccumulator();
  private readonly formationRouteCache = new Map<string, ExpandedPathPlan>();
  private readonly pathPlanScheduler: SimulationPathPlanScheduler;
  private readonly activePathPlanJobs = new Map<AllyTeamId, ActivePathPlanJob>();
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
    this.pathPlanScheduler = new SimulationPathPlanScheduler(
      () => this.world.simulationTickRateHz,
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

    // Resource converters are one-way energy -> metal makers. Run after
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
    if (commanderResult.resurrectedUnits.length > 0) {
      const onUnitSpawn = this.onUnitSpawn;
      if (onUnitSpawn !== null) onUnitSpawn(commanderResult.resurrectedUnits);
    }
    SIM_TICK_INSTRUMENTATION.phase('sim.commanderAbilities');

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
    this.deadEntityCleanup.run(this.onUnitDeath, this.onBuildingDeath, this.onBuildingSpawn);
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

    // Update traveling projectile positions for projectile broadphase
    // queries. Beam/laser line shots are handled by beam pathing.
    spatialGrid.updateProjectiles(this.world.getTravelingProjectiles());
  }

  // Check for game over - last commander standing wins
  private checkGameOver(): boolean {
    if (this.gameOverWinnerId !== null) return false; // Already over
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
   *  apply immediately; every real A* request waits for its ally team's one
   *  resumable job and round-robin work turn. A unit with no safe route
   *  returns null and supplies no destination-directed drive this tick. */
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
      const buildingGridVersion = this.constructionSystem.getGrid().getVersion();
      if (plan.buildingGridVersion !== buildingGridVersion) {
        if (
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

    this.pathPlanScheduler.requestFresh(entity, false);
    return null;
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

  /** Admit one queued request into the selected ally team's continuation.
   *  Direct routes and formation-cache hits are installed for free and return
   *  false so admission can keep scanning. */
  private admitPathPlanRequest(
    teamId: AllyTeamId,
    entityId: EntityId,
    lane: number,
  ): boolean {
    const entity = this.world.getEntity(entityId);
    if (entity === undefined) return false;
    const unit = entity.unit;
    if (unit === null || unit.hp <= 0) return false;
    if (unit.pathRequestLane !== lane) return false;
    const playerId = entity.ownership?.playerId ?? (0 as PlayerId);
    if (getAllyTeamId(this.world.teamRoster, playerId) !== teamId) return false;
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

    const terrainFilter = this.pathTerrainFilterForUnit(entity);
    let formationRoute = !forceLocal && unit.activePath === null
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
          unit.pathRequestLane = PATH_REQUEST_NONE;
          unit.pathRequestForceLocal = false;
          this.installActivePathPlan(entity, unit, action, translated, terrainVersion);
          return false;
        }
        formationRoute = null;
        formationCacheKey = null;
      }
    }

    this.activePathPlanJobs.set(teamId, {
      entityId,
      lane,
      forceLocal,
      actionHash: unit.actionHash,
      actionSnapshot: { ...action },
      terrainVersion,
      buildingGridVersion: this.constructionSystem.getGrid().getVersion(),
      startX: formationRoute?.startX ?? entity.transform.x,
      startY: formationRoute?.startY ?? entity.transform.y,
      goalX: formationRoute?.goalX ?? action.x,
      goalY: formationRoute?.goalY ?? action.y,
      goalZ: action.z ?? null,
      terrainFilter,
      unitRadius: formationRoute?.radius ?? unit.radius.collision,
      symmetricSlope: this.world.slopePathMode === 'symmetric',
      formationRoute,
      formationCacheKey,
    });
    return true;
  }

  /** Resume or finish one team's path job. Invalid live intent is free, so the
   *  scheduler may admit a replacement in the same team turn. */
  private advanceActivePathPlanJob(
    teamId: AllyTeamId,
    expansionBudget: number,
  ): { status: 'invalid' | 'pending' | 'complete'; expansionsUsed: number } {
    const job = this.activePathPlanJobs.get(teamId);
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
    const navigationStillMatches = getTerrainVersion() === job.terrainVersion &&
      this.constructionSystem.getGrid().getVersion() === job.buildingGridVersion;
    if (
      entity === undefined ||
      unit === null ||
      unit.hp <= 0 ||
      unit.pathRequestLane !== job.lane ||
      !actionStillMatches ||
      !navigationStillMatches
    ) {
      cancelPathPlanSlice(teamId);
      this.activePathPlanJobs.delete(teamId);
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
      teamId,
      expansionBudget,
    );
    if (result.status === 'pending') {
      return { status: 'pending', expansionsUsed: result.expansionsUsed };
    }

    this.activePathPlanJobs.delete(teamId);
    unit.pathRequestLane = PATH_REQUEST_NONE;
    unit.pathRequestForceLocal = false;
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
    const isFinalActionPoint = plan.index >= plan.points.length - 1;
    const pointDx = point.x - entity.transform.x;
    const pointDy = point.y - entity.transform.y;
    const closeEnoughForBroadAdvance = magnitude(pointDx, pointDy) <= ARRIVAL_RADIUS;
    const pathAdvanceRadius = isFinalActionPoint || (
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
    const units = this.world.getUnits();
    for (let i = 0; i < units.length; i++) consider(units[i]);
    const buildings = this.world.getBuildings();
    for (let i = 0; i < buildings.length; i++) consider(buildings[i]);

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

    // Exactly one ally team receives deterministic A* work in a fixed tick.
    // It resumes its retained frontier first, then may spend unused expansions
    // on more routes for that same team. Other teams wait for their turns.
    const roster = this.world.teamRoster;
    const selectedTeamTurn = selectPathPlanTeamTurn(this.world.getTick(), roster);
    if (selectedTeamTurn !== null) {
      const { teamId, teamTurn } = selectedTeamTurn;
      let expansionsRemaining = PATHFINDING_A_STAR_EXPANSIONS_PER_TEAM_TURN;
      while (expansionsRemaining > 0) {
        if (!this.activePathPlanJobs.has(teamId)) {
          const admitted = this.pathPlanScheduler.drainTeam(
            teamTurn,
            roster,
            teamId,
            (entityId, lane) => this.admitPathPlanRequest(teamId, entityId, lane),
          );
          if (!admitted) break;
        }
        const outcome = this.advanceActivePathPlanJob(teamId, expansionsRemaining);
        if (outcome.status === 'invalid') continue;
        // A query that resolves in direct/preflight work can close zero fine
        // nodes. Charge one deterministic admission unit so a pathological
        // stream of zero-expansion completions cannot monopolize the tick.
        expansionsRemaining -= Math.max(1, outcome.expansionsUsed);
        if (outcome.status === 'pending') break;
      }
    }
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
      if (currentAction.type === 'selfDestruct') {
        this.activateQueuedSelfDestructAction(entity);
        continue;
      }
      if (this.handleSatisfiedMovementAnchor(entity, currentAction)) {
        continue;
      }
      this.airborneLoiter.rememberTarget(unit, currentAction);

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

  private pathTerrainFilterForUnit(entity: Entity): PathTerrainFilter | null {
    const physicalFilter = entity.unit === null
      ? null
      : pathTerrainFilterForLocomotion(
          entity.unit.locomotion,
          entity.unit.mass,
          entity.unit.supportPointOffsetZ,
        );
    return applyLiquidHazardPathPolicy(physicalFilter, this.world.liquidSurfaceMode);
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
      completedAction.type === 'capture' ||
      completedAction.type === 'resurrect'
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
    this.stuckReplanController.reset();
    cancelAllPathPlanSlices();
    this.activePathPlanJobs.clear();
    this.formationRouteCache.clear();
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
