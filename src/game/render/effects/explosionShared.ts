// Shared helpers for the impact and death explosion renderers.
// Kept tiny so both can import without pulling in the other's render
// code — otherwise the two renderers live in their own focused files.

/**
 * Deterministic pseudo-random function seeded from a numeric seed.
 * Used by both impact and death renderers so a given explosion
 * position always produces the same particle layout (same replay →
 * same visuals), and so re-rendering the same frame doesn't shimmer.
 */
export function createSeededRandom(seed: number): (i: number) => number {
  return (i: number) => {
    let h = ((seed + i * 127) | 0) * 2654435761;
    h = ((h >>> 16) ^ h) * 45679;
    h = ((h >>> 16) ^ h);
    return (h >>> 0) / 4294967296;
  };
}
