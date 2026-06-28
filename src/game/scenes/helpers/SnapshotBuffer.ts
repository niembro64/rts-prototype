// Double-buffered snapshot accumulator.
// PeerJS callback stores snapshots instantly; update() consumes one per frame.
// One-shot events are accumulated across intermediate snapshots. Cleanup
// despawns coalesce by projectile id; visual-heavy streams are capped so a
// stalled frame cannot turn thousands of projectile/effect events into a long
// catch-up hitch.

import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotEntity,
  NetworkServerSnapshotProjectileSpawn,
  NetworkServerSnapshotProjectileDespawn,
  NetworkServerSnapshotBeamUpdate,
  NetworkServerSnapshotSimEvent,
  NetworkServerSnapshotVelocityUpdate,
} from '../../network/NetworkTypes';
import type { GameConnection } from '../../server/GameConnection';
import {
  cloneNetworkSnapshotEntity,
  ReusableNetworkSnapshotCloner,
} from '../../network/snapshotClone';
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
import { addSnapshotClientMaterializationStage } from '../../network/snapshotMaterializationMetadata';
import {
  forEachPackedProjectileDespawn,
  forEachPackedProjectileVelocityUpdate,
  getPackedProjectileSnapshotWire,
} from '../../network/snapshotProjectileWirePack';
import { unregisterEntitySnapshotWireSource } from '../../network/stateSerializerEntities';

const MAX_BUFFERED_PROJECTILE_SPAWNS = 4096;
const MAX_BUFFERED_SIM_EVENTS = 512;
const INDEXED_ENTITY_MERGE_MIN_WORK = 4096;

type SnapshotBufferCallback = (state: NetworkServerSnapshot) => void;
type SnapshotBufferDiagnostics = {
  bufferedDespawns: number;
  coalescedDespawns: number;
};

function copyPositionDelta(
  src: NonNullable<NetworkServerSnapshotEntity['pos']>,
  dst: NonNullable<NetworkServerSnapshotEntity['pos']>,
): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
}

function copyNormalDelta(
  src: NonNullable<NonNullable<NetworkServerSnapshotEntity['unit']>['surfaceNormal']>,
  dst: NonNullable<NonNullable<NetworkServerSnapshotEntity['unit']>['surfaceNormal']>,
): void {
  dst.nx = src.nx;
  dst.ny = src.ny;
  dst.nz = src.nz;
}

function copyOrientationDelta(
  src: NonNullable<NonNullable<NetworkServerSnapshotEntity['unit']>['orientation']>,
  dst: NonNullable<NonNullable<NetworkServerSnapshotEntity['unit']>['orientation']>,
): void {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.w = src.w;
}

export class SnapshotBuffer {
  private pendingSnapshot: NetworkServerSnapshot | null = null;
  private pendingSnapshotRelease: (() => void) | null = null;
  private consumedSnapshotRelease: (() => void) | null = null;
  private snapshotCloner = new ReusableNetworkSnapshotCloner();
  private detachSnapshotCallback: (() => void) | null = null;

  // Double-buffered event arrays (swap instead of allocating new arrays each frame)
  private _spawnsA: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsB: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsPoolA: NetworkServerSnapshotProjectileSpawn[] = [];
  private _spawnsPoolB: NetworkServerSnapshotProjectileSpawn[] = [];
  private bufferedSpawns: NetworkServerSnapshotProjectileSpawn[] = this._spawnsA;
  private bufferedSpawnsPool: NetworkServerSnapshotProjectileSpawn[] = this._spawnsPoolA;
  private bufferedSpawnOverwriteIndex = 0;

  private bufferedDespawns = new Map<number, NetworkServerSnapshotProjectileDespawn>();
  private despawnStagePool: NetworkServerSnapshotProjectileDespawn[] = [];
  private despawnStagePoolIndex = 0;
  private _despawnBufA: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnBufB: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnPoolA: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnPoolB: NetworkServerSnapshotProjectileDespawn[] = [];
  private _despawnBufToggle = false;
  private coalescedDespawns = 0;

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
  private readonly pendingEntityIndexById = new Map<number, number>();
  private readonly removedEntityIdSet = new Set<number>();

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

