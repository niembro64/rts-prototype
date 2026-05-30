/**
 * Shot blueprints.
 *
 * Authored data lives in shots.json so the same shot table can be read
 * by TypeScript today and Rust/WASM later. This module only resolves
 * references and validates the table shape expected by current callers.
 */

import {
  isForceFieldMaterialId,
  isShotBlueprintId,
  type ShotBlueprintId,
} from '../../../types/blueprintIds';
import rawShotBlueprints from './shots.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';
import type { ShotBlueprint } from './types';
import {
  assertNumberEquals,
  assertRadiusEquals,
  assertValidEntityBaseLedger,
} from './entityBaseLedger';

const PROJECTILE_EXPLICIT_FIELDS = [
  'base',
  'health',
  'explosion',
  'hitSound',
  'submunitions',
  'homingTurnRate',
  'homingThrust',
  'gravityForceMultiplier',
  'smokeTrail',
] as const;

const LINE_EXPLICIT_FIELDS = ['hitSound', 'gravityForceMultiplier'] as const;
const FORCE_FIELD_EXPLICIT_FIELDS = [
  'materialId',
  'angle',
  'transitionTime',
  'barrier',
  'hitSound',
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
  if (blueprint.type === 'plasma' || blueprint.type === 'rocket') {
    assertExplicitFields(
      `shot blueprint ${id}`,
      blueprint,
      PROJECTILE_EXPLICIT_FIELDS,
    );
    assertValidEntityBaseLedger(`shot blueprint ${id}`, blueprint.base);
    assertNumberEquals(`shot blueprint ${id}`, 'mass', blueprint.mass, blueprint.base.mass);
    assertNumberEquals(`shot blueprint ${id}`, 'health', blueprint.health, blueprint.base.health);
    assertRadiusEquals(
      `shot blueprint ${id}`,
      {
        visual: blueprint.collision.radius,
        hitbox: blueprint.collision.radius,
        collision: blueprint.collision.radius,
      },
      blueprint.base.radius,
    );
    if (blueprint.explosion !== null) {
      const blast = blueprint.base.deathExplosion;
      assertNumberEquals(`shot blueprint ${id}`, 'deathExplosion.radius', blueprint.explosion.radius, blast.radius);
      assertNumberEquals(`shot blueprint ${id}`, 'deathExplosion.force', blueprint.explosion.force, blast.force);
      assertNumberEquals(`shot blueprint ${id}`, 'deathExplosion.damage', blueprint.explosion.damage, blast.damage);
    }
    // Homing is "rate + thrust" — both fields must be set together or
    // neither. A turn rate without a thrust budget would be steering
    // without an engine; a thrust budget without a turn rate would be
    // an engine without guidance fins.
    const hasRate = blueprint.homingTurnRate !== null;
    const hasThrust = blueprint.homingThrust !== null;
    if (hasRate !== hasThrust) {
      throw new Error(
        `Shot blueprint ${id} mismatched homing: homingTurnRate=${blueprint.homingTurnRate}, homingThrust=${blueprint.homingThrust}. Both must be set or both null.`,
      );
    }
    if (
      !Number.isFinite(blueprint.health) ||
      blueprint.health <= 0
    ) {
      throw new Error(
        `Shot blueprint ${id} has invalid health: projectile shots must define positive finite health.`,
      );
    }
    if (
      !Number.isFinite(blueprint.gravityForceMultiplier) ||
      blueprint.gravityForceMultiplier <= 0
    ) {
      throw new Error(
        `Shot blueprint ${id} has invalid gravityForceMultiplier: projectile shots must keep gravity enabled with a positive finite multiplier.`,
      );
    }
    if (blueprint.type === 'rocket') {
      if (
        !Number.isFinite(blueprint.maxLifespan) ||
        blueprint.maxLifespan! <= 0
      ) {
        throw new Error(
          `Shot blueprint ${id} must define positive maxLifespan for rocket expiry`,
        );
      }
    } else if (
      blueprint.maxLifespan !== undefined &&
      blueprint.maxLifespan !== null &&
      (!Number.isFinite(blueprint.maxLifespan) || blueprint.maxLifespan <= 0)
    ) {
      throw new Error(
        `Shot blueprint ${id} has invalid maxLifespan: expected positive finite milliseconds`,
      );
    }
  } else if (blueprint.type === 'forceField') {
    if ('base' in blueprint) {
      throw new Error(
        `Invalid shot blueprint ${id}: force-field emissions are not entities and must not carry base`,
      );
    }
    assertExplicitFields(
      `shot blueprint ${id}`,
      blueprint,
      FORCE_FIELD_EXPLICIT_FIELDS,
    );
    if (
      !Number.isFinite(blueprint.transitionTime) ||
      blueprint.transitionTime <= 0
    ) {
      throw new Error(
        `Shot blueprint ${id} must define positive transitionTime`,
      );
    }
    if (!isForceFieldMaterialId(blueprint.materialId)) {
      throw new Error(
        `Shot blueprint ${id} references unknown force-field material: ${blueprint.materialId}`,
      );
    }
  } else {
    if ('base' in blueprint) {
      throw new Error(
        `Invalid shot blueprint ${id}: line emissions are not entities and must not carry base`,
      );
    }
    assertExplicitFields(`shot blueprint ${id}`, blueprint, LINE_EXPLICIT_FIELDS);
    if (blueprint.gravityForceMultiplier !== 0) {
      throw new Error(
        `Shot blueprint ${id} has invalid gravityForceMultiplier: line weapons must use 0 because they are not ballistic projectile bodies.`,
      );
    }
  }
}
