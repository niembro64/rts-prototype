/**
 * Projectile blueprints.
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
  'lifespan',
  'lifespanVariance',
  'hitSound',
  'submunitions',
  'homingTurnRate',
  'smokeTrail',
  'shape',
  'cylinderShape',
] as const;

const LINE_EXPLICIT_FIELDS = ['hitSound'] as const;

export const SHOT_BLUEPRINTS = resolveBlueprintRefs(
  rawShotBlueprints,
) as unknown as Record<ShotId, ShotBlueprint>;

export function getShotBlueprint(id: string): ShotBlueprint {
  if (!isShotId(id)) throw new Error(`Unknown projectile blueprint: ${id}`);
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
  } else {
    assertExplicitFields(`shot blueprint ${id}`, blueprint, LINE_EXPLICIT_FIELDS);
  }
}
