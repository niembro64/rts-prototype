export type PredictionStep = {
  entityDeltaMs: number;
  targetDeltaMs: number;
};

export class ClientPredictionCadence {
  private readonly step: PredictionStep = {
    entityDeltaMs: 0,
    targetDeltaMs: 0,
  };

  clearAll(): void {}

  consumeDelta(deltaMs: number): PredictionStep {
    this.step.entityDeltaMs = deltaMs;
    this.step.targetDeltaMs = deltaMs;
    return this.step;
  }
}
