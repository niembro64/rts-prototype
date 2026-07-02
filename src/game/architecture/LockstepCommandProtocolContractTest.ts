import type {
  MoveCommand,
  PingCommand,
  SetPausedCommand,
  SetUnitGroundNormalEmaModeCommand,
  StopCommand,
} from '../sim/commands';
import { CommandQueue } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { sanitizeCommandForAuthoritativeServer } from '../server/commandSanitizer';
import {
  assignLockstepExecuteFrame,
  classifyCommandForArchitecture,
  createLockstepCommandEnvelope,
  enqueueLockstepCommandEnvelope,
  materializeLockstepCommandFrame,
  materializeLockstepCommand,
  validateLockstepCommandForPeer,
  validateLockstepCommandFrameForPeer,
  validateLockstepCommandEnvelope,
} from './LockstepCommandProtocol';

type SetConverterTaxCommand = Extract<import('../sim/commands').Command, { type: 'setConverterTax' }>;
type SetSlopePathModeCommand = Extract<import('../sim/commands').Command, { type: 'setSlopePathMode' }>;

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[lockstep command protocol contract] ${message}`);
  }
}

function assertThrows(fn: () => void, message: string): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assertContract(threw, message);
}

export function runLockstepCommandProtocolContractTest(): void {
  const world = new WorldState(1234, 128, 128);
  while (world.getTick() < 77) world.incrementTick();

  const stop: StopCommand = {
    type: 'stop',
    tick: 999,
    entityIds: [11],
  };
  const authoritative = sanitizeCommandForAuthoritativeServer(stop, world);
  assertContract(
    authoritative !== null && authoritative.tick === 77,
    'authoritative sanitizer must keep using world.getTick()',
  );

  const envelope = createLockstepCommandEnvelope({
    gameId: 'contract-game',
    currentKnownFrame: 100,
    inputDelayTicks: 6,
    playerId: 1 as PlayerId,
    playerSequence: 3,
    commandIndex: 0,
    clientIssuedFrame: 99,
    command: stop,
  });
  assertContract(
    envelope.executeFrame === 106 &&
      envelope.playerSequence === 3 &&
      envelope.commandIndex === 0 &&
      envelope.clientIssuedFrame === 99,
    'envelope must assign executeFrame from currentKnownFrame + inputDelayTicks',
  );

  const materialized = materializeLockstepCommand(envelope, world);
  assertContract(
    materialized !== null &&
      materialized.type === 'stop' &&
      materialized.tick === 106,
    'lockstep materialization must use envelope executeFrame instead of raw command.tick',
  );

  const secondRawTick: StopCommand = { ...stop, tick: 12 };
  const sameFrame = materializeLockstepCommand({
    ...envelope,
    command: secondRawTick,
  }, world);
  assertContract(
    sameFrame !== null && sameFrame.tick === envelope.executeFrame,
    'raw command ticks must not influence lockstep truth timing',
  );

  const reverseArrival = [
    {
      ...envelope,
      playerId: 2 as PlayerId,
      playerSequence: 1,
      commandIndex: 0,
      command: { ...stop, entityIds: [20] },
    },
    {
      ...envelope,
      playerId: 1 as PlayerId,
      playerSequence: 2,
      commandIndex: 1,
      command: { ...stop, entityIds: [12] },
    },
    {
      ...envelope,
      playerId: 1 as PlayerId,
      playerSequence: 2,
      commandIndex: 0,
      command: { ...stop, entityIds: [11] },
    },
  ];
  const frameCommands = materializeLockstepCommandFrame(reverseArrival, world);
  assertContract(
    frameCommands.map((command) => (command as StopCommand).entityIds[0]).join(',') === '11,12,20',
    'lockstep frame materialization must sort by player, sequence, and command index',
  );

  const queue = new CommandQueue();
  for (const frameCommand of reverseArrival) {
    enqueueLockstepCommandEnvelope(queue, frameCommand, world);
  }
  assertContract(
    queue.getCommandsForTick(envelope.executeFrame)
      .map((command) => (command as StopCommand).entityIds[0])
      .join(',') === '11,12,20',
    'CommandQueue must use explicit lockstep order keys, not arrival order',
  );

  const authoritativeQueue = new CommandQueue();
  authoritativeQueue.enqueue({ ...stop, tick: 5, entityIds: [1] });
  authoritativeQueue.enqueue({ ...stop, tick: 5, entityIds: [2] });
  assertContract(
    authoritativeQueue.getCommandsForTick(5)
      .map((command) => (command as StopCommand).entityIds[0])
      .join(',') === '1,2',
    'authoritative same-tick queue order must preserve enqueue order explicitly',
  );

  const playerOneUnit = world.createUnitFromBlueprint(32, 32, 1 as PlayerId, 'unitCommander');
  const playerTwoUnit = world.createUnitFromBlueprint(64, 32, 2 as PlayerId, 'unitCommander');
  world.addEntity(playerOneUnit);
  world.addEntity(playerTwoUnit);

  const validStopEnvelope = {
    ...envelope,
    playerId: 1 as PlayerId,
    playerSequence: 20,
    commandIndex: 0,
    command: {
      ...stop,
      entityIds: [playerOneUnit.id],
    },
  };
  const hostPlayerId = 1 as PlayerId;
  const accepted = validateLockstepCommandForPeer(validStopEnvelope, world, hostPlayerId);
  assertContract(
    accepted.accepted &&
      accepted.command.tick === envelope.executeFrame &&
      (accepted.command as StopCommand).entityIds[0] === playerOneUnit.id,
    'lockstep peer validation must accept owned gameplay commands on the envelope frame',
  );

  const rejections: string[] = [];
  const unauthorized = validateLockstepCommandForPeer({
    ...validStopEnvelope,
    playerSequence: 21,
    command: {
      ...stop,
      entityIds: [playerTwoUnit.id],
    },
  }, world, hostPlayerId, (rejection) => {
    rejections.push(`${rejection.reason}:${rejection.playerId}:${rejection.playerSequence}`);
  });
  assertContract(
    !unauthorized.accepted &&
      unauthorized.rejection.reason === 'authorization-rejected' &&
      rejections[0] === 'authorization-rejected:1:21',
    'lockstep rejected commands must log player id, sequence, and reason',
  );

  const sanitizerRejected = validateLockstepCommandForPeer({
    ...validStopEnvelope,
    playerSequence: 22,
    command: {
      ...stop,
      entityIds: [],
    },
  }, world, hostPlayerId);
  assertContract(
    !sanitizerRejected.accepted &&
      sanitizerRejected.rejection.reason === 'sanitizer-rejected',
    'lockstep validation must deterministically drop commands rejected by sanitizer',
  );

  const acceptedFrame = validateLockstepCommandFrameForPeer([
    {
      ...validStopEnvelope,
      playerSequence: 24,
      commandIndex: 0,
      command: { ...stop, entityIds: [playerOneUnit.id] },
    },
    {
      ...validStopEnvelope,
      playerSequence: 23,
      commandIndex: 0,
      command: { ...stop, entityIds: [playerTwoUnit.id] },
    },
  ], world, hostPlayerId);
  assertContract(
    acceptedFrame.length === 1 &&
      (acceptedFrame[0] as StopCommand).entityIds[0] === playerOneUnit.id,
    'frame validation must drop invalid commands while preserving deterministic accepted order',
  );

  const move: MoveCommand = {
    type: 'move',
    tick: 0,
    entityIds: [11],
    targetX: 32,
    targetY: 64,
    waypointType: 'move',
    queue: false,
  };
  assertContract(
    validateLockstepCommandEnvelope({
      ...envelope,
      command: move,
    }) === null,
    'gameplay commands must be valid lockstep command payloads',
  );

  const paused: SetPausedCommand = {
    type: 'setPaused',
    tick: 0,
    paused: true,
  };
  const unitGroundNormal: SetUnitGroundNormalEmaModeCommand = {
    type: 'setUnitGroundNormalEmaMode',
    tick: 0,
    mode: 'slow',
  };
  const converterTax: SetConverterTaxCommand = {
    type: 'setConverterTax',
    tick: 0,
    tax: 0.25,
  };
  assertContract(
    classifyCommandForArchitecture(paused) === 'architecture-control',
    'pause/resume must use architecture-control protocol',
  );
  assertContract(
    classifyCommandForArchitecture(unitGroundNormal) === 'gameplay-truth',
    'ground-normal EMA mode changes gameplay truth and must be frame-scheduled',
  );
  assertContract(
    classifyCommandForArchitecture(converterTax) === 'gameplay-truth',
    'converter tax changes gameplay truth and must be frame-scheduled',
  );

  const slopePathMode: SetSlopePathModeCommand = {
    type: 'setSlopePathMode',
    tick: 0,
    mode: 'directional',
  };
  assertContract(
    classifyCommandForArchitecture(slopePathMode) === 'gameplay-truth',
    'slope path mode changes pathfinding truth and must be frame-scheduled',
  );

  const ping: PingCommand = {
    type: 'ping',
    tick: 0,
    targetX: 32,
    targetY: 48,
  };
  assertContract(
    classifyCommandForArchitecture(ping) === 'gameplay-truth',
    'ping is team-shared and must frame-schedule so every peer sees the marker',
  );

  const nonHostPing = validateLockstepCommandForPeer({
    ...validStopEnvelope,
    playerId: 2 as PlayerId,
    playerSequence: 30,
    command: ping,
  }, world, hostPlayerId);
  assertContract(
    nonHostPing.accepted &&
      nonHostPing.command.type === 'ping' &&
      (nonHostPing.command as PingCommand).playerId === 2,
    'ping must stay any-player and stamp the envelope playerId for attribution',
  );

  const nonHostSetting = validateLockstepCommandForPeer({
    ...validStopEnvelope,
    playerId: 2 as PlayerId,
    playerSequence: 31,
    command: slopePathMode,
  }, world, hostPlayerId);
  assertContract(
    !nonHostSetting.accepted &&
      nonHostSetting.rejection.reason === 'authorization-rejected',
    'gameplay setting commands from non-host players must be rejected at validation',
  );

  const hostSetting = validateLockstepCommandForPeer({
    ...validStopEnvelope,
    playerId: hostPlayerId,
    playerSequence: 32,
    command: slopePathMode,
  }, world, hostPlayerId);
  assertContract(
    hostSetting.accepted &&
      hostSetting.command.type === 'setSlopePathMode' &&
      hostSetting.command.tick === validStopEnvelope.executeFrame,
    'gameplay setting commands from the host must schedule on the envelope frame',
  );
  assertThrows(
    () => createLockstepCommandEnvelope({
      gameId: 'contract-game',
      currentKnownFrame: 1,
      inputDelayTicks: 6,
      playerId: 1 as PlayerId,
      playerSequence: 5,
      commandIndex: 0,
      command: paused,
    }),
    'architecture-control commands must not be lockstep gameplay envelopes',
  );
  assertContract(
    createLockstepCommandEnvelope({
      gameId: 'contract-game',
      currentKnownFrame: 1,
      inputDelayTicks: 6,
      playerId: 1 as PlayerId,
      playerSequence: 7,
      commandIndex: 0,
      command: unitGroundNormal,
    }).executeFrame === 7,
    'gameplay-affecting setting changes must be valid scheduled lockstep commands',
  );
  assertContract(
    assignLockstepExecuteFrame(8, 4) === 12,
    'execute-frame helper must be deterministic',
  );
}
