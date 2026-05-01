// Double-buffered snapshot accumulator.
// PeerJS callback stores snapshots instantly; update() consumes one per frame.
// One-shot events (spawns, despawns, audio, velocity) are accumulated across
// intermediate snapshots so none are lost even when frames are skipped.

import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotVelocityUpdate,
} from '../../network/NetworkTypes';
import type { GameConnection } from '../../server/GameConnection';
import { cloneNetworkSnapshot } from '../../network/snapshotClone';

export class SnapshotBuffer {
  private pendingSnapshot: NetworkServerSnapshot | null = null;

  // Double-buffered event arrays (swap instead of allocating new arrays each frame)
  private _spawnsA: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsB: NetworkServerSnapshotProjectileSpawn[] = [];
  private bufferedSpawns: NetworkServerSnapshotProjectileSpawn[] = this._spawnsA;

  private _despawnsA: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnsB: NetworkServerSnapshotProjectileDespawn[] = [];
  private bufferedDespawns: NetworkServerSnapshotProjectileDespawn[] = this._despawnsA;

  private _audioA: NetworkServerSnapshotSimEvent[] = [];
  private _audioB: NetworkServerSnapshotSimEvent[] = [];
  private bufferedAudio: NetworkServerSnapshotSimEvent[] = this._audioA;

  private bufferedVelocityUpdates = new Map<number, NetworkServerSnapshotVelocityUpdate>();
  private _velBufA: NetworkServerSnapshotVelocityUpdate[] = [];
  private _velBufB: NetworkServerSnapshotVelocityUpdate[] = [];
  private _velBufToggle = false;

  private bufferedBeamUpdates = new Map<number, NetworkServerSnapshotBeamUpdate>();
  private _beamBufA: NetworkServerSnapshotBeamUpdate[] = [];
  private _beamBufB: NetworkServerSnapshotBeamUpdate[] = [];
  private _beamBufToggle = false;

  /** Wire the gameConnection snapshot callback to accumulate events. */
  attach(gameConnection: GameConnection): void {
    gameConnection.onSnapshot((state: NetworkServerSnapshot) => {
      const proj = state.projectiles;
      if (proj?.spawns) {
        for (let i = 0; i < proj.spawns.length; i++) {
          this.bufferedSpawns.push(proj.spawns[i]);
        }
      }
      if (proj?.despawns) {
        for (let i = 0; i < proj.despawns.length; i++) {
          this.bufferedDespawns.push(proj.despawns[i]);
        }
      }
      if (state.audioEvents) {
        for (let i = 0; i < state.audioEvents.length; i++) {
          this.bufferedAudio.push(state.audioEvents[i]);
        }
      }
      if (proj?.velocityUpdates) {
        for (let i = 0; i < proj.velocityUpdates.length; i++) {
          const vu = proj.velocityUpdates[i];
          this.bufferedVelocityUpdates.set(vu.id, vu);
        }
      }
      if (proj?.beamUpdates) {
        for (let i = 0; i < proj.beamUpdates.length; i++) {
          const bu = proj.beamUpdates[i];
          this.bufferedBeamUpdates.set(bu.id, bu);
        }
      }
      // Never let startup deltas overwrite an unapplied full
      // keyframe. A delta cannot create entities that the client has
      // never seen, so dropping the first full snapshot during the
      // lobby -> real-battle scene transition leaves the map empty
      // until the next keyframe. Full snapshots are cloned because
      // the local server reuses its serializer object for later deltas.
      if (!this.pendingSnapshot || !state.isDelta || this.pendingSnapshot.isDelta) {
        this.pendingSnapshot = state.isDelta
          ? state
          : cloneNetworkSnapshot(state);
      }
    });
  }

  /**
   * Consume the latest buffered snapshot with all accumulated events attached.
   * Returns null if no snapshot is pending. Swaps double buffers (zero allocation).
   */
  consume(): NetworkServerSnapshot | null {
    if (!this.pendingSnapshot) return null;

    const state = this.pendingSnapshot;
    this.pendingSnapshot = null;

    // Swap spawns
    const spawns = this.bufferedSpawns;
    this.bufferedSpawns = (spawns === this._spawnsA) ? this._spawnsB : this._spawnsA;
    this.bufferedSpawns.length = 0;
    const netSpawns = spawns.length > 0 ? spawns : undefined;

    // Swap despawns
    const despawns = this.bufferedDespawns;
    this.bufferedDespawns = (despawns === this._despawnsA) ? this._despawnsB : this._despawnsA;
    this.bufferedDespawns.length = 0;
    const netDespawns = despawns.length > 0 ? despawns : undefined;

    // Swap audio
    const audio = this.bufferedAudio;
    this.bufferedAudio = (audio === this._audioA) ? this._audioB : this._audioA;
    this.bufferedAudio.length = 0;
    state.audioEvents = audio.length > 0 ? audio : undefined;

    // Swap velocity updates
    let netVelUpdates: NetworkServerSnapshotVelocityUpdate[] | undefined;
    if (this.bufferedVelocityUpdates.size > 0) {
      const buf = this._velBufToggle ? this._velBufB : this._velBufA;
      this._velBufToggle = !this._velBufToggle;
      buf.length = 0;
      for (const v of this.bufferedVelocityUpdates.values()) buf.push(v);
      this.bufferedVelocityUpdates.clear();
      netVelUpdates = buf;
    }

    // Swap beam updates. Keep only the newest path per beam; live
    // beams are continuous state, not one-shot events.
    let netBeamUpdates: NetworkServerSnapshotBeamUpdate[] | undefined;
    if (this.bufferedBeamUpdates.size > 0) {
      const buf = this._beamBufToggle ? this._beamBufB : this._beamBufA;
      this._beamBufToggle = !this._beamBufToggle;
      buf.length = 0;
      for (const b of this.bufferedBeamUpdates.values()) buf.push(b);
      this.bufferedBeamUpdates.clear();
      netBeamUpdates = buf;
    }

    // Write back nested projectiles
    const hasProjectiles = netSpawns || netDespawns || netVelUpdates || netBeamUpdates;
    if (hasProjectiles) {
      if (!state.projectiles) state.projectiles = {};
      state.projectiles.spawns = netSpawns;
      state.projectiles.despawns = netDespawns;
      state.projectiles.velocityUpdates = netVelUpdates;
      state.projectiles.beamUpdates = netBeamUpdates;
    } else {
      state.projectiles = undefined;
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
    this.bufferedBeamUpdates.clear();
    this._velBufA.length = 0;
    this._velBufB.length = 0;
    this._beamBufA.length = 0;
    this._beamBufB.length = 0;
  }
}
