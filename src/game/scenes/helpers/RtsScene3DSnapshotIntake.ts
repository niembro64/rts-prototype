import { EMA_CONFIG, EMA_INITIAL_VALUES, FRAME_TIMING_EMA } from '../../../config';
import type { ClientViewState } from '../../network/ClientViewState';
import { CLIENT_PREDICTION_DIAGNOSTICS } from '../../network/ClientPredictionDiagnostics';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotSimEvent,
} from '../../network/NetworkTypes';
import { getSnapshotWireBytes } from '../../network/snapshotWireMetadata';
import type { GameConnection } from '../../server/GameConnection';
import type { PlayerId } from '../../sim/types';
import { SNAPSHOT_CADENCE_REGRESSION } from '../../SnapshotCadenceRegression';
import { EmaMsTracker } from './EmaMsTracker';
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
  private readonly snapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private lastSnapArrivalMs = 0;
  private startupReadyAckSent = false;
  private startupSnapshotApplied = false;
  private startupReleased = false;
  private readonly syncEconomyFromSnapshots: boolean;

  constructor(
    private readonly clientViewState: ClientViewState,
    private readonly gameConnection: GameConnection,
  ) {
    this.syncEconomyFromSnapshots = gameConnection.sharesAuthoritativeState !== true;
  }

  attach(): void {
    this.snapshotBuffer.attach(
      this.gameConnection,
      (state) => this.recordSnapshotPayloadSize(state),
    );
  }

  consumeLatestSnapshot(
    clientRenderEnabled: boolean,
    audio?: RtsScene3DSnapshotAudioOptions,
    nowOverride?: number,
  ): RtsScene3DSnapshotIntakeResult {
    const state = this.snapshotBuffer.consume();
    if (!state) {
      return {
        appliedSnapshot: false,
        startupReleased: false,
        serverMeta: null,
        gameOverWinnerId: null,
      };
    }

    const applyStart = performance.now();
    const applyStats = this.clientViewState.applyNetworkState(state, {
      syncEconomy: this.syncEconomyFromSnapshots,
    });
    const applyMs = performance.now() - applyStart;
    if (!this.startupReadyAckSent) this.startupSnapshotApplied = true;

    // The server intentionally pauses simulation ticks behind the startup
    // ready barrier, so a tick > 0 snapshot can only arrive after clients
    // acknowledge their first full-state bootstrap. Treat that snapshot as
    // scene-startup-ready; otherwise the UI waits on the same gate it needs
    // to release.
    const startupReleased = !this.startupReleased && this.startupSnapshotApplied;
    if (startupReleased) this.startupReleased = true;

    const now = nowOverride ?? performance.now();
    this.recordSnapshotArrival(now);
    SNAPSHOT_CADENCE_REGRESSION.recordSnapshotApply({
      tick: state.tick,
      meta: state.serverMeta,
      applyMs,
      correction: applyStats.correction,
      now,
    });
    CLIENT_PREDICTION_DIAGNOSTICS.recordSnapshotApply(applyStats.correction);

    if (clientRenderEnabled && audio) {
      audio.scheduler.recordSnapshot(now);
      const events = this.clientViewState.getPendingAudioEvents();
      if (events && events.length > 0) {
        audio.scheduler.schedule(
          events,
          now,
          audio.smoothingEnabled,
          audio.play,
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
    if (!this.startupSnapshotApplied || this.startupReadyAckSent) return;
    this.startupReadyAckSent = true;
    this.gameConnection.markClientReady();
  }

  hasStartupFullSnapshotApplied(): boolean {
    return this.startupSnapshotApplied;
  }

  getSnapshotStats(): { avgRate: number; worstRate: number } {
    return {
      avgRate: this.snapTracker.getAvg(),
      worstRate: this.snapTracker.getLow(),
    };
  }

  getSnapshotPayloadSizeStats(): { avgBytes: number; hiBytes: number } {
    return {
      avgBytes: this.snapshotSizeTracker.getAvg(),
      hiBytes: this.snapshotSizeTracker.getHi(),
    };
  }

  clear(): void {
    this.snapshotBuffer.clear();
  }

  private recordSnapshotArrival(now: number): void {
    if (this.lastSnapArrivalMs > 0) {
      const dt = now - this.lastSnapArrivalMs;
      if (dt > 0) this.snapTracker.update(1000 / dt);
    }
    this.lastSnapArrivalMs = now;
  }

  private recordSnapshotPayloadSize(state: NetworkServerSnapshot): void {
    const bytes = getSnapshotWireBytes(state);
    if (bytes === undefined) return;
    this.snapshotSizeTracker.update(bytes);
  }
}
