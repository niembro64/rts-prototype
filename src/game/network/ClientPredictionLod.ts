import type { Entity, EntityId } from '../sim/types';
import { landCellCenterForSize, landCellIndexForSize, packLandCellKey } from '../landGrid';
import { normalizeLodCellSize } from '../lodGridMath';

export type PredictionLodTier = 'rich' | 'simple' | 'mass' | 'impostor' | 'marker';

export type PredictionLodContext = {
  /** Three.js/world camera x. */
  cameraX: number;
  /** Three.js/world camera height. */
  cameraY: number;
  /** Three.js/world camera z, equivalent to sim y. */
  cameraZ: number;
  richDistance: number;
  simpleDistance: number;
  massDistance: number;
  impostorDistance: number;
  cellSize: number;
  /** PLAYER CLIENT LOD global cadence: frames to skip before
   *  another client prediction step. 0 means every render frame. */
  physicsPredictionFramesSkip: number;
  /**
   * Optional shared frame resolver. When supplied, prediction uses the
   * same cell/tier cache as rendering instead of recomputing camera
   * sphere membership inside ClientViewState. Coordinates are Three.js
   * world axes: x, height/y, z.
   */
  resolveTier?: (worldX: number, worldY: number, worldZ: number) => PredictionLodTier;
};

export type PredictionStep = {
  entityDeltaMs: number;
  targetDeltaMs: number;
};

type PredictionLodCellKey = number;

type PredictionAccumulator = {
  entityMs: number;
  targetMs: number;
};

export class ClientPredictionLod {
  private accums: Map<EntityId, PredictionAccumulator> = new Map();
  private cells: Map<PredictionLodCellKey, PredictionLodTier> = new Map();
  private richDistanceSq = 0;
  private simpleDistanceSq = 0;
  private massDistanceSq = 0;
  private impostorDistanceSq = 0;
  private cellSize = 1;

  beginFrame(lod: PredictionLodContext | undefined): void {
    if (!lod?.resolveTier) {
      this.cells.clear();
    }
    if (lod) {
      const rich = Math.max(0, lod.richDistance);
      const simple = Math.max(0, lod.simpleDistance);
      const mass = Math.max(0, lod.massDistance);
      const impostor = Math.max(0, lod.impostorDistance);
      this.cellSize = normalizeLodCellSize(lod.cellSize);
      this.richDistanceSq = rich * rich;
      this.simpleDistanceSq = simple * simple;
      this.massDistanceSq = mass * mass;
      this.impostorDistanceSq = impostor * impostor;
    } else {
      this.richDistanceSq = 0;
      this.simpleDistanceSq = 0;
      this.massDistanceSq = 0;
      this.impostorDistanceSq = 0;
      this.cellSize = 1;
    }
  }

  clear(id: EntityId): void {
    this.accums.delete(id);
  }

  clearTarget(id: EntityId): void {
    const accum = this.accums.get(id);
    if (!accum) return;
    accum.targetMs = 0;
    if (accum.entityMs <= 0) this.accums.delete(id);
  }

  clearAll(): void {
    this.accums.clear();
    this.cells.clear();
  }

  resolveTier(
    entity: Entity,
    lod: PredictionLodContext | undefined,
  ): PredictionLodTier {
    if (!lod) return 'rich';
    if (lod.resolveTier) {
      return lod.resolveTier(
        entity.transform.x,
        entity.transform.z,
        entity.transform.y,
      );
    }

    const size = this.cellSize;
    const ix = landCellIndexForSize(entity.transform.x, size);
    const iy = landCellIndexForSize(entity.transform.y, size);
    const key = packLandCellKey(ix, iy);
    const cached = this.cells.get(key);
    if (cached !== undefined) return cached;

    const cellX = landCellCenterForSize(ix, size);
    const cellY = landCellCenterForSize(iy, size);
    const dx = cellX - lod.cameraX;
    const dy = -lod.cameraY;
    const dz = cellY - lod.cameraZ;
    const tier = this.resolveTierForDistanceSq(dx * dx + dy * dy + dz * dz);
    this.cells.set(key, tier);
    return tier;
  }

  frameStride(
    tier: PredictionLodTier,
    entity: Entity,
    lod: PredictionLodContext | undefined,
    isProjectileSourceSelected: (sourceId: EntityId) => boolean,
  ): number {
    if (entity.selectable?.selected === true) return 1;
    if (entity.projectile && isProjectileSourceSelected(entity.projectile.sourceEntityId)) {
      return 1;
    }
    const globalFramesSkip = Math.max(0, Math.floor(lod?.physicsPredictionFramesSkip ?? 0));
    const sphereFramesSkip = this.framesSkipForTier(tier);
    return Math.max(globalFramesSkip, sphereFramesSkip) + 1;
  }

  consumeDelta(
    id: EntityId,
    frameCounter: number,
    deltaMs: number,
    stride: number,
  ): PredictionStep | null {
    if (stride <= 1) {
      this.clear(id);
      return { entityDeltaMs: deltaMs, targetDeltaMs: deltaMs };
    }

    let accum = this.accums.get(id);
    const accumulatedMs = Math.min((accum?.entityMs ?? 0) + deltaMs, 250);
    const targetAccumulatedMs = Math.min((accum?.targetMs ?? 0) + deltaMs, 250);
    if ((frameCounter + id) % stride !== 0) {
      if (!accum) {
        accum = { entityMs: accumulatedMs, targetMs: targetAccumulatedMs };
        this.accums.set(id, accum);
      } else {
        accum.entityMs = accumulatedMs;
        accum.targetMs = targetAccumulatedMs;
      }
      return null;
    }

    this.clear(id);
    return {
      entityDeltaMs: accumulatedMs,
      targetDeltaMs: targetAccumulatedMs,
    };
  }

  private resolveTierForDistanceSq(distanceSq: number): PredictionLodTier {
    if (this.richDistanceSq > 0 && distanceSq <= this.richDistanceSq) return 'rich';
    if (this.simpleDistanceSq > 0 && distanceSq <= this.simpleDistanceSq) return 'simple';
    if (this.massDistanceSq > 0 && distanceSq <= this.massDistanceSq) return 'mass';
    if (this.impostorDistanceSq > 0 && distanceSq <= this.impostorDistanceSq) return 'impostor';
    return 'marker';
  }

  private framesSkipForTier(tier: PredictionLodTier): number {
    switch (tier) {
      case 'rich': return 0;
      case 'simple': return 1;
      case 'mass': return 3;
      case 'impostor': return 7;
      case 'marker': return 15;
    }
  }
}
