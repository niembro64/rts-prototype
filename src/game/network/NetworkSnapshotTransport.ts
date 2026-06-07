import type { DataConnection } from 'peerjs';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import { SNAPSHOT_CADENCE_REGRESSION } from '../SnapshotCadenceRegression';
import { SNAPSHOT_ENCODE_INSTRUMENTATION } from '../SnapshotEncodeInstrumentation';
import type { NetworkMessage, NetworkServerSnapshot } from './NetworkTypes';
import type { SnapshotWirePayload } from './SnapshotWirePayload';
import type { PlayerId } from '../sim/types';
import type { SnapshotCompressionFormat } from '../../types/config';
import type { SnapshotRate } from '../../types/server';
import {
  canUseSnapshotCompression,
  compressSnapshotPayload,
  decompressSnapshotPayload,
  getFullSnapshotCompressionOptions,
  SNAPSHOT_TRANSPORT_COMPRESSION,
} from './snapshotTransportCompression';
import {
  decodeNetworkSnapshot,
  encodeNetworkSnapshot,
  measureNetworkSnapshotWireBreakdown,
} from './snapshotWireCodec';
import { ReusableNetworkSnapshotCloner } from './snapshotClone';
import { setSnapshotWireBytes } from './snapshotWireMetadata';

const SNAPSHOT_BACKPRESSURE_DROP_BYTES = 2 * 1024 * 1024;
type NetworkStateMessage = Extract<NetworkMessage, { type: 'state' }>;
type StateMessageBuild = NetworkStateMessage | Promise<NetworkStateMessage | null> | null;
type SnapshotSendTelemetry = {
  rate: SnapshotRate | undefined;
  unitCount: number | undefined;
  isDelta: boolean;
};
type SnapshotCompressionDescriptor = NonNullable<NetworkStateMessage['compression']>;
type NetworkSnapshotTransportOptions = {
  onSnapshotDropped?: (playerId: PlayerId) => void;
  onPendingDeltaDropped?: () => void;
};

function isSnapshotCompressionFormat(value: unknown): value is SnapshotCompressionFormat {
  return value === 'gzip' || value === 'deflate' || value === 'deflate-raw';
}

function normalizeSnapshotCompression(
  compression: NetworkStateMessage['compression'] | null,
): SnapshotCompressionDescriptor | null {
  if (compression == null) return null;
  if (!isSnapshotCompressionFormat(compression.format)) return null;
  return {
    format: compression.format,
    rawBytes: Number.isFinite(compression.rawBytes) ? compression.rawBytes : 0,
  };
}

export class NetworkSnapshotTransport {
  private snapshotsSent = 0;
  private snapshotsReceived = 0;
  private snapshotsDropped = 0;
  private snapshotDropCounts: Map<PlayerId, number> = new Map();
  private pendingReceivedState: NetworkServerSnapshot | null = null;
  private pendingReceivedStateCloner = new ReusableNetworkSnapshotCloner();
  private pendingFullCompressionPlayerIds = new Set<PlayerId>();
  private compressionFailureLogged = false;

  constructor(private readonly options: NetworkSnapshotTransportOptions = {}) {}

  buildStateMessage(
    playerId: PlayerId,
    conn: DataConnection,
    gameId: string,
    state: NetworkServerSnapshot,
    wirePayload: SnapshotWirePayload | undefined = undefined,
  ): StateMessageBuild {
    if (this.shouldDropForBackpressure(playerId, conn)) return null;
    if (this.shouldDropForPendingFullCompression(playerId)) return null;

    const encoded = wirePayload ?? this.encodeSnapshot(state);
    const buf = encoded.bytes;
    const encodeMs = encoded.encodeMs;
    const telemetry = this.captureSendTelemetry(state);

    const compressionOptions = getFullSnapshotCompressionOptions();
    if (
      !state.isDelta &&
      compressionOptions.enabled &&
      buf.byteLength >= compressionOptions.minBytes
    ) {
      if (canUseSnapshotCompression(compressionOptions.format)) {
        this.pendingFullCompressionPlayerIds.add(playerId);
        return this.buildCompressedFullStateMessage(
          playerId,
          conn,
          gameId,
          telemetry,
          buf,
          encodeMs,
          compressionOptions.format,
        );
      }
      SNAPSHOT_TRANSPORT_COMPRESSION.recordUnsupported(buf.byteLength);
    }

    if (this.shouldDropForBackpressure(playerId, conn, buf.byteLength)) return null;
    this.recordSentSnapshot(playerId, conn, telemetry, buf.byteLength, encodeMs, state);
    return {
      type: 'state',
      gameId,
      data: buf,
      isDelta: state.isDelta,
    };
  }

