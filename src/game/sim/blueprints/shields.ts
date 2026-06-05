/**
 * Shield blueprints.
 *
 * Shields are sustained barrier emissions. They are projected by a
 * turret and attributed through that turret instead of becoming their
 * own runtime body.
 */

import {
  isShotBlueprintId,
  isShieldBlueprintId,
  isShieldMaterialId,
  type ShieldBlueprintId,
} from '../../../types/blueprintIds';
import rawShieldBlueprints from './shields.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields, isObject } from './jsonValidation';
import type { ShieldBlueprint } from './types';

export const SHIELD_SURFACE_RENDER_MODES = [
  'finite-mesh',
  'screen-space-analytic-shader',
] as const;
export type ShieldSurfaceRenderMode = typeof SHIELD_SURFACE_RENDER_MODES[number];

const SHIELD_EXPLICIT_FIELDS = [
  'materialId',
  'angle',
  'transitionTime',
  'barrier',
  'submunitions',
  'hitSound',
] as const;

const SHIELD_SUBMUNITION_EXPLICIT_FIELDS = [
  'shotBlueprintId',
  'launchForce',
  'cooldown',
  'spread',
] as const;

const SHIELD_SUBMUNITION_COOLDOWN_FIELDS = [
  'duration',
  'durationRandomness',
] as const;

const SHIELD_SUBMUNITION_SPREAD_FIELDS = [
  'angle',
  'pelletCount',
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

function validateShieldSubmunitions(label: string, value: unknown): void {
  if (value === null) return;
  assertExplicitFields(label, value, SHIELD_SUBMUNITION_EXPLICIT_FIELDS);
  if (!isObject(value)) throw new Error(`Invalid ${label}: expected object or null`);
  if (typeof value.shotBlueprintId !== 'string' || !isShotBlueprintId(value.shotBlueprintId)) {
    throw new Error(
      `Invalid ${label}.shotBlueprintId: unknown shot blueprint ${String(value.shotBlueprintId)}`,
    );
  }
  if (
    typeof value.launchForce !== 'number' ||
    !Number.isFinite(value.launchForce) ||
    value.launchForce < 0
  ) {
    throw new Error(`Invalid ${label}.launchForce: expected finite non-negative number`);
  }
  const cooldown = value.cooldown;
  assertExplicitFields(`${label}.cooldown`, cooldown, SHIELD_SUBMUNITION_COOLDOWN_FIELDS);
  if (!isObject(cooldown)) throw new Error(`Invalid ${label}.cooldown: expected object`);
  if (
    typeof cooldown.duration !== 'number' ||
    !Number.isFinite(cooldown.duration) ||
    cooldown.duration <= 0
  ) {
    throw new Error(`Invalid ${label}.cooldown.duration: expected finite positive milliseconds`);
  }
  if (
    typeof cooldown.durationRandomness !== 'number' ||
    !Number.isFinite(cooldown.durationRandomness) ||
    cooldown.durationRandomness < 0 ||
    cooldown.durationRandomness >= 1
  ) {
    throw new Error(`Invalid ${label}.cooldown.durationRandomness: expected finite [0,1)`);
  }
  const spread = value.spread;
  assertExplicitFields(`${label}.spread`, spread, SHIELD_SUBMUNITION_SPREAD_FIELDS);
  if (!isObject(spread)) throw new Error(`Invalid ${label}.spread: expected object`);
  if (
    typeof spread.angle !== 'number' ||
    !Number.isFinite(spread.angle) ||
    spread.angle < 0
  ) {
    throw new Error(`Invalid ${label}.spread.angle: expected finite non-negative radians`);
  }
  if (
    typeof spread.pelletCount !== 'number' ||
    !Number.isInteger(spread.pelletCount) ||
    spread.pelletCount <= 0
  ) {
    throw new Error(`Invalid ${label}.spread.pelletCount: expected positive integer`);
  }
}

export const SHIELD_SURFACE_RENDER_MODE = readShieldSurfaceRenderMode(rawShieldBlueprints);

export const SHIELD_BLUEPRINTS = resolveBlueprintRefs(
  readShieldBlueprintEntries(rawShieldBlueprints),
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
  validateShieldSubmunitions(`shield blueprint ${id}.submunitions`, blueprint.submunitions);
}