  private pushBufferedDespawn(despawn: NetworkServerSnapshotProjectileDespawn): void {
    this.pushBufferedDespawnId(despawn.id);
  }

  private pushBufferedDespawnId(id: number): void {
    if (this.bufferedDespawns.has(id)) {
      this.coalescedDespawns++;
      return;
    }
    const out = this.despawnStagePool[this.despawnStagePoolIndex] ?? { id: 0 };
    this.despawnStagePool[this.despawnStagePoolIndex] = out;
    this.despawnStagePoolIndex++;
    out.id = id;
    this.bufferedDespawns.set(id, out);
  }

  private pushBufferedVelocityFields(
    id: number,
    qposX: number,
    qposY: number,
    qposZ: number,
    qvelX: number,
    qvelY: number,
    qvelZ: number,
    targetEntityId: number | null,
    clearHomingTarget: boolean,
  ): void {
    let out = this.bufferedVelocityUpdates.get(id);
    if (!out) {
      out = this.velocityStagePool[this.velocityStagePoolIndex] ?? createVelocityDto();
      this.velocityStagePool[this.velocityStagePoolIndex] = out;
      this.velocityStagePoolIndex++;
      this.bufferedVelocityUpdates.set(id, out);
    }
    out.id = id;
    out.pos.x = qposX;
    out.pos.y = qposY;
    out.pos.z = qposZ;
    out.velocity.x = qvelX;
    out.velocity.y = qvelY;
    out.velocity.z = qvelZ;
    out.targetEntityId = targetEntityId;
    out.clearHomingTarget = clearHomingTarget ? true : null;
  }

  private mergeEntityMotionDeltaIntoPending(
    deltaEntities: readonly NetworkServerSnapshotEntity[],
    removedEntityIds: readonly number[] | undefined,
  ): void {
    const pending = this.pendingSnapshot;
    if (pending === null || pending.entityDeltaOnly === true) return;
    const pendingEntities = pending.entities;
    if (deltaEntities.length > 0 || (removedEntityIds !== undefined && removedEntityIds.length > 0)) {
      unregisterEntitySnapshotWireSource(pendingEntities);
    }
    const pendingEntityIndexById = this.preparePendingEntityIndex(
      pendingEntities,
      deltaEntities.length,
    );
    for (let i = 0; i < deltaEntities.length; i++) {
      const delta = deltaEntities[i];
      const targetIndex = this.findPendingEntityIndex(
        pendingEntities,
        delta.id,
        pendingEntityIndexById,
      );
      const target = targetIndex >= 0 ? pendingEntities[targetIndex] : undefined;
      if (target === undefined) {
        if (delta.changedFields === null) {
          pendingEntities.push(cloneNetworkSnapshotEntity(delta));
          pendingEntityIndexById?.set(delta.id, pendingEntities.length - 1);
        }
        continue;
      }
      if (delta.changedFields === null) {
        pendingEntities[targetIndex] = cloneNetworkSnapshotEntity(delta);
        continue;
      }
      if (delta.pos != null) {
        if (target.pos === null) target.pos = { x: 0, y: 0, z: 0 };
        copyPositionDelta(delta.pos, target.pos);
      }
      if (delta.rotation != null) {
        target.rotation = delta.rotation;
      }
      const srcUnit = delta.unit;
      const dstUnit = target.unit;
      if (srcUnit == null || dstUnit == null) continue;
      if (srcUnit.velocity != null) {
        if (dstUnit.velocity === null) dstUnit.velocity = { x: 0, y: 0, z: 0 };
        copyPositionDelta(srcUnit.velocity, dstUnit.velocity);
      }
      if (srcUnit.surfaceNormal != null) {
        if (dstUnit.surfaceNormal === null) dstUnit.surfaceNormal = { nx: 0, ny: 0, nz: 1000 };
        copyNormalDelta(srcUnit.surfaceNormal, dstUnit.surfaceNormal);
      }
      if (srcUnit.orientation != null) {
        if (dstUnit.orientation === null) dstUnit.orientation = { x: 0, y: 0, z: 0, w: 1 };
        copyOrientationDelta(srcUnit.orientation, dstUnit.orientation);
      }
      if (srcUnit.angularVelocity3 != null) {
        if (dstUnit.angularVelocity3 === null) dstUnit.angularVelocity3 = { x: 0, y: 0, z: 0 };
        copyPositionDelta(srcUnit.angularVelocity3, dstUnit.angularVelocity3);
      }
    }
    pendingEntityIndexById?.clear();
    if (removedEntityIds !== undefined && removedEntityIds.length > 0) {
      if (pendingEntities.length * removedEntityIds.length >= INDEXED_ENTITY_MERGE_MIN_WORK) {
        this.prunePendingEntitiesWithSet(pendingEntities, removedEntityIds);
        return;
      }
      for (let i = 0; i < removedEntityIds.length; i++) {
        const id = removedEntityIds[i];
        for (let j = pendingEntities.length - 1; j >= 0; j--) {
          if (pendingEntities[j].id === id) pendingEntities.splice(j, 1);
        }
      }
    }
  }

