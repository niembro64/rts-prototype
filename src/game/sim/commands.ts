export type {
  CommandType,
  BaseCommand,
  SelectCommand,
  WaypointTarget,
  MoveCommand,
  StopCommand,
  ClearQueuedOrdersCommand,
  RemoveLastQueuedOrderCommand,
  ClearSelectionCommand,
  PingCommand,
  ScanCommand,
  StartBuildCommand,
  QueueUnitCommand,
  CancelQueueItemCommand,
  SetRallyPointCommand,
  FactoryWaypoint,
  SetFactoryWaypointsCommand,
  FireDGunCommand,
  SetFireEnabledCommand,
  RepairCommand,
  RepairAreaCommand,
  ReclaimCommand,
  WaitCommand,
  AttackCommand,
  AttackGroundCommand,
  AttackAreaCommand,
  GuardCommand,
  SetSnapshotRateCommand,
  SetKeyframeRatioCommand,
  SetTickRateCommand,
  SetUnitGroundNormalEmaModeCommand,
  SetSendGridInfoCommand,
  SetBackgroundUnitTypeCommand,
  SetMaxTotalUnitsCommand,
  SetMirrorsEnabledCommand,
  SetForceFieldsEnabledCommand,
  SetForceFieldsObstructSightCommand,
  SetForceFieldReflectionModeCommand,
  SetFogOfWarEnabledCommand,
  Command,
} from '../../types/commands';

import type { Command } from '../../types/commands';

type QueuedCommand = {
  command: Command;
  sequence: number;
};

export type CommandQueueHashState = {
  nextSequence: number;
  commands: {
    sequence: number;
    command: Command;
  }[];
};

// Exact-tick command queue for deterministic execution.
// Late/missing bundle policy belongs to the lockstep scheduler; this queue only
// drains commands whose tick exactly matches the tick being simulated.
export class CommandQueue {
  private commands: QueuedCommand[] = [];
  private nextSequence = 0;

  // Add command to queue
  enqueue(command: Command): void {
    this.commands.push({
      command,
      sequence: this.nextSequence++,
    });
    this.commands.sort(compareQueuedCommands);
  }

  enqueueMany(commands: readonly Command[]): void {
    for (const command of commands) {
      this.commands.push({
        command,
        sequence: this.nextSequence++,
      });
    }
    this.commands.sort(compareQueuedCommands);
  }

  // Get commands scheduled exactly for a specific tick.
  getCommandsForTick(tick: number): Command[] {
    const result: Command[] = [];
    const remaining: QueuedCommand[] = [];
    for (const entry of this.commands) {
      if (entry.command.tick === tick) {
        result.push(entry.command);
      } else {
        remaining.push(entry);
      }
    }
    this.commands = remaining;
    return result;
  }

  dropCommandsBeforeTick(tick: number): Command[] {
    const dropped: Command[] = [];
    const remaining: QueuedCommand[] = [];
    for (const entry of this.commands) {
      if (entry.command.tick < tick) {
        dropped.push(entry.command);
      } else {
        remaining.push(entry);
      }
    }
    this.commands = remaining;
    return dropped;
  }

  // Clear all commands
  clear(): void {
    this.commands = [];
    this.nextSequence = 0;
  }

  // Get all pending commands
  getAll(): Command[] {
    return this.commands.map((entry) => entry.command);
  }

  // Get pending command count
  getPendingCount(): number {
    return this.commands.length;
  }

  getHashState(): CommandQueueHashState {
    return {
      nextSequence: this.nextSequence,
      commands: this.commands.map((entry) => ({
        sequence: entry.sequence,
        command: entry.command,
      })),
    };
  }
}

function compareQueuedCommands(a: QueuedCommand, b: QueuedCommand): number {
  const tickDelta = a.command.tick - b.command.tick;
  return tickDelta !== 0 ? tickDelta : a.sequence - b.sequence;
}
