import { ARCHITECTURE_CONFIG } from '@/architectureConfig';
import type { Command, CommandQueue, CommandQueueLockstepOrder } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import { sanitizeCommandForScheduledFrame } from '../server/commandSanitizer';
import { authorizeGameServerGameplayCommand } from '../server/ServerCommandAuthorizer';

type CommandArchitectureCategory =
  | 'gameplay-truth'
  | 'local-presentation'
  | 'architecture-control';

export type LockstepCommandEnvelope = {
  readonly gameId: string;
  readonly executeFrame: number;
  readonly playerId: PlayerId;
  readonly playerSequence: number;
  readonly commandIndex: number;
  readonly command: Command;
  readonly clientIssuedFrame?: number;
};

type LockstepCommandEnvelopeOptions = {
  readonly gameId: string;
  readonly currentKnownFrame: number;
  readonly playerId: PlayerId;
  readonly playerSequence: number;
  readonly commandIndex?: number;
  readonly command: Command;
  readonly inputDelayTicks?: number;
  readonly clientIssuedFrame?: number;
};

export type LockstepCommandRejectionReason =
  | 'invalid-envelope'
  | 'sanitizer-rejected'
  | 'authorization-rejected';

export type LockstepCommandRejection = {
  readonly gameId: string | null;
  readonly executeFrame: number | null;
  readonly playerId: PlayerId | null;
  readonly playerSequence: number | null;
  readonly commandIndex: number | null;
  readonly commandType: string | null;
  readonly reason: LockstepCommandRejectionReason;
  readonly detail: string;
};

type LockstepCommandValidationResult =
  | {
      readonly accepted: true;
      readonly envelope: LockstepCommandEnvelope;
      readonly command: Command;
    }
  | {
      readonly accepted: false;
      readonly envelope: LockstepCommandEnvelope;
      readonly rejection: LockstepCommandRejection;
    };

type LockstepCommandRejectionLogger = (rejection: LockstepCommandRejection) => void;

const LOCAL_PRESENTATION_COMMAND_TYPES: ReadonlySet<Command['type']> = new Set([
  'select',
  'clearSelection',
  'ping',
  'setSendGridInfo',
  'setBackgroundUnitBlueprintEnabled',
  'setBackgroundBuildingBlueprintEnabled',
  'setBackgroundTowerBlueprintEnabled',
]);

const ARCHITECTURE_CONTROL_COMMAND_TYPES: ReadonlySet<Command['type']> = new Set([
  'setPaused',
]);

const LOCKSTEP_GAMEPLAY_SETTING_COMMAND_TYPES: ReadonlySet<Command['type']> = new Set([
  'setUnitGroundNormalEmaMode',
  'setMaxTotalUnits',
  'setTurretShieldPanelsEnabled',
  'setTurretShieldSpheresEnabled',
  'setForceFieldsVisible',
  'setShieldsObstructSight',
  'setShieldReflectionMode',
  'setFogOfWarEnabled',
  'setConverterTax',
]);

export function classifyCommandForArchitecture(command: Pick<Command, 'type'>): CommandArchitectureCategory {
  if (LOCAL_PRESENTATION_COMMAND_TYPES.has(command.type)) return 'local-presentation';
  if (ARCHITECTURE_CONTROL_COMMAND_TYPES.has(command.type)) return 'architecture-control';
  return 'gameplay-truth';
}

function isLockstepGameplayTruthCommand(command: Pick<Command, 'type'>): boolean {
  return classifyCommandForArchitecture(command) === 'gameplay-truth';
}

export function assignLockstepExecuteFrame(
  currentKnownFrame: number,
  inputDelayTicks: number = ARCHITECTURE_CONFIG.lockstep.inputDelayTicks,
): number {
  assertFrameInteger(currentKnownFrame, 'currentKnownFrame');
  assertFrameInteger(inputDelayTicks, 'inputDelayTicks');
  if (inputDelayTicks <= 0) {
    throw new Error('[lockstep command] inputDelayTicks must be positive');
  }
  const executeFrame = currentKnownFrame + inputDelayTicks;
  assertFrameInteger(executeFrame, 'executeFrame');
  return executeFrame;
}

