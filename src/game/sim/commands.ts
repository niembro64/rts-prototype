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
} from '@/types/commands';

import type { Command } from '@/types/commands';

type QueuedCommand = {
  command: Command;
  sequence: number;
};

// Command queue for processing commands in deterministic local order.
//
// Migration note: the current host-snapshot architecture still drains
// commands with tick <= current tick so late network/UI commands remain
// playable. Lockstep must replace this with exact scheduled bundle
// execution once every peer sends per-tick command bundles.
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

  // Get commands for a specific tick
  getCommandsForTick(tick: number): Command[] {
    const result: Command[] = [];
    while (this.commands.length > 0 && this.commands[0].command.tick <= tick) {
      result.push(this.commands.shift()!.command);
    }
    return result;
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
}

function compareQueuedCommands(a: QueuedCommand, b: QueuedCommand): number {
  const tickDelta = a.command.tick - b.command.tick;
  return tickDelta !== 0 ? tickDelta : a.sequence - b.sequence;
}
