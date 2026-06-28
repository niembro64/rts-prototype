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

type RtsScene3DSnapshotIntakeResult = {
  appliedSnapshot: boolean;
  startupReleased: boolean;
  serverMeta: NetworkServerSnapshotMeta | null;
  gameOverWinnerId: PlayerId | null;
};

export type RtsScene3DSnapshotTrafficKind = 'rich' | 'delta';

export type RtsScene3DSnapshotRateLaneStats = {
  avgRate: number;
  worstRate: number;
};

export type RtsScene3DSnapshotByteLaneStats = {
  avgBytes: number;
  hiBytes: number;
};

export type RtsScene3DSnapshotApplyLaneStats = {
  avgMs: number;
  hiMs: number;
};

export type RtsScene3DSnapshotRateStats = RtsScene3DSnapshotRateLaneStats & {
  total: RtsScene3DSnapshotRateLaneStats;
  rich: RtsScene3DSnapshotRateLaneStats;
  delta: RtsScene3DSnapshotRateLaneStats;
};

export type RtsScene3DSnapshotPayloadSizeStats = RtsScene3DSnapshotByteLaneStats & {
  total: RtsScene3DSnapshotByteLaneStats;
  rich: RtsScene3DSnapshotByteLaneStats;
  delta: RtsScene3DSnapshotByteLaneStats;
};

export type RtsScene3DSnapshotApplyStats = {
  total: RtsScene3DSnapshotApplyLaneStats;
  rich: RtsScene3DSnapshotApplyLaneStats;
  delta: RtsScene3DSnapshotApplyLaneStats;
};

function snapshotTrafficKind(state: NetworkServerSnapshot): RtsScene3DSnapshotTrafficKind {
  return state.serverMeta !== undefined ? 'rich' : 'delta';
}

export class RtsScene3DSnapshotIntake {
  private readonly snapshotBuffer = new SnapshotBuffer();
  private readonly snapTracker = new EmaTracker(
    EMA_CONFIG.snaps,
    EMA_INITIAL_VALUES.snaps,
  );
  private readonly richSnapTracker = new EmaTracker(
    EMA_CONFIG.snaps,
    EMA_INITIAL_VALUES.snaps,
  );
  private readonly deltaSnapTracker = new EmaTracker(
    EMA_CONFIG.snaps,
    EMA_INITIAL_VALUES.snaps,
  );
  private readonly snapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly richSnapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly deltaSnapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly snapshotApplyTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly richSnapshotApplyTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly deltaSnapshotApplyTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private lastSnapArrivalMs = 0;
  private lastRichSnapArrivalMs = 0;
  private lastDeltaSnapArrivalMs = 0;
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

    const kind = snapshotTrafficKind(state);
    const applyStart = performance.now();
    const applyStats = this.clientViewState.applyNetworkState(state, {
      syncEconomy: this.syncEconomyFromSnapshots,
    });
    const applyMs = performance.now() - applyStart;
    this.recordSnapshotApply(kind, applyMs);
    if (!this.startupReadyAckSent) this.startupSnapshotApplied = true;

    // The server intentionally pauses simulation ticks behind the startup
    // ready barrier, so a tick > 0 snapshot can only arrive after clients
    // acknowledge their first full-state bootstrap. Treat that snapshot as
    // scene-startup-ready; otherwise the UI waits on the same gate it needs
    // to release.
    const startupReleased = !this.startupReleased && this.startupSnapshotApplied;
    if (startupReleased) this.startupReleased = true;

    const now = nowOverride ?? performance.now();
    this.recordSnapshotArrival(now, kind);
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

  getSnapshotStats(): RtsScene3DSnapshotRateStats {
    const total = {
      avgRate: this.snapTracker.getAvg(),
      worstRate: this.snapTracker.getLow(),
    };
    return {
      ...total,
      total,
      rich: {
        avgRate: this.richSnapTracker.getAvg(),
        worstRate: this.richSnapTracker.getLow(),
      },
      delta: {
        avgRate: this.deltaSnapTracker.getAvg(),
        worstRate: this.deltaSnapTracker.getLow(),
      },
    };
  }

  getSnapshotPayloadSizeStats(): RtsScene3DSnapshotPayloadSizeStats {
    const total = {
      avgBytes: this.snapshotSizeTracker.getAvg(),
      hiBytes: this.snapshotSizeTracker.getHi(),
    };
    return {
      ...total,
      total,
      rich: {
        avgBytes: this.richSnapshotSizeTracker.getAvg(),
        hiBytes: this.richSnapshotSizeTracker.getHi(),
      },
      delta: {
        avgBytes: this.deltaSnapshotSizeTracker.getAvg(),
        hiBytes: this.deltaSnapshotSizeTracker.getHi(),
      },
    };
  }

  getSnapshotApplyStats(): RtsScene3DSnapshotApplyStats {
    return {
      total: {
        avgMs: this.snapshotApplyTracker.getAvg(),
        hiMs: this.snapshotApplyTracker.getHi(),
      },
      rich: {
        avgMs: this.richSnapshotApplyTracker.getAvg(),
        hiMs: this.richSnapshotApplyTracker.getHi(),
      },
      delta: {
        avgMs: this.deltaSnapshotApplyTracker.getAvg(),
        hiMs: this.deltaSnapshotApplyTracker.getHi(),
      },
    };
  }

  clear(): void {
    this.snapshotBuffer.clear();
  }

  private recordSnapshotArrival(now: number, kind: RtsScene3DSnapshotTrafficKind): void {
    if (this.lastSnapArrivalMs > 0) {
      const dt = now - this.lastSnapArrivalMs;
      if (dt > 0) this.snapTracker.update(1000 / dt);
    }
    this.lastSnapArrivalMs = now;
    if (kind === 'rich') {
      if (this.lastRichSnapArrivalMs > 0) {
        const dt = now - this.lastRichSnapArrivalMs;
        if (dt > 0) this.richSnapTracker.update(1000 / dt);
      }
      this.lastRichSnapArrivalMs = now;
      return;
    }
    if (this.lastDeltaSnapArrivalMs > 0) {
      const dt = now - this.lastDeltaSnapArrivalMs;
      if (dt > 0) this.deltaSnapTracker.update(1000 / dt);
    }
    this.lastDeltaSnapArrivalMs = now;
  }

  private recordSnapshotApply(kind: RtsScene3DSnapshotTrafficKind, applyMs: number): void {
    const sample = Number.isFinite(applyMs) && applyMs >= 0 ? applyMs : 0;
    this.snapshotApplyTracker.update(sample);
    if (kind === 'rich') {
      this.richSnapshotApplyTracker.update(sample);
    } else {
      this.deltaSnapshotApplyTracker.update(sample);
    }
  }

  private recordSnapshotPayloadSize(state: NetworkServerSnapshot): void {
    const bytes = getSnapshotWireBytes(state);
    if (bytes === undefined) return;
    const kind = snapshotTrafficKind(state);
    this.snapshotSizeTracker.update(bytes);
    if (kind === 'rich') {
      this.richSnapshotSizeTracker.update(bytes);
    } else {
      this.deltaSnapshotSizeTracker.update(bytes);
    }
  }
}
