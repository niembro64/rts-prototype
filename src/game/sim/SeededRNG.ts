// Canonical deterministic random stream. Ambient time is sampled once by the
// match host and enters here only as the immutable game-generation seed.
export class SeededRNG {
  private readonly gameGenerationSeed: number;
  private streamState: number;

  constructor(gameGenerationSeed: number) {
    this.gameGenerationSeed = gameGenerationSeed >>> 0;
    this.streamState = this.gameGenerationSeed;
  }

  /**
   * Next deterministic sample for a player at a simulation tick.
   * streamState is the canonical call ordinal: it prevents repeated values
   * when one player legitimately requests multiple samples in the same tick.
   */
  next(playerNumber: number = 0, simulationTick: number = 0): number {
    this.streamState = (this.streamState + 0x6d2b79f5) >>> 0;
    let t = this.streamState;
    t ^= this.gameGenerationSeed;
    t ^= Math.imul(playerNumber >>> 0, 0x9e3779b1);
    t ^= Math.imul(simulationTick >>> 0, 0x85ebca6b);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Random in range [min, max).
  range(
    min: number,
    max: number,
    playerNumber: number = 0,
    simulationTick: number = 0,
  ): number {
    return min + this.next(playerNumber, simulationTick) * (max - min);
  }

  getSeed(): number {
    return this.streamState;
  }

  setSeed(seed: number): void {
    this.streamState = seed >>> 0;
  }

  getGameGenerationSeed(): number {
    return this.gameGenerationSeed;
  }
}
