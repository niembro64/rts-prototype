import type { EntityId } from '../sim/types';

type ScopedMeshChurnBucket = {
  hiddenEvents: number;
  reactivatedEvents: number;
  destroyEvents: number;
  rebuildEvents: number;
  hiddenPerSec: number;
  reactivatedPerSec: number;
  destroyPerSec: number;
  rebuildPerSec: number;
  lastSampleMs: number;
};

export type ScopedRenderMeshRetentionTelemetry = {
  retainedUnitMeshes: number;
  retainedBuildingMeshes: number;
  unitHiddenPerSec: number;
  unitReactivatedPerSec: number;
  unitScopedDestroyPerSec: number;
  unitScopedRebuildPerSec: number;
  buildingHiddenPerSec: number;
  buildingReactivatedPerSec: number;
  buildingScopedDestroyPerSec: number;
  buildingScopedRebuildPerSec: number;
};

function createBucket(): ScopedMeshChurnBucket {
  return {
    hiddenEvents: 0,
    reactivatedEvents: 0,
    destroyEvents: 0,
    rebuildEvents: 0,
    hiddenPerSec: 0,
    reactivatedPerSec: 0,
    destroyPerSec: 0,
    rebuildPerSec: 0,
    lastSampleMs: 0,
  };
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function sampleBucket(bucket: ScopedMeshChurnBucket, sampleMs: number): void {
  if (bucket.lastSampleMs <= 0) {
    bucket.lastSampleMs = sampleMs;
    return;
  }
  const dtMs = sampleMs - bucket.lastSampleMs;
  if (dtMs < 1000) return;
  const perSec = 1000 / Math.max(1, dtMs);
  bucket.hiddenPerSec = bucket.hiddenEvents * perSec;
  bucket.reactivatedPerSec = bucket.reactivatedEvents * perSec;
  bucket.destroyPerSec = bucket.destroyEvents * perSec;
  bucket.rebuildPerSec = bucket.rebuildEvents * perSec;
  bucket.hiddenEvents = 0;
  bucket.reactivatedEvents = 0;
  bucket.destroyEvents = 0;
  bucket.rebuildEvents = 0;
  bucket.lastSampleMs = sampleMs;
}

export class ScopedRenderMeshRetention3D {
  private readonly hiddenUnitIds = new Set<EntityId>();
  private readonly hiddenBuildingIds = new Set<EntityId>();
  private readonly unitChurn = createBucket();
  private readonly buildingChurn = createBucket();

  markUnitHidden(id: EntityId): boolean {
    return this.markHidden(this.hiddenUnitIds, this.unitChurn, id);
  }

  markBuildingHidden(id: EntityId): boolean {
    return this.markHidden(this.hiddenBuildingIds, this.buildingChurn, id);
  }

  markUnitActive(id: EntityId): boolean {
    return this.markActive(this.hiddenUnitIds, this.unitChurn, id);
  }

  markBuildingActive(id: EntityId): boolean {
    return this.markActive(this.hiddenBuildingIds, this.buildingChurn, id);
  }

  forgetUnit(id: EntityId): boolean {
    return this.hiddenUnitIds.delete(id);
  }

  forgetBuilding(id: EntityId): boolean {
    return this.hiddenBuildingIds.delete(id);
  }

  recordUnitScopedDestroy(): void {
    this.unitChurn.destroyEvents++;
  }

  recordBuildingScopedDestroy(): void {
    this.buildingChurn.destroyEvents++;
  }

  recordUnitScopedRebuild(): void {
    this.unitChurn.rebuildEvents++;
  }

  recordBuildingScopedRebuild(): void {
    this.buildingChurn.rebuildEvents++;
  }

  getTelemetry(sampleMs: number = nowMs()): ScopedRenderMeshRetentionTelemetry {
    sampleBucket(this.unitChurn, sampleMs);
    sampleBucket(this.buildingChurn, sampleMs);
    return {
      retainedUnitMeshes: this.hiddenUnitIds.size,
      retainedBuildingMeshes: this.hiddenBuildingIds.size,
      unitHiddenPerSec: this.unitChurn.hiddenPerSec,
      unitReactivatedPerSec: this.unitChurn.reactivatedPerSec,
      unitScopedDestroyPerSec: this.unitChurn.destroyPerSec,
      unitScopedRebuildPerSec: this.unitChurn.rebuildPerSec,
      buildingHiddenPerSec: this.buildingChurn.hiddenPerSec,
      buildingReactivatedPerSec: this.buildingChurn.reactivatedPerSec,
      buildingScopedDestroyPerSec: this.buildingChurn.destroyPerSec,
      buildingScopedRebuildPerSec: this.buildingChurn.rebuildPerSec,
    };
  }

  clear(): void {
    this.hiddenUnitIds.clear();
    this.hiddenBuildingIds.clear();
    this.resetBucket(this.unitChurn);
    this.resetBucket(this.buildingChurn);
  }

  private markHidden(
    hiddenIds: Set<EntityId>,
    bucket: ScopedMeshChurnBucket,
    id: EntityId,
  ): boolean {
    if (hiddenIds.has(id)) return false;
    hiddenIds.add(id);
    bucket.hiddenEvents++;
    return true;
  }

  private markActive(
    hiddenIds: Set<EntityId>,
    bucket: ScopedMeshChurnBucket,
    id: EntityId,
  ): boolean {
    if (!hiddenIds.delete(id)) return false;
    bucket.reactivatedEvents++;
    return true;
  }

  private resetBucket(bucket: ScopedMeshChurnBucket): void {
    bucket.hiddenEvents = 0;
    bucket.reactivatedEvents = 0;
    bucket.destroyEvents = 0;
    bucket.rebuildEvents = 0;
    bucket.hiddenPerSec = 0;
    bucket.reactivatedPerSec = 0;
    bucket.destroyPerSec = 0;
    bucket.rebuildPerSec = 0;
    bucket.lastSampleMs = 0;
  }
}
