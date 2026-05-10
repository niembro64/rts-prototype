import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';
import type { DataConnection } from 'peerjs';
import { GAME_DIAGNOSTICS, debugLog } from '../diagnostics';
import type { NetworkMessage, NetworkServerSnapshot } from './NetworkTypes';
import type { PlayerId } from '../sim/types';

const SNAPSHOT_BACKPRESSURE_DROP_BYTES = 2 * 1024 * 1024;

// Snapshot DTOs are pooled, so optional fields stay as own properties
// assigned to `undefined`. Default msgpack encodes those as `nil`,
// which the client decodes as `null` and treats as a present value
// (e.g. `metalExtractionRate !== undefined` would fire on null).
// `ignoreUndefined: true` makes msgpack skip those keys entirely,
// matching `JSON.stringify`'s behavior.
const SNAPSHOT_ENCODE_OPTIONS = { ignoreUndefined: true } as const;

export class NetworkSnapshotTransport {
  private snapshotsSent = 0;
  private snapshotsReceived = 0;
  private snapshotsDropped = 0;
  private snapshotDropCounts: Map<PlayerId, number> = new Map();
  private pendingReceivedState: NetworkServerSnapshot | null = null;

  buildStateMessage(
    playerId: PlayerId,
    conn: DataConnection,
    gameId: string,
    state: NetworkServerSnapshot,
  ): NetworkMessage | null {
    if (this.shouldDropForBackpressure(playerId, conn)) return null;

    this.snapshotsSent++;
    const buf = msgpackEncode(state, SNAPSHOT_ENCODE_OPTIONS);

    if (GAME_DIAGNOSTICS.networkSnapshots && this.snapshotsSent % 100 === 0) {
      const dc = conn.dataChannel;
      const buffered = dc ? dc.bufferedAmount : -1;
      const dcState = dc ? dc.readyState : 'no-dc';
      debugLog(
        true,
        `[NET] Host snapshot #${this.snapshotsSent} -> player ${playerId}: open=${conn.open} dc=${dcState} buffered=${buffered} size=${buf.byteLength} dropped=${this.snapshotDropCounts.get(playerId) ?? 0}`,
      );
    }

    return {
      type: 'state',
      gameId,
      data: buf,
    };
  }

  decodeReceivedState(raw: unknown, hostDataChannel?: RTCDataChannel): NetworkServerSnapshot {
    this.snapshotsReceived++;
    if (GAME_DIAGNOSTICS.networkSnapshots && this.snapshotsReceived % 100 === 0) {
      debugLog(
        true,
        `[NET] Client received snapshot #${this.snapshotsReceived} (dc=${hostDataChannel?.readyState ?? 'none'})`,
      );
    }

    if (raw instanceof Uint8Array) return msgpackDecode(raw) as NetworkServerSnapshot;
    if (raw instanceof ArrayBuffer) return msgpackDecode(new Uint8Array(raw)) as NetworkServerSnapshot;
    if (typeof raw === 'string') return JSON.parse(raw);
    return raw as NetworkServerSnapshot;
  }

  storePendingState(state: NetworkServerSnapshot): void {
    if (!this.pendingReceivedState || (this.pendingReceivedState.isDelta && !state.isDelta)) {
      this.pendingReceivedState = state;
    }
  }

  consumePendingState(): NetworkServerSnapshot | null {
    const state = this.pendingReceivedState;
    this.pendingReceivedState = null;
    return state;
  }

  clearPlayer(playerId: PlayerId): void {
    this.snapshotDropCounts.delete(playerId);
  }

  reset(): void {
    this.pendingReceivedState = null;
    this.snapshotDropCounts.clear();
    this.snapshotsDropped = 0;
  }

  private shouldDropForBackpressure(playerId: PlayerId, conn: DataConnection): boolean {
    const dc = conn.dataChannel;
    if (!conn.open || !dc || dc.readyState !== 'open') return true;
    if (dc.bufferedAmount < SNAPSHOT_BACKPRESSURE_DROP_BYTES) return false;

    this.snapshotsDropped++;
    const playerDrops = (this.snapshotDropCounts.get(playerId) ?? 0) + 1;
    this.snapshotDropCounts.set(playerId, playerDrops);
    if (GAME_DIAGNOSTICS.networkSnapshots && (playerDrops === 1 || playerDrops % 100 === 0)) {
      debugLog(
        true,
        `[NET] Dropping snapshot for player ${playerId}: data channel buffered=${dc.bufferedAmount} dropped=${playerDrops} totalDropped=${this.snapshotsDropped}`,
      );
    }
    return true;
  }
}
