import { WorldState } from './WorldState';
import { CommandQueue } from './commands';
import type { Entity, EntityId, PlayerId } from './types';
import { magnitude } from '../math';
import { executeCommand, type CommandContext } from './commandExecution';
import { distributeEnergy, createEnergyBuffers, resetEnergyBuffers, type EnergyBuffers } from './energyDistribution';
import {
  updateTargetingAndFiringState,
  updateTurretRotation,
  updateWeaponCooldowns,
  updateLaserSounds,
  emitLaserStopsForEntity,
  emitLaserStopsForTarget,
  updateForceFieldSounds,
  emitForceFieldStopsForEntity,
  fireWeapons,
  updateForceFieldState,
  applyForceFieldDamage,
  resetForceFieldBuffers,
  updateProjectiles,
  checkProjectileCollisions,
  type SimEvent,
  type DeathContext,
  type ProjectileSpawnEvent,
  type ProjectileDespawnEvent,
  type ProjectileVelocityUpdateEvent,
} from './combat';
import { DamageSystem } from './damage';
import { CombatStatsTracker, type CombatStatsSnapshot } from './CombatStatsTracker';
import { economyManager } from './economy';
import { ConstructionSystem } from './construction';
import { factoryProductionSystem } from './factoryProduction';
import { commanderAbilitiesSystem, type SprayTarget } from './commanderAbilities';
import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';

// Shared empty array constant (avoids per-call allocation for empty returns)
const EMPTY_VEL_UPDATES: ProjectileVelocityUpdateEvent[] = [];


