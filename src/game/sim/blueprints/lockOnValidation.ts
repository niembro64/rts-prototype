import {
  TURRET_LOCK_ON_ENTITY_FAMILY_EXCLUSIONS,
  TURRET_LOCK_ON_RELATIONSHIP_EXCLUSIONS,
  type LockOnExclusionObject,
} from '../../../types/blueprints';

const LOCK_ON_RELATIONSHIP_SET: ReadonlySet<string> = new Set(
  TURRET_LOCK_ON_RELATIONSHIP_EXCLUSIONS,
);
const LOCK_ON_ENTITY_FAMILY_SET: ReadonlySet<string> = new Set(
  TURRET_LOCK_ON_ENTITY_FAMILY_EXCLUSIONS,
);

export const LOCK_ON_EXCLUSION_FIELDS = [
  'excludeLockOnLevel0FriendsAndEnemies',
  'excludeLockOnLevel0Entities',
  'excludeLockOnLevel1Buildings',
  'excludeLockOnLevel1Towers',
  'excludeLockOnLevel1Units',
  'excludeLockOnLevel1Turrets',
] as const;

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

export function validateLockOnExclusionObject(
  label: string,
  value: LockOnExclusionObject,
): void {
  assertStringArray(
    label,
    'excludeLockOnLevel0FriendsAndEnemies',
    value.excludeLockOnLevel0FriendsAndEnemies,
  );
  assertEnumArray(
    label,
    'excludeLockOnLevel0FriendsAndEnemies',
    value.excludeLockOnLevel0FriendsAndEnemies,
    LOCK_ON_RELATIONSHIP_SET,
  );
  assertStringArray(
    label,
    'excludeLockOnLevel0Entities',
    value.excludeLockOnLevel0Entities,
  );
  assertEnumArray(
    label,
    'excludeLockOnLevel0Entities',
    value.excludeLockOnLevel0Entities,
    LOCK_ON_ENTITY_FAMILY_SET,
  );
  assertStringArray(label, 'excludeLockOnLevel1Buildings', value.excludeLockOnLevel1Buildings);
  assertStringArray(label, 'excludeLockOnLevel1Towers', value.excludeLockOnLevel1Towers);
  assertStringArray(label, 'excludeLockOnLevel1Units', value.excludeLockOnLevel1Units);
  assertStringArray(label, 'excludeLockOnLevel1Turrets', value.excludeLockOnLevel1Turrets);
}
