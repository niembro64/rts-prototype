import {
  CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS,
  Input3DKeyboardController,
  barLegacyBuildKeyForKey,
  barBuildCategoryForHomeCommandId,
  isBarGridCycleBuilderKey,
  isBarGridNextPageKey,
  barManualFireCommandForKey,
  barStateCommandForTap,
  barStateTapTargetForKey,
  barSupportCommandForKey,
  cameraKeyboardActionForKey,
  isAutoGroupRemoveKey,
  isAutoGroupPresetLoadKey,
  isControlGroupUnsetKey,
  recordControlGroupRecallTap,
  resetControlGroupRecallTap,
  type ControlGroupRecallTapState,
} from './Input3DKeyboardController';
import { setActiveCommandHotkeyPresetId } from '../input/commandHotkeys';
import {
  barLegacyBuildKeyForStructureBlueprintId,
  getBarLegacyBuildMenuStructureBlueprintIdsForKey,
} from '../input/buildMenuLayout';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[input keyboard contract] ${message}`);
  }
}

function makeState(): ControlGroupRecallTapState {
  return {
    index: -1,
    timeMs: Number.NEGATIVE_INFINITY,
  };
}

type KeyboardActionFixture = Parameters<typeof cameraKeyboardActionForKey>[0];

function makeKey(overrides: Partial<KeyboardActionFixture>): KeyboardActionFixture {
  return {
    code: 'ArrowUp',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function makeKeyboardEvent(
  overrides: Partial<KeyboardEvent> & Pick<KeyboardEvent, 'code'>,
): KeyboardEvent {
  let prevented = false;
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    target: null,
    timeStamp: 0,
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
    ...overrides,
  } as KeyboardEvent;
}

function installSsrCommandHotkeyStorage(): (() => void) | null {
  if (typeof window !== 'undefined') return null;
  const values = new Map<string, string>();
  const localStorage = {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
  });
  return () => {
    Reflect.deleteProperty(globalThis, 'window');
  };
}

function runBarFactoryPresetDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  let recalledControlGroup = 0;
  let loadedPreset = -1;
  let savedPreset = -1;
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    recallControlGroupSlot: () => {
      recalledControlGroup++;
      return true;
    },
    loadFactoryProductionPreset: (index: number) => {
      loadedPreset = index;
    },
    saveFactoryProductionPreset: (index: number) => {
      savedPreset = index;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const event = makeKeyboardEvent({ code: 'Digit0', key: '0', metaKey: true });
  controller.handleKeyDown(event);
  assertContract(
    loadedPreset === 0,
    'BAR-grid Meta+0 must dispatch factory preset load instead of control-group recall',
  );
  assertContract(
    recalledControlGroup === 0,
    'BAR-grid Meta+0 must not be treated as a control-group number chord',
  );
  assertContract(
    event.defaultPrevented,
    'BAR-grid Meta+0 factory preset dispatch must prevent the browser default',
  );

  const lastLoadEvent = makeKeyboardEvent({ code: 'Digit9', key: '9', metaKey: true });
  controller.handleKeyDown(lastLoadEvent);
  assertContract(
    loadedPreset === 9,
    'BAR-grid Meta+9 must dispatch factory preset load for BAR preset slot 9',
  );
  assertContract(
    recalledControlGroup === 0,
    'BAR-grid Meta+9 must not be treated as a control-group number chord',
  );
  assertContract(
    lastLoadEvent.defaultPrevented,
    'BAR-grid Meta+9 factory preset dispatch must prevent the browser default',
  );

  const lastSaveEvent = makeKeyboardEvent({ code: 'Digit9', key: '9', metaKey: true, altKey: true });
  controller.handleKeyDown(lastSaveEvent);
  assertContract(
    savedPreset === 9,
    'BAR-grid Meta+Alt+9 must dispatch factory preset save for BAR preset slot 9',
  );
  assertContract(
    recalledControlGroup === 0,
    'BAR-grid Meta+Alt+9 must not be treated as a control-group number chord',
  );
  assertContract(
    lastSaveEvent.defaultPrevented,
    'BAR-grid Meta+Alt+9 factory preset dispatch must prevent the browser default',
  );
}

function runBarAutoGroupPresetDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  let loadedAutoGroupPreset = -1;
  let setAutoGroup = 0;
  let recalledControlGroup = 0;
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    setAutoControlGroupSlot: () => {
      setAutoGroup++;
    },
    recallControlGroupSlot: () => {
      recalledControlGroup++;
      return true;
    },
    loadAutoGroupPreset: (index: number) => {
      loadedAutoGroupPreset = index;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const event = makeKeyboardEvent({ code: 'Digit3', key: '3', altKey: true, shiftKey: true });
  controller.handleKeyDown(event);
  assertContract(
    loadedAutoGroupPreset === 3,
    'BAR-grid Shift+Alt+3 must dispatch load_autogroup_preset 3',
  );
  assertContract(
    setAutoGroup === 0 && recalledControlGroup === 0,
    'BAR-grid Shift+Alt+3 must not assign or recall control group 3',
  );
  assertContract(
    event.defaultPrevented,
    'BAR-grid Shift+Alt+3 autogroup preset dispatch must prevent the browser default',
  );
  assertContract(
    isAutoGroupPresetLoadKey(makeKeyboardEvent({ code: 'Digit9', key: '9', altKey: true, shiftKey: true }), 'bar-legacy'),
    'BAR legacy Shift+Alt+9 must match num_keys.txt load_autogroup_preset 9',
  );
  assertContract(
    isAutoGroupPresetLoadKey(makeKeyboardEvent({ code: 'Digit0', key: '0', altKey: true, shiftKey: true }), 'bar-grid-60pct'),
    'BAR 60% presets must keep num_keys.txt load_autogroup_preset bindings',
  );
  assertContract(
    !isAutoGroupPresetLoadKey(makeKeyboardEvent({ code: 'Digit3', key: '3', altKey: true, shiftKey: true }), 'prototype'),
    'prototype preset must not claim BAR load_autogroup_preset bindings',
  );
}

function runBarBuildCategoryDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  let activeCategory: string | null = null;
  let enteredBuildMode: string | null = null;
  const controller = new Input3DKeyboardController(new Proxy({
    mode: {
      isInBuildMode: false,
      enterBuildMode: (buildingBlueprintId: string) => {
        enteredBuildMode = buildingBlueprintId;
      },
    },
    moveCameraByKeyboard: () => {},
    hasSelectedBuilder: () => true,
    getBuildGridCategory: () => activeCategory,
    setBuildGridCategory: (categoryId: string | null) => {
      activeCategory = categoryId;
    },
    getBuildGridPage: () => 0,
    getSelectedBuilderAllowedBuildBlueprintIds: () => [
      'buildingExtractor',
      'buildingSolar',
      'towerCannon',
      'buildingRadar',
      'buildingSonar',
      'towerFabricator',
    ],
    exitSpecialModes: () => {},
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const categoryEvent = makeKeyboardEvent({ code: 'KeyZ', key: 'z' });
  controller.handleKeyDown(categoryEvent);
  assertContract(
    activeCategory === 'Economy',
    'BAR-grid home Z must enter the Economy build category',
  );
  assertContract(
    enteredBuildMode === 'buildingExtractor',
    'BAR-grid home Z must auto-select the first Economy build option',
  );
  assertContract(
    categoryEvent.defaultPrevented,
    'BAR-grid home category entry must prevent the browser default',
  );

  enteredBuildMode = null;
  const modifiedCategorySlotEvent = makeKeyboardEvent({ code: 'KeyZ', key: 'z', ctrlKey: true });
  controller.handleKeyDown(modifiedCategorySlotEvent);
  assertContract(
    activeCategory === 'Economy' && enteredBuildMode === null,
    'BAR-grid modified builder-category slot keys must not pick build options',
  );
  assertContract(
    !modifiedCategorySlotEvent.defaultPrevented,
    'BAR-grid modified builder-category slot keys must fall through like BAR gridmenu',
  );

  activeCategory = null;
  enteredBuildMode = null;
  const rowTwoEvent = makeKeyboardEvent({ code: 'KeyA', key: 'a' });
  controller.handleKeyDown(rowTwoEvent);
  assertContract(
    activeCategory === null && enteredBuildMode === null,
    'BAR-grid row-2 build keys must not issue home-layer build commands',
  );
}

function runBarBuildCategoryClearContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  let activeCategory: string | null = 'Economy';
  let buildModeActive = true;
  const mode = {
    get isInBuildMode() {
      return buildModeActive;
    },
    exitBuildMode: () => {
      buildModeActive = false;
    },
  };
  const controller = new Input3DKeyboardController(new Proxy({
    mode,
    moveCameraByKeyboard: () => {},
    getBuildGridCategory: () => activeCategory,
    setBuildGridCategory: (categoryId: string | null) => {
      activeCategory = categoryId;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  controller.handleKeyUp(makeKeyboardEvent({ code: 'ShiftRight', key: 'Shift' }));
  assertContract(
    activeCategory === 'Economy' && buildModeActive,
    'BAR-grid right Shift release must not clear the active build category',
  );

  controller.handleKeyUp(makeKeyboardEvent({ code: 'ShiftLeft', key: 'Shift' }));
  assertContract(
    activeCategory === null && !buildModeActive,
    'BAR-grid left Shift release must clear the active build category and active build command',
  );

  activeCategory = 'Combat';
  buildModeActive = true;
  const escapeEvent = makeKeyboardEvent({ code: 'Escape', key: 'Escape' });
  controller.handleKeyDown(escapeEvent);
  assertContract(
    activeCategory === null && !buildModeActive,
    'BAR-grid Escape must clear the active build category and active build command',
  );
}

function runBarGridNextPageDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  let buildPage = 0;
  let factoryPage = 0;
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    hasSelectedBuilder: () => true,
    hasSelectedUnits: () => false,
    hasSelectedFactory: () => false,
    stepBuildGridPage: (delta: number) => {
      buildPage = (buildPage + delta + 2) % 2;
      return true;
    },
    stepFactoryGridPage: (delta: number) => {
      factoryPage = (factoryPage + delta + 3) % 3;
      return true;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const buildPageEvent = makeKeyboardEvent({ code: 'KeyB', key: 'b' });
  controller.handleKeyDown(buildPageEvent);
  assertContract(
    buildPage === 1 && factoryPage === 0 && buildPageEvent.defaultPrevented,
    'BAR-grid plain B must dispatch gui_gridmenu.lua gridmenu_next_page to selected-builder build pages',
  );

  const buildWrapEvent = makeKeyboardEvent({ code: 'KeyB', key: 'b' });
  controller.handleKeyDown(buildWrapEvent);
  assertContract(
    buildPage === 0 && factoryPage === 0 && buildWrapEvent.defaultPrevented,
    'BAR-grid builder page stepping must allow gui_gridmenu.lua nextPageHandler-style page wrapping',
  );

  const factoryController = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    hasSelectedBuilder: () => false,
    hasSelectedUnits: () => false,
    hasSelectedFactory: () => true,
    stepBuildGridPage: (delta: number) => {
      buildPage = (buildPage + delta + 2) % 2;
      return true;
    },
    stepFactoryGridPage: (delta: number) => {
      factoryPage = (factoryPage + delta + 3) % 3;
      return true;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const factoryPageEvent = makeKeyboardEvent({ code: 'KeyB', key: 'b' });
  factoryController.handleKeyDown(factoryPageEvent);
  assertContract(
    buildPage === 0 && factoryPage === 1 && factoryPageEvent.defaultPrevented,
    'BAR-grid plain B must dispatch gui_gridmenu.lua gridmenu_next_page to selected-factory production pages',
  );
}

function runBarFactoryQueueModeContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  let factoryQueueMode = false;
  let factoryRepeatsProduction = false;
  let toggleCount = 0;
  let airIdleToggleCount = 0;
  const factoryRepeatStates: boolean[] = [];
  const queuedSlots: { slotIndex: number; repeat: boolean; count: number }[] = [];
  const quotaSlots: { slotIndex: number; delta: number }[] = [];
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    hasSelectedUnits: () => false,
    hasSelectedFactory: () => true,
    hasSelectedBuilder: () => false,
    getFactoryQueueMode: () => factoryQueueMode,
    toggleFactoryQueueMode: () => {
      factoryQueueMode = !factoryQueueMode;
      toggleCount++;
    },
    getSelectedFactoryRepeatProduction: () => factoryRepeatsProduction,
    setSelectedFactoryRepeatProduction: (enabled: boolean) => {
      factoryRepeatsProduction = enabled;
      factoryRepeatStates.push(enabled);
    },
    toggleSelectedFactoryRepeatProduction: () => {
      factoryRepeatsProduction = !factoryRepeatsProduction;
      factoryRepeatStates.push(factoryRepeatsProduction);
    },
    toggleSelectedFactoryAirIdleState: () => {
      airIdleToggleCount++;
    },
    queueSelectedFactoryUnitSlot: (slotIndex: number, repeat: boolean, count: number) => {
      queuedSlots.push({ slotIndex, repeat, count });
      return true;
    },
    changeSelectedFactoryUnitSlotQuota: (slotIndex: number, delta: number) => {
      quotaSlots.push({ slotIndex, delta });
      return true;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const repeatEvent = makeKeyboardEvent({ code: 'KeyZ', key: 'z' });
  controller.handleKeyDown(repeatEvent);
  assertContract(
    queuedSlots.length === 1 &&
      queuedSlots[0].slotIndex === 0 &&
      queuedSlots[0].repeat === false &&
      queuedSlots[0].count === 1,
    'BAR-grid factory slot hotkeys must queue one-shot units while factory repeat is off',
  );
  assertContract(
    repeatEvent.defaultPrevented,
    'BAR-grid factory slot hotkeys must prevent the browser default',
  );

  factoryRepeatsProduction = true;
  const repeatEnabledEvent = makeKeyboardEvent({ code: 'KeyZ', key: 'z' });
  controller.handleKeyDown(repeatEnabledEvent);
  assertContract(
    queuedSlots.length === 2 &&
      queuedSlots[1].slotIndex === 0 &&
      queuedSlots[1].repeat === true &&
      queuedSlots[1].count === 1,
    'BAR-grid factory slot hotkeys must repeat units while factory repeat is on',
  );

  const shiftEvent = makeKeyboardEvent({ code: 'KeyX', key: 'x', shiftKey: true });
  controller.handleKeyDown(shiftEvent);
  assertContract(
    queuedSlots.length === 3 &&
      queuedSlots[2].slotIndex === 1 &&
      queuedSlots[2].repeat === false &&
      queuedSlots[2].count === 5,
    'BAR-grid Shift factory slot hotkeys must queue five one-shot units',
  );
  assertContract(
    shiftEvent.defaultPrevented,
    'BAR-grid Shift factory slot hotkeys must prevent the browser default',
  );

  const ctrlEvent = makeKeyboardEvent({ code: 'KeyC', key: 'c', ctrlKey: true });
  controller.handleKeyDown(ctrlEvent);
  assertContract(
    queuedSlots.length === 4 &&
      queuedSlots[3].slotIndex === 2 &&
      queuedSlots[3].repeat === false &&
      queuedSlots[3].count === 20,
    'BAR-grid Ctrl factory slot hotkeys must queue twenty units',
  );
  assertContract(
    ctrlEvent.defaultPrevented,
    'BAR-grid Ctrl factory slot hotkeys must prevent the browser default',
  );

  const shiftCtrlEvent = makeKeyboardEvent({ code: 'KeyV', key: 'v', ctrlKey: true, shiftKey: true });
  controller.handleKeyDown(shiftCtrlEvent);
  assertContract(
    queuedSlots.length === 5 &&
      queuedSlots[4].slotIndex === 3 &&
      queuedSlots[4].repeat === false &&
      queuedSlots[4].count === 100,
    'BAR-grid Shift+Ctrl factory slot hotkeys must queue one hundred units',
  );
  assertContract(
    shiftCtrlEvent.defaultPrevented,
    'BAR-grid Shift+Ctrl factory slot hotkeys must prevent the browser default',
  );

  const toggleEvent = makeKeyboardEvent({ code: 'KeyG', key: 'g', altKey: true });
  controller.handleKeyDown(toggleEvent);
  assertContract(
    toggleCount === 1 && factoryQueueMode,
    'BAR-grid Alt+G must toggle factory queue mode',
  );
  assertContract(
    toggleEvent.defaultPrevented,
    'BAR-grid Alt+G factory queue mode must prevent the browser default',
  );
  assertContract(
    airIdleToggleCount === 0,
    'BAR air-plant LandAt has no default hotkey binding',
  );

  const queueEvent = makeKeyboardEvent({ code: 'KeyX', key: 'x' });
  controller.handleKeyDown(queueEvent);
  assertContract(
    queuedSlots.length === 5 &&
      quotaSlots.length === 1 &&
      quotaSlots[0].slotIndex === 1 &&
      quotaSlots[0].delta === 1,
    'BAR-grid factory quota mode must adjust quotas instead of queuing units',
  );
  assertContract(
    queueEvent.defaultPrevented,
    'BAR-grid queue-mode factory slot hotkeys must prevent the browser default',
  );

  const metaQueueModeEvent = makeKeyboardEvent({ code: 'KeyC', key: 'c', metaKey: true });
  controller.handleKeyDown(metaQueueModeEvent);
  assertContract(
    queuedSlots.length === 5 &&
      quotaSlots.length === 2 &&
      quotaSlots[1].slotIndex === 2 &&
      quotaSlots[1].delta === 1,
    'BAR-grid factory quota mode must treat Meta-modified grid keys as quota changes because gui_gridmenu.lua only lets Alt bypass quota mode',
  );
  assertContract(
    metaQueueModeEvent.defaultPrevented,
    'BAR-grid Meta factory quota hotkeys must prevent the browser default',
  );

  const ctrlQueueModeEvent = makeKeyboardEvent({ code: 'KeyV', key: 'v', ctrlKey: true });
  controller.handleKeyDown(ctrlQueueModeEvent);
  assertContract(
    queuedSlots.length === 5 &&
      quotaSlots.length === 3 &&
      quotaSlots[2].slotIndex === 3 &&
      quotaSlots[2].delta === 20,
    'BAR-grid factory quota mode must treat Ctrl factory grid keys as +20 quota changes',
  );
  assertContract(
    ctrlQueueModeEvent.defaultPrevented,
    'BAR-grid Ctrl factory quota hotkeys must prevent the browser default',
  );

  const altQueueBypassEvent = makeKeyboardEvent({ code: 'KeyC', key: 'c', altKey: true });
  controller.handleKeyDown(altQueueBypassEvent);
  assertContract(
    queuedSlots.length === 6 &&
      queuedSlots[5].slotIndex === 2 &&
      queuedSlots[5].repeat === false &&
      queuedSlots[5].count === 1 &&
      quotaSlots.length === 3,
    'BAR-grid factory quota mode must let Alt bypass quota mode and queue normally',
  );
  assertContract(
    altQueueBypassEvent.defaultPrevented,
    'BAR-grid Alt quota-bypass factory hotkeys must prevent the browser default',
  );

  factoryRepeatsProduction = false;
  const repeatOnEvent = makeKeyboardEvent({ code: 'KeyT', key: 't' });
  controller.handleKeyDown(repeatOnEvent);
  assertContract(
    factoryRepeatStates.length === 0,
    'BAR-grid factory T must wait briefly for a possible repeat-off double tap',
  );
  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  assertContract(
    factoryRepeatStates.length === 1 && factoryRepeatStates[0] === true,
    'BAR-grid single T must set selected factory repeat on',
  );

  const repeatOffFirstEvent = makeKeyboardEvent({ code: 'KeyT', key: 't' });
  const repeatOffSecondEvent = makeKeyboardEvent({ code: 'KeyT', key: 't' });
  controller.handleKeyDown(repeatOffFirstEvent);
  controller.handleKeyDown(repeatOffSecondEvent);
  assertContract(
    factoryRepeatStates.length === 2 && factoryRepeatStates[1] === false,
    'BAR-grid double T must set selected factory repeat off',
  );
  assertContract(
    repeatOnEvent.defaultPrevented && repeatOffFirstEvent.defaultPrevented && repeatOffSecondEvent.defaultPrevented,
    'BAR-grid factory repeat taps must prevent browser defaults',
  );
}

function runBarFactoryGuardDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  const guardStates: boolean[] = [];
  let toggleCount = 0;
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    hasSelectedUnits: () => false,
    hasSelectedFactory: () => true,
    hasSelectedBuilder: () => false,
    setSelectedFactoryGuardEnabled: (enabled: boolean) => {
      guardStates.push(enabled);
    },
    toggleSelectedFactoryGuard: () => {
      toggleCount++;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const event = makeKeyboardEvent({ code: 'KeyG', key: 'g', ctrlKey: true });
  controller.handleKeyDown(event);
  assertContract(
    guardStates.length === 0 && toggleCount === 0,
    'BAR-grid single Ctrl+G must wait briefly for a possible factory-guard off double tap',
  );
  assertContract(
    event.defaultPrevented,
    'BAR-grid Ctrl+G factory guard mode must prevent the browser default',
  );

  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  assertContract(
    guardStates.length === 1 && guardStates[0] === true && toggleCount === 0,
    'BAR-grid single Ctrl+G must set factory guard mode on after the tap window',
  );

  const doubleFirstEvent = makeKeyboardEvent({ code: 'KeyG', key: 'g', ctrlKey: true });
  const doubleSecondEvent = makeKeyboardEvent({ code: 'KeyG', key: 'g', ctrlKey: true });
  controller.handleKeyDown(doubleFirstEvent);
  controller.handleKeyDown(doubleSecondEvent);
  assertContract(
    guardStates.length === 2 && guardStates[1] === false && toggleCount === 0,
    'BAR-grid double Ctrl+G must set factory guard mode off',
  );
  assertContract(
    doubleFirstEvent.defaultPrevented && doubleSecondEvent.defaultPrevented,
    'BAR-grid factory guard double tap must prevent browser defaults',
  );
}

function runBarStateTapDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  const buildingActiveStates: boolean[] = [];
  const trajectoryModes: string[] = [];
  const fireStates: string[] = [];
  const moveStates: string[] = [];
  const genericToggleCounts = {
    buildingActive: 0,
    fireState: 0,
    moveState: 0,
    trajectory: 0,
  };
  let hasBuildingActiveControl = true;
  let hasTrajectoryControl = true;
  let hasMoveStateControl = true;
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    hasSelectedUnits: () => true,
    hasSelectedFactory: () => false,
    hasSelectedBuilder: () => false,
    hasSelectedBuildingActiveControl: () => hasBuildingActiveControl,
    hasSelectedTrajectoryControl: () => hasTrajectoryControl,
    hasSelectedMoveStateControl: () => hasMoveStateControl,
    setBuildingActive: (open: boolean) => {
      buildingActiveStates.push(open);
    },
    setTrajectoryMode: (mode: string) => {
      trajectoryModes.push(mode);
    },
    setSelectedFireState: (state: string) => {
      fireStates.push(state);
    },
    setUnitMoveState: (state: string) => {
      moveStates.push(state);
    },
    toggleBuildingActive: () => {
      genericToggleCounts.buildingActive++;
    },
    toggleTrajectoryMode: () => {
      genericToggleCounts.trajectory++;
    },
    toggleSelectedFire: () => {
      genericToggleCounts.fireState++;
    },
    toggleUnitMoveState: () => {
      genericToggleCounts.moveState++;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const buildingOnEvent = makeKeyboardEvent({ code: 'KeyB', key: 'b', shiftKey: true });
  controller.handleKeyDown(buildingOnEvent);
  assertContract(
    buildingActiveStates.length === 0 && genericToggleCounts.buildingActive === 0,
    'BAR-grid single Shift+B must wait briefly for a possible building-off double tap',
  );
  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  assertContract(
    buildingActiveStates.length === 1 && buildingActiveStates[0] === true,
    'BAR-grid single Shift+B must set building active on',
  );

  const buildingOffFirstEvent = makeKeyboardEvent({ code: 'KeyB', key: 'b' });
  const buildingOffSecondEvent = makeKeyboardEvent({ code: 'KeyB', key: 'b' });
  controller.handleKeyDown(buildingOffFirstEvent);
  controller.handleKeyDown(buildingOffSecondEvent);
  assertContract(
    buildingActiveStates.length === 2 && buildingActiveStates[1] === false,
    'BAR-grid double B must set building active off',
  );

  hasBuildingActiveControl = false;
  const trajectoryAutoEvent = makeKeyboardEvent({ code: 'KeyB', key: 'b' });
  controller.handleKeyDown(trajectoryAutoEvent);
  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  assertContract(
    trajectoryModes.length === 1 && trajectoryModes[0] === 'auto',
    'BAR-grid single B must set trajectory mode to auto when no building active state is shown',
  );

  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyB', key: 'b' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyB', key: 'b' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  assertContract(
    trajectoryModes.length === 2 && trajectoryModes[1] === 'low',
    'BAR-grid double B must set trajectory mode to low',
  );

  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyB', key: 'b' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyB', key: 'b' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyB', key: 'b' }));
  assertContract(
    trajectoryModes.length === 3 && trajectoryModes[2] === 'high',
    'BAR-grid triple B must set trajectory mode to high',
  );

  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyL', key: 'l' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyL', key: 'l' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyL', key: 'l' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyL', key: 'l' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyL', key: 'l' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'KeyL', key: 'l' }));
  assertContract(
    fireStates.join(',') === 'fireAtWill,holdFire,returnFire',
    'BAR-grid L taps must dispatch fire-at-will, hold-fire, and return-fire states',
  );

  hasMoveStateControl = true;
  controller.handleKeyDown(makeKeyboardEvent({ code: 'Semicolon', key: ';' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'Semicolon', key: ';' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'Semicolon', key: ';' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'F13', key: 'F13' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'Semicolon', key: ';' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'Semicolon', key: ';' }));
  controller.handleKeyDown(makeKeyboardEvent({ code: 'Semicolon', key: ';' }));
  assertContract(
    moveStates.join(',') === 'roam,holdPosition,maneuver',
    'BAR-grid semicolon taps must dispatch roam, hold-position, and maneuver move states',
  );

  assertContract(
    genericToggleCounts.buildingActive === 0 &&
      genericToggleCounts.trajectory === 0 &&
      genericToggleCounts.fireState === 0 &&
      genericToggleCounts.moveState === 0,
    'BAR-grid state taps must dispatch exact BAR state values instead of generic cycle toggles',
  );
  assertContract(
    buildingOnEvent.defaultPrevented && buildingOffFirstEvent.defaultPrevented &&
      buildingOffSecondEvent.defaultPrevented && trajectoryAutoEvent.defaultPrevented,
    'BAR-grid state taps must prevent browser defaults',
  );
}

function runBarSelectionFilterDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  let splitCount = 0;
  let damagedCount = 0;
  let matchingCount = 0;
  let previousCount = 0;
  let previousNotGroupedCount = 0;
  let previousArmyNotGroupedCount = 0;
  let groundWeaponCount = 0;
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    splitArmySelection: () => {
      splitCount++;
    },
    selectDamagedOnly: () => {
      damagedCount++;
    },
    selectAllMatching: () => {
      matchingCount++;
    },
    selectPreviousSelection: () => {
      previousCount++;
    },
    selectPreviousSelectionNotInControlGroups: () => {
      previousNotGroupedCount++;
    },
    selectPreviousNonBuildersNotInControlGroups: () => {
      previousArmyNotGroupedCount++;
    },
    selectGroundWeaponUnits: () => {
      groundWeaponCount++;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const splitEvent = makeKeyboardEvent({ code: 'KeyQ', key: 'q', ctrlKey: true });
  controller.handleKeyDown(splitEvent);
  assertContract(
    splitCount === 1 && splitEvent.defaultPrevented,
    'BAR-grid Ctrl+Q must dispatch the split-selection filter (BAR SelectPart_50)',
  );

  const damagedEvent = makeKeyboardEvent({ code: 'KeyQ', key: 'q', altKey: true });
  controller.handleKeyDown(damagedEvent);
  assertContract(
    damagedCount === 1 && damagedEvent.defaultPrevented,
    'BAR-grid Alt+Q must dispatch the damaged-mobile selection filter',
  );

  const matchingEvent = makeKeyboardEvent({ code: 'KeyW', key: 'w', ctrlKey: true });
  controller.handleKeyDown(matchingEvent);
  assertContract(
    matchingCount === 1 && matchingEvent.defaultPrevented,
    'BAR-grid Ctrl+W must dispatch AllMap+_InPrevSel same-type selection',
  );

  const previousEvent = makeKeyboardEvent({ code: 'KeyS', key: 's', ctrlKey: true, altKey: true });
  controller.handleKeyDown(previousEvent);
  assertContract(
    previousCount === 0 && !previousEvent.defaultPrevented,
    'BAR-grid Ctrl+Alt+S must stay unbound because BAR grid has no whole previous-selection bind',
  );

  setActiveCommandHotkeyPresetId('bar-legacy');
  const previousNotGroupedEvent = makeKeyboardEvent({ code: 'KeyX', key: 'x', ctrlKey: true });
  controller.handleKeyDown(previousNotGroupedEvent);
  assertContract(
    previousNotGroupedCount === 1 && previousNotGroupedEvent.defaultPrevented,
    'BAR-legacy Ctrl+X must dispatch previous-selection excluding hotkey groups',
  );

  const previousArmyNotGroupedEvent = makeKeyboardEvent({ code: 'KeyV', key: 'v', ctrlKey: true });
  controller.handleKeyDown(previousArmyNotGroupedEvent);
  assertContract(
    previousArmyNotGroupedCount === 1 && previousArmyNotGroupedEvent.defaultPrevented,
    'BAR-legacy Ctrl+V must dispatch previous non-builder selection excluding hotkey groups',
  );

  const groundWeaponEvent = makeKeyboardEvent({ code: 'KeyW', key: 'w', ctrlKey: true });
  controller.handleKeyDown(groundWeaponEvent);
  assertContract(
    groundWeaponCount === 1 && groundWeaponEvent.defaultPrevented,
    'BAR-legacy Ctrl+W must dispatch Not_Aircraft_Weapons selection',
  );
}

function runBarSelfDestructDispatcherContract(): void {
  const selfDestructModes: { queue?: boolean; queueFront?: boolean; queueInsertIndex?: number }[] = [];
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    selfDestructSelected: (queue?: boolean, queueFront?: boolean, queueInsertIndex?: number) => {
      selfDestructModes.push({ queue, queueFront, queueInsertIndex });
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  setActiveCommandHotkeyPresetId('bar-grid');
  const gridSelfdEvent = makeKeyboardEvent({ code: 'KeyB', key: 'b', ctrlKey: true });
  controller.handleKeyDown(gridSelfdEvent);
  assertContract(
    selfDestructModes.length === 1 &&
      selfDestructModes[0].queue === false &&
      gridSelfdEvent.defaultPrevented,
    'BAR-grid Ctrl+B must dispatch grid_keys.txt selfd while CMD.SELFD stays hidden from the order menu',
  );

  setActiveCommandHotkeyPresetId('bar-grid-60pct');
  const grid60QueuedSelfdEvent = makeKeyboardEvent({
    code: 'KeyB',
    key: 'b',
    ctrlKey: true,
    shiftKey: true,
  });
  controller.handleKeyDown(grid60QueuedSelfdEvent);
  assertContract(
    selfDestructModes.length === 2 &&
      selfDestructModes[1].queue === true &&
      selfDestructModes[1].queueFront === false &&
      grid60QueuedSelfdEvent.defaultPrevented,
    'BAR-grid-60pct Ctrl+Shift+B must dispatch grid_keys_60pct.txt queued selfd',
  );

  setActiveCommandHotkeyPresetId('bar-legacy');
  const legacySelfdEvent = makeKeyboardEvent({ code: 'KeyD', key: 'd', ctrlKey: true });
  controller.handleKeyDown(legacySelfdEvent);
  assertContract(
    selfDestructModes.length === 3 &&
      selfDestructModes[2].queue === false &&
      legacySelfdEvent.defaultPrevented,
    'BAR-legacy Ctrl+D must dispatch legacy_keys.txt selfd',
  );

  const legacyQueuedSelfdEvent = makeKeyboardEvent({
    code: 'KeyD',
    key: 'd',
    ctrlKey: true,
    shiftKey: true,
  });
  controller.handleKeyDown(legacyQueuedSelfdEvent);
  assertContract(
    selfDestructModes.length === 4 &&
      selfDestructModes[3].queue === true &&
      legacyQueuedSelfdEvent.defaultPrevented,
    'BAR-legacy Ctrl+Shift+D must dispatch legacy_keys.txt queued selfd',
  );
}

function runCloakDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  let hasCloakControl = false;
  let toggleCount = 0;
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: () => {},
    hasSelectedCloakControl: () => hasCloakControl,
    toggleCloakState: () => {
      toggleCount++;
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const blockedEvent = makeKeyboardEvent({ code: 'KeyK', key: 'k' });
  controller.handleKeyDown(blockedEvent);
  assertContract(
    toggleCount === 0,
    'cloak hotkey must not dispatch when the selected units lack BAR-equivalent cloak control',
  );
  assertContract(
    blockedEvent.defaultPrevented,
    'resolved cloak hotkey should still prevent browser defaults even when no selected unit can cloak',
  );

  hasCloakControl = true;
  const allowedEvent = makeKeyboardEvent({ code: 'KeyK', key: 'k' });
  controller.handleKeyDown(allowedEvent);
  assertContract(
    toggleCount === 1,
    'cloak hotkey must dispatch when a BAR-equivalent cloak-capable unit is selected',
  );
  assertContract(
    allowedEvent.defaultPrevented,
    'cloak hotkey dispatch must prevent browser defaults',
  );
}

function runBarNumpadCameraDispatcherContract(): void {
  setActiveCommandHotkeyPresetId('bar-grid');
  const cameraActions: { mode: string; x: number; y: number; fast: boolean }[] = [];
  const controller = new Input3DKeyboardController(new Proxy({
    moveCameraByKeyboard: (action: { mode: string; x: number; y: number; fast: boolean }) => {
      cameraActions.push(action);
    },
  }, {
    get(target, prop: string | symbol) {
      if (prop in target) return target[prop as keyof typeof target];
      return () => false;
    },
  }) as never);

  const fastDownEvent = makeKeyboardEvent({ code: 'Numpad1', key: '1' });
  controller.handleKeyDown(fastDownEvent);
  assertContract(
    cameraActions.length === 0 && fastDownEvent.defaultPrevented,
    'BAR Numpad1 must not pan diagonally; it must remain available for FOV down while enabling movefast',
  );

  const fastPanEvent = makeKeyboardEvent({ code: 'Numpad8', key: '8' });
  controller.handleKeyDown(fastPanEvent);
  assertContract(
    cameraActions.length === 1 &&
      cameraActions[0]?.mode === 'pan' &&
      cameraActions[0]?.x === 0 &&
      cameraActions[0]?.y === 1 &&
      cameraActions[0]?.fast === true &&
      fastPanEvent.defaultPrevented,
    'BAR held Numpad1 movefast must accelerate Numpad8 camera movement',
  );

  controller.handleKeyUp(makeKeyboardEvent({ code: 'Numpad1', key: '1' }));
  const normalPanEvent = makeKeyboardEvent({ code: 'Numpad8', key: '8' });
  controller.handleKeyDown(normalPanEvent);
  assertContract(
    cameraActions.length === 2 && cameraActions[1]?.fast === false,
    'releasing BAR Numpad1 movefast must restore normal numpad camera speed',
  );
}

export function runInput3DKeyboardControllerContractTest(): void {
  const restoreSsrCommandHotkeyStorage = installSsrCommandHotkeyStorage();
  runBarFactoryPresetDispatcherContract();
  runBarAutoGroupPresetDispatcherContract();
  runBarBuildCategoryDispatcherContract();
  runBarBuildCategoryClearContract();
  runBarGridNextPageDispatcherContract();
  runBarFactoryQueueModeContract();
  runBarFactoryGuardDispatcherContract();
  runBarStateTapDispatcherContract();
  runBarSelectionFilterDispatcherContract();
  runBarSelfDestructDispatcherContract();
  runCloakDispatcherContract();
  runBarNumpadCameraDispatcherContract();

  const state = makeState();

  assertContract(
    !recordControlGroupRecallTap(state, 1, 1000),
    'first control-group recall must not focus',
  );
  assertContract(
    recordControlGroupRecallTap(state, 1, 1000 + CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS),
    'same-slot recall inside the double-tap window must focus',
  );
  assertContract(
    !recordControlGroupRecallTap(state, 2, 1200),
    'switching slots must start a new double-tap sequence',
  );
  assertContract(
    !recordControlGroupRecallTap(state, 2, 1200 + CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS + 1),
    'same-slot recall after the double-tap window must not focus',
  );

  resetControlGroupRecallTap(state);
  assertContract(
    !recordControlGroupRecallTap(state, 2, 1300),
    'reset tap state must clear the pending focus sequence',
  );
  assertContract(
    isControlGroupUnsetKey(makeKeyboardEvent({ code: 'Backquote', key: '`', ctrlKey: true }), 'bar-grid'),
    'BAR-grid Ctrl+Backquote must unset selected units from control groups',
  );
  assertContract(
    !isControlGroupUnsetKey(makeKeyboardEvent({ code: 'KeyQ', key: 'q', ctrlKey: true, metaKey: true }), 'bar-grid'),
    'BAR-grid must not accept the 60% Ctrl+Meta+Q group-unset binding',
  );
  assertContract(
    isControlGroupUnsetKey(makeKeyboardEvent({ code: 'KeyQ', key: 'q', ctrlKey: true, metaKey: true }), 'bar-grid-60pct'),
    'BAR-grid 60% Ctrl+Meta+Q must unset selected units from control groups',
  );
  assertContract(
    !isControlGroupUnsetKey(makeKeyboardEvent({ code: 'Backquote', key: '`', ctrlKey: true }), 'bar-grid-60pct'),
    'BAR-grid 60% must not keep the normal Ctrl+Backquote group-unset binding',
  );
  assertContract(
    isAutoGroupRemoveKey(makeKeyboardEvent({ code: 'Backquote', key: '`', altKey: true }), 'bar-legacy'),
    'BAR legacy Alt+Backquote must remove selected units from autogroups',
  );
  assertContract(
    !isAutoGroupRemoveKey(makeKeyboardEvent({ code: 'KeyQ', key: 'q', altKey: true }), 'bar-legacy'),
    'BAR legacy must not accept the 60% Alt+Q autogroup removal binding',
  );
  assertContract(
    isAutoGroupRemoveKey(makeKeyboardEvent({ code: 'KeyQ', key: 'q', altKey: true }), 'bar-legacy-60pct'),
    'BAR legacy 60% Alt+Q must remove selected units from autogroups',
  );
  assertContract(
    !isAutoGroupRemoveKey(makeKeyboardEvent({ code: 'Backquote', key: '`', altKey: true }), 'bar-legacy-60pct'),
    'BAR legacy 60% must not keep the normal Alt+Backquote autogroup removal binding',
  );

  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowUp' }))?.mode === 'pan',
    'plain arrows must pan the camera',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowLeft', ctrlKey: true }), 'prototype')?.mode === 'height-pan',
    'prototype Ctrl + arrows must keep local height-pan camera behavior',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowLeft', ctrlKey: true }), 'bar-grid')?.mode === 'pan',
    'BAR Any+Left must pan instead of using Ctrl as a keyboard height-pan modifier',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowRight', altKey: true }), 'prototype')?.mode === 'orbit',
    'prototype Alt + arrows must keep local keyboard orbit behavior',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowRight', altKey: true }), 'bar-legacy')?.mode === 'pan',
    'BAR Any+Right must pan instead of using Alt as a keyboard orbit modifier',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'Numpad9', shiftKey: true }), 'bar-grid')?.mode === 'height-pan',
    'BAR Numpad9 must move the camera up rather than diagonally panning',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'Numpad3' }), 'bar-grid')?.mode === 'height-pan',
    'BAR Numpad3 must move the camera down rather than diagonally panning',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'PageUp', altKey: true }), 'bar-grid')?.mode === 'height-pan',
    'BAR Any+PageUp must move the camera up instead of orbiting',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'PageDown', ctrlKey: true }), 'bar-grid')?.mode === 'height-pan',
    'BAR Any+PageDown must move the camera down',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'Numpad1' })) === null,
    'BAR Numpad1 must not be claimed as diagonal camera pan because chat_and_ui_keys also binds it to FOV down',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'Numpad7' })) === null,
    'BAR Numpad7 must not be claimed as diagonal camera pan because chat_and_ui_keys binds it to FOV up',
  );
  assertContract(
    cameraKeyboardActionForKey(makeKey({ code: 'ArrowDown', metaKey: true })) === null,
    'Meta + arrows must stay out of keyboard camera handling',
  );

  assertContract(
    barManualFireCommandForKey(
      makeKey({ code: 'KeyD' }),
      {
        presetId: 'bar-grid',
        hasSelectedCommander: true,
        hasSelectedManualLaunchEntities: true,
      },
    ) === 'command.dgun',
    'BAR manual-fire D must prefer commander DGun when a commander is selected',
  );
  assertContract(
    barManualFireCommandForKey(
      makeKey({ code: 'KeyD' }),
      {
        presetId: 'bar-grid',
        hasSelectedCommander: false,
        hasSelectedManualLaunchEntities: true,
      },
    ) === 'combat.manualLaunch',
    'BAR manual-fire D must trigger manual launch when only manual-launch weapons are selected',
  );
  assertContract(
    barManualFireCommandForKey(
      makeKey({ code: 'KeyD' }),
      {
        presetId: 'bar-grid',
        hasSelectedCommander: false,
        hasSelectedManualLaunchEntities: false,
      },
    ) === null,
    'BAR manual-fire D must not trigger manual launch without a manual-fire weapon',
  );
  assertContract(
    barManualFireCommandForKey(
      makeKey({ code: 'KeyD', altKey: true }),
      {
        presetId: 'bar-grid',
        hasSelectedCommander: false,
        hasSelectedManualLaunchEntities: true,
      },
    ) === null,
    'BAR manual-fire D must not consume modified D chords',
  );
  assertContract(
    barManualFireCommandForKey(
      makeKey({ code: 'KeyD' }),
      {
        presetId: 'prototype',
        hasSelectedCommander: false,
        hasSelectedManualLaunchEntities: true,
      },
    ) === null,
    'BAR manual-fire D must not override non-BAR presets',
  );

  assertContract(
    barBuildCategoryForHomeCommandId('build.slot1') === 'Economy',
    'BAR-grid home Z must select the economy build category',
  );
  assertContract(
    barBuildCategoryForHomeCommandId('build.slot4') === 'Production',
    'BAR-grid home V must select the production build category',
  );
  assertContract(
    barBuildCategoryForHomeCommandId('build.slot5') === null,
    'BAR-grid row-2 build keys must not select categories from the home layer',
  );
  assertContract(
    isBarGridNextPageKey(makeKey({ code: 'KeyB' }), 'bar-grid'),
    'BAR-grid plain B must be recognized as the grid next-page key',
  );
  assertContract(
    isBarGridNextPageKey(makeKey({ code: 'KeyB' }), 'bar-grid-60pct'),
    'BAR-grid 60% plain B must retain the grid next-page key',
  );
  assertContract(
    !isBarGridNextPageKey(makeKey({ code: 'KeyB', shiftKey: true }), 'bar-grid'),
    'BAR-grid Shift+B must not trigger the plain grid next-page key',
  );
  assertContract(
    !isBarGridNextPageKey(makeKey({ code: 'KeyB' }), 'prototype'),
    'prototype preset must not consume B as BAR grid next-page',
  );
  assertContract(
    !isBarGridNextPageKey(makeKey({ code: 'KeyB' }), 'bar-legacy'),
    'BAR legacy must not consume B as BAR grid next-page',
  );
  assertContract(
    isBarGridCycleBuilderKey(makeKey({ code: 'Period' }), 'bar-grid'),
    'BAR-grid plain period must be recognized as the active-builder cycle key',
  );
  assertContract(
    isBarGridCycleBuilderKey(makeKey({ code: 'Period' }), 'bar-grid-60pct'),
    'BAR-grid 60% plain period must retain active-builder cycling',
  );
  assertContract(
    !isBarGridCycleBuilderKey(makeKey({ code: 'Period', shiftKey: true }), 'bar-grid'),
    'BAR-grid Shift+Period must not trigger active-builder cycling',
  );
  assertContract(
    !isBarGridCycleBuilderKey(makeKey({ code: 'Period' }), 'prototype'),
    'prototype preset must not consume period as BAR active-builder cycling',
  );
  assertContract(
    !isBarGridCycleBuilderKey(makeKey({ code: 'Period' }), 'bar-legacy'),
    'BAR legacy must not consume period as BAR active-builder cycling',
  );
  assertContract(
    barLegacyBuildKeyForKey(makeKey({ code: 'KeyZ' }), 'bar-legacy') === 'Z',
    'BAR legacy Z must be recognized as the metal/economy buildunit key',
  );
  assertContract(
    barLegacyBuildKeyForKey(makeKey({ code: 'KeyZ' }), 'bar-legacy-60pct') === 'Z',
    'BAR legacy 60% Z must retain the metal/economy buildunit key',
  );
  assertContract(
    barLegacyBuildKeyForKey(makeKey({ code: 'KeyX', shiftKey: true }), 'bar-legacy') === 'X',
    'BAR legacy Shift+X must be recognized as the queued energy buildunit key',
  );
  assertContract(
    barLegacyBuildKeyForKey(makeKey({ code: 'KeyX', altKey: true }), 'bar-legacy') === null,
    'BAR legacy Alt+X must remain build-spacing decrease, not a buildunit key',
  );
  assertContract(
    barLegacyBuildKeyForKey(makeKey({ code: 'KeyZ' }), 'bar-grid') === null,
    'BAR-grid must not use BAR legacy repeated buildunit keys',
  );
  assertContract(
    barLegacyBuildKeyForStructureBlueprintId('buildingExtractor') === 'Z',
    'BAR legacy extractor builds must display/use Z like BAR mex bindings',
  );
  assertContract(
    barLegacyBuildKeyForStructureBlueprintId('buildingSolar') === 'X' &&
      barLegacyBuildKeyForStructureBlueprintId('buildingWind') === 'X' &&
      barLegacyBuildKeyForStructureBlueprintId('buildingResourceConverter') === 'X',
    'BAR legacy energy builds must display/use X',
  );
  assertContract(
    barLegacyBuildKeyForStructureBlueprintId('towerCannon') === 'C' &&
      barLegacyBuildKeyForStructureBlueprintId('buildingRadar') === 'C' &&
      barLegacyBuildKeyForStructureBlueprintId('buildingSonar') === 'C',
    'BAR legacy defense and contact-sensor builds must display/use C',
  );
  assertContract(
    barLegacyBuildKeyForStructureBlueprintId('towerFabricator') === 'V',
    'BAR legacy production builds must display/use V',
  );
  assertContract(
    getBarLegacyBuildMenuStructureBlueprintIdsForKey('X', [
      'buildingExtractor',
      'buildingSolar',
      'buildingWind',
      'towerCannon',
    ]).join(',') === 'buildingSolar,buildingWind',
    'BAR legacy X cycling must include only the matching energy build options in build-menu order',
  );

  assertContract(
    barSupportCommandForKey(
      makeKey({ code: 'KeyW' }),
      {
        presetId: 'bar-grid',
        hasSelectedCaptureControl: true,
        hasSelectedResurrectControl: false,
        isCaptureMode: false,
        isResurrectMode: false,
      },
    ) === 'combat.capture',
    'BAR support W must default to capture for BAR capture-capable selections',
  );
  assertContract(
    barSupportCommandForKey(
      makeKey({ code: 'KeyW' }),
      {
        presetId: 'bar-grid',
        hasSelectedCaptureControl: false,
        hasSelectedResurrectControl: false,
        isCaptureMode: false,
        isResurrectMode: false,
      },
    ) === null,
    'BAR support W must not default to capture without a BAR capture command',
  );
  assertContract(
    barSupportCommandForKey(
      makeKey({ code: 'KeyW' }),
      {
        presetId: 'bar-grid',
        hasSelectedCaptureControl: true,
        hasSelectedResurrectControl: false,
        isCaptureMode: false,
        isResurrectMode: true,
      },
    ) === null,
    'BAR support W must not resurrect when the selection lacks a BAR-equivalent resurrect command',
  );
  assertContract(
    barSupportCommandForKey(
      makeKey({ code: 'KeyW' }),
      {
        presetId: 'bar-grid',
        hasSelectedCaptureControl: true,
        hasSelectedResurrectControl: true,
        isCaptureMode: false,
        isResurrectMode: true,
      },
    ) === 'combat.resurrect',
    'BAR support W may toggle active resurrect mode for a BAR-equivalent resurrect-capable selection',
  );
  assertContract(
    barSupportCommandForKey(
      makeKey({ code: 'KeyW', ctrlKey: true, altKey: true }),
      {
        presetId: 'bar-grid',
        hasSelectedCaptureControl: true,
        hasSelectedResurrectControl: true,
        isCaptureMode: false,
        isResurrectMode: true,
      },
    ) === null,
    'BAR support W must not consume modified resurrect-area chords',
  );
  assertContract(
    barSupportCommandForKey(
      makeKey({ code: 'KeyW' }),
      {
        presetId: 'prototype',
        hasSelectedCaptureControl: true,
        hasSelectedResurrectControl: true,
        isCaptureMode: false,
        isResurrectMode: true,
      },
    ) === null,
    'BAR support W must not override non-BAR presets',
  );

  assertContract(
    barStateTapTargetForKey(
      makeKey({ code: 'KeyB' }),
      {
        presetId: 'bar-grid',
        hasSelectedMoveStateControl: true,
        hasSelectedBuildingActiveControl: true,
        hasSelectedTrajectoryControl: true,
      },
    ) === 'buildingActive',
    'BAR state B must prefer building active state when the selection supports it',
  );
  assertContract(
    barStateTapTargetForKey(
      makeKey({ code: 'KeyB' }),
      {
        presetId: 'bar-grid',
        hasSelectedMoveStateControl: true,
        hasSelectedBuildingActiveControl: false,
        hasSelectedTrajectoryControl: true,
      },
    ) === 'trajectory',
    'BAR state B must trigger trajectory state for ballistic selections without active state',
  );
  assertContract(
    barStateTapTargetForKey(
      makeKey({ code: 'KeyB', ctrlKey: true }),
      {
        presetId: 'bar-grid',
        hasSelectedMoveStateControl: true,
        hasSelectedBuildingActiveControl: true,
        hasSelectedTrajectoryControl: true,
      },
    ) === null,
    'BAR state B must not consume modified B chords',
  );
  assertContract(
    barStateTapTargetForKey(
      makeKey({ code: 'KeyB' }),
      {
        presetId: 'prototype',
        hasSelectedMoveStateControl: true,
        hasSelectedBuildingActiveControl: true,
        hasSelectedTrajectoryControl: true,
      },
    ) === null,
    'BAR state B must not override non-BAR presets',
  );
  assertContract(
    barStateTapTargetForKey(
      makeKey({ code: 'KeyT' }),
      {
        presetId: 'bar-grid',
        hasSelectedMoveStateControl: true,
        hasSelectedBuildingActiveControl: false,
        hasSelectedTrajectoryControl: false,
      },
    ) === 'repeat',
    'BAR state T must target repeat orders',
  );
  assertContract(
    barStateTapTargetForKey(
      makeKey({ code: 'Semicolon', shiftKey: true }),
      {
        presetId: 'bar-grid',
        hasSelectedMoveStateControl: true,
        hasSelectedBuildingActiveControl: false,
        hasSelectedTrajectoryControl: false,
      },
    ) === 'moveState',
    'BAR state semicolon must target move state with or without Shift',
  );
  assertContract(
    barStateTapTargetForKey(
      makeKey({ code: 'Semicolon' }),
      {
        presetId: 'bar-grid',
        hasSelectedMoveStateControl: false,
        hasSelectedBuildingActiveControl: false,
        hasSelectedTrajectoryControl: false,
      },
    ) === null,
    'BAR state semicolon must not target hidden bomber move-state commands',
  );
  const repeatOn = barStateCommandForTap('repeat', 1);
  const repeatOff = barStateCommandForTap('repeat', 2);
  assertContract(
    repeatOn.type === 'repeat' && repeatOn.enabled === true &&
      repeatOff.type === 'repeat' && repeatOff.enabled === false,
    'BAR T taps must map to repeat on/off',
  );

  const buildingOn = barStateCommandForTap('buildingActive', 1);
  const buildingOff = barStateCommandForTap('buildingActive', 2);
  assertContract(
    buildingOn.type === 'buildingActive' && buildingOn.open === true &&
      buildingOff.type === 'buildingActive' && buildingOff.open === false,
    'BAR B taps must map to building on/off',
  );

  const moveRoam = barStateCommandForTap('moveState', 1);
  const moveHold = barStateCommandForTap('moveState', 2);
  const moveManeuver = barStateCommandForTap('moveState', 3);
  assertContract(
    moveRoam.type === 'moveState' && moveRoam.moveState === 'roam' &&
      moveHold.type === 'moveState' && moveHold.moveState === 'holdPosition' &&
      moveManeuver.type === 'moveState' && moveManeuver.moveState === 'maneuver',
    'BAR semicolon taps must map to roam/hold/maneuver',
  );

  const fireAtWill = barStateCommandForTap('fireState', 1);
  const fireHold = barStateCommandForTap('fireState', 2);
  const fireReturn = barStateCommandForTap('fireState', 3);
  assertContract(
    fireAtWill.type === 'fireState' && fireAtWill.fireState === 'fireAtWill' &&
      fireHold.type === 'fireState' && fireHold.fireState === 'holdFire' &&
      fireReturn.type === 'fireState' && fireReturn.fireState === 'returnFire',
    'BAR L taps must map to fire-at-will/hold/return-fire',
  );

  const trajectoryAuto = barStateCommandForTap('trajectory', 1);
  const trajectoryLow = barStateCommandForTap('trajectory', 2);
  const trajectoryHigh = barStateCommandForTap('trajectory', 3);
  assertContract(
    trajectoryAuto.type === 'trajectory' && trajectoryAuto.trajectoryMode === 'auto' &&
      trajectoryLow.type === 'trajectory' && trajectoryLow.trajectoryMode === 'low' &&
      trajectoryHigh.type === 'trajectory' && trajectoryHigh.trajectoryMode === 'high',
    'BAR B trajectory taps must map to auto/low/high',
  );
  restoreSsrCommandHotkeyStorage?.();
}
