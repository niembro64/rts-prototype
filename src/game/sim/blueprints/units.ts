/**
 * Unit blueprints.
 *
 * Authored unit facts live in units.json. Unit locomotion is authored
 * inline on the unit; this loader resolves $audio and validates the complete
 * force profile alongside the unit's explicit pathing class.
 */

import type { TurretBlueprintId } from '../../../types/blueprintIds';
import { isStructureBlueprintId } from '../../../types/blueprintIds';
import type { UnitBlueprint } from './types';
import type { UnitLocomotion } from '../types';
import { createUnitLocomotion } from '../unitLocomotion';
export { BUILDABLE_UNIT_BLUEPRINT_IDS,  } from './unitRoster';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './unitRoster';
import { TURRET_BLUEPRINTS } from './turrets';
import rawUnitBlueprints from './units.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';
import type { LockOnInclusionObject, UnitLocomotionBlueprint } from './types';
import {
  assertNoInlineLockOnInclusionFields,
} from './lockOnValidation';
import {
  assertUnitLockOnInclusionConfigIds,
  getUnitLockOnInclusions,
} from './lockOnConfig';
import {
  normalizeEntityBaseLedgerFromAliases,
  assertValidShotArmingRadius,
} from './entityBaseLedger';
import type { UnitSupportSurface } from '../../../types/blueprints';

type JsonUnitBlueprint = Omit<UnitBlueprint, keyof LockOnInclusionObject>;

const UNIT_EXPLICIT_FIELDS = [
  'base',
  'supportSurface',
  'sensors',
  'legAttachHeightFrac',
  'suspension',
  'builder',
  'dgun',
  'deathSound',
  'unitLocomotion',
] as const;

function resolveInlineLocomotion(
  unitBlueprintId: string,
  unitLocomotion: JsonUnitBlueprint['unitLocomotion'],
): UnitLocomotionBlueprint {
  if (!unitLocomotion || !unitLocomotion.type) {
    throw new Error(`Invalid unit blueprint ${unitBlueprintId}: missing unitLocomotion`);
  }
  if (!unitLocomotion.physics || typeof unitLocomotion.physics !== 'object') {
    throw new Error(
      `Invalid unit blueprint ${unitBlueprintId}: unitLocomotion missing physics`,
    );
  }
  if (
    'maxSlopeDeg' in unitLocomotion.physics &&
    (unitLocomotion.physics as { maxSlopeDeg?: unknown }).maxSlopeDeg !== undefined
  ) {
    throw new Error(
      `Invalid unit blueprint ${unitBlueprintId}: unitLocomotion physics.maxSlopeDeg is derived from authoritative physics`,
    );
  }
  createUnitLocomotion(unitLocomotion);
  return unitLocomotion;
}

function buildUnitBlueprints(): Record<string, UnitBlueprint> {
  const resolved = resolveBlueprintRefs(
    rawUnitBlueprints,
  ) as unknown as Record<string, JsonUnitBlueprint>;
  assertUnitLockOnInclusionConfigIds(Object.keys(resolved));
  const blueprints: Record<string, UnitBlueprint> = {};

  for (const [id, blueprint] of Object.entries(resolved)) {
    assertExplicitFields(`unit blueprint ${id}`, blueprint, UNIT_EXPLICIT_FIELDS);
    assertNoInlineLockOnInclusionFields(`unit blueprint ${id}`, blueprint);
    const unitLocomotion = resolveInlineLocomotion(id, blueprint.unitLocomotion);
    const base = normalizeEntityBaseLedgerFromAliases(
      `unit blueprint ${id}`,
      blueprint.base,
      {
        cost: blueprint.cost,
        mass: blueprint.mass,
        health: blueprint.hp,
        radius: blueprint.radius,
      },
    );
    for (const mount of blueprint.turrets) {
      const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
      if (!turretBlueprint) {
        throw new Error(
          `Invalid unit blueprint ${id}: unknown turretBlueprintId "${mount.turretBlueprintId}"`,
        );
      }
      if (typeof mount.requiredEngagedForFightStop !== 'boolean') {
        throw new Error(
          `Invalid unit blueprint ${id}: turret mount ${mount.turretBlueprintId} must define a boolean requiredEngagedForFightStop`,
        );
      }
    }
    blueprints[id] = {
      ...blueprint,
      base,
      ...getUnitLockOnInclusions(id),
      unitLocomotion,
    };
  }

  return blueprints;
}

