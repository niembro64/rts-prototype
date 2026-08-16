import {
  CONTROL_GROUP_COUNT,
  type AutoGroupRuleSnapshot,
} from './helpers';

const AUTO_GROUP_PRESET_STORAGE_KEY = 'budget-annihilation.autoControlGroups.v1';
const AUTO_GROUP_PRESET_BANK_STORAGE_KEY = 'budget-annihilation.autoControlGroupPresets.v2';

export const AUTO_GROUP_PRESET_COUNT = CONTROL_GROUP_COUNT;
export const DEFAULT_AUTO_GROUP_PRESET_INDEX = 1;

type AutoGroupPresetSlots = (AutoGroupRuleSnapshot | null)[];
export type AutoGroupPresetBank = AutoGroupPresetSlots[];

function createEmptyAutoGroupPresetSlots(): AutoGroupPresetSlots {
  return new Array<AutoGroupRuleSnapshot | null>(CONTROL_GROUP_COUNT).fill(null);
}

export function createEmptyAutoGroupPresetBank(): AutoGroupPresetBank {
  return Array.from(
    { length: AUTO_GROUP_PRESET_COUNT },
    createEmptyAutoGroupPresetSlots,
  );
}

function sanitizeAutoGroupPresetSlots(value: unknown): AutoGroupPresetSlots {
  const slots = createEmptyAutoGroupPresetSlots();
  if (!Array.isArray(value)) return slots;
  const count = Math.min(value.length, CONTROL_GROUP_COUNT);
  for (let i = 0; i < count; i++) {
    const entry = value[i];
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as Partial<AutoGroupRuleSnapshot>;
    const unitBlueprintIds = Array.isArray(candidate.unitBlueprintIds)
      ? candidate.unitBlueprintIds.filter((id): id is string => typeof id === 'string')
      : [];
    const buildingBlueprintIds = Array.isArray(candidate.buildingBlueprintIds)
      ? candidate.buildingBlueprintIds.filter((id): id is string => typeof id === 'string')
      : [];
    if (unitBlueprintIds.length === 0 && buildingBlueprintIds.length === 0) continue;
    slots[i] = { unitBlueprintIds, buildingBlueprintIds };
  }
  return slots;
}

export function loadAutoGroupPresets(): {
  presets: AutoGroupPresetBank;
  activeIndex: number;
} {
  const presets = createEmptyAutoGroupPresetBank();
  if (typeof window === 'undefined') {
    return { presets, activeIndex: DEFAULT_AUTO_GROUP_PRESET_INDEX };
  }
  try {
    const raw = window.localStorage.getItem(AUTO_GROUP_PRESET_BANK_STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const count = Math.min(parsed.length, AUTO_GROUP_PRESET_COUNT);
        for (let i = 0; i < count; i++) {
          presets[i] = sanitizeAutoGroupPresetSlots(parsed[i]);
        }
        return { presets, activeIndex: DEFAULT_AUTO_GROUP_PRESET_INDEX };
      }
    }
  } catch {
    // Fall through to v1 migration.
  }
  try {
    const raw = window.localStorage.getItem(AUTO_GROUP_PRESET_STORAGE_KEY);
    if (raw === null) {
      return { presets, activeIndex: DEFAULT_AUTO_GROUP_PRESET_INDEX };
    }
    const parsed = JSON.parse(raw);
    presets[DEFAULT_AUTO_GROUP_PRESET_INDEX] = sanitizeAutoGroupPresetSlots(parsed);
    return { presets, activeIndex: DEFAULT_AUTO_GROUP_PRESET_INDEX };
  } catch {
    return { presets, activeIndex: DEFAULT_AUTO_GROUP_PRESET_INDEX };
  }
}

export function saveAutoGroupPresets(
  presets: readonly (readonly (AutoGroupRuleSnapshot | null)[])[],
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUTO_GROUP_PRESET_BANK_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // localStorage may be unavailable or over quota; auto-groups still work in-memory.
  }
}
