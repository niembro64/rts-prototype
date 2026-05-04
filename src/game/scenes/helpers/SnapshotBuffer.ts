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
  NetworkServerSnapshotBeamPoint,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotVelocityUpdate,
} from '../../network/NetworkTypes';
import type { GameConnection } from '../../server/GameConnection';
import { ReusableNetworkSnapshotCloner } from '../../network/snapshotClone';
import type { Vec3 } from '@/types/vec2';
import { PROJECTILE_TYPE_UNKNOWN, TURRET_ID_UNKNOWN } from '@/types/network';

const MAX_BUFFERED_PROJECTILE_SPAWNS = 4096;
const MAX_BUFFERED_SIM_EVENTS = 512;

type BufferedSpawn = NetworkServerSnapshotProjectileSpawn & {
  _pos: Vec3;
  _velocity: Vec3;
  _beamStart: Vec3;
  _beamEnd: Vec3;
  _beam: { start: Vec3; end: Vec3 };
};

type BufferedVelocityUpdate = NetworkServerSnapshotVelocityUpdate & {
  _pos: Vec3;
  _velocity: Vec3;
};

type BufferedBeamUpdate = NetworkServerSnapshotBeamUpdate & {
  _points: NetworkServerSnapshotBeamPoint[];
};

type BufferedSimEvent = NetworkServerSnapshotSimEvent & {
  _pos: Vec3;
};

function createBufferedSpawn(): BufferedSpawn {
  const spawn: BufferedSpawn = {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    rotation: 0,
    velocity: { x: 0, y: 0, z: 0 },
    projectileType: PROJECTILE_TYPE_UNKNOWN,
    turretId: TURRET_ID_UNKNOWN,
    shotId: undefined,
    sourceTurretId: undefined,
    playerId: 1,
    sourceEntityId: 0,
    turretIndex: 0,
    barrelIndex: 0,
    _pos: { x: 0, y: 0, z: 0 },
    _velocity: { x: 0, y: 0, z: 0 },
    _beamStart: { x: 0, y: 0, z: 0 },
    _beamEnd: { x: 0, y: 0, z: 0 },
    _beam: { start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } },
  };
  spawn.pos = spawn._pos;
  spawn.velocity = spawn._velocity;
  spawn._beam.start = spawn._beamStart;
  spawn._beam.end = spawn._beamEnd;
  return spawn;
}

function copySpawnInto(src: NetworkServerSnapshotProjectileSpawn, dst: BufferedSpawn): BufferedSpawn {
  dst.id = src.id;
  dst._pos.x = src.pos.x;
  dst._pos.y = src.pos.y;
  dst._pos.z = src.pos.z;
  dst.rotation = src.rotation;
  dst._velocity.x = src.velocity.x;
  dst._velocity.y = src.velocity.y;
  dst._velocity.z = src.velocity.z;
  dst.projectileType = src.projectileType;
  dst.maxLifespan = src.maxLifespan;
  dst.turretId = src.turretId;
  dst.shotId = src.shotId;
  dst.sourceTurretId = src.sourceTurretId;
  dst.playerId = src.playerId;
  dst.sourceEntityId = src.sourceEntityId;
  dst.turretIndex = src.turretIndex;
  dst.barrelIndex = src.barrelIndex;
  dst.isDGun = src.isDGun;
  dst.fromParentDetonation = src.fromParentDetonation;
  if (src.beam) {
    dst._beamStart.x = src.beam.start.x;
    dst._beamStart.y = src.beam.start.y;
    dst._beamStart.z = src.beam.start.z;
    dst._beamEnd.x = src.beam.end.x;
    dst._beamEnd.y = src.beam.end.y;
    dst._beamEnd.z = src.beam.end.z;
    dst.beam = dst._beam;
  } else {
    dst.beam = undefined;
  }
  dst.targetEntityId = src.targetEntityId;
  dst.homingTurnRate = src.homingTurnRate;
  return dst;
}

function createBufferedVelocityUpdate(): BufferedVelocityUpdate {
  const update: BufferedVelocityUpdate = {
    id: 0,
    pos: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    _pos: { x: 0, y: 0, z: 0 },
    _velocity: { x: 0, y: 0, z: 0 },
  };
  update.pos = update._pos;
  update.velocity = update._velocity;
  return update;
}

function copyVelocityInto(
  src: NetworkServerSnapshotVelocityUpdate,
  dst: BufferedVelocityUpdate,
): BufferedVelocityUpdate {
  dst.id = src.id;
  dst._pos.x = src.pos.x;
  dst._pos.y = src.pos.y;
  dst._pos.z = src.pos.z;
  dst._velocity.x = src.velocity.x;
  dst._velocity.y = src.velocity.y;
  dst._velocity.z = src.velocity.z;
  return dst;
}

function createBufferedBeamUpdate(): BufferedBeamUpdate {
  const update: BufferedBeamUpdate = {
    id: 0,
    points: [],
    _points: [],
  };
  update.points = update._points;
  return update;
}

