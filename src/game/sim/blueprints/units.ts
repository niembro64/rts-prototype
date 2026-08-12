/**
 * Unit blueprints.
 *
 * Authored unit facts live in units.json. Unit locomotion is authored
 * inline on the unit; this loader resolves $audio and validates the complete
 * force profile alongside the unit's explicit pathing class.
 */

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
import type {
  CrawlerConfig,
  BotArms,
  BotLegs,
  UnitBodyShape,
} from '@/types/blueprintSchema.generated';
import {
  assertNoInlineLockOnInclusionFields,
} from './lockOnValidation';
import {
  assertUnitLockOnInclusionConfigIds,
  getUnitLockOnInclusions,
} from './lockOnConfig';
import {
  assertValidEntityRadius,
  normalizeEntityBaseLedgerFromAliases,
} from './entityBaseLedger';
import type { UnitSupportSurface } from '../../../types/blueprints';

type JsonUnitBlueprint = Omit<UnitBlueprint, keyof LockOnInclusionObject>;

const UNIT_EXPLICIT_FIELDS = [
  'base',
  'supportSurface',
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
      if (mount.sensorTurretBlueprintId !== undefined) {
        const sensorBlueprint = TURRET_BLUEPRINTS[mount.sensorTurretBlueprintId];
        if (!sensorBlueprint || sensorBlueprint.kind !== 'sensor') {
          throw new Error(
            `Invalid unit blueprint ${id}: sensorTurretBlueprintId "${mount.sensorTurretBlueprintId}" must reference a sensor turret blueprint`,
          );
        }
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

function validateUnitWorkCapability(bp: UnitBlueprint): void {
  const constructionRate = bp.constructionRate ?? null;
  const roster = bp.allowedBuildBlueprintIds ?? null;
  const producedUnitBlueprintId = bp.factoryProducedUnitBlueprintId ?? null;
  const workEmitter = bp.workEmitter ?? null;

  if (constructionRate !== null && (!Number.isFinite(constructionRate) || constructionRate <= 0)) {
    throw new Error(
      `Invalid work config for ${bp.unitBlueprintId}: constructionRate must be positive`,
    );
  }
  if (roster !== null) {
    if (!Array.isArray(roster) || roster.length === 0) {
      throw new Error(
        `Invalid builder config for ${bp.unitBlueprintId}: allowedBuildBlueprintIds must not be empty`,
      );
    }
    const seen = new Set<string>();
    for (const id of roster) {
      if (!isStructureBlueprintId(id)) {
        throw new Error(
          `Invalid builder config for ${bp.unitBlueprintId}: unknown allowedBuildBlueprintId "${id}"`,
        );
      }
      if (seen.has(id)) {
        throw new Error(
          `Invalid builder config for ${bp.unitBlueprintId}: duplicate allowedBuildBlueprintId "${id}"`,
        );
      }
      seen.add(id);
    }
  }
  if (
    producedUnitBlueprintId !== null &&
    UNIT_BLUEPRINTS[producedUnitBlueprintId] === undefined
  ) {
    throw new Error(
      `Invalid factory config for ${bp.unitBlueprintId}: unknown factoryProducedUnitBlueprintId "${producedUnitBlueprintId}"`,
    );
  }
  if (constructionRate !== null) {
    if (
      workEmitter === null ||
      workEmitter.points.length === 0 ||
      !Number.isFinite(workEmitter.particleTravelSpeed) ||
      workEmitter.particleTravelSpeed <= 0 ||
      !Number.isFinite(workEmitter.particleRadius) ||
      workEmitter.particleRadius <= 0
    ) {
      throw new Error(
        `Invalid work config for ${bp.unitBlueprintId}: construction hosts must author a valid workEmitter`,
      );
    }
    for (const point of workEmitter.points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
        throw new Error(
          `Invalid work config for ${bp.unitBlueprintId}: workEmitter points must be finite`,
        );
      }
    }
  } else if (workEmitter !== null) {
    throw new Error(
      `Invalid work config for ${bp.unitBlueprintId}: workEmitter requires constructionRate`,
    );
  }

  if (bp.builder === null) {
    if (roster !== null) {
      throw new Error(
        `Invalid builder config for ${bp.unitBlueprintId}: only builders may author allowedBuildBlueprintIds`,
      );
    }
    return;
  }
  if (!Number.isFinite(bp.builder.buildRange) || bp.builder.buildRange <= 0) {
    throw new Error(
      `Invalid builder config for ${bp.unitBlueprintId}: buildRange must be positive`,
    );
  }
  if (constructionRate === null || roster === null) {
    throw new Error(
      `Invalid constructor config for ${bp.unitBlueprintId}: builders must author constructionRate and allowedBuildBlueprintIds on the host`,
    );
  }
}

/** A crawler authors its mirrored world-space leg layout directly on the
 *  locomotion config, with one shared envelope for every limb. */
function validateCrawlerLayout(unitBlueprintId: string, config: CrawlerConfig): void {
  const choppingRatio = config.choppingSphere.radiusLegLengthRatio;
  if (!Number.isFinite(choppingRatio) || choppingRatio <= 0) {
    throw new Error(
      `Invalid leg layout for ${unitBlueprintId}: choppingSphere.radiusLegLengthRatio must be finite and positive`,
    );
  }
  const globalValues = [
    ['radius', config.radius],
    ['segments.upper.lengthUnitRadiusRatio', config.segments.upper.lengthUnitRadiusRatio],
    ['segments.lower.lengthUnitRadiusRatio', config.segments.lower.lengthUnitRadiusRatio],
    ['footSphere.originExtensionRatio', config.footSphere.originExtensionRatio],
    ['footSphere.radiusLegLengthRatio', config.footSphere.radiusLegLengthRatio],
    ['snapRay.originBoundarySpanRatio', config.snapRay.originBoundarySpanRatio],
  ] as const;
  for (const [name, value] of globalValues) {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Invalid leg layout for ${unitBlueprintId}: ${name} must be finite`,
      );
    }
  }
  if (
    config.radius <= 0 ||
    config.segments.upper.lengthUnitRadiusRatio <= 0 ||
    config.segments.lower.lengthUnitRadiusRatio <= 0
  ) {
    throw new Error(
      `Invalid leg layout for ${unitBlueprintId}: radius and leg lengths must be positive`,
    );
  }
  if (
    config.footSphere.originExtensionRatio < 0
    || config.footSphere.originExtensionRatio > 1
  ) {
    throw new Error(
      `Invalid leg layout for ${unitBlueprintId}: footSphere.originExtensionRatio must be between 0 and 1`,
    );
  }
  if (config.footSphere.radiusLegLengthRatio <= 0) {
    throw new Error(
      `Invalid leg layout for ${unitBlueprintId}: footSphere.radiusLegLengthRatio must be positive`,
    );
  }
  if (
    config.snapRay.originBoundarySpanRatio < 0
    || config.snapRay.originBoundarySpanRatio > 1
  ) {
    throw new Error(
      `Invalid leg layout for ${unitBlueprintId}: snapRay.originBoundarySpanRatio must be between 0 and 1`,
    );
  }
  const legs = config.leftSide;
  if (!Array.isArray(legs) || legs.length === 0) {
    throw new Error(
      `Invalid leg layout for ${unitBlueprintId}: leftSide must define at least one leg`,
    );
  }
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const values = [
      ['attachmentPoint.xUnitRadiusRatio', leg.attachmentPoint.xUnitRadiusRatio],
      ['attachmentPoint.yUnitRadiusRatio', leg.attachmentPoint.yUnitRadiusRatio],
    ] as const;
    for (const [name, value] of values) {
      if (!Number.isFinite(value)) {
        throw new Error(
          `Invalid leg layout for ${unitBlueprintId}[${i}]: ${name} must be finite`,
        );
      }
    }
    const attachLengthSq =
      leg.attachmentPoint.xUnitRadiusRatio * leg.attachmentPoint.xUnitRadiusRatio +
      leg.attachmentPoint.yUnitRadiusRatio * leg.attachmentPoint.yUnitRadiusRatio;
    if (attachLengthSq <= 1e-12) {
      throw new Error(
        `Invalid leg layout for ${unitBlueprintId}[${i}]: attachment must be offset from the unit center`,
      );
    }
  }
}

/** A bot mech owns a coupled biped pose, not independent reach shells.
 *  Its authored idle stance may open forward and laterally at the hip, so the
 *  reach check includes those two offsets as well as standing height. */
function validateBotLegs(unitBlueprintId: string, legs: BotLegs): void {
  const values = [
    ['hip.xUnitRadiusRatio', legs.hip.xUnitRadiusRatio],
    ['hip.yUnitRadiusRatio', legs.hip.yUnitRadiusRatio],
    ['hip.zUnitRadiusRatio', legs.hip.zUnitRadiusRatio],
    ['radius', legs.radius],
    ['segments.upper.lengthUnitRadiusRatio', legs.segments.upper.lengthUnitRadiusRatio],
    ['segments.lower.lengthUnitRadiusRatio', legs.segments.lower.lengthUnitRadiusRatio],
    ['footLengthRatio', legs.footLengthRatio],
    ['footWidthRatio', legs.footWidthRatio],
    ['strideLengthRatio', legs.strideLengthRatio],
    ['strideLiftRatio', legs.strideLiftRatio],
    ['standHeightRatio', legs.standHeightRatio],
    ['stanceForwardUnitRadiusRatio', legs.stanceForwardUnitRadiusRatio],
    ['stanceOutwardUnitRadiusRatio', legs.stanceOutwardUnitRadiusRatio],
  ] as const;
  for (const [name, value] of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid stand leg layout for ${unitBlueprintId}: ${name} must be finite`);
    }
  }
  if (
    legs.radius <= 0 ||
    legs.segments.upper.lengthUnitRadiusRatio <= 0 ||
    legs.segments.lower.lengthUnitRadiusRatio <= 0 ||
    legs.strideLengthRatio <= 0 ||
    legs.standHeightRatio <= 0 ||
    legs.stanceForwardUnitRadiusRatio < 0 ||
    legs.stanceOutwardUnitRadiusRatio < 0
  ) {
    throw new Error(
      `Invalid stand leg layout for ${unitBlueprintId}: lengths, stride and stand height must be positive`,
    );
  }
  if (legs.hip.yUnitRadiusRatio <= 0) {
    throw new Error(
      `Invalid stand leg layout for ${unitBlueprintId}: hip.yUnitRadiusRatio is the half-track between the two legs and must be positive`,
    );
  }
  // A hip that stands higher than the leg is long cannot reach the ground, and
  // the solve would silently hold the leg straight at full extension forever.
  if (legs.standHeightRatio > 1) {
    throw new Error(
      `Invalid stand leg layout for ${unitBlueprintId}: standHeightRatio must be at most 1 — a leg cannot stand taller than it is long`,
    );
  }
  const legLengthRatio =
    legs.segments.upper.lengthUnitRadiusRatio +
    legs.segments.lower.lengthUnitRadiusRatio;
  const standHeightRatio = legLengthRatio * legs.standHeightRatio;
  if (Math.abs(standHeightRatio - legs.hip.zUnitRadiusRatio) > 1e-5) {
    throw new Error(
      `Invalid stand leg layout for ${unitBlueprintId}: hip height must equal the authored standing height so fixed-length bones meet the ground`,
    );
  }
  const stoppedReachRatioSq =
    standHeightRatio * standHeightRatio +
    legs.stanceForwardUnitRadiusRatio * legs.stanceForwardUnitRadiusRatio +
    legs.stanceOutwardUnitRadiusRatio * legs.stanceOutwardUnitRadiusRatio;
  const toleratedLegLengthRatio = legLengthRatio + 1e-6;
  if (stoppedReachRatioSq > toleratedLegLengthRatio * toleratedLegLengthRatio) {
    throw new Error(
      `Invalid stand leg layout for ${unitBlueprintId}: stopped stance cannot reach its authored forward/outward foot offsets`,
    );
  }
  const walkingHalfStrideRatio = legLengthRatio * legs.strideLengthRatio * 0.48;
  const walkingReachRatioSq =
    standHeightRatio * standHeightRatio + walkingHalfStrideRatio * walkingHalfStrideRatio;
  if (walkingReachRatioSq > toleratedLegLengthRatio * toleratedLegLengthRatio) {
    throw new Error(
      `Invalid stand leg layout for ${unitBlueprintId}: walking stride exceeds the fixed-length leg reach`,
    );
  }
}

