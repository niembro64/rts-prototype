/**
 * Building blueprints.
 *
 * Authored static facts live in buildings.json (pure infrastructure)
 * and towers.json (static turret/lock-on hosts). This module keeps
 * the current TypeScript API for validation, renderer helpers, and
 * derived runtime config while the blueprint tables themselves are data.
 */

import type { BuildingAnchorProfile, BuildingRenderProfile, BuildingBlueprintId, ResourceCost } from '../types';
import { isTowerBuildingBlueprintId } from '../../../types/buildingTypes';
import type {
  BuildingTurretMount,
  DetectorBlueprint,
  EntityBaseLedger,
  EntityHudBlueprint,
  LockOnInclusionObject,
} from '../../../types/blueprints';
import rawBuildingBlueprints from './buildings.json';
import rawTowerBlueprints from './towers.json';
import { assertExplicitFields } from './jsonValidation';
import {
  LOCK_ON_INCLUSION_FIELDS,
  assertNoInlineLockOnInclusionFields,
  validateLockOnInclusionObject,
} from './lockOnValidation';
import {
  assertTowerLockOnInclusionConfigIds,
  getTowerLockOnInclusions,
} from './lockOnConfig';
import { BUILDING_BLUEPRINT_IDS } from '../../../types/blueprintIds';
import { TURRET_BLUEPRINTS } from './turrets';
import {
  assertNumberEquals,
  assertValidEntityBaseLedger,
} from './entityBaseLedger';

