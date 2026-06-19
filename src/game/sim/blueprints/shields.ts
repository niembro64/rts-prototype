/**
 * Shield blueprints.
 *
 * Shields are sustained barrier emissions. They are projected by a
 * turret and attributed through that turret instead of becoming their
 * own runtime body.
 */

import {
  isShieldMaterialId,
  type ShieldBlueprintId,
} from '../../../types/blueprintIds';
import {
  SHIELD_REFLECTION_ENTITIES,
  isShieldReflectionDirection,
} from '../../../types/shotTypes';
import rawShieldBlueprints from './shields.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields, isObject } from './jsonValidation';
import type { ShieldBlueprint } from './types';

const SHIELD_SURFACE_RENDER_MODES = [
  'finite-mesh',
  'screen-space-analytic-shader',
] as const;
export type ShieldSurfaceRenderMode = typeof SHIELD_SURFACE_RENDER_MODES[number];

const SHIELD_EXPLICIT_FIELDS = [
  'materialId',
  'angle',
  'transitionTime',
  'reflection',
  'barrier',
  'hitSound',
] as const;

function readShieldSurfaceRenderMode(raw: unknown): ShieldSurfaceRenderMode {
  if (!isObject(raw) || !isObject(raw.$config)) {
    throw new Error('shields.json must define $config.shieldSurfaceRenderMode');
  }
  const mode = raw.$config.shieldSurfaceRenderMode;
  if (
    mode === 'finite-mesh' ||
    mode === 'screen-space-analytic-shader'
  ) {
    return mode;
  }
  throw new Error(
    'Invalid shields.json $config.shieldSurfaceRenderMode: expected "finite-mesh" or "screen-space-analytic-shader"',
  );
}

function readShieldBlueprintEntries(raw: unknown): Record<string, unknown> {
  if (!isObject(raw)) throw new Error('shields.json must contain a top-level object');
  const entries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$config') continue;
    if (key.startsWith('$')) {
      throw new Error(`Invalid shields.json reserved key: ${key}`);
    }
    entries[key] = value;
  }
  return entries;
}

export const SHIELD_SURFACE_RENDER_MODE = readShieldSurfaceRenderMode(rawShieldBlueprints);

export const SHIELD_BLUEPRINTS = resolveBlueprintRefs(
  readShieldBlueprintEntries(rawShieldBlueprints),
) as unknown as Record<ShieldBlueprintId, ShieldBlueprint>;


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
  if (Object.prototype.hasOwnProperty.call(blueprint, 'submunitions')) {
    throw new Error(
      `Invalid shield blueprint ${id}: submunitions belong on turret blueprints`,
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
  if (!isObject(blueprint.reflection)) {
    throw new Error(`Shield blueprint ${id} must define reflection`);
  }
  if (!isObject(blueprint.reflection.entities)) {
    throw new Error(`Shield blueprint ${id} must define reflection.entities`);
  }
  for (const [entity, direction] of Object.entries(blueprint.reflection.entities)) {
    if (!SHIELD_REFLECTION_ENTITIES.includes(entity as typeof SHIELD_REFLECTION_ENTITIES[number])) {
      throw new Error(
        `Shield blueprint ${id} has invalid reflection entity: ${entity}`,
      );
    }
    if (!isShieldReflectionDirection(direction)) {
      throw new Error(
        `Shield blueprint ${id} has invalid reflection direction for ${entity}: ${String(direction)}`,
      );
    }
  }
}
