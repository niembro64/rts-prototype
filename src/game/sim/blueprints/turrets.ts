/**
 * Turret blueprints.
 *
 * Authored data lives in turrets.json. This module keeps the existing
 * TypeScript API as a thin resolver/validator while the data becomes
 * language-neutral for the Rust/WASM port.
 */

import { isTurretBlueprintId, type TurretBlueprintId } from '../../../types/blueprintIds';
import {
  WEAPON_KINDS,
} from '../../../types/blueprints';
import rawTurretBlueprints from './turrets.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields, isObject } from './jsonValidation';
import type { LockOnInclusionObject, TurretBlueprint } from './types';
import { assertNoInlineLockOnInclusionFields } from './lockOnValidation';
import {
  assertTurretLockOnInclusionConfigIds,
  getTurretLockOnInclusions,
} from './lockOnConfig';

const TURRET_EXPLICIT_FIELDS = [
  'name',
  'emissionKind',
  'emissionBlueprintId',
  'rangeVolume',
  'cooldown',
  'launchForce',
  'isManualFire',
  'passive',
  'requiresNonObstructedLineOfSight',
  'spread',
  'burst',
  'shieldPanels',
  'audio',
  'verticalLauncher',
  'idlePitch',
  'groundAimFraction',
  'headOnly',
  'constructionEmitter',
  'kind',
] as const;

const WEAPON_KIND_SET: ReadonlySet<string> = new Set(WEAPON_KINDS);

type JsonTurretBlueprint = Omit<TurretBlueprint, keyof LockOnInclusionObject>;

const TURRET_COOLDOWN_FIELDS = ['duration', 'durationRandomness'] as const;

function validateTurretCooldown(label: string, cooldown: unknown): void {
  if (cooldown === null) return;
  if (!isObject(cooldown)) {
    throw new Error(`Invalid ${label}.cooldown: expected object or null`);
  }

  assertExplicitFields(`${label}.cooldown`, cooldown, TURRET_COOLDOWN_FIELDS);
  for (const field of Object.keys(cooldown)) {
    if (!TURRET_COOLDOWN_FIELDS.includes(field as typeof TURRET_COOLDOWN_FIELDS[number])) {
      throw new Error(`Invalid ${label}.cooldown: unexpected field "${field}"`);
    }
  }

  const duration = cooldown.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      `Invalid ${label}.cooldown.duration: expected finite positive milliseconds, got ${duration}`,
    );
  }

  const durationRandomness = cooldown.durationRandomness;
  if (
    typeof durationRandomness !== 'number' ||
    !Number.isFinite(durationRandomness) ||
    durationRandomness < 0 ||
    durationRandomness >= 1
  ) {
    throw new Error(
      `Invalid ${label}.cooldown.durationRandomness: expected finite [0,1), got ${durationRandomness}`,
    );
  }
}

const RESOLVED_TURRET_BLUEPRINTS = resolveBlueprintRefs(
  rawTurretBlueprints,
) as unknown as Record<TurretBlueprintId, JsonTurretBlueprint>;

assertTurretLockOnInclusionConfigIds(Object.keys(RESOLVED_TURRET_BLUEPRINTS));

export const TURRET_BLUEPRINTS = Object.fromEntries(
  Object.entries(RESOLVED_TURRET_BLUEPRINTS).map(([id, blueprint]) => {
    assertNoInlineLockOnInclusionFields(`turret blueprint ${id}`, blueprint);
    return [
      id,
      {
        ...blueprint,
        ...getTurretLockOnInclusions(id),
      },
    ];
  }),
) as Record<TurretBlueprintId, TurretBlueprint>;

export const CONSTRUCTION_TURRET_HEAD_RADIUS =
  TURRET_BLUEPRINTS.turretConstruction.radius.visual;

export function getTurretBlueprint(id: string): TurretBlueprint {
  if (!isTurretBlueprintId(id)) throw new Error(`Unknown weapon blueprint: ${id}`);
  const turretBlueprint = TURRET_BLUEPRINTS[id];
  return turretBlueprint;
}

for (const [id, blueprint] of Object.entries(TURRET_BLUEPRINTS)) {
  if (blueprint.turretBlueprintId !== id) {
    throw new Error(
      `Turret blueprint key/id mismatch: ${id} contains ${blueprint.turretBlueprintId}`,
    );
  }
  assertExplicitFields(`turret blueprint ${id}`, blueprint, TURRET_EXPLICIT_FIELDS);
  if (Object.prototype.hasOwnProperty.call(blueprint, 'shield')) {
    throw new Error(
      `Invalid turret blueprint ${id}: shield emission data belongs in shields.json and must be referenced by emissionBlueprintId`,
    );
  }
  if (blueprint.shieldPanels.length > 0) {
    throw new Error(
      `Invalid turret blueprint ${id}: shield panel geometry belongs on the host mount, not the turret blueprint`,
    );
  }

  const label = `turret blueprint ${id}`;
  if (typeof blueprint.name !== 'string' || blueprint.name.trim().length === 0) {
    throw new Error(`Invalid ${label}: missing display name`);
  }
  if (!WEAPON_KIND_SET.has(blueprint.kind)) {
    throw new Error(
      `Invalid ${label}: kind "${blueprint.kind}" is not one of [${[...WEAPON_KIND_SET].join(', ')}]`,
    );
  }
  validateTurretCooldown(label, blueprint.cooldown);
}
