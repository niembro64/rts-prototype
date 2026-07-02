// BAR "NoDuplicateOrders" (luaui/Widgets/cmd_no_duplicate_orders.lua):
// shift-appending an attack or repair order a unit already has queued is
// dropped client-side, per unit, at command build time. Blocking is gated
// on the plain shift append only — queue-front and index inserts are
// deliberate reorderings, matching the widget's `options.coded == 16`
// (shift-only) gate. The sim never sees the duplicate, so lockstep
// semantics are untouched.

import type { Entity, EntityId } from '../../sim/types';

/** True when the command flags describe a plain shift append (the only
 *  case BAR's NoDuplicateOrders widget blocks). */
export function isPlainQueueAppend(
  queue: boolean,
  queueFront: boolean,
  queueInsertIndex?: number,
): boolean {
  return queue && !queueFront && queueInsertIndex === undefined;
}

/** True when `unit` already has the same (type, target) order anywhere in
 *  its action queue. For repair, a queued build assist on the same
 *  in-progress building counts too — BAR blocks a repair order that
 *  duplicates the build command already constructing that target. */
export function unitHasQueuedDuplicateOrder(
  unit: Entity,
  orderType: 'attack' | 'repair',
  targetId: EntityId,
): boolean {
  const actions = unit.unit?.actions;
  if (!actions) return false;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (action.type === orderType && action.targetId === targetId) return true;
    if (orderType === 'repair' && action.type === 'build' && action.buildingId === targetId) {
      return true;
    }
  }
  return false;
}
