/**
 * Shot blueprints.
 *
 * Authored data lives in shots.json. Only physical travelling
 * projectile bodies belong here; rays and shields have separate
 * blueprint families.
 */

import { isShotBlueprintId, type ShotBlueprintId } from '../../../types/blueprintIds';
import rawShotBlueprints from './shots.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields, isObject } from './jsonValidation';
import type { ShotBlueprint } from './types';
import {
  assertValidEntityRadius,
  assertValidEntityBaseLedger,
} from './entityBaseLedger';
import { getShotLocomotionPreset } from '../shotLocomotion';
import { validateEmissionMediumTrajectoryMatrix } from '../emissionMedium';

const PROJECTILE_EXPLICIT_FIELDS = [
  'name',
  'base',
  'health',
  'hitSound',
  'submunitions',
  'shotLocomotionPresetId',
  'maxLifespanMs',
  'turning',
  'mediumTrajectory',
  'smokeTrail',
] as const;

export const SHOT_BLUEPRINTS = resolveBlueprintRefs(
  rawShotBlueprints,
) as unknown as Record<ShotBlueprintId, ShotBlueprint>;

export function getShotBlueprint(id: string): ShotBlueprint {
  if (!isShotBlueprintId(id)) throw new Error(`Unknown shot blueprint: ${id}`);
  const shotBlueprint = SHOT_BLUEPRINTS[id];
  return shotBlueprint;
}

