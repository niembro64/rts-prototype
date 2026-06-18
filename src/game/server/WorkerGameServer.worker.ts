import { GameServer } from './GameServer';
import type { GameServerConfig } from '@/types/game';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { GameOverCallback } from './GameConnection';
import type { CommandAuthority } from './commandAuthority';
import type {
  WorkerGameServerClientMessage,
  WorkerGameServerCreatePayload,
  WorkerGameServerEventMessage,
} from './WorkerGameServerProtocol';
import type { LocalCommandAuthorityMode } from './LocalGameConnection';

type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<WorkerGameServerClientMessage>) => void,
  ): void;
};

const workerScope = self as unknown as WorkerScope;

let server: GameServer | null = null;
let snapshotListenerKey: string | null = null;
let gameOverListenerRef: GameOverCallback | null = null;
let commandPlayerId: PlayerId | undefined;
let filterPlayerId: PlayerId | undefined;
let commandAuthorityMode: LocalCommandAuthorityMode = 'player';

function post(message: WorkerGameServerEventMessage, transfer?: Transferable[]): void {
  workerScope.postMessage(message, transfer ?? []);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function postResponse(requestId: number, value?: unknown): void {
  post({ type: 'response', requestId, ok: true, value });
}

function postErrorResponse(requestId: number, error: unknown): void {
  post({ type: 'response', requestId, ok: false, error: errorMessage(error) });
}

function assertServer(): GameServer {
  if (server === null) throw new Error('worker game server is not created');
  return server;
}

function commandAuthority(): CommandAuthority {
  if (commandPlayerId === undefined) {
    return { mode: 'spectator', playerId: filterPlayerId };
  }
  return {
    mode: commandAuthorityMode,
    playerId: commandPlayerId,
  };
}

function removeSnapshotListener(): void {
  if (server === null || snapshotListenerKey === null) return;
  server.removeSnapshotListener(snapshotListenerKey);
  snapshotListenerKey = null;
}

function subscribeSnapshots(): void {
  const liveServer = assertServer();
  removeSnapshotListener();
  snapshotListenerKey = liveServer.addSnapshotListener((_state, _releaseSnapshot, wirePayload) => {
    if (wirePayload === undefined) return;
    // The Rust direct-wire path may return a view into WASM memory; copy
    // before transfer so the worker never detaches reusable encoder storage.
    const source = wirePayload.bytes;
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    post({ type: 'snapshot', bytes: copy.buffer }, [copy.buffer]);
  }, filterPlayerId, { preencodeWire: true });
}

function removeGameOverListener(): void {
  if (server === null || gameOverListenerRef === null) return;
  server.removeGameOverListener(gameOverListenerRef);
  gameOverListenerRef = null;
}

async function createServer(payload: WorkerGameServerCreatePayload): Promise<void> {
  stopServer();
  commandPlayerId = payload.localPlayerId;
  filterPlayerId = payload.localPlayerId;
  commandAuthorityMode = payload.commandAuthorityMode;
  server = await GameServer.create(
    payload.config as GameServerConfig,
    {
      onProgress: (progress, phase) => {
        post({ type: 'progress', progress, phase });
      },
    },
  );
  subscribeSnapshots();
  gameOverListenerRef = server.addGameOverListener((winnerId) => {
    post({ type: 'gameOver', winnerId });
  });
}

function startServer(): void {
  assertServer().start();
}

function stopServer(): void {
  removeSnapshotListener();
  removeGameOverListener();
  if (server === null) return;
  const stopping = server;
  server = null;
  stopping.stop();
}

function receiveCommand(command: Command): void {
  assertServer().receiveCommand(command, commandAuthority());
}

function receiveHostCommand(command: Command): void {
  assertServer().receiveCommand(command, { mode: 'host-admin' });
}

function markClientReady(): void {
  if (server === null || snapshotListenerKey === null) return;
  server.markSnapshotListenerReady(snapshotListenerKey);
}

function rebindRecipient(playerId: PlayerId | undefined, updateCommandPlayer: boolean): void {
  if (updateCommandPlayer) commandPlayerId = playerId;
  if (filterPlayerId === playerId) return;
  filterPlayerId = playerId;
  if (server === null) return;
  subscribeSnapshots();
  markClientReady();
}

async function handleRequest(message: WorkerGameServerClientMessage): Promise<void> {
  switch (message.type) {
    case 'create':
      await createServer(message.payload);
      postResponse(message.requestId);
      return;
    case 'start':
      startServer();
      postResponse(message.requestId);
      return;
    case 'stop':
      stopServer();
      postResponse(message.requestId);
      return;
    case 'exportReplay':
      postResponse(message.requestId, assertServer().exportReplay());
      return;
    default:
      return;
  }
}

workerScope.addEventListener('message', (event: MessageEvent<WorkerGameServerClientMessage>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case 'create':
      case 'start':
      case 'stop':
      case 'exportReplay':
        void handleRequest(message).catch((error) => postErrorResponse(message.requestId, error));
        return;
      case 'disconnect':
        stopServer();
        return;
      case 'sendCommand':
        receiveCommand(message.command);
        return;
      case 'sendHostCommand':
        receiveHostCommand(message.command);
        return;
      case 'markClientReady':
        markClientReady();
        return;
      case 'setRecipientPlayerId':
        rebindRecipient(message.playerId, true);
        return;
      case 'setSpectatorTarget':
        rebindRecipient(message.playerId, false);
        return;
      case 'setIpAddress':
        assertServer().setIpAddress(message.ipAddress);
        return;
    }
  } catch (error) {
    post({ type: 'error', error: errorMessage(error) });
  }
});
