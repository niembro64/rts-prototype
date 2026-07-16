/** Pathfinding slope-traversal policy. Battle-level, deterministic world
 *  state (set via a command, included in the canonical state hash).
 *
 *  Every mode first requires a surface the unit can control from a standstill.
 *  - `directional` (default): the stricter powered-climb gate applies uphill;
 *    downhill edges need only remain inside the standstill envelope.
 *  - `symmetric`: the powered-climb gate applies regardless of travel
 *    direction, so terrain the unit cannot climb is blocked both ways. */
export type SlopePathMode = 'directional' | 'symmetric';

export const DEFAULT_SLOPE_PATH_MODE: SlopePathMode = 'directional';

export function isSlopePathMode(value: unknown): value is SlopePathMode {
  return value === 'directional' || value === 'symmetric';
}
