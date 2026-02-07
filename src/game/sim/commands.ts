import type { EntityId, WaypointType, BuildingType } from './types';

// Command types
export type CommandType = 'select' | 'move' | 'clearSelection' | 'startBuild' | 'queueUnit' | 'cancelQueueItem' | 'setRallyPoint' | 'setFactoryWaypoints' | 'fireDGun' | 'repair';

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

// Waypoint target for move commands
export interface WaypointTarget {
  x: number;
  y: number;
}

// Move command - move selected units to target(s)
export interface MoveCommand extends BaseCommand {
  type: 'move';
  entityIds: EntityId[];
  // Single target for group move
  targetX?: number;
  targetY?: number;
  // Individual targets for line move (one per entity, same order as entityIds)
  individualTargets?: WaypointTarget[];
  // Waypoint type (move, fight, patrol)
  waypointType: WaypointType;
  // Whether to add to existing waypoints (shift-queue) or replace
  queue: boolean;
}

// Clear selection command
export interface ClearSelectionCommand extends BaseCommand {
  type: 'clearSelection';
}

// Start build command - commander builds a structure
export interface StartBuildCommand extends BaseCommand {
  type: 'startBuild';
  builderId: EntityId;
  buildingType: BuildingType;
  gridX: number;
  gridY: number;
  queue: boolean; // Whether to add to build queue (shift) or replace
}

// Queue unit command - add unit to factory production queue
export interface QueueUnitCommand extends BaseCommand {
  type: 'queueUnit';
  factoryId: EntityId;
  weaponId: string;
}

// Cancel queue item command - remove unit from factory production queue
export interface CancelQueueItemCommand extends BaseCommand {
  type: 'cancelQueueItem';
  factoryId: EntityId;
  index: number;
}

// Set rally point command - set factory rally point
export interface SetRallyPointCommand extends BaseCommand {
  type: 'setRallyPoint';
  factoryId: EntityId;
  rallyX: number;
  rallyY: number;
}

// Factory waypoint for waypoint commands
export interface FactoryWaypoint {
  x: number;
  y: number;
  type: WaypointType;
}

// Set factory waypoints command - set factory waypoints (replaces or adds to existing)
export interface SetFactoryWaypointsCommand extends BaseCommand {
  type: 'setFactoryWaypoints';
  factoryId: EntityId;
  waypoints: FactoryWaypoint[];
  queue: boolean; // Whether to add to existing waypoints or replace
}

// Fire D-gun command - commander fires D-gun at target
export interface FireDGunCommand extends BaseCommand {
  type: 'fireDGun';
  commanderId: EntityId;
  targetX: number;
  targetY: number;
}

// Repair command - commander repairs/builds a specific entity
export interface RepairCommand extends BaseCommand {
  type: 'repair';
  commanderId: EntityId;
  targetId: EntityId;
  queue: boolean; // Whether to add to build queue (shift) or replace
}

// Union of all command types
export type Command = SelectCommand | MoveCommand | ClearSelectionCommand | StartBuildCommand | QueueUnitCommand | CancelQueueItemCommand | SetRallyPointCommand | SetFactoryWaypointsCommand | FireDGunCommand | RepairCommand;

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

  // Get all pending commands
  getAll(): Command[] {
    return [...this.commands];
  }

  // Get pending command count
  getPendingCount(): number {
    return this.commands.length;
  }
}