  private preparePendingEntityIndex(
    pendingEntities: readonly NetworkServerSnapshotEntity[],
    deltaCount: number,
  ): Map<number, number> | undefined {
    if (pendingEntities.length * deltaCount < INDEXED_ENTITY_MERGE_MIN_WORK) return undefined;
    const indexById = this.pendingEntityIndexById;
    indexById.clear();
    for (let i = 0; i < pendingEntities.length; i++) {
      indexById.set(pendingEntities[i].id, i);
    }
    return indexById;
  }

  private findPendingEntityIndex(
    pendingEntities: readonly NetworkServerSnapshotEntity[],
    id: number,
    indexById: ReadonlyMap<number, number> | undefined,
  ): number {
    if (indexById !== undefined) return indexById.get(id) ?? -1;
    for (let i = 0; i < pendingEntities.length; i++) {
      if (pendingEntities[i].id === id) return i;
    }
    return -1;
  }

  private prunePendingEntitiesWithSet(
    pendingEntities: NetworkServerSnapshotEntity[],
    removedEntityIds: readonly number[],
  ): void {
    const removedIds = this.removedEntityIdSet;
    removedIds.clear();
    for (let i = 0; i < removedEntityIds.length; i++) removedIds.add(removedEntityIds[i]);
    let write = 0;
    for (let read = 0; read < pendingEntities.length; read++) {
      const entity = pendingEntities[read];
      if (removedIds.has(entity.id)) continue;
      if (write !== read) pendingEntities[write] = entity;
      write++;
    }
    pendingEntities.length = write;
    removedIds.clear();
  }

