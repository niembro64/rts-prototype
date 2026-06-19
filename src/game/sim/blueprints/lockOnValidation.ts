import {
  TURRET_LOCK_ON_ENTITY_FAMILY_INCLUSIONS,
  TURRET_LOCK_ON_RELATIONSHIP_INCLUSIONS,
  type LockOnRequiresTargetLockedOntoSelf,
  type LockOnInclusionObject,
  type TurretLockOnRelationshipInclusion,
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
  'includeLockOnLevel1Shots',
  'lockOnRequiresTargetLockedOntoSelf',
] as const;

const LOCK_ON_RECIPROCAL_MODES = [
  'ignore',
  'require',
  'preferReacquire',
  'preferHold',
] as const;
const LOCK_ON_RECIPROCAL_MODE_SET: ReadonlySet<string> = new Set(
  LOCK_ON_RECIPROCAL_MODES,
);
const LOCK_ON_TARGET_POLICY_REQUIRED_FIELDS = ['targets'] as const;
const LOCK_ON_TARGET_POLICY_FIELDS = [
  'targets',
  'lockOnRequiresTargetLockedOntoSelf',
] as const;
const LOCK_ON_TARGET_RELATIONSHIP_FIELDS = ['friendly', 'enemy'] as const;
const LOCK_ON_TARGET_FAMILY_FIELDS = [
  'buildings',
  'towers',
  'units',
  'turrets',
  'shots',
] as const;

type LockOnTargetRelationship = (typeof LOCK_ON_TARGET_RELATIONSHIP_FIELDS)[number];
type LockOnTargetFamily = (typeof LOCK_ON_TARGET_FAMILY_FIELDS)[number];
type LockOnTargetFamilyPolicy =
  | 'all'
  | {
      only: string[];
    };
type LockOnTargetRelationshipPolicy = Partial<
  Record<LockOnTargetFamily, LockOnTargetFamilyPolicy>
>;
type LockOnTargetPolicyObject = {
  targets: 'none' | Partial<Record<LockOnTargetRelationship, LockOnTargetRelationshipPolicy>>;
  lockOnRequiresTargetLockedOntoSelf?: LockOnRequiresTargetLockedOntoSelf;
};

const LOCK_ON_TARGET_RELATIONSHIP_SET: ReadonlySet<string> = new Set(
  LOCK_ON_TARGET_RELATIONSHIP_FIELDS,
);
const LOCK_ON_TARGET_FAMILY_SET: ReadonlySet<string> = new Set(
  LOCK_ON_TARGET_FAMILY_FIELDS,
);

const TARGET_RELATIONSHIP_TO_INCLUSION: Record<
  LockOnTargetRelationship,
  TurretLockOnRelationshipInclusion
> = {
  friendly: 'friendly_entities',
  enemy: 'enemy_entities',
};

const TARGET_FAMILY_TO_LEVEL1_FIELD: Record<
  LockOnTargetFamily,
  keyof Pick<
    LockOnInclusionObject,
    | 'includeLockOnLevel1Buildings'
    | 'includeLockOnLevel1Towers'
    | 'includeLockOnLevel1Units'
    | 'includeLockOnLevel1Turrets'
    | 'includeLockOnLevel1Shots'
  >
> = {
  buildings: 'includeLockOnLevel1Buildings',
  towers: 'includeLockOnLevel1Towers',
  units: 'includeLockOnLevel1Units',
  turrets: 'includeLockOnLevel1Turrets',
  shots: 'includeLockOnLevel1Shots',
};

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
  if (Object.prototype.hasOwnProperty.call(value, 'targets')) {
    throw new Error(
      `Invalid ${label}: lock-on target policy "targets" belongs in inclusionLockOnConfig.json`,
    );
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

function assertKnownFields(
  label: string,
  value: unknown,
  allowedFields: ReadonlySet<string>,
): void {
  if (!isObject(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new Error(
        `Invalid ${label}: unknown field "${field}" is not one of [${[...allowedFields].join(', ')}]`,
      );
    }
  }
}

function copyNonEmptyStringArray(
  label: string,
  field: string,
  value: unknown,
): string[] {
  assertStringArray(label, field, value);
  if (value.length === 0) {
    throw new Error(
      `Invalid ${label}: ${field} must not be empty; use "all" for every target in the family or omit the family to target none`,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    if (seen.has(value[i])) {
      throw new Error(
        `Invalid ${label}: ${field}[${i}] = "${value[i]}" is a duplicate`,
      );
    }
    seen.add(value[i]);
  }
  return [...value];
}

function normalizeTargetFamilyPolicy(
  label: string,
  family: LockOnTargetFamily,
  value: unknown,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'all') {
    return [];
  }
  if (isObject(value)) {
    const fields = ['only'] as const;
    assertExplicitFields(label, value, fields);
    assertKnownFields(label, value, new Set(fields));
    return copyNonEmptyStringArray(label, `${family}.only`, value.only);
  }
  throw new Error(
    `Invalid ${label}: ${family} must be "all" or { "only": [...] }; omit the family to target none`,
  );
}

function sameStringSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  for (const value of a) {
    if (!bSet.has(value)) return false;
  }
  return true;
}

