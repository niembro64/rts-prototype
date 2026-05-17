import type { Entity, EntityId } from '../sim/types';
import { shouldRunOnStride } from '../math';

export type PredictionLodContext = {
  /** PLAYER CLIENT LOD global cadence: frames to skip before
   *  another client prediction step. 0 means every render frame. */
  physicsPredictionFramesSkip: number;
};

export type PredictionStep = {
  entityDeltaMs: number;
  targetDeltaMs: number;
};

type PredictionAccumulator = {
  entityMs: number;
  targetMs: number;
};

export class ClientPredictionLod {
  private accums: Map<EntityId, PredictionAccumulator> = new Map();

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
  }

  frameStride(
    entity: Entity,
    lod: PredictionLodContext | undefined,
    isProjectileSourceSelected: (sourceId: EntityId) => boolean,
  ): number {
    if (entity.selectable?.selected === true) return 1;
    if (entity.projectile && isProjectileSourceSelected(entity.projectile.sourceEntityId)) {
      return 1;
    }
    const globalFramesSkip = Math.max(0, Math.floor(lod?.physicsPredictionFramesSkip ?? 0));
    return globalFramesSkip + 1;
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
    if (!shouldRunOnStride(frameCounter, stride, id)) {
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
}
