import { WorldState } from './WorldState';
import { CommandQueue } from './commands';
import type { Entity, EntityId, PlayerId } from './types';
import { buildUnitDeathEvent, buildBuildingDeathEvent } from './combat/damageHelpers';
import { magnitude } from '../math';
import { executeCommand, type CommandContext } from './commandExecution';
import { distributeEnergy, createEnergyBuffers, resetEnergyBuffers, type EnergyBuffers } from './energyDistribution';
import {
  updateTargetingAndFiringState,
  updateTurretRotation,
  updateLaserSounds,
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
  updateForceFieldSounds,
  emitForceFieldStopsForEntity,
  fireTurrets,
  updateForceFieldState,
  applyForceFieldDamage,
  resetForceFieldBuffers,
  registerPackedProjectile,
  unregisterPackedProjectile,
} from './combat';
import { clearTargetIndex } from './combat/targetIndex';
import { engagedTurretCount } from './combat/combatUtils';
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
import { syncShellHpToBuildFraction } from './shellHpSync';
import { commanderAbilitiesSystem, type SprayTarget } from './commanderAbilities';
import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';
import { transitionPhase } from '@/gamePhase';
import { getUnitBlueprint } from './blueprints/units';
import { ENTITY_CHANGED_ACTIONS, ENTITY_CHANGED_TURRETS } from '@/types/network';
import type { GamePhase } from '@/types/network';
import { updateAiProduction } from './aiProduction';
import { expandPathActions } from './Pathfinder';
import { updateSolarCollectors } from './solarCollector';
import { getEntityTargetPoint } from './buildingAnchors';
import { WindPowerTracker, sampleWindState, type WindState } from './wind';
import { isBuildTargetInRange } from './builderRange';

