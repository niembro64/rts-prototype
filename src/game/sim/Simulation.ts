import { WorldState } from './WorldState';
import { CommandQueue, type Command, type MoveCommand, type SelectCommand, type StartBuildCommand, type QueueUnitCommand, type CancelQueueItemCommand, type SetRallyPointCommand, type SetFactoryWaypointsCommand, type FireDGunCommand, type RepairCommand } from './commands';
import type { Entity, EntityId, PlayerId, UnitAction } from './types';
import { magnitude } from '../math';
import {
  updateTargetingAndFiringState,
  updateTurretRotation,
  updateWeaponCooldowns,
  updateLaserSounds,
  fireWeapons,
  updateForceFieldState,
  applyForceFieldDamage,
  updateProjectiles,
  checkProjectileCollisions,
  type AudioEvent,
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
import { getWeaponConfig } from './weapons';
import { commanderAbilitiesSystem, type SprayTarget } from './commanderAbilities';
import { ForceAccumulator } from './ForceAccumulator';
import { spatialGrid } from './SpatialGrid';

// Fixed simulation timestep (60 Hz)
export const FIXED_TIMESTEP = 1000 / 60;

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private accumulator: number = 0;
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

  // Pending audio events for network broadcast (cleared after each state serialization)
  private pendingAudioEvents: AudioEvent[] = [];

  // Pending projectile spawn/despawn/velocity-update events for network broadcast
  private pendingProjectileSpawns: ProjectileSpawnEvent[] = [];
  private pendingProjectileDespawns: ProjectileDespawnEvent[] = [];
  private pendingProjectileVelocityUpdates: ProjectileVelocityUpdateEvent[] = [];

  // Reusable buffers for cleanupDeadEntities (avoid per-tick allocations)
  private _deadUnitIdsBuf: EntityId[] = [];
  private _deadBuildingIdsBuf: EntityId[] = [];

  // Callback for when units die (to clean up physics bodies)
  // deathContexts contains info about the killing blow for directional explosions
  public onUnitDeath?: (deadUnitIds: EntityId[], deathContexts?: Map<EntityId, DeathContext>) => void;

  // Callback for when units are spawned (to create physics bodies)
  public onUnitSpawn?: (newUnits: Entity[]) => void;

  // Callback for when buildings are destroyed
  public onBuildingDeath?: (deadBuildingIds: EntityId[]) => void;

  // Callback for audio events
  public onAudioEvent?: (event: AudioEvent) => void;

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

  // Get and clear pending audio events (for network broadcast)
  getAndClearAudioEvents(): AudioEvent[] {
    const events = this.pendingAudioEvents;
    this.pendingAudioEvents = [];
    return events;
  }

  // Get and clear pending projectile spawn events (for network broadcast)
  getAndClearProjectileSpawns(): ProjectileSpawnEvent[] {
    const events = this.pendingProjectileSpawns;
    this.pendingProjectileSpawns = [];
    return events;
  }

  // Get and clear pending projectile despawn events (for network broadcast)
  getAndClearProjectileDespawns(): ProjectileDespawnEvent[] {
    const events = this.pendingProjectileDespawns;
    this.pendingProjectileDespawns = [];
    return events;
  }

  // Get and clear pending projectile velocity update events (for network broadcast)
  getAndClearProjectileVelocityUpdates(): ProjectileVelocityUpdateEvent[] {
    const events = this.pendingProjectileVelocityUpdates;
    this.pendingProjectileVelocityUpdates = [];
    return events;
  }

  // Get combat stats snapshot for network broadcast
  getCombatStatsSnapshot(): CombatStatsSnapshot {
    return this.combatStatsTracker.getSnapshot();
  }

  // Get the combat stats tracker (for recording external events like background spawns)
  getCombatStatsTracker(): CombatStatsTracker {
    return this.combatStatsTracker;
  }

  // Update simulation with variable delta time
  update(deltaMs: number): void {
    this.accumulator += deltaMs;

    // Cap accumulator to prevent runaway catch-up loops (max ~10 frames behind)
    const MAX_ACCUMULATOR = FIXED_TIMESTEP * 10;
    if (this.accumulator > MAX_ACCUMULATOR) {
      this.accumulator = MAX_ACCUMULATOR;
    }

    // Process fixed timesteps
    while (this.accumulator >= FIXED_TIMESTEP) {
      this.fixedUpdate(FIXED_TIMESTEP);
      this.accumulator -= FIXED_TIMESTEP;
    }
  }

  // Fixed timestep update
  private fixedUpdate(dtMs: number): void {
    const tick = this.world.getTick();

    // Process commands for this tick
    const commands = this.commandQueue.getCommandsForTick(tick);
    for (const command of commands) {
      this.executeCommand(command);
    }

    // Update economy (income, production)
    economyManager.update(dtMs);

    // Update construction progress
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

    // Update spatial grid incrementally (PERFORMANCE CRITICAL)
    // Units: O(1) per unit that didn't cross cell boundary
    // Buildings: only added on creation, removed on destruction (static)
    this.updateSpatialGrid();

    // Beam index is maintained incrementally:
    // - addBeam() called on beam creation in fireWeapons()
    // - removeBeam() called on beam expiry/orphan in updateProjectiles/checkProjectileCollisions

    // Clear force accumulator for this frame
    this.forceAccumulator.clear();

    // Update all units movement (calculates target velocities)
    this.updateUnits();

    // Sync transforms from Matter bodies
    this.syncTransformsFromBodies();

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
    const laserAudioEvents = updateLaserSounds(this.world);
    for (const event of laserAudioEvents) {
      this.onAudioEvent?.(event);
      this.pendingAudioEvents.push(event);
    }

    // Update turret rotation (before firing, so weapons fire in turret direction)
    updateTurretRotation(this.world, dtMs);

    // Fire weapons and create projectiles (with recoil force for projectiles)
    const fireResult = fireWeapons(this.world, this.forceAccumulator);
    for (const proj of fireResult.projectiles) {
      this.world.addEntity(proj);
    }

    // Collect projectile spawn events
    for (const event of fireResult.spawnEvents) {
      this.pendingProjectileSpawns.push(event);
    }

    // Emit fire audio events
    for (const event of fireResult.audioEvents) {
      this.onAudioEvent?.(event);
      this.pendingAudioEvents.push(event);
    }

    // Update force field state (range transitions)
    updateForceFieldState(this.world, dtMs);

    // Apply force field damage (continuous AoE for force field units)
    // Pass force accumulator for force field pull effect
    const forceFieldVelocityUpdates = applyForceFieldDamage(this.world, dtMs, this.damageSystem, this.forceAccumulator, this.combatStatsTracker);
    for (const event of forceFieldVelocityUpdates) {
      this.pendingProjectileVelocityUpdates.push(event);
    }

    // Update projectile positions and remove orphaned beams (from dead units)
    const updateResult = updateProjectiles(this.world, dtMs, this.damageSystem);
    for (const id of updateResult.orphanedIds) {
      this.world.removeEntity(id);
    }
    for (const event of updateResult.despawnEvents) {
      this.pendingProjectileDespawns.push(event);
    }

    // Check projectile collisions and get dead units
    const collisionResult = checkProjectileCollisions(this.world, dtMs, this.damageSystem, this.forceAccumulator);

    // Collect projectile despawn events from collisions
    for (const event of collisionResult.despawnEvents) {
      this.pendingProjectileDespawns.push(event);
    }

    // Emit hit/death audio events
    for (const event of collisionResult.audioEvents) {
      this.onAudioEvent?.(event);
      this.pendingAudioEvents.push(event);
    }

    // Remove dead entities from spatial grid and notify callbacks
    if (collisionResult.deadUnitIds.size > 0) {
      for (const id of collisionResult.deadUnitIds) {
        const entity = this.world.getEntity(id);
        if (entity?.unit?.unitType && entity.ownership) {
          this.combatStatsTracker.recordUnitLost(entity.ownership.playerId, entity.unit.unitType);
        }
        spatialGrid.removeUnit(id);
      }
      this.onUnitDeath?.([...collisionResult.deadUnitIds], collisionResult.deathContexts);
    }

    if (collisionResult.deadBuildingIds.size > 0) {
      for (const id of collisionResult.deadBuildingIds) {
        spatialGrid.removeBuilding(id);
      }
      this.onBuildingDeath?.([...collisionResult.deadBuildingIds]);
    }

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
        if (entity?.unit?.unitType && entity.ownership) {
          this.combatStatsTracker.recordUnitLost(entity.ownership.playerId, entity.unit.unitType);
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

  // Execute a command
  private executeCommand(command: Command): void {
    switch (command.type) {
      case 'select':
        this.executeSelectCommand(command);
        break;
      case 'move':
        this.executeMoveCommand(command);
        break;
      case 'clearSelection':
        this.world.clearSelection();
        break;
      case 'startBuild':
        this.executeStartBuildCommand(command);
        break;
      case 'queueUnit':
        this.executeQueueUnitCommand(command);
        break;
      case 'cancelQueueItem':
        this.executeCancelQueueItemCommand(command);
        break;
      case 'setRallyPoint':
        this.executeSetRallyPointCommand(command);
        break;
      case 'setFactoryWaypoints':
        this.executeSetFactoryWaypointsCommand(command);
        break;
      case 'fireDGun':
        this.executeFireDGunCommand(command);
        break;
      case 'repair':
        this.executeRepairCommand(command);
        break;
    }
  }

  // Execute select command
  private executeSelectCommand(command: SelectCommand): void {
    if (!command.additive) {
      this.world.clearSelection();
    }
    this.world.selectEntities(command.entityIds);
  }

  // Execute move command with action queue support
  private executeMoveCommand(command: MoveCommand): void {
    // Collect valid units without .map/.filter allocation
    const entityIds = command.entityIds;
    let unitCount = 0;

    // First pass: count valid units to size the iteration
    for (let i = 0; i < entityIds.length; i++) {
      const e = this.world.getEntity(entityIds[i]);
      if (e !== undefined && e.type === 'unit') unitCount++;
    }

    if (unitCount === 0) return;

    // Handle individual targets (line move)
    if (command.individualTargets && command.individualTargets.length === entityIds.length) {
      for (let i = 0; i < entityIds.length; i++) {
        const unit = this.world.getEntity(entityIds[i]);
        if (!unit || unit.type !== 'unit' || !unit.unit) continue;
        const target = command.individualTargets[i];
        const action: UnitAction = {
          type: command.waypointType,
          x: target.x,
          y: target.y,
        };
        this.addActionToUnit(unit, action, command.queue);
      }
    } else if (command.targetX !== undefined && command.targetY !== undefined) {
      // Group move with formation spreading
      const spacing = 40;
      const unitsPerRow = Math.ceil(Math.sqrt(unitCount));

      let index = 0;
      for (let i = 0; i < entityIds.length; i++) {
        const unit = this.world.getEntity(entityIds[i]);
        if (!unit || unit.type !== 'unit' || !unit.unit) continue;

        // Grid formation offset
        const row = Math.floor(index / unitsPerRow);
        const col = index % unitsPerRow;
        const offsetX = (col - (unitsPerRow - 1) / 2) * spacing;
        const offsetY = (row - (unitCount / unitsPerRow - 1) / 2) * spacing;

        const action: UnitAction = {
          type: command.waypointType,
          x: command.targetX! + offsetX,
          y: command.targetY! + offsetY,
        };
        this.addActionToUnit(unit, action, command.queue);
        index++;
      }
    }
  }

  // Execute start build command - adds build action to unit's action queue
  private executeStartBuildCommand(command: StartBuildCommand): void {
    const builder = this.world.getEntity(command.builderId);
    if (!builder?.builder || !builder.ownership || !builder.commander || !builder.unit) return;

    const playerId = builder.ownership.playerId;

    // Start the building (creates the ghost/under-construction building)
    const building = this.constructionSystem.startBuilding(
      this.world,
      command.buildingType,
      command.gridX,
      command.gridY,
      playerId,
      command.builderId
    );

    if (!building) {
      // Placement failed (invalid location)
      return;
    }

    // Create build action with building info
    const action: UnitAction = {
      type: 'build',
      x: building.transform.x,
      y: building.transform.y,
      buildingType: command.buildingType,
      gridX: command.gridX,
      gridY: command.gridY,
      buildingId: building.id,
    };

    this.addActionToUnit(builder, action, command.queue);
  }

  // Execute queue unit command
  private executeQueueUnitCommand(command: QueueUnitCommand): void {
    const factory = this.world.getEntity(command.factoryId);
    if (!factory?.factory) return;

    factoryProductionSystem.queueUnit(factory, command.weaponId);
  }

  // Execute cancel queue item command
  private executeCancelQueueItemCommand(command: CancelQueueItemCommand): void {
    const factory = this.world.getEntity(command.factoryId);
    if (!factory?.factory) return;

    factoryProductionSystem.dequeueUnit(factory, command.index);
  }

  // Execute set rally point command
  private executeSetRallyPointCommand(command: SetRallyPointCommand): void {
    const factory = this.world.getEntity(command.factoryId);
    if (!factory?.factory) return;

    factory.factory.rallyX = command.rallyX;
    factory.factory.rallyY = command.rallyY;
  }

  // Execute set factory waypoints command
  private executeSetFactoryWaypointsCommand(command: SetFactoryWaypointsCommand): void {
    const factory = this.world.getEntity(command.factoryId);
    if (!factory?.factory) return;

    if (command.queue) {
      // Add to existing waypoints
      for (const wp of command.waypoints) {
        factory.factory.waypoints.push({ x: wp.x, y: wp.y, type: wp.type });
      }
    } else {
      // Replace waypoints
      factory.factory.waypoints = command.waypoints.map(wp => ({ x: wp.x, y: wp.y, type: wp.type }));
    }

    // Update rally point to first waypoint
    if (command.waypoints.length > 0) {
      factory.factory.rallyX = command.waypoints[0].x;
      factory.factory.rallyY = command.waypoints[0].y;
    }
  }

  // Execute fire D-gun command
  private executeFireDGunCommand(command: FireDGunCommand): void {
    const commander = this.world.getEntity(command.commanderId);
    if (!commander?.commander || !commander.ownership) return;

    const playerId = commander.ownership.playerId;

    // Check if we have enough energy
    const dgunCost = commander.commander.dgunEnergyCost;
    if (!economyManager.canAfford(playerId, dgunCost)) {
      return;
    }

    // Spend energy
    economyManager.spendInstant(playerId, dgunCost);

    // Calculate direction to target
    const dx = command.targetX - commander.transform.x;
    const dy = command.targetY - commander.transform.y;
    const dist = magnitude(dx, dy);

    if (dist === 0) return;

    // Get D-gun weapon config
    const dgunConfig = getWeaponConfig('dgun');
    const speed = dgunConfig.projectileSpeed ?? 350;

    // Calculate velocity
    const velocityX = (dx / dist) * speed;
    const velocityY = (dy / dist) * speed;

    // Create D-gun projectile
    const projectile = this.world.createDGunProjectile(
      commander.transform.x,
      commander.transform.y,
      velocityX,
      velocityY,
      playerId,
      commander.id,
      dgunConfig
    );

    this.world.addEntity(projectile);

    // Emit projectile spawn event for D-gun
    this.pendingProjectileSpawns.push({
      id: projectile.id,
      x: commander.transform.x,
      y: commander.transform.y,
      rotation: Math.atan2(dy, dx),
      velocityX,
      velocityY,
      projectileType: 'traveling',
      weaponId: 'dgun',
      playerId,
      sourceEntityId: commander.id,
      weaponIndex: 0,
      isDGun: true,
    });

    // Face the target
    commander.transform.rotation = Math.atan2(dy, dx);

    // Emit audio event (dgun uses cannon sound)
    const dgunAudioEvent: AudioEvent = {
      type: 'fire',
      x: commander.transform.x,
      y: commander.transform.y,
      weaponId: 'cannon',
    };
    this.onAudioEvent?.(dgunAudioEvent);
    this.pendingAudioEvents.push(dgunAudioEvent);
  }

  // Execute repair command - adds repair action to unit's action queue
  private executeRepairCommand(command: RepairCommand): void {
    const commander = this.world.getEntity(command.commanderId);
    const target = this.world.getEntity(command.targetId);

    if (!commander?.commander || !commander.unit || !commander.builder) return;
    if (!target) return;

    // Target must be a buildable (incomplete building) or a damaged unit
    const isIncompleteBuilding = target.buildable && !target.buildable.isComplete && !target.buildable.isGhost;
    const isDamagedUnit = target.unit && target.unit.hp < target.unit.maxHp && target.unit.hp > 0;

    if (!isIncompleteBuilding && !isDamagedUnit) return;

    // Create repair action
    const action: UnitAction = {
      type: 'repair',
      x: target.transform.x,
      y: target.transform.y,
      targetId: command.targetId,
    };

    this.addActionToUnit(commander, action, command.queue);
  }

  // Add an action to a unit (respecting queue flag)
  private addActionToUnit(entity: Entity, action: UnitAction, queue: boolean): void {
    if (!entity.unit) return;

    if (!queue) {
      // Replace all actions
      entity.unit.actions = [action];
      entity.unit.patrolStartIndex = null;
    } else {
      // Add to existing actions
      entity.unit.actions.push(action);
    }

    // Update patrol start index if this is a patrol action
    if (action.type === 'patrol' && entity.unit.patrolStartIndex === null) {
      // Mark the start of patrol loop
      entity.unit.patrolStartIndex = entity.unit.actions.length - 1;
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

      // Check if unit should stop for combat (fight or patrol mode with majority of weapons firing)
      if (currentAction.type === 'fight' || currentAction.type === 'patrol') {
        const weapons = entity.weapons;
        if (weapons && weapons.length > 0) {
          let firingCount = 0;
          for (let i = 0; i < weapons.length; i++) {
            if (weapons[i].isFiring) firingCount++;
          }
          if (firingCount > weapons.length / 2) {
            // Majority of weapons are firing - stop and fight
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

  // Sync transforms from Matter.js bodies (rotation is handled in RtsScene after physics)
  private syncTransformsFromBodies(): void {
    for (const entity of this.world.getAllEntities()) {
      if (entity.body?.matterBody) {
        // Sync position from physics
        entity.transform.x = entity.body.matterBody.position.x;
        entity.transform.y = entity.body.matterBody.position.y;
      }
    }
  }
}
