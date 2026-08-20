/** Which terrain shaping step comes LAST in the generation pipeline —
 *  last wins where the two overlap (PRECEDENCE bar). Battle-level,
 *  deterministic world-generation input carried by the lobby settings
 *  contract.
 *
 *  - `perimeter-precedence` (default, the classic look): the PERIMETER
 *    ring applies after the DIVIDERS ridges, so the ridges fade to flat
 *    before the outer buffer and the ring overrides everything in its
 *    band — an unbroken rim/moat.
 *  - `dividers-precedence`: the DIVIDERS ridges apply after the
 *    PERIMETER ring — they run out to the rectangular map edge,
 *    punching through the ring, while the ring keeps full effect
 *    between them. */
export type TerrainPrecedence = 'perimeter-precedence' | 'dividers-precedence';

export const DEFAULT_TERRAIN_PRECEDENCE: TerrainPrecedence =
  'perimeter-precedence';

export function isTerrainPrecedence(
  value: unknown,
): value is TerrainPrecedence {
  return value === 'perimeter-precedence' || value === 'dividers-precedence';
}