  private encodeSnapshot(state: NetworkServerSnapshot): SnapshotWirePayload {
    const encodeStart = performance.now();
    const bytes = encodeNetworkSnapshot(state);
    const encodeMs = performance.now() - encodeStart;
    return { bytes, encodeMs };
  }

  async decodeReceivedState(
    message: NetworkStateMessage,
    hostDataChannel: RTCDataChannel | undefined = undefined,
  ): Promise<NetworkServerSnapshot> {
    this.snapshotsReceived++;
    if (GAME_DIAGNOSTICS.networkSnapshots && this.snapshotsReceived % 100 === 0) {
      debugLog(
        true,
        `[NET] Client received snapshot #${this.snapshotsReceived} (dc=${hostDataChannel === undefined ? 'none' : hostDataChannel.readyState})`,
      );
    }

    const decodeStart = performance.now();
    const bytes = message.data.byteLength;
    let payload = message.data instanceof Uint8Array
      ? message.data
      : new Uint8Array(message.data);
    const compression = normalizeSnapshotCompression(message.compression ?? null);
    if (compression !== null) {
      const decompressStart = performance.now();
      try {
        payload = await decompressSnapshotPayload(payload, compression.format);
      } catch (err) {
        SNAPSHOT_TRANSPORT_COMPRESSION.recordDecodeFailure();
        throw err;
      }
      const decompressMs = performance.now() - decompressStart;
      SNAPSHOT_TRANSPORT_COMPRESSION.recordDecompressed(
        bytes,
        payload.byteLength,
        decompressMs,
      );
      if (
        Number.isFinite(compression.rawBytes) &&
        compression.rawBytes !== payload.byteLength
      ) {
        console.warn('[NET] FULLSNAP decompressed size mismatch', {
          expected: compression.rawBytes,
          actual: payload.byteLength,
        });
      }
    }

    const state = decodeNetworkSnapshot(payload);
    setSnapshotWireBytes(state, bytes);
    const serverMeta = state.serverMeta;
    SNAPSHOT_CADENCE_REGRESSION.recordSnapshotDecode({
      rate: serverMeta === undefined ? undefined : serverMeta.snaps.rate,
      bytes,
      decodeMs: performance.now() - decodeStart,
    });
    return state;
  }

  storePendingState(state: NetworkServerSnapshot): void {
    if (!state.isDelta) {
      // A newer full keyframe supersedes any buffered state.
      const previousTerrain = this.pendingReceivedState?.terrain;
      const previousBuildability = this.pendingReceivedState?.buildability;
      const pending = this.pendingReceivedStateCloner.clone(state);
      // If the real-battle scene has not attached yet, a later dynamic
      // keyframe can arrive after the initial static terrain keyframe. Keep
      // the map payload with the newest pending full snapshot so startup
      // cannot lose terrain before the renderer consumes it.
      if (pending.terrain === undefined && previousTerrain !== undefined) {
        pending.terrain = previousTerrain;
      }
      if (pending.buildability === undefined && previousBuildability !== undefined) {
        pending.buildability = previousBuildability;
      }
      this.pendingReceivedState = pending;
      return;
    }

    if (!this.pendingReceivedState) {
      // Held until a later consume; the next decode reuses pooled DTOs, so
      // clone into owned objects to keep the buffered snapshot intact.
      this.pendingReceivedState = this.pendingReceivedStateCloner.clone(state);
      return;
    }

    this.options.onPendingDeltaDropped?.();
  }

