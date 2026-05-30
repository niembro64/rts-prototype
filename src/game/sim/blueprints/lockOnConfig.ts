import type { LockOnExclusionObject } from './types';
import rawLockOnExclusionConfig from './exclusionLockOnConfig.json';
import {
  cloneLockOnExclusionObject,
  validateLockOnExclusionConfigSection,
} from './lockOnValidation';

type LockOnExclusionConfigSection = Record<string, LockOnExclusionObject>;
type LockOnExclusionConfig = {
  units: LockOnExclusionConfigSection;
  turrets: LockOnExclusionConfigSection;
  towers: LockOnExclusionConfigSection;
};

const LOCK_ON_EXCLUSION_CONFIG =
  rawLockOnExclusionConfig as unknown as LockOnExclusionConfig;

validateLockOnExclusionConfigSection('units', LOCK_ON_EXCLUSION_CONFIG.units);
validateLockOnExclusionConfigSection('turrets', LOCK_ON_EXCLUSION_CONFIG.turrets);
validateLockOnExclusionConfigSection('towers', LOCK_ON_EXCLUSION_CONFIG.towers);

function assertLockOnExclusionConfigIds(
  sectionName: keyof LockOnExclusionConfig,
  blueprintLabel: string,
  expectedIds: readonly string[],
): void {
  const section = LOCK_ON_EXCLUSION_CONFIG[sectionName];
  const expected = new Set(expectedIds);
  for (const id of expectedIds) {
    if (!Object.prototype.hasOwnProperty.call(section, id)) {
      throw new Error(
        `Missing lock-on exclusion config for ${blueprintLabel} "${id}" in exclusionLockOnConfig.json:${sectionName}`,
      );
    }
  }
  for (const id of Object.keys(section)) {
    if (!expected.has(id)) {
      throw new Error(
        `Stale lock-on exclusion config for ${blueprintLabel} "${id}" in exclusionLockOnConfig.json:${sectionName}`,
      );
    }
  }
}

function getLockOnExclusions(
  sectionName: keyof LockOnExclusionConfig,
  blueprintLabel: string,
  id: string,
): LockOnExclusionObject {
  const exclusions = LOCK_ON_EXCLUSION_CONFIG[sectionName][id];
  if (exclusions === undefined) {
    throw new Error(
      `Missing lock-on exclusion config for ${blueprintLabel} "${id}" in exclusionLockOnConfig.json:${sectionName}`,
    );
  }
  return cloneLockOnExclusionObject(exclusions);
}

export function assertUnitLockOnExclusionConfigIds(expectedIds: readonly string[]): void {
  assertLockOnExclusionConfigIds('units', 'unit blueprint', expectedIds);
}

export function assertTurretLockOnExclusionConfigIds(expectedIds: readonly string[]): void {
  assertLockOnExclusionConfigIds('turrets', 'turret blueprint', expectedIds);
}

export function assertTowerLockOnExclusionConfigIds(expectedIds: readonly string[]): void {
  assertLockOnExclusionConfigIds('towers', 'tower blueprint', expectedIds);
}

export function getUnitLockOnExclusions(id: string): LockOnExclusionObject {
  return getLockOnExclusions('units', 'unit blueprint', id);
}

export function getTurretLockOnExclusions(id: string): LockOnExclusionObject {
  return getLockOnExclusions('turrets', 'turret blueprint', id);
}

export function getTowerLockOnExclusions(id: string): LockOnExclusionObject {
  return getLockOnExclusions('towers', 'tower blueprint', id);
}