export const UNIT_BLUEPRINTS = buildUnitBlueprints();

// Queen unit factories use the same production-ring contract as the static
// fabricator, but hover/flying turret mounts must remain on the roll axis for
// sim/render banking correctness. The real mounts stay axis-compliant here;
// production-ring pylon placement is a visual override derived from the same
// hold geometry.
for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  const spawnMount = bp.turrets.find((mount) => mount.producedBlueprintId !== undefined);
  if (spawnMount === undefined || spawnMount.producedBlueprintId === undefined) continue;
  if (UNIT_BLUEPRINTS[spawnMount.producedBlueprintId] === undefined) continue;
  const centerX = Number.isFinite(spawnMount.mount.x) ? spawnMount.mount.x : 0;
  const centerY = 0;
  const centerZ = 0;
  spawnMount.mount.x = centerX;
  spawnMount.mount.y = centerY;
  spawnMount.mount.z = centerZ;

  for (const mount of bp.turrets) {
    const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (turretBlueprint?.resourcePylon?.role !== 'construction') continue;
    mount.mount.x = centerX;
    mount.mount.y = centerY;
    mount.mount.z = centerZ;
  }
}

function validateUnitSupportSurface(
  unitBlueprintId: string,
  supportSurface: UnitSupportSurface,
): void {
  if (!supportSurface || typeof supportSurface !== 'object') {
    throw new Error(`Invalid unit blueprint ${unitBlueprintId}: supportSurface must be an object`);
  }
  if (supportSurface.kind === 'none') return;
  if (supportSurface.kind !== 'discTop') {
    throw new Error(
      `Invalid unit blueprint ${unitBlueprintId}: unknown supportSurface kind "${String((supportSurface as { kind?: unknown }).kind)}"`,
    );
  }
  if (!Number.isFinite(supportSurface.topZ) || supportSurface.topZ <= 0) {
    throw new Error(`Invalid unit blueprint ${unitBlueprintId}: supportSurface.topZ must be positive`);
  }
  if (!Number.isFinite(supportSurface.radius) || supportSurface.radius <= 0) {
    throw new Error(`Invalid unit blueprint ${unitBlueprintId}: supportSurface.radius must be positive`);
  }
}

function validateSensorCapabilityConfig(
  unitBlueprintId: string,
  sensors: UnitBlueprint['sensors'],
): void {
  if (!sensors || typeof sensors !== 'object') {
    throw new Error(`Invalid sensor config for ${unitBlueprintId}: sensors must be an object`);
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
      throw new Error(
        `Invalid sensor config for ${unitBlueprintId}: sensors.${field} must be a finite non-negative number`,
      );
    }
  }
}

function validateUnitBuilderMounts(bp: UnitBlueprint): void {
  let hasStructureSpawnRoster = false;
  let hasConstructionRate = false;

  for (const mount of bp.turrets) {
    const turretBlueprint = TURRET_BLUEPRINTS[mount.turretBlueprintId];
    if (mount.allowedBuildBlueprintIds !== undefined) {
      if (turretBlueprint.spawn?.producedKind !== 'buildingsAndTowers') {
        throw new Error(
          `Invalid builder config for ${bp.unitBlueprintId}: allowedBuildBlueprintIds belongs on a building/tower spawn turret mount`,
        );
      }
      if (!Array.isArray(mount.allowedBuildBlueprintIds) || mount.allowedBuildBlueprintIds.length === 0) {
        throw new Error(
          `Invalid builder config for ${bp.unitBlueprintId}: spawn turret allowedBuildBlueprintIds must not be empty`,
        );
      }
      for (const id of mount.allowedBuildBlueprintIds) {
        if (!isStructureBlueprintId(id)) {
          throw new Error(
            `Invalid builder config for ${bp.unitBlueprintId}: unknown allowedBuildBlueprintId "${id}"`,
          );
        }
      }
      hasStructureSpawnRoster = true;
    }
    if (mount.constructionRate !== undefined) {
      if (turretBlueprint.resourcePylon?.role !== 'construction') {
        throw new Error(
          `Invalid builder config for ${bp.unitBlueprintId}: constructionRate belongs on a construction-pylon turret mount`,
        );
      }
      if (!Number.isFinite(mount.constructionRate) || mount.constructionRate <= 0) {
        throw new Error(
          `Invalid builder config for ${bp.unitBlueprintId}: construction-pylon constructionRate must be positive`,
        );
      }
      hasConstructionRate = true;
    }
  }

  if (bp.builder === null) return;
  if (!Number.isFinite(bp.builder.buildRange) || bp.builder.buildRange <= 0) {
    throw new Error(
      `Invalid builder config for ${bp.unitBlueprintId}: buildRange must be positive`,
    );
  }
  if (!hasStructureSpawnRoster) {
    throw new Error(
      `Invalid builder config for ${bp.unitBlueprintId}: builder units must author allowedBuildBlueprintIds on their building/tower spawn turret mount`,
    );
  }
  if (!hasConstructionRate) {
    throw new Error(
      `Invalid builder config for ${bp.unitBlueprintId}: builder units must author constructionRate on a construction-pylon mount`,
    );
  }
}

