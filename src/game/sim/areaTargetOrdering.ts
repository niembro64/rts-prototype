/** BAR-parity ordering for area-command fan-out (cmd_area_mex.lua
 * `calculateCmdOrder`, unit_smart_area_reclaim.lua `tsp`): a greedy chained
 * nearest-neighbour walk. The first pick is the target nearest the seed and
 * every later hop is measured from the target just picked, so a builder
 * travels one coherent path across the field instead of starring out and
 * back from a single sort origin. The optional per-target worth divides the
 * squared distance (BAR's area-mex weighting), letting a slightly farther
 * rich deposit outrank a near poor one.
 *
 * Orders in place and returns the same array. O(n²) over command-time target
 * counts, and deterministic: squared distances with an id tie-break, so every
 * peer expands an area command into the same sequence. */
export function orderAreaTargetsByChainedNearest<T>(
  targets: T[],
  seedX: number,
  seedY: number,
  getX: (target: T) => number,
  getY: (target: T) => number,
  getId: (target: T) => number,
  getWorth: ((target: T) => number) | null = null,
): T[] {
  let fromX = seedX;
  let fromY = seedY;
  for (let i = 0; i < targets.length - 1; i++) {
    let bestIndex = i;
    let bestScore = Infinity;
    let bestId = Infinity;
    for (let j = i; j < targets.length; j++) {
      const target = targets[j];
      const dx = getX(target) - fromX;
      const dy = getY(target) - fromY;
      let score = dx * dx + dy * dy;
      if (getWorth !== null) score /= Math.max(1, getWorth(target));
      const id = getId(target);
      if (score < bestScore || (score === bestScore && id < bestId)) {
        bestIndex = j;
        bestScore = score;
        bestId = id;
      }
    }
    const picked = targets[bestIndex];
    targets[bestIndex] = targets[i];
    targets[i] = picked;
    fromX = getX(picked);
    fromY = getY(picked);
  }
  return targets;
}
