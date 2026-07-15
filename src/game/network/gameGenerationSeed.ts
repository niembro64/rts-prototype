/** Stable fallback for tests, replays, and low-level server fixtures that do
 * not represent a newly hosted live match. Live hosts must provide a seed. */
export const DEFAULT_GAME_GENERATION_SEED = 42;

/**
 * Create the one immutable seed owned by a match host.
 *
 * This is intentionally the only wall-clock boundary in game generation.
 * The returned value is distributed in canonical match initialization; no
 * simulation code reads time after the match has been created.
 */
export function createHostGameGenerationSeed(nowMs: number = Date.now()): number {
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Cannot create game generation seed from ${String(nowMs)}`);
  }
  const milliseconds = Math.max(0, Math.trunc(nowMs));
  const low = milliseconds >>> 0;
  const high = Math.floor(milliseconds / 0x1_0000_0000) >>> 0;
  return avalanche32(low ^ rotateLeft32(high, 13) ^ 0x9e37_79b9);
}

export function normalizeGameGenerationSeed(seed: number): number {
  if (!Number.isFinite(seed)) {
    throw new Error(`Invalid game generation seed: ${String(seed)}`);
  }
  return Math.trunc(seed) >>> 0;
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function avalanche32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb_352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846c_a68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}
