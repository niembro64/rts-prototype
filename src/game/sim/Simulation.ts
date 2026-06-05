import { WorldState } from './WorldState';
import { CommandQueue } from './commands';
import type { Entity, EntityId, PlayerId, Unit, UnitAction, UnitPathPoint } from './types';
import { NO_ENTITY_ID } from './types';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import {
  applyKnockbackForces,
  buildUnitDeathEvent,
  buildBuildingDeathEvent,
  collectKillsAndDeathContexts,
} from './combat/damageHelpers';
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
import { DamageSystem, type AreaDamageSource } from './damage';
import { economyManager } from './economy';
import { ConstructionSystem } from './construction';
import { factoryProductionSystem } from './factoryProduction';
import { updateConstructionLifecycle } from './constructionLifecycle';
import {
  isBuildBlockingActivation,
  isBuildInProgress,
  isConstructionBodyMaterialized,
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
import { UNIT_MASS_MULTIPLIER } from '../../config';
import type { GamePhase } from '@/types/network';
import { updateAiProduction } from './aiProduction';
import {
  expandPathPoints,
  pathTerrainFilterForLocomotion,
  type PathTerrainFilter,
} from './Pathfinder';
import { getTerrainVersion } from './Terrain';
import {
  getBuildingBlueprint,
  getUnitBlueprint,
} from './blueprints';
import { updateBuildingActiveStates } from './buildingActiveState';
import { getEntityTargetPoint } from './buildingAnchors';
import { getGuardFollowRadius, isFriendlyGuardTarget } from './guard';
import { WindPowerTracker, sampleWindState, sampleWindStateInto, type WindState } from './wind';
import { isBuildTargetInRange } from './builderRange';
import { isReclaimableTarget } from './reclaim';
import { setUnitMovementAcceleration } from './unitMovementAcceleration';
import { getActionIntentStart, getUnitActionTargetId } from './unitActionIntents';
import {
  CT_COMBAT_HALT_MODE_ANY_ENGAGED,
  CT_COMBAT_HALT_MODE_FIGHT_REQUIRED,
  getSimWasm,
  type SimWasm,
} from '../sim-wasm/init';
import {
  rotateFirstUnitActionToEnd,
  refreshUnitActionHash,
  shiftUnitAction,
  spliceUnitActions,
} from './unitActions';
import {
  LOCOMOTION_FORCE_SCALE,
} from './locomotion';

// Shared empty array constant (avoids per-call allocation for empty returns)
const EMPTY_VEL_UPDATES: ProjectileVelocityUpdateEvent[] = [];
const EMPTY_DEATH_EXPLOSION_EXCLUDES = new Set<EntityId>();
type DeathExplosionBlast = {
  radius: number;
  force: number;
  damage: number;
  sourceKey: string;
  sourceType: 'turret' | 'unit' | 'building' | 'system';
  sourceEntityId: EntityId;
  center: { x: number; y: number; z: number };
};
type ActiveMovementTarget = UnitPathPoint & {
  isFinalActionPoint: boolean;
};

function safeVelocityUpdates(value: unknown): ProjectileVelocityUpdateEvent[] {
  return Array.isArray(value) ? value as ProjectileVelocityUpdateEvent[] : EMPTY_VEL_UPDATES;
}

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

const ARRIVAL_RADIUS = 50;
const ARRIVAL_FINAL_RADIUS = 15;
const ARRIVAL_FINAL_STOP_SPEED = 100;
const ARRIVAL_CONTROL_RADIUS = 20;
const ARRIVAL_RESPONSE_TIME_SEC = 0.22;
const ARRIVAL_MIN_ACCEL = 0.001;
const ARRIVAL_BATCH_FLAG_LAST_ACTION = 1 << 1;
const ARRIVAL_COMPLETION_BATCH_FLAG_FLYING = 1 << 2;
const FLYING_LOITER_INVALID_BODY_SLOT = 0xffffffff;
const FLYING_LOITER_RADIUS_MULT = 8;
const FLYING_LOITER_MIN_RADIUS = 80;
const FLYING_LOITER_RADIAL_GAIN = 0.65;
const DEATH_EXPLOSION_WORK_KIND_UNIT = 1;
const DEATH_EXPLOSION_WORK_KIND_BUILDING = 2;
const DEATH_CLEANUP_KIND_UNIT = 1;
const DEATH_CLEANUP_KIND_BUILDING = 2;

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private constructionSystem: ConstructionSystem;
  private damageSystem: DamageSystem;
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

  // Pending audio events for network broadcast (double-buffered to avoid per-snapshot allocation)
  private _audioA: SimEvent[] = [];
  private _audioB: SimEvent[] = [];
  private pendingSimEvents: SimEvent[] = this._audioA;

  // Pending projectile spawn/despawn/velocity-update events (double-buffered)
  private _spawnsA: ProjectileSpawnEvent[] = [];
  private _spawnsB: ProjectileSpawnEvent[] = [];
  private pendingProjectileSpawns: ProjectileSpawnEvent[] = this._spawnsA;

  private _despawnsA: ProjectileDespawnEvent[] = [];
  private _despawnsB: ProjectileDespawnEvent[] = [];
  private pendingProjectileDespawns: ProjectileDespawnEvent[] = this._despawnsA;

  private pendingProjectileVelocityUpdates = new Map<number, ProjectileVelocityUpdateEvent>();
  private _velUpdateBufA: ProjectileVelocityUpdateEvent[] = [];
  private _velUpdateBufB: ProjectileVelocityUpdateEvent[] = [];
  private _velUpdateToggle = false;

  // Reusable buffers for cleanupDeadEntities (avoid per-tick allocations)
  private _deadUnitIdsBuf: EntityId[] = [];
  private _deadBuildingIdsBuf: EntityId[] = [];
  private _deathCheckIdsBuf: EntityId[] = [];
  private _movingUnitsBuf: Entity[] = [];
  private _arrivalEntitiesBuf: Entity[] = [];
  private _deathExplosionUnitIdsBuf = new Int32Array(0);
  private _deathExplosionBuildingIdsBuf = new Int32Array(0);
  private _deathExplosionWorkEntityIdBuf = new Int32Array(1);
  private _deathExplosionWorkKindBuf = new Uint8Array(1);
  private _deathExplosionBlastScratch: DeathExplosionBlast = {
    radius: 0,
    force: 0,
    damage: 0,
    sourceKey: '',
    sourceType: 'system',
    sourceEntityId: NO_ENTITY_ID,
    center: { x: 0, y: 0, z: 0 },
  };
  private _deathExplosionAreaDamageScratch: AreaDamageSource = {
    type: 'area',
    sourceEntityId: NO_ENTITY_ID,
    // Death blasts are neutral for broadphase filtering: they hit
    // friend and foe. Kill credit still resolves through sourceEntityId.
    ownerId: 0,
    damage: 0,
    excludeEntities: EMPTY_DEATH_EXPLOSION_EXCLUDES,
    center: this._deathExplosionBlastScratch.center,
    radius: 0,
    knockbackForce: 0,
  };
  private _cleanupDeadUnitIdSet = new Set<EntityId>();
  private _cleanupDeadBuildingIdSet = new Set<EntityId>();
  private _cleanupDeadTurretIdSet = new Set<EntityId>();
  private _cleanupSyntheticDeathEventIds = new Set<EntityId>();
  private _cleanupDeathContexts = new Map<EntityId, DeathContext>();
  private _cleanupDeathEnabledBuf = new Uint8Array(0);
  private _cleanupDeathEntityIdBuf = new Int32Array(0);
  private _cleanupDeathKindBuf = new Uint8Array(0);
  private _cleanupDeathHpBuf = new Float64Array(0);
  private _cleanupDeathUnitMaterializedBuf = new Uint8Array(0);
  private _cleanupDeathDiffEntityIdsBuf = new Int32Array(0);
  private _cleanupDeathDiffKindBuf = new Uint8Array(0);
  private _cleanupDeathDiffCountBuf = new Uint32Array(1);
  private _arrivalSlotsBuf = new Uint32Array(0);
  private _arrivalDxBuf = new Float64Array(0);
  private _arrivalDyBuf = new Float64Array(0);
  private _arrivalDistanceBuf = new Float64Array(0);
  private _arrivalRadiusPushBuf = new Float64Array(0);
  private _arrivalDriveForceBuf = new Float64Array(0);
  private _arrivalTractionBuf = new Float64Array(0);
  private _arrivalMassBuf = new Float64Array(0);
  private _arrivalFlagsBuf = new Uint8Array(0);
  private _arrivalOutXBuf = new Float64Array(0);
  private _arrivalOutYBuf = new Float64Array(0);
  private _arrivalActiveBuf = new Uint8Array(0);
  private _arrivalCount = 0;
  private _arrivalCompletionEntitiesBuf: Entity[] = [];
  private _arrivalCompletionActionsBuf: UnitAction[] = [];
  private _arrivalCompletionSlotsBuf = new Uint32Array(0);
  private _arrivalCompletionDxBuf = new Float64Array(0);
  private _arrivalCompletionDyBuf = new Float64Array(0);
  private _arrivalCompletionFallbackVxBuf = new Float64Array(0);
  private _arrivalCompletionFallbackVyBuf = new Float64Array(0);
  private _arrivalCompletionFlagsBuf = new Uint8Array(0);
  private _arrivalCompletionFinalPointBuf = new Uint8Array(0);
  private _arrivalCompletionDistanceBuf = new Float64Array(0);
  private _arrivalCompletionArrivedBuf = new Uint8Array(0);
  private _arrivalCompletionCount = 0;
  private _loiterEntitiesBuf: Entity[] = [];
  private _loiterSlotsBuf = new Uint32Array(0);
  private _loiterDxBuf = new Float64Array(0);
  private _loiterDyBuf = new Float64Array(0);
  private _loiterDistanceBuf = new Float64Array(0);
  private _loiterRotationBuf = new Float64Array(0);
  private _loiterRadiusBuf = new Float64Array(0);
  private _loiterTurnSignBuf = new Float64Array(0);
  private _loiterFallbackVxBuf = new Float64Array(0);
  private _loiterFallbackVyBuf = new Float64Array(0);
  private _loiterOutXBuf = new Float64Array(0);
  private _loiterOutYBuf = new Float64Array(0);
  private _loiterOutTurnSignBuf = new Float64Array(0);
  private _loiterActiveBuf = new Uint8Array(0);
  private _loiterCount = 0;
  private _stuckEntitiesBuf: Entity[] = [];
  private _stuckSlotsBuf = new Uint32Array(0);
  private _stuckTicksBuf = new Int32Array(0);
  private _stuckSettlingDxBuf = new Float64Array(0);
  private _stuckSettlingDyBuf = new Float64Array(0);
  private _stuckSettlingFlagsBuf = new Uint8Array(0);
  private _stuckOutTicksBuf = new Int32Array(0);
  private _stuckOutReplanBuf = new Uint8Array(0);
  private _combatHaltTouchedSlotsBuf: number[] = [];
  private _combatHaltSlotsBuf = new Uint32Array(0);
  private _combatHaltModesBuf = new Uint8Array(0);
  private _combatHaltPriorityPointBuf = new Uint8Array(0);
  private _combatHaltOutBuf = new Uint8Array(0);
  private _combatHaltModeBySlot = new Uint8Array(0);
  private _combatHaltPriorityPointBySlot = new Uint8Array(0);
  private _combatHaltStopBySlot = new Uint8Array(0);

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
    const events = this.pendingSimEvents;
    this.pendingSimEvents = (events === this._audioA) ? this._audioB : this._audioA;
    this.pendingSimEvents.length = 0;
    return events;
  }

  // Get and clear pending projectile spawn events (double-buffer swap)
  getAndClearProjectileSpawns(): ProjectileSpawnEvent[] {
    const events = this.pendingProjectileSpawns;
    this.pendingProjectileSpawns = (events === this._spawnsA) ? this._spawnsB : this._spawnsA;
    this.pendingProjectileSpawns.length = 0;
    return events;
  }

  // Get and clear pending projectile despawn events (double-buffer swap)
  getAndClearProjectileDespawns(): ProjectileDespawnEvent[] {
    const events = this.pendingProjectileDespawns;
    this.pendingProjectileDespawns = (events === this._despawnsA) ? this._despawnsB : this._despawnsA;
    this.pendingProjectileDespawns.length = 0;
    return events;
  }

  // Get and clear pending projectile velocity update events (double-buffered)
  getAndClearProjectileVelocityUpdates(): ProjectileVelocityUpdateEvent[] {
    const map = this.pendingProjectileVelocityUpdates;
    if (map.size === 0) return EMPTY_VEL_UPDATES;
    const buf = this._velUpdateToggle ? this._velUpdateBufB : this._velUpdateBufA;
    this._velUpdateToggle = !this._velUpdateToggle;
    buf.length = 0;
    for (const v of map.values()) buf.push(v);
    map.clear();
    return buf;
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
      pendingProjectileSpawns: this.pendingProjectileSpawns,
      pendingSimEvents: this.pendingSimEvents,
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
    if (this.playerIds.length < 2) return;

    // Count alive commanders without allocating a filtered array
    let aliveCount = 0;
    let lastAliveId = 0;
    for (let i = 0; i < this.playerIds.length; i++) {
      if (this.world.isCommanderAlive(this.playerIds[i])) {
        aliveCount++;
        lastAliveId = this.playerIds[i];
      }
    }

    // If only one player remains, they win
    if (aliveCount === 1) {
      this.gameOverWinnerId = lastAliveId;
      this.gamePhase = transitionPhase(this.gamePhase, 'gameOver');
      const onGameOver = this.onGameOver;
      if (onGameOver !== null) onGameOver(this.gameOverWinnerId);
    }
    // If no players remain (somehow), no winner
    else if (aliveCount === 0 && this.playerIds.length > 0) {
      // Draw or error state - just pick first player
      this.gameOverWinnerId = this.playerIds[0];
      this.gamePhase = transitionPhase(this.gamePhase, 'gameOver');
      const onGameOver = this.onGameOver;
      if (onGameOver !== null) onGameOver(this.gameOverWinnerId);
    }
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
        this.pendingSimEvents.push(event);
      }
    }

    // Update shield sounds based on transition progress (every frame)
    const shieldUnits = this.world.turretShieldSpheresEnabled
      ? this.world.getShieldUnits()
      : undefined;
    if (shieldUnits && shieldUnits.length > 0) {
      const shieldSimEvents = updateShieldSounds(shieldUnits);
      for (const event of shieldSimEvents) {
        const onSimEvent = this.onSimEvent;
        if (onSimEvent !== null) onSimEvent(event);
        this.pendingSimEvents.push(event);
      }
    }

    // Update turret rotation (before firing, so weapons fire in turret direction)
    updateTurretRotation(this.world, dtMs, activeCombatUnits);

    // Fire weapons and create projectiles (with recoil force for projectiles)
    const fireResult = fireTurrets(this.world, dtMs, this.forceAccumulator, activeCombatUnits);
    for (const proj of fireResult.projectiles) {
      this.world.addEntity(proj);
      registerPackedProjectile(proj);
    }

    // Collect projectile spawn events
    for (const event of fireResult.spawnEvents) {
      this.pendingProjectileSpawns.push(event);
    }

    // Emit fire audio events
    for (const event of fireResult.events) {
      const onSimEvent = this.onSimEvent;
      if (onSimEvent !== null) onSimEvent(event);
      this.pendingSimEvents.push(event);
    }

    // Update shield state (range transitions)
    if (shieldUnits && shieldUnits.length > 0) {
      updateShieldState(this.world, dtMs);
    } else {
      resetShieldBuffers();
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
        this.pendingProjectileDespawns.push(event);
      }
      // Collect homing projectile velocity updates
      for (const event of safeVelocityUpdates(updateResult.velocityUpdates)) {
        this.pendingProjectileVelocityUpdates.set(event.id, event);
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
        this.pendingProjectileSpawns.push(event);
      }

      // Collect projectile despawn events from collisions
      for (const event of collisionResult.despawnEvents) {
        unregisterPackedProjectile(event.id);
        spatialGrid.removeProjectile(event.id);
        this.pendingProjectileDespawns.push(event);
      }
      for (const event of safeVelocityUpdates(collisionResult.velocityUpdates)) {
        this.pendingProjectileVelocityUpdates.set(event.id, event);
      }

      this.detonateEntityDeathExplosions(
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
        this.pendingSimEvents.push(event);
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
              this.pendingSimEvents.push(evt);
            }
            // Emit laserStop for any beam weapons across the world targeting this entity
            for (const evt of emitLaserStopsForTarget(this.world, id)) {
              this.pendingSimEvents.push(evt);
            }
            // Emit shieldStop for the dying entity's shield weapons
            for (const evt of emitShieldStopsForEntity(entity)) {
              this.pendingSimEvents.push(evt);
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
    this.cleanupDeadEntities();
  }

  // Cleanup pass - removes any entities with HP <= 0 that weren't caught by normal death handling
  // This is a safety net to ensure dead entities don't persist in the world
  private cleanupDeadEntities(): void {
    const deathCheckIds = this._deathCheckIdsBuf;
    const deadUnitIds = this._deadUnitIdsBuf;
    const deadBuildingIds = this._deadBuildingIdsBuf;
    deadUnitIds.length = 0;
    deadBuildingIds.length = 0;
    this.world.drainPendingDeathCheckIds(deathCheckIds);
    if (deathCheckIds.length === 0) return;

    const count = deathCheckIds.length;
    this.ensureDeathCleanupCapacity(count);
    const enabled = this._cleanupDeathEnabledBuf;
    const entityIds = this._cleanupDeathEntityIdBuf;
    const kind = this._cleanupDeathKindBuf;
    const hp = this._cleanupDeathHpBuf;
    const unitMaterialized = this._cleanupDeathUnitMaterializedBuf;
    const diffEntityIds = this._cleanupDeathDiffEntityIdsBuf;
    const diffKind = this._cleanupDeathDiffKindBuf;
    const diffCount = this._cleanupDeathDiffCountBuf;
    enabled.fill(0, 0, count);
    kind.fill(0, 0, count);
    unitMaterialized.fill(0, 0, count);
    diffCount[0] = 0;

    // Pack only entities whose HP changed since the last drain. Rust owns
    // the unit/building dead-alive classification and compact removal diff
    // generation; TypeScript keeps JS graph lookup and removal side effects
    // until the ECS migration.
    let expectedCleanupRows = 0;
    for (let i = 0; i < count; i++) {
      const entityId = deathCheckIds[i];
      entityIds[i] = entityId;
      const entity = this.world.getEntity(entityId);
      hp[i] = 0;
      if (!entity) continue;
      if (entity.unit !== null) {
        enabled[i] = 1;
        kind[i] = DEATH_CLEANUP_KIND_UNIT;
        hp[i] = entity.unit.hp;
        unitMaterialized[i] = isConstructionBodyMaterialized(entity) ? 1 : 0;
        expectedCleanupRows++;
      } else if (entity.building !== null) {
        enabled[i] = 1;
        kind[i] = DEATH_CLEANUP_KIND_BUILDING;
        hp[i] = entity.building.hp;
        expectedCleanupRows++;
      }
    }

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Simulation.cleanupDeadEntities: sim-wasm is not initialized');
    }
    const processed = sim.deathCleanupDiffBatch(
      count,
      enabled.subarray(0, count),
      entityIds.subarray(0, count),
      kind.subarray(0, count),
      hp.subarray(0, count),
      unitMaterialized.subarray(0, count),
      diffEntityIds.subarray(0, count),
      diffKind.subarray(0, count),
      diffCount,
    );
    if (processed !== expectedCleanupRows) {
      throw new Error(`Simulation.cleanupDeadEntities: death cleanup batch failed: ${processed}/${expectedCleanupRows}`);
    }

    const deadDiffCount = diffCount[0];
    if (deadDiffCount > count) {
      throw new Error(`Simulation.cleanupDeadEntities: invalid death cleanup diff count: ${deadDiffCount}/${count}`);
    }
    for (let i = 0; i < deadDiffCount; i++) {
      const entityId = diffEntityIds[i];
      if (diffKind[i] === DEATH_CLEANUP_KIND_UNIT) {
        deadUnitIds.push(entityId);
      } else if (diffKind[i] === DEATH_CLEANUP_KIND_BUILDING) {
        deadBuildingIds.push(entityId);
      }
    }
    deathCheckIds.length = 0;

    if (deadUnitIds.length > 0 || deadBuildingIds.length > 0) {
      const deadUnitSet = this._cleanupDeadUnitIdSet;
      const deadBuildingSet = this._cleanupDeadBuildingIdSet;
      const deadTurretSet = this._cleanupDeadTurretIdSet;
      const syntheticDeathEventIds = this._cleanupSyntheticDeathEventIds;
      const deathContexts = this._cleanupDeathContexts;
      deadUnitSet.clear();
      deadBuildingSet.clear();
      deadTurretSet.clear();
      syntheticDeathEventIds.clear();
      deathContexts.clear();
      for (const id of deadUnitIds) {
        deadUnitSet.add(id);
        syntheticDeathEventIds.add(id);
      }
      for (const id of deadBuildingIds) {
        deadBuildingSet.add(id);
        syntheticDeathEventIds.add(id);
      }
      this.detonateEntityDeathExplosions(
        deadUnitSet,
        deadBuildingSet,
        deadTurretSet,
        this.pendingSimEvents,
        deathContexts,
      );
      deadUnitIds.length = 0;
      deadBuildingIds.length = 0;
      for (const id of deadUnitSet) deadUnitIds.push(id);
      for (const id of deadBuildingSet) deadBuildingIds.push(id);
    }

    // Remove dead entities from spatial grid, notify callbacks, and remove from world
    if (deadUnitIds.length > 0) {
      for (const id of deadUnitIds) {
        const entity = this.world.getEntity(id);
        if (entity) {
          // Emit laserStop for the dying entity's own beam weapons
          for (const evt of emitLaserStopsForEntity(entity)) {
            this.pendingSimEvents.push(evt);
          }
          // Emit laserStop for any beam weapons across the world targeting this entity
          for (const evt of emitLaserStopsForTarget(this.world, id)) {
            this.pendingSimEvents.push(evt);
          }
          // Emit shieldStop for the dying entity's shield weapons
          for (const evt of emitShieldStopsForEntity(entity)) {
            this.pendingSimEvents.push(evt);
          }
          // Synthesize a death SimEvent so the renderer still fires a
          // material explosion for units killed outside the normal
          // damage-pass path (e.g. bleed-out, anything
          // that sets hp<=0 without going through collectKills*).
          // Without this, the unit just vanishes silently.
          if (this._cleanupSyntheticDeathEventIds.has(id)) {
            this.emitSyntheticDeathEvent(entity);
          }
        }
        spatialGrid.removeUnit(id);
      }
      const onUnitDeath = this.onUnitDeath;
      if (onUnitDeath !== null) onUnitDeath(deadUnitIds, null);
      for (const id of deadUnitIds) {
        this.world.removeEntity(id);
      }
    }

    if (deadBuildingIds.length > 0) {
      for (const id of deadBuildingIds) {
        const building = this.world.getEntity(id);
        if (building && this._cleanupSyntheticDeathEventIds.has(id)) {
          this.emitSyntheticDeathEvent(building);
        }
        spatialGrid.removeBuilding(id);
      }
      const onBuildingDeath = this.onBuildingDeath;
      if (onBuildingDeath !== null) onBuildingDeath(deadBuildingIds);
      for (const id of deadBuildingIds) {
        this.world.removeEntity(id);
      }
    }
  }

  private ensureDeathCleanupCapacity(required: number): void {
    if (required <= this._cleanupDeathEnabledBuf.length) return;
    let next = Math.max(16, this._cleanupDeathEnabledBuf.length);
    while (next < required) next *= 2;
    this._cleanupDeathEnabledBuf = new Uint8Array(next);
    this._cleanupDeathEntityIdBuf = new Int32Array(next);
    this._cleanupDeathKindBuf = new Uint8Array(next);
    this._cleanupDeathHpBuf = new Float64Array(next);
    this._cleanupDeathUnitMaterializedBuf = new Uint8Array(next);
    this._cleanupDeathDiffEntityIdsBuf = new Int32Array(next);
    this._cleanupDeathDiffKindBuf = new Uint8Array(next);
  }

  // Build a death SimEvent for entities dying outside the normal
  // collision-handler path (anything that mutates hp
  // directly). Delegates to the shared buildUnitDeathEvent /
  // buildBuildingDeathEvent so the shape can't drift from the damage-
  // path kills. There is no turret to credit here, so provenance lives
  // in sourceType/sourceKey and turretBlueprintId remains a weapon/audio key.
  private emitSyntheticDeathEvent(entity: Entity): void {
    if (entity.unit) {
      this.pendingSimEvents.push(
        buildUnitDeathEvent(entity, entity.id, entity.unit.unitBlueprintId ?? '', undefined, 'unit'),
      );
    } else if (entity.building) {
      this.pendingSimEvents.push(
        buildBuildingDeathEvent(entity, entity.id, entity.buildingBlueprintId ?? '', 'building'),
      );
    }
  }

  private ensureDeathExplosionPlannerIdCapacity(unitCount: number, buildingCount: number): void {
    if (unitCount > this._deathExplosionUnitIdsBuf.length) {
      let next = Math.max(16, this._deathExplosionUnitIdsBuf.length);
      while (next < unitCount) next *= 2;
      this._deathExplosionUnitIdsBuf = new Int32Array(next);
    }
    if (buildingCount > this._deathExplosionBuildingIdsBuf.length) {
      let next = Math.max(16, this._deathExplosionBuildingIdsBuf.length);
      while (next < buildingCount) next *= 2;
      this._deathExplosionBuildingIdsBuf = new Int32Array(next);
    }
  }

  private packDeathExplosionIds(
    ids: Set<EntityId>,
    out: Int32Array,
  ): number {
    let count = 0;
    for (const id of ids) {
      out[count++] = id;
    }
    return count;
  }

  private seedDeathExplosionPlanner(
    sim: SimWasm,
    deadUnitIds: Set<EntityId>,
    deadBuildingIds: Set<EntityId>,
  ): void {
    this.ensureDeathExplosionPlannerIdCapacity(deadUnitIds.size, deadBuildingIds.size);
    const unitCount = this.packDeathExplosionIds(deadUnitIds, this._deathExplosionUnitIdsBuf);
    const buildingCount = this.packDeathExplosionIds(deadBuildingIds, this._deathExplosionBuildingIdsBuf);
    sim.deathExplosionPlannerSeed(
      this._deathExplosionUnitIdsBuf.subarray(0, unitCount),
      this._deathExplosionBuildingIdsBuf.subarray(0, buildingCount),
    );
  }

  private appendDeathExplosionPlannerKills(
    sim: SimWasm,
    killedUnitIds: Set<EntityId>,
    killedBuildingIds: Set<EntityId>,
  ): void {
    this.ensureDeathExplosionPlannerIdCapacity(killedUnitIds.size, killedBuildingIds.size);
    const unitCount = this.packDeathExplosionIds(killedUnitIds, this._deathExplosionUnitIdsBuf);
    const buildingCount = this.packDeathExplosionIds(killedBuildingIds, this._deathExplosionBuildingIdsBuf);
    sim.deathExplosionPlannerAppendKills(
      this._deathExplosionUnitIdsBuf.subarray(0, unitCount),
      this._deathExplosionBuildingIdsBuf.subarray(0, buildingCount),
    );
  }

  private detonateEntityDeathExplosions(
    deadUnitIds: Set<EntityId>,
    deadBuildingIds: Set<EntityId>,
    deadTurretIds: Set<EntityId>,
    audioEvents: SimEvent[],
    deathContexts: Map<EntityId, DeathContext>,
  ): void {
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Simulation.detonateEntityDeathExplosions: sim-wasm is not initialized');
    }

    this.seedDeathExplosionPlanner(sim, deadUnitIds, deadBuildingIds);

    for (;;) {
      const next = sim.deathExplosionPlannerNext(
        this._deathExplosionWorkEntityIdBuf,
        this._deathExplosionWorkKindBuf,
      );
      if (next === 0) break;
      if (next !== 1) {
        throw new Error(`Simulation.detonateEntityDeathExplosions: invalid planner result ${next}`);
      }

      const id = this._deathExplosionWorkEntityIdBuf[0];
      const workKind = this._deathExplosionWorkKindBuf[0];
      if (
        workKind !== DEATH_EXPLOSION_WORK_KIND_UNIT &&
        workKind !== DEATH_EXPLOSION_WORK_KIND_BUILDING
      ) {
        throw new Error(`Simulation.detonateEntityDeathExplosions: invalid planner work kind ${workKind}`);
      }

      const blast = this._deathExplosionBlastScratch;
      if (
        !this.writeEntityDeathExplosion(id, blast) ||
        blast.radius <= 0 ||
        (blast.damage <= 0 && blast.force <= 0)
      ) {
        continue;
      }

      const areaDamage = this._deathExplosionAreaDamageScratch;
      areaDamage.sourceEntityId = blast.sourceEntityId;
      areaDamage.damage = blast.damage;
      areaDamage.radius = blast.radius;
      areaDamage.knockbackForce = blast.force;

      const result = this.damageSystem.applyDeathExplosionDamage(areaDamage);
      applyKnockbackForces(result.knockbacks, this.forceAccumulator);
      collectKillsAndDeathContexts(
        result,
        this.world,
        blast.sourceKey,
        blast.sourceType,
        deadUnitIds,
        deadBuildingIds,
        audioEvents,
        deathContexts,
        blast.sourceEntityId,
        deadTurretIds,
      );
      this.appendDeathExplosionPlannerKills(
        sim,
        result.killedUnitIds,
        result.killedBuildingIds,
      );
    }
  }

  private writeEntityDeathExplosion(
    id: EntityId,
    out: DeathExplosionBlast,
  ): boolean {
    const entity = this.world.getEntity(id);
    if (entity === undefined) {
      return false;
    }
    if (entity.unit !== null) {
      const unitBlueprintId = entity.unit.unitBlueprintId;
      const blast = getUnitBlueprint(unitBlueprintId).base.deathExplosion;
      out.radius = blast.radius;
      out.force = blast.force;
      out.damage = blast.damage;
      out.sourceKey = unitBlueprintId;
      out.sourceType = 'unit';
      out.sourceEntityId = entity.id;
      out.center.x = entity.transform.x;
      out.center.y = entity.transform.y;
      out.center.z = entity.transform.z;
      return true;
    }
    if (entity.building !== null && entity.buildingBlueprintId !== null) {
      const buildingBlueprintId = entity.buildingBlueprintId;
      const blast = getBuildingBlueprint(buildingBlueprintId).base.deathExplosion;
      out.radius = blast.radius;
      out.force = blast.force;
      out.damage = blast.damage;
      out.sourceKey = buildingBlueprintId;
      out.sourceType = 'building';
      out.sourceEntityId = entity.id;
      out.center.x = entity.transform.x;
      out.center.y = entity.transform.y;
      out.center.z = entity.transform.z;
      return true;
    }
    return false;
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
    this._arrivalCount = 0;
    this.prepareCombatHaltDecisions();

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
        this.queueFlyingLoiterThrust(entity);
        continue;
      }

      this.promoteReachableBuildAction(entity);

      // Get current action
      const currentAction = unit.actions[0];
      this.rememberFlyingLoiterTarget(unit, currentAction);

      if (currentAction.type === 'wait') {
        unit.activePath = null;
        unit.stuckTicks = 0;
        this.queueFlyingLoiterThrust(entity);
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

        this.queueArrivalThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
        continue;
      }

      // Attack action: chase a specific enemy target
      // (dead-target attack actions are already swept from the queue above)
      if (currentAction.type === 'attack' && currentAction.targetId !== undefined) {
        const attackTarget = this.world.getEntity(currentAction.targetId)!;

        // Set priority target for turret system
        if (entity.combat) entity.combat.priorityTargetId = currentAction.targetId;

        // Stop if any turret is engaged.
        if (this.shouldStopForEngagedCombat(entity)) {
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
          this.queueArrivalThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
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

        if (this.shouldStopForEngagedCombat(entity)) {
          unit.stuckTicks = 0;
          continue;
        }

        const movementTarget = this.resolveActiveMovementTarget(entity, currentAction);
        const dx = movementTarget.x - transform.x;
        const dy = movementTarget.y - transform.y;
        const distance = magnitude(dx, dy);
        if (distance > 15) {
          this.queueArrivalThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
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

        if (this.shouldStopForEngagedCombat(entity)) {
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
          this.queueArrivalThrust(entity, currentAction, dx, dy, distance, movementTarget.isFinalActionPoint);
        } else if (!movementTarget.isFinalActionPoint) {
          this.advanceActivePathPoint(entity);
          unit.stuckTicks = 0;
        } else if (this.tryRefreshGuardApproach(entity, currentAction, targetPoint)) {
          unit.stuckTicks = 0;
        } else {
          this.queueArrivalThrust(entity, currentAction, targetDx, targetDy, targetDistance);
        }
        continue;
      }

      // Fight/patrol halt is per-mount: unit blueprints mark the exact
      // turret mount(s) that must be engaged before the unit stops and
      // brawls. If no mount is marked, the unit keeps moving while
      // weapons engage opportunistically.
      if (currentAction.type === 'fight' || currentAction.type === 'patrol') {
        if (this.shouldStopForFightCombat(entity)) {
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
      this.queueArrivalCompletion(
        entity,
        currentAction,
        dx,
        dy,
        movementTarget.isFinalActionPoint,
      );
    }

    this.flushArrivalCompletion();
    this.flushFlyingLoiterThrust(movingUnits);
    this.flushArrivalThrust(movingUnits, dtSec);

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

  /** Record the latest actionable point for flying units so they have
   *  a bounded loiter center after their queue empties. */
  private rememberFlyingLoiterTarget(unit: Unit, action: UnitAction): void {
    if (unit.locomotion.type !== 'flying') return;
    const x = this.clampMapX(action.x);
    const y = this.clampMapY(action.y);
    unit.flyingLoiterTargetX = x;
    unit.flyingLoiterTargetY = y;
    unit.flyingLoiterTargetZ = action.z ?? this.world.getGroundZ(x, y);
  }

  private queueFlyingLoiterThrust(entity: Entity): void {
    const unit = entity.unit;
    if (!unit || unit.locomotion.type !== 'flying') return;

    const { transform } = entity;
    const storedCenterX = unit.flyingLoiterTargetX;
    const storedCenterY = unit.flyingLoiterTargetY;
    let centerX: number;
    let centerY: number;
    if (
      typeof storedCenterX !== 'number' ||
      typeof storedCenterY !== 'number' ||
      !Number.isFinite(storedCenterX) ||
      !Number.isFinite(storedCenterY)
    ) {
      centerX = this.clampMapX(transform.x);
      centerY = this.clampMapY(transform.y);
      unit.flyingLoiterTargetX = centerX;
      unit.flyingLoiterTargetY = centerY;
      unit.flyingLoiterTargetZ = Number.isFinite(transform.z)
        ? transform.z
        : this.world.getGroundZ(centerX, centerY);
    } else {
      centerX = this.clampMapX(storedCenterX);
      centerY = this.clampMapY(storedCenterY);
      unit.flyingLoiterTargetX = centerX;
      unit.flyingLoiterTargetY = centerY;
    }

    const dx = centerX - transform.x;
    const dy = centerY - transform.y;
    const distance = magnitude(dx, dy);
    const index = this._loiterCount++;
    this.ensureLoiterCapacity(this._loiterCount);
    this._loiterEntitiesBuf[index] = entity;
    const body = entity.body;
    this._loiterSlotsBuf[index] = body === null
      ? FLYING_LOITER_INVALID_BODY_SLOT
      : body.physicsBody.slot;
    this._loiterDxBuf[index] = dx;
    this._loiterDyBuf[index] = dy;
    this._loiterDistanceBuf[index] = distance;
    this._loiterRotationBuf[index] = transform.rotation;
    this._loiterRadiusBuf[index] = unit.radius.collision;
    this._loiterTurnSignBuf[index] =
      unit.flyingLoiterTurnSign === 1 || unit.flyingLoiterTurnSign === -1
        ? unit.flyingLoiterTurnSign
        : 0;
    this._loiterFallbackVxBuf[index] = unit.velocityX;
    this._loiterFallbackVyBuf[index] = unit.velocityY;
  }

  private ensureLoiterCapacity(required: number): void {
    if (this._loiterSlotsBuf.length >= required) return;
    const next = Math.max(required, this._loiterSlotsBuf.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this._loiterSlotsBuf);
    this._loiterSlotsBuf = slots;
    const dx = new Float64Array(next);
    dx.set(this._loiterDxBuf);
    this._loiterDxBuf = dx;
    const dy = new Float64Array(next);
    dy.set(this._loiterDyBuf);
    this._loiterDyBuf = dy;
    const distance = new Float64Array(next);
    distance.set(this._loiterDistanceBuf);
    this._loiterDistanceBuf = distance;
    const rotation = new Float64Array(next);
    rotation.set(this._loiterRotationBuf);
    this._loiterRotationBuf = rotation;
    const radius = new Float64Array(next);
    radius.set(this._loiterRadiusBuf);
    this._loiterRadiusBuf = radius;
    const turnSign = new Float64Array(next);
    turnSign.set(this._loiterTurnSignBuf);
    this._loiterTurnSignBuf = turnSign;
    const fallbackVx = new Float64Array(next);
    fallbackVx.set(this._loiterFallbackVxBuf);
    this._loiterFallbackVxBuf = fallbackVx;
    const fallbackVy = new Float64Array(next);
    fallbackVy.set(this._loiterFallbackVyBuf);
    this._loiterFallbackVyBuf = fallbackVy;
    this._loiterOutXBuf = new Float64Array(next);
    this._loiterOutYBuf = new Float64Array(next);
    this._loiterOutTurnSignBuf = new Float64Array(next);
    this._loiterActiveBuf = new Uint8Array(next);
  }

  private flushFlyingLoiterThrust(movingUnits: Entity[]): void {
    const count = this._loiterCount;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Simulation.flushFlyingLoiterThrust: sim-wasm is not initialized');
    }
    sim.flyingLoiterStepBatch(
      this._loiterSlotsBuf.subarray(0, count),
      this._loiterDxBuf.subarray(0, count),
      this._loiterDyBuf.subarray(0, count),
      this._loiterDistanceBuf.subarray(0, count),
      this._loiterRotationBuf.subarray(0, count),
      this._loiterRadiusBuf.subarray(0, count),
      this._loiterTurnSignBuf.subarray(0, count),
      this._loiterFallbackVxBuf.subarray(0, count),
      this._loiterFallbackVyBuf.subarray(0, count),
      this._loiterOutXBuf.subarray(0, count),
      this._loiterOutYBuf.subarray(0, count),
      this._loiterOutTurnSignBuf.subarray(0, count),
      this._loiterActiveBuf.subarray(0, count),
      FLYING_LOITER_MIN_RADIUS,
      FLYING_LOITER_RADIUS_MULT,
      FLYING_LOITER_RADIAL_GAIN,
    );

    for (let i = 0; i < count; i++) {
      const entity = this._loiterEntitiesBuf[i];
      const unit = entity.unit;
      if (unit) {
        unit.thrustDirX = this._loiterOutXBuf[i];
        unit.thrustDirY = this._loiterOutYBuf[i];
        const turnSign = this._loiterOutTurnSignBuf[i];
        unit.flyingLoiterTurnSign = turnSign === 1 || turnSign === -1 ? turnSign : null;
        if (this._loiterActiveBuf[i] !== 0) movingUnits.push(entity);
      }
      this._loiterEntitiesBuf[i] = undefined as unknown as Entity;
    }
    this._loiterCount = 0;
  }

  private clampMapX(x: number): number {
    return Math.max(0, Math.min(this.world.mapWidth, x));
  }

  private clampMapY(y: number): number {
    return Math.max(0, Math.min(this.world.mapHeight, y));
  }

  private ensureArrivalCapacity(required: number): void {
    if (this._arrivalSlotsBuf.length >= required) return;
    const next = Math.max(required, this._arrivalSlotsBuf.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this._arrivalSlotsBuf);
    this._arrivalSlotsBuf = slots;
    const dx = new Float64Array(next);
    dx.set(this._arrivalDxBuf);
    this._arrivalDxBuf = dx;
    const dy = new Float64Array(next);
    dy.set(this._arrivalDyBuf);
    this._arrivalDyBuf = dy;
    const distance = new Float64Array(next);
    distance.set(this._arrivalDistanceBuf);
    this._arrivalDistanceBuf = distance;
    const radiusCollision = new Float64Array(next);
    radiusCollision.set(this._arrivalRadiusPushBuf);
    this._arrivalRadiusPushBuf = radiusCollision;
    const driveForce = new Float64Array(next);
    driveForce.set(this._arrivalDriveForceBuf);
    this._arrivalDriveForceBuf = driveForce;
    const traction = new Float64Array(next);
    traction.set(this._arrivalTractionBuf);
    this._arrivalTractionBuf = traction;
    const mass = new Float64Array(next);
    mass.set(this._arrivalMassBuf);
    this._arrivalMassBuf = mass;
    const flags = new Uint8Array(next);
    flags.set(this._arrivalFlagsBuf);
    this._arrivalFlagsBuf = flags;
    this._arrivalOutXBuf = new Float64Array(next);
    this._arrivalOutYBuf = new Float64Array(next);
    this._arrivalActiveBuf = new Uint8Array(next);
  }

  private ensureArrivalCompletionCapacity(required: number): void {
    if (this._arrivalCompletionSlotsBuf.length >= required) return;
    const next = Math.max(required, this._arrivalCompletionSlotsBuf.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this._arrivalCompletionSlotsBuf);
    this._arrivalCompletionSlotsBuf = slots;
    const dx = new Float64Array(next);
    dx.set(this._arrivalCompletionDxBuf);
    this._arrivalCompletionDxBuf = dx;
    const dy = new Float64Array(next);
    dy.set(this._arrivalCompletionDyBuf);
    this._arrivalCompletionDyBuf = dy;
    const fallbackVx = new Float64Array(next);
    fallbackVx.set(this._arrivalCompletionFallbackVxBuf);
    this._arrivalCompletionFallbackVxBuf = fallbackVx;
    const fallbackVy = new Float64Array(next);
    fallbackVy.set(this._arrivalCompletionFallbackVyBuf);
    this._arrivalCompletionFallbackVyBuf = fallbackVy;
    const flags = new Uint8Array(next);
    flags.set(this._arrivalCompletionFlagsBuf);
    this._arrivalCompletionFlagsBuf = flags;
    const finalPoint = new Uint8Array(next);
    finalPoint.set(this._arrivalCompletionFinalPointBuf);
    this._arrivalCompletionFinalPointBuf = finalPoint;
    this._arrivalCompletionDistanceBuf = new Float64Array(next);
    this._arrivalCompletionArrivedBuf = new Uint8Array(next);
  }

  /** Pack one generic waypoint action for Rust-side completion
   *  classification. TypeScript still mutates action queues after the
   *  batch returns; Rust owns the distance/radius/stop-speed decision. */
  private queueArrivalCompletion(
    entity: Entity,
    action: UnitAction,
    dx: number,
    dy: number,
    isFinalActionPoint: boolean,
  ): void {
    const unit = entity.unit;
    if (!unit) return;

    const index = this._arrivalCompletionCount++;
    this.ensureArrivalCompletionCapacity(this._arrivalCompletionCount);
    this._arrivalCompletionEntitiesBuf[index] = entity;
    this._arrivalCompletionActionsBuf[index] = action;
    this._arrivalCompletionSlotsBuf[index] =
      entity.body !== null ? entity.body.physicsBody.slot : FLYING_LOITER_INVALID_BODY_SLOT;
    this._arrivalCompletionDxBuf[index] = dx;
    this._arrivalCompletionDyBuf[index] = dy;
    this._arrivalCompletionFallbackVxBuf[index] = unit.velocityX;
    this._arrivalCompletionFallbackVyBuf[index] = unit.velocityY;
    let flags = unit.actions.length <= 1 && action.type !== 'patrol'
      && isFinalActionPoint
      ? ARRIVAL_BATCH_FLAG_LAST_ACTION
      : 0;
    if (unit.locomotion.type === 'flying') flags |= ARRIVAL_COMPLETION_BATCH_FLAG_FLYING;
    this._arrivalCompletionFlagsBuf[index] = flags;
    this._arrivalCompletionFinalPointBuf[index] = isFinalActionPoint ? 1 : 0;
  }

  private flushArrivalCompletion(): void {
    const count = this._arrivalCompletionCount;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Simulation.flushArrivalCompletion: sim-wasm is not initialized');
    }
    sim.arrivalCompletionStepBatch(
      this._arrivalCompletionSlotsBuf.subarray(0, count),
      this._arrivalCompletionDxBuf.subarray(0, count),
      this._arrivalCompletionDyBuf.subarray(0, count),
      this._arrivalCompletionFallbackVxBuf.subarray(0, count),
      this._arrivalCompletionFallbackVyBuf.subarray(0, count),
      this._arrivalCompletionFlagsBuf.subarray(0, count),
      this._arrivalCompletionDistanceBuf.subarray(0, count),
      this._arrivalCompletionArrivedBuf.subarray(0, count),
      ARRIVAL_RADIUS,
      ARRIVAL_FINAL_RADIUS,
      ARRIVAL_FINAL_STOP_SPEED,
    );

    for (let i = 0; i < count; i++) {
      const entity = this._arrivalCompletionEntitiesBuf[i];
      const action = this._arrivalCompletionActionsBuf[i];
      const unit = entity.unit;
      if (unit) {
        if (this._arrivalCompletionArrivedBuf[i] !== 0) {
          if (this._arrivalCompletionFinalPointBuf[i] !== 0) {
            this.advanceAction(entity);
          } else {
            this.advanceActivePathPoint(entity);
          }
          unit.stuckTicks = 0;
          if (unit.actions.length === 0) this.queueFlyingLoiterThrust(entity);
        } else {
          this.queueArrivalThrust(
            entity,
            action,
            this._arrivalCompletionDxBuf[i],
            this._arrivalCompletionDyBuf[i],
            this._arrivalCompletionDistanceBuf[i],
            this._arrivalCompletionFinalPointBuf[i] !== 0,
          );
        }
      }
      this._arrivalCompletionEntitiesBuf[i] = undefined as unknown as Entity;
      this._arrivalCompletionActionsBuf[i] = undefined as unknown as UnitAction;
      this._arrivalCompletionFinalPointBuf[i] = 0;
    }
    this._arrivalCompletionCount = 0;
  }

  /** Pack one action-system arrival request for the WASM batch. The
   *  TypeScript side still owns action queue semantics; Rust owns the
   *  velocity-aware PD controller over the packed candidates. */
  private queueArrivalThrust(
    entity: Entity,
    action: UnitAction,
    dx: number,
    dy: number,
    distance: number,
    isFinalActionPoint = true,
  ): void {
    const unit = entity.unit;
    const body = entity.body;
    const bodySlot = body !== null ? body.physicsBody.slot : -1;
    if (!unit || bodySlot < 0 || !Number.isFinite(distance) || distance <= 0.0001) {
      if (unit) {
        unit.thrustDirX = 0;
        unit.thrustDirY = 0;
      }
      return;
    }

    // Intermediate path points and queued waypoints steer full-power
    // through the point. The PD braking math only fires when the unit
    // needs to stop at a precise point: the final path point for the
    // last durable action in the queue.
    const isLastAction = isFinalActionPoint && unit.actions.length <= 1 && action.type !== 'patrol';
    const index = this._arrivalCount++;
    this.ensureArrivalCapacity(this._arrivalCount);
    this._arrivalEntitiesBuf[index] = entity;
    this._arrivalSlotsBuf[index] = bodySlot;
    this._arrivalDxBuf[index] = dx;
    this._arrivalDyBuf[index] = dy;
    this._arrivalDistanceBuf[index] = distance;
    this._arrivalRadiusPushBuf[index] = unit.radius.collision;
    this._arrivalDriveForceBuf[index] = unit.locomotion.driveForce;
    this._arrivalTractionBuf[index] = unit.locomotion.traction;
    this._arrivalMassBuf[index] = unit.mass;
    this._arrivalFlagsBuf[index] = isLastAction ? ARRIVAL_BATCH_FLAG_LAST_ACTION : 0;
  }

  private flushArrivalThrust(movingUnits: Entity[], dtSec: number): void {
    const count = this._arrivalCount;
    if (count === 0) return;

    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error('Simulation.flushArrivalThrust: sim-wasm is not initialized');
    }
    sim.arrivalControlStepBatch(
      this._arrivalSlotsBuf.subarray(0, count),
      this._arrivalDxBuf.subarray(0, count),
      this._arrivalDyBuf.subarray(0, count),
      this._arrivalDistanceBuf.subarray(0, count),
      this._arrivalRadiusPushBuf.subarray(0, count),
      this._arrivalDriveForceBuf.subarray(0, count),
      this._arrivalTractionBuf.subarray(0, count),
      this._arrivalMassBuf.subarray(0, count),
      this._arrivalFlagsBuf.subarray(0, count),
      this._arrivalOutXBuf.subarray(0, count),
      this._arrivalOutYBuf.subarray(0, count),
      this._arrivalActiveBuf.subarray(0, count),
      dtSec,
      this.world.thrustMultiplier,
      LOCOMOTION_FORCE_SCALE,
      UNIT_MASS_MULTIPLIER,
      ARRIVAL_CONTROL_RADIUS,
      ARRIVAL_RESPONSE_TIME_SEC,
      ARRIVAL_MIN_ACCEL,
    );

    for (let i = 0; i < count; i++) {
      const entity = this._arrivalEntitiesBuf[i];
      const unit = entity.unit;
      if (unit) {
        unit.thrustDirX = this._arrivalOutXBuf[i];
        unit.thrustDirY = this._arrivalOutYBuf[i];
        if (this._arrivalActiveBuf[i] !== 0) movingUnits.push(entity);
      }
      this._arrivalEntitiesBuf[i] = undefined as unknown as Entity;
    }
    this._arrivalCount = 0;
  }

  private ensureCombatHaltRowCapacity(required: number): void {
    if (this._combatHaltSlotsBuf.length >= required) return;
    const next = Math.max(required, this._combatHaltSlotsBuf.length * 2, 128);
    const slots = new Uint32Array(next);
    slots.set(this._combatHaltSlotsBuf);
    this._combatHaltSlotsBuf = slots;
    const modes = new Uint8Array(next);
    modes.set(this._combatHaltModesBuf);
    this._combatHaltModesBuf = modes;
    const priorityPoint = new Uint8Array(next);
    priorityPoint.set(this._combatHaltPriorityPointBuf);
    this._combatHaltPriorityPointBuf = priorityPoint;
    this._combatHaltOutBuf = new Uint8Array(next);
  }

  private ensureCombatHaltSlotCapacity(required: number): void {
    if (this._combatHaltModeBySlot.length >= required) return;
    const next = Math.max(required, this._combatHaltModeBySlot.length * 2, 128);
    const modes = new Uint8Array(next);
    modes.set(this._combatHaltModeBySlot);
    this._combatHaltModeBySlot = modes;
    const priorityPoint = new Uint8Array(next);
    priorityPoint.set(this._combatHaltPriorityPointBySlot);
    this._combatHaltPriorityPointBySlot = priorityPoint;
    const stop = new Uint8Array(next);
    stop.set(this._combatHaltStopBySlot);
    this._combatHaltStopBySlot = stop;
  }

  private clearCombatHaltDecisionCache(): void {
    const touched = this._combatHaltTouchedSlotsBuf;
    for (let i = 0; i < touched.length; i++) {
      const slot = touched[i];
      this._combatHaltModeBySlot[slot] = 0;
      this._combatHaltPriorityPointBySlot[slot] = 0;
      this._combatHaltStopBySlot[slot] = 0;
    }
    touched.length = 0;
  }

  private queueCombatHaltDecision(
    index: number,
    slot: number,
    mode: number,
    priorityPointPresent: boolean,
  ): void {
    this._combatHaltSlotsBuf[index] = slot;
    this._combatHaltModesBuf[index] = mode;
    this._combatHaltPriorityPointBuf[index] = priorityPointPresent ? 1 : 0;
  }

  private cacheCombatHaltDecision(
    slot: number,
    mode: number,
    priorityPointPresent: number,
    shouldStop: number,
  ): void {
    this.ensureCombatHaltSlotCapacity(slot + 1);
    this._combatHaltModeBySlot[slot] = mode + 1;
    this._combatHaltPriorityPointBySlot[slot] = priorityPointPresent;
    this._combatHaltStopBySlot[slot] = shouldStop;
    this._combatHaltTouchedSlotsBuf.push(slot);
  }

  private prepareCombatHaltDecisions(): void {
    this.clearCombatHaltDecisionCache();
    const sim = getSimWasm();
    if (sim === undefined) return;
    const units = this.world.getUnits();
    this.ensureCombatHaltRowCapacity(units.length);

    let count = 0;
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      const unit = entity.unit;
      if (!unit || !entity.combat || unit.actions.length === 0) continue;
      const action = unit.actions[0];
      let mode = -1;
      let priorityPointPresent = false;
      if (
        (action.type === 'attack' && action.targetId !== undefined) ||
        action.type === 'guard'
      ) {
        mode = CT_COMBAT_HALT_MODE_ANY_ENGAGED;
      } else if (action.type === 'attackGround') {
        mode = CT_COMBAT_HALT_MODE_ANY_ENGAGED;
        priorityPointPresent = true;
      } else if (action.type === 'fight' || action.type === 'patrol') {
        if (!this.unitHasFightStopRequiredMount(unit.unitBlueprintId)) continue;
        mode = CT_COMBAT_HALT_MODE_FIGHT_REQUIRED;
      } else {
        continue;
      }
      const slot = spatialGrid.getSlot(entity.id);
      if (slot < 0) continue;
      this.queueCombatHaltDecision(count, slot, mode, priorityPointPresent);
      count++;
    }
    if (count === 0) return;

    sim.combatTargeting.haltDecisionBatch(
      this._combatHaltSlotsBuf.subarray(0, count),
      this._combatHaltModesBuf.subarray(0, count),
      this._combatHaltPriorityPointBuf.subarray(0, count),
      this._combatHaltOutBuf.subarray(0, count),
    );

    for (let i = 0; i < count; i++) {
      this.cacheCombatHaltDecision(
        this._combatHaltSlotsBuf[i],
        this._combatHaltModesBuf[i],
        this._combatHaltPriorityPointBuf[i],
        this._combatHaltOutBuf[i],
      );
    }
  }

  private readCombatHaltDecision(
    entity: Entity,
    mode: number,
    priorityPointPresent: boolean,
  ): boolean {
    const slot = spatialGrid.getSlot(entity.id);
    if (slot < 0) return false;
    this.ensureCombatHaltSlotCapacity(slot + 1);
    const modeKey = mode + 1;
    const priorityPointFlag = priorityPointPresent ? 1 : 0;
    if (
      this._combatHaltModeBySlot[slot] === modeKey &&
      this._combatHaltPriorityPointBySlot[slot] === priorityPointFlag
    ) {
      return this._combatHaltStopBySlot[slot] !== 0;
    }

    const sim = getSimWasm();
    if (sim === undefined) return false;
    this.ensureCombatHaltRowCapacity(1);
    this.queueCombatHaltDecision(0, slot, mode, priorityPointPresent);
    sim.combatTargeting.haltDecisionBatch(
      this._combatHaltSlotsBuf.subarray(0, 1),
      this._combatHaltModesBuf.subarray(0, 1),
      this._combatHaltPriorityPointBuf.subarray(0, 1),
      this._combatHaltOutBuf.subarray(0, 1),
    );
    this.cacheCombatHaltDecision(
      slot,
      mode,
      priorityPointFlag,
      this._combatHaltOutBuf[0],
    );
    return this._combatHaltOutBuf[0] !== 0;
  }

  /** True when any non-visual turret is engaged with a target, so the
   *  unit should hold position rather than keep chasing. This uses the
   *  turret FSM directly instead of firingTurretMask so passive combat
   *  systems like shield panels can stop during fight/patrol orders. */
  private shouldStopForEngagedCombat(entity: Entity): boolean {
    const combat = entity.combat;
    if (!combat || combat.turrets.length === 0) return false;
    return this.readCombatHaltDecision(
      entity,
      CT_COMBAT_HALT_MODE_ANY_ENGAGED,
      combat.priorityTargetPoint !== null,
    );
  }

  private unitHasFightStopRequiredMount(unitBlueprintId: string): boolean {
    return getUnitBlueprint(unitBlueprintId).turrets.some(
      (mount) => mount.requiredEngagedForFightStop === true,
    );
  }

  /** Fight/patrol variant of the engagement halt check. Halts only when
   *  every unit mount marked `requiredEngagedForFightStop` has an engaged,
   *  non-visual turret. Units with no required mounts never halt for
   *  fight/patrol combat. Host-directed targeting is independent: a turret
   *  may inherit host orders without participating in fight-stop gating. */
  private shouldStopForFightCombat(entity: Entity): boolean {
    if (!entity.unit) return false;
    if (!this.unitHasFightStopRequiredMount(entity.unit.unitBlueprintId)) return false;
    const combat = entity.combat;
    if (!combat || combat.turrets.length === 0) return false;
    return this.readCombatHaltDecision(
      entity,
      CT_COMBAT_HALT_MODE_FIGHT_REQUIRED,
      combat.priorityTargetPoint !== null,
    );
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
    this._audioA.length = 0;
    this._audioB.length = 0;
    this.pendingSimEvents = this._audioA;
    this._spawnsA.length = 0;
    this._spawnsB.length = 0;
    this.pendingProjectileSpawns = this._spawnsA;
    this._despawnsA.length = 0;
    this._despawnsB.length = 0;
    this.pendingProjectileDespawns = this._despawnsA;
    this.pendingProjectileVelocityUpdates.clear();
    this._velUpdateBufA.length = 0;
    this._velUpdateBufB.length = 0;
    this._deadUnitIdsBuf.length = 0;
    this._deadBuildingIdsBuf.length = 0;
    this._deathCheckIdsBuf.length = 0;
    this._arrivalCount = 0;
    this._arrivalEntitiesBuf.length = 0;
    this._arrivalCompletionCount = 0;
    this._arrivalCompletionEntitiesBuf.length = 0;
    this._arrivalCompletionActionsBuf.length = 0;
    this._loiterCount = 0;
    this._loiterEntitiesBuf.length = 0;
    this._stuckEntitiesBuf.length = 0;
    this.clearCombatHaltDecisionCache();
    this.world.clearPendingDeathCheckIds();
    resetEnergyBuffers(this.energyBuffers);
    resetShieldBuffers();
    resetLaserSoundState();
    resetShieldSoundState();
    this.spatialGridBuildingVersion = -1;
  }
}