/** A biped's arms hang off the same stride its legs walk with. None of this
 *  reaches the sim — arms are presentation — but a non-finite ratio poses the
 *  whole limb at NaN, which reads as a missing arm rather than as a bad
 *  blueprint. */
function validateBotArms(unitBlueprintId: string, arms: BotArms): void {
  const values = [
    ['shoulder.xUnitRadiusRatio', arms.shoulder.xUnitRadiusRatio],
    ['shoulder.yUnitRadiusRatio', arms.shoulder.yUnitRadiusRatio],
    ['shoulder.zUnitRadiusRatio', arms.shoulder.zUnitRadiusRatio],
    ['radius', arms.radius],
    ['segments.upper.lengthUnitRadiusRatio', arms.segments.upper.lengthUnitRadiusRatio],
    ['segments.lower.lengthUnitRadiusRatio', arms.segments.lower.lengthUnitRadiusRatio],
    ['handRadiusRatio', arms.handRadiusRatio],
    ['restSwingDeg', arms.restSwingDeg],
    ['walkSwingDeg', arms.walkSwingDeg],
    ['outwardDeg', arms.outwardDeg],
  ] as const;
  for (const [name, value] of values) {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid arm layout for ${unitBlueprintId}: ${name} must be finite`);
    }
  }
  if (
    arms.radius <= 0 ||
    arms.segments.upper.lengthUnitRadiusRatio <= 0 ||
    arms.segments.lower.lengthUnitRadiusRatio <= 0 ||
    arms.outwardDeg < 5
  ) {
    throw new Error(
      `Invalid arm layout for ${unitBlueprintId}: radius and arm lengths must be positive, and outwardDeg must be at least 5`,
    );
  }
  if (arms.handRadiusRatio < 0 || arms.walkSwingDeg < 0) {
    throw new Error(
      `Invalid arm layout for ${unitBlueprintId}: handRadiusRatio and walkSwingDeg must be non-negative`,
    );
  }
}

/**
 * A ROD IS PLACED ONE WAY OR THE OTHER, NEVER BOTH.
 *
 * A cylinder segment states its height either as a centre plus a tilt or as
 * its two end heights (see getCylinderSegmentPose). Authoring both forms
 * leaves two descriptions of one rod, and the resolver can only obey one —
 * so the loser silently does nothing, which is the kind of dead knob someone
 * tunes for a while before noticing.
 */
function validateBodyShapeSegments(
  unitBlueprintId: string,
  bodyShape: UnitBodyShape | null,
): void {
  if (bodyShape === null || bodyShape.kind !== 'composite') return;
  for (let i = 0; i < bodyShape.parts.length; i++) {
    const part = bodyShape.parts[i];
    if (part.kind !== 'cylinder') continue;
    const authorsEnds = part.startYFrac !== undefined || part.endYFrac !== undefined;
    if (!authorsEnds) continue;
    if (part.centerYFrac !== undefined || part.pitchRad !== undefined) {
      throw new Error(
        `Invalid body shape for ${unitBlueprintId}[${i}]: a cylinder segment authors ` +
        'either centerYFrac/pitchRad or startYFrac/endYFrac, not both',
      );
    }
    if (
      !Number.isFinite(part.startYFrac ?? NaN) ||
      !Number.isFinite(part.endYFrac ?? NaN)
    ) {
      throw new Error(
        `Invalid body shape for ${unitBlueprintId}[${i}]: a cylinder segment placed by ` +
        'its ends must author both startYFrac and endYFrac as finite numbers',
      );
    }
    if (Math.abs((part.startYFrac ?? 0) - (part.endYFrac ?? 0)) > part.lengthFrac) {
      throw new Error(
        `Invalid body shape for ${unitBlueprintId}[${i}]: a cylinder segment ${part.lengthFrac} ` +
        `long cannot rise ${Math.abs((part.startYFrac ?? 0) - (part.endYFrac ?? 0))} between its ends`,
      );
    }
  }
}

for (const bp of Object.values(UNIT_BLUEPRINTS)) {
  validateBodyShapeSegments(bp.unitBlueprintId, bp.bodyShape);
  validateUnitSupportSurface(bp.unitBlueprintId, bp.supportSurface);
  assertValidEntityRadius(`unit blueprint ${bp.unitBlueprintId}`, bp.radius);
  if (bp.turrets.length === 0) {
    throw new Error(`Invalid unit blueprint ${bp.unitBlueprintId}: every unit must mount at least one turret`);
  }

  if (!Number.isFinite(bp.supportPointOffsetZ) || bp.supportPointOffsetZ < 0) {
    throw new Error(
      `Invalid supportPointOffsetZ for ${bp.unitBlueprintId}: supportPointOffsetZ must be a finite non-negative number`,
    );
  }

  validateUnitWorkCapability(bp);

  if (!bp.hud || !Number.isFinite(bp.hud.barsOffsetAboveTop)) {
    throw new Error(
      `Invalid HUD layout for ${bp.unitBlueprintId}: barsOffsetAboveTop must be finite`,
    );
  }

  if (bp.unitLocomotion.type === 'crawler') {
    validateCrawlerLayout(bp.unitBlueprintId, bp.unitLocomotion.config);
  } else if (bp.unitLocomotion.type === 'bot') {
    validateBotLegs(bp.unitBlueprintId, bp.unitLocomotion.config.legs);
    validateBotArms(bp.unitBlueprintId, bp.unitLocomotion.config.arms);
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
        `Invalid turret mount for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: mount x/y/z must be finite`,
      );
    }
    const botHost = bp.unitLocomotion.type === 'bot';
    if (botHost && turret.hostAttachment === undefined) {
      throw new Error(
        `Invalid bot turret mount for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: ` +
        'every bot-host turret must identify its host attachment',
      );
    }
    if (!botHost && turret.hostAttachment !== undefined) {
      throw new Error(
        `Invalid turret host attachment for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: ` +
        'bot attachments require bot locomotion',
      );
    }
    // Airborne mounts may use all three axes. Presentation banking is
    // disabled for a host with any off-axis combat mount, so visual-only
    // roll can never move its rendered turret away from combat truth.
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

export function resolveUnitTurretMounts(): void {
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
      const turretRadius = turret.presentation?.headRadius;
      if (typeof turretRadius !== 'number' || !Number.isFinite(turretRadius) || turretRadius <= 0) {
        throw new Error(
          `Invalid top-mounted turret for ${bp.unitBlueprintId}[${i}] ${turret.turretBlueprintId}: presentation.headRadius must be positive`,
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
