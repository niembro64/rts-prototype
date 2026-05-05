/**
 * Building Blueprints
 *
 * Single source of truth for authored building facts. Runtime building
 * configs, client render profiles, and targeting/hover anchors all derive
 * from this table.
 */

import type { BuildingAnchorProfile, BuildingRenderProfile, BuildingType, ResourceCost } from '../types';
import type { BuildingTurretMount, EntityHudBlueprint } from '../../../types/blueprints';
import {
  EXTRACTOR_METAL_PER_SECOND,
  METAL_DEPOSIT_RESOURCE_CELLS,
  SOLAR_ENERGY_PER_SECOND,
  WIND_ENERGY_PER_SECOND,
} from '../../../config';
import { CONSTRUCTION_TURRET_HEAD_RADIUS } from './turrets';

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
  energyProduction?: number;
  metalProduction?: number;
  constructionRate?: number;
  renderProfile: BuildingRenderProfile;
  /** Primary visual/anchor height above ground, in world units. */
  visualHeight: number;
  anchorProfile: BuildingAnchorProfile;
  hud: EntityHudBlueprint;
  /** Optional reusable turret hardpoints mounted on this building.
   *  Building mount coordinates are absolute world units relative to
   *  the building center/base, not body-radius fractions like units. */
  turrets?: BuildingTurretMount[];
};

export const DEFAULT_BUILDING_VISUAL_HEIGHT = 120;
export const SOLAR_BUILDING_VISUAL_HEIGHT = 52;
export const WIND_BUILDING_VISUAL_HEIGHT = 250;
export const FACTORY_BASE_VISUAL_HEIGHT = 30;
export const EXTRACTOR_BUILDING_VISUAL_HEIGHT = 50;
export const FACTORY_CONSTRUCTION_TURRET_MOUNT_Z =
  FACTORY_BASE_VISUAL_HEIGHT + CONSTRUCTION_TURRET_HEAD_RADIUS;

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

export const BUILDING_BLUEPRINTS: Record<BuildingType, BuildingBlueprint> = {
  solar: {
    id: 'solar',
    name: 'Solar',
    gridWidth: 3,
    gridHeight: 3,
    gridDepth: 1,
    hp: 200,
    cost: { energy: 100, mana: 100, metal: 100 },
    energyProduction: SOLAR_ENERGY_PER_SECOND,
    renderProfile: 'solar',
    visualHeight: SOLAR_BUILDING_VISUAL_HEIGHT,
    anchorProfile: 'constantVisualTop',
    hud: {
      barsOffsetAboveTop: 12,
    },
  },
  wind: {
    id: 'wind',
    name: 'Wind',
    gridWidth: 2,
    gridHeight: 2,
    gridDepth: 5,
    hp: 100,
    cost: { energy: 60, mana: 60, metal: 60 },
    energyProduction: WIND_ENERGY_PER_SECOND,
    renderProfile: 'wind',
    visualHeight: WIND_BUILDING_VISUAL_HEIGHT,
    anchorProfile: 'constantVisualTop',
    hud: {
      barsOffsetAboveTop: -10,
    },
  },
  factory: {
    id: 'factory',
    name: 'Fabricator',
    // Fabricators are just their construction tower. Units are assembled
    // outside this small blocking footprint, not inside a reserved yard.
    gridWidth: 2,
    gridHeight: 2,
    gridDepth: 6,
    hp: 800,
    cost: { energy: 300, mana: 300, metal: 300 },
    constructionRate: 100,
    renderProfile: 'factory',
    visualHeight: FACTORY_BASE_VISUAL_HEIGHT,
    anchorProfile: 'factoryTower',
    hud: {
      barsOffsetAboveTop: 12,
    },
    turrets: [
      {
        turretId: 'constructionTurret',
        mount: { x: 0, y: 0, z: FACTORY_CONSTRUCTION_TURRET_MOUNT_Z },
        visualVariant: 'large',
      },
    ],
  },
  extractor: {
    id: 'extractor',
    name: 'Extractor',
    // Matches the logical square metal-deposit footprint exactly.
    gridWidth: METAL_DEPOSIT_RESOURCE_CELLS,
    gridHeight: METAL_DEPOSIT_RESOURCE_CELLS,
    gridDepth: 2,
    hp: 250,
    cost: { energy: 80, mana: 80, metal: 80 },
    metalProduction: EXTRACTOR_METAL_PER_SECOND,
    renderProfile: 'extractor',
    visualHeight: EXTRACTOR_BUILDING_VISUAL_HEIGHT,
    anchorProfile: 'constantVisualTop',
    hud: {
      barsOffsetAboveTop: 38,
    },
  },
};

for (const [id, blueprint] of Object.entries(BUILDING_BLUEPRINTS)) {
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
  if (blueprint.turrets) {
    for (let i = 0; i < blueprint.turrets.length; i++) {
      const mount = blueprint.turrets[i].mount;
      if (
        !Number.isFinite(mount.x) ||
        !Number.isFinite(mount.y) ||
        !Number.isFinite(mount.z)
      ) {
        throw new Error(
          `Invalid building turret mount for ${id}[${i}] ${blueprint.turrets[i].turretId}: mount x/y/z must be finite`,
        );
      }
    }
  }
}

export function getBuildingBlueprint(type: BuildingType): BuildingBlueprint {
  return BUILDING_BLUEPRINTS[type];
}

export function getAllBuildingBlueprints(): BuildingBlueprint[] {
  return Object.values(BUILDING_BLUEPRINTS);
}
