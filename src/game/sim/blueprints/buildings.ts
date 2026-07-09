/**
 * Building blueprints.
 *
 * Authored static facts live in buildings.json (pure infrastructure)
 * and towers.json (static turret/lock-on hosts). This module keeps
 * the current TypeScript API for validation, renderer helpers, and
 * derived runtime config while the blueprint tables themselves are data.
 */

import type {
  BuildingAnchorProfile,
  BuildingRenderProfile,
  BuildingBlueprintId,
  BuildingHoveringType,
  BuildingSupportSurface,
  ResourceCost,
} from '../types';
import { isTowerBuildingBlueprintId } from '../../../types/buildingTypes';
import type { UnitBlueprintId } from '../../../types/blueprintIds';
import type {
  BuildingTurretMount,
  EntityBaseLedger,
  EntityHudBlueprint,
  LockOnInclusionObject,
  SensorCapabilityConfig,
} from '../../../types/blueprints';
import rawBuildingBlueprints from './buildings.json';
import rawTowerBlueprints from './towers.json';
import { assertExplicitFields } from './jsonValidation';
import {
  LOCK_ON_INCLUSION_FIELDS,
  assertNoInlineLockOnInclusionFields,
  validateLockOnInclusionObject,
} from './lockOnValidation';
import { productionHoldRingOuterRadius } from '../productionHoldGeometry';
import {
  assertTowerLockOnInclusionConfigIds,
  getTowerLockOnInclusions,
} from './lockOnConfig';
import {
  isUnitBlueprintId,
  STRUCTURE_BLUEPRINT_IDS,
} from '../../../types/blueprintIds';
import { TURRET_BLUEPRINTS } from './turrets';
import { UNIT_BLUEPRINTS } from './units';
import { isBuildableUnitBlueprintId } from './unitRoster';
import { BUILD_GRID_CELL_SIZE } from '../buildGrid';
import {
  assertValidShotArmingRadius,
  normalizeEntityBaseLedgerFromAliases,
} from './entityBaseLedger';

export type BuildingBlueprint = Partial<LockOnInclusionObject> & {
  buildingBlueprintId: BuildingBlueprintId;
  name: string;
  gridWidth: number;
  gridHeight: number;
  gridDepth: number;
  /** Build-grid cells reserved for placement when larger than the
   *  physical footprint (`null` = same as gridWidth/gridHeight). The
   *  clearance ring blocks construction but not movement or physics —
   *  the wind turbine reserves 6x6 so nothing builds under its blades
   *  while its body stays 2x2. Must be >= the physical dim and share
   *  its parity so both rects center on the same point. */
  placementGridWidth: number | null;
  placementGridHeight: number | null;
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
  /** Unit production roster for static factories. This is BAR-style
   *  `buildoptions` data for unit-producing buildings/towers: null for
   *  non-factories, non-empty for any host that mounts a unit spawn turret. */
  allowedUnitBlueprintIds: readonly UnitBlueprintId[] | null;
  renderProfile: BuildingRenderProfile;
  /** Primary visual/anchor height above ground, in world units. */
  visualHeight: number;
  anchorProfile: BuildingAnchorProfile;
  /** Authored walkable/support proxy, independent from the collision cuboid. */
  supportSurface: BuildingSupportSurface;
  /** Hovering structure classification. Null means grounded. The fabricator
   *  torus is currently the only hovering structure type. */
  hoveringType: BuildingHoveringType;
  hud: EntityHudBlueprint;
  sensors: SensorCapabilityConfig;
  /** Optional reusable turret hardpoints mounted on this building.
   *  Building mount coordinates are absolute world units relative to
   *  the building center/base, not body-radius fractions like units. */
  turrets: BuildingTurretMount[];
};

type JsonTowerBlueprint = Omit<BuildingBlueprint, keyof LockOnInclusionObject>;

const PURE_BUILDING_BLUEPRINTS =
  rawBuildingBlueprints as Partial<Record<BuildingBlueprintId, BuildingBlueprint>>;
const RAW_TOWER_BLUEPRINTS =
  rawTowerBlueprints as Partial<Record<BuildingBlueprintId, JsonTowerBlueprint>>;

assertTowerLockOnInclusionConfigIds(Object.keys(RAW_TOWER_BLUEPRINTS));

function buildTowerBlueprints(): Partial<Record<BuildingBlueprintId, BuildingBlueprint>> {
  const blueprints: Partial<Record<BuildingBlueprintId, BuildingBlueprint>> = {};
  const ids = Object.keys(RAW_TOWER_BLUEPRINTS) as BuildingBlueprintId[];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const blueprint = RAW_TOWER_BLUEPRINTS[id];
    if (blueprint === undefined) continue;
    assertNoInlineLockOnInclusionFields(`tower blueprint ${id}`, blueprint);
    blueprints[id] = {
      ...blueprint,
      ...getTowerLockOnInclusions(id),
    };
  }
  return blueprints;
}

