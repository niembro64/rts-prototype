// Renderer-agnostic UI label constants — colors and display names that
// the HUD overlays (waypoint paths, selection labels) need without
// pulling in the rendering layer. Lifted out of render/types.ts so the
// HUD doesn't depend on the 2D module.

import type { WaypointType, ActionType, BuildingType } from './sim/types';
import { getUnitBlueprint } from './sim/blueprints';
import { BUILDING_CONFIGS, getBuildingConfig } from './sim/buildConfigs';
import { GRID_CELL_SIZE } from './sim/grid';

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

function inferBuildingType(entity: import('./sim/types').Entity): BuildingType | undefined {
  if (entity.buildingType && entity.buildingType in BUILDING_CONFIGS) {
    return entity.buildingType;
  }
  if (entity.factory) return 'factory';
  if (entity.building?.solar) return 'solar';

  const b = entity.building;
  if (!b) return undefined;
  for (const type of Object.keys(BUILDING_CONFIGS) as BuildingType[]) {
    const cfg = BUILDING_CONFIGS[type];
    if (
      Math.abs(b.width - cfg.gridWidth * GRID_CELL_SIZE) < 0.01 &&
      Math.abs(b.height - cfg.gridHeight * GRID_CELL_SIZE) < 0.01 &&
      Math.abs(b.depth - cfg.gridDepth * GRID_CELL_SIZE) < 0.01
    ) {
      return type;
    }
  }
  return undefined;
}

/** Text shown above a selected building — the building config's
 *  canonical display name (e.g. 'Solar Panel', 'Factory'). */
export function labelTextForBuilding(entity: import('./sim/types').Entity): string {
  const t = inferBuildingType(entity);
  if (!t) return 'Building';
  return getBuildingConfig(t)?.name ?? t;
}
