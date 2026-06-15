/**
 * Unit blueprints.
 *
 * Authored unit facts live in units.json. Unit locomotion is authored
 * inline on the unit; this loader only resolves shared data references
 * such as pathfinding and $audio into the runtime objects callers expect.
 */

import type { TurretBlueprintId } from '../../../types/blueprintIds';
import { isStructureBlueprintId } from '../../../types/blueprintIds';
import type { UnitBlueprint } from './types';
import type { UnitLocomotion } from '../types';
import { createUnitLocomotion } from '../locomotion';
export { BUILDABLE_UNIT_BLUEPRINT_IDS, type BuildableUnitBlueprintId } from './unitRoster';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './unitRoster';
import { PATHFINDING_BLUEPRINTS } from './pathfinding';
import { TURRET_BLUEPRINTS } from './turrets';
import rawUnitBlueprints from './units.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';
import type { LockOnInclusionObject, LocomotionBlueprint } from './types';
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

type JsonUnitBlueprint = Omit<UnitBlueprint, 'locomotion' | keyof LockOnInclusionObject> & {
  locomotion: Omit<LocomotionBlueprint, 'pathfinding'>;
};

const UNIT_EXPLICIT_FIELDS = [
  'base',
  'supportSurface',
  'sensors',
  'airFrictionPer60HzFrame',
  'legAttachHeightFrac',
  'suspension',
  'builder',
  'dgun',
  'deathSound',
  'locomotion',
] as const;

function resolveInlineLocomotion(
  unitBlueprintId: string,
  locomotion: JsonUnitBlueprint['locomotion'],
): LocomotionBlueprint {
  if (!locomotion || !locomotion.type) {
    throw new Error(`Invalid unit blueprint ${unitBlueprintId}: missing locomotion`);
  }
  if (!locomotion.pathfindingBlueprintId) {
    throw new Error(
      `Invalid unit blueprint ${unitBlueprintId}: locomotion missing pathfindingBlueprintId`,
    );
  }
  const pathfinding = PATHFINDING_BLUEPRINTS[locomotion.pathfindingBlueprintId];
  if (!pathfinding) {
    throw new Error(
      `Invalid unit blueprint ${unitBlueprintId}: unknown locomotion.pathfindingBlueprintId "${locomotion.pathfindingBlueprintId}"`,
    );
  }
  if (!locomotion.physics || locomotion.physics.driveForce <= 0) {
    throw new Error(
      `Invalid unit blueprint ${unitBlueprintId}: locomotion physics.driveForce must be positive`,
    );
  }
  if (
    'maxSlopeDeg' in locomotion.physics &&
    (locomotion.physics as { maxSlopeDeg?: unknown }).maxSlopeDeg !== undefined
  ) {
    throw new Error(
      `Invalid unit blueprint ${unitBlueprintId}: locomotion physics.maxSlopeDeg moved to pathfindingConfig.json`,
    );
  }
  return {
    ...locomotion,
    pathfinding,
  } as LocomotionBlueprint;
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
    const locomotion = resolveInlineLocomotion(id, blueprint.locomotion);
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
    if (
      !Number.isFinite(blueprint.airFrictionPer60HzFrame) ||
      blueprint.airFrictionPer60HzFrame < 0 ||
      blueprint.airFrictionPer60HzFrame >= 1
    ) {
      throw new Error(
        `Invalid unit blueprint ${id}: airFrictionPer60HzFrame must be a finite value in [0, 1)`,
      );
    }
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
      locomotion,
    };
  }

  return blueprints;
}

export const UNIT_BLUEPRINTS = buildUnitBlueprints();

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

for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  validateUnitSupportSurface(bp.unitBlueprintId, bp.supportSurface);
  validateSensorCapabilityConfig(bp.unitBlueprintId, bp.sensors);
  assertValidShotArmingRadius(`unit blueprint ${bp.unitBlueprintId}`, bp.radius);

  if (!Number.isFinite(bp.bodyCenterHeight) || bp.bodyCenterHeight < 0) {
    throw new Error(
      `Invalid bodyCenterHeight for ${bp.unitBlueprintId}: bodyCenterHeight must be a finite non-negative number`,
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
  if (bp.builder !== null) {
    if (!Array.isArray(bp.builder.allowedBuildBlueprintIds) || bp.builder.allowedBuildBlueprintIds.length === 0) {
      throw new Error(
        `Invalid builder config for ${bp.unitBlueprintId}: allowedBuildBlueprintIds must not be empty`,
      );
    }
    for (const id of bp.builder.allowedBuildBlueprintIds) {
      if (!isStructureBlueprintId(id)) {
        throw new Error(
          `Invalid builder config for ${bp.unitBlueprintId}: unknown allowedBuildBlueprintId "${id}"`,
        );
      }
    }
  }

  if (!bp.hud || !Number.isFinite(bp.hud.barsOffsetAboveTop)) {
    throw new Error(
      `Invalid HUD layout for ${bp.unitBlueprintId}: barsOffsetAboveTop must be finite`,
    );
  }

  if (bp.locomotion.type === 'legs') {
    const legs = bp.locomotion.config.leftSide;
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
  const isAirborne =
    bp.locomotion.type === 'hover' || bp.locomotion.type === 'flying';
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
          `Invalid top-mounted turret for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: turret radius.visual must be positive`,
        );
      }
      turret.mount.z = resolver.bodyTopZFrac + turretRadius / bp.radius.visual;
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
  return createUnitLocomotion(unitBlueprint.locomotion);
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