for (const [id, blueprint] of Object.entries(SHOT_BLUEPRINTS)) {
  if (blueprint.shotBlueprintId !== id) {
    throw new Error(
      `Shot blueprint key/id mismatch: ${id} contains ${blueprint.shotBlueprintId}`,
    );
  }
  if (typeof blueprint.name !== 'string' || blueprint.name.trim().length === 0) {
    throw new Error(`Invalid shot blueprint ${id}: missing display name`);
  }
  if (
    blueprint.type !== 'plasma' &&
    blueprint.type !== 'rocket' &&
    blueprint.type !== 'missile'
  ) {
    throw new Error(
      `Invalid shot blueprint ${id}: shots.json may only contain physical plasma/rocket/missile shots`,
    );
  }
  assertExplicitFields(
    `shot blueprint ${id}`,
    blueprint,
    PROJECTILE_EXPLICIT_FIELDS,
  );
  assertValidEntityBaseLedger(`shot blueprint ${id}`, blueprint.base);
  if (!Number.isFinite(blueprint.mass) || blueprint.mass <= 0) {
    throw new Error(
      `Shot blueprint ${id} has invalid mass: projectile shots must define positive finite mass.`,
    );
  }
  if (!Number.isFinite(blueprint.health) || blueprint.health <= 0) {
    throw new Error(
      `Shot blueprint ${id} has invalid health: projectile shots must define positive finite health.`,
    );
  }
  assertValidEntityRadius(`shot blueprint ${id}`, blueprint.radius);
  validateEmissionMediumTrajectoryMatrix(
    `shot blueprint ${id}.mediumTrajectory`,
    blueprint.mediumTrajectory,
  );
  const locomotion = getShotLocomotionPreset(blueprint.shotLocomotionPresetId);
  if (
    blueprint.maxLifespanMs !== null &&
    (!Number.isFinite(blueprint.maxLifespanMs) || blueprint.maxLifespanMs <= 0)
  ) {
    throw new Error(
      `Invalid shot blueprint ${id}.maxLifespanMs: expected positive finite milliseconds or null`,
    );
  }
  const turning = blueprint.turning;
  const isRocketOrMissile = blueprint.type === 'rocket' || blueprint.type === 'missile';
  const usesGuidance =
    locomotion.motionModel === 'constantSpeedGuided' ||
    locomotion.motionModel === 'thrustGuided';
  // A missile is guided by definition. A rocket may be a dumb-fire round:
  // aimed at launch, no turning, on a non-guided locomotion preset.
  if (blueprint.type === 'missile' && turning === null) {
    throw new Error(
      `Invalid shot blueprint ${id}.turning: missile shots must author turning controls`,
    );
  }
  if (blueprint.type === 'rocket' && turning === null && usesGuidance) {
    throw new Error(
      `Invalid shot blueprint ${id}.turning: guided rocket presets must author turning controls`,
    );
  }
  if (!isRocketOrMissile && turning !== null) {
    throw new Error(
      `Invalid shot blueprint ${id}.turning: plasma shots must explicitly author null`,
    );
  }
  if (usesGuidance !== (turning !== null)) {
    throw new Error(
      `Invalid shot blueprint ${id}.turning: turning controls must match a guided locomotion preset`,
    );
  }
  if (turning !== null) {
    if (!isObject(turning)) {
      throw new Error(`Invalid shot blueprint ${id}.turning: expected object`);
    }
    assertExplicitFields(`shot blueprint ${id}.turning`, turning, [
      'turnRate',
      'guidanceDelayMs',
      'guidanceRampMs',
      'guidanceSolveRateHz',
      'lostTargetBehavior',
      'lostTargetArrivalRadius',
    ]);
    const expectedTurningFields = new Set([
      'turnRate',
      'guidanceDelayMs',
      'guidanceRampMs',
      'guidanceSolveRateHz',
      'lostTargetBehavior',
      'lostTargetArrivalRadius',
    ]);
    for (const key of Object.keys(turning)) {
      if (!expectedTurningFields.has(key)) {
        throw new Error(`Invalid shot blueprint ${id}.turning.${key}: unexpected field`);
      }
    }
    if (!Number.isFinite(turning.turnRate) || !(turning.turnRate > 0)) {
      throw new Error(
        `Invalid shot blueprint ${id}.turning.turnRate: expected finite radians/second > 0`,
      );
    }
    for (const field of ['guidanceDelayMs', 'guidanceRampMs'] as const) {
      if (!Number.isFinite(turning[field]) || turning[field] < 0) {
        throw new Error(
          `Invalid shot blueprint ${id}.turning.${field}: expected finite milliseconds >= 0`,
        );
      }
    }
    if (!Number.isFinite(turning.guidanceSolveRateHz) || !(turning.guidanceSolveRateHz > 0)) {
      throw new Error(
        `Invalid shot blueprint ${id}.turning.guidanceSolveRateHz: expected finite hertz > 0`,
      );
    }
    if (
      turning.lostTargetBehavior !== 'continueCurrentVector' &&
      turning.lostTargetBehavior !== 'flyToLastInterceptPoint'
    ) {
      throw new Error(
        `Invalid shot blueprint ${id}.turning.lostTargetBehavior: expected supported policy`,
      );
    }
    if (
      !Number.isFinite(turning.lostTargetArrivalRadius) ||
      turning.lostTargetArrivalRadius < 0
    ) {
      throw new Error(
        `Invalid shot blueprint ${id}.turning.lostTargetArrivalRadius: expected finite radius >= 0`,
      );
    }
    if (
      turning.lostTargetBehavior === 'flyToLastInterceptPoint' &&
      !(turning.lostTargetArrivalRadius > 0)
    ) {
      throw new Error(
        `Invalid shot blueprint ${id}.turning.lostTargetArrivalRadius: fly-to-point guidance requires radius > 0`,
      );
    }
  }
  const routes = blueprint.mediumTrajectory;
  if (
    (routes.aboveWater.aboveWater || routes.aboveWater.underwater) &&
    !locomotion.media.air.operational
  ) {
    throw new Error(
      `Invalid shot blueprint ${id}.mediumTrajectory.aboveWater: a true launch route requires operational air locomotion`,
    );
  }
  if (
    (routes.underwater.aboveWater || routes.underwater.underwater) &&
    !locomotion.media.water.operational
  ) {
    throw new Error(
      `Invalid shot blueprint ${id}.mediumTrajectory.underwater: a true launch route requires operational water locomotion`,
    );
  }
  if (
    routes.aboveWater.underwater &&
    (locomotion.transitions.enterWater === 'detonate' ||
      locomotion.transitions.enterWater === 'despawn')
  ) {
    throw new Error(
      `Invalid shot blueprint ${id}.mediumTrajectory.aboveWater.underwater: enterWater terminates the shot`,
    );
  }
  if (
    routes.underwater.aboveWater &&
    (locomotion.transitions.exitWater === 'detonate' ||
      locomotion.transitions.exitWater === 'despawn')
  ) {
    throw new Error(
      `Invalid shot blueprint ${id}.mediumTrajectory.underwater.aboveWater: exitWater terminates the shot`,
    );
  }
  // The runtime shot explosion is derived from base.deathExplosion in
  // buildShotConfig — base.deathExplosion is the single source of truth for
  // a shot's death blast, so there is no separate authored `explosion` field
  // to cross-check here.
}