  consumePendingState(): NetworkServerSnapshot | null {
    const state = this.pendingReceivedState;
    this.pendingReceivedState = null;
    return state;
  }

  clearPlayer(playerId: PlayerId): void {
    this.snapshotDropCounts.delete(playerId);
    this.pendingFullCompressionPlayerIds.delete(playerId);
    SNAPSHOT_ENCODE_INSTRUMENTATION.clearListener(`player-${playerId}`, 'remote');
  }

  reset(): void {
    this.pendingReceivedState = null;
    this.pendingReceivedStateCloner.clear();
    this.snapshotDropCounts.clear();
    this.pendingFullCompressionPlayerIds.clear();
    this.snapshotsDropped = 0;
    this.compressionFailureLogged = false;
    SNAPSHOT_ENCODE_INSTRUMENTATION.clearSource('remote');
  }

  getPendingCloneRetainedCounts(): ReturnType<ReusableNetworkSnapshotCloner['getRetainedCounts']> {
    return this.pendingReceivedStateCloner.getRetainedCounts();
  }

  private async buildCompressedFullStateMessage(
    playerId: PlayerId,
    conn: DataConnection,
    gameId: string,
    telemetry: SnapshotSendTelemetry,
    raw: Uint8Array,
    rawEncodeMs: number,
    format: SnapshotCompressionFormat,
  ): Promise<NetworkStateMessage | null> {
    const compressStart = performance.now();
    try {
      const compressed = await compressSnapshotPayload(raw, format);
      const compressMs = performance.now() - compressStart;
      if (compressed.byteLength >= raw.byteLength) {
        SNAPSHOT_TRANSPORT_COMPRESSION.recordRawFallback(raw.byteLength, compressMs);
        if (this.shouldDropForBackpressure(playerId, conn, raw.byteLength)) return null;
        this.recordSentSnapshot(
          playerId,
          conn,
          telemetry,
          raw.byteLength,
          rawEncodeMs + compressMs,
        );
        return {
          type: 'state',
          gameId,
          data: raw,
        };
      }

      SNAPSHOT_TRANSPORT_COMPRESSION.recordCompressed(
        raw.byteLength,
        compressed.byteLength,
        compressMs,
      );
      if (this.shouldDropForBackpressure(playerId, conn, compressed.byteLength)) return null;
      this.recordSentSnapshot(
        playerId,
        conn,
        telemetry,
        compressed.byteLength,
        rawEncodeMs + compressMs,
      );
      return {
        type: 'state',
        gameId,
        data: compressed,
        isDelta: telemetry.isDelta,
        compression: {
          format,
          rawBytes: raw.byteLength,
        },
      };
    } catch (err) {
      const compressMs = performance.now() - compressStart;
      SNAPSHOT_TRANSPORT_COMPRESSION.recordEncodeFailure(raw.byteLength);
      if (!this.compressionFailureLogged) {
        this.compressionFailureLogged = true;
        console.warn('[NET] FULLSNAP compression failed; sending raw snapshots.', err);
      }
      if (this.shouldDropForBackpressure(playerId, conn, raw.byteLength)) return null;
      this.recordSentSnapshot(
        playerId,
        conn,
        telemetry,
        raw.byteLength,
        rawEncodeMs + compressMs,
      );
      return {
        type: 'state',
        gameId,
        data: raw,
        isDelta: telemetry.isDelta,
      };
    } finally {
      this.pendingFullCompressionPlayerIds.delete(playerId);
    }
  }

