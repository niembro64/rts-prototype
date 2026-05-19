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
