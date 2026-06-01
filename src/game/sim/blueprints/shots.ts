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
import { assertExplicitFields } from './jsonValidation';
import type { ShotBlueprint } from './types';
import {
  assertNumberEquals,
  assertRadiusEquals,
  assertValidEntityBaseLedger,
} from './entityBaseLedger';

const PROJECTILE_EXPLICIT_FIELDS = [
  'name',
  'base',
  'health',
  'armingDelayMs',
  'hitSound',
  'submunitions',
  'homingTurnRate',
  'homingThrust',
  'gravityForceMultiplier',
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
  if (blueprint.type !== 'plasma' && blueprint.type !== 'rocket') {
    throw new Error(
      `Invalid shot blueprint ${id}: shots.json may only contain physical plasma/rocket shots`,
    );
  }
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
    blueprint.radius,
    blueprint.base.radius,
  );
  // The runtime shot explosion is derived from base.deathExplosion in
  // buildShotConfig — base.deathExplosion is the single source of truth for
  // a shot's death blast, so there is no separate authored `explosion` field
  // to cross-check here.
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
  if (!Number.isFinite(blueprint.health) || blueprint.health <= 0) {
    throw new Error(
      `Shot blueprint ${id} has invalid health: projectile shots must define positive finite health.`,
    );
  }
  if (!Number.isFinite(blueprint.armingDelayMs) || blueprint.armingDelayMs < 0) {
    throw new Error(
      `Shot blueprint ${id} has invalid armingDelayMs: expected finite milliseconds >= 0.`,
    );
  }
  if (!Number.isFinite(blueprint.gravityForceMultiplier) || blueprint.gravityForceMultiplier < 0) {
    throw new Error(
      `Shot blueprint ${id} has invalid gravityForceMultiplier: projectile shots must define a finite non-negative multiplier.`,
    );
  }
  if (blueprint.type === 'rocket') {
    if (!Number.isFinite(blueprint.maxLifespan) || blueprint.maxLifespan! <= 0) {
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
}
