import type { GameServerConfig } from '@/types/game';
import type { Command } from '../sim/commands';
import type { PlayerId } from '../sim/types';
import type { BudgetReplayFile } from './ReplayRecorder';
import type { LocalCommandAuthorityMode } from './LocalGameConnection';

export type WorkerGameServerCreatePayload = {
  readonly config: GameServerConfig;
  readonly localPlayerId: PlayerId | undefined;
  readonly commandAuthorityMode: LocalCommandAuthorityMode;
};

export type WorkerGameServerClientMessage =
  | {
      readonly type: 'create';
      readonly requestId: number;
      readonly payload: WorkerGameServerCreatePayload;
    }
  | {
      readonly type: 'start';
      readonly requestId: number;
    }
  | {
      readonly type: 'stop';
      readonly requestId: number;
    }
  | {
      readonly type: 'disconnect';
    }
  | {
      readonly type: 'sendCommand';
      readonly command: Command;
    }
  | {
      readonly type: 'sendHostCommand';
      readonly command: Command;
    }
  | {
      readonly type: 'markClientReady';
    }
  | {
      readonly type: 'setRecipientPlayerId';
      readonly playerId: PlayerId | undefined;
    }
  | {
      readonly type: 'setSpectatorTarget';
      readonly playerId: PlayerId | undefined;
    }
  | {
      readonly type: 'setIpAddress';
      readonly ipAddress: string;
    }
  | {
      readonly type: 'exportReplay';
      readonly requestId: number;
    };

export type WorkerGameServerSnapshotMessage = {
  readonly type: 'snapshot';
  readonly bytes: ArrayBuffer;
};

export type WorkerGameServerProgressMessage = {
  readonly type: 'progress';
  readonly progress: number;
  readonly phase: string | undefined;
};

export type WorkerGameServerResponseMessage =
  | {
      readonly type: 'response';
      readonly requestId: number;
      readonly ok: true;
      readonly value?: unknown;
    }
  | {
      readonly type: 'response';
      readonly requestId: number;
      readonly ok: false;
      readonly error: string;
    };

export type WorkerGameServerEventMessage =
  | WorkerGameServerSnapshotMessage
  | WorkerGameServerProgressMessage
  | WorkerGameServerResponseMessage
  | {
      readonly type: 'gameOver';
      readonly winnerId: PlayerId;
    }
  | {
      readonly type: 'error';
      readonly error: string;
    };

export type WorkerGameServerExportReplayResponse = BudgetReplayFile;
