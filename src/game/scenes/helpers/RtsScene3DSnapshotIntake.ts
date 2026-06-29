import { EMA_CONFIG, EMA_INITIAL_VALUES, FRAME_TIMING_EMA } from '../../../config';
import type { ClientViewState } from '../../network/ClientViewState';
import { CLIENT_PREDICTION_DIAGNOSTICS } from '../../network/ClientPredictionDiagnostics';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotMeta,
  NetworkServerSnapshotSimEvent,
} from '../../network/NetworkTypes';
import { getSnapshotWireBytes } from '../../network/snapshotWireMetadata';
import {
  addSnapshotClientMaterializationStage,
  getSnapshotMaterializationMetadata,
  type SnapshotMaterializationMetadata,
} from '../../network/snapshotMaterializationMetadata';
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

export type RtsScene3DSnapshotTrafficKind = 'rich' | 'entity-delta' | 'projectile-delta';

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
  entityDelta: RtsScene3DSnapshotRateLaneStats;
  projectileDelta: RtsScene3DSnapshotRateLaneStats;
};

export type RtsScene3DSnapshotCounters = {
  total: number;
  rich: number;
  delta: number;
  entityDelta: number;
  projectileDelta: number;
};

export type RtsScene3DSnapshotPayloadSizeStats = RtsScene3DSnapshotByteLaneStats & {
  total: RtsScene3DSnapshotByteLaneStats;
  rich: RtsScene3DSnapshotByteLaneStats;
  delta: RtsScene3DSnapshotByteLaneStats;
  entityDelta: RtsScene3DSnapshotByteLaneStats;
  projectileDelta: RtsScene3DSnapshotByteLaneStats;
};

export type RtsScene3DSnapshotApplyStats = {
  total: RtsScene3DSnapshotApplyLaneStats;
  rich: RtsScene3DSnapshotApplyLaneStats;
  delta: RtsScene3DSnapshotApplyLaneStats;
  entityDelta: RtsScene3DSnapshotApplyLaneStats;
  projectileDelta: RtsScene3DSnapshotApplyLaneStats;
};

function snapshotTrafficKind(state: NetworkServerSnapshot): RtsScene3DSnapshotTrafficKind {
  if (state.serverMeta !== undefined) return 'rich';
  return state.projectileDeltaOnly === true ? 'projectile-delta' : 'entity-delta';
}

