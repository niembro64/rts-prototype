/**
 * Turret blueprints.
 *
 * Authored data lives in turrets.json. This module keeps the existing
 * TypeScript API as a thin resolver/validator while the data becomes
 * language-neutral for the Rust/WASM port.
 */

import { isTurretId, type TurretId } from '../../../types/blueprintIds';
import {
  TURRET_LOCK_ON_ENTITY_FAMILY_EXCLUSIONS,
  TURRET_LOCK_ON_RELATIONSHIP_EXCLUSIONS,
} from '../../../types/blueprints';
import rawTurretBlueprints from './turrets.json';
import { resolveBlueprintRefs } from './jsonRefs';
import { assertExplicitFields } from './jsonValidation';
import type { TurretBlueprint } from './types';

const TURRET_EXPLICIT_FIELDS = [
  'projectileId',
  'cooldown',
  'launchForce',
  'isManualFire',
  'passive',
  'requiresNonObstructedLineOfSight',
  'spread',
  'burst',
  'forceField',
  'mirrorPanels',
  'audio',
  'verticalLauncher',
  'idlePitch',
  'groundAimFraction',
  'headOnly',
  'constructionEmitter',
  'excludeLockOnLevel0FriendsAndEnemies',
  'excludeLockOnLevel0Entities',
  'excludeLockOnLevel1Buildings',
  'excludeLockOnLevel1Units',
  'excludeLockOnLevel1Turrets',
] as const;

const TURRET_LOCK_ON_RELATIONSHIP_SET: ReadonlySet<string> = new Set(
  TURRET_LOCK_ON_RELATIONSHIP_EXCLUSIONS,
);
const TURRET_LOCK_ON_ENTITY_FAMILY_SET: ReadonlySet<string> = new Set(
  TURRET_LOCK_ON_ENTITY_FAMILY_EXCLUSIONS,
);

function assertStringArray(
  label: string,
  field: string,
  value: unknown,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${label}: ${field} must be an array`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      throw new Error(
        `Invalid ${label}: ${field}[${i}] must be a string, got ${typeof value[i]}`,
      );
    }
  }
}

function assertEnumArray(
  label: string,
  field: string,
  value: string[],
  allowed: ReadonlySet<string>,
): void {
  for (let i = 0; i < value.length; i++) {
    if (!allowed.has(value[i])) {
      throw new Error(
        `Invalid ${label}: ${field}[${i}] = "${value[i]}" is not one of [${[...allowed].join(', ')}]`,
      );
    }
  }
}

export const TURRET_BLUEPRINTS = resolveBlueprintRefs(
  rawTurretBlueprints,
) as unknown as Record<TurretId, TurretBlueprint>;

export const CONSTRUCTION_TURRET_HEAD_RADIUS =
  TURRET_BLUEPRINTS.constructionTurret.radius.body;

export function getTurretBlueprint(id: string): TurretBlueprint {
  if (!isTurretId(id)) throw new Error(`Unknown weapon blueprint: ${id}`);
  const turretBlueprint = TURRET_BLUEPRINTS[id];
  return turretBlueprint;
}

for (const [id, blueprint] of Object.entries(TURRET_BLUEPRINTS)) {
  if (blueprint.id !== id) {
    throw new Error(
      `Turret blueprint key/id mismatch: ${id} contains ${blueprint.id}`,
    );
  }
  assertExplicitFields(`turret blueprint ${id}`, blueprint, TURRET_EXPLICIT_FIELDS);

  const label = `turret blueprint ${id}`;
  assertStringArray(
    label,
    'excludeLockOnLevel0FriendsAndEnemies',
    blueprint.excludeLockOnLevel0FriendsAndEnemies,
  );
  assertEnumArray(
    label,
    'excludeLockOnLevel0FriendsAndEnemies',
    blueprint.excludeLockOnLevel0FriendsAndEnemies,
    TURRET_LOCK_ON_RELATIONSHIP_SET,
  );
  assertStringArray(
    label,
    'excludeLockOnLevel0Entities',
    blueprint.excludeLockOnLevel0Entities,
  );
  assertEnumArray(
    label,
    'excludeLockOnLevel0Entities',
    blueprint.excludeLockOnLevel0Entities,
    TURRET_LOCK_ON_ENTITY_FAMILY_SET,
  );
  assertStringArray(label, 'excludeLockOnLevel1Buildings', blueprint.excludeLockOnLevel1Buildings);
  assertStringArray(label, 'excludeLockOnLevel1Units', blueprint.excludeLockOnLevel1Units);
  assertStringArray(label, 'excludeLockOnLevel1Turrets', blueprint.excludeLockOnLevel1Turrets);
}
