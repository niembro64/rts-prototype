import { EMA_CONFIG, EMA_INITIAL_VALUES } from '../../../config';
import type { ClientViewState } from '../../network/ClientViewState';
import type {
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotSimEvent,
} from '../../network/NetworkTypes';
import type { GameConnection } from '../../server/GameConnection';
import type { PlayerId } from '../../sim/types';
import { EmaTracker } from './EmaTracker';
import { SnapshotBuffer } from './SnapshotBuffer';

export type RtsScene3DSnapshotEventScheduler = {
  recordSnapshot(now: number): number;
  schedule(
    events: NetworkServerSnapshotSimEvent[],
    now: number,
    smoothingEnabled: boolean,
    play: (event: NetworkServerSnapshotSimEvent) => void,
  ): void;
};

export type RtsScene3DSnapshotAudioOptions = {
  scheduler: RtsScene3DSnapshotEventScheduler;
  smoothingEnabled: boolean;
  play(event: NetworkServerSnapshotSimEvent): void;
};

export type RtsScene3DSnapshotIntakeResult = {
  appliedSnapshot: boolean;
  startupReleased: boolean;
  serverMeta: NetworkServerSnapshotMeta | null;
  gameOverWinnerId: PlayerId | null;
};

export class RtsScene3DSnapshotIntake {
  private readonly snapshotBuffer = new SnapshotBuffer();
  private readonly snapTracker = new EmaTracker(
    EMA_CONFIG.snaps,
    EMA_INITIAL_VALUES.snaps,
  );
  // Parallel tracker that ONLY updates on full keyframes
  // (state.isDelta=false). No initial value: the EMA seeds from the
  // first real full-keyframe interval.
  private readonly fullSnapTracker = new EmaTracker(EMA_CONFIG.snaps);
  private lastSnapArrivalMs = 0;
  private lastFullSnapArrivalMs = 0;
  private startupReadyAckSent = false;
  private startupFullSnapshotApplied = false;
  private startupReleased = false;

  constructor(
    private readonly clientViewState: ClientViewState,
    private readonly gameConnection: GameConnection,
  ) {}

  attach(): void {
    this.snapshotBuffer.attach(this.gameConnection);
  }

  consumeLatestSnapshot(options: {
    clientRenderEnabled: boolean;
    audio?: RtsScene3DSnapshotAudioOptions;
    now?: number;
  }): RtsScene3DSnapshotIntakeResult {
    const state = this.snapshotBuffer.consume();
    if (!state) {
      return {
        appliedSnapshot: false,
        startupReleased: false,
        serverMeta: null,
        gameOverWinnerId: null,
      };
    }

    this.clientViewState.applyNetworkState(state);
    if (!this.startupReadyAckSent && !state.isDelta) {
      this.startupFullSnapshotApplied = true;
    }

    const startupReleased = !this.startupReleased && state.tick > 0;
    if (startupReleased) this.startupReleased = true;

    const now = options.now ?? performance.now();
    this.recordSnapshotArrival(state.isDelta, now);

    if (options.clientRenderEnabled && options.audio) {
      options.audio.scheduler.recordSnapshot(now);
      const events = this.clientViewState.getPendingAudioEvents();
      if (events && events.length > 0) {
        options.audio.scheduler.schedule(
          events,
          now,
          options.audio.smoothingEnabled,
          options.audio.play,
        );
      }
    }

    return {
      appliedSnapshot: true,
      startupReleased,
      serverMeta: this.clientViewState.getServerMeta(),
      gameOverWinnerId: this.clientViewState.getGameOverWinnerId(),
    };
  }

  markClientReadyAfterRender(): void {
    if (!this.startupFullSnapshotApplied || this.startupReadyAckSent) return;
    this.startupReadyAckSent = true;
    this.gameConnection.markClientReady();
  }

  getSnapshotStats(): { avgRate: number; worstRate: number } {
    return {
      avgRate: this.snapTracker.getAvg(),
      worstRate: this.snapTracker.getLow(),
    };
  }

  getFullSnapshotStats(): { avgRate: number; worstRate: number } {
    return {
      avgRate: this.fullSnapTracker.getAvg(),
      worstRate: this.fullSnapTracker.getLow(),
    };
  }

  clear(): void {
    this.snapshotBuffer.clear();
  }

  private recordSnapshotArrival(isDelta: boolean, now: number): void {
    if (this.lastSnapArrivalMs > 0) {
      const dt = now - this.lastSnapArrivalMs;
      if (dt > 0) this.snapTracker.update(1000 / dt);
    }
    this.lastSnapArrivalMs = now;

    if (isDelta) return;
    if (this.lastFullSnapArrivalMs > 0) {
      const dt = now - this.lastFullSnapArrivalMs;
      if (dt > 0) this.fullSnapTracker.update(1000 / dt);
    }
    this.lastFullSnapArrivalMs = now;
  }
}
