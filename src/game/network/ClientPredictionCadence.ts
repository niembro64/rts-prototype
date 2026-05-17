import type { EntityId } from '../sim/types';

export type PredictionStep = {
  entityDeltaMs: number;
  targetDeltaMs: number;
};

type PredictionAccumulator = {
  entityMs: number;
  targetMs: number;
};

export class ClientPredictionCadence {
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

  frameStride(): number {
    return 1;
  }

  consumeDelta(
    id: EntityId,
    _frameCounter: number,
    deltaMs: number,
    _stride: number,
  ): PredictionStep {
    this.clear(id);
    return { entityDeltaMs: deltaMs, targetDeltaMs: deltaMs };
  }
}