export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private constructionSystem: ConstructionSystem;
  private damageSystem: DamageSystem;
  private forceAccumulator: ForceAccumulator = new ForceAccumulator();
  private combatStatsTracker: CombatStatsTracker;

  // Current spray targets for rendering (build/heal effects)
  private currentSprayTargets: SprayTarget[] = [];

  // Player IDs participating in this game
  private playerIds: PlayerId[] = [1, 2];

  // Track if game is over
  private gameOverWinnerId: PlayerId | null = null;

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
    this.combatStatsTracker = new CombatStatsTracker(world);
    this.damageSystem = new DamageSystem(world);
    this.damageSystem.statsTracker = this.combatStatsTracker;
  }

  // Set the player IDs for this game
  setPlayerIds(playerIds: PlayerId[]): void {
    this.playerIds = playerIds;
  }

  // Get the winner ID (null if game not over)
  getWinnerId(): PlayerId | null {
    return this.gameOverWinnerId;
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

  // Get combat stats snapshot for network broadcast
  getCombatStatsSnapshot(): CombatStatsSnapshot {
    return this.combatStatsTracker.getSnapshot();
  }

  // Get the combat stats tracker (for recording external events like background spawns)
  getCombatStatsTracker(): CombatStatsTracker {
    return this.combatStatsTracker;
  }

  // Run one simulation step with the given timestep
  update(dtMs: number): void {
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

    // Update economy (income, production)
    economyManager.update(dtMs);

    // Distribute energy equally among all active consumers (factories, construction, commander)
    distributeEnergy(this.world, dtMs, this.energyBuffers);

    // Check construction completion
    this.constructionSystem.update(this.world, dtMs);

    // Update factory production
    const productionResult = factoryProductionSystem.update(this.world, dtMs);
    // Record production stats and notify about newly spawned units (need physics bodies)
    if (productionResult.completedUnits.length > 0) {
      for (const unit of productionResult.completedUnits) {
        if (unit.unit?.unitType && unit.ownership) {
          this.combatStatsTracker.registerEntity(unit.id, unit.ownership.playerId, unit.unit.unitType);
          this.combatStatsTracker.recordUnitProduced(unit.ownership.playerId, unit.unit.unitType);
        }
      }
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
    // - addBeam() called on beam creation in fireWeapons()
    // - removeBeam() called on beam expiry/orphan in updateProjectiles/checkProjectileCollisions

    // Clear force accumulator for this frame
    this.forceAccumulator.clear();

    // Update all units movement (calculates target velocities)
    this.updateUnits();

    // Update spatial grid AFTER physics sync so grid cells match actual positions
    // (PERFORMANCE CRITICAL: O(1) per unit that didn't cross cell boundary)
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
    // Update unit positions (O(1) per unit that stayed in same cell)
    for (const unit of this.world.getUnits()) {
      spatialGrid.updateUnit(unit);
    }

    // Ensure buildings are tracked (addBuilding skips if already present)
    for (const building of this.world.getBuildings()) {
      if (building.building && building.building.hp > 0) {
        spatialGrid.addBuilding(building);
      }
    }

    // Update projectile positions (for force field spatial queries)
    for (const proj of this.world.getProjectiles()) {
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
      this.onGameOver?.(this.gameOverWinnerId);
    }
    // If no players remain (somehow), no winner
    else if (aliveCount === 0 && this.playerIds.length > 0) {
      // Draw or error state - just pick first player
      this.gameOverWinnerId = this.playerIds[0];
      this.onGameOver?.(this.gameOverWinnerId);
    }
  }

  // Update combat systems
  private updateCombat(dtMs: number): void {
    // Update weapon cooldowns + cache rotation sin/cos (merged into single loop)
    updateWeaponCooldowns(this.world, dtMs);

    // Update auto-targeting and firing state in a single pass
    updateTargetingAndFiringState(this.world);

    // Update laser sounds based on targeting state (every frame)
    const laserSimEvents = updateLaserSounds(this.world);
    for (const event of laserSimEvents) {
      this.onSimEvent?.(event);
      this.pendingSimEvents.push(event);
    }

    // Update force field sounds based on transition progress (every frame)
    const forceFieldSimEvents = updateForceFieldSounds(this.world.getForceFieldUnits());
    for (const event of forceFieldSimEvents) {
      this.onSimEvent?.(event);
      this.pendingSimEvents.push(event);
    }

    // Update turret rotation (before firing, so weapons fire in turret direction)
    updateTurretRotation(this.world, dtMs);

    // Fire weapons and create projectiles (with recoil force for projectiles)
    const fireResult = fireWeapons(this.world, dtMs, this.forceAccumulator);
    for (const proj of fireResult.projectiles) {
      this.world.addEntity(proj);
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
    updateForceFieldState(this.world, dtMs);

    // Apply force field damage (continuous AoE for force field units)
    // Pass force accumulator for force field pull effect
    const forceFieldVelocityUpdates = applyForceFieldDamage(this.world, dtMs, this.damageSystem, this.forceAccumulator, this.combatStatsTracker);
    for (const event of forceFieldVelocityUpdates) {
      this.pendingProjectileVelocityUpdates.set(event.id, event);
    }

    // Update projectile positions and remove orphaned beams (from dead units)
    const updateResult = updateProjectiles(this.world, dtMs, this.damageSystem);
    for (const id of updateResult.orphanedIds) {
      spatialGrid.removeProjectile(id);
      this.world.removeEntity(id);
    }
    for (const event of updateResult.despawnEvents) {
      spatialGrid.removeProjectile(event.id);
      this.pendingProjectileDespawns.push(event);
    }
    // Collect homing projectile velocity updates
    for (const event of updateResult.velocityUpdates) {
      this.pendingProjectileVelocityUpdates.set(event.id, event);
    }

    // Check projectile collisions and get dead units
    const collisionResult = checkProjectileCollisions(this.world, dtMs, this.damageSystem, this.forceAccumulator);

    // Collect projectile despawn events from collisions
    for (const event of collisionResult.despawnEvents) {
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
          if (entity.unit?.unitType && entity.ownership) {
            this.combatStatsTracker.recordUnitLost(entity.ownership.playerId, entity.unit.unitType);
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

    // Prune stale combat stats registry entries (rate-limited internally)
    this.combatStatsTracker.pruneRegistry();

    // Safety cleanup - remove any dead entities that slipped through
    this.cleanupDeadEntities();
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
          if (entity.unit?.unitType && entity.ownership) {
            this.combatStatsTracker.recordUnitLost(entity.ownership.playerId, entity.unit.unitType);
          }
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
        spatialGrid.removeBuilding(id);
      }
      this.onBuildingDeath?.(deadBuildingIds);
      for (const id of deadBuildingIds) {
        this.world.removeEntity(id);
      }
    }
  }

  // Update unit movement with action queue processing
  // velocityX/Y represents thrust direction - if 0, no thrust is applied and friction slows the unit
  private updateUnits(): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.unit || !entity.body) continue;

      const { unit, transform } = entity;

      // Default: no thrust (friction will slow the unit)
      unit.velocityX = 0;
      unit.velocityY = 0;

      // No actions - no thrust needed
      if (unit.actions.length === 0) {
        continue;
      }

      // Get current action
      const currentAction = unit.actions[0];

      // For build/repair actions, check if we're in range
      if (currentAction.type === 'build' || currentAction.type === 'repair') {
        const buildRange = entity.builder?.buildRange ?? 100;
        const dx = currentAction.x - transform.x;
        const dy = currentAction.y - transform.y;
        const distance = magnitude(dx, dy);

        // In range - no thrust needed
        if (distance <= buildRange) {
          continue;
        }

        // Thrust toward target
        unit.velocityX = (dx / distance) * unit.moveSpeed * this.world.thrustMultiplier;
        unit.velocityY = (dy / distance) * unit.moveSpeed * this.world.thrustMultiplier;
        continue;
      }

      // Check if unit should stop for combat (fight or patrol mode with majority of weapons engaged)
      if (currentAction.type === 'fight' || currentAction.type === 'patrol') {
        const weapons = entity.weapons;
        if (weapons && weapons.length > 0) {
          let engagedCount = 0;
          for (let i = 0; i < weapons.length; i++) {
            if (weapons[i].isEngaged) engagedCount++;
          }
          if (engagedCount > weapons.length / 2) {
            // Majority of weapons are engaged — stop and fight
            continue;
          }
        }
      }

      // Calculate direction to waypoint
      const dx = currentAction.x - transform.x;
      const dy = currentAction.y - transform.y;
      const distance = magnitude(dx, dy);

      // Close enough to waypoint - advance to next action, no thrust
      if (distance < 15) {
        this.advanceAction(entity);
        continue;
      }

      // Thrust toward waypoint
      unit.velocityX = (dx / distance) * unit.moveSpeed * this.world.thrustMultiplier;
      unit.velocityY = (dy / distance) * unit.moveSpeed * this.world.thrustMultiplier;
    }
  }

  // Get force accumulator for external force application (used by RtsScene)
  getForceAccumulator(): ForceAccumulator {
    return this.forceAccumulator;
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
  }

  // Reset all session state (call between game sessions to free stale references)
  resetSessionState(): void {
    this.forceAccumulator.reset();
    this.combatStatsTracker.reset();
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
  }
}
