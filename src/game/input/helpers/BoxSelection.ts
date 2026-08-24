// Screen-rect box-selection: walk owned entities, project each world
// position to screen pixels, keep the ones that fall inside the drag
// rect, and prefer units over buildings. The renderer-specific
// projection is abstracted as a ProjectToScreen callback.

import type { Entity, EntityId, PlayerId } from '../../sim/types';
import { entityHasBarAttackCommand } from '../../sim/unitCommandCapabilities';
import type { SelectionEntitySource } from './SelectionHelper';

export type ScreenRect = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Project an entity's visual center to screen-pixel coords. Callers
 *  receive the full entity so the 3D path can pick an appropriate
 *  vertical height per entity kind (commanders are taller than
 *  regular units, buildings sit flat on the ground) instead of a
 *  single magic constant that's wrong for most of them.
 *
 *  The `behind` flag lets 3D callers reject points behind the
 *  camera (NDC z >= 1 after project()) — the 2D path never sets it.
 */
export type ProjectToScreen = (
  entity: Entity,
  out: { x: number; y: number; behind: boolean },
) => void;

export type ScreenRectSelectionOptions = {
  readonly includeBuildingsWithUnits?: boolean;
  readonly mobileOnly?: boolean;
  readonly idleOnly?: boolean;
  readonly sameTypeOnly?: boolean;
  readonly previousSelection?: readonly Entity[];
};

type SelectBoxHeldModifier = 'sameType' | 'idle';

type ScreenRectSelectionModifierState = {
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly selectBoxIdleHeld?: boolean;
  readonly selectBoxSameTypeHeld?: boolean;
  readonly previousSelection?: readonly Entity[];
};

type ResolvedScreenRectSelectionModifiers = {
  readonly additive: boolean;
  readonly subtractive: boolean;
  readonly options: ScreenRectSelectionOptions;
};

type BarSelectionClickTap = {
  readonly typeKey: string;
  readonly timeMs: number;
  readonly clientX: number;
  readonly clientY: number;
};

/** Recoil's default DoubleClickTime is 200 ms; BAR's Ignore Self selection
 * widget accepts a 12-pixel Manhattan movement between the two taps. */
const BAR_SELECTION_DOUBLE_CLICK_MS = 200;
const BAR_SELECTION_DOUBLE_CLICK_MAX_MANHATTAN_PX = 12;

export function isBarSameTypeSelectionDoubleClick(
  previous: BarSelectionClickTap | null,
  current: BarSelectionClickTap,
): boolean {
  if (previous === null || previous.typeKey !== current.typeKey) return false;
  const elapsedMs = current.timeMs - previous.timeMs;
  if (elapsedMs < 0 || elapsedMs > BAR_SELECTION_DOUBLE_CLICK_MS) return false;
  return Math.abs(current.clientX - previous.clientX) + Math.abs(current.clientY - previous.clientY)
    <= BAR_SELECTION_DOUBLE_CLICK_MAX_MANHATTAN_PX;
}

export function selectBoxHeldModifierForKeyCode(code: string): SelectBoxHeldModifier | null {
  if (code === 'KeyZ') return 'sameType';
  if (code === 'Space') return 'idle';
  return null;
}

export function resolveScreenRectSelectionModifiers(
  state: ScreenRectSelectionModifierState,
): ResolvedScreenRectSelectionModifiers {
  const subtractive = Boolean(state.ctrlKey || state.metaKey);
  return {
    additive: Boolean(state.shiftKey) && !subtractive,
    subtractive,
    options: {
      // BAR's Ctrl deselect operates on the raw in-box set. Do not let the
      // ordinary unit-over-building preference hide a building that should
      // be removed from the drag-start selection.
      includeBuildingsWithUnits: Boolean(state.shiftKey) || subtractive,
      // SmartSelect's deselect branch consumes its raw mouseSelection before
      // idle/same/mobile preference filters run. Modifier chords therefore
      // cannot accidentally protect an in-box entity from Ctrl removal.
      mobileOnly: !subtractive && Boolean(state.altKey),
      idleOnly: !subtractive && Boolean(state.selectBoxIdleHeld),
      sameTypeOnly: !subtractive && Boolean(state.selectBoxSameTypeHeld),
      previousSelection: state.previousSelection,
    },
  };
}

function isIdleUnit(entity: Entity): boolean {
  return entity.unit?.actions.length === 0;
}

function buildSameTypeFilters(
  selection: readonly Entity[] | undefined,
): { unitBlueprintIds: Set<string>; buildingBlueprintIds: Set<string> } {
  const unitBlueprintIds = new Set<string>();
  const buildingBlueprintIds = new Set<string>();
  if (selection === undefined) return { unitBlueprintIds, buildingBlueprintIds };
  for (let i = 0; i < selection.length; i++) {
    const entity = selection[i];
    const unitBlueprintId = entity.unit?.unitBlueprintId;
    if (unitBlueprintId) unitBlueprintIds.add(unitBlueprintId);
    const buildingBlueprintId = entity.buildingBlueprintId;
    if (buildingBlueprintId) buildingBlueprintIds.add(buildingBlueprintId);
  }
  return { unitBlueprintIds, buildingBlueprintIds };
}

