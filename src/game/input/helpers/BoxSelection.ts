// Screen-rect box-selection: walk owned entities, project each world
// position to screen pixels, keep the ones that fall inside the drag
// rect, and prefer units over buildings. The renderer-specific
// projection is abstracted as a ProjectToScreen callback.

import type { Entity, EntityId, PlayerId } from '../../sim/types';
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
  if (!options.sameTypeOnly) return true;
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
  const buildingBlueprintId = entity.buildingBlueprintId;
  return buildingBlueprintId != null && sameTypeFilters.buildingBlueprintIds.has(buildingBlueprintId);
}

export function entityMatchesScreenRectSelectionOptions(
  entity: Entity,
  options: ScreenRectSelectionOptions = {},
): boolean {
  const sameTypeFilters = buildSameTypeFilters(options.previousSelection);
  const sameTypeHasAnyFilter =
    sameTypeFilters.unitBlueprintIds.size > 0 ||
    sameTypeFilters.buildingBlueprintIds.size > 0;
  if (options.sameTypeOnly && !sameTypeHasAnyFilter) return false;
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
  playerId: PlayerId,
  project: ProjectToScreen,
  options: ScreenRectSelectionOptions = {},
): EntityId[] {
  const unitIds: EntityId[] = [];
  const buildingIds: EntityId[] = [];
  const sameTypeFilters = buildSameTypeFilters(options.previousSelection);
  const sameTypeHasAnyFilter =
    sameTypeFilters.unitBlueprintIds.size > 0 ||
    sameTypeFilters.buildingBlueprintIds.size > 0;
  if (options.sameTypeOnly && !sameTypeHasAnyFilter) return [];

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
    if (u.ownership?.playerId !== playerId) continue;
    if (!canIncludeUnit(u, sameTypeFilters, options)) continue;
    if (isInsideRect(u)) unitIds.push(u.id);
  }
  if (unitIds.length > 0 && !options.includeBuildingsWithUnits) return unitIds;

  for (const b of source.getBuildings()) {
    if (b.ownership?.playerId !== playerId) continue;
    if (!canIncludeBuilding(b, sameTypeFilters, options)) continue;
    if (isInsideRect(b)) buildingIds.push(b.id);
  }
  return unitIds.length > 0 ? [...unitIds, ...buildingIds] : buildingIds;
}
