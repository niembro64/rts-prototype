import type { LockOnInclusionObject } from './types';
import rawLockOnInclusionConfig from './inclusionLockOnConfig.json';
import {
  cloneLockOnInclusionObject,
  validateLockOnInclusionConfigSection,
} from './lockOnValidation';

type LockOnInclusionConfigSection = Record<string, LockOnInclusionObject>;
type LockOnInclusionConfig = {
  units: LockOnInclusionConfigSection;
  turrets: LockOnInclusionConfigSection;
  towers: LockOnInclusionConfigSection;
};

const LOCK_ON_INCLUSION_CONFIG =
  rawLockOnInclusionConfig as unknown as LockOnInclusionConfig;

validateLockOnInclusionConfigSection('units', LOCK_ON_INCLUSION_CONFIG.units);
validateLockOnInclusionConfigSection('turrets', LOCK_ON_INCLUSION_CONFIG.turrets);
validateLockOnInclusionConfigSection('towers', LOCK_ON_INCLUSION_CONFIG.towers);

function assertLockOnInclusionConfigIds(
  sectionName: keyof LockOnInclusionConfig,
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
}

function getLockOnInclusions(
  sectionName: keyof LockOnInclusionConfig,
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
