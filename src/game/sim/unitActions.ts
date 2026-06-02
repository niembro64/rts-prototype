import type { Unit, UnitAction } from './types';

export const EMPTY_UNIT_ACTION_HASH = 0;

export function computeUnitActionHash(actions: readonly UnitAction[]): number {
  let hash = actions.length;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    hash = (hash * 31 + action.x * 1000) | 0;
    hash = (hash * 31 + action.y * 1000) | 0;
    hash = (hash * 31 + (action.z !== undefined ? action.z * 1000 : 0)) | 0;
    hash = (hash * 31 + action.type.length) | 0;
    for (let j = 0; j < action.type.length; j++) {
      hash = (hash * 31 + action.type.charCodeAt(j)) | 0;
    }
  }
  return hash;
}

export function refreshUnitActionHash(unit: Unit): number {
  const hash = computeUnitActionHash(unit.actions);
  unit.actionHash = hash;
  return hash;
}

export function setUnitActions(unit: Unit, actions: UnitAction[]): void {
  unit.actions = actions;
  refreshUnitActionHash(unit);
}

export function replaceLeadingUnitActions(
  unit: Unit,
  deleteCount: number,
  replacements: readonly UnitAction[],
): void {
  const actions = unit.actions;
  const safeDeleteCount = Math.max(0, Math.min(deleteCount | 0, actions.length));
  const replacementCount = replacements.length;
  const tailCount = actions.length - safeDeleteCount;
  const nextLength = replacementCount + tailCount;

  if (replacementCount > safeDeleteCount) {
    actions.length = nextLength;
    for (let i = tailCount - 1; i >= 0; i--) {
      actions[replacementCount + i] = actions[safeDeleteCount + i];
    }
  } else if (replacementCount < safeDeleteCount) {
    for (let i = 0; i < tailCount; i++) {
      actions[replacementCount + i] = actions[safeDeleteCount + i];
    }
    actions.length = nextLength;
  }

  for (let i = 0; i < replacementCount; i++) {
    actions[i] = replacements[i];
  }
  refreshUnitActionHash(unit);
}

export function pushUnitAction(unit: Unit, action: UnitAction): void {
  unit.actions.push(action);
  refreshUnitActionHash(unit);
}

export function unshiftUnitAction(unit: Unit, action: UnitAction): void {
  unit.actions.unshift(action);
  refreshUnitActionHash(unit);
}

export function spliceUnitActions(
  unit: Unit,
  start: number,
  deleteCount: number,
): UnitAction[] {
  const removed = unit.actions.splice(start, deleteCount);
  if (removed.length > 0) refreshUnitActionHash(unit);
  return removed;
}

export function shiftUnitAction(unit: Unit): UnitAction | undefined {
  const action = unit.actions.shift();
  if (action) refreshUnitActionHash(unit);
  return action;
}

export function rotateFirstUnitActionToEnd(unit: Unit): UnitAction | undefined {
  const action = unit.actions.shift();
  if (action) {
    unit.actions.push(action);
    refreshUnitActionHash(unit);
  }
  return action;
}

export function assertUnitActionHashSynced(unit: Unit, context: string): void {
  if (!import.meta.env.DEV) return;
  const expected = computeUnitActionHash(unit.actions);
  if (unit.actionHash !== expected) {
    throw new Error(
      `Unit action hash drift in ${context}: cached=${unit.actionHash}, expected=${expected}`,
    );
  }
}