const TOWER_BLUEPRINTS = buildTowerBlueprints();
const STATIC_BLUEPRINTS_BY_ID = {
  ...PURE_BUILDING_BLUEPRINTS,
  ...TOWER_BLUEPRINTS,
} as Partial<Record<BuildingBlueprintId, BuildingBlueprint>>;
for (const id of STRUCTURE_BLUEPRINT_IDS) {
  if (STATIC_BLUEPRINTS_BY_ID[id as BuildingBlueprintId] === undefined) {
    throw new Error(`Missing static blueprint for stable building blueprint id ${id}`);
  }
}
// Compatibility table for runtime/network fields that still use the
// historical `buildingBlueprintId` name for every static structure.
function buildBuildingBlueprints(): Record<BuildingBlueprintId, BuildingBlueprint> {
  const blueprints = {} as Record<BuildingBlueprintId, BuildingBlueprint>;
  for (let i = 0; i < STRUCTURE_BLUEPRINT_IDS.length; i++) {
    const id = STRUCTURE_BLUEPRINT_IDS[i] as BuildingBlueprintId;
    blueprints[id] = STATIC_BLUEPRINTS_BY_ID[id] as BuildingBlueprint;
  }
  return blueprints;
}

export const BUILDING_BLUEPRINTS = buildBuildingBlueprints();

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
  'allowedUnitBlueprintIds',
  'placementGridWidth',
  'placementGridHeight',
  'supportSurface',
  'hoveringType',
  'sensors',
  'turrets',
] as const;

export const DEFAULT_BUILDING_VISUAL_HEIGHT = 120;
export const SOLAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingSolar.visualHeight;
export const WIND_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingWind.visualHeight;
const FACTORY_BASE_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.towerFabricator.visualHeight;
export const EXTRACTOR_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.buildingExtractor.visualHeight;
export const RADAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingRadar.visualHeight;
export const MEGA_BEAM_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerBeamMega.visualHeight;
export const CANNON_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerCannon.visualHeight;
export const ANTI_AIR_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerAntiAir.visualHeight;

function firstTurretMountZ(
  blueprint: BuildingBlueprint,
  fallback: number,
): number {
  const turret = blueprint.turrets[0];
  return turret !== undefined ? turret.mount.z : fallback;
}

const FACTORY_CONSTRUCTION_TURRET_MOUNT_Z =
  firstTurretMountZ(BUILDING_BLUEPRINTS.towerFabricator, FACTORY_BASE_VISUAL_HEIGHT);

// Fabricator construction-tower dimensions. Historically read from the
// (now-removed) turretConstruction blueprint's large constructionEmitter;
// retained here as explicit constants (the exact former blueprint values) so
// the legacy turret blueprint is no longer a load-bearing dependency. These
// feed both the 3D renderer and sim-side anchors, so they are fixed: changing
// a value is a visual + anchor change, not a refactor.
const FABRICATOR_TOWER_PYLON_RADIUS = 3.6;
const FABRICATOR_TOWER_PYLON_OFFSET = 96;
const FABRICATOR_TOWER_PYLON_HEIGHT = 90;
const FABRICATOR_TOWER_MOUNT_RADIUS = 8;

type FactoryBuildingVisualMetrics = {
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
  const pylonRadius = FABRICATOR_TOWER_PYLON_RADIUS;
  const pylonOffset = FABRICATOR_TOWER_PYLON_OFFSET;
  const pylonHeight = FABRICATOR_TOWER_PYLON_HEIGHT;
  const towerRadius = Math.max(7, minDim * 0.09);
  const collarRadius = Math.max(towerRadius * 1.35, minDim * 0.16);
  const towerHeight = pylonHeight;
  const towerBaseY = Math.max(0, FACTORY_CONSTRUCTION_TURRET_MOUNT_Z - FABRICATOR_TOWER_MOUNT_RADIUS);
  const capRadius = Math.max(1.35, pylonRadius * 1.65);
  const capY = towerBaseY + pylonHeight + capRadius * 0.36;
  const nozzleRadius = capRadius;
  const nozzleY = capY + capRadius * 0.35;
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
    // The fabricator body is now the hovering torus, so its top (where the
    // health/build bars float) is the ring height plus the ring's tube radius —
    // not the old central construction tower.
    visualTop: fabricatorTorusHoverHeight() + fabricatorTorusRingRadius(width, depth) * 0.22 + capRadius,
  };
}

