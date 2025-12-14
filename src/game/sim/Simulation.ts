import { WorldState } from './WorldState';
import { CommandQueue, type Command, type MoveCommand, type SelectCommand } from './commands';
import type { Entity, EntityId } from './types';
import {
  updateAutoTargeting,
  updateWeaponCooldowns,
  fireWeapons,
  updateProjectiles,
  checkProjectileCollisions,
  type AudioEvent,
} from './combat';

// Fixed simulation timestep (60 Hz)
export const FIXED_TIMESTEP = 1000 / 60;

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private accumulator: number = 0;

  // Callback for when units die (to clean up physics bodies)
  public onUnitDeath?: (deadUnitIds: EntityId[]) => void;

  // Callback for audio events
  public onAudioEvent?: (event: AudioEvent) => void;

  constructor(world: WorldState, commandQueue: CommandQueue) {
    this.world = world;
    this.commandQueue = commandQueue;
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

    // Update all units movement
    this.updateUnits();

    // Sync transforms from Matter bodies
    this.syncTransformsFromBodies();

    // Update combat systems
    this.updateCombat(dtMs);

    this.world.incrementTick();
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
    const collisionResult = checkProjectileCollisions(this.world);

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
    }
  }

  // Execute select command
  private executeSelectCommand(command: SelectCommand): void {
    if (!command.additive) {
      this.world.clearSelection();
    }
    this.world.selectEntities(command.entityIds);
  }

  // Execute move command with formation spreading
  private executeMoveCommand(command: MoveCommand): void {
    const units = command.entityIds
      .map((id) => this.world.getEntity(id))
      .filter((e): e is Entity => e !== undefined && e.type === 'unit');

    if (units.length === 0) return;

    // Calculate formation offsets
    const spacing = 40; // Spacing between units
    const unitsPerRow = Math.ceil(Math.sqrt(units.length));

    units.forEach((unit, index) => {
      if (!unit.unit) return;

      // Grid formation offset
      const row = Math.floor(index / unitsPerRow);
      const col = index % unitsPerRow;
      const offsetX = (col - (unitsPerRow - 1) / 2) * spacing;
      const offsetY = (row - (units.length / unitsPerRow - 1) / 2) * spacing;

      unit.unit.targetX = command.targetX + offsetX;
      unit.unit.targetY = command.targetY + offsetY;
    });
  }

  // Update unit movement
  private updateUnits(): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.unit || !entity.body) continue;

      const { unit, body, transform } = entity;
      const { targetX, targetY } = unit;

      if (targetX === null || targetY === null) {
        // No movement target, apply friction through Matter's frictionAir
        if (body.matterBody) {
          (body.matterBody as MatterJS.BodyType).frictionAir = 0.1;
        }
        continue;
      }

      // Calculate direction to target
      const dx = targetX - transform.x;
      const dy = targetY - transform.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // If close enough, stop
      const stopThreshold = 5;
      if (distance < stopThreshold) {
        unit.targetX = null;
        unit.targetY = null;
        // Zero out velocity
        if (body.matterBody) {
          (entity as unknown as { velocityX: number; velocityY: number }).velocityX = 0;
          (entity as unknown as { velocityX: number; velocityY: number }).velocityY = 0;
        }
        continue;
      }

      // Calculate velocity
      const speed = unit.moveSpeed;
      const vx = (dx / distance) * speed;
      const vy = (dy / distance) * speed;

      // Store desired velocity for physics update
      (entity as unknown as { velocityX: number; velocityY: number }).velocityX = vx;
      (entity as unknown as { velocityX: number; velocityY: number }).velocityY = vy;

      // Update rotation to face movement direction (unless attacking)
      if (!entity.weapon?.targetEntityId) {
        transform.rotation = Math.atan2(dy, dx);
      }
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
