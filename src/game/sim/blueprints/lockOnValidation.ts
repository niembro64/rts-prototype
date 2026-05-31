import {
  TURRET_LOCK_ON_ENTITY_FAMILY_INCLUSIONS,
  TURRET_LOCK_ON_RELATIONSHIP_INCLUSIONS,
  type LockOnInclusionObject,
} from '../../../types/blueprints';
import { assertExplicitFields, isObject } from './jsonValidation';

const LOCK_ON_RELATIONSHIP_SET: ReadonlySet<string> = new Set(
  TURRET_LOCK_ON_RELATIONSHIP_INCLUSIONS,
);
const LOCK_ON_ENTITY_FAMILY_SET: ReadonlySet<string> = new Set(
  TURRET_LOCK_ON_ENTITY_FAMILY_INCLUSIONS,
);

export const LOCK_ON_INCLUSION_FIELDS = [
  'includeLockOnLevel0FriendsAndEnemies',
  'includeLockOnLevel0Entities',
  'includeLockOnLevel1Buildings',
  'includeLockOnLevel1Towers',
  'includeLockOnLevel1Units',
  'includeLockOnLevel1Turrets',
  'includeLockOnLevel1Locomotions',
  'includeLockOnLevel1Shots',
] as const;

export function assertNoInlineLockOnInclusionFields(
  label: string,
  value: unknown,
): void {
  if (!isObject(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  for (const field of LOCK_ON_INCLUSION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(
        `Invalid ${label}: lock-on inclusion field "${field}" belongs in inclusionLockOnConfig.json`,
      );
    }
  }
}

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

export function validateLockOnInclusionObject(
  label: string,
  value: LockOnInclusionObject,
): void {
  assertStringArray(
    label,
    'includeLockOnLevel0FriendsAndEnemies',
    value.includeLockOnLevel0FriendsAndEnemies,
  );
  assertEnumArray(
    label,
    'includeLockOnLevel0FriendsAndEnemies',
    value.includeLockOnLevel0FriendsAndEnemies,
    LOCK_ON_RELATIONSHIP_SET,
  );
  assertStringArray(
    label,
    'includeLockOnLevel0Entities',
    value.includeLockOnLevel0Entities,
  );
  assertEnumArray(
    label,
    'includeLockOnLevel0Entities',
    value.includeLockOnLevel0Entities,
    LOCK_ON_ENTITY_FAMILY_SET,
  );
  assertStringArray(label, 'includeLockOnLevel1Buildings', value.includeLockOnLevel1Buildings);
  assertStringArray(label, 'includeLockOnLevel1Towers', value.includeLockOnLevel1Towers);
  assertStringArray(label, 'includeLockOnLevel1Units', value.includeLockOnLevel1Units);
  assertStringArray(label, 'includeLockOnLevel1Turrets', value.includeLockOnLevel1Turrets);
  assertStringArray(
    label,
    'includeLockOnLevel1Locomotions',
    value.includeLockOnLevel1Locomotions,
  );
  assertStringArray(label, 'includeLockOnLevel1Shots', value.includeLockOnLevel1Shots);
}

export function validateLockOnInclusionConfigSection(
  sectionLabel: string,
  value: unknown,
): asserts value is Record<string, LockOnInclusionObject> {
  if (!isObject(value)) {
    throw new Error(`Invalid lock-on inclusion config: "${sectionLabel}" must be an object`);
  }
  for (const [id, inclusions] of Object.entries(value)) {
    const label = `lock-on inclusion config ${sectionLabel}.${id}`;
    assertExplicitFields(label, inclusions, LOCK_ON_INCLUSION_FIELDS);
    validateLockOnInclusionObject(label, inclusions as LockOnInclusionObject);
  }
}

export function cloneLockOnInclusionObject(
  value: LockOnInclusionObject,
): LockOnInclusionObject {
  return {
    includeLockOnLevel0FriendsAndEnemies: [
      ...value.includeLockOnLevel0FriendsAndEnemies,
    ],
    includeLockOnLevel0Entities: [...value.includeLockOnLevel0Entities],
    includeLockOnLevel1Buildings: [...value.includeLockOnLevel1Buildings],
    includeLockOnLevel1Towers: [...value.includeLockOnLevel1Towers],
    includeLockOnLevel1Units: [...value.includeLockOnLevel1Units],
    includeLockOnLevel1Turrets: [...value.includeLockOnLevel1Turrets],
    includeLockOnLevel1Locomotions: [...value.includeLockOnLevel1Locomotions],
    includeLockOnLevel1Shots: [...value.includeLockOnLevel1Shots],
  };
}
