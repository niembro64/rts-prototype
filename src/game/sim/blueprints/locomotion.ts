/**
 * Locomotion blueprints.
 *
 * Authored locomotion data lives in locomotion.json. Runtime systems
 * still consume the existing TypeScript export while Rust/WASM gains a
 * direct data file to load.
 */

import rawLocomotionBlueprints from './locomotion.json';
import { assertExplicitFields } from './jsonValidation';
import type { LocomotionBlueprint } from './types';

export const UNIT_LOCOMOTION_BLUEPRINTS =
  rawLocomotionBlueprints as Record<string, LocomotionBlueprint>;

for (const [id, blueprint] of Object.entries(UNIT_LOCOMOTION_BLUEPRINTS)) {
  if (!blueprint || typeof blueprint.type !== 'string') {
    throw new Error(`Invalid locomotion blueprint ${id}: missing type`);
  }
  if (
    !blueprint.physics ||
    !Number.isFinite(blueprint.physics.driveForce) ||
    blueprint.physics.driveForce <= 0
  ) {
    throw new Error(`Invalid locomotion blueprint ${id}: driveForce must be positive`);
  }
  assertExplicitFields(
    `locomotion blueprint ${id}.physics`,
    blueprint.physics,
    ['jump'],
  );
}
