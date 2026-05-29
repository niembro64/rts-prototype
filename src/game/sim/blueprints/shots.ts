/**
 * Shot blueprints.
 *
 * Authored data lives in shots.json so the same shot table can be read
 * by TypeScript today and Rust/WASM later. This module only resolves
 * references and validates the table shape expected by current callers.
 */

import { isShotId, type ShotId } from '../../../types/blueprintIds';
import rawShotBlueprints from './shots.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';
import type { ShotBlueprint } from './types';

const PROJECTILE_EXPLICIT_FIELDS = [
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
  'angle',
  'transitionTime',
  'barrier',
  'hitSound',
] as const;

export const SHOT_BLUEPRINTS = resolveBlueprintRefs(
  rawShotBlueprints,
) as unknown as Record<ShotId, ShotBlueprint>;

export function getShotBlueprint(id: string): ShotBlueprint {
  if (!isShotId(id)) throw new Error(`Unknown shot blueprint: ${id}`);
  const shotBlueprint = SHOT_BLUEPRINTS[id];
  return shotBlueprint;
}

for (const [id, blueprint] of Object.entries(SHOT_BLUEPRINTS)) {
  if (blueprint.id !== id) {
    throw new Error(
      `Shot blueprint key/id mismatch: ${id} contains ${blueprint.id}`,
    );
  }
  if (blueprint.type === 'plasma' || blueprint.type === 'rocket') {
    assertExplicitFields(
      `shot blueprint ${id}`,
      blueprint,
      PROJECTILE_EXPLICIT_FIELDS,
    );
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
  } else {
    assertExplicitFields(`shot blueprint ${id}`, blueprint, LINE_EXPLICIT_FIELDS);
  }
}
