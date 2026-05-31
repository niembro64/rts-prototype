/**
 * Shield blueprints.
 *
 * Shields are sustained barrier emissions. They are projected by a
 * turret and attributed through that turret instead of becoming their
 * own runtime body.
 */

import {
  isShieldBlueprintId,
  isShieldMaterialId,
  type ShieldBlueprintId,
} from '../../../types/blueprintIds';
import rawShieldBlueprints from './shields.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';
import type { ShieldBlueprint } from './types';

const SHIELD_EXPLICIT_FIELDS = [
  'materialId',
  'angle',
  'transitionTime',
  'barrier',
  'hitSound',
] as const;

export const SHIELD_BLUEPRINTS = resolveBlueprintRefs(
  rawShieldBlueprints,
) as unknown as Record<ShieldBlueprintId, ShieldBlueprint>;

export function getShieldBlueprint(id: string): ShieldBlueprint {
  if (!isShieldBlueprintId(id)) throw new Error(`Unknown shield blueprint: ${id}`);
  return SHIELD_BLUEPRINTS[id];
}

for (const [id, blueprint] of Object.entries(SHIELD_BLUEPRINTS)) {
  if (blueprint.shieldBlueprintId !== id) {
    throw new Error(
      `Shield blueprint key/id mismatch: ${id} contains ${blueprint.shieldBlueprintId}`,
    );
  }
  if ('base' in blueprint) {
    throw new Error(
      `Invalid shield blueprint ${id}: shields are not entities and must not carry base`,
    );
  }
  assertExplicitFields(
    `shield blueprint ${id}`,
    blueprint,
    SHIELD_EXPLICIT_FIELDS,
  );
  if (!Number.isFinite(blueprint.transitionTime) || blueprint.transitionTime <= 0) {
    throw new Error(
      `Shield blueprint ${id} must define positive transitionTime`,
    );
  }
  if (!isShieldMaterialId(blueprint.materialId)) {
    throw new Error(
      `Shield blueprint ${id} references unknown shield material: ${blueprint.materialId}`,
    );
  }
}
