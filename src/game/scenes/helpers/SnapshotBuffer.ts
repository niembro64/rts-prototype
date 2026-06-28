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
import {
  ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE,
  ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE,
  ENTITY_SNAPSHOT_WIRE_KIND_BASIC,
  ENTITY_SNAPSHOT_WIRE_KIND_BUILDING,
  ENTITY_SNAPSHOT_WIRE_KIND_UNIT,
  ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE,
  getEntitySnapshotWireSource,
  unregisterEntitySnapshotWireSource,
  type EntitySnapshotWireSource,
} from '../../network/stateSerializerEntities';
import {
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_POS,
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
} from '../../../types/network';

const MAX_BUFFERED_PROJECTILE_SPAWNS = 4096;
const MAX_BUFFERED_SIM_EVENTS = 512;
const INDEXED_ENTITY_MERGE_MIN_WORK = 4096;
const ENTITY_MOTION_MERGE_FIELDS =
  ENTITY_CHANGED_POS |
  ENTITY_CHANGED_ROT |
  ENTITY_CHANGED_VEL |
  ENTITY_CHANGED_NORMAL;

type SnapshotBufferCallback = (state: NetworkServerSnapshot) => void;
type SnapshotBufferDiagnostics = {
  bufferedDespawns: number;
  coalescedDespawns: number;
};
type PendingEntityWireMotionRow = {
  kind: number;
  values: Float64Array;
  base: number;
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
    const pendingEntityIndexById = this.preparePendingEntityIndex(
      pendingEntities,
      deltaEntities.length,
    );
    const pendingWireSource = getEntitySnapshotWireSource(pendingEntities);
    const deltaWireSource = getEntitySnapshotWireSource(deltaEntities);
    const canPreservePendingWireSource = pendingWireSource !== undefined &&
      this.canPreservePendingEntityWireSource(
        pendingEntities,
        deltaEntities,
        pendingWireSource,
        pendingEntityIndexById,
      );
    if (
      !canPreservePendingWireSource &&
      (deltaEntities.length > 0 || (removedEntityIds !== undefined && removedEntityIds.length > 0))
    ) {
      unregisterEntitySnapshotWireSource(pendingEntities);
    }
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
      if (
        this.patchPendingEntityMotionFromTypedDelta(
          deltaWireSource,
          i,
          target,
          pendingWireSource,
          targetIndex,
          canPreservePendingWireSource,
        )
      ) {
        continue;
      }
      if (canPreservePendingWireSource && pendingWireSource !== undefined) {
        this.patchPendingEntityWireSourceMotion(pendingWireSource, targetIndex, delta);
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
      const preservedWireSource = canPreservePendingWireSource ? pendingWireSource : undefined;
      if (pendingEntities.length * removedEntityIds.length >= INDEXED_ENTITY_MERGE_MIN_WORK) {
        this.prunePendingEntitiesWithSet(pendingEntities, removedEntityIds, preservedWireSource);
        return;
      }
      for (let i = 0; i < removedEntityIds.length; i++) {
        const id = removedEntityIds[i];
        for (let j = pendingEntities.length - 1; j >= 0; j--) {
          if (pendingEntities[j].id === id) {
            this.prunePendingEntityAt(pendingEntities, j, preservedWireSource);
          }
        }
      }
    }
  }

  private patchPendingEntityMotionFromTypedDelta(
    deltaSource: EntitySnapshotWireSource | undefined,
    deltaIndex: number,
    target: NetworkServerSnapshotEntity,
    pendingSource: EntitySnapshotWireSource | undefined,
    targetIndex: number,
    patchPendingSource: boolean,
  ): boolean {
    if (deltaSource === undefined) {
      return false;
    }
    if (deltaSource.kinds[deltaIndex] === ENTITY_SNAPSHOT_WIRE_KIND_BASIC) {
      return this.patchPendingEntityTransformFromBasicTypedDelta(
        deltaSource,
        deltaIndex,
        target,
        pendingSource,
        targetIndex,
        patchPendingSource,
      );
    }
    if (deltaSource.kinds[deltaIndex] !== ENTITY_SNAPSHOT_WIRE_KIND_UNIT) return false;
    const deltaRowIndex = deltaSource.rowIndices[deltaIndex];
    if (deltaRowIndex < 0 || deltaRowIndex >= deltaSource.unitRows.count) return false;
    const deltaValues = deltaSource.unitRows.values;
    const deltaBase = deltaRowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
    const changedFields = deltaValues[deltaBase + 7] | 0;
    if (deltaValues[deltaBase + 6] === 0 || changedFields === 0) return false;
    if ((changedFields & ~ENTITY_MOTION_MERGE_FIELDS) !== 0) return false;
    if ((deltaValues[deltaBase + 0] | 0) !== target.id) return false;

    let pendingValues: Float64Array | undefined;
    let pendingBase = 0;
    if (
      patchPendingSource &&
      pendingSource !== undefined &&
      pendingSource.kinds[targetIndex] === ENTITY_SNAPSHOT_WIRE_KIND_UNIT
    ) {
      const pendingRowIndex = pendingSource.rowIndices[targetIndex];
      if (pendingRowIndex >= 0 && pendingRowIndex < pendingSource.unitRows.count) {
        const values = pendingSource.unitRows.values;
        const base = pendingRowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
        if ((values[base + 0] | 0) === target.id) {
          pendingValues = values;
          pendingBase = base;
        }
      }
    }

    let patched = false;
    if ((changedFields & ENTITY_CHANGED_POS) !== 0) {
      if (target.pos === null) target.pos = { x: 0, y: 0, z: 0 };
      target.pos.x = deltaValues[deltaBase + 1];
      target.pos.y = deltaValues[deltaBase + 2];
      target.pos.z = deltaValues[deltaBase + 3];
      if (pendingValues !== undefined) {
        pendingValues[pendingBase + 1] = deltaValues[deltaBase + 1];
        pendingValues[pendingBase + 2] = deltaValues[deltaBase + 2];
        pendingValues[pendingBase + 3] = deltaValues[deltaBase + 3];
      }
      patched = true;
    }
    if ((changedFields & ENTITY_CHANGED_ROT) !== 0) {
      target.rotation = deltaValues[deltaBase + 4];
      if (pendingValues !== undefined) {
        pendingValues[pendingBase + 4] = deltaValues[deltaBase + 4];
      }
      patched = true;
    }

    const dstUnit = target.unit;
    if (dstUnit === null) return patched;
    if ((changedFields & ENTITY_CHANGED_VEL) !== 0) {
      if (dstUnit.velocity === null) dstUnit.velocity = { x: 0, y: 0, z: 0 };
      dstUnit.velocity.x = deltaValues[deltaBase + 10];
      dstUnit.velocity.y = deltaValues[deltaBase + 11];
      dstUnit.velocity.z = deltaValues[deltaBase + 12];
      if (pendingValues !== undefined) {
        pendingValues[pendingBase + 10] = deltaValues[deltaBase + 10];
        pendingValues[pendingBase + 11] = deltaValues[deltaBase + 11];
        pendingValues[pendingBase + 12] = deltaValues[deltaBase + 12];
      }
      if (deltaValues[deltaBase + 32] !== 0) {
        if (dstUnit.angularVelocity3 === null) {
          dstUnit.angularVelocity3 = { x: 0, y: 0, z: 0 };
        }
        dstUnit.angularVelocity3.x = deltaValues[deltaBase + 33];
        dstUnit.angularVelocity3.y = deltaValues[deltaBase + 34];
        dstUnit.angularVelocity3.z = deltaValues[deltaBase + 35];
        if (pendingValues !== undefined) {
          pendingValues[pendingBase + 32] = 1;
          pendingValues[pendingBase + 33] = deltaValues[deltaBase + 33];
          pendingValues[pendingBase + 34] = deltaValues[deltaBase + 34];
          pendingValues[pendingBase + 35] = deltaValues[deltaBase + 35];
        }
      }
      patched = true;
    }
    if ((changedFields & ENTITY_CHANGED_NORMAL) !== 0 && deltaValues[deltaBase + 23] !== 0) {
      if (dstUnit.surfaceNormal === null) dstUnit.surfaceNormal = { nx: 0, ny: 0, nz: 1000 };
      dstUnit.surfaceNormal.nx = deltaValues[deltaBase + 24];
      dstUnit.surfaceNormal.ny = deltaValues[deltaBase + 25];
      dstUnit.surfaceNormal.nz = deltaValues[deltaBase + 26];
      if (pendingValues !== undefined) {
        pendingValues[pendingBase + 23] = 1;
        pendingValues[pendingBase + 24] = deltaValues[deltaBase + 24];
        pendingValues[pendingBase + 25] = deltaValues[deltaBase + 25];
        pendingValues[pendingBase + 26] = deltaValues[deltaBase + 26];
      }
      patched = true;
    }
    if ((changedFields & ENTITY_CHANGED_ROT) !== 0 && deltaValues[deltaBase + 27] !== 0) {
      if (dstUnit.orientation === null) dstUnit.orientation = { x: 0, y: 0, z: 0, w: 1 };
      dstUnit.orientation.x = deltaValues[deltaBase + 28];
      dstUnit.orientation.y = deltaValues[deltaBase + 29];
      dstUnit.orientation.z = deltaValues[deltaBase + 30];
      dstUnit.orientation.w = deltaValues[deltaBase + 31];
      if (pendingValues !== undefined) {
        pendingValues[pendingBase + 27] = 1;
        pendingValues[pendingBase + 28] = deltaValues[deltaBase + 28];
        pendingValues[pendingBase + 29] = deltaValues[deltaBase + 29];
        pendingValues[pendingBase + 30] = deltaValues[deltaBase + 30];
        pendingValues[pendingBase + 31] = deltaValues[deltaBase + 31];
      }
      patched = true;
    }
    return patched;
  }

  private patchPendingEntityTransformFromBasicTypedDelta(
    deltaSource: EntitySnapshotWireSource,
    deltaIndex: number,
    target: NetworkServerSnapshotEntity,
    pendingSource: EntitySnapshotWireSource | undefined,
    targetIndex: number,
    patchPendingSource: boolean,
  ): boolean {
    const deltaRowIndex = deltaSource.rowIndices[deltaIndex];
    if (deltaRowIndex < 0 || deltaRowIndex >= deltaSource.basicRows.count) return false;
    const deltaValues = deltaSource.basicRows.values;
    const deltaBase = deltaRowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
    const changedFields = deltaValues[deltaBase + 8] | 0;
    if (deltaValues[deltaBase + 7] === 0 || changedFields === 0) return false;
    if ((changedFields & ~ENTITY_MOTION_MERGE_FIELDS) !== 0) return false;
    if ((changedFields & (ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL)) !== 0) return false;
    if ((deltaValues[deltaBase + 0] | 0) !== target.id) return false;

    const pendingRow = patchPendingSource
      ? this.getPendingEntityWireMotionRow(pendingSource, targetIndex, target.id)
      : undefined;
    let patched = false;
    if ((changedFields & ENTITY_CHANGED_POS) !== 0) {
      if (target.pos === null) target.pos = { x: 0, y: 0, z: 0 };
      target.pos.x = deltaValues[deltaBase + 2];
      target.pos.y = deltaValues[deltaBase + 3];
      target.pos.z = deltaValues[deltaBase + 4];
      this.patchPendingWireRowPosition(
        pendingRow,
        deltaValues[deltaBase + 2],
        deltaValues[deltaBase + 3],
        deltaValues[deltaBase + 4],
      );
      patched = true;
    }
    if ((changedFields & ENTITY_CHANGED_ROT) !== 0) {
      target.rotation = deltaValues[deltaBase + 5];
      this.patchPendingWireRowRotation(pendingRow, deltaValues[deltaBase + 5]);
      patched = true;
    }
    return patched;
  }

  private canPreservePendingEntityWireSource(
    pendingEntities: readonly NetworkServerSnapshotEntity[],
    deltaEntities: readonly NetworkServerSnapshotEntity[],
    source: EntitySnapshotWireSource,
    indexById: ReadonlyMap<number, number> | undefined,
  ): boolean {
    if (source.kinds.length !== pendingEntities.length) return false;
    for (let i = 0; i < deltaEntities.length; i++) {
      const delta = deltaEntities[i];
      const changedFields = delta.changedFields;
      if (
        typeof changedFields !== 'number' ||
        (changedFields & ~ENTITY_MOTION_MERGE_FIELDS) !== 0
      ) {
        return false;
      }
      const targetIndex = this.findPendingEntityIndex(pendingEntities, delta.id, indexById);
      if (targetIndex < 0) return false;
      const target = pendingEntities[targetIndex];
      const pendingRow = this.getPendingEntityWireMotionRow(source, targetIndex, delta.id);
      if (pendingRow === undefined) return false;
      if (
        (changedFields & (ENTITY_CHANGED_VEL | ENTITY_CHANGED_NORMAL)) !== 0 &&
        (target.unit == null || pendingRow.kind !== ENTITY_SNAPSHOT_WIRE_KIND_UNIT)
      ) {
        return false;
      }
    }
    return true;
  }

  private patchPendingEntityWireSourceMotion(
    source: EntitySnapshotWireSource,
    targetIndex: number,
    delta: NetworkServerSnapshotEntity,
  ): void {
    const row = this.getPendingEntityWireMotionRow(source, targetIndex, delta.id);
    if (row === undefined) return;
    const values = row.values;
    const base = row.base;
    if (delta.pos != null) {
      this.patchPendingWireRowPosition(row, delta.pos.x, delta.pos.y, delta.pos.z);
    }
    if (delta.rotation != null) {
      this.patchPendingWireRowRotation(row, delta.rotation);
    }
    if (row.kind !== ENTITY_SNAPSHOT_WIRE_KIND_UNIT) return;
    const unit = delta.unit;
    if (unit == null) return;
    if (unit.velocity != null) {
      values[base + 10] = unit.velocity.x;
      values[base + 11] = unit.velocity.y;
      values[base + 12] = unit.velocity.z;
    }
    if (unit.surfaceNormal != null) {
      values[base + 23] = 1;
      values[base + 24] = unit.surfaceNormal.nx;
      values[base + 25] = unit.surfaceNormal.ny;
      values[base + 26] = unit.surfaceNormal.nz;
    }
    if (unit.orientation != null) {
      values[base + 27] = 1;
      values[base + 28] = unit.orientation.x;
      values[base + 29] = unit.orientation.y;
      values[base + 30] = unit.orientation.z;
      values[base + 31] = unit.orientation.w;
    }
    if (unit.angularVelocity3 != null) {
      values[base + 32] = 1;
      values[base + 33] = unit.angularVelocity3.x;
      values[base + 34] = unit.angularVelocity3.y;
      values[base + 35] = unit.angularVelocity3.z;
    }
  }

  private getPendingEntityWireMotionRow(
    source: EntitySnapshotWireSource | undefined,
    targetIndex: number,
    id: number,
  ): PendingEntityWireMotionRow | undefined {
    if (source === undefined) return undefined;
    const kind = source.kinds[targetIndex];
    const rowIndex = source.rowIndices[targetIndex];
    let values: Float64Array;
    let base: number;
    if (kind === ENTITY_SNAPSHOT_WIRE_KIND_UNIT) {
      if (rowIndex < 0 || rowIndex >= source.unitRows.count) return undefined;
      values = source.unitRows.values;
      base = rowIndex * ENTITY_SNAPSHOT_WIRE_UNIT_STRIDE;
    } else if (kind === ENTITY_SNAPSHOT_WIRE_KIND_BUILDING) {
      if (rowIndex < 0 || rowIndex >= source.buildingRows.count) return undefined;
      values = source.buildingRows.values;
      base = rowIndex * ENTITY_SNAPSHOT_WIRE_BUILDING_STRIDE;
    } else if (kind === ENTITY_SNAPSHOT_WIRE_KIND_BASIC) {
      if (rowIndex < 0 || rowIndex >= source.basicRows.count) return undefined;
      values = source.basicRows.values;
      base = rowIndex * ENTITY_SNAPSHOT_WIRE_BASIC_STRIDE;
    } else {
      return undefined;
    }
    return (values[base + 0] | 0) === id ? { kind, values, base } : undefined;
  }

  private patchPendingWireRowPosition(
    row: PendingEntityWireMotionRow | undefined,
    x: number,
    y: number,
    z: number,
  ): void {
    if (row === undefined) return;
    const posBase = row.kind === ENTITY_SNAPSHOT_WIRE_KIND_BASIC ? row.base + 2 : row.base + 1;
    row.values[posBase + 0] = x;
    row.values[posBase + 1] = y;
    row.values[posBase + 2] = z;
  }

  private patchPendingWireRowRotation(
    row: PendingEntityWireMotionRow | undefined,
    rotation: number,
  ): void {
    if (row === undefined) return;
    row.values[row.kind === ENTITY_SNAPSHOT_WIRE_KIND_BASIC ? row.base + 5 : row.base + 4] = rotation;
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
    wireSource: EntitySnapshotWireSource | undefined,
  ): void {
    const removedIds = this.removedEntityIdSet;
    removedIds.clear();
    for (let i = 0; i < removedEntityIds.length; i++) removedIds.add(removedEntityIds[i]);
    let write = 0;
    for (let read = 0; read < pendingEntities.length; read++) {
      const entity = pendingEntities[read];
      if (removedIds.has(entity.id)) continue;
      if (write !== read) {
        pendingEntities[write] = entity;
        if (wireSource !== undefined) {
          wireSource.kinds[write] = wireSource.kinds[read];
          wireSource.rowIndices[write] = wireSource.rowIndices[read];
        }
      }
      write++;
    }
    pendingEntities.length = write;
    if (wireSource !== undefined) {
      wireSource.kinds.length = write;
      wireSource.rowIndices.length = write;
      if (write === 0) unregisterEntitySnapshotWireSource(pendingEntities);
    }
    removedIds.clear();
  }

  private prunePendingEntityAt(
    pendingEntities: NetworkServerSnapshotEntity[],
    index: number,
    wireSource: EntitySnapshotWireSource | undefined,
  ): void {
    pendingEntities.splice(index, 1);
    if (wireSource === undefined) return;
    wireSource.kinds.splice(index, 1);
    wireSource.rowIndices.splice(index, 1);
    if (wireSource.kinds.length === 0) unregisterEntitySnapshotWireSource(pendingEntities);
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
