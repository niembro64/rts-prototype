// Double-buffered snapshot accumulator.
// PeerJS callback stores snapshots instantly; update() consumes one per frame.
// One-shot events are accumulated across intermediate snapshots. Critical
// cleanup streams stay unbounded; visual-heavy streams are capped so a stalled
// frame cannot turn thousands of projectile/effect events into a long catch-up
// hitch.

import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotVelocityUpdate,
} from '../../network/NetworkTypes';
import type { GameConnection } from '../../server/GameConnection';
import { ReusableNetworkSnapshotCloner } from '../../network/snapshotClone';
import {
  copyBeamInto,
  copySimEventInto,
  copySpawnInto,
  copyVelocityInto,
  createBeamDto,
  createSimEventDto,
  createSpawnDto,
  createVelocityDto,
} from '../../network/snapshotDtoCopy';

const MAX_BUFFERED_PROJECTILE_SPAWNS = 4096;
const MAX_BUFFERED_SIM_EVENTS = 512;

export class SnapshotBuffer {
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private fullSnapshotCloner = new ReusableNetworkSnapshotCloner();

  // Double-buffered event arrays (swap instead of allocating new arrays each frame)
  private _spawnsA: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsB: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsPoolA: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsPoolB: NetworkServerSnapshotProjectileSpawn[] = [];
  private bufferedSpawns: NetworkServerSnapshotProjectileSpawn[] = this._spawnsA;
  private bufferedSpawnsPool: NetworkServerSnapshotProjectileSpawn[] = this._spawnsPoolA;
  private bufferedSpawnOverwriteIndex = 0;

  private _despawnsA: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnsB: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnsPoolA: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnsPoolB: NetworkServerSnapshotProjectileDespawn[] = [];
  private bufferedDespawns: NetworkServerSnapshotProjectileDespawn[] = this._despawnsA;
  private bufferedDespawnsPool: NetworkServerSnapshotProjectileDespawn[] = this._despawnsPoolA;

  private _audioA: NetworkServerSnapshotSimEvent[] = [];
  private _audioB: NetworkServerSnapshotSimEvent[] = [];
  private _audioPoolA: NetworkServerSnapshotSimEvent[] = [];
  private _audioPoolB: NetworkServerSnapshotSimEvent[] = [];
  private bufferedAudio: NetworkServerSnapshotSimEvent[] = this._audioA;
  private bufferedAudioPool: NetworkServerSnapshotSimEvent[] = this._audioPoolA;
  private bufferedAudioOverwriteIndex = 0;

  private bufferedVelocityUpdates = new Map<number, NetworkServerSnapshotVelocityUpdate>();
  private velocityStagePool: NetworkServerSnapshotVelocityUpdate[] = [];
  private velocityStagePoolIndex = 0;
  private _velBufA: NetworkServerSnapshotVelocityUpdate[] = [];
  private _velBufB: NetworkServerSnapshotVelocityUpdate[] = [];
  private _velPoolA: NetworkServerSnapshotVelocityUpdate[] = [];
  private _velPoolB: NetworkServerSnapshotVelocityUpdate[] = [];
  private _velBufToggle = false;

  private bufferedBeamUpdates = new Map<number, NetworkServerSnapshotBeamUpdate>();
  private beamStagePool: NetworkServerSnapshotBeamUpdate[] = [];
  private beamStagePoolIndex = 0;
  private _beamBufA: NetworkServerSnapshotBeamUpdate[] = [];
  private _beamBufB: NetworkServerSnapshotBeamUpdate[] = [];
  private _beamPoolA: NetworkServerSnapshotBeamUpdate[] = [];
  private _beamPoolB: NetworkServerSnapshotBeamUpdate[] = [];
  private _beamBufToggle = false;
  private bufferedGrid: NetworkServerSnapshot['grid'];

  private pushBufferedSpawn(spawn: NetworkServerSnapshotProjectileSpawn): void {
    let index = this.bufferedSpawns.length;
    if (index >= MAX_BUFFERED_PROJECTILE_SPAWNS) {
      index = this.bufferedSpawnOverwriteIndex % MAX_BUFFERED_PROJECTILE_SPAWNS;
      this.bufferedSpawnOverwriteIndex++;
    }
    const out = this.bufferedSpawnsPool[index] ?? createSpawnDto();
    this.bufferedSpawnsPool[index] = out;
    const copied = copySpawnInto(spawn, out);
    if (index === this.bufferedSpawns.length) this.bufferedSpawns.push(copied);
    else this.bufferedSpawns[index] = copied;
  }

