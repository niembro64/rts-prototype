export type {
  CommandType,
  BaseCommand,
  SelectCommand,
  WaypointTarget,
  MoveCommand,
  ClearSelectionCommand,
  StartBuildCommand,
  QueueUnitCommand,
  CancelQueueItemCommand,
  SetRallyPointCommand,
  FactoryWaypoint,
  SetFactoryWaypointsCommand,
  FireDGunCommand,
  JumpCommand,
  RepairCommand,
  AttackCommand,
  SetSnapshotRateCommand,
  SetKeyframeRatioCommand,
  SetTickRateCommand,
  SetTiltEmaModeCommand,
  SetSendGridInfoCommand,
  SetBackgroundUnitTypeCommand,
  SetMaxTotalUnitsCommand,
  SetMirrorsEnabledCommand,
  SetForceFieldsEnabledCommand,
  SetCameraAoiCommand,
  Command,
} from '@/types/commands';

import type { Command } from '@/types/commands';

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