  /** Wire the gameConnection snapshot callback to accumulate events. */
  attach(gameConnection: GameConnection, onBufferedSnapshot?: SnapshotBufferCallback): void {
    this.detachSnapshotCallback?.();
    this.detachSnapshotCallback = gameConnection.onSnapshot((
      state: NetworkServerSnapshot,
      releaseSnapshot?: () => void,
    ) => {
      if (onBufferedSnapshot !== undefined) onBufferedSnapshot(state);
      const proj = state.projectiles;
      const packedProjectiles = getPackedProjectileSnapshotWire(proj);
      if (proj !== undefined && proj.spawns !== undefined) {
        for (let i = 0; i < proj.spawns.length; i++) {
          this.pushBufferedSpawn(proj.spawns[i]);
        }
      }
      if (proj !== undefined && proj.despawns !== undefined) {
        for (let i = 0; i < proj.despawns.length; i++) {
          this.pushBufferedDespawn(proj.despawns[i]);
        }
      } else if (packedProjectiles !== undefined) {
        forEachPackedProjectileDespawn(
          packedProjectiles,
          (id) => this.pushBufferedDespawnId(id),
        );
      }
      if (state.audioEvents) {
        for (let i = 0; i < state.audioEvents.length; i++) {
          this.pushBufferedAudio(state.audioEvents[i]);
        }
      }
      if (proj !== undefined && proj.velocityUpdates !== undefined) {
        for (let i = 0; i < proj.velocityUpdates.length; i++) {
          const vu = proj.velocityUpdates[i];
          this.pushBufferedVelocityFields(
            vu.id,
            vu.pos.x,
            vu.pos.y,
            vu.pos.z,
            vu.velocity.x,
            vu.velocity.y,
            vu.velocity.z,
            vu.targetEntityId,
            vu.clearHomingTarget === true,
          );
        }
      } else if (packedProjectiles !== undefined) {
        forEachPackedProjectileVelocityUpdate(
          packedProjectiles,
          (
            id,
            qposX,
            qposY,
            qposZ,
            qvelX,
            qvelY,
            qvelZ,
            targetEntityId,
            clearHomingTarget,
          ) => this.pushBufferedVelocityFields(
            id,
            qposX,
            qposY,
            qposZ,
            qvelX,
            qvelY,
            qvelZ,
            targetEntityId,
            clearHomingTarget,
          ),
        );
      }
      if (proj !== undefined && proj.beamUpdates !== undefined) {
        for (let i = 0; i < proj.beamUpdates.length; i++) {
          const bu = proj.beamUpdates[i];
          let out = this.bufferedBeamUpdates.get(bu.id);
          if (!out) {
            out = this.beamStagePool[this.beamStagePoolIndex] ?? createBeamDto();
            this.beamStagePool[this.beamStagePoolIndex] = out;
            this.beamStagePoolIndex++;
            this.bufferedBeamUpdates.set(bu.id, out);
          }
          copyBeamInto(bu, out);
        }
      }
      if (state.grid) {
        this.bufferedGrid = state.grid;
      } else if (state.serverMeta !== undefined && state.serverMeta.grid === false) {
        this.bufferedGrid = undefined;
      }
      if (
        state.projectileDeltaOnly === true &&
        this.pendingSnapshot !== null &&
        this.pendingSnapshot.projectileDeltaOnly !== true
      ) {
        releaseSnapshot?.();
        return;
      }
      if (
        state.entityDeltaOnly === true &&
        this.pendingSnapshot !== null &&
        this.pendingSnapshot.entityDeltaOnly !== true
      ) {
        const mergeStart = performance.now();
        this.mergeEntityMotionDeltaIntoPending(state.entities, state.removedEntityIds);
        addSnapshotClientMaterializationStage(
          this.pendingSnapshot,
          'cloneMerge',
          performance.now() - mergeStart,
        );
        releaseSnapshot?.();
        return;
      }
      // Full-state snapshots are cloned because the local server reuses
      // its serializer object for later frames. Static terrain/buildability
      // ride only bootstrap/recovery packets, so preserve the latest copy.
      const previousTerrain = this.pendingSnapshot?.terrain;
      const previousBuildability = this.pendingSnapshot?.buildability;
      this.releasePendingSnapshot();
      const cloneStart = performance.now();
      const pending = this.snapshotCloner.clone(state);
      addSnapshotClientMaterializationStage(
        pending,
        'cloneMerge',
        performance.now() - cloneStart,
      );
      if (pending.terrain === undefined && previousTerrain !== undefined) {
        pending.terrain = previousTerrain;
      }
      if (
        pending.buildability === undefined &&
        previousBuildability !== undefined
      ) {
        pending.buildability = previousBuildability;
      }
      this.pendingSnapshot = pending;
      if (pending.grid !== undefined) {
        this.bufferedGrid = pending.grid;
      }
      this.pendingSnapshotRelease = null;
      releaseSnapshot?.();
    });
  }