for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  validateUnitSupportSurface(bp.unitBlueprintId, bp.supportSurface);
  validateSensorCapabilityConfig(bp.unitBlueprintId, bp.sensors);
  assertValidShotArmingRadius(`unit blueprint ${bp.unitBlueprintId}`, bp.radius);

  if (!Number.isFinite(bp.supportPointOffsetZ) || bp.supportPointOffsetZ < 0) {
    throw new Error(
      `Invalid supportPointOffsetZ for ${bp.unitBlueprintId}: supportPointOffsetZ must be a finite non-negative number`,
    );
  }

  if (!Number.isFinite(bp.fullVisionRadius) || bp.fullVisionRadius <= 0) {
    throw new Error(
      `Invalid fullVisionRadius for ${bp.unitBlueprintId}: fullVisionRadius must be a finite positive number`,
    );
  }
  if (bp.fullVisionRadius !== bp.sensors.fullSightRadius) {
    throw new Error(
      `Invalid sensor config for ${bp.unitBlueprintId}: fullVisionRadius must mirror sensors.fullSightRadius`,
    );
  }
  validateUnitBuilderMounts(bp);

  if (!bp.hud || !Number.isFinite(bp.hud.barsOffsetAboveTop)) {
    throw new Error(
      `Invalid HUD layout for ${bp.unitBlueprintId}: barsOffsetAboveTop must be finite`,
    );
  }

  if (bp.unitLocomotion.type === 'legs') {
    const legs = bp.unitLocomotion.config.leftSide;
    if (!Array.isArray(legs) || legs.length === 0) {
      throw new Error(
        `Invalid leg layout for ${bp.unitBlueprintId}: leftSide must define at least one leg`,
      );
    }
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const values = [
        ['attachOffsetXFrac', leg.attachOffsetXFrac],
        ['attachOffsetYFrac', leg.attachOffsetYFrac],
        ['upperLegLengthFrac', leg.upperLegLengthFrac],
        ['lowerLegLengthFrac', leg.lowerLegLengthFrac],
        ['snapTriggerAngle', leg.snapTriggerAngle],
        ['snapTargetAngle', leg.snapTargetAngle],
        ['snapDistanceMultiplier', leg.snapDistanceMultiplier],
        ['extensionThreshold', leg.extensionThreshold],
      ] as const;
      for (const [name, value] of values) {
        if (!Number.isFinite(value)) {
          throw new Error(
            `Invalid leg layout for ${bp.unitBlueprintId}[${i}]: ${name} must be finite`,
          );
        }
      }
      if (leg.upperLegLengthFrac <= 0 || leg.lowerLegLengthFrac <= 0) {
        throw new Error(
          `Invalid leg layout for ${bp.unitBlueprintId}[${i}]: leg lengths must be positive`,
        );
      }
      if (leg.snapDistanceMultiplier <= 0 || leg.extensionThreshold <= 0) {
        throw new Error(
          `Invalid leg layout for ${bp.unitBlueprintId}[${i}]: snapDistanceMultiplier and extensionThreshold must be positive`,
        );
      }
    }
  }

  // Mount-finiteness only — cross-blueprint turret-ID validation runs
  // in blueprints/index.ts where both UNIT_BLUEPRINTS and
  // TURRET_BLUEPRINTS are visible.
  const isAirborne = bp.unitLocomotion.type === 'hover' ||
    bp.unitLocomotion.type === 'flying' ||
    bp.unitLocomotion.type === 'dive';
  for (let i = 0; i < bp.turrets.length; i++) {
    const turret = bp.turrets[i];
    const mount = turret.mount;
    if (
      !Number.isFinite(mount.x) ||
      !Number.isFinite(mount.y) ||
      !Number.isFinite(mount.z)
    ) {
      throw new Error(
        `Invalid turret mount for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: mount x/y/z must be finite`,
      );
    }
    // Hover/flying invariant — banking is render-time only, and the
    // body-forward axis is the roll axis. Any mount off that axis
    // would visibly drift away from the sim's yaw-only mount math
    // every time the renderer composes a bank. See the
    // "Airborne Banking Is Visual" section of budget_design_philosophy.html.
    if (isAirborne) {
      if (mount.y !== 0 || mount.z !== 0) {
        throw new Error(
          `Invalid airborne turret mount for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: ` +
            `hover/flying mounts must sit on the roll axis (y=0, z=0), got y=${mount.y} z=${mount.z}`,
        );
      }
      if (turret.zResolver) {
        throw new Error(
          `Invalid airborne turret mount for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: ` +
            `hover/flying turrets cannot use zResolver — z must be authored as 0`,
        );
      }
    }
  }

  if (bp.dgun !== null) {
    const dgunTurretBlueprintId = bp.dgun.turretBlueprintId;
    let hasDgunTurret = false;
    for (let i = 0; i < bp.turrets.length; i++) {
      if (bp.turrets[i].turretBlueprintId !== dgunTurretBlueprintId) continue;
      hasDgunTurret = true;
      break;
    }
    if (!hasDgunTurret) {
      throw new Error(
        `Invalid dgun turret for ${bp.unitBlueprintId}: ${bp.dgun.turretBlueprintId} is not mounted on the unit`,
      );
    }
  }
}

