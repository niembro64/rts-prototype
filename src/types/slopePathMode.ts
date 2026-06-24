/** Pathfinding slope-traversal policy. Battle-level, deterministic world
 *  state (set via a command, included in the canonical state hash).
 *
 *  - `directional` (default, today's behaviour): descending and flat steps are
 *    always legal — gravity assists, so a unit may drive down or fall off any
 *    slope — while only uphill is gated by the unit's climb ability.
 *  - `symmetric`: the climb gate applies regardless of travel direction, so a
 *    face too steep for the unit to climb blocks the route both up AND down. */
export type SlopePathMode = 'directional' | 'symmetric';

export const DEFAULT_SLOPE_PATH_MODE: SlopePathMode = 'directional';

export function isSlopePathMode(value: unknown): value is SlopePathMode {
  return value === 'directional' || value === 'symmetric';
}
