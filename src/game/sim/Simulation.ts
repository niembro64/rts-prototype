import { WorldState } from './WorldState';
import { CommandQueue } from './commands';
import type { Entity, EntityId, PlayerId, Unit, UnitAction, UnitPathPoint } from './types';
import { NO_ENTITY_ID } from './types';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import { magnitude } from '../math';
import { executeCommand, type CommandContext } from './commandExecution';
import { distributeEnergy, createEnergyBuffers, resetEnergyBuffers, type EnergyBuffers } from './energyDistribution';
import { resourceMovementSystem } from './resourceMovement';
import {
  updateTargetingAndFiringState,
  updateTurretRotation,
  updateLaserSounds,
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
  resetLaserSoundState,
  updateShieldSounds,
  emitShieldStopsForEntity,
  resetShieldSoundState,
  fireTurrets,
  updateShieldState,
  resetShieldBuffers,
  registerPackedProjectile,
  unregisterPackedProjectile,
} from './combat';
import {
  stampCombatTargetingPool,
  stampShieldSurfacePool,
} from './combat/targetingInputStamping';
import {
  updateProjectiles,
  checkProjectileCollisions,
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
import {
  isBuildBlockingActivation,
  isBuildInProgress,
} from './buildableHelpers';
import { commanderAbilitiesSystem, type SprayTarget } from './commanderAbilities';
import { updateUnitGroundNormal } from './unitGroundNormal';
import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';
import { transitionPhase } from '@/gamePhase';
import {
  ENTITY_CHANGED_ACTIONS,
  ENTITY_CHANGED_TURRETS,
} from '@/types/network';
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
import { getGuardFollowRadius, isFriendlyGuardTarget } from './guard';
import { WindPowerTracker, sampleWindState, sampleWindStateInto, type WindState } from './wind';
import { isBuildTargetInRange } from './builderRange';
import { isReclaimableTarget } from './reclaim';
import { setUnitMovementAcceleration } from './unitMovementAcceleration';
import { getActionIntentStart, getUnitActionTargetId } from './unitActionIntents';
import { getSimWasm } from '../sim-wasm/init';
import {
  rotateFirstUnitActionToEnd,
  refreshUnitActionHash,
  shiftUnitAction,
  spliceUnitActions,
} from './unitActions';
import {
  SimulationEventQueues,
  safeVelocityUpdates,
} from './SimulationEventQueues';
import { resolveCommanderGameOverWinner } from './SimulationGameOver';
import { SimulationDeathExplosionPlanner } from './SimulationDeathExplosionPlanner';
import { SimulationDeadEntityCleanup } from './SimulationDeadEntityCleanup';
import {
  ARRIVAL_RADIUS,
  SimulationArrivalController,
} from './SimulationArrivalController';
import {
  SimulationFlyingLoiterController,
} from './SimulationFlyingLoiterController';
import { SimulationCombatHaltController } from './SimulationCombatHaltController';

type ActiveMovementTarget = UnitPathPoint & {
  isFinalActionPoint: boolean;
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

/** Body speed (wu/sec) below which a unit counts as "not moving". */
const STUCK_VEL_THRESHOLD = 5;

/** Consecutive stuck ticks before we force a replan. At a 30 Hz
 *  tick rate that's ~1 second — long enough to filter out brief
 *  collision rebounds, short enough that the user notices the
 *  recovery before they manually re-issue the order. */
const STUCK_TICK_THRESHOLD = 30;

/** Hard cap on replans per tick. Each replan is one bounded A*
 *  run plus path smoothing — typically well under 1 ms, but a
 *  cap keeps a chokepoint-pileup from spiking the tick budget. */
const MAX_REPLANS_PER_TICK = 5;

/** When a replan attempt fails (planner bailed, or eligibility
 *  check rejected the action type), set the unit's stuckTicks
 *  to this NEGATIVE cooldown value instead of leaving it at the
 *  threshold. The stuckTicks counter ticks UP each frame the
 *  unit's still wedged, so a value of −60 introduces a 60-tick
 *  (~2-second) gap before the unit is eligible for another
 *  replan attempt. Without this, a unit whose replans
 *  consistently bail (planner can't find a route) hammers the
 *  planner once every 30 ticks indefinitely — burning CPU on
 *  a problem that won't improve from one tick to the next. */
const REPLAN_FAILURE_COOLDOWN = -60;
const STUCK_REPLAN_BATCH_FLAG_SETTLING_CHECK = 1 << 0;

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private constructionSystem: ConstructionSystem;
  private damageSystem: DamageSystem;
  private deathExplosionPlanner: SimulationDeathExplosionPlanner;
  private deadEntityCleanup: SimulationDeadEntityCleanup;
  private arrivalController: SimulationArrivalController;
  private combatHaltController: SimulationCombatHaltController;
  private flyingLoiter: SimulationFlyingLoiterController;
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
  /** How many path replans we've spent this tick (capped at
   *  MAX_REPLANS_PER_TICK so a chokepoint pile-up can't burn the
   *  tick budget on planning). Reset at the top of `update()`. */
  private replansThisTick = 0;
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

  private _deadUnitIdsBuf: EntityId[] = [];
  private _deadBuildingIdsBuf: EntityId[] = [];
  private _movingUnitsBuf: Entity[] = [];
  private _stuckEntitiesBuf: Entity[] = [];
  private _stuckSlotsBuf = new Uint32Array(0);
  private _stuckTicksBuf = new Int32Array(0);
  private _stuckSettlingDxBuf = new Float64Array(0);
  private _stuckSettlingDyBuf = new Float64Array(0);
  private _stuckSettlingFlagsBuf = new Uint8Array(0);
  private _stuckOutTicksBuf = new Int32Array(0);
  private _stuckOutReplanBuf = new Uint8Array(0);

  // Reusable buffers for shared energy distribution (avoid per-tick allocations)
  private energyBuffers: EnergyBuffers = createEnergyBuffers();

  // Callback for when units die (to clean up physics bodies)
  // deathContexts contains info about the killing blow for directional explosions
  public onUnitDeath: ((deadUnitIds: EntityId[], deathContexts: Map<EntityId, DeathContext> | null) => void) | null = null;

  // Callback for when units are spawned (to create physics bodies)
  public onUnitSpawn: ((newUnits: Entity[]) => void) | null = null;

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
    this.arrivalController = new SimulationArrivalController(this.world, {
      advanceAction: (entity) => this.advanceAction(entity),
      advanceActivePathPoint: (entity) => this.advanceActivePathPoint(entity),
      queueFlyingLoiter: (entity) => this.flyingLoiter.queue(entity),
    });
    this.combatHaltController = new SimulationCombatHaltController(this.world);
    this.flyingLoiter = new SimulationFlyingLoiterController(this.world);
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

  getWindState(): WindState {
    return this.windState;
  }

  // Run one simulation step with the given timestep
  update(dtMs: number): void {
    if (this.gamePhase === 'init') this.gamePhase = transitionPhase('init', 'battle');

    // Replan budget resets each tick — see updateUnits / stuck detection.
    this.replansThisTick = 0;
    resourceMovementSystem.beginTick(this.world);

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
    for (const command of commands) {
      executeCommand(cmdCtx, command);
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

    // Resource converters: per-tick metal↔energy conversion governed by
    // world.converterTax. Runs after income so converters operate on
    // post-income stockpiles.
    economyManager.processConverters(this.world, dtMs);

    // Update each unit's smoothed surface normal BEFORE the systems
    // that read it (commanderAbilitiesSystem, turret kinematics inside
    // updateUnits / the targeting scheduler bridge). The EMA owns the
    // single canonical normal source so the renderer, sim turret
    // mounts, and locomotion can never read disagreeing per-unit normals.
    updateUnitGroundNormal(this.world, dtMs);

    // Distribute energy equally among all active consumers (factories, construction, commander)
    distributeEnergy(this.world, dtMs, this.energyBuffers);

    // Shared construction lifecycle for both building shells and
    // factory unit shells: HP growth, paid-full completion, building
    // completion effects, and dirty flags all flow through one pass.
    const constructionResult = updateConstructionLifecycle(this.world);
    this.advanceCompletedConstructionActions(constructionResult.completedBuildings);

    // AI auto-queues units at idle factories
    updateAiProduction(this.world, this.aiPlayerIds, this.aiAllowedUnitBlueprintIds);

    // Update factory production
    const productionResult = factoryProductionSystem.update(
      this.world, dtMs,
      this.constructionSystem.getGrid(),
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

    // Handle completed build/repair actions - advance commander action queues
    for (const completed of commanderResult.completedBuildings) {
      const commander = this.world.getEntity(completed.commanderId);
      if (commander) {
        this.advanceAction(commander);
      }
    }

    // Beam index is maintained incrementally:
    // - addBeam() called on beam creation in fireTurrets()
    // - removeBeam() called on beam expiry/orphan in updateProjectiles/checkProjectileCollisions

    // Clear force accumulator for this frame
    this.forceAccumulator.clear();

    // Update all units movement (calculates target velocities) and
    // refresh their spatial-grid cells in the same pass.
    this.updateUnits(dtMs / 1000);

    // Update non-unit spatial indices. Unit cells are refreshed inside
    // updateUnits() to avoid another full unit walk.
    this.updateSpatialGrid();

    // Update combat systems (targeting, firing, projectile collisions)
    this.updateCombat(dtMs);

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
      for (const building of this.world.getBuildings()) {
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

  // Update combat systems
  private updateCombat(dtMs: number): void {
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Simulation.updateCombat: sim-wasm is not initialized');
    }
    sim.deathExplosionPlannerReset();

    // AIM-08.2 — stamp the FF pool BEFORE the FSM so the shield
    // clearance kernels read the latest sphere list. The list is
    // produced by the previous tick's updateShieldState, so shield
    // sphere targeting has the same one-tick-stale envelope as
    // projectile collision.
    // One material, two shapes: a single pool holds both the sphere and the
    // flat-panel shield surfaces, both stamped here before the FSM/gate.
    stampShieldSurfacePool(this.world);
    // AIM-08.5 — rebuild targeting slabs before the FSM. The targeting
    // pass mutates the slab through Rust transition kernels and writes
    // those results back to JS turrets for the remaining consumers.
    stampCombatTargetingPool(this.world);
    // Update targeting and firing state. Cooldown timers now step inside
    // the scheduled Rust targeting batch and write back through the
    // transitional slab -> JS turret copy.
    const activeCombatUnits = updateTargetingAndFiringState(this.world, dtMs);

    // Update laser sounds based on targeting state (every frame)
    if (this.world.getBeamUnits().length > 0) {
      const laserSimEvents = updateLaserSounds(this.world);
      for (const event of laserSimEvents) {
        const onSimEvent = this.onSimEvent;
        if (onSimEvent !== null) onSimEvent(event);
        this.eventQueues.simEvents.push(event);
      }
    }

    // Update turret rotation (before firing, so weapons fire in turret direction)
    updateTurretRotation(this.world, dtMs, activeCombatUnits);

    // Update shield state before projectile emission. Aimed tube shields
    // are one turret with two emissions: the physical tube and the
    // sprayed payload both derive from the same engaged lock this tick.
    const shieldUnits = this.world.turretShieldSpheresEnabled
      ? this.world.getShieldUnits()
      : undefined;
    if (shieldUnits && shieldUnits.length > 0) {
      updateShieldState(this.world, dtMs);
    } else {
      resetShieldBuffers();
    }

    // Update shield sounds based on the just-written transition progress.
    if (shieldUnits && shieldUnits.length > 0) {
      const shieldSimEvents = updateShieldSounds(shieldUnits);
      for (const event of shieldSimEvents) {
        const onSimEvent = this.onSimEvent;
        if (onSimEvent !== null) onSimEvent(event);
        this.eventQueues.simEvents.push(event);
      }
    }

    // Fire weapons and create projectiles (with recoil force for projectiles)
    const fireResult = fireTurrets(this.world, dtMs, this.forceAccumulator, activeCombatUnits);
    for (const proj of fireResult.projectiles) {
      this.world.addEntity(proj);
      registerPackedProjectile(proj);
    }

    // Collect projectile spawn events
    for (const event of fireResult.spawnEvents) {
      this.eventQueues.projectileSpawns.push(event);
    }

    // Emit fire audio events
    for (const event of fireResult.events) {
      const onSimEvent = this.onSimEvent;
      if (onSimEvent !== null) onSimEvent(event);
      this.eventQueues.simEvents.push(event);
    }

    for (const unit of activeCombatUnits) {
      this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
    }

    // Update projectile positions and remove orphaned beams (from dead units)
    if (this.world.getProjectiles().length > 0) {
      const updateResult = updateProjectiles(this.world, dtMs, this.damageSystem);
      for (const id of updateResult.orphanedIds) {
        unregisterPackedProjectile(id);
        spatialGrid.removeProjectile(id);
        this.world.removeEntity(id);
      }
      for (const event of updateResult.despawnEvents) {
        unregisterPackedProjectile(event.id);
        spatialGrid.removeProjectile(event.id);
        this.eventQueues.projectileDespawns.push(event);
      }
      // Collect homing projectile velocity updates
      for (const event of safeVelocityUpdates(updateResult.velocityUpdates)) {
        this.eventQueues.projectileVelocityUpdates.set(event.id, event);
      }

      // Refresh projectile broadphase after integration. The frame-level
      // spatial update ran before combat, so projectile-vs-projectile
      // hitbox checks need the post-move positions here.
      spatialGrid.updateProjectiles(this.world.getTravelingProjectiles());

      // Projectile reflection queries use the same reflector slabs as
      // targeting, but need the post-rotation, post-shield-update
      // pose for this collision tick.
      stampShieldSurfacePool(this.world, { includeWhenSightDisabled: true });

      // Check projectile collisions and get dead units
      const collisionResult = checkProjectileCollisions(this.world, dtMs, this.damageSystem, this.forceAccumulator);

      // Add submunition / cluster projectiles spawned at explosion points,
      // and mirror their spawn events to the network queue so clients see
      // them the same way they see any freshly-fired round.
      for (const proj of collisionResult.newProjectiles) {
        this.world.addEntity(proj);
        registerPackedProjectile(proj);
      }
      for (const event of collisionResult.spawnEvents) {
        this.eventQueues.projectileSpawns.push(event);
      }

      // Collect projectile despawn events from collisions
      for (const event of collisionResult.despawnEvents) {
        unregisterPackedProjectile(event.id);
        spatialGrid.removeProjectile(event.id);
        this.eventQueues.projectileDespawns.push(event);
      }
      for (const event of safeVelocityUpdates(collisionResult.velocityUpdates)) {
        this.eventQueues.projectileVelocityUpdates.set(event.id, event);
      }

      this.deathExplosionPlanner.detonate(
        collisionResult.deadUnitIds,
        collisionResult.deadBuildingIds,
        collisionResult.deadTurretIds,
        collisionResult.events,
        collisionResult.deathContexts,
      );

      // Emit hit/death audio events
      for (const event of collisionResult.events) {
        const onSimEvent = this.onSimEvent;
        if (onSimEvent !== null) onSimEvent(event);
        this.eventQueues.simEvents.push(event);
      }

      // Remove dead entities from spatial grid and notify callbacks
      if (collisionResult.deadUnitIds.size > 0) {
        const buf = this._deadUnitIdsBuf;
        buf.length = 0;
        for (const id of collisionResult.deadUnitIds) {
          const entity = this.world.getEntity(id);
          if (entity) {
            // Emit laserStop for the dying entity's own beam weapons
            for (const evt of emitLaserStopsForEntity(entity)) {
              this.eventQueues.simEvents.push(evt);
            }
            // Emit laserStop for any beam weapons across the world targeting this entity
            for (const evt of emitLaserStopsForTarget(this.world, id)) {
              this.eventQueues.simEvents.push(evt);
            }
            // Emit shieldStop for the dying entity's shield weapons
            for (const evt of emitShieldStopsForEntity(entity)) {
              this.eventQueues.simEvents.push(evt);
            }
          }
          spatialGrid.removeUnit(id);
          buf.push(id);
        }
        const onUnitDeath = this.onUnitDeath;
        if (onUnitDeath !== null) onUnitDeath(buf, collisionResult.deathContexts);
      }

      if (collisionResult.deadBuildingIds.size > 0) {
        const buf = this._deadBuildingIdsBuf;
        buf.length = 0;
        for (const id of collisionResult.deadBuildingIds) {
          spatialGrid.removeBuilding(id);
          buf.push(id);
        }
        const onBuildingDeath = this.onBuildingDeath;
        if (onBuildingDeath !== null) onBuildingDeath(buf);
      }

    }

    // Safety cleanup - remove any dead entities that slipped through.
    // WorldState records ids whose HP changed, so this drains only
    // those candidates instead of walking every unit/building.
    this.deadEntityCleanup.run(this.onUnitDeath, this.onBuildingDeath);
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

    while (plan.index < plan.points.length - 1) {
      const point = plan.points[plan.index];
      const dx = point.x - entity.transform.x;
      const dy = point.y - entity.transform.y;
      if (magnitude(dx, dy) > ARRIVAL_RADIUS) break;
      plan.index++;
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

    for (const entity of this.world.getUnits()) {
      spatialGrid.updateUnit(entity);
      if (!entity.unit || !entity.body) continue;

      const { unit, transform } = entity;

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
        }
        continue;
      }

      // Default: no thrust (contact braking/drag will slow or hold the unit)
      unit.thrustDirX = 0;
      unit.thrustDirY = 0;
      setUnitMovementAcceleration(unit, 0, 0, 0);

      // Clear priority target — re-set below by attack / attack-ground actions.
      if (entity.combat) {
        entity.combat.priorityTargetId = null;
        entity.combat.priorityTargetPoint = null;
      }

      // Sweep targeted intents whose target disappeared or no longer
      // needs work. The action queue holds durable command waypoints;
      // transient pathfinding points live in unit.activePath and are
      // discarded automatically when the queue changes.
      if (this.sweepInvalidTargetActions(entity)) {
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      }

      // No actions - flying units keep circling their last destination.
      if (unit.actions.length === 0) {
        unit.activePath = null;
        unit.stuckTicks = 0;
        this.flyingLoiter.queue(entity);
        continue;
      }

      this.promoteReachableBuildAction(entity);

      // Get current action
      const currentAction = unit.actions[0];
      this.flyingLoiter.rememberTarget(unit, currentAction);

      if (currentAction.type === 'wait') {
        unit.activePath = null;
        unit.stuckTicks = 0;
        this.flyingLoiter.queue(entity);
        continue;
      }

      // For build/repair/reclaim actions, check if we're in range
      if (
        currentAction.type === 'build' ||
        currentAction.type === 'repair' ||
        currentAction.type === 'reclaim'
      ) {
        const targetId = currentAction.type === 'build'
          ? currentAction.buildingId
          : currentAction.targetId;
        const target = targetId !== undefined ? this.world.getEntity(targetId) : undefined;
        if (target && isBuildTargetInRange(entity, target)) {
          unit.stuckTicks = 0;
          continue;
        }

        const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
        const dx = movementTarget.x - transform.x;
        const dy = movementTarget.y - transform.y;
        const distance = magnitude(dx, dy);
        if (distance <= 1) {
          if (!movementTarget.isFinalActionPoint) this.advanceActivePathPoint(entity);
          unit.stuckTicks = 0;
          continue;
        }

        this.arrivalController.queueThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
        continue;
      }

      // Attack action: chase a specific enemy target
      // (dead-target attack actions are already swept from the queue above)
      if (currentAction.type === 'attack' && currentAction.targetId !== undefined) {
        const attackTarget = this.world.getEntity(currentAction.targetId)!;

        // Set priority target for turret system
        if (entity.combat) entity.combat.priorityTargetId = currentAction.targetId;

        // Stop if any turret is engaged.
        if (this.combatHaltController.shouldStopForEngagedCombat(entity)) {
          unit.stuckTicks = 0;
          continue;
        }

        // Move toward the pathfinder-approved approach point, not the
        // target's raw position. If the target moved and this approach
        // point no longer gets us into range, replan only after reaching
        // the approach point so we do not recreate an obstacle beeline.
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
          if ((unit.stuckTicks ?? 0) < 0) {
            unit.stuckTicks = (unit.stuckTicks ?? 0) + 1;
            continue;
          }
          const targetPoint = getEntityTargetPoint(attackTarget);
          if (!this.tryRefreshAttackApproach(entity, currentAction, targetPoint)) {
            unit.stuckTicks = REPLAN_FAILURE_COOLDOWN;
            continue;
          }
          unit.stuckTicks = 0;
        }
        continue;
      }

      if (currentAction.type === 'attackGround') {
        if (entity.combat) {
          const targetPoint = entity.combat.priorityTargetPoint ??
            (entity.combat.priorityTargetPoint = { x: 0, y: 0, z: 0 });
          targetPoint.x = currentAction.x;
          targetPoint.y = currentAction.y;
          targetPoint.z = currentAction.z ?? this.world.getGroundZ(currentAction.x, currentAction.y);
        }

        if (this.combatHaltController.shouldStopForEngagedCombat(entity)) {
          unit.stuckTicks = 0;
          continue;
        }

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
        continue;
      }

      if (currentAction.type === 'guard' && currentAction.targetId !== undefined) {
        const guardTarget = this.world.getEntity(currentAction.targetId);
        if (!entity.ownership || !isFriendlyGuardTarget(guardTarget, entity.ownership.playerId)) {
          this.advanceAction(entity);
          unit.stuckTicks = 0;
          continue;
        }

        if (this.combatHaltController.shouldStopForEngagedCombat(entity)) {
          unit.stuckTicks = 0;
          continue;
        }

        const targetPoint = getEntityTargetPoint(guardTarget);
        const targetDx = targetPoint.x - transform.x;
        const targetDy = targetPoint.y - transform.y;
        const targetDistance = magnitude(targetDx, targetDy);
        if (targetDistance <= getGuardFollowRadius(entity, guardTarget)) {
          unit.stuckTicks = 0;
          continue;
        }

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
        continue;
      }

      // Fight/patrol halt is per-mount: unit blueprints mark the exact
      // turret mount(s) that must be engaged before the unit stops and
      // brawls. If no mount is marked, the unit keeps moving while
      // weapons engage opportunistically.
      if (currentAction.type === 'fight' || currentAction.type === 'patrol') {
        if (this.combatHaltController.shouldStopForFightCombat(entity)) {
          unit.stuckTicks = 0;
          continue;
        }
      }

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
    this.evaluateStuckAndReplan(movingUnits);
  }

  private sweepInvalidTargetActions(entity: Entity): boolean {
    const unit = entity.unit;
    if (!unit) return false;

    let changed = false;
    const actions = unit.actions;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (!this.isTargetedActionInvalid(action)) continue;

      const targetId = getUnitActionTargetId(action);
      const removeStart = getActionIntentStart(actions, i);
      spliceUnitActions(unit, removeStart, i - removeStart + 1);
      const builder = entity.builder;
      if (targetId !== undefined && builder !== null && builder.currentBuildTarget === targetId) {
        builder.currentBuildTarget = NO_ENTITY_ID;
      }
      changed = true;
      i = removeStart - 1;
    }

    if (changed) {
      const patrolStartIndex = actions.findIndex((action) => action.type === 'patrol');
      unit.patrolStartIndex = patrolStartIndex >= 0 ? patrolStartIndex : null;
    }
    return changed;
  }

  private isTargetedActionInvalid(action: UnitAction): boolean {
    if (
      action.type !== 'attack' &&
      action.type !== 'build' &&
      action.type !== 'repair' &&
      action.type !== 'reclaim' &&
      action.type !== 'guard'
    ) {
      return false;
    }

    const targetId = getUnitActionTargetId(action);
    const target = targetId !== undefined ? this.world.getEntity(targetId) : undefined;
    if (!target) return true;

    if (action.type === 'attack') {
      return !this.isAliveAttackTarget(target);
    }

    if (action.type === 'build') {
      return !this.isIncompleteBuildableTarget(target);
    }

    if (action.type === 'guard') {
      return !this.isAliveAttackTarget(target);
    }

    if (action.type === 'reclaim') {
      return !isReclaimableTarget(target);
    }

    return !this.isIncompleteBuildableTarget(target) && !this.isDamagedRepairUnit(target);
  }

  private isAliveAttackTarget(target: Entity): boolean {
    return !!(
      (target.unit && target.unit.hp > 0) ||
      (target.building && target.building.hp > 0)
    );
  }

  private isIncompleteBuildableTarget(target: Entity): boolean {
    return !!(isBuildInProgress(target.buildable) &&
      ((target.building && target.building.hp > 0) ||
        (target.unit && target.unit.hp > 0)));
  }

  private isDamagedRepairUnit(target: Entity): boolean {
    return !!(target.unit && target.unit.hp > 0 && target.unit.hp < target.unit.maxHp);
  }

  private promoteReachableBuildAction(entity: Entity): void {
    const unit = entity.unit;
    if (!unit || !entity.builder || unit.actions.length === 0) return;

    const actions = unit.actions;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.type !== 'build' && action.type !== 'repair' && action.type !== 'reclaim') {
        if (!action.isPathExpansion) return;
        continue;
      }

      const targetId = action.type === 'build' ? action.buildingId : action.targetId;
      const target = targetId !== undefined ? this.world.getEntity(targetId) : undefined;
      if (!target || !isBuildTargetInRange(entity, target)) return;

      if (i > 0) {
        spliceUnitActions(unit, 0, i);
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      }
      return;
    }
  }

  private advanceCompletedConstructionActions(completedBuildings: readonly Entity[]): void {
    if (completedBuildings.length === 0) return;
    for (const completed of completedBuildings) {
      const completedId = completed.id;
      for (const entity of this.world.getBuilderUnits()) {
        const unit = entity.unit;
        if (!unit || unit.actions.length === 0) continue;
        const action = unit.actions[0];
        const targetId = action.type === 'build'
          ? action.buildingId
          : action.type === 'repair'
            ? action.targetId
            : undefined;
        if (targetId === completedId) {
          this.advanceAction(entity);
        }
      }
    }
  }

  private ensureStuckCapacity(required: number): void {
    if (this._stuckSlotsBuf.length >= required) return;
    const next = Math.max(required, this._stuckSlotsBuf.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this._stuckSlotsBuf);
    this._stuckSlotsBuf = slots;
    const ticks = new Int32Array(next);
    ticks.set(this._stuckTicksBuf);
    this._stuckTicksBuf = ticks;
    const settlingDx = new Float64Array(next);
    settlingDx.set(this._stuckSettlingDxBuf);
    this._stuckSettlingDxBuf = settlingDx;
    const settlingDy = new Float64Array(next);
    settlingDy.set(this._stuckSettlingDyBuf);
    this._stuckSettlingDyBuf = settlingDy;
    const settlingFlags = new Uint8Array(next);
    settlingFlags.set(this._stuckSettlingFlagsBuf);
    this._stuckSettlingFlagsBuf = settlingFlags;
    this._stuckOutTicksBuf = new Int32Array(next);
    this._stuckOutReplanBuf = new Uint8Array(next);
  }

  /** Per-tick stuck check. For each unit that wanted to move this
   *  tick but is barely moving, increment its stuck counter; once
   *  past the threshold and within the per-tick replan budget, run
   *  a fresh A* from the unit's current position to the active
   *  waypoint without rewriting the authored action queue. */
  private evaluateStuckAndReplan(movingUnits: readonly Entity[]): void {
    const maxRows = movingUnits.length;
    if (maxRows === 0) return;

    this.ensureStuckCapacity(maxRows);
    let count = 0;
    for (let i = 0; i < maxRows; i++) {
      const entity = movingUnits[i];
      if (!entity.unit || !entity.body) continue;
      const unit = entity.unit;
      const action = unit.actions[0];
      let settlingDx = 0;
      let settlingDy = 0;
      let settlingFlags = 0;
      if (
        action !== undefined &&
        action.type !== 'patrol' &&
        (action.type === 'move' || action.type === 'fight')
      ) {
        settlingDx = action.x - entity.transform.x;
        settlingDy = action.y - entity.transform.y;
        settlingFlags = STUCK_REPLAN_BATCH_FLAG_SETTLING_CHECK;
      }

      this._stuckEntitiesBuf[count] = entity;
      this._stuckSlotsBuf[count] = entity.body.physicsBody.slot;
      this._stuckTicksBuf[count] = unit.stuckTicks ?? 0;
      this._stuckSettlingDxBuf[count] = settlingDx;
      this._stuckSettlingDyBuf[count] = settlingDy;
      this._stuckSettlingFlagsBuf[count] = settlingFlags;
      count++;
    }
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Simulation.evaluateStuckAndReplan: sim-wasm is not initialized');
    }
    sim.stuckReplanStepBatch(
      this._stuckSlotsBuf.subarray(0, count),
      this._stuckTicksBuf.subarray(0, count),
      this._stuckSettlingDxBuf.subarray(0, count),
      this._stuckSettlingDyBuf.subarray(0, count),
      this._stuckSettlingFlagsBuf.subarray(0, count),
      this._stuckOutTicksBuf.subarray(0, count),
      this._stuckOutReplanBuf.subarray(0, count),
      STUCK_VEL_THRESHOLD,
      STUCK_TICK_THRESHOLD,
      ARRIVAL_RADIUS,
    );

    for (let i = 0; i < count; i++) {
      const entity = this._stuckEntitiesBuf[i];
      const unit = entity.unit;
      if (!unit) {
        this._stuckEntitiesBuf[i] = undefined as unknown as Entity;
        continue;
      }

      unit.stuckTicks = this._stuckOutTicksBuf[i];
      if (this._stuckOutReplanBuf[i] === 0) {
        this._stuckEntitiesBuf[i] = undefined as unknown as Entity;
        continue;
      }
      if (this.replansThisTick >= MAX_REPLANS_PER_TICK) {
        this._stuckEntitiesBuf[i] = undefined as unknown as Entity;
        continue;
      }
      if (this.tryReplan(entity)) {
        unit.stuckTicks = 0;
        this.replansThisTick++;
      } else {
        // Replan didn't improve the unit's active path — most often the
        // planner bailed (target unreachable from current position
        // under the JP-expansion budget) or the action type isn't
        // replan-eligible (patrol / build / repair). Either way,
        // hammering the planner again next tick won't help. Set
        // stuckTicks to a negative cooldown so the unit waits a
        // few seconds before its next eligibility window. The
        // active path stays untouched (tryReplan didn't replace it)
        // so the unit keeps trying its existing route.
        unit.stuckTicks = REPLAN_FAILURE_COOLDOWN;
      }
      this._stuckEntitiesBuf[i] = undefined as unknown as Entity;
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
      action.type !== 'attack' &&
      action.type !== 'attackGround' &&
      action.type !== 'guard'
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
    const nextAction: UnitAction = {
      ...currentAction,
      x: targetPoint.x,
      y: targetPoint.y,
      z: targetPoint.z,
    };

    if (this.sameAttackApproach(currentAction, nextAction)) {
      return false;
    }

    this.updateCurrentActionApproach(entity, currentAction, targetPoint);
    return true;
  }

  private sameAttackApproach(a: UnitAction, b: UnitAction): boolean {
    return (
      a.type === b.type &&
      a.targetId === b.targetId &&
      Math.abs(a.x - b.x) < 1 &&
      Math.abs(a.y - b.y) < 1 &&
      Math.abs((a.z ?? 0) - (b.z ?? 0)) < 1
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
    const nextAction: UnitAction = {
      ...currentAction,
      x: targetPoint.x,
      y: targetPoint.y,
      z: targetPoint.z,
    };

    if (this.sameAttackApproach(currentAction, nextAction)) {
      return false;
    }

    this.updateCurrentActionApproach(entity, currentAction, targetPoint);
    return true;
  }

  private pathTerrainFilterForUnit(entity: Entity): PathTerrainFilter | null {
    return entity.unit === null
      ? null
      : pathTerrainFilterForLocomotion(entity.unit.locomotion);
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
    }

    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
  }

  // Reset all session state (call between game sessions to free stale references)
  resetSessionState(): void {
    this.forceAccumulator.reset();
    this.eventQueues.reset();
    this._deadUnitIdsBuf.length = 0;
    this._deadBuildingIdsBuf.length = 0;
    this.deadEntityCleanup.reset();
    this.arrivalController.reset();
    this.flyingLoiter.reset();
    this._stuckEntitiesBuf.length = 0;
    this.combatHaltController.reset();
    this.world.clearPendingDeathCheckIds();
    resetEnergyBuffers(this.energyBuffers);
    resetShieldBuffers();
    resetLaserSoundState();
    resetShieldSoundState();
    this.spatialGridBuildingVersion = -1;
  }
}
