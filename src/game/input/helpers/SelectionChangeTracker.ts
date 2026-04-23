// SelectionChangeTracker — detect when the owned-selected set has
// changed since the last poll. Both the 2D and 3D input paths want
// to reset the waypoint mode back to 'move' whenever the player's
// selection changes (a common RTS convention so 'fight' / 'patrol'
// don't silently persist into a new squad).
//
// The tracker owns a Set<EntityId> internally. `poll()` returns true
// exactly once per change and commits the new state, so callers just
// do:
//
//   if (tracker.poll(source, playerId)) setWaypointMode('move');

import type { EntityId, PlayerId } from '../../sim/types';
import type { SelectionEntitySource } from './SelectionHelper';

export class SelectionChangeTracker {
  // Reused Set — cleared + refilled in place on change, never reallocated.
  private prev = new Set<EntityId>();

  /** Compare the current owned-selected set against the cached one.
   *  On the first call after any change (add or remove), commit the
   *  new state and return true. Otherwise return false. */
  poll(source: SelectionEntitySource, playerId: PlayerId): boolean {
    const units = source.getUnits();

    let currentCount = 0;
    let changed = false;
    for (const u of units) {
      if (u.selectable?.selected && u.ownership?.playerId === playerId) {
        currentCount++;
        if (!this.prev.has(u.id)) changed = true;
      }
    }
    // A deselect leaves the prev set bigger than currentCount.
    if (!changed && currentCount !== this.prev.size) changed = true;

    if (changed) {
      this.prev.clear();
      for (const u of units) {
        if (u.selectable?.selected && u.ownership?.playerId === playerId) {
          this.prev.add(u.id);
        }
      }
    }
    return changed;
  }

  /** Forget the cached selection — useful when swapping entity sources
   *  (renderer swap, game restart). */
  reset(): void {
    this.prev.clear();
  }
}
