export const FACTORY_PRODUCTION_PRESET_STORAGE_KEY = 'budget-annihilation.factoryPresets.v1';
export const FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT =
  'budget-annihilation:factory-production-presets-changed';
export const FACTORY_PRODUCTION_PRESET_COUNT = 10;
const FACTORY_PRODUCTION_PRESET_QUEUE_MAX = 64;

export type FactoryProductionPresetSnapshot = {
  selectedUnitBlueprintId: string | null;
  repeatProduction: boolean;
  productionQueue: string[];
};

export type FactoryProductionPresetReplay = {
  selectedUnitBlueprintId: string;
  repeatProduction: boolean;
  productionQueue: string[];
};

type FactoryProductionPresetSlots = (FactoryProductionPresetSnapshot | null)[];

function emptyFactoryProductionPresetSlots(): FactoryProductionPresetSlots {
  const slots = new Array<FactoryProductionPresetSnapshot | null>(FACTORY_PRODUCTION_PRESET_COUNT);
  for (let i = 0; i < FACTORY_PRODUCTION_PRESET_COUNT; i++) slots[i] = null;
  return slots;
}

function cleanUnitBlueprintId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function cleanProductionQueue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const queue: string[] = [];
  for (let i = 0; i < value.length && queue.length < FACTORY_PRODUCTION_PRESET_QUEUE_MAX; i++) {
    const unitBlueprintId = cleanUnitBlueprintId(value[i]);
    if (unitBlueprintId !== null) queue.push(unitBlueprintId);
  }
  return queue;
}

export function normalizeFactoryProductionPresetSnapshot(
  value: unknown,
): FactoryProductionPresetSnapshot | null {
  const legacyUnitBlueprintId = cleanUnitBlueprintId(value);
  if (legacyUnitBlueprintId !== null) {
    return {
      selectedUnitBlueprintId: legacyUnitBlueprintId,
      repeatProduction: true,
      productionQueue: [],
    };
  }

  if (value === null || typeof value !== 'object') return null;
  const candidate = value as {
    selectedUnitBlueprintId?: unknown;
    repeatProduction?: unknown;
    productionQueue?: unknown;
  };
  const selectedUnitBlueprintId = cleanUnitBlueprintId(candidate.selectedUnitBlueprintId);
  const productionQueue = cleanProductionQueue(candidate.productionQueue);
  if (selectedUnitBlueprintId === null && productionQueue.length === 0) return null;
  return {
    selectedUnitBlueprintId,
    repeatProduction: candidate.repeatProduction !== false,
    productionQueue,
  };
}

export function createFactoryProductionPresetSnapshot(
  selectedUnitBlueprintId: string | null | undefined,
  repeatProduction: boolean | null | undefined,
  productionQueue: readonly string[] | null | undefined,
): FactoryProductionPresetSnapshot | null {
  return normalizeFactoryProductionPresetSnapshot({
    selectedUnitBlueprintId,
    repeatProduction: repeatProduction !== false,
    productionQueue: productionQueue ?? [],
  });
}

export function getFactoryProductionPresetUnitBlueprintIds(
  snapshot: FactoryProductionPresetSnapshot | null,
): string[] {
  if (snapshot === null) return [];
  const unitBlueprintIds: string[] = [];
  if (snapshot.selectedUnitBlueprintId !== null) unitBlueprintIds.push(snapshot.selectedUnitBlueprintId);
  for (let i = 0; i < snapshot.productionQueue.length; i++) {
    unitBlueprintIds.push(snapshot.productionQueue[i]);
  }
  return unitBlueprintIds;
}

export function resolveFactoryProductionPresetReplay(
  snapshot: FactoryProductionPresetSnapshot | null,
  allowedUnitBlueprintIds: ReadonlySet<string>,
): FactoryProductionPresetReplay | null {
  const unitBlueprintIds = getFactoryProductionPresetUnitBlueprintIds(snapshot);
  if (snapshot === null || unitBlueprintIds.length === 0) return null;
  for (let i = 0; i < unitBlueprintIds.length; i++) {
    if (!allowedUnitBlueprintIds.has(unitBlueprintIds[i])) return null;
  }

  const productionQueue = snapshot.productionQueue.slice();
  const selectedUnitBlueprintId = snapshot.selectedUnitBlueprintId ?? productionQueue.shift() ?? null;
  if (selectedUnitBlueprintId === null) return null;
  return {
    selectedUnitBlueprintId,
    repeatProduction: snapshot.repeatProduction && productionQueue.length === 0,
    productionQueue,
  };
}

export function loadFactoryProductionPresetSlots(): FactoryProductionPresetSlots {
  if (typeof window === 'undefined') return emptyFactoryProductionPresetSlots();
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(FACTORY_PRODUCTION_PRESET_STORAGE_KEY) ?? '[]',
    );
    const slots = new Array<FactoryProductionPresetSnapshot | null>(FACTORY_PRODUCTION_PRESET_COUNT);
    for (let index = 0; index < FACTORY_PRODUCTION_PRESET_COUNT; index++) {
      const value = Array.isArray(parsed) ? parsed[index] : null;
      slots[index] = normalizeFactoryProductionPresetSnapshot(value);
    }
    return slots;
  } catch {
    return emptyFactoryProductionPresetSlots();
  }
}

export function getFactoryProductionPresetSlot(index: number): FactoryProductionPresetSnapshot | null {
  if (index < 0 || index >= FACTORY_PRODUCTION_PRESET_COUNT) return null;
  return loadFactoryProductionPresetSlots()[index] ?? null;
}

export function setFactoryProductionPresetSlot(
  index: number,
  snapshot: FactoryProductionPresetSnapshot | string | null,
): void {
  if (index < 0 || index >= FACTORY_PRODUCTION_PRESET_COUNT) return;
  const slots = loadFactoryProductionPresetSlots();
  slots[index] = normalizeFactoryProductionPresetSnapshot(snapshot);
  saveFactoryProductionPresetSlots(slots);
}

function saveFactoryProductionPresetSlots(
  slots: readonly (FactoryProductionPresetSnapshot | null)[],
): void {
  if (typeof window === 'undefined') return;
  const next = new Array<FactoryProductionPresetSnapshot | null>(FACTORY_PRODUCTION_PRESET_COUNT);
  for (let index = 0; index < FACTORY_PRODUCTION_PRESET_COUNT; index++) {
    const value = slots[index] ?? null;
    next[index] = normalizeFactoryProductionPresetSnapshot(value);
  }
  window.localStorage.setItem(FACTORY_PRODUCTION_PRESET_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT, {
    detail: next,
  }));
}
