import { WorldState } from './WorldState';
import { CommandQueue, type Command, type MoveCommand, type SelectCommand, type StartBuildCommand, type QueueUnitCommand, type SetRallyPointCommand, type FireDGunCommand } from './commands';
import type { Entity, EntityId, Waypoint } from './types';
import {
  updateAutoTargeting,
  updateTurretRotation,
  updateWeaponCooldowns,
  fireWeapons,
  updateProjectiles,
  checkProjectileCollisions,
  type AudioEvent,
} from './combat';
import { economyManager } from './economy';
import { ConstructionSystem } from './construction';
import { factoryProductionSystem } from './factoryProduction';
import { getWeaponConfig } from './weapons';

// Fixed simulation timestep (60 Hz)
export const FIXED_TIMESTEP = 1000 / 60;

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private accumulator: number = 0;
  private constructionSystem: ConstructionSystem;

  // Callback for when units die (to clean up physics bodies)
  public onUnitDeath?: (deadUnitIds: EntityId[]) => void;

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
    factoryProductionSystem.update(this.world, dtMs);
    // Note: completed units are added to world in factoryProductionSystem

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
    if (!builder?.builder || !builder.ownership) return;

    const playerId = builder.ownership.playerId;

    // Start the building
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

    // Move builder to building location if needed
    if (builder.unit) {
      const waypoint: Waypoint = {
        x: building.transform.x,
        y: building.transform.y,
        type: 'move',
      };
      this.addWaypointToUnit(builder, waypoint, false);
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
      const isInCombat = entity.weapon?.targetEntityId !== null;
      const shouldStopForCombat =
        (currentWaypoint.type === 'fight' || currentWaypoint.type === 'patrol') && isInCombat;

      if (shouldStopForCombat) {
        // Stop moving but stay at current waypoint
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