  /**
   * Consume the latest buffered snapshot with all accumulated events attached.
   * Returns null if no snapshot is pending. Swaps double buffers (zero allocation).
   */
  consume(): NetworkServerSnapshot | null {
    this.consumedSnapshotRelease?.();
    this.consumedSnapshotRelease = null;
    if (!this.pendingSnapshot) return null;

    const state = this.pendingSnapshot;
    const releaseSnapshot = this.pendingSnapshotRelease;
    this.pendingSnapshot = null;
    this.pendingSnapshotRelease = null;

    // Swap spawns
    const spawns = this.bufferedSpawns;
    this.bufferedSpawns = (spawns === this._spawnsA) ? this._spawnsB : this._spawnsA;
    this.bufferedSpawnsPool = (spawns === this._spawnsA) ? this._spawnsPoolB : this._spawnsPoolA;
    this.bufferedSpawns.length = 0;
    this.bufferedSpawnOverwriteIndex = 0;
    const netSpawns = spawns.length > 0 ? spawns : undefined;

    // Swap despawns. Cleanup events are idempotent, so repeated ids can
    // collapse to one authoritative cleanup without keeping every event.
    let netDespawns: NetworkServerSnapshotProjectileDespawn[] | undefined;
    if (this.bufferedDespawns.size > 0) {
      const buf = this._despawnBufToggle ? this._despawnBufB : this._despawnBufA;
      const pool = this._despawnBufToggle ? this._despawnPoolB : this._despawnPoolA;
      this._despawnBufToggle = !this._despawnBufToggle;
      buf.length = 0;
      let writeIdx = 0;
      for (const despawn of this.bufferedDespawns.values()) {
        const out = pool[writeIdx] ?? { id: 0 };
        pool[writeIdx] = out;
        out.id = despawn.id;
        buf.push(out);
        writeIdx++;
      }
      this.bufferedDespawns.clear();
      this.despawnStagePoolIndex = 0;
      netDespawns = buf;
    }

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
      if (!state.projectiles) {
        state.projectiles = {
          spawns: undefined,
          despawns: undefined,
          velocityUpdates: undefined,
          beamUpdates: undefined,
        };
      }
      const projectiles = state.projectiles;
      projectiles.spawns = netSpawns;
      projectiles.despawns = netDespawns;
      projectiles.velocityUpdates = netVelUpdates;
      projectiles.beamUpdates = netBeamUpdates;
    } else {
      state.projectiles = undefined;
    }

    if (
      !state.grid &&
      this.bufferedGrid &&
      (state.serverMeta === undefined || state.serverMeta.grid !== false)
    ) {
      state.grid = this.bufferedGrid;
    }
    if (state.grid === this.bufferedGrid) {
      this.bufferedGrid = undefined;
    }

    this.consumedSnapshotRelease = releaseSnapshot;
    return state;
  }

  /** Release all buffered data. */
  clear(): void {
    this.detachSnapshotCallback?.();
    this.detachSnapshotCallback = null;
    this.releasePendingSnapshot();
    this.consumedSnapshotRelease?.();
    this.consumedSnapshotRelease = null;
    this.snapshotCloner.clear();
    this._spawnsA.length = 0;
    this._spawnsB.length = 0;
    this._spawnsPoolA.length = 0;
    this._spawnsPoolB.length = 0;
    this.bufferedSpawnOverwriteIndex = 0;
    this.bufferedDespawns.clear();
    this.despawnStagePool.length = 0;
    this.despawnStagePoolIndex = 0;
    this._despawnBufA.length = 0;
    this._despawnBufB.length = 0;
    this._despawnPoolA.length = 0;
    this._despawnPoolB.length = 0;
    this.coalescedDespawns = 0;
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
    this.pendingEntityIndexById.clear();
    this.removedEntityIdSet.clear();
    this._velBufA.length = 0;
    this._velBufB.length = 0;
    this._velPoolA.length = 0;
    this._velPoolB.length = 0;
    this._beamBufA.length = 0;
    this._beamBufB.length = 0;
    this._beamPoolA.length = 0;
    this._beamPoolB.length = 0;
  }

  getDiagnostics(): SnapshotBufferDiagnostics {
    return {
      bufferedDespawns: this.bufferedDespawns.size,
      coalescedDespawns: this.coalescedDespawns,
    };
  }

  private releasePendingSnapshot(): void {
    this.pendingSnapshot = null;
    this.pendingSnapshotRelease?.();
    this.pendingSnapshotRelease = null;
  }
}
