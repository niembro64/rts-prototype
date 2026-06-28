import type {
  GameConnection,
  GameOverCallback,
  SimEventCallback,
  SnapshotCallback,
  SnapshotUnsubscribe,
} from './GameConnection';
import type { Command } from '../sim/commands';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import type { PlayerId } from '../sim/types';
import type { GameServerConfig } from '@/types/game';
import { decodeNetworkSnapshot } from '../network/snapshotWireCodec';
import { setSnapshotWireBytes } from '../network/snapshotWireMetadata';
import type { BudgetReplayFile } from './ReplayRecorder';
import type { LocalCommandAuthorityMode } from './LocalGameConnection';
import type {
  WorkerGameServerClientMessage,
  WorkerGameServerCreatePayload,
  WorkerGameServerEventMessage,
  WorkerGameServerExportReplayResponse,
} from './WorkerGameServerProtocol';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type WorkerGameServerConnectionCreateOptions = {
  readonly config: GameServerConfig;
  readonly localPlayerId: PlayerId | undefined;
  readonly commandAuthorityMode?: LocalCommandAuthorityMode;
  readonly onProgress?: (progress: number, phase?: string) => void | Promise<void>;
};

export class WorkerGameServerConnection implements GameConnection {
  readonly sharesAuthoritativeState = false;

  private readonly worker: Worker;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly onProgress: ((progress: number, phase?: string) => void | Promise<void>) | undefined;
  private snapshotCallback: SnapshotCallback | null = null;
  private gameOverCallback: GameOverCallback | null = null;
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private nextRequestId = 1;
  private disconnected = false;
  private snapshotsDecoded = 0;

  static async create(
    options: WorkerGameServerConnectionCreateOptions,
  ): Promise<WorkerGameServerConnection> {
    const worker = new Worker(new URL('./WorkerGameServer.worker.ts', import.meta.url), {
      type: 'module',
      name: 'budget-annihilation-server',
    });
    const connection = new WorkerGameServerConnection(worker, options.onProgress);
    const payload: WorkerGameServerCreatePayload = {
      config: options.config,
      localPlayerId: options.localPlayerId,
      commandAuthorityMode: options.commandAuthorityMode ?? 'player',
    };
    await connection.request({ type: 'create', requestId: 0, payload });
    return connection;
  }

  private constructor(
    worker: Worker,
    onProgress: WorkerGameServerConnectionCreateOptions['onProgress'],
  ) {
    this.worker = worker;
    this.onProgress = onProgress;
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleWorkerMessageError);
  }

  startServer(): Promise<void> {
    return this.request({ type: 'start', requestId: 0 }).then(() => undefined);
  }

  stopServer(): Promise<void> {
    return this.request({ type: 'stop', requestId: 0 }).then(() => undefined);
  }

  exportReplay(): Promise<BudgetReplayFile> {
    return this.request({ type: 'exportReplay', requestId: 0 })
      .then((value) => value as WorkerGameServerExportReplayResponse);
  }

  sendHostCommand(command: Command): void {
    this.post({ type: 'sendHostCommand', command });
  }

  setIpAddress(ipAddress: string): void {
    this.post({ type: 'setIpAddress', ipAddress });
  }

  getDiagnostics(): { readonly snapshotsDecoded: number; readonly pendingRequests: number } {
    return {
      snapshotsDecoded: this.snapshotsDecoded,
      pendingRequests: this.pendingRequests.size,
    };
  }

  sendCommand(command: Command): void {
    this.post({ type: 'sendCommand', command });
  }

  markClientReady(): void {
    this.post({ type: 'markClientReady' });
  }

  onSnapshot(callback: SnapshotCallback): SnapshotUnsubscribe {
    this.snapshotCallback = callback;
    if (this.pendingSnapshot !== null) {
      const pending = this.pendingSnapshot;
      this.pendingSnapshot = null;
      callback(pending);
    }
    return () => {
      if (this.snapshotCallback === callback) this.snapshotCallback = null;
    };
  }

  clearSnapshotCallback(): void {
    this.snapshotCallback = null;
  }

  onSimEvent(_callback: SimEventCallback): void {
    // Local worker snapshots carry visual/audio one-shot events.
  }

  onGameOver(callback: GameOverCallback): void {
    this.gameOverCallback = callback;
  }

  setRecipientPlayerId(playerId: PlayerId | undefined): void {
    this.pendingSnapshot = null;
    this.post({ type: 'setRecipientPlayerId', playerId });
  }

  setSpectatorTarget(playerId: PlayerId | undefined): void {
    this.pendingSnapshot = null;
    this.post({ type: 'setSpectatorTarget', playerId });
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.worker.postMessage({ type: 'disconnect' } satisfies WorkerGameServerClientMessage);
    this.disconnected = true;
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleWorkerMessageError);
    this.worker.terminate();
    this.snapshotCallback = null;
    this.gameOverCallback = null;
    this.pendingSnapshot = null;
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error('worker game server disconnected'));
    }
    this.pendingRequests.clear();
  }

  private request(
    message: Extract<WorkerGameServerClientMessage, { requestId: number }>,
  ): Promise<unknown> {
    if (this.disconnected) {
      return Promise.reject(new Error('worker game server disconnected'));
    }
    const requestId = this.nextRequestId++;
    const requestMessage = { ...message, requestId } as WorkerGameServerClientMessage;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      this.worker.postMessage(requestMessage);
    });
  }

  private post(message: WorkerGameServerClientMessage): void {
    if (this.disconnected) return;
    this.worker.postMessage(message);
  }

  private readonly handleMessage = (event: MessageEvent<WorkerGameServerEventMessage>): void => {
    const message = event.data;
    switch (message.type) {
      case 'response': {
        const pending = this.pendingRequests.get(message.requestId);
        if (pending === undefined) return;
        this.pendingRequests.delete(message.requestId);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(new Error(message.error));
        return;
      }
      case 'progress':
        void this.onProgress?.(message.progress, message.phase);
        return;
      case 'snapshot':
        this.receiveSnapshot(message.bytes);
        return;
      case 'gameOver':
        this.gameOverCallback?.(message.winnerId);
        return;
      case 'error':
        console.error('[WorkerGameServer] worker error:', message.error);
        return;
    }
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    this.rejectAllPending(new Error(event.message || 'worker game server failed'));
  };

  private readonly handleWorkerMessageError = (): void => {
    this.rejectAllPending(new Error('worker game server message serialization failed'));
  };

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  private receiveSnapshot(bytes: ArrayBuffer): void {
    const byteLength = bytes.byteLength;
    const snapshot = decodeNetworkSnapshot(bytes, {
      packedProjectileDeltas: 'metadata-only',
      packedEntityDeltas: 'metadata-only',
    });
    setSnapshotWireBytes(snapshot, byteLength);
    this.snapshotsDecoded++;
    if (this.snapshotCallback !== null) {
      this.snapshotCallback(snapshot);
    } else {
      this.pendingSnapshot = snapshot;
    }
  }
}
