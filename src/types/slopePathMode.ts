/** Pathfinding slope-traversal policy. Battle-level, deterministic world
 *  state (set via a command, included in the canonical state hash).
 *
 *  Every mode first requires both cells to satisfy the selected unit's
 *  medium-specific force envelope.
 *  - `directional` (default): the inter-cell rise gate applies uphill only,
 *    preserving controlled one-way descent between otherwise valid cells.
 *  - `symmetric`: the same rise gate applies regardless of travel direction,
 *    so an edge the unit cannot climb is blocked both ways. */
export type SlopePathMode = 'directional' | 'symmetric';

export const DEFAULT_SLOPE_PATH_MODE: SlopePathMode = 'directional';

export function isSlopePathMode(value: unknown): value is SlopePathMode {
  return value === 'directional' || value === 'symmetric';
}