function normalizeTargetRelationshipPolicy(
  label: string,
  value: unknown,
): Partial<Record<LockOnTargetFamily, string[]>> {
  assertKnownFields(label, value, LOCK_ON_TARGET_FAMILY_SET);
  const policy = value as LockOnTargetRelationshipPolicy;
  const normalized: Partial<Record<LockOnTargetFamily, string[]>> = {};
  for (const family of LOCK_ON_TARGET_FAMILY_FIELDS) {
    const familyPolicy = normalizeTargetFamilyPolicy(
      `${label}.${family}`,
      family,
      policy[family],
    );
    if (familyPolicy !== undefined) normalized[family] = familyPolicy;
  }
  return normalized;
}

function normalizeReciprocalMode(
  label: string,
  value: unknown,
): LockOnRequiresTargetLockedOntoSelf {
  if (value === undefined) return 'ignore';
  if (typeof value !== 'string' || !LOCK_ON_RECIPROCAL_MODE_SET.has(value)) {
    throw new Error(
      `Invalid ${label}: lockOnRequiresTargetLockedOntoSelf must be one of [${LOCK_ON_RECIPROCAL_MODES.join(', ')}]`,
    );
  }
  return value as LockOnRequiresTargetLockedOntoSelf;
}

function assertRelationshipPoliciesCanCompile(
  label: string,
  relationships: readonly LockOnTargetRelationship[],
  policies: Record<LockOnTargetRelationship, Partial<Record<LockOnTargetFamily, string[]>>>,
): void {
  if (relationships.length <= 1) return;
  const baselineRelationship = relationships[0];
  const baseline = policies[baselineRelationship];
  for (let i = 1; i < relationships.length; i++) {
    const relationship = relationships[i];
    const candidate = policies[relationship];
    for (const family of LOCK_ON_TARGET_FAMILY_FIELDS) {
      if (!sameStringSet(baseline[family], candidate[family])) {
        throw new Error(
          `Invalid ${label}: targets.${baselineRelationship}.${family} and targets.${relationship}.${family} differ, but runtime lock-on masks combine relationships and families independently. Use the same family rules for each relationship or split this into separate weapon profiles.`,
        );
      }
    }
  }
}

