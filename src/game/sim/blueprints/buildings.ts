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
  BuildingPlacementSet,
  BuildingSupportSurface,
  ResourceCost,
} from '../types';
import type { UnitBlueprintId } from '../../../types/blueprintIds';
import type {
  BuildingTurretMount,
  EntityBaseLedger,
  EntityHudBlueprint,
  LockOnInclusionObject,
  WorkEmitterSpec,
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
import {
  BUILD_GRID_CELL_SIZE,
  parseBuildingPlacementFootprint,
} from '../buildGrid';
import {
  normalizeEntityBaseLedgerFromAliases,
} from './entityBaseLedger';
import { getMaximumSensorMatrixRadius } from '../sensorConfig';
import { validateStationArticulation, validateWorkEmitter } from './stationArticulation';
import {
  BUILDING_PLACEMENT_SETS,
  getBuildingPlacementSetAnchor,
  getBuildingPlacementSetSquareType,
  isBuildingPlacementSet,
} from '../../../types/buildingTypes';

export type BuildingBlueprint = Partial<LockOnInclusionObject> & {
  buildingBlueprintId: BuildingBlueprintId;
  name: string;
  /** Authored abbreviation for surfaces with no room for the full name: the
   *  selection info panel, build-menu thumb fallbacks, factory preset chips.
   *  Derived abbreviations used to be built by stripping words off the label,
   *  which produced things like "SHIELD DETECTION LAB" in a slot sized for
   *  six characters. */
  shortName: string;
  /** Exactly three uppercase letters, unique across the whole roster. This is
   *  the code for a fixed-width slot — a portrait fallback, an icon badge —
   *  where even `shortName` has no guaranteed width to work with. */
  tinyName: string;
  gridWidth: number;
  gridHeight: number;
  gridDepth: number;
  /** Top-to-bottom build-grid mask. `#` marks structure/reservation cells,
   *  `+` construction-only overhang clearance, and `.` unused bounding-box
   *  space. The mask dimensions own placement snapping and reservation. */
  footprintMask: string[];
  base: EntityBaseLedger;
  hp: number;
  /** Authored construction cost. BUILDING_CONFIGS applies COST_MULTIPLIER.
   *  Metal and energy are paid together for each realized work step. */
  cost: ResourceCost;
  energyProduction: number | null;
  metalProduction: number | null;
  /** Passive capacity added to the owner's energy stockpile while this
   *  completed structure exists. Null means this is not energy storage. */
  energyStorage: number | null;
  /** Passive capacity added to the owner's metal stockpile while this
   *  completed structure exists. Null means this is not metal storage. */
  metalStorage: number | null;
  constructionRate: number | null;
  /** Host-owned build-power origin. This is presentation geometry, not a
   *  turret, weapon, or resource-transfer lane. */
  workEmitter?: WorkEmitterSpec | null;
  /** Source-resource throughput (units per second) for a resource
   *  converter. Each tick, a completed converter consumes this much of
   *  whichever resource is in surplus (metal vs energy) and pays out
   *  the other resource minus the configured CONVERTER TAX. `null` for
   *  any non-converter building. */
  conversionRate: number | null;
  /** Unit production roster for static factories. This is BAR-style
   *  `buildoptions` data owned directly by the factory host. */
  allowedUnitBlueprintIds: readonly UnitBlueprintId[] | null;
  renderProfile: BuildingRenderProfile;
  /** Primary visual/anchor height above ground, in world units. */
  visualHeight: number;
  anchorProfile: BuildingAnchorProfile;
  /** Authored walkable/support proxy, independent from the collision cuboid. */
  supportSurface: BuildingSupportSurface;
  /** Exhaustive square domains on which this structure may be placed. */
  placementSets: readonly BuildingPlacementSet[];
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
  'energyStorage',
  'metalStorage',
  'constructionRate',
  'conversionRate',
  'allowedUnitBlueprintIds',
  'footprintMask',
  'supportSurface',
  'placementSets',
  'hoveringType',
  'turrets',
] as const;

export const DEFAULT_BUILDING_VISUAL_HEIGHT = 120;
export const SOLAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingSolar.visualHeight;
export const WIND_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingWind.visualHeight;
export const EXTRACTOR_T2_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.buildingExtractorT2.visualHeight;
export const EXTRACTOR_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.buildingExtractor.visualHeight;
export const RADAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingRadar.visualHeight;
export const SONAR_BUILDING_VISUAL_HEIGHT = BUILDING_BLUEPRINTS.buildingSonar.visualHeight;
export const MEGA_BEAM_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerBeamMega.visualHeight;
/** Paired emitter layout in the heavy tower head's local aim frame. Keeping
 * this derived from the weapon sockets makes its housing and authoritative
 * QueryWeapon origins share one source of truth. */
export const HEAVY_BEAM_TOWER_EMITTER_LAYOUT = (() => {
  const mounts = BUILDING_BLUEPRINTS.towerBeamMega.turrets;
  if (mounts.length !== 2) {
    throw new Error('Heavy Beam Tower must expose exactly two emitter sockets');
  }
  const left = mounts[0].hostAttachment;
  const right = mounts[1].hostAttachment;
  if (
    left?.kind !== 'buildingAimPiece' ||
    right?.kind !== 'buildingAimPiece' ||
    left.piece !== 'beamHead' ||
    right.piece !== 'beamHead' ||
    left.socketOffset.x !== right.socketOffset.x ||
    left.socketOffset.y !== -right.socketOffset.y ||
    left.socketOffset.z !== 0 ||
    right.socketOffset.z !== 0
  ) {
    throw new Error('Heavy Beam Tower emitter sockets must form a symmetric beamHead pair');
  }
  return Object.freeze({
    forwardOffset: left.socketOffset.x,
    lateralHalfSpan: Math.abs(left.socketOffset.y),
  });
})();
export const LIGHT_BEAM_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerBeamLight.visualHeight;
export const SHIELD_TARGETING_TECH_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.buildingShieldTargetingTech.visualHeight;
export const SHIELD_TECH_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.buildingShieldTech.visualHeight;
export const PRECISION_TARGETING_TECH_BUILDING_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.buildingPrecisionTargetingTech.visualHeight;
export const CANNON_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerCannon.visualHeight;
export const ANTI_AIR_TOWER_VISUAL_HEIGHT =
  BUILDING_BLUEPRINTS.towerAntiAir.visualHeight;

type FactoryBuildingVisualMetrics = {
  visualTop: number;
};

/** Authoritative top of the hovering factory ring for HUD/target anchors. */
export function getFactoryBuildingVisualMetrics(
  width: number,
  depth: number,
): FactoryBuildingVisualMetrics {
  return {
    visualTop: fabricatorTorusHoverHeight() + fabricatorTorusRingRadius(width, depth) * 0.22,
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

function validateBuildingPlacementSets(
  id: string,
  blueprint: BuildingBlueprint,
): void {
  const placementSets = blueprint.placementSets;
  if (!Array.isArray(placementSets) || placementSets.length === 0) {
    throw new Error(`Invalid building blueprint ${id}: placementSets must not be empty`);
  }
  let anchor: ReturnType<typeof getBuildingPlacementSetAnchor> | null = null;
  const squareTypes = new Set<string>();
  const seenSets = new Set<string>();
  let lastCanonicalIndex = -1;
  for (const placementSet of placementSets) {
    if (!isBuildingPlacementSet(placementSet)) {
      throw new Error(
        `Invalid building blueprint ${id}: unknown placementSet "${String(placementSet)}"`,
      );
    }
    if (seenSets.has(placementSet)) {
      throw new Error(`Invalid building blueprint ${id}: duplicate placementSet "${placementSet}"`);
    }
    seenSets.add(placementSet);
    const canonicalIndex = BUILDING_PLACEMENT_SETS.indexOf(placementSet);
    if (canonicalIndex <= lastCanonicalIndex) {
      throw new Error(`Invalid building blueprint ${id}: placementSets must use canonical order`);
    }
    lastCanonicalIndex = canonicalIndex;
    const squareType = getBuildingPlacementSetSquareType(placementSet);
    if (squareTypes.has(squareType)) {
      throw new Error(
        `Invalid building blueprint ${id}: at most one placementSet may target ${squareType} build squares`,
      );
    }
    squareTypes.add(squareType);
    const placementAnchor = getBuildingPlacementSetAnchor(placementSet);
    if (anchor !== null && anchor !== placementAnchor) {
      throw new Error(
        `Invalid building blueprint ${id}: all placementSets must share one physical anchor`,
      );
    }
    anchor = placementAnchor;
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
  if ((anchor === 'hover-surface') !== (hoveringType !== null)) {
    throw new Error(
      `Invalid building blueprint ${id}: hover-surface placementSets and hoveringType must be authored together`,
    );
  }
  if (
    (id === 'buildingSonar' || id === 'buildingSonarJammer') &&
    (placementSets.length !== 1 || placementSets[0] !== 'water-build-squares-sea-on-surface')
  ) {
    throw new Error(
      `Invalid building blueprint ${id}: placementSets must contain only "water-build-squares-sea-on-surface"`,
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
  const sensors =
    TURRET_BLUEPRINTS[sensorMount.turretBlueprintId].targeting.observation.sensors;
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

function validateDedicatedJammer(
  id: string,
  blueprint: BuildingBlueprint,
): void {
  if (id !== 'buildingRadarJammer' && id !== 'buildingSonarJammer') return;
  const sensorMount = blueprint.turrets.find(
    (mount) => TURRET_BLUEPRINTS[mount.turretBlueprintId]?.kind === 'sensor',
  );
  if (sensorMount === undefined) {
    throw new Error(`Invalid building blueprint ${id}: missing dedicated jammer turret`);
  }
  const sensors =
    TURRET_BLUEPRINTS[sensorMount.turretBlueprintId].targeting.observation.sensors;
  if (
    getMaximumSensorMatrixRadius(sensors.fullSight) !== 0
    || getMaximumSensorMatrixRadius(sensors.contactSight) !== 0
    || sensors.detectorRadius !== 0
  ) {
    throw new Error(`Invalid building blueprint ${id}: jammer suite must not grant observation`);
  }
  const expectedRadius = id === 'buildingRadarJammer'
    ? sensors.radarJamRadius
    : sensors.sonarJamRadius;
  const otherRadius = id === 'buildingRadarJammer'
    ? sensors.sonarJamRadius
    : sensors.radarJamRadius;
  if (!Number.isFinite(expectedRadius) || expectedRadius <= 0 || otherRadius !== 0) {
    throw new Error(
      `Invalid building blueprint ${id}: it must jam only its authored radar/sonar medium`,
    );
  }
}

function validateStorageCapacity(id: string, blueprint: BuildingBlueprint): void {
  for (const [field, capacity] of [
    ['energyStorage', blueprint.energyStorage],
    ['metalStorage', blueprint.metalStorage],
  ] as const) {
    if (capacity !== null && (!Number.isFinite(capacity) || capacity <= 0)) {
      throw new Error(`Invalid building blueprint ${id}: ${field} must be null or positive`);
    }
  }
  if (blueprint.energyStorage !== null && blueprint.metalStorage !== null) {
    throw new Error(`Invalid building blueprint ${id}: storage structures must author one resource`);
  }
  if (
    (id === 'buildingEnergyStorage') !== (blueprint.energyStorage !== null)
    || (id === 'buildingMetalStorage') !== (blueprint.metalStorage !== null)
  ) {
    throw new Error(
      `Invalid building blueprint ${id}: storage capacity must stay on its dedicated storage blueprint`,
    );
  }
}

function validateFactoryUnitRoster(
  id: string,
  blueprint: BuildingBlueprint,
): void {
  const roster = blueprint.allowedUnitBlueprintIds;
  const isFactory = blueprint.constructionRate !== null;
  if (!isFactory) {
    if (roster !== null) {
      throw new Error(
        `Invalid building blueprint ${id}: allowedUnitBlueprintIds must be null on non-factories`,
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
  if (blueprint.turrets.length === 0) {
    throw new Error(`Invalid building blueprint ${id}: every building must mount at least one turret`);
  }
  const hostPieceContracts = new Map<string, {
    kind: 'buildingYawPiece' | 'buildingAimPiece';
    mountX: number;
    mountY: number;
    mountZ: number;
    yawMaxSpeed: number;
    yawMaxAcceleration: number;
    pitchMaxSpeed: number;
    pitchMaxAcceleration: number;
    pitchMin: number;
    pitchMax: number;
    restPitch: number;
    restoreDelayMs: number;
  }>();
  for (const mount of blueprint.turrets) {
    validateStationArticulation(
      `turret station ${id} ${mount.mountId}`,
      mount.articulation,
    );
    const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (!turretBlueprint) {
      throw new Error(
        `Invalid building blueprint ${id}: unknown turretBlueprintId "${mount.turretBlueprintId}"`,
      );
    }
    const angularActuator = mount.angularActuator ?? turretBlueprint.angularActuator;
    if (mount.angularActuator !== undefined) {
      for (const [axis, actuator] of [
        ['yaw', mount.angularActuator.yaw],
        ['pitch', mount.angularActuator.pitch],
      ] as const) {
        if (
          !Number.isFinite(actuator.maxSpeed) || actuator.maxSpeed <= 0 ||
          !Number.isFinite(actuator.maxAcceleration) || actuator.maxAcceleration <= 0
        ) {
          throw new Error(
            `Invalid building actuator override ${id} ${mount.mountId}.${axis}: ` +
            'maxSpeed and maxAcceleration must be finite and positive',
          );
        }
      }
    }
    const attachment = mount.hostAttachment;
    if (attachment !== undefined) {
      const socket = attachment.socketOffset;
      if (
        !Number.isFinite(socket.x) ||
        !Number.isFinite(socket.y) ||
        !Number.isFinite(socket.z)
      ) {
        throw new Error(
          `Invalid building host attachment ${id} ${mount.mountId}: ` +
          'socketOffset x/y/z must be finite world units',
        );
      }
      if (
        mount.articulation === undefined ||
        mount.articulation.hostAssist !== (
          attachment.kind === 'buildingAimPiece' ? 'requestAim' : 'requestYaw'
        ) ||
        mount.articulation.claimGroup !== attachment.piece
      ) {
        throw new Error(
          `Invalid building host attachment ${id} ${mount.mountId}: ` +
          `piece "${attachment.piece}" requires ${
            attachment.kind === 'buildingAimPiece' ? 'requestAim' : 'requestYaw'
          } articulation with the same claimGroup`,
        );
      }
      const yawActuator = angularActuator?.yaw;
      if (yawActuator === undefined) {
        throw new Error(
          `Invalid building yaw piece ${id} ${mount.mountId}: attack station needs a yaw actuator`,
        );
      }
      const pitchActuator = angularActuator?.pitch;
      if (attachment.kind === 'buildingAimPiece' && pitchActuator === undefined) {
        throw new Error(
          `Invalid building aim piece ${id} ${mount.mountId}: attack station needs a pitch actuator`,
        );
      }
      const prior = hostPieceContracts.get(attachment.piece);
      const next = {
        kind: attachment.kind,
        mountX: mount.mount.x,
        mountY: mount.mount.y,
        mountZ: mount.mount.z,
        yawMaxSpeed: yawActuator.maxSpeed,
        yawMaxAcceleration: yawActuator.maxAcceleration,
        pitchMaxSpeed: pitchActuator?.maxSpeed ?? 0,
        pitchMaxAcceleration: pitchActuator?.maxAcceleration ?? 0,
        pitchMin: mount.articulation.pitch.minAngle,
        pitchMax: mount.articulation.pitch.maxAngle,
        restPitch: mount.articulation.restPitch,
        restoreDelayMs: mount.articulation.restoreDelayMs,
      };
      if (prior === undefined) {
        hostPieceContracts.set(attachment.piece, next);
      } else if (
        prior.kind !== next.kind ||
        prior.mountX !== next.mountX ||
        prior.mountY !== next.mountY ||
        prior.mountZ !== next.mountZ ||
        prior.yawMaxSpeed !== next.yawMaxSpeed ||
        prior.yawMaxAcceleration !== next.yawMaxAcceleration ||
        prior.pitchMaxSpeed !== next.pitchMaxSpeed ||
        prior.pitchMaxAcceleration !== next.pitchMaxAcceleration ||
        prior.pitchMin !== next.pitchMin ||
        prior.pitchMax !== next.pitchMax ||
        prior.restPitch !== next.restPitch ||
        prior.restoreDelayMs !== next.restoreDelayMs
      ) {
        throw new Error(
          `Invalid building host piece ${id} "${attachment.piece}": ` +
          'all attached stations must share one pivot, actuator, traverse, and restore delay',
        );
      }
    }
    if (mount.emissionSockets !== undefined) {
      if (mount.emissionSockets.length !== turretBlueprint.emissionLaneCount) {
        throw new Error(
          `Invalid emission sockets for building ${id} ${mount.mountId}: ` +
          `expected exactly ${turretBlueprint.emissionLaneCount} QueryWeapon lane(s)`,
        );
      }
      for (const socket of mount.emissionSockets) {
        if (
          !Number.isFinite(socket.offset.x) ||
          !Number.isFinite(socket.offset.y) ||
          !Number.isFinite(socket.offset.z)
        ) {
          throw new Error(
            `Invalid emission socket for building ${id} ${mount.mountId}: ` +
            'offset x/y/z must be finite world units',
          );
        }
      }
    }
  }
  if (blueprint.workEmitter !== null && blueprint.workEmitter !== undefined) {
    validateWorkEmitter(`work emitter ${id}`, blueprint.workEmitter);
    if (blueprint.workEmitter.attachment.kind !== 'host') {
      throw new Error(`Invalid work emitter ${id}: buildings currently support host sockets only`);
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
  const placementFootprint = parseBuildingPlacementFootprint(
    blueprint.footprintMask,
    `building blueprint ${id}`,
  );
  for (const [placement, physical, field] of [
    [placementFootprint.gridWidth, blueprint.gridWidth, 'width'],
    [placementFootprint.gridHeight, blueprint.gridHeight, 'height'],
  ] as const) {
    if (placement < physical) {
      throw new Error(
        `Invalid building blueprint ${id}: footprintMask ${field} must be >= the physical grid ${field}`,
      );
    }
    if ((placement - physical) % 2 !== 0) {
      throw new Error(
        `Invalid building blueprint ${id}: footprintMask ${field} must share parity with the physical grid ${field}`,
      );
    }
  }
  const physicalInsetX = (placementFootprint.gridWidth - blueprint.gridWidth) / 2;
  const physicalInsetY = (placementFootprint.gridHeight - blueprint.gridHeight) / 2;
  let structureCellCount = 0;
  for (const cell of placementFootprint.cells) {
    if (cell.kind !== 'structure') continue;
    structureCellCount++;
    if (
      cell.dx < physicalInsetX ||
      cell.dx >= physicalInsetX + blueprint.gridWidth ||
      cell.dy < physicalInsetY ||
      cell.dy >= physicalInsetY + blueprint.gridHeight
    ) {
      throw new Error(
        `Invalid building blueprint ${id}: structure footprint cell ${cell.dx},${cell.dy} lies outside the centered physical grid`,
      );
    }
  }
  if (structureCellCount === 0) {
    throw new Error(`Invalid building blueprint ${id}: footprintMask needs at least one # cell`);
  }
  const disconnected = new Set(
    placementFootprint.cells.map((cell) => `${cell.dx},${cell.dy}`),
  );
  const pending = [placementFootprint.cells[0]];
  disconnected.delete(`${pending[0].dx},${pending[0].dy}`);
  while (pending.length > 0) {
    const cell = pending.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const key = `${cell.dx + dx},${cell.dy + dy}`;
      if (!disconnected.delete(key)) continue;
      pending.push({ dx: cell.dx + dx, dy: cell.dy + dy, kind: 'structure' });
    }
  }
  if (disconnected.size > 0) {
    throw new Error(
      `Invalid building blueprint ${id}: footprintMask must be one four-connected reservation`,
    );
  }
  if (!Number.isFinite(blueprint.visualHeight) || blueprint.visualHeight <= 0) {
    throw new Error(`Invalid building blueprint ${id}: visualHeight must be positive`);
  }
  validateFabricatorTorusTargetRadius(id, blueprint);
  validateBuildingSupportSurface(id, blueprint.supportSurface);
  validateBuildingPlacementSets(id, blueprint);
  validateDedicatedContactSensor(id, blueprint);
  validateDedicatedJammer(id, blueprint);
  validateStorageCapacity(id, blueprint);
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