export function createLockstepCommandEnvelope(
  options: LockstepCommandEnvelopeOptions,
): LockstepCommandEnvelope {
  assertGameId(options.gameId);
  assertFrameInteger(options.playerSequence, 'playerSequence');
  assertPlayerId(options.playerId);
  if (!isLockstepGameplayTruthCommand(options.command)) {
    throw new Error(
      `[lockstep command] ${options.command.type} is ${classifyCommandForArchitecture(options.command)} and must not be frame-scheduled`,
    );
  }
  const envelope: LockstepCommandEnvelope = {
    gameId: options.gameId,
    executeFrame: assignLockstepExecuteFrame(
      options.currentKnownFrame,
      options.inputDelayTicks,
    ),
    playerId: options.playerId,
    playerSequence: options.playerSequence,
    commandIndex: validateFrameInteger(options.commandIndex ?? 0, 'commandIndex'),
    command: options.command,
    ...(options.clientIssuedFrame !== undefined
      ? { clientIssuedFrame: validateFrameInteger(options.clientIssuedFrame, 'clientIssuedFrame') }
      : {}),
  };
  return envelope;
}

export function validateLockstepCommandEnvelope(envelope: LockstepCommandEnvelope): string | null {
  if (typeof envelope !== 'object' || envelope === null) return 'envelope must be an object';
  if (typeof envelope.gameId !== 'string' || envelope.gameId.length === 0) return 'gameId is required';
  if (!isFrameInteger(envelope.executeFrame)) return 'executeFrame must be a non-negative frame integer';
  if (!isPlayerId(envelope.playerId)) return 'playerId must be a valid player id';
  if (!isFrameInteger(envelope.playerSequence)) return 'playerSequence must be a non-negative integer';
  if (!isFrameInteger(envelope.commandIndex)) return 'commandIndex must be a non-negative integer';
  if (envelope.clientIssuedFrame !== undefined && !isFrameInteger(envelope.clientIssuedFrame)) {
    return 'clientIssuedFrame must be a non-negative frame integer when present';
  }
  if (!envelope.command || typeof envelope.command.type !== 'string') return 'command is required';
  if (!isLockstepGameplayTruthCommand(envelope.command)) {
    return `${envelope.command.type} is ${classifyCommandForArchitecture(envelope.command)} and is not lockstep gameplay truth`;
  }
  return null;
}

export function materializeLockstepCommand(
  envelope: LockstepCommandEnvelope,
  world: WorldState,
): Command | null {
  const invalidReason = validateLockstepCommandEnvelope(envelope);
  if (invalidReason !== null) {
    throw new Error(`[lockstep command] invalid envelope: ${invalidReason}`);
  }
  return sanitizeCommandForScheduledFrame(envelope.command, world, envelope.executeFrame);
}

export function materializeLockstepCommandFrame(
  envelopes: readonly LockstepCommandEnvelope[],
  world: WorldState,
): Command[] {
  const ordered = [...envelopes].sort(compareLockstepCommandEnvelopes);
  const commands: Command[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const command = materializeLockstepCommand(ordered[i], world);
    if (command !== null) commands.push(command);
  }
  return commands;
}

export function validateLockstepCommandForPeer(
  envelope: LockstepCommandEnvelope,
  world: WorldState,
  onRejected: LockstepCommandRejectionLogger | null = null,
): LockstepCommandValidationResult {
  const invalidReason = validateLockstepCommandEnvelope(envelope);
  if (invalidReason !== null) {
    return rejectLockstepCommand(envelope, 'invalid-envelope', invalidReason, onRejected);
  }

  const materialized = sanitizeCommandForScheduledFrame(envelope.command, world, envelope.executeFrame);
  if (materialized === null) {
    return rejectLockstepCommand(envelope, 'sanitizer-rejected', 'scheduled command failed sanitizer', onRejected);
  }

  const authorized = authorizeLockstepGameplayTruthCommand(world, materialized, envelope.playerId);
  if (authorized === null) {
    return rejectLockstepCommand(envelope, 'authorization-rejected', 'player is not authorized for command', onRejected);
  }

  return { accepted: true, envelope, command: authorized };
}

