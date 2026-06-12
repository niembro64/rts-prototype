import { resetDeltaTrackingForKey } from '../network/stateSerializer';
import { resetAudioPoolForKey } from '../network/stateSerializerAudio';
import { resetMinimapPoolForKey } from '../network/stateSerializerMinimap';
import { resetSprayPoolForKey } from '../network/stateSerializerSpray';
import { getSimWasm } from '../sim-wasm/init';
import type { PlayerId } from '../sim/types';
import type { SnapshotCallback } from './GameConnection';
import type { SnapshotListenerEntry } from './ServerSnapshotPublisher';

export type SnapshotListenerOptions = {
  preencodeWire?: boolean;
};

export class ServerSnapshotListenerRegistry {
  private readonly listeners: SnapshotListenerEntry[] = [];
  private readonly startupReadyListenerKeys = new Set<string>();
  private nextListenerId = 0;

  get entries(): readonly SnapshotListenerEntry[] {
    return this.listeners;
  }

  get count(): number {
    return this.listeners.length;
  }

  add(
    callback: SnapshotCallback,
    playerId: PlayerId | undefined = undefined,
    options: SnapshotListenerOptions = {},
  ): string {
    const trackingScope = playerId === undefined ? 'global' : `player-${playerId}`;
    const trackingKey = `${trackingScope}-${this.nextListenerId++}`;
    const deltaTrackingKey = playerId === undefined ? 'global-shared' : trackingKey;
    const simWasm = getSimWasm();
    const snapshotBaselineHandle = simWasm === undefined
      ? undefined
      : simWasm.snapshotBaseline.create();
    this.listeners.push({
      callback,
      playerId,
      trackingKey,
      deltaTrackingKey,
      preencodeWire: options.preencodeWire === true,
      lastStaticTerrainTileMap: undefined,
      lastStaticBuildabilityGrid: undefined,
      needsKeyframe: false,
      needsStatic: false,
      startupReady: false,
      snapshotBaselineHandle,
    });
    return trackingKey;
  }

  /** Mark every listener for `playerId` so its next snapshot is a
   *  keyframe (optionally re-carrying the static terrain payload).
   *  Recovery is per-listener: other players keep their delta streams. */
  requestRecovery(playerId: PlayerId, includeStatic: boolean): void {
    for (const listener of this.listeners) {
      if (listener.playerId !== playerId) continue;
      listener.needsKeyframe = true;
      if (includeStatic) listener.needsStatic = true;
    }
  }

  markReady(trackingKey: string): void {
    this.startupReadyListenerKeys.add(trackingKey);
    const listener = this.listeners.find((entry) => entry.trackingKey === trackingKey);
    if (listener !== undefined) listener.startupReady = true;
  }

  markPlayerReady(playerId: PlayerId): void {
    for (const listener of this.listeners) {
      if (listener.playerId === playerId) {
        this.startupReadyListenerKeys.add(listener.trackingKey);
        listener.startupReady = true;
      }
    }
  }

  areStartupListenersReady(): boolean {
    if (this.listeners.length === 0) return true;
    for (const listener of this.listeners) {
      if (!this.startupReadyListenerKeys.has(listener.trackingKey)) return false;
    }
    return true;
  }

  clearStartupReady(): void {
    this.startupReadyListenerKeys.clear();
    for (const listener of this.listeners) listener.startupReady = false;
  }

  remove(trackingKey: string): void {
    const idx = this.listeners.findIndex((listener) => listener.trackingKey === trackingKey);
    if (idx < 0) return;
    const [removed] = this.listeners.splice(idx, 1);
    this.startupReadyListenerKeys.delete(removed.trackingKey);
    if (removed.snapshotBaselineHandle !== undefined) {
      const simWasm = getSimWasm();
      if (simWasm !== undefined) {
        simWasm.snapshotBaseline.destroy(removed.snapshotBaselineHandle);
      }
    }
    if (!this.listeners.some((listener) => listener.deltaTrackingKey === removed.deltaTrackingKey)) {
      resetDeltaTrackingForKey(removed.deltaTrackingKey);
    }
    resetAudioPoolForKey(removed.deltaTrackingKey);
    resetSprayPoolForKey(removed.deltaTrackingKey);
    resetMinimapPoolForKey(removed.deltaTrackingKey);
  }

  releaseAll(): void {
    while (this.listeners.length > 0) {
      this.remove(this.listeners[0].trackingKey);
    }
  }
}
