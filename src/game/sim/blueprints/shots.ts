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
import { getShotLocomotionPreset } from '../shotLocomotion';

const PROJECTILE_EXPLICIT_FIELDS = [
  'name',
  'base',
  'health',
  'hitSound',
  'submunitions',
  'shotLocomotionPresetId',
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
  getShotLocomotionPreset(blueprint.shotLocomotionPresetId);
  // The runtime shot explosion is derived from base.deathExplosion in
  // buildShotConfig — base.deathExplosion is the single source of truth for
  // a shot's death blast, so there is no separate authored `explosion` field
  // to cross-check here.
}
