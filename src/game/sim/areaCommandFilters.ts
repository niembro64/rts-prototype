// BAR cmd_area_commands_filter.lua parity helpers, shared by the area
// command executors (sim), the command sanitizer (server), and the
// area-drag controller (client). BAR filters area repair/reclaim/
// resurrect targets by the thing hovered at the area center:
//   - Ctrl: all units in the area (for wrecks: same tech level). Our
//     blueprints have no tech levels, so Ctrl maps to the hovered
//     target's broad category ('unit' | 'building' | 'wreck').
//   - Alt: only targets sharing the hovered target's unitDefId /
//     featureDefId. Ours maps that to the exact blueprint id (wrecks
//     match on their source blueprint).
// Category and blueprint checks are both applied when both fields are
// present (the client only ever sets one; a blueprint match implies its
// category anyway, so the conjunction stays deterministic and safe).

import type { AreaCommandFilterCategory } from './commands';
import type { Entity } from './types';
import type { VegetationProp } from './vegetation';

export const AREA_COMMAND_FILTER_CATEGORIES: readonly AreaCommandFilterCategory[] =
  ['unit', 'building', 'wreck', 'vegetation'];

export function isAreaCommandFilterCategory(value: unknown): value is AreaCommandFilterCategory {
  return typeof value === 'string' &&
    AREA_COMMAND_FILTER_CATEGORIES.includes(value as AreaCommandFilterCategory);
}

/** Broad filter bucket for an area-command target. Wreck entities are
 *  buildings with a wreck component, so the wreck check runs first. */
export function areaCommandFilterCategoryOf(entity: Entity): AreaCommandFilterCategory {
  if (entity.wreck !== null) return 'wreck';
  if (entity.unit !== null) return 'unit';
  return 'building';
}

/** True when a filter category can only ever match an entity target.
 *  `vegetation` props live in their own store, so an entity scan must
 *  skip that category outright rather than testing each entity. */
export function isEntityAreaCommandFilterCategory(
  category: AreaCommandFilterCategory | undefined,
): boolean {
  return category !== 'vegetation';
}

/** Blueprint identity used by the same-type (Alt) filter. Wrecks match
 *  on the blueprint of what they were before dying — BAR's same
 *  featureDefId behaves identically because each wreck featureDef is
 *  derived from its source unitDef. Returns null for entities without
 *  any blueprint identity (they never match a blueprint filter). */
export function areaCommandFilterBlueprintIdOf(entity: Entity): string | null {
  const wreck = entity.wreck;
  if (wreck !== null) {
    return wreck.source.kind === 'unit'
      ? wreck.source.unitBlueprintId
      : wreck.source.buildingBlueprintId;
  }
  if (entity.unit !== null) return entity.unit.unitBlueprintId;
  if (entity.buildingBlueprintId !== null) return entity.buildingBlueprintId;
  return null;
}

export type AreaCommandTargetFilter = {
  filterCategory?: AreaCommandFilterCategory;
  filterBlueprintId?: string;
};

/** Client-side: turn the entity hovered at the area-drag anchor plus the
 *  Ctrl/Alt state at drag release into the command's optional filter
 *  fields. Mirrors BAR's precedence (Ctrl wins over Alt) and its rule
 *  that no hovered target means no filtering. */
export function resolveAreaCommandTargetFilter(
  hovered: Entity | null | undefined,
  ctrlHeld: boolean,
  altHeld: boolean,
): AreaCommandTargetFilter {
  if (hovered === null || hovered === undefined) return {};
  if (ctrlHeld) return { filterCategory: areaCommandFilterCategoryOf(hovered) };
  if (altHeld) {
    const blueprintId = areaCommandFilterBlueprintIdOf(hovered);
    return blueprintId !== null ? { filterBlueprintId: blueprintId } : {};
  }
  return {};
}

/** Same as `resolveAreaCommandTargetFilter` for a hovered vegetation
 *  prop. BAR's Ctrl/Alt split maps cleanly: Ctrl keeps the whole
 *  feature category, Alt narrows to the hovered prop's own kind — the
 *  vegetation analogue of matching one featureDefId. */
export function resolveVegetationAreaCommandTargetFilter(
  hovered: VegetationProp,
  ctrlHeld: boolean,
  altHeld: boolean,
): AreaCommandTargetFilter {
  if (ctrlHeld) return { filterCategory: 'vegetation' };
  if (altHeld) return { filterBlueprintId: hovered.kind };
  return {};
}

/** True when a vegetation prop passes the optional area-command filter
 *  fields. Props are their own category, so any entity-shaped category
 *  filter excludes them and vice versa. */
export function vegetationAreaTargetMatchesCommandFilter(
  prop: VegetationProp,
  filterCategory: AreaCommandFilterCategory | undefined,
  filterBlueprintId: string | undefined,
): boolean {
  if (filterCategory !== undefined && filterCategory !== 'vegetation') return false;
  if (filterBlueprintId !== undefined && filterBlueprintId !== prop.kind) return false;
  return true;
}

/** True when `target` passes the optional area-command filter fields.
 *  Absent fields filter nothing (the default, unfiltered command). */
export function areaTargetMatchesCommandFilter(
  target: Entity,
  filterCategory: AreaCommandFilterCategory | undefined,
  filterBlueprintId: string | undefined,
): boolean {
  if (filterCategory !== undefined && areaCommandFilterCategoryOf(target) !== filterCategory) {
    return false;
  }
  if (filterBlueprintId !== undefined && areaCommandFilterBlueprintIdOf(target) !== filterBlueprintId) {
    return false;
  }
  return true;
}