  private pushBufferedAudio(event: NetworkServerSnapshotSimEvent): void {
    let index = this.bufferedAudio.length;
    if (index >= MAX_BUFFERED_SIM_EVENTS) {
      index = this.bufferedAudioOverwriteIndex % MAX_BUFFERED_SIM_EVENTS;
      this.bufferedAudioOverwriteIndex++;
    }
    const out = this.bufferedAudioPool[index] ?? createSimEventDto();
    this.bufferedAudioPool[index] = out;
    const copied = copySimEventInto(event, out);
    if (index === this.bufferedAudio.length) this.bufferedAudio.push(copied);
    else this.bufferedAudio[index] = copied;
  }

  /** Wire the gameConnection snapshot callback to accumulate events. */
  attach(gameConnection: GameConnection): void {
    gameConnection.onSnapshot((state: NetworkServerSnapshot) => {
      const proj = state.projectiles;
      if (proj?.spawns) {
        for (let i = 0; i < proj.spawns.length; i++) {
          this.pushBufferedSpawn(proj.spawns[i]);
        }
      }
      if (proj?.despawns) {
        for (let i = 0; i < proj.despawns.length; i++) {
          const index = this.bufferedDespawns.length;
          const out = this.bufferedDespawnsPool[index] ?? { id: 0 };
          this.bufferedDespawnsPool[index] = out;
          out.id = proj.despawns[i].id;
          this.bufferedDespawns.push(out);
        }
      }
      if (state.audioEvents) {
        for (let i = 0; i < state.audioEvents.length; i++) {
          this.pushBufferedAudio(state.audioEvents[i]);
        }
      }
      if (proj?.velocityUpdates) {
        for (let i = 0; i < proj.velocityUpdates.length; i++) {
          const vu = proj.velocityUpdates[i];
          let out = this.bufferedVelocityUpdates.get(vu.id);
          if (!out) {
            out = this.velocityStagePool[this.velocityStagePoolIndex] ?? createVelocityDto();
            this.velocityStagePool[this.velocityStagePoolIndex] = out;
            this.velocityStagePoolIndex++;
            this.bufferedVelocityUpdates.set(vu.id, out);
          }
          this.bufferedVelocityUpdates.set(vu.id, copyVelocityInto(vu, out));
        }
      }
      if (proj?.beamUpdates) {
        for (let i = 0; i < proj.beamUpdates.length; i++) {
          const bu = proj.beamUpdates[i];
          let out = this.bufferedBeamUpdates.get(bu.id);
          if (!out) {
            out = this.beamStagePool[this.beamStagePoolIndex] ?? createBeamDto();
            this.beamStagePool[this.beamStagePoolIndex] = out;
            this.beamStagePoolIndex++;
            this.bufferedBeamUpdates.set(bu.id, out);
          }
          this.bufferedBeamUpdates.set(bu.id, copyBeamInto(bu, out));
        }
      }
      if (state.grid) {
        this.bufferedGrid = state.grid;
      } else if (state.serverMeta?.grid === false) {
        this.bufferedGrid = undefined;
      }
      // Never let startup deltas overwrite an unapplied full
      // keyframe. A delta cannot create entities that the client has
      // never seen, so dropping the first full snapshot during the
      // lobby -> real-battle scene transition leaves the map empty
      // until the next keyframe. Full snapshots are cloned because
      // the local server reuses its serializer object for later deltas.
      // The cloner reuses its destination object graph so full
      // keyframes do not allocate a fresh 10k-entity tree each time.
      if (!this.pendingSnapshot || !state.isDelta || this.pendingSnapshot.isDelta) {
        this.pendingSnapshot = state.isDelta
          ? state
          : this.fullSnapshotCloner.clone(state);
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
    this.bufferedSpawnsPool = (spawns === this._spawnsA) ? this._spawnsPoolB : this._spawnsPoolA;
    this.bufferedSpawns.length = 0;
    this.bufferedSpawnOverwriteIndex = 0;
    const netSpawns = spawns.length > 0 ? spawns : undefined;

    // Swap despawns
    const despawns = this.bufferedDespawns;
    this.bufferedDespawns = (despawns === this._despawnsA) ? this._despawnsB : this._despawnsA;
    this.bufferedDespawnsPool = (despawns === this._despawnsA) ? this._despawnsPoolB : this._despawnsPoolA;
    this.bufferedDespawns.length = 0;
    const netDespawns = despawns.length > 0 ? despawns : undefined;

    // Swap audio
    const audio = this.bufferedAudio;
    this.bufferedAudio = (audio === this._audioA) ? this._audioB : this._audioA;
    this.bufferedAudioPool = (audio === this._audioA) ? this._audioPoolB : this._audioPoolA;
    this.bufferedAudio.length = 0;
    this.bufferedAudioOverwriteIndex = 0;
    state.audioEvents = audio.length > 0 ? audio : undefined;

    // Swap velocity updates
    let netVelUpdates: NetworkServerSnapshotVelocityUpdate[] | undefined;
    if (this.bufferedVelocityUpdates.size > 0) {
      const buf = this._velBufToggle ? this._velBufB : this._velBufA;
      const pool = this._velBufToggle ? this._velPoolB : this._velPoolA;
      this._velBufToggle = !this._velBufToggle;
      buf.length = 0;
      let writeIdx = 0;
      for (const v of this.bufferedVelocityUpdates.values()) {
        const out = pool[writeIdx] ?? createVelocityDto();
        pool[writeIdx] = out;
        buf.push(copyVelocityInto(v, out));
        writeIdx++;
      }
      this.bufferedVelocityUpdates.clear();
      this.velocityStagePoolIndex = 0;
      netVelUpdates = buf;
    }

    // Swap beam updates. Keep only the newest path per beam; live
    // beams are continuous state, not one-shot events.
    let netBeamUpdates: NetworkServerSnapshotBeamUpdate[] | undefined;
    if (this.bufferedBeamUpdates.size > 0) {
      const buf = this._beamBufToggle ? this._beamBufB : this._beamBufA;
      const pool = this._beamBufToggle ? this._beamPoolB : this._beamPoolA;
      this._beamBufToggle = !this._beamBufToggle;
      buf.length = 0;
      let writeIdx = 0;
      for (const b of this.bufferedBeamUpdates.values()) {
        const out = pool[writeIdx] ?? createBeamDto();
        pool[writeIdx] = out;
        buf.push(copyBeamInto(b, out));
        writeIdx++;
      }
      this.bufferedBeamUpdates.clear();
      this.beamStagePoolIndex = 0;
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

    if (!state.grid && this.bufferedGrid && state.serverMeta?.grid !== false) {
      state.grid = this.bufferedGrid;
    }
    if (state.grid === this.bufferedGrid) {
      this.bufferedGrid = undefined;
    }

    return state;
  }

  /** Release all buffered data. */
  clear(): void {
    this.pendingSnapshot = null;
    this.fullSnapshotCloner.clear();
    this._spawnsA.length = 0;
    this._spawnsB.length = 0;
    this._spawnsPoolA.length = 0;
    this._spawnsPoolB.length = 0;
    this.bufferedSpawnOverwriteIndex = 0;
    this._despawnsA.length = 0;
    this._despawnsB.length = 0;
    this._despawnsPoolA.length = 0;
    this._despawnsPoolB.length = 0;
    this._audioA.length = 0;
    this._audioB.length = 0;
    this._audioPoolA.length = 0;
    this._audioPoolB.length = 0;
    this.bufferedAudioOverwriteIndex = 0;
    this.bufferedVelocityUpdates.clear();
    this.velocityStagePool.length = 0;
    this.velocityStagePoolIndex = 0;
    this.bufferedBeamUpdates.clear();
    this.beamStagePool.length = 0;
    this.beamStagePoolIndex = 0;
    this.bufferedGrid = undefined;
    this._velBufA.length = 0;
    this._velBufB.length = 0;
    this._velPoolA.length = 0;
    this._velPoolB.length = 0;
    this._beamBufA.length = 0;
    this._beamBufB.length = 0;
    this._beamPoolA.length = 0;
    this._beamPoolB.length = 0;
  }
}
