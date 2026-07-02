// Shared idle-builder predicate — single source of truth for "which of my
// builder units count as idle". Used by the Ctrl+Tab / select.idleBuilders
// hotkey path (Input3DManager) AND the persistent idle-builders HUD panel
// (UIUpdateManager.buildIdleBuilderGroups), so clicking a panel chip always
// selects exactly the units the panel counted.
//
// Mirrors BAR gui_idle_builders.lua updateList(): command queue empty,
// alive, and not still being built (nanoframes are not idle workers).

import type { Entity } from './types';
import { isBuildInProgress } from './buildableHelpers';

export function isIdleBuilderUnit(entity: Entity): boolean {
  if (entity.builder === null || entity.unit === null) return false;
  if (entity.unit.hp <= 0) return false;
  if (isBuildInProgress(entity.buildable)) return false;
  return entity.unit.actions.length === 0;
}