function canIncludeUnit(
  entity: Entity,
  sameTypeFilters: { unitBlueprintIds: Set<string>; buildingBlueprintIds: Set<string> },
  options: ScreenRectSelectionOptions,
): boolean {
  if (options.idleOnly && !isIdleUnit(entity)) return false;
  if (options.mobileOnly) {
    // selectbox_mobile is named after mobility, but Smart Select implements
    // it as its combatFilter: an armed non-builder (plus BAR's explicitly
    // authored combat exceptions, represented locally by the BAR Attack
    // capability). Constructors and unarmed transports are not included.
    if (entity.builder !== null || !entityHasBarAttackCommand(entity)) return false;
  }
  if (!options.sameTypeOnly) return true;
  if (
    sameTypeFilters.unitBlueprintIds.size === 0 &&
    sameTypeFilters.buildingBlueprintIds.size === 0
  ) return true;
  const unitBlueprintId = entity.unit?.unitBlueprintId;
  return unitBlueprintId !== undefined && sameTypeFilters.unitBlueprintIds.has(unitBlueprintId);
}

function canIncludeBuilding(
  entity: Entity,
  sameTypeFilters: { unitBlueprintIds: Set<string>; buildingBlueprintIds: Set<string> },
  options: ScreenRectSelectionOptions,
): boolean {
  if (options.mobileOnly || options.idleOnly) return false;
  if (!options.sameTypeOnly) return true;
  if (
    sameTypeFilters.unitBlueprintIds.size === 0 &&
    sameTypeFilters.buildingBlueprintIds.size === 0
  ) return true;
  const buildingBlueprintId = entity.buildingBlueprintId;
  return buildingBlueprintId != null && sameTypeFilters.buildingBlueprintIds.has(buildingBlueprintId);
}

export function entityMatchesScreenRectSelectionOptions(
  entity: Entity,
  options: ScreenRectSelectionOptions = {},
): boolean {
  const sameTypeFilters = buildSameTypeFilters(options.previousSelection);
  if (entity.unit) return canIncludeUnit(entity, sameTypeFilters, options);
  if (entity.building) return canIncludeBuilding(entity, sameTypeFilters, options);
  return false;
}

/** Find owned entities whose screen-projected position falls inside
 *  the rect. Units take precedence unless the caller requests
 *  includeBuildingsWithUnits, which maps BAR's Shift/selectbox_any
 *  modifier onto this 3D selection path. */
export function selectEntitiesInScreenRect(
  source: SelectionEntitySource,
  rect: ScreenRect,
  /** The selecting seat, or undefined for a seatless SPECTATOR — owner
   *  filters are skipped entirely then, so a box keeps every in-rect
   *  entity regardless of side (the preference rules stay owner-blind). */
  playerId: PlayerId | undefined,
  project: ProjectToScreen,
  options: ScreenRectSelectionOptions = {},
): EntityId[] {
  const unitIds: EntityId[] = [];
  const preferredUnitIds: EntityId[] = [];
  const buildingIds: EntityId[] = [];
  const sameTypeFilters = buildSameTypeFilters(options.previousSelection);

  // Reuse one out object to avoid per-entity allocations on a hot path.
  const out = { x: 0, y: 0, behind: false };

  const isInsideRect = (entity: Entity): boolean => {
    out.behind = false;
    project(entity, out);
    return !out.behind &&
      out.x >= rect.minX && out.x <= rect.maxX &&
      out.y >= rect.minY && out.y <= rect.maxY;
  };

  for (const u of source.getUnits()) {
    if (playerId !== undefined && u.ownership?.playerId !== playerId) continue;
    if (!canIncludeUnit(u, sameTypeFilters, options)) continue;
    if (!isInsideRect(u)) continue;
    unitIds.push(u.id);
    // Ordinary BAR Smart Select treats constructors as a lower
    // preference when combat/mobile units share a box. Shift/selectbox_any
    // bypasses this; Alt already applied the stricter combat filter above.
    if (u.builder === null) preferredUnitIds.push(u.id);
  }
  if (unitIds.length > 0 && !options.includeBuildingsWithUnits) {
    if (!options.mobileOnly && preferredUnitIds.length > 0) return preferredUnitIds;
    return unitIds;
  }

  for (const b of source.getBuildings()) {
    if (playerId !== undefined && b.ownership?.playerId !== playerId) continue;
    if (!canIncludeBuilding(b, sameTypeFilters, options)) continue;
    if (isInsideRect(b)) buildingIds.push(b.id);
  }
  return unitIds.length > 0 ? [...unitIds, ...buildingIds] : buildingIds;
}