function isDeltaSnapshotKind(kind: RtsScene3DSnapshotTrafficKind): boolean {
  return kind !== 'rich';
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
  private readonly entityDeltaSnapTracker = new EmaTracker(
    EMA_CONFIG.snaps,
    EMA_INITIAL_VALUES.snaps,
  );
  private readonly projectileDeltaSnapTracker = new EmaTracker(
    EMA_CONFIG.snaps,
    EMA_INITIAL_VALUES.snaps,
  );
  private readonly snapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly richSnapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly deltaSnapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly entityDeltaSnapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly projectileDeltaSnapshotSizeTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly snapshotApplyTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly richSnapshotApplyTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly deltaSnapshotApplyTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly entityDeltaSnapshotApplyTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private readonly projectileDeltaSnapshotApplyTracker = new EmaMsTracker(FRAME_TIMING_EMA.frameMs);
  private lastSnapArrivalMs = 0;
  private lastRichSnapArrivalMs = 0;
  private lastDeltaSnapArrivalMs = 0;
  private lastEntityDeltaSnapArrivalMs = 0;
  private lastProjectileDeltaSnapArrivalMs = 0;
  private snapshotCounterTotal = 0;
  private snapshotCounterRich = 0;
  private snapshotCounterDelta = 0;
  private snapshotCounterEntityDelta = 0;
  private snapshotCounterProjectileDelta = 0;
  private receivedSnapshotCounterTotal = 0;
  private receivedSnapshotCounterRich = 0;
  private receivedSnapshotCounterDelta = 0;
  private receivedSnapshotCounterEntityDelta = 0;
  private receivedSnapshotCounterProjectileDelta = 0;
  private startupReadyAckSent = false;
  private startupSnapshotApplied = false;
  private startupReleased = false;
  private readonly syncEconomyFromSnapshots: boolean;
  private readonly materializationMetadataSamples: SnapshotMaterializationMetadata[] = [];

  constructor(
    private readonly clientViewState: ClientViewState,
    private readonly gameConnection: GameConnection,
  ) {
    this.syncEconomyFromSnapshots = gameConnection.sharesAuthoritativeState !== true;
  }

  attach(): void {
    this.snapshotBuffer.attach(
      this.gameConnection,
      (state) => {
        this.recordSnapshotPayloadSize(state);
        this.recordReceivedSnapshotCounter(snapshotTrafficKind(state));
      },
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
      collectCorrectionStats:
        SNAPSHOT_CADENCE_REGRESSION.enabled ||
        CLIENT_PREDICTION_DIAGNOSTICS.enabled,
      collectMaterializationStages: true,
      deferPredictedTurretRenderRefresh: true,
    });
    const applyMs = performance.now() - applyStart;
    addSnapshotClientMaterializationStage(state, 'clientApply', applyMs);
    const materializationMetadata = getSnapshotMaterializationMetadata(state);
    if (materializationMetadata !== undefined) {
      this.materializationMetadataSamples.push(materializationMetadata);
    }
    this.recordSnapshotCounter(kind);
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
      entityDelta: {
        avgRate: this.entityDeltaSnapTracker.getAvg(),
        worstRate: this.entityDeltaSnapTracker.getLow(),
      },
      projectileDelta: {
        avgRate: this.projectileDeltaSnapTracker.getAvg(),
        worstRate: this.projectileDeltaSnapTracker.getLow(),
      },
    };
  }

  getSnapshotCounters(): RtsScene3DSnapshotCounters {
    return {
      total: this.snapshotCounterTotal,
      rich: this.snapshotCounterRich,
      delta: this.snapshotCounterDelta,
      entityDelta: this.snapshotCounterEntityDelta,
      projectileDelta: this.snapshotCounterProjectileDelta,
    };
  }

  getReceivedSnapshotCounters(): RtsScene3DSnapshotCounters {
    return {
      total: this.receivedSnapshotCounterTotal,
      rich: this.receivedSnapshotCounterRich,
      delta: this.receivedSnapshotCounterDelta,
      entityDelta: this.receivedSnapshotCounterEntityDelta,
      projectileDelta: this.receivedSnapshotCounterProjectileDelta,
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
      entityDelta: {
        avgBytes: this.entityDeltaSnapshotSizeTracker.getAvg(),
        hiBytes: this.entityDeltaSnapshotSizeTracker.getHi(),
      },
      projectileDelta: {
        avgBytes: this.projectileDeltaSnapshotSizeTracker.getAvg(),
        hiBytes: this.projectileDeltaSnapshotSizeTracker.getHi(),
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
      entityDelta: {
        avgMs: this.entityDeltaSnapshotApplyTracker.getAvg(),
        hiMs: this.entityDeltaSnapshotApplyTracker.getHi(),
      },
      projectileDelta: {
        avgMs: this.projectileDeltaSnapshotApplyTracker.getAvg(),
        hiMs: this.projectileDeltaSnapshotApplyTracker.getHi(),
      },
    };
  }

  drainSnapshotMaterializationMetadata(out: SnapshotMaterializationMetadata[]): void {
    for (let i = 0; i < this.materializationMetadataSamples.length; i++) {
      out.push(this.materializationMetadataSamples[i]);
    }
    this.materializationMetadataSamples.length = 0;
  }

  clear(): void {
    this.snapshotBuffer.clear();
    this.materializationMetadataSamples.length = 0;
    this.snapshotCounterTotal = 0;
    this.snapshotCounterRich = 0;
    this.snapshotCounterDelta = 0;
    this.snapshotCounterEntityDelta = 0;
    this.snapshotCounterProjectileDelta = 0;
    this.receivedSnapshotCounterTotal = 0;
    this.receivedSnapshotCounterRich = 0;
    this.receivedSnapshotCounterDelta = 0;
    this.receivedSnapshotCounterEntityDelta = 0;
    this.receivedSnapshotCounterProjectileDelta = 0;
  }

  private recordSnapshotCounter(kind: RtsScene3DSnapshotTrafficKind): void {
    this.snapshotCounterTotal++;
    if (kind === 'rich') {
      this.snapshotCounterRich++;
      return;
    }
    this.snapshotCounterDelta++;
    if (kind === 'entity-delta') {
      this.snapshotCounterEntityDelta++;
    } else {
      this.snapshotCounterProjectileDelta++;
    }
  }

  private recordReceivedSnapshotCounter(kind: RtsScene3DSnapshotTrafficKind): void {
    this.receivedSnapshotCounterTotal++;
    if (kind === 'rich') {
      this.receivedSnapshotCounterRich++;
      return;
    }
    this.receivedSnapshotCounterDelta++;
    if (kind === 'entity-delta') {
      this.receivedSnapshotCounterEntityDelta++;
    } else {
      this.receivedSnapshotCounterProjectileDelta++;
    }
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
    if (!isDeltaSnapshotKind(kind)) return;
    if (this.lastDeltaSnapArrivalMs > 0) {
      const dt = now - this.lastDeltaSnapArrivalMs;
      if (dt > 0) this.deltaSnapTracker.update(1000 / dt);
    }
    this.lastDeltaSnapArrivalMs = now;
    if (kind === 'entity-delta') {
      if (this.lastEntityDeltaSnapArrivalMs > 0) {
        const dt = now - this.lastEntityDeltaSnapArrivalMs;
        if (dt > 0) this.entityDeltaSnapTracker.update(1000 / dt);
      }
      this.lastEntityDeltaSnapArrivalMs = now;
    } else {
      if (this.lastProjectileDeltaSnapArrivalMs > 0) {
        const dt = now - this.lastProjectileDeltaSnapArrivalMs;
        if (dt > 0) this.projectileDeltaSnapTracker.update(1000 / dt);
      }
      this.lastProjectileDeltaSnapArrivalMs = now;
    }
  }

  private recordSnapshotApply(kind: RtsScene3DSnapshotTrafficKind, applyMs: number): void {
    const sample = Number.isFinite(applyMs) && applyMs >= 0 ? applyMs : 0;
    this.snapshotApplyTracker.update(sample);
    if (kind === 'rich') {
      this.richSnapshotApplyTracker.update(sample);
    } else if (kind === 'entity-delta') {
      this.deltaSnapshotApplyTracker.update(sample);
      this.entityDeltaSnapshotApplyTracker.update(sample);
    } else {
      this.deltaSnapshotApplyTracker.update(sample);
      this.projectileDeltaSnapshotApplyTracker.update(sample);
    }
  }

  private recordSnapshotPayloadSize(state: NetworkServerSnapshot): void {
    const bytes = getSnapshotWireBytes(state);
    if (bytes === undefined) return;
    const kind = snapshotTrafficKind(state);
    this.snapshotSizeTracker.update(bytes);
    if (kind === 'rich') {
      this.richSnapshotSizeTracker.update(bytes);
    } else if (kind === 'entity-delta') {
      this.deltaSnapshotSizeTracker.update(bytes);
      this.entityDeltaSnapshotSizeTracker.update(bytes);
    } else {
      this.deltaSnapshotSizeTracker.update(bytes);
      this.projectileDeltaSnapshotSizeTracker.update(bytes);
    }
  }
}
