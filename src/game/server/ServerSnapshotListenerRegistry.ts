import { resetAudioPoolForKey } from '../network/stateSerializerAudio';
import { IndexedEntityIdSet } from '../network/IndexedEntityIdCollections';
import { resetMinimapPoolForKey } from '../network/stateSerializerMinimap';
import { resetSprayPoolForKey } from '../network/stateSerializerSpray';
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
    const cacheKey = playerId === undefined ? 'global-shared' : trackingKey;
    this.listeners.push({
      callback,
      playerId,
      trackingKey,
      cacheKey,
      preencodeWire: options.preencodeWire === true,
      lastStaticTerrainTileMap: undefined,
      lastStaticBuildabilityGrid: undefined,
      needsFullState: false,
      needsStatic: false,
      startupReady: false,
      hasVisibleEntityBaseline: false,
      visibleEntityIds: new IndexedEntityIdSet(),
    });
    return trackingKey;
  }

  /** Mark every listener for `playerId` so its next snapshot also
   *  re-carries static terrain/buildability when requested. Dynamic
   *  state is full every snapshot. */
  requestRecovery(playerId: PlayerId, includeStatic: boolean): void {
    for (const listener of this.listeners) {
      if (listener.playerId !== playerId) continue;
      listener.needsFullState = true;
      listener.hasVisibleEntityBaseline = false;
      listener.visibleEntityIds.clear();
      if (includeStatic) listener.needsStatic = true;
    }
  }

  markReady(trackingKey: string): void {
    this.startupReadyListenerKeys.add(trackingKey);
    for (let i = 0; i < this.listeners.length; i++) {
      const listener = this.listeners[i];
      if (listener.trackingKey !== trackingKey) continue;
      listener.startupReady = true;
      break;
    }
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
    let idx = -1;
    for (let i = 0; i < this.listeners.length; i++) {
      if (this.listeners[i].trackingKey !== trackingKey) continue;
      idx = i;
      break;
    }
    if (idx < 0) return;
    const [removed] = this.listeners.splice(idx, 1);
    this.startupReadyListenerKeys.delete(removed.trackingKey);
    let hasRemainingCacheListener = false;
    for (let i = 0; i < this.listeners.length; i++) {
      if (this.listeners[i].cacheKey !== removed.cacheKey) continue;
      hasRemainingCacheListener = true;
      break;
    }
    if (!hasRemainingCacheListener) {
      resetAudioPoolForKey(removed.cacheKey);
      resetSprayPoolForKey(removed.cacheKey);
      resetMinimapPoolForKey(removed.cacheKey);
    }
  }

  releaseAll(): void {
    while (this.listeners.length > 0) {
      this.remove(this.listeners[0].trackingKey);
    }
  }
}
