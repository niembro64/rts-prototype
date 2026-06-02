import type { LockOnInclusionObject } from './types';
import rawLockOnInclusionConfig from './inclusionLockOnConfig.json';
import {
  cloneLockOnInclusionObject,
  normalizeLockOnTargetConfigSection,
} from './lockOnValidation';
import { assertExplicitFields, isObject } from './jsonValidation';

type AuthoredLockOnInclusionConfigSection = Record<string, unknown>;
type NormalizedLockOnInclusionConfigSection = Record<string, LockOnInclusionObject>;
type LockOnInclusionSectionName = 'units' | 'turrets' | 'towers';
export type SecondaryLockOnProfile = {
  mode: 'incomingThreatReflector';
  candidateRelationship: 'enemy_entities';
  candidateFamily: 'turrets';
  rankBy: 'threat_turret_sustained_dps';
  aim: 'bisect_threat_turret_origin_and_threat_host_origin';
  intent: string;
};
type LockOnInclusionConfig = {
  units: AuthoredLockOnInclusionConfigSection;
  turrets: AuthoredLockOnInclusionConfigSection;
  towers: AuthoredLockOnInclusionConfigSection;
  secondaryLockOnProfiles?: Record<string, SecondaryLockOnProfile>;
};

const LOCK_ON_INCLUSION_CONFIG =
  rawLockOnInclusionConfig as unknown as LockOnInclusionConfig;

const SECONDARY_LOCK_ON_PROFILE_FIELDS = [
  'mode',
  'candidateRelationship',
  'candidateFamily',
  'rankBy',
  'aim',
  'intent',
] as const;

function validateSecondaryLockOnProfile(
  id: string,
  value: unknown,
): asserts value is SecondaryLockOnProfile {
  const label = `secondary lock-on profile ${id}`;
  assertExplicitFields(label, value, SECONDARY_LOCK_ON_PROFILE_FIELDS);
  if (!isObject(value)) throw new Error(`Invalid ${label}: expected object`);
  if (value.mode !== 'incomingThreatReflector') {
    throw new Error(`Invalid ${label}: mode must be "incomingThreatReflector"`);
  }
  if (value.candidateRelationship !== 'enemy_entities') {
    throw new Error(`Invalid ${label}: candidateRelationship must be "enemy_entities"`);
  }
  if (value.candidateFamily !== 'turrets') {
    throw new Error(`Invalid ${label}: candidateFamily must be "turrets"`);
  }
  if (value.rankBy !== 'threat_turret_sustained_dps') {
    throw new Error(`Invalid ${label}: rankBy must be "threat_turret_sustained_dps"`);
  }
  if (value.aim !== 'bisect_threat_turret_origin_and_threat_host_origin') {
    throw new Error(
      `Invalid ${label}: aim must be "bisect_threat_turret_origin_and_threat_host_origin"`,
    );
  }
  if (typeof value.intent !== 'string' || value.intent.trim().length === 0) {
    throw new Error(`Invalid ${label}: intent must be non-empty text`);
  }
}

function validateSecondaryLockOnProfiles(
  value: unknown,
): asserts value is Record<string, SecondaryLockOnProfile> {
  if (!isObject(value)) {
    throw new Error('Invalid secondaryLockOnProfiles: expected object');
  }
  for (const [id, profile] of Object.entries(value)) {
    validateSecondaryLockOnProfile(id, profile);
  }
}

const NORMALIZED_LOCK_ON_INCLUSION_CONFIG: Record<
  LockOnInclusionSectionName,
  NormalizedLockOnInclusionConfigSection
> = {
  units: normalizeLockOnTargetConfigSection('units', LOCK_ON_INCLUSION_CONFIG.units),
  turrets: normalizeLockOnTargetConfigSection('turrets', LOCK_ON_INCLUSION_CONFIG.turrets),
  towers: normalizeLockOnTargetConfigSection('towers', LOCK_ON_INCLUSION_CONFIG.towers),
};
if (LOCK_ON_INCLUSION_CONFIG.secondaryLockOnProfiles !== undefined) {
  validateSecondaryLockOnProfiles(LOCK_ON_INCLUSION_CONFIG.secondaryLockOnProfiles);
}

function assertLockOnInclusionConfigIds(
  sectionName: LockOnInclusionSectionName,
  blueprintLabel: string,
  expectedIds: readonly string[],
): void {
  const section = NORMALIZED_LOCK_ON_INCLUSION_CONFIG[sectionName];
  const expected = new Set(expectedIds);
  for (const id of expectedIds) {
    if (!Object.prototype.hasOwnProperty.call(section, id)) {
      throw new Error(
        `Missing lock-on inclusion config for ${blueprintLabel} "${id}" in inclusionLockOnConfig.json:${sectionName}`,
      );
    }
  }
  for (const id of Object.keys(section)) {
    if (!expected.has(id)) {
      throw new Error(
        `Stale lock-on inclusion config for ${blueprintLabel} "${id}" in inclusionLockOnConfig.json:${sectionName}`,
      );
    }
  }
  if (sectionName === 'turrets') {
    const profiles = LOCK_ON_INCLUSION_CONFIG.secondaryLockOnProfiles ?? {};
    for (const id of Object.keys(profiles)) {
      if (!expected.has(id)) {
        throw new Error(
          `Stale secondary lock-on profile for ${blueprintLabel} "${id}" in inclusionLockOnConfig.json:secondaryLockOnProfiles`,
        );
      }
    }
  }
}

function getLockOnInclusions(
  sectionName: LockOnInclusionSectionName,
  blueprintLabel: string,
  id: string,
): LockOnInclusionObject {
  const inclusions = NORMALIZED_LOCK_ON_INCLUSION_CONFIG[sectionName][id];
  if (inclusions === undefined) {
    throw new Error(
      `Missing lock-on inclusion config for ${blueprintLabel} "${id}" in inclusionLockOnConfig.json:${sectionName}`,
    );
  }
  return cloneLockOnInclusionObject(inclusions);
}

export function assertUnitLockOnInclusionConfigIds(expectedIds: readonly string[]): void {
  assertLockOnInclusionConfigIds('units', 'unit blueprint', expectedIds);
}

export function assertTurretLockOnInclusionConfigIds(expectedIds: readonly string[]): void {
  assertLockOnInclusionConfigIds('turrets', 'turret blueprint', expectedIds);
}

export function assertTowerLockOnInclusionConfigIds(expectedIds: readonly string[]): void {
  assertLockOnInclusionConfigIds('towers', 'tower blueprint', expectedIds);
}

export function getUnitLockOnInclusions(id: string): LockOnInclusionObject {
  return getLockOnInclusions('units', 'unit blueprint', id);
}

export function getTurretLockOnInclusions(id: string): LockOnInclusionObject {
  return getLockOnInclusions('turrets', 'turret blueprint', id);
}

export function getTowerLockOnInclusions(id: string): LockOnInclusionObject {
  return getLockOnInclusions('towers', 'tower blueprint', id);
}

export function getSecondaryLockOnProfile(id: string): SecondaryLockOnProfile | undefined {
  return LOCK_ON_INCLUSION_CONFIG.secondaryLockOnProfiles?.[id];
}
