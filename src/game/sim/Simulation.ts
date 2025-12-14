import { WorldState } from './WorldState';
import { CommandQueue, type Command, type MoveCommand, type SelectCommand, type StartBuildCommand, type QueueUnitCommand, type SetRallyPointCommand, type FireDGunCommand } from './commands';
import type { Entity, EntityId, Waypoint } from './types';
import {
  updateAutoTargeting,
  updateTurretRotation,
  updateWeaponCooldowns,
  updateLaserSounds,
  fireWeapons,
  updateProjectiles,
  checkProjectileCollisions,
  type AudioEvent,
} from './combat';
import { economyManager } from './economy';
import { ConstructionSystem } from './construction';
import { factoryProductionSystem } from './factoryProduction';
import { getWeaponConfig } from './weapons';
import { commanderAbilitiesSystem, type SprayTarget } from './commanderAbilities';

// Fixed simulation timestep (60 Hz)
export const FIXED_TIMESTEP = 1000 / 60;

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private accumulator: number = 0;
  private constructionSystem: ConstructionSystem;

  // Current spray targets for rendering (build/heal effects)
  private currentSprayTargets: SprayTarget[] = [];

  // Callback for when units die (to clean up physics bodies)
  public onUnitDeath?: (deadUnitIds: EntityId[]) => void;

  // Callback for when units are spawned (to create physics bodies)
  public onUnitSpawn?: (newUnits: Entity[]) => void;

  // Callback for when buildings are destroyed
  public onBuildingDeath?: (deadBuildingIds: EntityId[]) => void;

  // Callback for audio events
  public onAudioEvent?: (event: AudioEvent) => void;

  // Callback for game over
  public onGameOver?: (loserId: number) => void;

  constructor(world: WorldState, commandQueue: CommandQueue) {
    this.world = world;
    this.commandQueue = commandQueue;
    this.constructionSystem = new ConstructionSystem(world.mapWidth, world.mapHeight);
  }

  // Get construction system (for placement validation)
  getConstructionSystem(): ConstructionSystem {
    return this.constructionSystem;
  }

  // Get current spray targets for rendering
  getSprayTargets(): SprayTarget[] {
    return this.currentSprayTargets;
  }

  // Update simulation with variable delta time
  update(deltaMs: number): void {
    this.accumulator += deltaMs;

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
    // Notify about newly spawned units (need physics bodies)
    if (productionResult.completedUnits.length > 0 && this.onUnitSpawn) {
      this.onUnitSpawn(productionResult.completedUnits);
    }

    // Update commander auto-build and auto-heal
    const commanderResult = commanderAbilitiesSystem.update(this.world, dtMs);
    this.currentSprayTargets = commanderResult.sprayTargets;

    // Handle completed buildings - advance commander build queues
    for (const completed of commanderResult.completedBuildings) {
      this.advanceCommanderBuildQueue(completed.commanderId, completed.buildingId);
    }

    // Update all units movement
    this.updateUnits();

    // Sync transforms from Matter bodies
    this.syncTransformsFromBodies();

    // Update combat systems
    this.updateCombat(dtMs);

    // Check for game over (commander death)
    this.checkGameOver();

    this.world.incrementTick();
  }

  // Check if any commander died
  private checkGameOver(): void {
    if (!this.world.isCommanderAlive(1)) {
      this.onGameOver?.(1);
    }
    if (!this.world.isCommanderAlive(2)) {
      this.onGameOver?.(2);
    }
  }

  // Update combat systems
  private updateCombat(dtMs: number): void {
    // Update weapon cooldowns
    updateWeaponCooldowns(this.world, dtMs);

    // Update auto-targeting
    updateAutoTargeting(this.world);

    // Update laser sounds based on targeting state (every frame)
    const laserAudioEvents = updateLaserSounds(this.world);
    for (const event of laserAudioEvents) {
      this.onAudioEvent?.(event);
    }

    // Update turret rotation (before firing, so weapons fire in turret direction)
    updateTurretRotation(this.world, dtMs);

    // Fire weapons and create projectiles
    const fireResult = fireWeapons(this.world);
    for (const proj of fireResult.projectiles) {
      this.world.addEntity(proj);
    }

    // Emit fire audio events
    for (const event of fireResult.audioEvents) {
      this.onAudioEvent?.(event);
    }

    // Update projectile positions
    updateProjectiles(this.world, dtMs);

    // Check projectile collisions and get dead units
    const collisionResult = checkProjectileCollisions(this.world, dtMs);

    // Emit hit/death audio events
    for (const event of collisionResult.audioEvents) {
      this.onAudioEvent?.(event);
    }

    // Notify about dead units (for physics cleanup)
    if (collisionResult.deadUnitIds.length > 0 && this.onUnitDeath) {
      this.onUnitDeath(collisionResult.deadUnitIds);
    }

    // Notify about dead buildings (for cleanup)
    if (collisionResult.deadBuildingIds.length > 0 && this.onBuildingDeath) {
      this.onBuildingDeath(collisionResult.deadBuildingIds);
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
      case 'setRallyPoint':
        this.executeSetRallyPointCommand(command);
        break;
      case 'fireDGun':
        this.executeFireDGunCommand(command);
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

  // Execute move command with waypoint queue support
  private executeMoveCommand(command: MoveCommand): void {
    const units = command.entityIds
      .map((id) => this.world.getEntity(id))
      .filter((e): e is Entity => e !== undefined && e.type === 'unit');

    if (units.length === 0) return;

    // Handle individual targets (line move)
    if (command.individualTargets && command.individualTargets.length === units.length) {
      units.forEach((unit, index) => {
        if (!unit.unit) return;
        const target = command.individualTargets![index];
        const waypoint: Waypoint = {
          x: target.x,
          y: target.y,
          type: command.waypointType,
        };
        this.addWaypointToUnit(unit, waypoint, command.queue);
      });
    } else if (command.targetX !== undefined && command.targetY !== undefined) {
      // Group move with formation spreading
      const spacing = 40;
      const unitsPerRow = Math.ceil(Math.sqrt(units.length));

      units.forEach((unit, index) => {
        if (!unit.unit) return;

        // Grid formation offset
        const row = Math.floor(index / unitsPerRow);
        const col = index % unitsPerRow;
        const offsetX = (col - (unitsPerRow - 1) / 2) * spacing;
        const offsetY = (row - (units.length / unitsPerRow - 1) / 2) * spacing;

        const waypoint: Waypoint = {
          x: command.targetX! + offsetX,
          y: command.targetY! + offsetY,
          type: command.waypointType,
        };
        this.addWaypointToUnit(unit, waypoint, command.queue);
      });
    }
  }

  // Execute start build command
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

    // If not queuing, clear the existing build queue AND movement waypoints
    if (!command.queue) {
      builder.commander.buildQueue = [];
      builder.unit.waypoints = [];
      builder.unit.patrolLoopIndex = null;
    }

    // Add building to commander's build queue
    builder.commander.buildQueue.push(building.id);

    // If this is the first/only item in queue, start moving toward it
    if (builder.commander.buildQueue.length === 1) {
      this.moveCommanderToBuildTarget(builder, building);
    }
  }

  // Move commander toward a build target (close enough to be in build range)
  private moveCommanderToBuildTarget(commander: Entity, target: Entity): void {
    if (!commander.unit || !commander.builder) return;

    const buildRange = commander.builder.buildRange;
    const dx = target.transform.x - commander.transform.x;
    const dy = target.transform.y - commander.transform.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // If already in range, no need to move
    if (dist <= buildRange) return;

    // Calculate position just inside build range
    const moveDistance = dist - buildRange + 10; // Stop 10 units inside range
    const dirX = dx / dist;
    const dirY = dy / dist;

    const waypoint: Waypoint = {
      x: commander.transform.x + dirX * moveDistance,
      y: commander.transform.y + dirY * moveDistance,
      type: 'move',
    };
    this.addWaypointToUnit(commander, waypoint, false);
  }

  // Advance commander's build queue after a building completes
  private advanceCommanderBuildQueue(commanderId: EntityId, completedBuildingId: EntityId): void {
    const commander = this.world.getEntity(commanderId);
    if (!commander?.commander) return;

    const queue = commander.commander.buildQueue;

    // Remove the completed building from the queue
    const index = queue.indexOf(completedBuildingId);
    if (index !== -1) {
      queue.splice(index, 1);
    }

    // If there's a next building in queue, move toward it
    if (queue.length > 0) {
      const nextTarget = this.world.getEntity(queue[0]);
      if (nextTarget) {
        this.moveCommanderToBuildTarget(commander, nextTarget);
      }
    }
  }

  // Execute queue unit command
  private executeQueueUnitCommand(command: QueueUnitCommand): void {
    const factory = this.world.getEntity(command.factoryId);
    if (!factory?.factory) return;

    factoryProductionSystem.queueUnit(factory, command.weaponId);
  }

  // Execute set rally point command
  private executeSetRallyPointCommand(command: SetRallyPointCommand): void {
    const factory = this.world.getEntity(command.factoryId);
    if (!factory?.factory) return;

    factory.factory.rallyX = command.rallyX;
    factory.factory.rallyY = command.rallyY;
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
    const dist = Math.sqrt(dx * dx + dy * dy);

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

    // Face the target
    commander.transform.rotation = Math.atan2(dy, dx);

    // Emit audio event
    this.onAudioEvent?.({
      type: 'fire',
      x: commander.transform.x,
      y: commander.transform.y,
      weaponId: 'dgun',
    });
  }

  // Add a waypoint to a unit (respecting queue flag)
  private addWaypointToUnit(entity: Entity, waypoint: Waypoint, queue: boolean): void {
    if (!entity.unit) return;

    if (!queue) {
      // Replace all waypoints
      entity.unit.waypoints = [waypoint];
      entity.unit.patrolLoopIndex = null;
    } else {
      // Add to existing waypoints
      entity.unit.waypoints.push(waypoint);
    }

    // Update patrol loop index if this is a patrol waypoint
    if (waypoint.type === 'patrol' && entity.unit.patrolLoopIndex === null) {
      // Mark the start of patrol loop
      entity.unit.patrolLoopIndex = entity.unit.waypoints.length - 1;
    }
  }

  // Update unit movement with waypoint queue processing
  private updateUnits(): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.unit || !entity.body) continue;

      const { unit, body, transform } = entity;

      // No waypoints - stop moving
      if (unit.waypoints.length === 0) {
        if (body.matterBody) {
          (body.matterBody as MatterJS.BodyType).frictionAir = 0.1;
        }
        continue;
      }

      // Get current waypoint
      const currentWaypoint = unit.waypoints[0];

      // Check if unit should stop moving due to combat (fight or patrol mode)
      // Only stop when target is within WEAPON range (not just vision range)
      let canFireAtTarget = false;
      if (entity.weapon && entity.weapon.targetEntityId !== null) {
        const target = this.world.getEntity(entity.weapon.targetEntityId);
        if (target?.unit) {
          const dx = target.transform.x - entity.transform.x;
          const dy = target.transform.y - entity.transform.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const effectiveRange = entity.weapon.config.range + target.unit.radius;
          canFireAtTarget = dist <= effectiveRange;
        }
      }

      const shouldStopForCombat =
        (currentWaypoint.type === 'fight' || currentWaypoint.type === 'patrol') && canFireAtTarget;

      if (shouldStopForCombat) {
        // Stop moving - target is within weapon range
        unit.velocityX = 0;
        unit.velocityY = 0;
        continue;
      }

      // Calculate direction to current waypoint
      const dx = currentWaypoint.x - transform.x;
      const dy = currentWaypoint.y - transform.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // If close enough to waypoint, advance to next
      const stopThreshold = 5;
      if (distance < stopThreshold) {
        this.advanceWaypoint(entity);

        // Zero out velocity for this frame
        unit.velocityX = 0;
        unit.velocityY = 0;
        continue;
      }

      // Calculate velocity
      const speed = unit.moveSpeed;
      const vx = (dx / distance) * speed;
      const vy = (dy / distance) * speed;

      // Store velocity on unit for rendering and physics
      unit.velocityX = vx;
      unit.velocityY = vy;

      // Update body rotation to face movement direction
      transform.rotation = Math.atan2(dy, dx);
    }
  }

  // Advance to next waypoint (with patrol loop support)
  private advanceWaypoint(entity: Entity): void {
    if (!entity.unit) return;
    const unit = entity.unit;

    if (unit.waypoints.length === 0) return;

    const completedWaypoint = unit.waypoints[0];

    // Check if we're in patrol mode and should loop
    if (completedWaypoint.type === 'patrol' && unit.patrolLoopIndex !== null) {
      // Move completed patrol waypoint to end of queue (after all patrol waypoints)
      unit.waypoints.shift();
      unit.waypoints.push(completedWaypoint);
    } else {
      // Remove completed waypoint
      unit.waypoints.shift();

      // If we just finished the last non-patrol waypoint and hit patrol section
      if (unit.waypoints.length > 0 && unit.waypoints[0].type === 'patrol') {
        unit.patrolLoopIndex = 0;
      }
    }

    // Clear patrol loop index if no more waypoints
    if (unit.waypoints.length === 0) {
      unit.patrolLoopIndex = null;
    }
  }

  // Sync transforms from Matter.js bodies
  private syncTransformsFromBodies(): void {
    for (const entity of this.world.getAllEntities()) {
      if (entity.body?.matterBody) {
        entity.transform.x = entity.body.matterBody.position.x;
        entity.transform.y = entity.body.matterBody.position.y;
        // Don't sync rotation from physics - we control it manually
      }
    }
  }
}
