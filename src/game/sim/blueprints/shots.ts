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
  assertValidEntityRadius,
  assertValidEntityBaseLedger,
} from './entityBaseLedger';

const PROJECTILE_EXPLICIT_FIELDS = [
  'name',
  'base',
  'health',
  'hitSound',
  'submunitions',
  'homingTurnRate',
  'homingThrust',
  'homingDelayMs',
  'propulsionForce',
  'physicsMedium',
  'gravityForceMultiplier',
  'airFrictionPer60HzFrame',
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
  if (
    blueprint.physicsMedium !== 'air-only' &&
    blueprint.physicsMedium !== 'water-only' &&
    blueprint.physicsMedium !== 'air-and-water'
  ) {
    throw new Error(
      `Shot blueprint ${id} has invalid physicsMedium: expected air-only, water-only, or air-and-water.`,
    );
  }
  // The runtime shot explosion is derived from base.deathExplosion in
  // buildShotConfig — base.deathExplosion is the single source of truth for
  // a shot's death blast, so there is no separate authored `explosion` field
  // to cross-check here.
  // Rocket homing is "rate + thrust" because rockets steer through
  // authored engine acceleration. Missiles are the constant-speed
  // exception: they steer by rotating the velocity vector and must not
  // author homing thrust or propulsion force.
  const hasRate = blueprint.homingTurnRate !== null;
  const hasThrust = blueprint.homingThrust !== null;
  if (blueprint.type === 'missile') {
    if (!hasRate || !Number.isFinite(blueprint.homingTurnRate) || blueprint.homingTurnRate! <= 0) {
      throw new Error(
        `Shot blueprint ${id} must define positive homingTurnRate for missile steering.`,
      );
    }
    if (hasThrust) {
      throw new Error(
        `Shot blueprint ${id} must use null homingThrust: missiles preserve speed by velocity rotation.`,
      );
    }
    if (blueprint.propulsionForce !== null) {
      throw new Error(
        `Shot blueprint ${id} must use null propulsionForce: missiles do not accelerate forward.`,
      );
    }
    if (blueprint.airFrictionPer60HzFrame !== 0) {
      throw new Error(
        `Shot blueprint ${id} must use zero airFrictionPer60HzFrame to preserve missile speed.`,
      );
    }
    if (blueprint.gravityForceMultiplier !== 0) {
      throw new Error(
        `Shot blueprint ${id} must use zero gravityForceMultiplier to preserve missile speed.`,
      );
    }
  } else if (blueprint.type === 'rocket') {
    if (!hasRate || !Number.isFinite(blueprint.homingTurnRate) || blueprint.homingTurnRate! <= 0) {
      throw new Error(
        `Shot blueprint ${id} must define positive homingTurnRate for rocket steering.`,
      );
    }
    if (!hasThrust || !Number.isFinite(blueprint.homingThrust) || blueprint.homingThrust! <= 0) {
      throw new Error(
        `Shot blueprint ${id} must define positive homingThrust for rocket steering.`,
      );
    }
  } else if (hasRate !== hasThrust) {
    throw new Error(
      `Shot blueprint ${id} mismatched homing: homingTurnRate=${blueprint.homingTurnRate}, homingThrust=${blueprint.homingThrust}. Both must be set or both null.`,
    );
  }
  if (blueprint.type === 'rocket' && blueprint.gravityForceMultiplier !== 1) {
    throw new Error(
      `Shot blueprint ${id} must use gravityForceMultiplier 1: rocket thrust should counter gravity instead of opting out of it.`,
    );
  }
  if (blueprint.homingDelayMs !== null && (!Number.isFinite(blueprint.homingDelayMs) || blueprint.homingDelayMs < 0)) {
    throw new Error(
      `Shot blueprint ${id} has invalid homingDelayMs: expected null or finite non-negative milliseconds.`,
    );
  }
  if (!hasRate && blueprint.homingDelayMs !== null) {
    throw new Error(
      `Shot blueprint ${id} has homingDelayMs without homing: non-homing shots must use null.`,
    );
  }
  if (!Number.isFinite(blueprint.gravityForceMultiplier) || blueprint.gravityForceMultiplier < 0) {
    throw new Error(
      `Shot blueprint ${id} has invalid gravityForceMultiplier: projectile shots must define a finite non-negative multiplier.`,
    );
  }
  if (blueprint.propulsionForce !== null && (!Number.isFinite(blueprint.propulsionForce) || blueprint.propulsionForce < 0)) {
    throw new Error(
      `Shot blueprint ${id} has invalid propulsionForce: expected null or finite non-negative force.`,
    );
  }
  if (!Number.isFinite(blueprint.airFrictionPer60HzFrame) || blueprint.airFrictionPer60HzFrame < 0 || blueprint.airFrictionPer60HzFrame >= 1) {
    throw new Error(
      `Shot blueprint ${id} has invalid airFrictionPer60HzFrame: expected finite value in [0, 1).`,
    );
  }
  if (blueprint.type === 'rocket' || blueprint.type === 'missile') {
    if (!Number.isFinite(blueprint.maxLifespan) || blueprint.maxLifespan! <= 0) {
      throw new Error(
        `Shot blueprint ${id} must define positive maxLifespan for guided munition expiry`,
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
