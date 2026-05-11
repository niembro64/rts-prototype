import type { EntityId, UnitAction } from './types';

export function getActionIntentStart(
  actions: readonly UnitAction[],
  finalActionIndex: number,
): number {
  let start = finalActionIndex;
  while (start > 0 && actions[start - 1].isPathExpansion) start--;
  return start;
}

export function getFirstActionIntentEnd(actions: readonly UnitAction[]): number {
  if (actions.length === 0) return -1;
  for (let i = 0; i < actions.length; i++) {
    if (!actions[i].isPathExpansion) return i;
  }
  return actions.length - 1;
}

export function getLastActionIntentFinalIndex(actions: readonly UnitAction[]): number {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (!actions[i].isPathExpansion) return i;
  }
  return -1;
}

export function hasQueuedActionIntents(actions: readonly UnitAction[]): boolean {
  const activeIntentEnd = getFirstActionIntentEnd(actions);
  return activeIntentEnd >= 0 && getLastActionIntentFinalIndex(actions) > activeIntentEnd;
}

export function getUnitActionTargetId(action: UnitAction): EntityId | undefined {
  if (action.type === 'build') return action.buildingId;
  if (
    action.type === 'attack' ||
    action.type === 'repair' ||
    action.type === 'reclaim' ||
    action.type === 'guard'
  ) {
    return action.targetId;
  }
  return undefined;
}
