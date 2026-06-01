import type { LockOnInclusionObject } from './types';
import rawLockOnInclusionConfig from './inclusionLockOnConfig.json';
import {
  cloneLockOnInclusionObject,
  validateLockOnInclusionConfigSection,
} from './lockOnValidation';
import { assertExplicitFields, isObject } from './jsonValidation';

type LockOnInclusionConfigSection = Record<string, LockOnInclusionObject>;
type LockOnInclusionSectionName = 'units' | 'turrets' | 'towers';
export type SecondaryLockOnProfile = {
  mode: 'incomingThreatReflector';
  candidateRelationship: 'enemy_entities';
  candidateFamily: 'turrets';
  threatMustTarget: ['self_host', 'self_turret'];
  threatState: 'locked_or_engaged';
  rankBy: 'threat_turret_sustained_dps';
  aim: 'bisect_threat_turret_origin_and_threat_host_origin';
  intent: string;
};
type LockOnInclusionConfig = {
  units: LockOnInclusionConfigSection;
  turrets: LockOnInclusionConfigSection;
  towers: LockOnInclusionConfigSection;
  secondaryLockOnProfiles?: Record<string, SecondaryLockOnProfile>;
};

const LOCK_ON_INCLUSION_CONFIG =
  rawLockOnInclusionConfig as unknown as LockOnInclusionConfig;

const SECONDARY_LOCK_ON_PROFILE_FIELDS = [
  'mode',
  'candidateRelationship',
  'candidateFamily',
  'threatMustTarget',
  'threatState',
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
  if (
    !Array.isArray(value.threatMustTarget) ||
    value.threatMustTarget.length !== 2 ||
    value.threatMustTarget[0] !== 'self_host' ||
    value.threatMustTarget[1] !== 'self_turret'
  ) {
    throw new Error(
      `Invalid ${label}: threatMustTarget must be ["self_host", "self_turret"]`,
    );
  }
  if (value.threatState !== 'locked_or_engaged') {
    throw new Error(`Invalid ${label}: threatState must be "locked_or_engaged"`);
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

validateLockOnInclusionConfigSection('units', LOCK_ON_INCLUSION_CONFIG.units);
validateLockOnInclusionConfigSection('turrets', LOCK_ON_INCLUSION_CONFIG.turrets);
validateLockOnInclusionConfigSection('towers', LOCK_ON_INCLUSION_CONFIG.towers);
if (LOCK_ON_INCLUSION_CONFIG.secondaryLockOnProfiles !== undefined) {
  validateSecondaryLockOnProfiles(LOCK_ON_INCLUSION_CONFIG.secondaryLockOnProfiles);
}

function assertLockOnInclusionConfigIds(
  sectionName: LockOnInclusionSectionName,
  blueprintLabel: string,
  expectedIds: readonly string[],
): void {
  const section = LOCK_ON_INCLUSION_CONFIG[sectionName];
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
  const inclusions = LOCK_ON_INCLUSION_CONFIG[sectionName][id];
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
