// Renderer-agnostic UI label constants — colors and display names that
// the HUD overlays (waypoint paths, selection labels) need without
// pulling in the rendering layer. Lifted out of render/types.ts so the
// HUD doesn't depend on the 2D module.

import type { WaypointType, ActionType, BuildingType } from './sim/types';
import { getUnitBlueprint } from './sim/blueprints';
import { getBuildingConfig } from './sim/buildConfigs';

/** Waypoint marker colors by type — legacy factory rally points. */
export const WAYPOINT_COLORS: Record<WaypointType, number> = {
  move: 0x00ff00,    // Green
  patrol: 0x0088ff,  // Blue
  fight: 0xff4444,   // Red
};

/** Unit action queue colors. */
export const ACTION_COLORS: Record<ActionType, number> = {
  move: 0x00ff00,    // Green
  patrol: 0x0088ff,  // Blue
  fight: 0xff4444,   // Red
  build: 0xffcc00,   // Yellow for building
  repair: 0x44ff44,  // Light green for repair
  attack: 0xff0000,  // Red for attack
};

/** Text shown above a selected unit — the blueprint's canonical
 *  display name (e.g. 'Commander', 'Tick', 'Mammoth'). Falls back to
 *  the raw unitType id if the blueprint can't be resolved. */
export function labelTextForUnit(entity: import('./sim/types').Entity): string {
  const unitType = entity.unit?.unitType;
  if (!unitType) return 'Unit';
  try {
    return getUnitBlueprint(unitType).name;
  } catch {
    return unitType;
  }
}

/** Text shown above a selected building — the building config's
 *  canonical display name (e.g. 'Solar Panel', 'Factory'). */
export function labelTextForBuilding(entity: import('./sim/types').Entity): string {
  const t = entity.buildingType as BuildingType | undefined;
  if (!t) return 'Building';
  return getBuildingConfig(t)?.name ?? 'Building';
}