// Shared empty array constant (avoids per-call allocation for empty returns)
const EMPTY_VEL_UPDATES: ProjectileVelocityUpdateEvent[] = [];

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
  private static readonly SAFETY_CLEANUP_STRIDE = 8;

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
  private _movingUnitsBuf: Entity[] = [];

  // Reusable buffers for shared energy distribution (avoid per-tick allocations)
  private energyBuffers: EnergyBuffers = createEnergyBuffers();

  // Callback for when units die (to clean up physics bodies)
  // deathContexts contains info about the killing blow for directional explosions
  public onUnitDeath?: (deadUnitIds: EntityId[], deathContexts?: Map<EntityId, DeathContext>) => void;

  // Callback for when units are spawned (to create physics bodies)
  public onUnitSpawn?: (newUnits: Entity[]) => void;

  // Callback for when buildings are destroyed
  public onBuildingDeath?: (deadBuildingIds: EntityId[]) => void;

  // Callback for audio events
  public onSimEvent?: (event: SimEvent) => void;

  // Callback for game over (passes winner ID)
  public onGameOver?: (winnerId: PlayerId) => void;

  constructor(world: WorldState, commandQueue: CommandQueue) {
    this.world = world;
    this.commandQueue = commandQueue;
    this.constructionSystem = new ConstructionSystem(world.mapWidth, world.mapHeight);
    this.damageSystem = new DamageSystem(world);
  }

  // AI player IDs (for auto-production)
  private aiPlayerIds: Set<PlayerId> = new Set();
  private aiAllowedUnitTypes?: ReadonlySet<string>;

  // Set the player IDs for this game
  setPlayerIds(playerIds: PlayerId[]): void {
    this.playerIds = playerIds;
  }

  // Set which players are AI-controlled (factories auto-queue units)
  setAiPlayerIds(ids: PlayerId[]): void {
    this.aiPlayerIds = new Set(ids);
  }

  // Set allowed unit types for AI production (undefined = all allowed)
  setAiAllowedUnitTypes(types?: ReadonlySet<string>): void {
    this.aiAllowedUnitTypes = types;
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

    this.simElapsedMs += dtMs;
    const tick = this.world.getTick();

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

    // Solar collectors are stateful: damage closes them, a quiet
    // debounce reopens them, and production follows that open state.
    updateSolarCollectors(this.world, dtMs);
    this.windState = sampleWindState(this.simElapsedMs);
    this.windPowerTracker.update(this.world, this.windState);

    // Update economy (income, production). Mana base income is gated
    // on a living commander — pass the predicate so a team that's
    // lost its commander stops earning passive mana.
    economyManager.update(dtMs, (pid) => this.world.isCommanderAlive(pid));

    // Distribute energy equally among all active consumers (factories, construction, commander)
    distributeEnergy(this.world, dtMs, this.energyBuffers);

    // Update HP of every in-progress shell to track its avg-fill ratio.
    // The shell entity is fully built mesh-wise but its hp must follow
    // the bars so a half-built shell sits at half HP and the four bars
    // (3 resource + HP) tell a consistent story.
    syncShellHpToBuildFraction(this.world);

    // Check construction completion
    this.constructionSystem.update(this.world, dtMs);

    // AI auto-queues units at idle factories
    updateAiProduction(this.world, this.aiPlayerIds, this.aiAllowedUnitTypes);

    // Update factory production
    const productionResult = factoryProductionSystem.update(
      this.world, dtMs,
      this.constructionSystem.getGrid(),
    );
    // Notify about newly spawned units (need physics bodies)
    if (productionResult.completedUnits.length > 0) {
      this.onUnitSpawn?.(productionResult.completedUnits);
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
    this.updateUnits();

    // Update non-unit spatial indices. Unit cells are refreshed inside
    // updateUnits() to avoid another full unit walk.
    this.updateSpatialGrid();

    // Update combat systems (adds external forces like force field pull)
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

    // Update traveling projectile positions for force-field spatial
    // queries. Beam/laser line shots are handled by beam pathing and
    // do not participate as pushable projectile bodies.
    for (const proj of this.world.getTravelingProjectiles()) {
      spatialGrid.updateProjectile(proj);
    }
  }

  // Check for game over - last commander standing wins
  private checkGameOver(): void {
    if (this.gameOverWinnerId !== null) return; // Already over

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
      this.onGameOver?.(this.gameOverWinnerId);
    }
    // If no players remain (somehow), no winner
    else if (aliveCount === 0 && this.playerIds.length > 0) {
      // Draw or error state - just pick first player
      this.gameOverWinnerId = this.playerIds[0];
      this.gamePhase = transitionPhase(this.gamePhase, 'gameOver');
      this.onGameOver?.(this.gameOverWinnerId);
    }
  }

  // Update combat systems
  private updateCombat(dtMs: number): void {
    // Update weapon cooldowns, targeting, and firing state in one armed-unit pass.
    const activeCombatUnits = updateTargetingAndFiringState(this.world, dtMs);

    // Update laser sounds based on targeting state (every frame)
    if (this.world.getBeamUnits().length > 0) {
      const laserSimEvents = updateLaserSounds(this.world);
      for (const event of laserSimEvents) {
        this.onSimEvent?.(event);
        this.pendingSimEvents.push(event);
      }
    }

    // Update force field sounds based on transition progress (every frame)
    const forceFieldUnits = this.world.forceFieldsEnabled
      ? this.world.getForceFieldUnits()
      : undefined;
    if (forceFieldUnits && forceFieldUnits.length > 0) {
      const forceFieldSimEvents = updateForceFieldSounds(forceFieldUnits);
      for (const event of forceFieldSimEvents) {
        this.onSimEvent?.(event);
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
      this.onSimEvent?.(event);
      this.pendingSimEvents.push(event);
    }

    // Update force field state (range transitions)
    if (forceFieldUnits && forceFieldUnits.length > 0) {
      updateForceFieldState(this.world, dtMs);
    }

    // Apply force field knockback (force fields no longer deal damage,
    // only push enemy units / projectiles).
    if (forceFieldUnits && forceFieldUnits.length > 0) {
      const forceFieldVelocityUpdates = applyForceFieldDamage(this.world, dtMs, this.damageSystem, this.forceAccumulator);
      for (const event of forceFieldVelocityUpdates) {
        this.pendingProjectileVelocityUpdates.set(event.id, event);
      }
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
      for (const event of updateResult.velocityUpdates) {
        this.pendingProjectileVelocityUpdates.set(event.id, event);
      }

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

      // Emit hit/death audio events
      for (const event of collisionResult.events) {
        this.onSimEvent?.(event);
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
            // Emit forceFieldStop for the dying entity's force field weapons
            for (const evt of emitForceFieldStopsForEntity(entity)) {
              this.pendingSimEvents.push(evt);
            }
          }
          spatialGrid.removeUnit(id);
          buf.push(id);
        }
        this.onUnitDeath?.(buf, collisionResult.deathContexts);
      }

      if (collisionResult.deadBuildingIds.size > 0) {
        const buf = this._deadBuildingIdsBuf;
        buf.length = 0;
        for (const id of collisionResult.deadBuildingIds) {
          spatialGrid.removeBuilding(id);
          buf.push(id);
        }
        this.onBuildingDeath?.(buf);
      }
    }

    // Safety cleanup - remove any dead entities that slipped through.
    // Normal combat deaths are handled in the collision path above;
    // this fallback is rate-limited so it does not rescan the world on
    // every combat tick.
    if (this.world.getTick() % Simulation.SAFETY_CLEANUP_STRIDE === 0) {
      this.cleanupDeadEntities();
    }
  }

  // Cleanup pass - removes any entities with HP <= 0 that weren't caught by normal death handling
  // This is a safety net to ensure dead entities don't persist in the world
  private cleanupDeadEntities(): void {
    const deadUnitIds = this._deadUnitIdsBuf;
    const deadBuildingIds = this._deadBuildingIdsBuf;
    deadUnitIds.length = 0;
    deadBuildingIds.length = 0;

    // Check all units for death
    for (const entity of this.world.getUnits()) {
      if (entity.unit && entity.unit.hp <= 0) {
        deadUnitIds.push(entity.id);
      }
    }

    // Check all buildings for death
    for (const entity of this.world.getBuildings()) {
      if (entity.building && entity.building.hp <= 0) {
        deadBuildingIds.push(entity.id);
      }
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
          // Emit forceFieldStop for the dying entity's force field weapons
          for (const evt of emitForceFieldStopsForEntity(entity)) {
            this.pendingSimEvents.push(evt);
          }
          // Synthesize a death SimEvent so the renderer still fires a
          // material explosion for units killed outside the normal
          // damage-pass path (e.g. force-field DoT, bleed-out, anything
          // that sets hp<=0 without going through collectKills*).
          // Without this, the unit just vanishes silently.
          this.emitSyntheticDeathEvent(entity);
        }
        spatialGrid.removeUnit(id);
      }
      this.onUnitDeath?.(deadUnitIds);
      for (const id of deadUnitIds) {
        this.world.removeEntity(id);
      }
    }

    if (deadBuildingIds.length > 0) {
      for (const id of deadBuildingIds) {
        const building = this.world.getEntity(id);
        if (building) this.emitSyntheticDeathEvent(building);
        spatialGrid.removeBuilding(id);
      }
      this.onBuildingDeath?.(deadBuildingIds);
      for (const id of deadBuildingIds) {
        this.world.removeEntity(id);
      }
    }
  }

  // Build a death SimEvent for entities dying outside the normal
  // collision-handler path (force-field DoT, anything that mutates hp
  // directly). Delegates to the shared buildUnitDeathEvent /
  // buildBuildingDeathEvent so the shape can't drift from the damage-
  // path kills. There is no turret to credit here, so provenance lives
  // in sourceType/sourceKey and turretId remains a weapon/audio key.
  private emitSyntheticDeathEvent(entity: Entity): void {
    if (entity.unit) {
      this.pendingSimEvents.push(
        buildUnitDeathEvent(entity, entity.id, entity.unit.unitType ?? '', undefined, 'unit'),
      );
    } else if (entity.building) {
      this.pendingSimEvents.push(
        buildBuildingDeathEvent(entity, entity.id, entity.buildingType ?? '', 'building'),
      );
    }
  }

  // Update unit movement with action queue processing.
  // unit.thrustDirX/Y is what GameServer.applyForces reads — a (0, 0)
  // means "no thrust this tick, friction will slow us". The
  // authoritative physics velocity stays in unit.velocityX/Y/Z and
  // is only overwritten by syncFromPhysics, so lead-prediction in
  // turretSystem reads the real velocity, not this thrust target.
  private updateUnits(): void {
    const movingUnits = this._movingUnitsBuf;
    movingUnits.length = 0;

    for (const entity of this.world.getUnits()) {
      spatialGrid.updateUnit(entity);
      if (!entity.unit || !entity.body) continue;

      const { unit, transform } = entity;

      // Inert shells stay put — zero thrust, no actions, no priority
      // target. The shell occupies its build-spot footprint until it
      // completes or is destroyed.
      if (entity.buildable && !entity.buildable.isComplete) {
        unit.thrustDirX = 0;
        unit.thrustDirY = 0;
        unit.priorityTargetId = undefined;
        continue;
      }

      // Default: no thrust (friction will slow the unit)
      unit.thrustDirX = 0;
      unit.thrustDirY = 0;

      // Clear priority target — re-set below if current action is attack
      unit.priorityTargetId = undefined;

      // Sweep queued attack actions whose targets are dead/gone
      let actionsChanged = false;
      for (let i = unit.actions.length - 1; i >= 0; i--) {
        const a = unit.actions[i];
        if (a.type !== 'attack' || a.targetId === undefined) continue;
        const t = this.world.getEntity(a.targetId);
        const alive = t &&
          ((t.unit && t.unit.hp > 0) || (t.building && t.building.hp > 0));
        if (!alive) {
          unit.actions.splice(i, 1);
          actionsChanged = true;
        }
      }
      if (actionsChanged) {
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      }

      // No actions - no thrust needed
      if (unit.actions.length === 0) {
        unit.stuckTicks = 0;
        continue;
      }

      this.promoteReachableBuildAction(entity);

      // Get current action
      const currentAction = unit.actions[0];

      // For build/repair actions, check if we're in range
      if (currentAction.type === 'build' || currentAction.type === 'repair') {
        const targetId = currentAction.type === 'build'
          ? currentAction.buildingId
          : currentAction.targetId;
        const target = targetId !== undefined ? this.world.getEntity(targetId) : undefined;
        if (target && isBuildTargetInRange(entity, target)) {
          unit.stuckTicks = 0;
          continue;
        }

        const dx = currentAction.x - transform.x;
        const dy = currentAction.y - transform.y;
        const distance = magnitude(dx, dy);
        if (distance <= 1) {
          unit.stuckTicks = 0;
          continue;
        }

        // Thrust toward target
        this.applyThrustToward(unit, dx, dy, distance);
        movingUnits.push(entity);
        continue;
      }

      // Attack action: chase a specific enemy target
      // (dead-target attack actions are already swept from the queue above)
      if (currentAction.type === 'attack' && currentAction.targetId !== undefined) {
        const attackTarget = this.world.getEntity(currentAction.targetId)!;

        // Set priority target for turret system
        unit.priorityTargetId = currentAction.targetId;

        // Update action position to target's current anchor (follow
        // moving units and keep building attack markers on the visual
        // building center/top instead of collider-center guesses).
        const targetPoint = getEntityTargetPoint(attackTarget);
        currentAction.x = targetPoint.x;
        currentAction.y = targetPoint.y;
        currentAction.z = targetPoint.z;

        // Stop if enough turrets are engaged
        if (this.shouldStopForEngagedCombat(entity)) {
          unit.stuckTicks = 0;
          continue;
        }

        // Thrust toward target
        const dx = targetPoint.x - transform.x;
        const dy = targetPoint.y - transform.y;
        const distance = magnitude(dx, dy);
        if (distance > 5) {
          this.applyThrustToward(unit, dx, dy, distance);
          movingUnits.push(entity);
        } else {
          unit.stuckTicks = 0;
        }
        continue;
      }

      // Check if unit should stop for combat (fight or patrol mode with enough turrets engaged)
      if (currentAction.type === 'fight' || currentAction.type === 'patrol') {
        if (this.shouldStopForEngagedCombat(entity)) {
          unit.stuckTicks = 0;
          continue;
        }
      }

      // Calculate direction to waypoint
      const dx = currentAction.x - transform.x;
      const dy = currentAction.y - transform.y;
      const distance = magnitude(dx, dy);

      // Close enough to waypoint - advance to next action, no thrust
      if (distance < 15) {
        this.advanceAction(entity);
        unit.stuckTicks = 0;
        continue;
      }

      // Thrust toward waypoint
      this.applyThrustToward(unit, dx, dy, distance);
      movingUnits.push(entity);
    }

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

  private promoteReachableBuildAction(entity: Entity): void {
    const unit = entity.unit;
    if (!unit || !entity.builder || unit.actions.length === 0) return;

    const actions = unit.actions;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action.type !== 'build' && action.type !== 'repair') {
        if (!action.isPathExpansion) return;
        continue;
      }

      const targetId = action.type === 'build' ? action.buildingId : action.targetId;
      const target = targetId !== undefined ? this.world.getEntity(targetId) : undefined;
      if (!target || !isBuildTargetInRange(entity, target)) return;

      if (i > 0) {
        actions.splice(0, i);
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
      }
      return;
    }
  }

  /** Set the unit's thrust vector toward a (dx, dy) offset whose
   *  pre-computed magnitude is `distance`. Locomotion physics owns
   *  propulsion strength; actions only author desired direction. */
  private applyThrustToward(unit: NonNullable<Entity['unit']>, dx: number, dy: number, distance: number): void {
    unit.thrustDirX = dx / distance;
    unit.thrustDirY = dy / distance;
  }

  /** True when the unit has enough turrets engaged that it should hold
   *  position to fight rather than continue chasing the current waypoint. */
  private shouldStopForEngagedCombat(entity: Entity): boolean {
    const turrets = entity.turrets;
    if (!turrets || turrets.length === 0) return false;
    const stopRatio = getUnitBlueprint(entity.unit!.unitType).fightStopEngagedRatio;
    return engagedTurretCount(turrets) >= turrets.length * stopRatio;
  }

  /** Per-tick stuck check. For each unit that wanted to move this
   *  tick but is barely moving, increment its stuck counter; once
   *  past the threshold and within the per-tick replan budget, run
   *  a fresh A* from the unit's current position to the trip's
   *  final destination and replace its action queue. */
  private evaluateStuckAndReplan(movingUnits: readonly Entity[]): void {
    for (const entity of movingUnits) {
      if (!entity.unit || !entity.body) continue;
      const unit = entity.unit;
      const body = entity.body.physicsBody;
      const speed = magnitude(body.vx, body.vy);
      if (speed >= STUCK_VEL_THRESHOLD) {
        unit.stuckTicks = 0;
        continue;
      }
      unit.stuckTicks = (unit.stuckTicks ?? 0) + 1;
      if (unit.stuckTicks <= STUCK_TICK_THRESHOLD) continue;
      if (this.replansThisTick >= MAX_REPLANS_PER_TICK) continue;
      if (this.tryReplan(entity)) {
        unit.stuckTicks = 0;
        this.replansThisTick++;
      } else {
        // Replan didn't improve the unit's path — most often the
        // planner bailed (target unreachable from current position
        // under the JP-expansion budget) or the action type isn't
        // replan-eligible (patrol / build / repair). Either way,
        // hammering the planner again next tick won't help. Set
        // stuckTicks to a negative cooldown so the unit waits a
        // few seconds before its next eligibility window. The
        // current path stays untouched (tryReplan didn't replace
        // it) so the unit keeps trying its existing route.
        unit.stuckTicks = REPLAN_FAILURE_COOLDOWN;
      }
    }
  }

  /** Replan the given unit's path from its current position to the
   *  final waypoint of its existing action queue. Returns true on a
   *  successful replan (queue replaced), false when the action type
   *  isn't replan-eligible (patrol loops have wrap semantics that
   *  break under naive replan; build/repair are short-range and
   *  bound to specific targets). Attack-action target IDs are
   *  preserved on the new final waypoint so the unit keeps tracking
   *  the right enemy through the new route. */
  private tryReplan(entity: Entity): boolean {
    if (!entity.unit) return false;
    const actions = entity.unit.actions;
    if (actions.length === 0) return false;
    const finalAction = actions[actions.length - 1];
    if (
      finalAction.type !== 'move' &&
      finalAction.type !== 'fight' &&
      finalAction.type !== 'attack'
    ) {
      return false;
    }
    // Forward the original action's altitude so a replan keeps the
    // click-derived final-waypoint z (used by Waypoint3D rendering)
    // instead of falling back to a fresh terrain sample.
    const newPath = expandPathActions(
      entity.transform.x, entity.transform.y,
      finalAction.x, finalAction.y,
      finalAction.type,
      this.world.mapWidth, this.world.mapHeight,
      this.constructionSystem.getGrid(),
      finalAction.z,
    );
    if (newPath.length === 0) return false;
    // CRITICAL: a single-waypoint result is the planner's
    // straight-line fallback — it fires when JPS hit its expansion
    // cap, when the snap couldn't find an open cell within radius,
    // or when the goal was unreachable. Overwriting the unit's
    // existing multi-waypoint path with that single-waypoint
    // fallback would REPLACE a good route with a beeline straight
    // at the obstacle the unit was already routing around. The
    // existing path is strictly more useful than the fallback;
    // keep it and let the unit's current motion resolve via
    // physics push or by reaching the next waypoint. Stuck
    // detection re-fires next tick if the unit is still wedged,
    // so we'll retry the replan on the next stuck-tick threshold.
    if (newPath.length <= 1 && actions.length > 1) return false;
    if (finalAction.type === 'attack' && finalAction.targetId !== undefined) {
      const last = newPath[newPath.length - 1];
      last.targetId = finalAction.targetId;
      last.x = finalAction.x;
      last.y = finalAction.y;
      last.z = finalAction.z;
    }
    entity.unit.actions = newPath;
    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ACTIONS);
    return true;
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
      unit.actions.shift();
      unit.actions.push(completedAction);
    } else {
      // Remove completed action
      unit.actions.shift();

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
    resetEnergyBuffers(this.energyBuffers);
    resetForceFieldBuffers();
    clearTargetIndex();
    this.spatialGridBuildingVersion = -1;
  }
}