export type BuildingBlueprint = Partial<LockOnInclusionObject> & {
  buildingBlueprintId: BuildingBlueprintId;
  name: string;
  gridWidth: number;
  gridHeight: number;
  gridDepth: number;
  base: EntityBaseLedger;
  hp: number;
  /** Authored per-resource build cost. BUILDING_CONFIGS applies
   *  COST_MULTIPLIER. Each construction bar fills independently from the
   *  owner's stockpile. */
  cost: ResourceCost;
  energyProduction: number | null;
  metalProduction: number | null;
  constructionRate: number | null;
  /** Source-resource throughput (units per second) for a resource
   *  converter. Each tick, a completed converter consumes this much of
   *  whichever resource is in surplus (metal vs energy) and pays out
   *  the other resource minus the configured CONVERTER TAX. `null` for
   *  any non-converter building. */
  conversionRate: number | null;
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

type JsonTowerBlueprint = Omit<BuildingBlueprint, keyof LockOnInclusionObject>;

export const PURE_BUILDING_BLUEPRINTS =
  rawBuildingBlueprints as Partial<Record<BuildingBlueprintId, BuildingBlueprint>>;
const RAW_TOWER_BLUEPRINTS =
  rawTowerBlueprints as Partial<Record<BuildingBlueprintId, JsonTowerBlueprint>>;

assertTowerLockOnInclusionConfigIds(Object.keys(RAW_TOWER_BLUEPRINTS));

export const TOWER_BLUEPRINTS = Object.fromEntries(
  Object.entries(RAW_TOWER_BLUEPRINTS).map(([id, blueprint]) => {
    assertNoInlineLockOnInclusionFields(`tower blueprint ${id}`, blueprint);
    return [
      id,
      {
        ...blueprint,
        ...getTowerLockOnInclusions(id),
      },
    ];
  }),
) as Partial<Record<BuildingBlueprintId, BuildingBlueprint>>;
const STATIC_BLUEPRINTS_BY_ID = {
  ...PURE_BUILDING_BLUEPRINTS,
  ...TOWER_BLUEPRINTS,
} as Partial<Record<BuildingBlueprintId, BuildingBlueprint>>;
for (const id of BUILDING_BLUEPRINT_IDS) {
  if (STATIC_BLUEPRINTS_BY_ID[id as BuildingBlueprintId] === undefined) {
    throw new Error(`Missing static blueprint for stable building blueprint id ${id}`);
  }
}
export const BUILDING_BLUEPRINTS = Object.fromEntries(
  BUILDING_BLUEPRINT_IDS.map((id) => [id, STATIC_BLUEPRINTS_BY_ID[id as BuildingBlueprintId]]),
) as Record<BuildingBlueprintId, BuildingBlueprint>;

for (const id of Object.keys(rawTowerBlueprints)) {
  if (Object.prototype.hasOwnProperty.call(rawBuildingBlueprints, id)) {
    throw new Error(
      `Static blueprint ${id} is authored in both buildings.json and towers.json`,
    );
  }
}

const BUILDING_EXPLICIT_FIELDS = [
  'base',
  'energyProduction',
  'metalProduction',
  'constructionRate',
  'conversionRate',
  'turrets',
  'detector',
  'cloak',
] as const;

export const DEFAULT_BUILDING_VISUAL_HEIGHT = 120;
export const SOLAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingSolar.visualHeight;
export const WIND_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingWind.visualHeight;
export const FACTORY_BASE_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.towerFabricator.visualHeight;
export const EXTRACTOR_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.buildingExtractor.visualHeight;
export const RADAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingRadar.visualHeight;
export const MEGA_BEAM_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerBeamMega.visualHeight;
export const CANNON_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerCannon.visualHeight;

function firstTurretMountZ(
  blueprint: BuildingBlueprint,
  fallback: number,
): number {
  const turret = blueprint.turrets[0];
  return turret !== undefined ? turret.mount.z : fallback;
}

export const FACTORY_CONSTRUCTION_TURRET_MOUNT_Z =
  firstTurretMountZ(BUILDING_BLUEPRINTS.towerFabricator, FACTORY_BASE_VISUAL_HEIGHT);
/** Pivot height for the megaBeam turret on the tower — head sits just
 *  above the body socket so the barrel clears the tapered hex shaft. */
export const MEGA_BEAM_TOWER_TURRET_MOUNT_Z =
  firstTurretMountZ(BUILDING_BLUEPRINTS.towerBeamMega, MEGA_BEAM_TOWER_VISUAL_HEIGHT);
/** Pivot height for the cannon tower's heavier static turret head. */
export const CANNON_TOWER_TURRET_MOUNT_Z =
  firstTurretMountZ(BUILDING_BLUEPRINTS.towerCannon, CANNON_TOWER_VISUAL_HEIGHT);

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
  const towerBlueprint = isTowerBuildingBlueprintId(id as BuildingBlueprintId);
  if (towerBlueprint) {
    assertExplicitFields(`tower blueprint ${id}`, blueprint, LOCK_ON_INCLUSION_FIELDS);
    validateLockOnInclusionObject(
      `tower blueprint ${id}`,
      blueprint as BuildingBlueprint & LockOnInclusionObject,
    );
  } else {
    for (const field of LOCK_ON_INCLUSION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(blueprint, field)) {
        throw new Error(
          `Invalid building blueprint ${id}: pure buildings do not carry lock-on inclusion field "${field}"`,
        );
      }
    }
  }
  if (id !== blueprint.buildingBlueprintId) {
    throw new Error(
      `Building blueprint key mismatch: key '${id}' has buildingBlueprintId '${blueprint.buildingBlueprintId}'`,
    );
  }
  assertValidEntityBaseLedger(`${towerBlueprint ? 'tower' : 'building'} blueprint ${id}`, blueprint.base);
  assertNumberEquals(
    `${towerBlueprint ? 'tower' : 'building'} blueprint ${id}`,
    'health',
    blueprint.hp,
    blueprint.base.health,
  );
  for (const mount of blueprint.turrets) {
    const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (!turretBlueprint) {
      throw new Error(
        `Invalid ${towerBlueprint ? 'tower' : 'building'} blueprint ${id}: unknown turretBlueprintId "${mount.turretBlueprintId}"`,
      );
    }
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

export function getBuildingBlueprint(buildingBlueprintId: BuildingBlueprintId): BuildingBlueprint {
  return BUILDING_BLUEPRINTS[buildingBlueprintId];
}

export function getAllBuildingBlueprints(): BuildingBlueprint[] {
  return Object.values(BUILDING_BLUEPRINTS);
}