function authorizeLockstepGameplayTruthCommand(
  world: WorldState,
  command: Command,
  playerId: PlayerId,
): Command | null {
  if (LOCKSTEP_GAMEPLAY_SETTING_COMMAND_TYPES.has(command.type)) return command;
  return authorizeGameServerGameplayCommand(
    world,
    command,
    { mode: 'player', playerId },
  );
}

export function validateLockstepCommandFrameForPeer(
  envelopes: readonly LockstepCommandEnvelope[],
  world: WorldState,
  onRejected: LockstepCommandRejectionLogger | null = null,
): Command[] {
  const acceptedCommands: Command[] = [];
  const ordered = [...envelopes].sort(compareLockstepCommandEnvelopes);
  for (let i = 0; i < ordered.length; i++) {
    const result = validateLockstepCommandForPeer(ordered[i], world, onRejected);
    if (result.accepted) acceptedCommands.push(result.command);
  }
  return acceptedCommands;
}

export function enqueueLockstepCommandEnvelope(
  queue: CommandQueue,
  envelope: LockstepCommandEnvelope,
  world: WorldState,
): void {
  const command = materializeLockstepCommand(envelope, world);
  if (command === null) return;
  queue.enqueueLockstepCommand(command, lockstepOrderFromEnvelope(envelope));
}

export function compareLockstepCommandEnvelopes(
  a: LockstepCommandEnvelope,
  b: LockstepCommandEnvelope,
): number {
  if (a.executeFrame !== b.executeFrame) return a.executeFrame - b.executeFrame;
  if (a.playerId !== b.playerId) return a.playerId - b.playerId;
  if (a.playerSequence !== b.playerSequence) return a.playerSequence - b.playerSequence;
  return a.commandIndex - b.commandIndex;
}

function lockstepOrderFromEnvelope(envelope: LockstepCommandEnvelope): CommandQueueLockstepOrder {
  return {
    playerId: envelope.playerId,
    playerSequence: envelope.playerSequence,
    commandIndex: envelope.commandIndex,
  };
}

function rejectLockstepCommand(
  envelope: LockstepCommandEnvelope,
  reason: LockstepCommandRejectionReason,
  detail: string,
  onRejected: LockstepCommandRejectionLogger | null,
): LockstepCommandValidationResult {
  const rejection = buildLockstepCommandRejection(envelope, reason, detail);
  onRejected?.(rejection);
  return { accepted: false, envelope, rejection };
}

function buildLockstepCommandRejection(
  envelope: LockstepCommandEnvelope,
  reason: LockstepCommandRejectionReason,
  detail: string,
): LockstepCommandRejection {
  return {
    gameId: typeof envelope.gameId === 'string' ? envelope.gameId : null,
    executeFrame: isFrameInteger(envelope.executeFrame) ? envelope.executeFrame : null,
    playerId: isPlayerId(envelope.playerId) ? envelope.playerId : null,
    playerSequence: isFrameInteger(envelope.playerSequence) ? envelope.playerSequence : null,
    commandIndex: isFrameInteger(envelope.commandIndex) ? envelope.commandIndex : null,
    commandType: envelope.command && typeof envelope.command.type === 'string'
      ? envelope.command.type
      : null,
    reason,
    detail,
  };
}

function assertGameId(gameId: string): void {
  if (typeof gameId !== 'string' || gameId.length === 0) {
    throw new Error('[lockstep command] gameId is required');
  }
}

function assertPlayerId(playerId: PlayerId): void {
  if (!isPlayerId(playerId)) {
    throw new Error('[lockstep command] playerId must be a valid player id');
  }
}

function assertFrameInteger(value: number, label: string): void {
  validateFrameInteger(value, label);
}

function validateFrameInteger(value: number, label: string): number {
  if (!isFrameInteger(value)) {
    throw new Error(`[lockstep command] ${label} must be a non-negative frame integer`);
  }
  return value;
}

function isFrameInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0x7FFF_FFFF;
}

function isPlayerId(value: unknown): value is PlayerId {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xFFFF_FFFF;
}
