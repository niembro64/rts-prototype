import type { DataConnection } from 'peerjs';
import type { PlayerId } from '../sim/types';

type DataChannelListenerEntry = {
  dc: RTCDataChannel;
  onClose: () => void;
  onError: (event: Event) => void;
};

export class NetworkDataChannelMonitor {
  private listeners: Map<PlayerId, DataChannelListenerEntry> = new Map();
  private waitIntervals: Map<PlayerId, ReturnType<typeof setInterval>> = new Map();

  attach(conn: DataConnection, playerId: PlayerId): void {
    this.detach(playerId);

    const dc = conn.dataChannel;
    if (dc) {
      this.monitorDataChannel(dc, playerId);
      return;
    }

    let dcAttempts = 0;
    const checkDc = setInterval(() => {
      dcAttempts++;
      if (conn.dataChannel) {
        this.monitorDataChannel(conn.dataChannel, playerId);
        clearInterval(checkDc);
        this.waitIntervals.delete(playerId);
      } else if (dcAttempts > 50) {
        clearInterval(checkDc);
        this.waitIntervals.delete(playerId);
      }
    }, 100);
    this.waitIntervals.set(playerId, checkDc);
  }

  detach(playerId: PlayerId): void {
    const wait = this.waitIntervals.get(playerId);
    if (wait !== undefined) {
      clearInterval(wait);
      this.waitIntervals.delete(playerId);
    }

    const entry = this.listeners.get(playerId);
    if (!entry) return;
    entry.dc.removeEventListener('close', entry.onClose);
    entry.dc.removeEventListener('error', entry.onError);
    this.listeners.delete(playerId);
  }

  clear(): void {
    const playerIds = new Set<PlayerId>([
      ...this.waitIntervals.keys(),
      ...this.listeners.keys(),
    ]);
    for (const playerId of playerIds) {
      this.detach(playerId);
    }
  }

  private monitorDataChannel(dc: RTCDataChannel, playerId: PlayerId): void {
    this.detach(playerId);
    const onClose = () => {
      console.warn(`[NET] DataChannel CLOSED for player ${playerId} (state=${dc.readyState})`);
    };
    const onError = (event: Event) => {
      console.error(`[NET] DataChannel ERROR for player ${playerId}:`, event);
    };
    dc.addEventListener('close', onClose);
    dc.addEventListener('error', onError);
    this.listeners.set(playerId, { dc, onClose, onError });
  }
}
