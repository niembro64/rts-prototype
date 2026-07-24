/**
 * Building blueprints.
 *
 * Every static host is a building. Combat, production, resource, and sensor
 * behavior all come from its mounted turrets.
 */

import type {
  BuildingAnchorProfile,
  BuildingRenderProfile,
  BuildingBlueprintId,
  BuildingHoveringType,
  BuildingPlacementType,
  BuildingSupportSurface,
  ResourceCost,
} from '../types';
import type { UnitBlueprintId } from '../../../types/blueprintIds';
import type {
  BuildingTurretMount,
  EntityBaseLedger,
  EntityHudBlueprint,
  LockOnInclusionObject,
} from '../../../types/blueprints';
import rawBuildingBlueprints from './buildings.json';
import { assertExplicitFields } from './jsonValidation';
import {
  LOCK_ON_INCLUSION_FIELDS,
  assertNoInlineLockOnInclusionFields,
  validateLockOnInclusionObject,
} from './lockOnValidation';
import { productionHoldRingOuterRadius } from '../productionHoldGeometry';
import {
  assertBuildingLockOnInclusionConfigIds,
  getBuildingLockOnInclusions,
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
import { getMaximumSensorMatrixRadius } from '../sensorConfig';

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
  /** Semantic terrain/water anchor and placement validation policy. */
  placementType: BuildingPlacementType;
  /** Hovering structure classification. Null means grounded. The fabricator
   *  torus is currently the only hovering structure type. */
  hoveringType: BuildingHoveringType;
  hud: EntityHudBlueprint;
  /** Optional reusable turret hardpoints mounted on this building.
   *  Building mount coordinates are absolute world units relative to
   *  the building center/base, not body-radius fractions like units. */
  turrets: BuildingTurretMount[];
};

type JsonBuildingBlueprint = Omit<BuildingBlueprint, keyof LockOnInclusionObject>;

const RAW_BUILDING_BLUEPRINTS =
  rawBuildingBlueprints as unknown as Partial<Record<BuildingBlueprintId, JsonBuildingBlueprint>>;

assertBuildingLockOnInclusionConfigIds(Object.keys(RAW_BUILDING_BLUEPRINTS));

const STATIC_BLUEPRINTS_BY_ID: Partial<Record<BuildingBlueprintId, BuildingBlueprint>> = {};
for (const id of Object.keys(RAW_BUILDING_BLUEPRINTS) as BuildingBlueprintId[]) {
  const blueprint = RAW_BUILDING_BLUEPRINTS[id];
  if (blueprint === undefined) continue;
  assertNoInlineLockOnInclusionFields(`building blueprint ${id}`, blueprint);
  STATIC_BLUEPRINTS_BY_ID[id] = {
    ...blueprint,
    ...getBuildingLockOnInclusions(id),
  };
}
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
  'placementType',
  'hoveringType',
  'turrets',
] as const;

