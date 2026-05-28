import type { Entity } from '../sim/types';
import { getUnitBlueprint } from '../sim/blueprints';
import { getBuildingBlueprint } from '../sim/blueprints/buildings';
import type { EntityHudBlueprint } from '@/types/blueprints';
import {
  DEFAULT_BUILDING_HUD_LAYOUT,
  DEFAULT_UNIT_HUD_LAYOUT,
} from '@/config';

/** Vertical world Y (THREE up-axis) of an entity's HUD anchor: the top
 *  of its push/footprint sphere — body center (`transform.z`) plus the
 *  push radius for units, or half the cuboid height for buildings. Bars
 *  and names are then offset above the *projected* anchor by a constant
 *  pixel distance (see HudScreenSpace), so the on-screen gap is
 *  zoom-invariant.
 *
 *  The anchor is deliberately static: it tracks only body center +
 *  push, never live turret pitch / barrel elevation, so bars don't bob
 *  vertically as turrets aim. */
export function getEntityHudAnchorY(entity: Entity): number {
  if (entity.unit) return entity.transform.z + entity.unit.radius.push;
  if (entity.building) return entity.transform.z + entity.building.depth / 2;
  return entity.transform.z;
}

function getUnitHudLayout(unit: Entity): EntityHudBlueprint {
  const unitType = unit.unit?.unitType;
  if (!unitType) return DEFAULT_UNIT_HUD_LAYOUT;
  try {
    return getUnitBlueprint(unitType).hud ?? DEFAULT_UNIT_HUD_LAYOUT;
  } catch {
    return DEFAULT_UNIT_HUD_LAYOUT;
  }
}

function getBuildingHudLayout(building: Entity): EntityHudBlueprint {
  const buildingType = building.buildingType;
  if (!buildingType) return DEFAULT_BUILDING_HUD_LAYOUT;
  try {
    return getBuildingBlueprint(buildingType).hud ?? DEFAULT_BUILDING_HUD_LAYOUT;
  } catch {
    return DEFAULT_BUILDING_HUD_LAYOUT;
  }
}

/** Screen-pixel gap from the projected anchor up to the bottom edge of
 *  the first (bottom) bar. Per-blueprint, defaulting to the global HUD
 *  layout. */
export function getEntityHudBarsBaseGapPx(entity: Entity): number {
  if (entity.unit) return getUnitHudLayout(entity).barsOffsetAboveTop;
  if (entity.building) return getBuildingHudLayout(entity).barsOffsetAboveTop;
  return DEFAULT_UNIT_HUD_LAYOUT.barsOffsetAboveTop;
}