function normalizeLockOnTargetPolicy(
  label: string,
  value: unknown,
): LockOnInclusionObject {
  assertExplicitFields(label, value, LOCK_ON_TARGET_POLICY_REQUIRED_FIELDS);
  assertKnownFields(label, value, new Set(LOCK_ON_TARGET_POLICY_FIELDS));
  const targetPolicy = value as LockOnTargetPolicyObject;
  const reciprocalMode = normalizeReciprocalMode(
    label,
    targetPolicy.lockOnRequiresTargetLockedOntoSelf,
  );
  if (targetPolicy.targets === 'none') {
    if (reciprocalMode !== 'ignore') {
      throw new Error(
        `Invalid ${label}: lockOnRequiresTargetLockedOntoSelf "${reciprocalMode}" requires targetable enemy entities`,
      );
    }
    return {
      includeLockOnLevel0FriendsAndEnemies: [],
      includeLockOnLevel0Entities: [],
      includeLockOnLevel1Buildings: [],
      includeLockOnLevel1Towers: [],
      includeLockOnLevel1Units: [],
      includeLockOnLevel1Turrets: [],
      includeLockOnLevel1Shots: [],
      lockOnRequiresTargetLockedOntoSelf: 'ignore',
    };
  }
  assertKnownFields(`${label}.targets`, targetPolicy.targets, LOCK_ON_TARGET_RELATIONSHIP_SET);

  const relationshipPolicies: Record<
    LockOnTargetRelationship,
    Partial<Record<LockOnTargetFamily, string[]>>
  > = {
    friendly: {},
    enemy: {},
  };
  const enabledRelationships: LockOnTargetRelationship[] = [];
  for (const relationship of LOCK_ON_TARGET_RELATIONSHIP_FIELDS) {
    const relationshipPolicy = targetPolicy.targets[relationship];
    if (relationshipPolicy === undefined) continue;
    const normalizedRelationshipPolicy = normalizeTargetRelationshipPolicy(
      `${label}.targets.${relationship}`,
      relationshipPolicy,
    );
    const enabledFamilyCount = Object.keys(normalizedRelationshipPolicy).length;
    if (enabledFamilyCount === 0) {
      throw new Error(
        `Invalid ${label}.targets.${relationship}: expected at least one target family`,
      );
    }
    relationshipPolicies[relationship] = normalizedRelationshipPolicy;
    enabledRelationships.push(relationship);
  }

  if (enabledRelationships.length === 0) {
    throw new Error(`Invalid ${label}.targets: expected at least one relationship`);
  }
  if (reciprocalMode !== 'ignore' && !enabledRelationships.includes('enemy')) {
    throw new Error(
      `Invalid ${label}: lockOnRequiresTargetLockedOntoSelf "${reciprocalMode}" requires targets.enemy because reciprocal lock-on only applies to enemy_entities`,
    );
  }
  assertRelationshipPoliciesCanCompile(label, enabledRelationships, relationshipPolicies);

  const baseline = relationshipPolicies[enabledRelationships[0]];
  const includeLockOnLevel0FriendsAndEnemies: LockOnInclusionObject['includeLockOnLevel0FriendsAndEnemies'] = [];
  for (let i = 0; i < enabledRelationships.length; i++) {
    includeLockOnLevel0FriendsAndEnemies.push(
      TARGET_RELATIONSHIP_TO_INCLUSION[enabledRelationships[i]],
    );
  }
  const normalized: LockOnInclusionObject = {
    includeLockOnLevel0FriendsAndEnemies,
    includeLockOnLevel0Entities: [],
    includeLockOnLevel1Buildings: [],
    includeLockOnLevel1Towers: [],
    includeLockOnLevel1Units: [],
    includeLockOnLevel1Turrets: [],
    includeLockOnLevel1Shots: [],
    lockOnRequiresTargetLockedOntoSelf: reciprocalMode,
  };
  for (const family of LOCK_ON_TARGET_FAMILY_FIELDS) {
    const familyPolicy = baseline[family];
    if (familyPolicy === undefined) continue;
    normalized.includeLockOnLevel0Entities.push(family);
    normalized[TARGET_FAMILY_TO_LEVEL1_FIELD[family]] = [...familyPolicy];
  }

  validateLockOnInclusionObject(label, normalized);
  return normalized;
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
  assertStringArray(label, 'includeLockOnLevel1Shots', value.includeLockOnLevel1Shots);
  normalizeReciprocalMode(label, value.lockOnRequiresTargetLockedOntoSelf);
}

export function normalizeLockOnTargetConfigSection(
  sectionLabel: string,
  value: unknown,
): Record<string, LockOnInclusionObject> {
  if (!isObject(value)) {
    throw new Error(`Invalid lock-on inclusion config: "${sectionLabel}" must be an object`);
  }
  const normalized: Record<string, LockOnInclusionObject> = {};
  for (const [id, policy] of Object.entries(value)) {
    const label = `lock-on inclusion config ${sectionLabel}.${id}`;
    normalized[id] = normalizeLockOnTargetPolicy(label, policy);
  }
  return normalized;
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
    includeLockOnLevel1Shots: [...value.includeLockOnLevel1Shots],
    lockOnRequiresTargetLockedOntoSelf: value.lockOnRequiresTargetLockedOntoSelf,
  };
}