export const DEFAULT_BUILDING_VISUAL_HEIGHT = 120;
export const SOLAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingSolar.visualHeight;
export const WIND_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingWind.visualHeight;
const FACTORY_BASE_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.towerFabricator.visualHeight;
export const EXTRACTOR_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.buildingExtractor.visualHeight;
export const RADAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingRadar.visualHeight;
export const SONAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingSonar.visualHeight;
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
  const placementType = blueprint.placementType;
  if (
    placementType !== 'ground' &&
    placementType !== 'hover' &&
    placementType !== 'water-surface'
  ) {
    throw new Error(
      `Invalid building blueprint ${id}: unknown placementType "${String(placementType)}"`,
    );
  }
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
  if ((placementType === 'hover') !== (hoveringType !== null)) {
    throw new Error(
      `Invalid building blueprint ${id}: placementType "hover" and hoveringType must be authored together`,
    );
  }
  if (id === 'buildingSonar' && placementType !== 'water-surface') {
    throw new Error(
      'Invalid building blueprint buildingSonar: placementType must be "water-surface"',
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

function buildingBlueprintHasUnitSpawnTurret(blueprint: BuildingBlueprint): boolean {
  for (const mount of blueprint.turrets) {
    const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (turretBlueprint?.spawn?.producedKind === 'units') return true;
  }
  return false;
}

function validateDedicatedContactSensor(
  id: string,
  blueprint: BuildingBlueprint,
): void {
  if (id !== 'buildingRadar' && id !== 'buildingSonar') return;
  const sensorMount = blueprint.turrets.find(
    (mount) => TURRET_BLUEPRINTS[mount.turretBlueprintId]?.kind === 'sensor',
  );
  if (sensorMount === undefined) {
    throw new Error(`Invalid building blueprint ${id}: missing dedicated sensor turret`);
  }
  const sensors = TURRET_BLUEPRINTS[sensorMount.turretBlueprintId].turretRange.sensors;
  if (getMaximumSensorMatrixRadius(sensors.fullSight) !== 0) {
    throw new Error(
      `Invalid building blueprint ${id}: dedicated contact sensors must not grant full sight`,
    );
  }
  const contact = sensors.contactSight;
  const expectedRadius = id === 'buildingRadar'
    ? contact.aboveWater.aboveWater
    : contact.underwater.underwater;
  if (!Number.isFinite(expectedRadius) || expectedRadius <= 0) {
    throw new Error(
      `Invalid building blueprint ${id}: its same-medium contact radius must be positive`,
    );
  }
  const unexpectedRadii = id === 'buildingRadar'
    ? [
        contact.aboveWater.underwater,
        contact.underwater.aboveWater,
        contact.underwater.underwater,
      ]
    : [
        contact.aboveWater.aboveWater,
        contact.aboveWater.underwater,
        contact.underwater.aboveWater,
      ];
  if (unexpectedRadii.some((radius) => radius !== 0)) {
    throw new Error(
      `Invalid building blueprint ${id}: dedicated radar/sonar contact coverage must stay in its authored source-target lane`,
    );
  }
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
  assertExplicitFields(`building blueprint ${id}`, blueprint, LOCK_ON_INCLUSION_FIELDS);
  validateLockOnInclusionObject(
    `building blueprint ${id}`,
    blueprint as BuildingBlueprint & LockOnInclusionObject,
  );
  if (id !== blueprint.buildingBlueprintId) {
    throw new Error(
      `Building blueprint key mismatch: key '${id}' has buildingBlueprintId '${blueprint.buildingBlueprintId}'`,
    );
  }
  blueprint.base = normalizeEntityBaseLedgerFromAliases(
    `building blueprint ${id}`,
    blueprint.base,
    {
      cost: blueprint.cost,
      health: blueprint.hp,
    },
  );
  if (blueprint.turrets.some(
    (mount) => TURRET_BLUEPRINTS[mount.turretBlueprintId]?.kind === 'attack',
  )) {
    assertValidShotArmingRadius(`building blueprint ${id}`, blueprint.base.radius);
  }
  if (blueprint.turrets.length === 0) {
    throw new Error(`Invalid building blueprint ${id}: every building must mount at least one turret`);
  }
  for (const mount of blueprint.turrets) {
    const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (!turretBlueprint) {
      throw new Error(
        `Invalid building blueprint ${id}: unknown turretBlueprintId "${mount.turretBlueprintId}"`,
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
  validateDedicatedContactSensor(id, blueprint);
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
// construction pylons anchor there too — their rigs stand at the authored
// emitter offset INSIDE the ring and visually orbit that center while the
// fabricator spends resources (see ConstructionVisualController3D tower
// spin). Mutating loaded blueprint data at import time mirrors
// normalizeEntityBaseLedgerFromAliases.
{
  const fabricator = BUILDING_BLUEPRINTS.towerFabricator;
  if (fabricator) {
    const hover = fabricatorTorusHoverHeight();
    for (const mount of fabricator.turrets) {
      const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
      if (
        turretBlueprint.spawn != null ||
        turretBlueprint.resourcePylon?.role === 'construction'
      ) {
        mount.mount.x = 0;
        mount.mount.y = 0;
        mount.mount.z = hover;
      }
    }
  }
}