function copyBeamInto(src: NetworkServerSnapshotBeamUpdate, dst: BufferedBeamUpdate): BufferedBeamUpdate {
  dst.id = src.id;
  dst.obstructionT = src.obstructionT;
  const dstPts = dst._points;
  dstPts.length = src.points.length;
  for (let i = 0; i < src.points.length; i++) {
    const sp = src.points[i];
    let dp = dstPts[i];
    if (!dp) {
      dp = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      dstPts[i] = dp;
    }
    dp.x = sp.x; dp.y = sp.y; dp.z = sp.z;
    dp.vx = sp.vx; dp.vy = sp.vy; dp.vz = sp.vz;
    dp.mirrorEntityId = sp.mirrorEntityId;
  }
  dst.points = dstPts;
  return dst;
}

function createBufferedSimEvent(): BufferedSimEvent {
  const event: BufferedSimEvent = {
    type: 'fire',
    turretId: '',
    sourceType: undefined,
    sourceKey: undefined,
    pos: { x: 0, y: 0, z: 0 },
    forceFieldImpact: undefined,
    _pos: { x: 0, y: 0, z: 0 },
  };
  event.pos = event._pos;
  return event;
}

function copySimEventInto(src: NetworkServerSnapshotSimEvent, dst: BufferedSimEvent): BufferedSimEvent {
  dst.type = src.type;
  dst.turretId = src.turretId;
  dst.sourceType = src.sourceType;
  dst.sourceKey = src.sourceKey;
  dst._pos.x = src.pos.x;
  dst._pos.y = src.pos.y;
  dst._pos.z = src.pos.z;
  dst.entityId = src.entityId;
  dst.deathContext = src.deathContext;
  dst.impactContext = src.impactContext;
  dst.forceFieldImpact = src.forceFieldImpact
    ? {
        normal: { ...src.forceFieldImpact.normal },
        playerId: src.forceFieldImpact.playerId,
      }
    : undefined;
  return dst;
}

export class SnapshotBuffer {
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private fullSnapshotCloner = new ReusableNetworkSnapshotCloner();

  // Double-buffered event arrays (swap instead of allocating new arrays each frame)
  private _spawnsA: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsB: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsPoolA: BufferedSpawn[] = [];
  private _spawnsPoolB: BufferedSpawn[] = [];
  private bufferedSpawns: NetworkServerSnapshotProjectileSpawn[] = this._spawnsA;
  private bufferedSpawnsPool: BufferedSpawn[] = this._spawnsPoolA;
  private bufferedSpawnOverwriteIndex = 0;

  private _despawnsA: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnsB: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnsPoolA: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnsPoolB: NetworkServerSnapshotProjectileDespawn[] = [];
  private bufferedDespawns: NetworkServerSnapshotProjectileDespawn[] = this._despawnsA;
  private bufferedDespawnsPool: NetworkServerSnapshotProjectileDespawn[] = this._despawnsPoolA;

  private _audioA: NetworkServerSnapshotSimEvent[] = [];
  private _audioB: NetworkServerSnapshotSimEvent[] = [];
  private _audioPoolA: BufferedSimEvent[] = [];
  private _audioPoolB: BufferedSimEvent[] = [];
  private bufferedAudio: NetworkServerSnapshotSimEvent[] = this._audioA;
  private bufferedAudioPool: BufferedSimEvent[] = this._audioPoolA;
  private bufferedAudioOverwriteIndex = 0;

  private bufferedVelocityUpdates = new Map<number, BufferedVelocityUpdate>();
  private velocityStagePool: BufferedVelocityUpdate[] = [];
  private velocityStagePoolIndex = 0;
  private _velBufA: NetworkServerSnapshotVelocityUpdate[] = [];
  private _velBufB: NetworkServerSnapshotVelocityUpdate[] = [];
  private _velPoolA: BufferedVelocityUpdate[] = [];
  private _velPoolB: BufferedVelocityUpdate[] = [];
  private _velBufToggle = false;

  private bufferedBeamUpdates = new Map<number, BufferedBeamUpdate>();
  private beamStagePool: BufferedBeamUpdate[] = [];
  private beamStagePoolIndex = 0;
  private _beamBufA: NetworkServerSnapshotBeamUpdate[] = [];
  private _beamBufB: NetworkServerSnapshotBeamUpdate[] = [];
  private _beamPoolA: BufferedBeamUpdate[] = [];
  private _beamPoolB: BufferedBeamUpdate[] = [];
  private _beamBufToggle = false;
  private bufferedGrid: NetworkServerSnapshot['grid'];

  private pushBufferedSpawn(spawn: NetworkServerSnapshotProjectileSpawn): void {
    let index = this.bufferedSpawns.length;
    if (index >= MAX_BUFFERED_PROJECTILE_SPAWNS) {
      index = this.bufferedSpawnOverwriteIndex % MAX_BUFFERED_PROJECTILE_SPAWNS;
      this.bufferedSpawnOverwriteIndex++;
    }
    const out = this.bufferedSpawnsPool[index] ?? createBufferedSpawn();
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
    const out = this.bufferedAudioPool[index] ?? createBufferedSimEvent();
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
            out = this.velocityStagePool[this.velocityStagePoolIndex] ?? createBufferedVelocityUpdate();
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
            out = this.beamStagePool[this.beamStagePoolIndex] ?? createBufferedBeamUpdate();
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
        const out = pool[writeIdx] ?? createBufferedVelocityUpdate();
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
        const out = pool[writeIdx] ?? createBufferedBeamUpdate();
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
