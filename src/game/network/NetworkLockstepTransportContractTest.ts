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
      hello.protocolVersion === LOCKSTEP_PROTOCOL_VERSION,
    'handshake must include the lockstep protocol version',
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

  sent.length = 0;
  assertContract(
    transport.broadcastCommandFrameBatch([
      { frame: 21, frameSequence: 21, commands: [createEnvelope(2, 2, 0, 21)] },
      { frame: 20, frameSequence: 20, commands: [] },
    ]),
    'coordinator must broadcast command-frame batches',
  );
  assertContract(sent.length === 2, 'command-frame batch must be sent to every peer connection');
  const firstBatch = sent[0]?.message;
  assertContract(
    firstBatch?.type === 'lockstepCommandFrameBatch' &&
      firstBatch.frames.length === 2 &&
      firstBatch.frames[0].frame === 20 &&
      firstBatch.frames[1].frame === 21,
    'batch broadcast must preserve canonical frame order and payloads',
  );
  sent.length = 0;
  assertContract(
    transport.resendCommandFrame(21, 2 as PlayerId),
    'frames sent in a batch must still be retained for targeted single-frame resend',
  );
  assertContract(
    sent.length === 1 &&
      sent[0].message.type === 'lockstepCommandFrame' &&
      sent[0].message.frame === 21,
    'batch-retained resend must use the existing single-frame resend protocol',
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
  assertContract(
    received.length === 2,
    'duplicate command frame must reach the callback so receivers can ack resends',
  );

  const lateCommand = {
    ...baseMessage(),
    type: 'lockstepCommand',
    envelope: inboundFrame.commands[0],
  } satisfies NetworkLockstepMessage;
  transport.handleMessage(lateCommand, 1 as PlayerId);
  assertContract(
    received.length === 2,
    'raw command already delivered by a command frame must be ignored idempotently',
  );
  const staleDifferentCommand = {
    ...baseMessage(),
    type: 'lockstepCommand',
    envelope: createEnvelope(1 as PlayerId, 2, 99, 31),
  } satisfies NetworkLockstepMessage;
  transport.handleMessage(staleDifferentCommand, 1 as PlayerId);
  assertContract(
    received.length === 2,
    'raw commands below the last accepted peer sequence must be ignored even when the payload differs',
  );

  const outOfOrderLater = createFrame(41, 41, [createEnvelope(1, 4, 0, 41)]);
  const outOfOrderEarlier = createFrame(40, 40, [createEnvelope(1, 5, 0, 40)]);
  transport.handleMessage(outOfOrderLater, 1 as PlayerId);
  transport.handleMessage(outOfOrderEarlier, 1 as PlayerId);
  assertContract(
    received.length === 4,
    'out-of-order command frames must be accepted for the scheduler to stall/order later',
  );

  const inboundBatch = {
    ...baseMessage(),
    type: 'lockstepCommandFrameBatch',
    coordinatorPlayerId: 1 as PlayerId,
    frames: [
      { frame: 51, frameSequence: 51, commands: [] },
      { frame: 50, frameSequence: 50, commands: [createEnvelope(2, 6, 0, 50), createEnvelope(1, 6, 0, 50)] },
    ],
  } satisfies NetworkLockstepMessage;
  transport.handleMessage(inboundBatch, 1 as PlayerId);
  assertContract(
    received.length === 5 &&
      received[4].message.type === 'lockstepCommandFrameBatch' &&
      received[4].message.frames[0].commands[0].playerId === 1,
    'inbound command-frame batches must be sorted and delivered once to the lockstep callback',
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

  transport.handleMessage({
    ...baseMessage(),
    type: 'lockstepAck',
    playerId: 2 as PlayerId,
    ackFrame: 950,
    ackFrameSequence: 950,
    receivedPeerSequences: [],
  }, 2 as PlayerId);
  transport.handleMessage({
    ...baseMessage(),
    type: 'lockstepAck',
    playerId: 3 as PlayerId,
    ackFrame: 950,
    ackFrameSequence: 950,
    receivedPeerSequences: [],
  }, 3 as PlayerId);
  assertContract(
    !transport.resendCommandFrame(12, 2 as PlayerId),
    'fully acknowledged command frames older than the resend retention window must be pruned',
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
  const rejectedCommunication: NetworkMessage = {
    type: 'communication',
    gameId: 'contract-game',
    data: {
      kind: 'chat',
      clientEventId: 'pressure-test',
      text: 'pressure test',
    },
  };
  assertContract(
    !budget.send(congestedConn, rejectedCommunication, () => {
      rawSendCount++;
      return true;
    }),
    'noncritical command-rate backpressure guard should still reject at the same buffered amount',
  );
  assertContract(rawSendCount === 1, 'rejected communication command must not reach raw send');

  const saturatedConn = createConnection(10, 2 * 1024 * 1024);
  assertContract(
    budget.send(saturatedConn, firstFrame, () => {
      rawSendCount++;
      return true;
    }),
    'lockstep command frames must bypass generic control backpressure because missing frames stall the simulation',
  );
  assertContract(rawSendCount === 2, 'saturated lockstep frame must still reach raw send');
}

function baseMessage() {
  return {
    gameId: 'contract-game',
    protocolVersion: LOCKSTEP_PROTOCOL_VERSION,
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
