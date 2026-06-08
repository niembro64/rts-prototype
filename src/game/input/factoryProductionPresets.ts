export const FACTORY_PRODUCTION_PRESET_STORAGE_KEY = 'budget-annihilation.factoryPresets.v1';
export const FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT =
  'budget-annihilation:factory-production-presets-changed';
export const FACTORY_PRODUCTION_PRESET_COUNT = 4;

export type FactoryProductionPresetSlots = (string | null)[];

function emptyFactoryProductionPresetSlots(): FactoryProductionPresetSlots {
  return Array.from({ length: FACTORY_PRODUCTION_PRESET_COUNT }, () => null);
}

export function loadFactoryProductionPresetSlots(): FactoryProductionPresetSlots {
  if (typeof window === 'undefined') return emptyFactoryProductionPresetSlots();
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(FACTORY_PRODUCTION_PRESET_STORAGE_KEY) ?? '[]',
    );
    return Array.from({ length: FACTORY_PRODUCTION_PRESET_COUNT }, (_, index) => {
      const value = Array.isArray(parsed) ? parsed[index] : null;
      return typeof value === 'string' && value.length > 0 ? value : null;
    });
  } catch {
    return emptyFactoryProductionPresetSlots();
  }
}

export function getFactoryProductionPresetSlot(index: number): string | null {
  if (index < 0 || index >= FACTORY_PRODUCTION_PRESET_COUNT) return null;
  return loadFactoryProductionPresetSlots()[index] ?? null;
}

export function setFactoryProductionPresetSlot(
  index: number,
  unitBlueprintId: string | null,
): void {
  if (index < 0 || index >= FACTORY_PRODUCTION_PRESET_COUNT) return;
  const slots = loadFactoryProductionPresetSlots();
  slots[index] = unitBlueprintId;
  saveFactoryProductionPresetSlots(slots);
}

export function saveFactoryProductionPresetSlots(
  slots: readonly (string | null)[],
): void {
  if (typeof window === 'undefined') return;
  const next = Array.from({ length: FACTORY_PRODUCTION_PRESET_COUNT }, (_, index) => {
    const value = slots[index] ?? null;
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
  window.localStorage.setItem(FACTORY_PRODUCTION_PRESET_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT, {
    detail: next,
  }));
}