function validateBuildingSupportSurface(
  id: string,
  supportSurface: BuildingSupportSurface,
): void {
  if (!supportSurface || typeof supportSurface !== 'object') {
    throw new Error(`Invalid building blueprint ${id}: supportSurface must be an object`);
  }
  if (supportSurface.kind === 'none') return;
  if (supportSurface.kind !== 'boxTop') {
    throw new Error(
      `Invalid building blueprint ${id}: unknown supportSurface kind "${String((supportSurface as { kind?: unknown }).kind)}"`,
    );
  }
  if (!Number.isFinite(supportSurface.topZ) || supportSurface.topZ <= 0) {
    throw new Error(`Invalid building blueprint ${id}: supportSurface.topZ must be positive`);
  }
  if (!Number.isFinite(supportSurface.width) || supportSurface.width <= 0) {
    throw new Error(`Invalid building blueprint ${id}: supportSurface.width must be positive`);
  }
  if (!Number.isFinite(supportSurface.height) || supportSurface.height <= 0) {
    throw new Error(`Invalid building blueprint ${id}: supportSurface.height must be positive`);
  }
}

function validateBuildingHoveringType(
  id: string,
  blueprint: BuildingBlueprint,
): void {
  const hoveringType = blueprint.hoveringType;
  if (hoveringType !== null && hoveringType !== 'fabricator') {
    throw new Error(
      `Invalid building blueprint ${id}: unknown hoveringType "${String(hoveringType)}"`,
    );
  }
  if (id === 'towerFabricator') {
    if (hoveringType !== 'fabricator') {
      throw new Error('Invalid building blueprint towerFabricator: hoveringType must be "fabricator"');
    }
  } else if (hoveringType !== null) {
    throw new Error(
      `Invalid building blueprint ${id}: only towerFabricator may currently author a hoveringType`,
    );
  }
  if (hoveringType !== null && blueprint.supportSurface.kind !== 'none') {
    throw new Error(
      `Invalid building blueprint ${id}: hovering structures must use supportSurface.none`,
    );
  }
}

function validateFabricatorTorusTargetRadius(
  id: string,
  blueprint: BuildingBlueprint,
): void {
  if (id !== 'towerFabricator') return;
  const width = blueprint.gridWidth * BUILD_GRID_CELL_SIZE;
  const depth = blueprint.gridHeight * BUILD_GRID_CELL_SIZE;
  const expected = fabricatorTorusOuterRadius(width, depth);
  const radius = blueprint.base.radius;
  for (const field of ['other', 'hitbox', 'collision'] as const) {
    if (Math.abs(radius[field] - expected) > 1e-3) {
      throw new Error(
        `Invalid building blueprint ${id}: base.radius.${field} must match fabricator torus outer radius`,
      );
    }
  }
}