  private recordSentSnapshot(
    playerId: PlayerId,
    conn: DataConnection,
    telemetry: SnapshotSendTelemetry,
    wireBytes: number,
    encodeMs: number,
    breakdownState: NetworkServerSnapshot | undefined = undefined,
  ): void {
    this.snapshotsSent++;
    SNAPSHOT_CADENCE_REGRESSION.recordSnapshotEncode({
      rate: telemetry.rate,
      bytes: wireBytes,
      encodeMs,
    });
    SNAPSHOT_ENCODE_INSTRUMENTATION.record({
      source: 'remote',
      listener: `player-${playerId}`,
      rate: telemetry.rate,
      unitCount: telemetry.unitCount,
      bytes: wireBytes,
      encodeMs,
      isDelta: telemetry.isDelta,
      breakdown: breakdownState !== undefined && SNAPSHOT_ENCODE_INSTRUMENTATION.enabled
        ? measureNetworkSnapshotWireBreakdown(breakdownState, wireBytes)
        : undefined,
    });

    if (GAME_DIAGNOSTICS.networkSnapshots && this.snapshotsSent % 100 === 0) {
      const dc = conn.dataChannel;
      const buffered = dc ? dc.bufferedAmount : -1;
      const dcState = dc ? dc.readyState : 'no-dc';
      debugLog(
        true,
        `[NET] Host snapshot #${this.snapshotsSent} -> player ${playerId}: open=${conn.open} dc=${dcState} buffered=${buffered} size=${wireBytes} dropped=${this.snapshotDropCounts.get(playerId) ?? 0}`,
      );
    }
  }

  private captureSendTelemetry(state: NetworkServerSnapshot): SnapshotSendTelemetry {
    const serverMeta = state.serverMeta;
    return {
      rate: serverMeta === undefined ? undefined : serverMeta.snaps.rate,
      unitCount: serverMeta === undefined ? undefined : serverMeta.units.count,
      isDelta: state.isDelta,
    };
  }

  private shouldDropForBackpressure(
    playerId: PlayerId,
    conn: DataConnection,
    pendingBytes = 0,
  ): boolean {
    const dc = conn.dataChannel;
    if (!conn.open || !dc || dc.readyState !== 'open') return true;
    const buffered = dc.bufferedAmount;
    const bytes = Math.max(0, pendingBytes);
    const overCurrentBudget = buffered >= SNAPSHOT_BACKPRESSURE_DROP_BYTES;
    const wouldExceedBudget = bytes > 0 &&
      buffered > 0 &&
      buffered + bytes > SNAPSHOT_BACKPRESSURE_DROP_BYTES;
    if (!overCurrentBudget && !wouldExceedBudget) return false;

    const playerDrops = this.recordDroppedSnapshot(playerId);
    if (GAME_DIAGNOSTICS.networkSnapshots && (playerDrops === 1 || playerDrops % 100 === 0)) {
      debugLog(
        true,
        `[NET] Dropping snapshot for player ${playerId}: data channel buffered=${buffered} pending=${bytes} limit=${SNAPSHOT_BACKPRESSURE_DROP_BYTES} dropped=${playerDrops} totalDropped=${this.snapshotsDropped}`,
      );
    }
    return true;
  }

  private shouldDropForPendingFullCompression(playerId: PlayerId): boolean {
    if (!this.pendingFullCompressionPlayerIds.has(playerId)) return false;
    const playerDrops = this.recordDroppedSnapshot(playerId);
    if (GAME_DIAGNOSTICS.networkSnapshots && (playerDrops === 1 || playerDrops % 100 === 0)) {
      debugLog(
        true,
        `[NET] Dropping snapshot for player ${playerId}: pending FULLSNAP compression dropped=${playerDrops} totalDropped=${this.snapshotsDropped}`,
      );
    }
    return true;
  }

  private recordDroppedSnapshot(playerId: PlayerId): number {
    this.snapshotsDropped++;
    const playerDrops = (this.snapshotDropCounts.get(playerId) ?? 0) + 1;
    this.snapshotDropCounts.set(playerId, playerDrops);
    this.options.onSnapshotDropped?.(playerId);
    return playerDrops;
  }
}
