import type { DataConnection } from 'peerjs';
import type { LockstepCommandEnvelope } from '../architecture/LockstepCommandProtocol';
import type { MoveCommand } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import {
  LOCKSTEP_PROTOCOL_VERSION,
  type LockstepCommandFrameMessage,
  type NetworkLockstepMessage,
  type NetworkMessage,
} from './NetworkTypes';
import { NetworkLockstepTransport } from './NetworkLockstepTransport';
import { NetworkSendBudget } from './NetworkSendBudget';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[network lockstep transport contract] ${message}`);
  }
}

export function runNetworkLockstepTransportContractTest(): void {
  const conn2 = createConnection(2);
  const conn3 = createConnection(3);
  const connections = new Map<PlayerId, DataConnection>([
    [2 as PlayerId, conn2],
    [3 as PlayerId, conn3],
  ]);
  const sent: Array<{ conn: DataConnection; message: NetworkMessage }> = [];
  const received: Array<{ message: NetworkLockstepMessage; fromPlayerId: PlayerId }> = [];
  const transport = new NetworkLockstepTransport({
    getGameId: () => 'contract-game',
    getHostConnection: () => undefined,
    getConnections: () => connections,
    getLocalPlayerId: () => 1 as PlayerId,
    isMessageForCurrentGame: (message) => message.gameId === 'contract-game',
    onMessage: (message, fromPlayerId) => {
      received.push({ message, fromPlayerId });
    },
    send: (conn, message) => {
      sent.push({ conn, message });
      return true;
    },
  });

  assertContract(transport.sendHello('init-hash', 0), 'hello must broadcast from the host/coordinator');
  const hello = sent[0]?.message;
  assertContract(
    hello?.type === 'lockstepHello' &&
      hello.protocolVersion === LOCKSTEP_PROTOCOL_VERSION &&
      hello.architecture === 'deterministic-lockstep',
    'handshake must include protocol version and deterministic-lockstep architecture',
  );
  sent.length = 0;

  const envA = createEnvelope(1, 1, 0, 12);
  const envB = createEnvelope(2, 1, 0, 12);
  assertContract(
    transport.broadcastCommandFrame(12, 4, [envB, envA]),
    'coordinator must broadcast command frames',
  );
  assertContract(sent.length === 2, 'command frame must be sent to every peer connection');
  const firstFrame = sent[0]?.message;
  const secondFrame = sent[1]?.message;
  assertContract(
    firstFrame?.type === 'lockstepCommandFrame' &&
      secondFrame?.type === 'lockstepCommandFrame' &&
      JSON.stringify(firstFrame.commands) === JSON.stringify(secondFrame.commands),
    'all peers must receive identical command-frame contents',
  );
  if (firstFrame?.type !== 'lockstepCommandFrame') {
    throw new Error('[network lockstep transport contract] expected command-frame message');
  }
  assertContract(
    firstFrame.coordinatorPlayerId === 1 &&
      firstFrame.frameSequence === 4 &&
      firstFrame.commands[0] === envA &&
      firstFrame.commands[1] === envB,
    'coordinator command frames must be canonically ordered',
  );

  sent.length = 0;
  assertContract(transport.resendCommandFrame(12, 2 as PlayerId), 'stored frame must resend by frame');
  assertContract(
    sent.length === 1 && sent[0].conn === conn2 && sent[0].message === firstFrame,
    'single-frame resend must target the requested player',
  );
  sent.length = 0;
  transport.broadcastCommandFrame(13, 5, [createEnvelope(1, 2, 0, 13)]);
  sent.length = 0;
  assertContract(
    transport.resendCommandFramesAfter(11, 2 as PlayerId, 8) === 2,
    'ack-gap resend must replay stored frames after the acknowledged frame',
  );

  received.length = 0;
  const inboundFrame = createFrame(30, 30, [
    createEnvelope(2, 3, 0, 30),
    createEnvelope(1, 3, 0, 30),
  ]);
  assertContract(transport.handleMessage(inboundFrame, 1 as PlayerId), 'lockstep frames must be consumed');
  assertContract(received.length === 1, 'first command frame must reach the lockstep callback');
  assertContract(
    received[0].message.type === 'lockstepCommandFrame' &&
      received[0].message.commands[0].playerId === 1,
    'received command frame must be sorted before callback',
  );
  transport.handleMessage(inboundFrame, 1 as PlayerId);
  assertContract(received.length === 1, 'duplicate command frame must be ignored idempotently');

  const lateCommand = {
    ...baseMessage(),
    type: 'lockstepCommand',
    envelope: inboundFrame.commands[0],
  } satisfies NetworkLockstepMessage;
  transport.handleMessage(lateCommand, 1 as PlayerId);
  assertContract(
    received.length === 1,
    'raw command already delivered by a command frame must be ignored idempotently',
  );

  const outOfOrderLater = createFrame(41, 41, [createEnvelope(1, 4, 0, 41)]);
  const outOfOrderEarlier = createFrame(40, 40, [createEnvelope(1, 5, 0, 40)]);
  transport.handleMessage(outOfOrderLater, 1 as PlayerId);
  transport.handleMessage(outOfOrderEarlier, 1 as PlayerId);
  assertContract(
    received.length === 3,
    'out-of-order command frames must be accepted for the scheduler to stall/order later',
  );

  const ack = {
    ...baseMessage(),
    type: 'lockstepAck',
    playerId: 2 as PlayerId,
    ackFrame: 12,
    ackFrameSequence: 4,
    receivedPeerSequences: [{ playerId: 1 as PlayerId, lastPlayerSequence: 3 }],
  } satisfies NetworkLockstepMessage;
  transport.handleMessage(ack, 2 as PlayerId);
  assertContract(
    transport.latestAckForPlayer(2 as PlayerId) === ack,
    'latest ack must be retained for coordinator resend decisions',
  );

  const budget = new NetworkSendBudget();
  const congestedConn = createConnection(9, 700 * 1024);
  let rawSendCount = 0;
  assertContract(
    budget.send(congestedConn, firstFrame, () => {
      rawSendCount++;
      return true;
    }),
    'lockstep command frames must not be rejected by command/snapshot backpressure',
  );
  assertContract(rawSendCount === 1, 'lockstep command frame must use raw send under moderate pressure');
  const rejectedCommand: NetworkMessage = {
    type: 'command',
    gameId: 'contract-game',
    data: createMoveCommand(12),
  };
  assertContract(
    !budget.send(congestedConn, rejectedCommand, () => {
      rawSendCount++;
      return true;
    }),
    'legacy command backpressure guard should still reject at the same buffered amount',
  );
  assertContract(rawSendCount === 1, 'rejected legacy command must not reach raw send');
}

function baseMessage() {
  return {
    gameId: 'contract-game',
    protocolVersion: LOCKSTEP_PROTOCOL_VERSION,
    architecture: 'deterministic-lockstep' as const,
  };
}

function createFrame(
  frame: number,
  frameSequence: number,
  commands: LockstepCommandEnvelope[],
): LockstepCommandFrameMessage {
  return {
    ...baseMessage(),
    type: 'lockstepCommandFrame',
    coordinatorPlayerId: 1 as PlayerId,
    frame,
    frameSequence,
    commands,
  };
}

function createEnvelope(
  playerId: PlayerId,
  playerSequence: number,
  commandIndex: number,
  executeFrame: number,
): LockstepCommandEnvelope {
  return {
    gameId: 'contract-game',
    executeFrame,
    playerId,
    playerSequence,
    commandIndex,
    command: createMoveCommand(executeFrame),
  };
}

function createMoveCommand(tick: number): MoveCommand {
  return {
    type: 'move',
    tick,
    entityIds: [7],
    targetX: 42,
    targetY: 84,
    waypointType: 'move',
    queue: false,
  };
}

function createConnection(playerId: PlayerId, bufferedAmount = 0): DataConnection {
  return {
    open: true,
    peer: `player-${playerId}`,
    dataChannel: {
      bufferedAmount,
      readyState: 'open',
    },
  } as unknown as DataConnection;
}