function validateSensorCapabilityConfig(
  context: string,
  sensors: SensorCapabilityConfig,
): void {
  if (!sensors || typeof sensors !== 'object') {
    throw new Error(`Invalid ${context}: sensors must be an object`);
  }
  const fields = [
    'fullSightRadius',
    'radarRadius',
    'detectorRadius',
    'trackingRadius',
    'scanRadius',
  ] as const;
  for (const field of fields) {
    const value = sensors[field];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid ${context}: sensors.${field} must be a finite non-negative number`);
    }
  }
}

function buildingBlueprintHasUnitSpawnTurret(blueprint: BuildingBlueprint): boolean {
  for (const mount of blueprint.turrets) {
    const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (turretBlueprint?.spawn?.producedKind === 'units') return true;
  }
  return false;
}

function validateFactoryUnitRoster(
  id: string,
  blueprint: BuildingBlueprint,
): void {
  const hasUnitSpawnTurret = buildingBlueprintHasUnitSpawnTurret(blueprint);
  const roster = blueprint.allowedUnitBlueprintIds;
  if (!hasUnitSpawnTurret) {
    if (roster !== null) {
      throw new Error(
        `Invalid building blueprint ${id}: allowedUnitBlueprintIds must be null without a unit spawn turret`,
      );
    }
    return;
  }
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new Error(
      `Invalid building blueprint ${id}: unit-producing factories must author a non-empty allowedUnitBlueprintIds roster`,
    );
  }
  const seen = new Set<string>();
  for (const unitBlueprintId of roster) {
    if (!isUnitBlueprintId(unitBlueprintId) || !isBuildableUnitBlueprintId(unitBlueprintId)) {
      throw new Error(
        `Invalid building blueprint ${id}: unknown or non-buildable allowedUnitBlueprintId "${unitBlueprintId}"`,
      );
    }
    if (seen.has(unitBlueprintId)) {
      throw new Error(
        `Invalid building blueprint ${id}: duplicate allowedUnitBlueprintId "${unitBlueprintId}"`,
      );
    }
    seen.add(unitBlueprintId);
  }
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
  blueprint.base = normalizeEntityBaseLedgerFromAliases(
    `${towerBlueprint ? 'tower' : 'building'} blueprint ${id}`,
    blueprint.base,
    {
      cost: blueprint.cost,
      health: blueprint.hp,
    },
  );
  if (towerBlueprint) {
    assertValidShotArmingRadius(`tower blueprint ${id}`, blueprint.base.radius);
  }
  for (const mount of blueprint.turrets) {
    const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (!turretBlueprint) {
      throw new Error(
        `Invalid ${towerBlueprint ? 'tower' : 'building'} blueprint ${id}: unknown turretBlueprintId "${mount.turretBlueprintId}"`,
      );
    }
  }
  validateFactoryUnitRoster(id, blueprint);
  if (!Number.isFinite(blueprint.gridWidth) || blueprint.gridWidth <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridWidth must be positive`);
  }
  if (!Number.isFinite(blueprint.gridHeight) || blueprint.gridHeight <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridHeight must be positive`);
  }
  if (!Number.isFinite(blueprint.gridDepth) || blueprint.gridDepth <= 0) {
    throw new Error(`Invalid building blueprint ${id}: gridDepth must be positive`);
  }
  for (const [placementField, physical] of [
    ['placementGridWidth', blueprint.gridWidth],
    ['placementGridHeight', blueprint.gridHeight],
  ] as const) {
    const placement = blueprint[placementField];
    if (placement === null) continue;
    if (!Number.isFinite(placement) || placement < physical) {
      throw new Error(
        `Invalid building blueprint ${id}: ${placementField} must be >= the physical footprint dim`,
      );
    }
    if ((placement - physical) % 2 !== 0) {
      throw new Error(
        `Invalid building blueprint ${id}: ${placementField} must share parity with the physical footprint dim so both rects center on the same point`,
      );
    }
  }
  if (!Number.isFinite(blueprint.visualHeight) || blueprint.visualHeight <= 0) {
    throw new Error(`Invalid building blueprint ${id}: visualHeight must be positive`);
  }
  validateFabricatorTorusTargetRadius(id, blueprint);
  validateBuildingSupportSurface(id, blueprint.supportSurface);
  validateBuildingHoveringType(id, blueprint);
  validateSensorCapabilityConfig(`building blueprint ${id}`, blueprint.sensors);
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

// ── Fabricator torus geometry (single source of truth) ──────────────────────
// The fabricator is a hovering torus. Its body floats 1.2x the LARGEST unit's
// collision DIAMETER above the ground so even the biggest unit fits comfortably
// under it and moves freely beneath. The renderer (torus + pylon rigs), the
// spawn height, and the turret mounts all read this geometry, so they can never
// drift apart.
//
function computeMaxUnitCollisionRadius(): number {
  let max = 0;
  for (const bp of Object.values(UNIT_BLUEPRINTS)) {
    if (bp.radius.collision > max) max = bp.radius.collision;
  }
  return max;
}

// Unit blueprints are immutable static data, so cache this derived roster
// maximum once instead of allocating/scanning Object.values() in hot geometry
// helpers and line-of-sight setup.
const MAX_UNIT_COLLISION_RADIUS = computeMaxUnitCollisionRadius();

export function maxUnitCollisionRadius(): number {
  return MAX_UNIT_COLLISION_RADIUS;
}

/** Height of the fabricator torus body = 1.2 x the largest unit's collision
 *  diameter. */
export function fabricatorTorusHoverHeight(): number {
  return 1.2 * (2 * MAX_UNIT_COLLISION_RADIUS);
}

/** Radius of the torus ring — the circle the construction pylons hang on. */
export function fabricatorTorusRingRadius(width: number, depth: number): number {
  return Math.max(width, depth) * 0.46;
}

export function fabricatorTorusOuterRadius(width: number, depth: number): number {
  return productionHoldRingOuterRadius(fabricatorTorusRingRadius(width, depth));
}

// Finalize the fabricator's turret mounts from the torus geometry: the spawn
// turret sits at the ring center (where the unit materializes), and the two
// construction pylons hang on opposite sides of the ring. Mutating loaded
// blueprint data at import time mirrors normalizeEntityBaseLedgerFromAliases.
{
  const fabricator = BUILDING_BLUEPRINTS.towerFabricator;
  if (fabricator) {
    const width = fabricator.gridWidth * BUILD_GRID_CELL_SIZE;
    const depth = fabricator.gridHeight * BUILD_GRID_CELL_SIZE;
    const ring = fabricatorTorusRingRadius(width, depth);
    const hover = fabricatorTorusHoverHeight();
    let nextPylonX = -ring;
    for (const mount of fabricator.turrets) {
      const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
      if (turretBlueprint.spawn != null) {
        mount.mount.x = 0;
        mount.mount.y = 0;
        mount.mount.z = hover;
      } else if (turretBlueprint.resourcePylon?.role === 'construction') {
        mount.mount.x = nextPylonX;
        mount.mount.y = 0;
        mount.mount.z = hover;
        nextPylonX = ring;
      }
    }
  }
}
