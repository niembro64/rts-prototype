/**
 * Ray blueprints.
 *
 * Rays are sustained line emissions. They are not bodies, do not carry
 * base ledger data, and are authored separately from travelling shots.
 */

import { isRayBlueprintId, type RayBlueprintId } from '../../../types/blueprintIds';
import {
  isBeamSoundHarmonicIndex,
  beamSoundFrequencyFromHarmonicIndex,
} from '../../../audioConfig';
import rawRayBlueprints from './rays.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields, isObject } from './jsonValidation';
import type { RayBlueprint } from './types';

const RAY_EXPLICIT_FIELDS = ['hitSound', 'gravityForceMultiplier'] as const;
const BEAM_CONTINUOUS_SOUND_EXPLICIT_FIELDS = ['harmonicSeriesIndex'] as const;

function validateBeamContinuousSound(label: string, value: unknown): void {
  assertExplicitFields(label, value, BEAM_CONTINUOUS_SOUND_EXPLICIT_FIELDS);
  if (!isObject(value)) throw new Error(`Invalid ${label}: expected object`);
  const index = value.harmonicSeriesIndex;
  if (typeof index !== 'number' || !isBeamSoundHarmonicIndex(index)) {
    throw new Error(
      `Invalid ${label}.harmonicSeriesIndex: expected integer harmonic-series index, got ${index}`,
    );
  }
  const frequency = beamSoundFrequencyFromHarmonicIndex(index);
  if (!Number.isFinite(frequency) || frequency <= 0) {
    throw new Error(
      `Invalid ${label}.harmonicSeriesIndex: resolved non-positive frequency ${frequency}`,
    );
  }
}

export const RAY_BLUEPRINTS = resolveBlueprintRefs(
  rawRayBlueprints,
) as unknown as Record<RayBlueprintId, RayBlueprint>;

export function getRayBlueprint(id: string): RayBlueprint {
  if (!isRayBlueprintId(id)) throw new Error(`Unknown ray blueprint: ${id}`);
  return RAY_BLUEPRINTS[id];
}

for (const [id, blueprint] of Object.entries(RAY_BLUEPRINTS)) {
  if (blueprint.rayBlueprintId !== id) {
    throw new Error(
      `Ray blueprint key/id mismatch: ${id} contains ${blueprint.rayBlueprintId}`,
    );
  }
  if ('base' in blueprint) {
    throw new Error(
      `Invalid ray blueprint ${id}: rays are not entities and must not carry base`,
    );
  }
  assertExplicitFields(`ray blueprint ${id}`, blueprint, RAY_EXPLICIT_FIELDS);
  if (blueprint.type === 'beam') {
    validateBeamContinuousSound(
      `ray blueprint ${id}.continuousSound`,
      blueprint.continuousSound,
    );
  } else if ('continuousSound' in blueprint) {
    throw new Error(
      `Invalid ray blueprint ${id}: continuousSound is only valid for beam rays.`,
    );
  }
  if (blueprint.gravityForceMultiplier !== 0) {
    throw new Error(
      `Ray blueprint ${id} has invalid gravityForceMultiplier: rays must use 0 because they are not ballistic projectile bodies.`,
    );
  }
}
