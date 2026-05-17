/**
 * Unit blueprints.
 *
 * Authored unit facts live in units.json. The only transformation left
 * here is resolving data references such as locomotionId and $audio
 * into the runtime objects current TypeScript callers expect.
 */

import type { TurretId } from '../../../types/blueprintIds';
import type { UnitBlueprint } from './types';
import type { UnitLocomotion } from '../types';
import { createUnitLocomotion } from '../locomotion';
import { getExpectedUnitBodyCenterHeightY } from '../../math/BodyDimensions';
export { BUILDABLE_UNIT_IDS, type BuildableUnitId } from './unitRoster';
import { BUILDABLE_UNIT_IDS } from './unitRoster';
import { UNIT_LOCOMOTION_BLUEPRINTS } from './locomotion';
import rawUnitBlueprints from './units.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';

type JsonUnitBlueprint = Omit<UnitBlueprint, 'locomotion'> & {
  locomotionId: string;
};

const UNIT_EXPLICIT_FIELDS = [
  'hideChassis',
  'legAttachHeightFrac',
  'suspension',
  'builder',
  'dgun',
  'cloak',
  'detector',
  'deathSound',
  'fightStopEngagedRatio',
] as const;

function buildUnitBlueprints(): Record<string, UnitBlueprint> {
  const resolved = resolveBlueprintRefs(
    rawUnitBlueprints,
  ) as unknown as Record<string, JsonUnitBlueprint>;
  const blueprints: Record<string, UnitBlueprint> = {};

  for (const [id, blueprint] of Object.entries(resolved)) {
    assertExplicitFields(`unit blueprint ${id}`, blueprint, UNIT_EXPLICIT_FIELDS);
    const locomotion = UNIT_LOCOMOTION_BLUEPRINTS[blueprint.locomotionId];
    if (!locomotion) {
      throw new Error(
        `Invalid unit blueprint ${id}: unknown locomotionId "${blueprint.locomotionId}"`,
      );
    }
    const { locomotionId: _locomotionId, ...unitBlueprint } = blueprint;
    blueprints[id] = {
      ...unitBlueprint,
      locomotion,
    };
  }

  return blueprints;
}

export const UNIT_BLUEPRINTS = buildUnitBlueprints();

for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  const expectedBodyCenterHeight = getExpectedUnitBodyCenterHeightY(
    bp,
    bp.radius.body,
  );
  if (
    !Number.isFinite(bp.bodyCenterHeight) ||
    Math.abs(bp.bodyCenterHeight - expectedBodyCenterHeight) > 1e-6
  ) {
    throw new Error(
      `Invalid bodyCenterHeight for ${bp.id}: expected ${expectedBodyCenterHeight}, got ${bp.bodyCenterHeight}`,
    );
  }

  if (!bp.hud || !Number.isFinite(bp.hud.barsOffsetAboveTop)) {
    throw new Error(
      `Invalid HUD layout for ${bp.id}: barsOffsetAboveTop must be finite`,
    );
  }

  if (
    bp.detector !== null &&
    (!Number.isFinite(bp.detector.radius) || bp.detector.radius <= 0)
  ) {
    throw new Error(
      `Invalid detector for ${bp.id}: detector radius must be positive`,
    );
  }

  if (bp.locomotion.type === 'legs') {
    const legs = bp.locomotion.config.leftSide;
    if (!Array.isArray(legs) || legs.length === 0) {
      throw new Error(
        `Invalid leg layout for ${bp.id}: leftSide must define at least one leg`,
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
            `Invalid leg layout for ${bp.id}[${i}]: ${name} must be finite`,
          );
        }
      }
      if (leg.upperLegLengthFrac <= 0 || leg.lowerLegLengthFrac <= 0) {
        throw new Error(
          `Invalid leg layout for ${bp.id}[${i}]: leg lengths must be positive`,
        );
      }
      if (leg.snapDistanceMultiplier <= 0 || leg.extensionThreshold <= 0) {
        throw new Error(
          `Invalid leg layout for ${bp.id}[${i}]: snapDistanceMultiplier and extensionThreshold must be positive`,
        );
      }
    }
  }

  // Mount-finiteness only — cross-blueprint turret-ID validation runs
  // in blueprints/index.ts where both UNIT_BLUEPRINTS and
  // TURRET_BLUEPRINTS are visible.
  for (let i = 0; i < bp.turrets.length; i++) {
    const turret = bp.turrets[i];
    const mount = turret.mount;
    if (
      !Number.isFinite(mount.x) ||
      !Number.isFinite(mount.y) ||
      !Number.isFinite(mount.z)
    ) {
      throw new Error(
        `Invalid turret mount for ${bp.id}[${i}] ${turret.turretId}: mount x/y/z must be finite`,
      );
    }
  }

  if (bp.dgun !== null) {
    if (!bp.turrets.some((turret) => turret.turretId === bp.dgun!.turretId)) {
      throw new Error(
        `Invalid dgun turret for ${bp.id}: ${bp.dgun.turretId} is not mounted on the unit`,
      );
    }
  }
}

let unitTurretMountsResolved = false;

export function resolveUnitTurretMounts(
  getTurretBodyRadius: (turretId: TurretId) => number,
): void {
  if (unitTurretMountsResolved) return;

  for (const bp of Object.values(UNIT_BLUEPRINTS)) {
    for (let i = 0; i < bp.turrets.length; i++) {
      const turret = bp.turrets[i];
      const resolver = turret.zResolver;
      if (!resolver) continue;
      if (resolver.kind !== 'topMounted') {
        throw new Error(
          `Invalid turret mount resolver for ${bp.id}[${i}] ${turret.turretId}: unsupported kind`,
        );
      }
      const turretRadius = getTurretBodyRadius(turret.turretId);
      if (!Number.isFinite(turretRadius) || turretRadius <= 0) {
        throw new Error(
          `Invalid top-mounted turret for ${bp.id}[${i}] ${turret.turretId}: turret radius.body must be positive`,
        );
      }
      turret.mount.z = resolver.bodyTopZFrac + turretRadius / bp.radius.body;
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
  return createUnitLocomotion(getUnitBlueprint(id).locomotion);
}

export function getAllUnitBlueprints(): UnitBlueprint[] {
  assertUnitTurretMountsResolved();
  return Object.values(UNIT_BLUEPRINTS);
}

// Normalized cost: total per-build cost / max total across buildables.
// "Total" is the sum across the three resource axes — gives a single
// scalar for UI rank/scale display while honouring per-resource costs.
let _costNormCache: { max: number } | null = null;

function totalCost(c: { energy: number; mana: number; metal: number }): number {
  return c.energy + c.mana + c.metal;
}

function getCostNorm(): { max: number } {
  if (_costNormCache) return _costNormCache;
  let max = 0;
  for (const id of BUILDABLE_UNIT_IDS) {
    const unitBlueprint = UNIT_BLUEPRINTS[id];
    if (!unitBlueprint) continue;
    const t = totalCost(unitBlueprint.cost);
    if (t > max) max = t;
  }
  _costNormCache = { max };
  return _costNormCache;
}

export function getNormalizedUnitCost(unitBlueprint: {
  cost: { energy: number; mana: number; metal: number };
}): number {
  const { max } = getCostNorm();
  return max > 0 ? totalCost(unitBlueprint.cost) / max : 0;
}
