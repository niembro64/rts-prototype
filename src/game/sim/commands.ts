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
  SetTrajectoryModeCommand,
  SetCloakStateCommand,
  ClearSelectionCommand,
  PingCommand,
  ScanCommand,
  StartBuildCommand,
  UpgradeMetalExtractorCommand,
  UpgradeMetalExtractorAreaCommand,
  QueueUnitCommand,
  EditFactoryQueueCommand,
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
  CaptureCommand,
  ResurrectCommand,
  ResurrectAreaCommand,
  LoadTransportCommand,
  UnloadTransportCommand,
  WaitCommand,
  AttackCommand,
  AttackGroundCommand,
  AttackAreaCommand,
  ManualLaunchCommand,
  GuardCommand,
  SetPausedCommand,
  SetUnitGroundNormalEmaModeCommand,
  SetSendGridInfoCommand,
  SetBackgroundUnitBlueprintEnabledCommand,
  SetMaxTotalUnitsCommand,
  SetTurretShieldPanelsEnabledCommand,
  SetTurretShieldSpheresEnabledCommand,
  SetForceFieldsVisibleCommand,
  SetShieldsObstructSightCommand,
  SetShieldReflectionModeCommand,
  SetFogOfWarEnabledCommand,
  Command,
} from '@/types/commands';

import type { Command } from '@/types/commands';
import type { PlayerId } from './types';

export type CommandQueueLockstepOrder = {
  readonly playerId: PlayerId;
  readonly playerSequence: number;
  readonly commandIndex: number;
};

type QueuedCommandOrder =
  | {
      readonly kind: 'authoritative';
      readonly enqueueOrder: number;
    }
  | {
      readonly kind: 'lockstep';
      readonly playerId: PlayerId;
      readonly playerSequence: number;
      readonly commandIndex: number;
    };

type QueuedCommand = {
  readonly command: Command;
  readonly order: QueuedCommandOrder;
};

const AUTHORITATIVE_LOCKSTEP_SORT_SLOT = 0xFFFF_FFFF;

// Command queue for processing commands in order
export class CommandQueue {
  private commands: QueuedCommand[] = [];
  private nextEnqueueOrder = 0;

  // Add command to queue
  enqueue(command: Command): void {
    this.enqueueInternal(command, {
      kind: 'authoritative',
      enqueueOrder: this.nextEnqueueOrder++,
    });
  }

  enqueueLockstepCommand(command: Command, order: CommandQueueLockstepOrder): void {
    assertLockstepOrder(order);
    for (let i = 0; i < this.commands.length; i++) {
      const queued = this.commands[i];
      if (
        queued.command.tick === command.tick &&
        queued.order.kind === 'lockstep' &&
        queued.order.playerId === order.playerId &&
        queued.order.playerSequence === order.playerSequence &&
        queued.order.commandIndex === order.commandIndex
      ) {
        throw new Error(
          `[command queue] duplicate lockstep order key frame=${command.tick} ` +
            `player=${order.playerId} sequence=${order.playerSequence} index=${order.commandIndex}`,
        );
      }
    }
    this.enqueueInternal(command, {
      kind: 'lockstep',
      playerId: order.playerId,
      playerSequence: order.playerSequence,
      commandIndex: order.commandIndex,
    });
  }

  // Get commands for a specific tick
  getCommandsForTick(tick: number): Command[] {
    let count = 0;
    while (count < this.commands.length && this.commands[count].command.tick <= tick) count++;
    if (count === 0) return [];
    const result = new Array<Command>(count);
    for (let i = 0; i < count; i++) result[i] = this.commands[i].command;
    this.commands.splice(0, count);
    return result;
  }

  // Clear all commands
  clear(): void {
    this.commands = [];
    this.nextEnqueueOrder = 0;
  }

  // Get all pending commands
  getAll(): Command[] {
    const commands = new Array<Command>(this.commands.length);
    for (let i = 0; i < this.commands.length; i++) commands[i] = this.commands[i].command;
    return commands;
  }

  // Get pending command count
  getPendingCount(): number {
    return this.commands.length;
  }

  private enqueueInternal(command: Command, order: QueuedCommandOrder): void {
    const queued = { command, order };
    let lo = 0;
    let hi = this.commands.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareQueuedCommands(this.commands[mid], queued) <= 0) lo = mid + 1;
      else hi = mid;
    }
    this.commands.splice(lo, 0, queued);
  }
}

function compareQueuedCommands(a: QueuedCommand, b: QueuedCommand): number {
  if (a.command.tick !== b.command.tick) return a.command.tick - b.command.tick;
  const lockstepDelta = compareLockstepOrderSlots(a.order, b.order);
  if (lockstepDelta !== 0) return lockstepDelta;
  if (a.order.kind === 'authoritative' && b.order.kind === 'authoritative') {
    return a.order.enqueueOrder - b.order.enqueueOrder;
  }
  return 0;
}

function compareLockstepOrderSlots(a: QueuedCommandOrder, b: QueuedCommandOrder): number {
  const aPlayerId = a.kind === 'lockstep' ? a.playerId : AUTHORITATIVE_LOCKSTEP_SORT_SLOT;
  const bPlayerId = b.kind === 'lockstep' ? b.playerId : AUTHORITATIVE_LOCKSTEP_SORT_SLOT;
  if (aPlayerId !== bPlayerId) return aPlayerId - bPlayerId;

  const aSequence = a.kind === 'lockstep' ? a.playerSequence : AUTHORITATIVE_LOCKSTEP_SORT_SLOT;
  const bSequence = b.kind === 'lockstep' ? b.playerSequence : AUTHORITATIVE_LOCKSTEP_SORT_SLOT;
  if (aSequence !== bSequence) return aSequence - bSequence;

  const aIndex = a.kind === 'lockstep' ? a.commandIndex : AUTHORITATIVE_LOCKSTEP_SORT_SLOT;
  const bIndex = b.kind === 'lockstep' ? b.commandIndex : AUTHORITATIVE_LOCKSTEP_SORT_SLOT;
  return aIndex - bIndex;
}

function assertLockstepOrder(order: CommandQueueLockstepOrder): void {
  if (!isUint32(order.playerId) || !isUint31(order.playerSequence) || !isUint31(order.commandIndex)) {
    throw new Error('[command queue] invalid lockstep order key');
  }
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xFFFF_FFFF;
}

function isUint31(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0x7FFF_FFFF;
}
