// Double-buffered snapshot accumulator.
// PeerJS callback stores snapshots instantly; update() consumes one per frame.
// One-shot events (spawns, despawns, audio, velocity) are accumulated across
// intermediate snapshots so none are lost even when frames are skipped.

import type {
  NetworkGameState,
  NetworkProjectileSpawn,
  NetworkProjectileDespawn,
  NetworkSimEvent,
  NetworkProjectileVelocityUpdate,
} from '../../network/NetworkTypes';
import type { GameConnection } from '../../server/GameConnection';

export class SnapshotBuffer {
  private pendingSnapshot: NetworkGameState | null = null;

  // Double-buffered event arrays (swap instead of allocating new arrays each frame)
  private _spawnsA: NetworkProjectileSpawn[] = [];
  private _spawnsB: NetworkProjectileSpawn[] = [];
  private bufferedSpawns: NetworkProjectileSpawn[] = this._spawnsA;

  private _despawnsA: NetworkProjectileDespawn[] = [];
  private _despawnsB: NetworkProjectileDespawn[] = [];
  private bufferedDespawns: NetworkProjectileDespawn[] = this._despawnsA;

  private _audioA: NetworkSimEvent[] = [];
  private _audioB: NetworkSimEvent[] = [];
  private bufferedAudio: NetworkSimEvent[] = this._audioA;

  private bufferedVelocityUpdates = new Map<number, NetworkProjectileVelocityUpdate>();
  private _velBufA: NetworkProjectileVelocityUpdate[] = [];
  private _velBufB: NetworkProjectileVelocityUpdate[] = [];
  private _velBufToggle = false;

  /** Wire the gameConnection snapshot callback to accumulate events. */
  attach(gameConnection: GameConnection): void {
    gameConnection.onSnapshot((state: NetworkGameState) => {
      if (state.projectileSpawns) {
        for (let i = 0; i < state.projectileSpawns.length; i++) {
          this.bufferedSpawns.push(state.projectileSpawns[i]);
        }
      }
      if (state.projectileDespawns) {
        for (let i = 0; i < state.projectileDespawns.length; i++) {
          this.bufferedDespawns.push(state.projectileDespawns[i]);
        }
      }
      if (state.audioEvents) {
        for (let i = 0; i < state.audioEvents.length; i++) {
          this.bufferedAudio.push(state.audioEvents[i]);
        }
      }
      if (state.projectileVelocityUpdates) {
        for (let i = 0; i < state.projectileVelocityUpdates.length; i++) {
          const vu = state.projectileVelocityUpdates[i];
          this.bufferedVelocityUpdates.set(vu.id, vu);
        }
      }
      this.pendingSnapshot = state;
    });
  }

  /**
   * Consume the latest buffered snapshot with all accumulated events attached.
   * Returns null if no snapshot is pending. Swaps double buffers (zero allocation).
   */
  consume(): NetworkGameState | null {
    if (!this.pendingSnapshot) return null;

    const state = this.pendingSnapshot;
    this.pendingSnapshot = null;

    // Swap spawns
    const spawns = this.bufferedSpawns;
    this.bufferedSpawns = (spawns === this._spawnsA) ? this._spawnsB : this._spawnsA;
    this.bufferedSpawns.length = 0;
    state.projectileSpawns = spawns.length > 0 ? spawns : undefined;

    // Swap despawns
    const despawns = this.bufferedDespawns;
    this.bufferedDespawns = (despawns === this._despawnsA) ? this._despawnsB : this._despawnsA;
    this.bufferedDespawns.length = 0;
    state.projectileDespawns = despawns.length > 0 ? despawns : undefined;

    // Swap audio
    const audio = this.bufferedAudio;
    this.bufferedAudio = (audio === this._audioA) ? this._audioB : this._audioA;
    this.bufferedAudio.length = 0;
    state.audioEvents = audio.length > 0 ? audio : undefined;

    // Swap velocity updates
    if (this.bufferedVelocityUpdates.size > 0) {
      const buf = this._velBufToggle ? this._velBufB : this._velBufA;
      this._velBufToggle = !this._velBufToggle;
      buf.length = 0;
      for (const v of this.bufferedVelocityUpdates.values()) buf.push(v);
      this.bufferedVelocityUpdates.clear();
      state.projectileVelocityUpdates = buf;
    } else {
      state.projectileVelocityUpdates = undefined;
    }

    return state;
  }

  /** Release all buffered data. */
  clear(): void {
    this.pendingSnapshot = null;
    this._spawnsA.length = 0;
    this._spawnsB.length = 0;
    this._despawnsA.length = 0;
    this._despawnsB.length = 0;
    this._audioA.length = 0;
    this._audioB.length = 0;
    this.bufferedVelocityUpdates.clear();
    this._velBufA.length = 0;
    this._velBufB.length = 0;
  }
}
