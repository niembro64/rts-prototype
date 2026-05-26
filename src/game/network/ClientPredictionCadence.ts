// Migration debt: cadence adapter for prediction against host snapshots.
// Lockstep render interpolation between local sim ticks replaces this path.

export type PredictionStep = {
  entityDeltaMs: number;
  targetDeltaMs: number;
};

export class ClientPredictionCadence {
  clear(_id: number): void {}

  clearTarget(_id: number): void {}

  clearAll(): void {}

  consumeDelta(deltaMs: number): PredictionStep {
    return { entityDeltaMs: deltaMs, targetDeltaMs: deltaMs };
  }
}
