import type { EntityId } from './types';

// Command types
export type CommandType = 'select' | 'move' | 'clearSelection';

// Base command interface
interface BaseCommand {
  type: CommandType;
  tick: number; // Tick when command should be executed
}

// Select command - select entities within a rectangle
export interface SelectCommand extends BaseCommand {
  type: 'select';
  entityIds: EntityId[];
  additive: boolean; // Shift-click adds to selection
}

// Move command - move selected units to target
export interface MoveCommand extends BaseCommand {
  type: 'move';
  entityIds: EntityId[];
  targetX: number;
  targetY: number;
}

// Clear selection command
export interface ClearSelectionCommand extends BaseCommand {
  type: 'clearSelection';
}

// Union of all command types
export type Command = SelectCommand | MoveCommand | ClearSelectionCommand;

// Command queue for processing commands in order
export class CommandQueue {
  private commands: Command[] = [];

  // Add command to queue
  enqueue(command: Command): void {
    this.commands.push(command);
    // Sort by tick to ensure deterministic ordering
    this.commands.sort((a, b) => a.tick - b.tick);
  }

  // Get commands for a specific tick
  getCommandsForTick(tick: number): Command[] {
    const result: Command[] = [];
    while (this.commands.length > 0 && this.commands[0].tick <= tick) {
      result.push(this.commands.shift()!);
    }
    return result;
  }

  // Clear all commands
  clear(): void {
    this.commands = [];
  }

  // Get pending command count
  getPendingCount(): number {
    return this.commands.length;
  }
}
