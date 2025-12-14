import { WorldState } from './WorldState';
import { CommandQueue, type Command, type MoveCommand, type SelectCommand } from './commands';
import type { Entity } from './types';

// Fixed simulation timestep (60 Hz)
export const FIXED_TIMESTEP = 1000 / 60;

export class Simulation {
  private world: WorldState;
  private commandQueue: CommandQueue;
  private accumulator: number = 0;

  constructor(world: WorldState, commandQueue: CommandQueue) {
    this.world = world;
    this.commandQueue = commandQueue;
  }

  // Update simulation with variable delta time
  update(deltaMs: number): void {
    this.accumulator += deltaMs;

    // Process fixed timesteps
    while (this.accumulator >= FIXED_TIMESTEP) {
      this.fixedUpdate(FIXED_TIMESTEP / 1000);
      this.accumulator -= FIXED_TIMESTEP;
    }
  }

  // Fixed timestep update
  private fixedUpdate(dt: number): void {
    const tick = this.world.getTick();

    // Process commands for this tick
    const commands = this.commandQueue.getCommandsForTick(tick);
    for (const command of commands) {
      this.executeCommand(command);
    }

    // Update all units
    this.updateUnits(dt);

    // Sync transforms from Matter bodies
    this.syncTransformsFromBodies();

    this.world.incrementTick();
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
  private updateUnits(_dt: number): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.unit || !entity.body) continue;

      const { unit, body, transform } = entity;
      const { targetX, targetY } = unit;

      if (targetX === null || targetY === null) {
        // No target, apply friction through Matter's frictionAir
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

      // Update rotation to face movement direction
      transform.rotation = Math.atan2(dy, dx);
    }
  }

  // Sync transforms from Matter.js bodies
  private syncTransformsFromBodies(): void {
    for (const entity of this.world.getAllEntities()) {
      if (entity.body?.matterBody) {
        entity.transform.x = entity.body.matterBody.position.x;
        entity.transform.y = entity.body.matterBody.position.y;
        entity.transform.rotation = entity.body.matterBody.angle;
      }
    }
  }
}
