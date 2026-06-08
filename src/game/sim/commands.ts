export type {
  CommandType,
  BaseCommand,
  SelectCommand,
  WaypointTarget,
  MoveCommand,
  StopCommand,
  ClearQueuedOrdersCommand,
  RemoveLastQueuedOrderCommand,
  SkipCurrentOrderCommand,
  SetRepeatQueueCommand,
  SetUnitMoveStateCommand,
  ClearSelectionCommand,
  PingCommand,
  ScanCommand,
  StartBuildCommand,
  QueueUnitCommand,
  StopFactoryProductionCommand,
  SetRallyPointCommand,
  SetFactoryGuardCommand,
  FireDGunCommand,
  SetFireEnabledCommand,
  SetBuildingActiveCommand,
  SelfDestructCommand,
  SetTowerTargetCommand,
  RepairCommand,
  RepairAreaCommand,
  ReclaimCommand,
  ReclaimAreaCommand,
  WaitCommand,
  AttackCommand,
  AttackGroundCommand,
  AttackAreaCommand,
  GuardCommand,
  SetSnapshotRateCommand,
  SetKeyframeRatioCommand,
  SetTickRateCommand,
  SetPausedCommand,
  SetUnitGroundNormalEmaModeCommand,
  SetSendGridInfoCommand,
  SetBackgroundUnitBlueprintEnabledCommand,
  SetMaxTotalUnitsCommand,
  SetTurretShieldPanelsEnabledCommand,
  SetTurretShieldSpheresEnabledCommand,
  SetShieldsObstructSightCommand,
  SetShieldReflectionModeCommand,
  SetFogOfWarEnabledCommand,
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
