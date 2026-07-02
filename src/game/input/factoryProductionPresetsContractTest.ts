import {
  FACTORY_PRODUCTION_PRESET_COUNT,
  FACTORY_PRODUCTION_PRESET_STORAGE_KEY,
  FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT,
  createFactoryProductionPresetSnapshot,
  getFactoryProductionPresetSlot,
  loadFactoryProductionPresetSlots,
  normalizeFactoryProductionPresetSnapshot,
  resolveFactoryProductionPresetReplay,
  setFactoryProductionPresetSlot,
} from './factoryProductionPresets';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[factory production presets contract] ${message}`);
}

export function runFactoryProductionPresetsContractTest(): void {
  const legacy = normalizeFactoryProductionPresetSnapshot('unitLynx');
  assertContract(
    legacy?.selectedUnitBlueprintId === 'unitLynx' &&
      legacy.repeatProduction === true &&
      legacy.productionQueue.length === 0,
    'legacy single-unit preset must migrate to a repeat snapshot',
  );

  const empty = normalizeFactoryProductionPresetSnapshot({
    selectedUnitBlueprintId: '',
    repeatProduction: false,
    productionQueue: ['', null],
  });
  assertContract(empty === null, 'empty snapshot must normalize to a cleared preset');

  const longQueue = new Array<string>(80).fill('unitBee');
  const truncated = createFactoryProductionPresetSnapshot(null, false, longQueue);
  assertContract(
    truncated !== null &&
      truncated.selectedUnitBlueprintId === null &&
      truncated.repeatProduction === false &&
      truncated.productionQueue.length === 64,
    'queue snapshots must preserve finite mode and clamp to the storage cap',
  );

  const allowedUnits = new Set(['unitJackal', 'unitLynx', 'unitBee']);
  const finiteReplay = resolveFactoryProductionPresetReplay({
    selectedUnitBlueprintId: 'unitJackal',
    repeatProduction: true,
    productionQueue: ['unitLynx', 'unitBee'],
  }, allowedUnits);
  assertContract(
    finiteReplay?.selectedUnitBlueprintId === 'unitJackal' &&
      finiteReplay.repeatProduction === false &&
      finiteReplay.productionQueue.join(',') === 'unitLynx,unitBee',
    'snapshots with queued follow-ups must replay as a finite factory queue',
  );

  const shiftedReplay = resolveFactoryProductionPresetReplay({
    selectedUnitBlueprintId: null,
    repeatProduction: false,
    productionQueue: ['unitLynx', 'unitBee'],
  }, allowedUnits);
  assertContract(
    shiftedReplay?.selectedUnitBlueprintId === 'unitLynx' &&
      shiftedReplay.repeatProduction === false &&
      shiftedReplay.productionQueue.join(',') === 'unitBee',
    'snapshots without an active selection must promote the first queued unit on replay',
  );

  const invalidReplay = resolveFactoryProductionPresetReplay({
    selectedUnitBlueprintId: 'unitJackal',
    repeatProduction: true,
    productionQueue: ['unitTick'],
  }, allowedUnits);
  assertContract(invalidReplay === null, 'replay must reject units outside the selected factory roster');

  if (typeof window === 'undefined') return;

  const previousValue = window.localStorage.getItem(FACTORY_PRODUCTION_PRESET_STORAGE_KEY);
  let eventCount = 0;
  const onChanged = (): void => {
    eventCount++;
  };
  window.addEventListener(FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT, onChanged);
  try {
    window.localStorage.setItem(
      FACTORY_PRODUCTION_PRESET_STORAGE_KEY,
      JSON.stringify([
        'unitTick',
        {
          selectedUnitBlueprintId: 'unitLynx',
          repeatProduction: false,
          productionQueue: ['unitBee', '', 'unitTick'],
        },
      ]),
    );

    const loaded = loadFactoryProductionPresetSlots();
    assertContract(loaded.length === FACTORY_PRODUCTION_PRESET_COUNT, 'load must return every preset slot');
    assertContract(
      loaded[0]?.selectedUnitBlueprintId === 'unitTick' &&
        loaded[0]?.repeatProduction === true &&
        loaded[0]?.productionQueue.length === 0,
      'stored legacy slots must migrate on load',
    );
    assertContract(
      loaded[1]?.selectedUnitBlueprintId === 'unitLynx' &&
        loaded[1]?.repeatProduction === false &&
        loaded[1]?.productionQueue.join(',') === 'unitBee,unitTick',
      'stored snapshots must preserve selected unit, finite repeat state, and cleaned queue',
    );

    setFactoryProductionPresetSlot(2, {
      selectedUnitBlueprintId: 'unitJackal',
      repeatProduction: false,
      productionQueue: ['unitLynx', 'unitBee'],
    });
    const saved = getFactoryProductionPresetSlot(2);
    assertContract(
      saved?.selectedUnitBlueprintId === 'unitJackal' &&
        saved.repeatProduction === false &&
        saved.productionQueue.join(',') === 'unitLynx,unitBee',
      'set/get must round-trip full queue snapshots',
    );
    assertContract(eventCount === 1, 'saving a preset must dispatch the local changed event');

    setFactoryProductionPresetSlot(2, createFactoryProductionPresetSnapshot(null, true, []));
    assertContract(getFactoryProductionPresetSlot(2) === null, 'saving an empty snapshot must clear the slot');
    assertContract(eventCount === 2, 'clearing a preset must dispatch the local changed event');
  } finally {
    window.removeEventListener(FACTORY_PRODUCTION_PRESETS_CHANGED_EVENT, onChanged);
    if (previousValue === null) {
      window.localStorage.removeItem(FACTORY_PRODUCTION_PRESET_STORAGE_KEY);
    } else {
      window.localStorage.setItem(FACTORY_PRODUCTION_PRESET_STORAGE_KEY, previousValue);
    }
  }
}
