/**
 * Building blueprints.
 *
 * Authored building facts live in buildings.json. This module keeps
 * the current TypeScript API for validation, renderer helpers, and
 * derived runtime config while the blueprint table itself is data.
 */

import type { BuildingAnchorProfile, BuildingRenderProfile, BuildingType, ResourceCost } from '../types';
import type {
  BuildingTurretMount,
  DetectorBlueprint,
  EntityHudBlueprint,
} from '../../../types/blueprints';
import rawBuildingBlueprints from './buildings.json';
import { assertExplicitFields } from './jsonValidation';

export type BuildingBlueprint = {
  id: BuildingType;
  name: string;
  gridWidth: number;
  gridHeight: number;
  gridDepth: number;
  hp: number;
  /** Authored per-resource build cost. BUILDING_CONFIGS applies
   *  COST_MULTIPLIER. Each resource bar fills independently from the
   *  owner's stockpile. */
  cost: ResourceCost;
  energyProduction: number | null;
  metalProduction: number | null;
  constructionRate: number | null;
  renderProfile: BuildingRenderProfile;
  /** Primary visual/anchor height above ground, in world units. */
  visualHeight: number;
  anchorProfile: BuildingAnchorProfile;
  hud: EntityHudBlueprint;
  cloak: null;
  /** Optional reusable turret hardpoints mounted on this building.
   *  Building mount coordinates are absolute world units relative to
   *  the building center/base, not body-radius fractions like units. */
  turrets: BuildingTurretMount[];
  detector: DetectorBlueprint | null;
};

export const BUILDING_BLUEPRINTS =
  rawBuildingBlueprints as Record<BuildingType, BuildingBlueprint>;

const BUILDING_EXPLICIT_FIELDS = [
  'energyProduction',
  'metalProduction',
  'constructionRate',
  'turrets',
  'detector',
  'cloak',
] as const;

export const DEFAULT_BUILDING_VISUAL_HEIGHT = 120;
export const SOLAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.solar.visualHeight;
export const WIND_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.wind.visualHeight;
export const FACTORY_BASE_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.factory.visualHeight;
export const EXTRACTOR_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.extractor.visualHeight;
export const RADAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.radar.visualHeight;
export const MEGA_BEAM_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.megaBeamTower.visualHeight;
export const CANNON_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.cannonTower.visualHeight;
export const FACTORY_CONSTRUCTION_TURRET_MOUNT_Z =
  BUILDING_BLUEPRINTS.factory.turrets[0]?.mount.z ?? FACTORY_BASE_VISUAL_HEIGHT;
/** Pivot height for the megaBeam turret on the tower — head sits just
 *  above the body socket so the barrel clears the tapered hex shaft. */
export const MEGA_BEAM_TOWER_TURRET_MOUNT_Z =
  BUILDING_BLUEPRINTS.megaBeamTower.turrets[0]?.mount.z ??
  MEGA_BEAM_TOWER_VISUAL_HEIGHT;
/** Pivot height for the cannon tower's heavier static turret head. */
export const CANNON_TOWER_TURRET_MOUNT_Z =
  BUILDING_BLUEPRINTS.cannonTower.turrets[0]?.mount.z ??
  CANNON_TOWER_VISUAL_HEIGHT;

export type FactoryBuildingVisualMetrics = {
  minDim: number;
  baseHeight: number;
  towerRadius: number;
  collarRadius: number;
  towerHeight: number;
  towerBaseY: number;
  pylonRadius: number;
  pylonOffset: number;
  pylonHeight: number;
  capY: number;
  nozzleRadius: number;
  nozzleY: number;
  visualTop: number;
};

/** Factory construction tower dimensions. This is shared by the 3D
 *  renderer and simulation-side anchors so changing the tower visual
 *  cannot desync hover bars, target points, and construction spray. */
export function getFactoryBuildingVisualMetrics(
  width: number,
  depth: number,
): FactoryBuildingVisualMetrics {
  const minDim = Math.min(width, depth);
  const towerRadius = Math.max(7, minDim * 0.22);
  const collarRadius = Math.max(towerRadius * 1.35, minDim * 0.34);
  const towerHeight = Math.max(78, minDim * 1.9);
  const towerBaseY = FACTORY_BASE_VISUAL_HEIGHT;
  const pylonRadius = Math.max(2.3, minDim * 0.055);
  const pylonOffset = Math.min(minDim * 0.38, collarRadius * 1.15);
  const pylonHeight = towerHeight * 0.66;
  const capY = towerBaseY + towerHeight + 5;
  const nozzleRadius = Math.max(6, towerRadius * 0.95);
  const nozzleY = capY + 5 + nozzleRadius * 0.45;
  return {
    minDim,
    baseHeight: FACTORY_BASE_VISUAL_HEIGHT,
    towerRadius,
    collarRadius,
    towerHeight,
    towerBaseY,
    pylonRadius,
    pylonOffset,
    pylonHeight,
    capY,
    nozzleRadius,
    nozzleY,
    visualTop: nozzleY + nozzleRadius,
  };
}

for (const [id, blueprint] of Object.entries(BUILDING_BLUEPRINTS)) {
  assertExplicitFields(`building blueprint ${id}`, blueprint, BUILDING_EXPLICIT_FIELDS);
  if (id !== blueprint.id) {
    throw new Error(`Building blueprint key mismatch: key '${id}' has id '${blueprint.id}'`);
  }
  if (!Number.isFinite(blueprint.gridWidth) || blueprint.gridWidth <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridWidth must be positive`);
  }
  if (!Number.isFinite(blueprint.gridHeight) || blueprint.gridHeight <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridHeight must be positive`);
  }
  if (!Number.isFinite(blueprint.gridDepth) || blueprint.gridDepth <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridDepth must be positive`);
  }
  if (!Number.isFinite(blueprint.visualHeight) || blueprint.visualHeight <= 0) {
    throw new Error(`Invalid building blueprint ${id}: visualHeight must be positive`);
  }
  if (
    !blueprint.hud ||
    !Number.isFinite(blueprint.hud.barsOffsetAboveTop)
  ) {
    throw new Error(
      `Invalid building blueprint ${id}: HUD barsOffsetAboveTop must be finite`,
    );
  }
}

export function getBuildingBlueprint(type: BuildingType): BuildingBlueprint {
  return BUILDING_BLUEPRINTS[type];
}

export function getAllBuildingBlueprints(): BuildingBlueprint[] {
  return Object.values(BUILDING_BLUEPRINTS);
}