let unitTurretMountsResolved = false;

export function resolveUnitTurretMounts(
  getTurretBodyRadius: (turretBlueprintId: TurretBlueprintId) => number,
): void {
  if (unitTurretMountsResolved) return;

  for (const bp of Object.values(UNIT_BLUEPRINTS)) {
    for (let i = 0; i < bp.turrets.length; i++) {
      const turret = bp.turrets[i];
      const resolver = turret.zResolver;
      if (!resolver) continue;
      if (resolver.kind !== 'topMounted') {
        throw new Error(
          `Invalid turret mount resolver for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: unsupported kind`,
        );
      }
      const turretRadius = getTurretBodyRadius(turret.turretBlueprintId);
      if (!Number.isFinite(turretRadius) || turretRadius <= 0) {
        throw new Error(
          `Invalid top-mounted turret for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: turret radius.other must be positive`,
        );
      }
      turret.mount.z = resolver.bodyTopZFrac + turretRadius / bp.radius.other;
    }
  }

  unitTurretMountsResolved = true;
}

function assertUnitTurretMountsResolved(): void {
  if (!unitTurretMountsResolved) {
    throw new Error(
      'Unit turret mounts must be resolved by the blueprint builder before use',
    );
  }
}

export function getUnitBlueprint(id: string): UnitBlueprint {
  assertUnitTurretMountsResolved();
  const unitBlueprint = UNIT_BLUEPRINTS[id];
  if (!unitBlueprint) throw new Error(`Unknown unit blueprint: ${id}`);
  return unitBlueprint;
}

export function getUnitLocomotion(id: string): UnitLocomotion {
  const unitBlueprint = getUnitBlueprint(id);
  return createUnitLocomotion(unitBlueprint.unitLocomotion);
}

export function getAllUnitBlueprints(): UnitBlueprint[] {
  assertUnitTurretMountsResolved();
  return Object.values(UNIT_BLUEPRINTS);
}

// Normalized cost: total per-build cost / max total across buildables.
// "Total" is the sum across the resource axes — gives a single
// scalar for UI rank/scale display while honouring per-resource costs.
let _costNormCache: { max: number } | null = null;

function totalCost(c: { energy: number; metal: number }): number {
  return c.energy + c.metal;
}

function getCostNorm(): { max: number } {
  if (_costNormCache) return _costNormCache;
  let max = 0;
  for (const id of BUILDABLE_UNIT_BLUEPRINT_IDS) {
    const unitBlueprint = UNIT_BLUEPRINTS[id];
    if (!unitBlueprint) continue;
    const t = totalCost(unitBlueprint.cost);
    if (t > max) max = t;
  }
  _costNormCache = { max };
  return _costNormCache;
}

export function getNormalizedUnitCost(unitBlueprint: {
  cost: { energy: number; metal: number };
}): number {
  const { max } = getCostNorm();
  return max > 0 ? totalCost(unitBlueprint.cost) / max : 0;
}
