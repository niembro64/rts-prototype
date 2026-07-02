import type { ClientCommandSink } from '../input/ClientCommandSink';
import type {
  CombatFireState,
  CombatTrajectoryMode,
  StructureBlueprintId,
  UnitMoveState,
  WaypointType,
} from '../sim/types';
import {
  controlGroupIndexForKey,
  getDefaultBuildModeBuildingBlueprintId,
  handleEscape,
  type CommanderModeController,
} from '../input/helpers';
import {
  BAR_BUILD_CATEGORIES,
  BAR_GRID_COLUMNS,
  BAR_GRID_ROWS,
  barLegacyBuildKeyForKeyboardCode,
  getBarLegacyBuildMenuStructureBlueprintIdsForKey,
  getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex,
  getBarHomeBuildMenuStructureBlueprintIdBySlotIndex,
  type BarBuildCategoryId,
  type BarLegacyBuildKey,
} from '../input/buildMenuLayout';
import {
  CommandHotkeySequenceResolver,
  getActiveCommandHotkeyPresetId,
  isBarCommandHotkeyPreset,
  isBarGridCommandHotkeyPreset,
  isBarLegacyCommandHotkeyPreset,
  resolveCommandHotkey,
  type CommandHotkeyId,
  type CommandHotkeyPresetId,
} from '../input/commandHotkeys';
import {
  factoryProductionKeyModeFromEvent,
  queueModeFromEvent,
  queueModeFromEventIgnoringControlModifiers,
} from '../input/queueModifiers';

type Input3DKeyboardControllerConfig = {
  mode: CommanderModeController;
  commandQueue: ClientCommandSink;
  getTick: () => number;
  getQueueInsertIndex: () => number | null;
  setWaypointMode: (mode: WaypointType) => void;
  toggleFormationAssumeMode: () => void;
  toggleFormationMoveMode: () => void;
  storeControlGroupSlot: (index: number) => void;
  addToControlGroupSlot: (index: number) => void;
  setAutoControlGroupSlot: (index: number) => void;
  loadAutoGroupPreset: (index: number) => void;
  removeSelectedFromAutoControlGroups: () => void;
  recallControlGroupSlot: (index: number, additive: boolean) => boolean;
  toggleControlGroupSlot: (index: number) => boolean;
  unsetSelectedFromControlGroups: () => void;
  focusControlGroupSlot: (index: number) => boolean;
  moveCameraByKeyboard: (action: CameraKeyboardAction) => void;
  hasSelectedUnits: () => boolean;
  hasSelectedFactory: () => boolean;
  hasSelectedBuilder: () => boolean;
  hasSelectedCommander: () => boolean;
  hasSelectedManualLaunchEntities: () => boolean;
  hasSelectedCaptureControl: () => boolean;
  hasSelectedResurrectControl: () => boolean;
  hasSelectedMoveStateControl: () => boolean;
  hasSelectedTrajectoryControl: () => boolean;
  hasSelectedCloakControl: () => boolean;
  hasSelectedBuildingActiveControl: () => boolean;
  getBuildGridCategory: () => BarBuildCategoryId | null;
  setBuildGridCategory: (categoryId: BarBuildCategoryId | null) => void;
  getBuildGridPage: () => number;
  stepBuildGridPage: (delta: number) => boolean;
  stepFactoryGridPage: (delta: number) => boolean;
  getFactoryQueueMode: () => boolean;
  toggleFactoryQueueMode: () => void;
  getSelectedFactoryRepeatProduction: () => boolean;
  toggleSelectedFactoryRepeatProduction: () => void;
  setSelectedFactoryRepeatProduction: (enabled: boolean) => void;
  toggleSelectedFactoryAirIdleState: () => void;
  cycleActiveBuilder: () => boolean;
  getSelectedBuilderAllowedBuildBlueprintIds: () => readonly StructureBlueprintId[];
  setBuildMode: (buildingBlueprintId: StructureBlueprintId) => void;
  queueSelectedFactoryUnitSlot: (slotIndex: number, repeat: boolean, count: number) => boolean;
  changeSelectedFactoryUnitSlotQuota: (slotIndex: number, delta: number) => boolean;
  exitSpecialModes: (includeTowerTarget?: boolean) => void;
  increaseBuildLineSpacing: () => void;
  decreaseBuildLineSpacing: () => void;
  rotateBuildFacingClockwise: () => void;
  rotateBuildFacingCounterClockwise: () => void;
  stopSelectedUnits: () => void;
  skipCurrentOrder: () => void;
  removeLastQueuedOrder: () => void;
  clearQueuedOrders: () => void;
  toggleSelectedWait: (queue: boolean, queueFront?: boolean, queueInsertIndex?: number) => void;
  toggleSelectedGatherWait: (queue: boolean, queueFront?: boolean, queueInsertIndex?: number) => void;
  toggleRepeatQueue: () => void;
  setRepeatQueueEnabled: (enabled: boolean) => void;
  toggleBuilderPriority: () => void;
  toggleCarrierSpawn: () => void;
  setSelectedFactoryGuardEnabled: (enabled: boolean) => void;
  toggleSelectedFactoryGuard: () => void;
  stopSelectedFactoryProduction: () => void;
  toggleUnitMoveState: () => void;
  setUnitMoveState: (moveState: UnitMoveState) => void;
  toggleTrajectoryMode: () => void;
  setTrajectoryMode: (trajectoryMode: CombatTrajectoryMode) => void;
  toggleCloakState: () => void;
  toggleSelectedFire: () => void;
  setSelectedFireState: (fireState: CombatFireState) => void;
  toggleBuildingActive: () => void;
  setBuildingActive: (open: boolean) => void;
  selfDestructSelected: (queue?: boolean, queueFront?: boolean, queueInsertIndex?: number) => void;
  toggleTowerTargetMode: () => void;
  toggleTowerTargetNoGroundMode: () => void;
  clearTowerTarget: () => void;
  toggleAttackMode: () => void;
  toggleAttackAreaMode: () => void;
  toggleAttackGroundMode: () => void;
  toggleManualLaunchMode: () => void;
  toggleGuardMode: () => void;
  toggleReclaimMode: () => void;
  toggleCaptureMode: () => void;
  toggleResurrectMode: () => void;
  toggleResurrectAreaMode: () => void;
  toggleLoadTransportMode: () => void;
  toggleUnloadTransportMode: () => void;
  toggleMexUpgradeMode: () => void;
  upgradeSelectedMetalExtractors: () => void;
  toggleRepairAreaMode: () => void;
  toggleRestoreAreaMode: () => void;
  togglePingMode: () => void;
  toggleDGunMode: () => void;
  enqueueScanAtCursor: () => void;
  loadFactoryProductionPreset: (index: number) => void;
  saveFactoryProductionPreset: (index: number) => void;
  selectActiveCommander: (additive: boolean) => void;
  selectAllOwnedUnits: () => void;
  selectAllMatching: () => void;
  selectAllMatchingInView: () => void;
  selectPreviousSelection: () => void;
  selectPreviousSelectionNotInControlGroups: () => void;
  selectPreviousNonBuildersNotInControlGroups: () => void;
  selectGroundWeaponUnits: () => void;
  selectIdleBuilders: () => void;
  selectIdleTransports: () => void;
  selectWaitingUnits: () => void;
  selectSameTypeOnly: () => void;
  selectMobileOnly: () => void;
  selectDamagedOnly: () => void;
  invertSelection: () => void;
  splitArmySelection: () => void;
  loopSelection: () => void;
  isRepairAreaMode: () => boolean;
  isRestoreAreaMode: () => boolean;
  isAttackMode: () => boolean;
  isAttackAreaMode: () => boolean;
  isAttackGroundMode: () => boolean;
  isManualLaunchMode: () => boolean;
  isGuardMode: () => boolean;
  isReclaimMode: () => boolean;
  isCaptureMode: () => boolean;
  isResurrectMode: () => boolean;
  isResurrectAreaMode: () => boolean;
  isLoadTransportMode: () => boolean;
  isUnloadTransportMode: () => boolean;
  isMexUpgradeMode: () => boolean;
  isPingMode: () => boolean;
  isTowerTargetMode: () => boolean;
  isTowerTargetNoGroundMode: () => boolean;
  exitRepairAreaMode: () => void;
  exitRestoreAreaMode: () => void;
  exitAttackMode: () => void;
  exitAttackAreaMode: () => void;
  exitAttackGroundMode: () => void;
  exitManualLaunchMode: () => void;
  exitGuardMode: () => void;
  exitReclaimMode: () => void;
  exitCaptureMode: () => void;
  exitResurrectMode: () => void;
  exitResurrectAreaMode: () => void;
  exitLoadTransportMode: () => void;
  exitUnloadTransportMode: () => void;
  exitMexUpgradeMode: () => void;
  exitPingMode: () => void;
  exitTowerTargetMode: () => void;
  exitTowerTargetNoGroundMode: () => void;
};

const AREA_MEX_BLUEPRINT_ID: StructureBlueprintId = 'buildingExtractor';

function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(element?.isContentEditable);
}

export function isControlGroupUnsetKey(
  e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  presetId: CommandHotkeyPresetId,
): boolean {
  if (presetId === 'bar-grid-60pct' || presetId === 'bar-legacy-60pct') {
    return e.ctrlKey && e.metaKey && !e.shiftKey && !e.altKey && e.code === 'KeyQ';
  }
  if (isBarCommandHotkeyPreset(presetId)) {
    return e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (e.code === 'Backquote' || e.key === '`');
  }
  return (e.ctrlKey || e.metaKey)
    && !e.shiftKey
    && !e.altKey
    && (e.code === 'Backquote' || e.key === '`');
}

export function isAutoGroupRemoveKey(
  e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  presetId: CommandHotkeyPresetId,
): boolean {
  if (presetId === 'bar-grid-60pct' || presetId === 'bar-legacy-60pct') {
    return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyQ';
  }
  if (isBarCommandHotkeyPreset(presetId)) {
    return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'Backquote' || e.key === '`');
  }
  return e.altKey
    && !e.ctrlKey
    && !e.metaKey
    && !e.shiftKey
    && (e.code === 'Backquote' || e.key === '`' || e.code === 'KeyQ');
}

export function isAutoGroupPresetLoadKey(
  e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  presetId: CommandHotkeyPresetId,
): boolean {
  return isBarCommandHotkeyPreset(presetId) &&
    e.altKey &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    controlGroupIndexForKey(e) >= 0;
}

type BarManualFireKeyEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'metaKey' | 'altKey'
>;

type BarManualFireSelectionContext = {
  presetId: CommandHotkeyPresetId;
  hasSelectedCommander: boolean;
  hasSelectedManualLaunchEntities: boolean;
};

export function barManualFireCommandForKey(
  e: BarManualFireKeyEvent,
  context: BarManualFireSelectionContext,
): CommandHotkeyId | null {
  if (!isBarCommandHotkeyPreset(context.presetId)) return null;
  if (e.code !== 'KeyD' || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (context.hasSelectedCommander) return 'command.dgun';
  return context.hasSelectedManualLaunchEntities ? 'combat.manualLaunch' : null;
}

type BarSupportKeyEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'metaKey' | 'altKey'
>;

type BarSupportSelectionContext = {
  presetId: CommandHotkeyPresetId;
  hasSelectedCaptureControl: boolean;
  hasSelectedResurrectControl: boolean;
  isCaptureMode: boolean;
  isResurrectMode: boolean;
};

export function barSupportCommandForKey(
  e: BarSupportKeyEvent,
  context: BarSupportSelectionContext,
): CommandHotkeyId | null {
  if (!isBarGridCommandHotkeyPreset(context.presetId)) return null;
  if (e.code !== 'KeyW' || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (context.isResurrectMode) {
    return context.hasSelectedResurrectControl ? 'combat.resurrect' : null;
  }
  if (context.isCaptureMode) return 'combat.capture';
  return context.hasSelectedCaptureControl ? 'combat.capture' : null;
}

type BarStateKeyEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

type BarStateSelectionContext = {
  presetId: CommandHotkeyPresetId;
  hasSelectedMoveStateControl: boolean;
  hasSelectedTrajectoryControl: boolean;
  hasSelectedBuildingActiveControl: boolean;
};

export type BarStateTapTarget =
  | 'repeat'
  | 'factoryGuard'
  | 'moveState'
  | 'fireState'
  | 'buildingActive'
  | 'trajectory';

export type BarStateTapCommand =
  | { type: 'repeat'; enabled: boolean }
  | { type: 'factoryGuard'; enabled: boolean }
  | { type: 'moveState'; moveState: UnitMoveState }
  | { type: 'fireState'; fireState: CombatFireState }
  | { type: 'buildingActive'; open: boolean }
  | { type: 'trajectory'; trajectoryMode: CombatTrajectoryMode };

export function barStateTapTargetForKey(
  e: BarStateKeyEvent,
  context: BarStateSelectionContext,
): BarStateTapTarget | null {
  if (!isBarGridCommandHotkeyPreset(context.presetId)) return null;
  if (e.code === 'KeyG' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return 'factoryGuard';
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.code) {
    case 'KeyT':
      return 'repeat';
    case 'Semicolon':
      return context.hasSelectedMoveStateControl ? 'moveState' : null;
    case 'KeyL':
      return 'fireState';
    case 'KeyB':
      if (context.hasSelectedBuildingActiveControl) return 'buildingActive';
      return context.hasSelectedTrajectoryControl ? 'trajectory' : null;
    default:
      return null;
  }
}

export function barStateCommandForTap(
  target: BarStateTapTarget,
  tapCount: number,
): BarStateTapCommand {
  const count = Math.max(1, Math.floor(tapCount));
  switch (target) {
    case 'repeat':
      return { type: 'repeat', enabled: count === 1 };
    case 'factoryGuard':
      return { type: 'factoryGuard', enabled: count === 1 };
    case 'buildingActive':
      return { type: 'buildingActive', open: count === 1 };
    case 'moveState':
      return {
        type: 'moveState',
        moveState: count === 1 ? 'roam' : count === 2 ? 'holdPosition' : 'maneuver',
      };
    case 'fireState':
      return {
        type: 'fireState',
        fireState: count === 1 ? 'fireAtWill' : count === 2 ? 'holdFire' : 'returnFire',
      };
    case 'trajectory':
      return {
        type: 'trajectory',
        trajectoryMode: count === 1 ? 'auto' : count === 2 ? 'low' : 'high',
      };
  }
}

function barStateTapMaxCount(target: BarStateTapTarget): number {
  return target === 'repeat' || target === 'buildingActive' || target === 'factoryGuard' ? 2 : 3;
}

export type CameraKeyboardActionMode = 'pan' | 'height-pan' | 'orbit';

export type CameraKeyboardAction = {
  mode: CameraKeyboardActionMode;
  x: number;
  y: number;
  fast: boolean;
};

type CameraKeyboardEvent = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

export function cameraKeyboardActionForKey(
  e: CameraKeyboardEvent,
  presetId: CommandHotkeyPresetId = getActiveCommandHotkeyPresetId(),
): CameraKeyboardAction | null {
  if (e.metaKey) return null;
  let x = 0;
  let y = 0;
  let forcedMode: CameraKeyboardActionMode | null = null;
  let arrowPan = false;
  switch (e.code) {
    case 'ArrowUp':
      arrowPan = true;
      y = 1;
      break;
    case 'Numpad8':
      y = 1;
      break;
    case 'ArrowDown':
      arrowPan = true;
      y = -1;
      break;
    case 'Numpad2':
      y = -1;
      break;
    case 'ArrowLeft':
      arrowPan = true;
      x = -1;
      break;
    case 'Numpad4':
      x = -1;
      break;
    case 'ArrowRight':
      arrowPan = true;
      x = 1;
      break;
    case 'Numpad6':
      x = 1;
      break;
    case 'Numpad9':
    case 'PageUp':
      y = 1;
      forcedMode = 'height-pan';
      break;
    case 'Numpad3':
    case 'PageDown':
      y = -1;
      forcedMode = 'height-pan';
      break;
    default:
      return null;
  }
  if (arrowPan && isBarCommandHotkeyPreset(presetId)) forcedMode = 'pan';
  return {
    mode: forcedMode ?? (e.altKey ? 'orbit' : e.ctrlKey ? 'height-pan' : 'pan'),
    x,
    y,
    fast: false,
  };
}

function buildSlotIndexForCommandId(commandId: CommandHotkeyId): number {
  switch (commandId) {
    case 'build.slot1': return 0;
    case 'build.slot2': return 1;
    case 'build.slot3': return 2;
    case 'build.slot4': return 3;
    case 'build.slot5': return 4;
    case 'build.slot6': return 5;
    case 'build.slot7': return 6;
    case 'build.slot8': return 7;
    case 'build.slot9': return 8;
    case 'build.slot10': return 9;
    case 'build.slot11': return 10;
    case 'build.slot12': return 11;
    default: return -1;
  }
}

function factoryPresetLoadIndexForCommandId(commandId: CommandHotkeyId): number {
  switch (commandId) {
    case 'factoryPreset.load1': return 0;
    case 'factoryPreset.load2': return 1;
    case 'factoryPreset.load3': return 2;
    case 'factoryPreset.load4': return 3;
    case 'factoryPreset.load5': return 4;
    case 'factoryPreset.load6': return 5;
    case 'factoryPreset.load7': return 6;
    case 'factoryPreset.load8': return 7;
    case 'factoryPreset.load9': return 8;
    case 'factoryPreset.load10': return 9;
    default: return -1;
  }
}

function factoryPresetSaveIndexForCommandId(commandId: CommandHotkeyId): number {
  switch (commandId) {
    case 'factoryPreset.save1': return 0;
    case 'factoryPreset.save2': return 1;
    case 'factoryPreset.save3': return 2;
    case 'factoryPreset.save4': return 3;
    case 'factoryPreset.save5': return 4;
    case 'factoryPreset.save6': return 5;
    case 'factoryPreset.save7': return 6;
    case 'factoryPreset.save8': return 7;
    case 'factoryPreset.save9': return 8;
    case 'factoryPreset.save10': return 9;
    default: return -1;
  }
}

export function barBuildCategoryForHomeCommandId(commandId: CommandHotkeyId): BarBuildCategoryId | null {
  const slotIndex = buildSlotIndexForCommandId(commandId);
  if (slotIndex < 0 || slotIndex >= BAR_BUILD_CATEGORIES.length) return null;
  return BAR_BUILD_CATEGORIES[slotIndex]?.id ?? null;
}

function isPlainBuildCategoryKey(e: KeyboardEvent): boolean {
  return !e.altKey && !e.ctrlKey && !e.metaKey;
}

function isBarBuilderCategoryGridModifierKey(e: KeyboardEvent): boolean {
  return e.altKey || e.ctrlKey || e.metaKey;
}

export function isBarGridNextPageKey(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  presetId: CommandHotkeyPresetId,
): boolean {
  return isBarGridCommandHotkeyPreset(presetId)
    && e.code === 'KeyB'
    && !e.ctrlKey
    && !e.metaKey
    && !e.altKey
    && !e.shiftKey;
}

export function isBarGridCycleBuilderKey(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  presetId: CommandHotkeyPresetId,
): boolean {
  return isBarGridCommandHotkeyPreset(presetId)
    && e.code === 'Period'
    && !e.ctrlKey
    && !e.metaKey
    && !e.altKey
    && !e.shiftKey;
}

export function barLegacyBuildKeyForKey(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  presetId: CommandHotkeyPresetId,
): BarLegacyBuildKey | null {
  if (!isBarLegacyCommandHotkeyPreset(presetId)) return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  return barLegacyBuildKeyForKeyboardCode(e.code);
}

export const CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS = 500;
const BUILD_COLUMN_CYCLE_TAP_MS = 1500;

export type ControlGroupRecallTapState = {
  index: number;
  timeMs: number;
};

type BuildColumnCycleTapState = {
  slotIndex: number;
  timeMs: number;
  cycleIndex: number;
};

type BarLegacyBuildKeyCycleTapState = {
  key: BarLegacyBuildKey;
  timeMs: number;
  cycleIndex: number;
};

type BarStateTapState = {
  target: BarStateTapTarget;
  count: number;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

const BAR_STATE_TAP_WINDOW_MS = 260;

export function resetControlGroupRecallTap(state: ControlGroupRecallTapState): void {
  state.index = -1;
  state.timeMs = Number.NEGATIVE_INFINITY;
}

export function recordControlGroupRecallTap(
  state: ControlGroupRecallTapState,
  index: number,
  timeMs: number,
): boolean {
  const elapsedMs = timeMs - state.timeMs;
  const shouldFocus =
    state.index === index
    && elapsedMs >= 0
    && elapsedMs <= CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS;
  state.index = index;
  state.timeMs = timeMs;
  return shouldFocus;
}

export class Input3DKeyboardController {
  private readonly config: Input3DKeyboardControllerConfig;
  private readonly commandHotkeys = new CommandHotkeySequenceResolver();
  private readonly controlGroupRecallTap: ControlGroupRecallTapState = {
    index: -1,
    timeMs: Number.NEGATIVE_INFINITY,
  };
  private buildColumnCycleTap: BuildColumnCycleTapState | null = null;
  private barLegacyBuildKeyTap: BarLegacyBuildKeyCycleTapState | null = null;
  private barStateTap: BarStateTapState | null = null;
  private cameraMoveFastHeld = false;

  constructor(config: Input3DKeyboardControllerConfig) {
    this.config = config;
  }

  handleKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Numpad1') this.cameraMoveFastHeld = false;
    if (isTextEntryTarget(e.target)) return;
    if (
      e.code === 'ShiftLeft' &&
      isBarGridCommandHotkeyPreset(getActiveCommandHotkeyPresetId()) &&
      this.config.getBuildGridCategory() !== null
    ) {
      this.clearBuildGridCategory();
    }
  }

  handleKeyDown(e: KeyboardEvent): void {
    if (isTextEntryTarget(e.target)) return;

    const activeCommandPresetId = getActiveCommandHotkeyPresetId();
    const isBarPreset = isBarCommandHotkeyPreset(activeCommandPresetId);
    if (
      isBarPreset &&
      e.code === 'Numpad1' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      this.cameraMoveFastHeld = true;
    }

    const cameraAction = cameraKeyboardActionForKey(e, activeCommandPresetId);
    if (cameraAction !== null) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.config.moveCameraByKeyboard({
        ...cameraAction,
        fast: cameraAction.fast || this.cameraMoveFastHeld,
      });
      return;
    }

    if (e.repeat) return;

    if (isControlGroupUnsetKey(e, activeCommandPresetId)) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.config.unsetSelectedFromControlGroups();
      return;
    }

    if (isAutoGroupRemoveKey(e, activeCommandPresetId)) {
      e.preventDefault();
      this.commandHotkeys.reset();
      resetControlGroupRecallTap(this.controlGroupRecallTap);
      this.config.removeSelectedFromAutoControlGroups();
      return;
    }

    const controlGroupIndex = controlGroupIndexForKey(e);
    if (controlGroupIndex >= 0) {
      if (isAutoGroupPresetLoadKey(e, activeCommandPresetId)) {
        e.preventDefault();
        this.commandHotkeys.reset();
        resetControlGroupRecallTap(this.controlGroupRecallTap);
        this.config.loadAutoGroupPreset(controlGroupIndex);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        this.commandHotkeys.reset();
        resetControlGroupRecallTap(this.controlGroupRecallTap);
        this.config.setAutoControlGroupSlot(controlGroupIndex);
        return;
      }
      if (e.ctrlKey || (!isBarPreset && e.metaKey)) {
        e.preventDefault();
        this.commandHotkeys.reset();
        resetControlGroupRecallTap(this.controlGroupRecallTap);
        if (e.altKey) {
          this.config.toggleControlGroupSlot(controlGroupIndex);
        } else if (e.shiftKey) {
          this.config.addToControlGroupSlot(controlGroupIndex);
        } else {
          this.config.storeControlGroupSlot(controlGroupIndex);
        }
        return;
      }
      if (e.altKey && (!isBarPreset || !e.metaKey)) return;
      if (
        !(isBarPreset && e.metaKey)
        && this.config.recallControlGroupSlot(controlGroupIndex, e.shiftKey)
      ) {
        e.preventDefault();
        this.commandHotkeys.reset();
        if (e.shiftKey) {
          resetControlGroupRecallTap(this.controlGroupRecallTap);
        } else if (recordControlGroupRecallTap(
          this.controlGroupRecallTap,
          controlGroupIndex,
          e.timeStamp,
        )) {
          this.config.focusControlGroupSlot(controlGroupIndex);
        }
        return;
      }
    }

    if (isBarGridCycleBuilderKey(e, activeCommandPresetId) && this.config.hasSelectedBuilder()) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.config.cycleActiveBuilder();
      return;
    }
    if (isBarGridNextPageKey(e, activeCommandPresetId)) {
      const advancedPage = this.config.hasSelectedBuilder()
        ? this.config.stepBuildGridPage(1)
        : !this.config.hasSelectedUnits() && this.config.hasSelectedFactory()
          ? this.config.stepFactoryGridPage(1)
          : false;
      if (advancedPage) {
        e.preventDefault();
        this.commandHotkeys.reset();
        return;
      }
    }

    const barLegacyBuildKey = this.config.hasSelectedBuilder()
      ? barLegacyBuildKeyForKey(e, activeCommandPresetId)
      : null;
    if (
      barLegacyBuildKey !== null &&
      this.enterBarLegacyBuildKey(barLegacyBuildKey, e.timeStamp)
    ) {
      e.preventDefault();
      this.commandHotkeys.reset();
      return;
    }

    const stateTapTarget = barStateTapTargetForKey(e, {
      presetId: activeCommandPresetId,
      hasSelectedMoveStateControl: this.config.hasSelectedMoveStateControl(),
      hasSelectedTrajectoryControl: this.config.hasSelectedTrajectoryControl(),
      hasSelectedBuildingActiveControl: this.config.hasSelectedBuildingActiveControl(),
    });
    if (stateTapTarget === null) this.flushBarStateTap();

    const buildMenuCommandId = this.config.hasSelectedBuilder()
      ? resolveCommandHotkey(e, activeCommandPresetId, 'buildMenu')
      : null;
    const buildSlotIndex = buildMenuCommandId === null ? -1 : buildSlotIndexForCommandId(buildMenuCommandId);
    if (
      buildMenuCommandId !== null &&
      isBarGridCommandHotkeyPreset(activeCommandPresetId) &&
      this.config.getBuildGridCategory() === null &&
      isPlainBuildCategoryKey(e)
    ) {
      const categoryId = barBuildCategoryForHomeCommandId(buildMenuCommandId);
      if (categoryId !== null) {
        e.preventDefault();
        this.commandHotkeys.reset();
        this.config.setBuildGridCategory(categoryId);
        this.enterFirstBuildOptionForCategory(categoryId);
        return;
      }
    }
    const shouldTryBuildSlot = !(
      buildSlotIndex >= 0 &&
      isBarGridCommandHotkeyPreset(activeCommandPresetId) &&
      this.config.getBuildGridCategory() === null
    );
    const shouldSuppressBarBuilderCategorySlot =
      buildSlotIndex >= 0 &&
      isBarGridCommandHotkeyPreset(activeCommandPresetId) &&
      this.config.getBuildGridCategory() !== null &&
      isBarBuilderCategoryGridModifierKey(e);
    if (
      shouldTryBuildSlot &&
      !shouldSuppressBarBuilderCategorySlot &&
      buildSlotIndex >= 0 &&
      this.enterBuildSlot(buildSlotIndex)
    ) {
      e.preventDefault();
      this.commandHotkeys.reset();
      return;
    }

    const factoryBuildMenuCommandId =
      !this.config.hasSelectedUnits() && this.config.hasSelectedFactory()
        ? resolveCommandHotkey(e, activeCommandPresetId, 'buildMenu')
        : null;
    const factoryBuildSlotIndex = factoryBuildMenuCommandId === null
      ? -1
      : buildSlotIndexForCommandId(factoryBuildMenuCommandId);
    const productionMode = factoryBuildSlotIndex >= 0
      ? factoryProductionKeyModeFromEvent(e, this.config.getSelectedFactoryRepeatProduction())
      : null;
    if (
      factoryBuildSlotIndex >= 0 &&
      productionMode !== null &&
      (
        this.config.getFactoryQueueMode() && !e.altKey
          ? this.config.changeSelectedFactoryUnitSlotQuota(factoryBuildSlotIndex, productionMode.count)
          : this.config.queueSelectedFactoryUnitSlot(
            factoryBuildSlotIndex,
            productionMode.repeat,
            productionMode.count,
          )
      )
    ) {
      e.preventDefault();
      this.commandHotkeys.reset();
      return;
    }

    const factoryCommandId =
      !this.config.hasSelectedUnits() && this.config.hasSelectedFactory()
        ? resolveCommandHotkey(e, activeCommandPresetId, 'factory')
        : null;
    if (factoryCommandId !== null) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.runCommandHotkey(factoryCommandId, e);
      return;
    }

    const manualFireCommandId = barManualFireCommandForKey(e, {
      presetId: activeCommandPresetId,
      hasSelectedCommander: this.config.hasSelectedCommander(),
      hasSelectedManualLaunchEntities: this.config.hasSelectedManualLaunchEntities(),
    });
    if (manualFireCommandId !== null) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.runCommandHotkey(manualFireCommandId, e);
      return;
    }

    const supportCommandId = barSupportCommandForKey(e, {
      presetId: activeCommandPresetId,
      hasSelectedCaptureControl: this.config.hasSelectedCaptureControl(),
      hasSelectedResurrectControl: this.config.hasSelectedResurrectControl(),
      isCaptureMode: this.config.isCaptureMode(),
      isResurrectMode: this.config.isResurrectMode(),
    });
    if (supportCommandId !== null) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.runCommandHotkey(supportCommandId, e);
      return;
    }

    if (stateTapTarget !== null) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.recordBarStateTap(stateTapTarget);
      return;
    }

    const hotkey = this.commandHotkeys.resolve(e, activeCommandPresetId);
    if (hotkey.pending) {
      e.preventDefault();
      return;
    }
    if (hotkey.commandId !== null) {
      e.preventDefault();
      this.runCommandHotkey(hotkey.commandId, e);
      return;
    }

    if (e.key.toLowerCase() === 'escape') {
      this.commandHotkeys.reset();
      this.handleEscape();
    }
  }

  private recordBarStateTap(target: BarStateTapTarget): void {
    if (this.barStateTap !== null && this.barStateTap.target !== target) {
      this.flushBarStateTap();
    }

    if (this.barStateTap === null) {
      this.barStateTap = {
        target,
        count: 1,
        timeoutId: null,
      };
    } else {
      this.barStateTap.count++;
    }

    if (this.barStateTap.timeoutId !== null) {
      clearTimeout(this.barStateTap.timeoutId);
      this.barStateTap.timeoutId = null;
    }

    if (this.barStateTap.count >= barStateTapMaxCount(target)) {
      this.flushBarStateTap();
      return;
    }

    this.barStateTap.timeoutId = setTimeout(() => {
      this.flushBarStateTap();
    }, BAR_STATE_TAP_WINDOW_MS);
  }

  private flushBarStateTap(): void {
    const tap = this.barStateTap;
    if (tap === null) return;
    if (tap.timeoutId !== null) clearTimeout(tap.timeoutId);
    this.barStateTap = null;
    this.runBarStateTapCommand(barStateCommandForTap(tap.target, tap.count));
  }

  private runBarStateTapCommand(command: BarStateTapCommand): void {
    switch (command.type) {
      case 'repeat':
        if (this.config.hasSelectedFactory() && !this.config.hasSelectedUnits()) {
          this.config.setSelectedFactoryRepeatProduction(command.enabled);
        } else {
          this.config.setRepeatQueueEnabled(command.enabled);
        }
        break;
      case 'factoryGuard':
        this.config.setSelectedFactoryGuardEnabled(command.enabled);
        break;
      case 'moveState':
        this.config.setUnitMoveState(command.moveState);
        break;
      case 'fireState':
        this.config.setSelectedFireState(command.fireState);
        break;
      case 'buildingActive':
        this.config.setBuildingActive(command.open);
        break;
      case 'trajectory':
        this.config.setTrajectoryMode(command.trajectoryMode);
        break;
    }
  }

  private runCommandHotkey(commandId: CommandHotkeyId, e: KeyboardEvent): void {
    const factoryPresetLoadIndex = factoryPresetLoadIndexForCommandId(commandId);
    if (factoryPresetLoadIndex >= 0) {
      this.config.loadFactoryProductionPreset(factoryPresetLoadIndex);
      return;
    }
    const factoryPresetSaveIndex = factoryPresetSaveIndexForCommandId(commandId);
    if (factoryPresetSaveIndex >= 0) {
      this.config.saveFactoryProductionPreset(factoryPresetSaveIndex);
      return;
    }

    switch (commandId) {
      case 'waypoint.move':
        this.config.setWaypointMode('move');
        break;
      case 'waypoint.fight':
        this.config.setWaypointMode('fight');
        break;
      case 'waypoint.patrol':
        this.config.setWaypointMode('patrol');
        break;
      case 'formation.assume':
        this.config.toggleFormationAssumeMode();
        break;
      case 'formation.move':
        this.config.toggleFormationMoveMode();
        break;
      case 'command.stop':
        this.config.stopSelectedUnits();
        break;
      case 'command.skipCurrent':
        this.config.skipCurrentOrder();
        break;
      case 'command.undoQueue':
        this.config.removeLastQueuedOrder();
        break;
      case 'command.clearQueue':
        this.config.clearQueuedOrders();
        break;
      case 'command.wait':
        {
          const queueMode = queueModeFromEvent(e, this.config.getQueueInsertIndex());
          this.config.toggleSelectedWait(queueMode.queue, queueMode.queueFront, queueMode.queueInsertIndex);
        }
        break;
      case 'command.gatherWait':
        {
          const queueMode = queueModeFromEvent(e, this.config.getQueueInsertIndex());
          this.config.toggleSelectedGatherWait(queueMode.queue, queueMode.queueFront, queueMode.queueInsertIndex);
        }
        break;
      case 'command.repeat':
        if (this.config.hasSelectedFactory() && !this.config.hasSelectedUnits()) {
          this.config.toggleSelectedFactoryRepeatProduction();
        } else {
          this.config.toggleRepeatQueue();
        }
        break;
      case 'command.factoryGuard':
        this.config.toggleSelectedFactoryGuard();
        break;
      case 'command.builderPriority':
        this.config.toggleBuilderPriority();
        break;
      case 'command.carrierSpawn':
        this.config.toggleCarrierSpawn();
        break;
      case 'command.moveState':
        this.config.toggleUnitMoveState();
        break;
      case 'command.trajectoryToggle':
        this.config.toggleTrajectoryMode();
        break;
      case 'command.cloak':
        if (this.config.hasSelectedCloakControl()) this.config.toggleCloakState();
        break;
      case 'command.fireToggle':
        this.config.toggleSelectedFire();
        break;
      case 'command.buildingActive':
        this.config.toggleBuildingActive();
        break;
      case 'command.selfDestruct':
        {
          const queueMode = isBarCommandHotkeyPreset(getActiveCommandHotkeyPresetId())
            ? queueModeFromEventIgnoringControlModifiers(e, this.config.getQueueInsertIndex())
            : queueModeFromEvent(e, this.config.getQueueInsertIndex());
          this.config.selfDestructSelected(queueMode.queue, queueMode.queueFront, queueMode.queueInsertIndex);
        }
        break;
      case 'combat.towerTargetSet':
        this.config.toggleTowerTargetMode();
        break;
      case 'combat.towerTargetSetNoGround':
        this.config.toggleTowerTargetNoGroundMode();
        break;
      case 'combat.towerTargetClear':
        this.config.clearTowerTarget();
        break;
      case 'combat.attack':
        this.config.toggleAttackMode();
        break;
      case 'combat.attackLine':
        this.config.setWaypointMode('fight');
        break;
      case 'combat.attackArea':
        this.config.toggleAttackAreaMode();
        break;
      case 'combat.attackGround':
        this.config.toggleAttackGroundMode();
        break;
      case 'combat.manualLaunch':
        this.config.toggleManualLaunchMode();
        break;
      case 'combat.guard':
        this.config.toggleGuardMode();
        break;
      case 'combat.reclaim':
        this.config.toggleReclaimMode();
        break;
      case 'combat.capture':
        this.config.toggleCaptureMode();
        break;
      case 'combat.resurrect':
        this.config.toggleResurrectMode();
        break;
      case 'combat.resurrectArea':
        this.config.toggleResurrectAreaMode();
        break;
      case 'combat.loadTransport':
        this.config.toggleLoadTransportMode();
        break;
      case 'combat.unloadTransport':
        this.config.toggleUnloadTransportMode();
        break;
      case 'command.morph':
      case 'command.upgradeMexSelected':
        this.config.upgradeSelectedMetalExtractors();
        break;
      case 'command.upgradeMexArea':
        this.config.toggleMexUpgradeMode();
        break;
      case 'command.areaMex':
        if (
          this.config.hasSelectedBuilder() &&
          this.config.getSelectedBuilderAllowedBuildBlueprintIds().includes(AREA_MEX_BLUEPRINT_ID)
        ) {
          this.config.setBuildMode(AREA_MEX_BLUEPRINT_ID);
        }
        break;
      case 'combat.repair':
        this.config.toggleRepairAreaMode();
        break;
      case 'combat.restore':
        this.config.toggleRestoreAreaMode();
        break;
      case 'combat.ping':
        this.config.togglePingMode();
        break;
      case 'command.scan':
        this.config.enqueueScanAtCursor();
        break;
      case 'command.buildCycle':
        if (!this.config.hasSelectedBuilder()) break;
        this.config.exitSpecialModes(false);
        if (!this.config.mode.isInBuildMode) {
          this.config.mode.enterBuildMode(getDefaultBuildModeBuildingBlueprintId());
        } else {
          this.config.mode.cycleBuildingBlueprintId();
        }
        break;
      case 'command.dgun':
        this.config.toggleDGunMode();
        break;
      case 'command.selectCommander':
        this.config.selectActiveCommander(e.shiftKey);
        break;
      case 'factory.stopProduction':
        this.config.stopSelectedFactoryProduction();
        break;
      case 'factory.queueMode':
        this.config.toggleFactoryQueueMode();
        break;
      case 'factory.airIdleState':
        this.config.toggleSelectedFactoryAirIdleState();
        break;
      case 'build.slot1':
        this.enterBuildSlot(0);
        break;
      case 'build.slot2':
        this.enterBuildSlot(1);
        break;
      case 'build.slot3':
        this.enterBuildSlot(2);
        break;
      case 'build.slot4':
        this.enterBuildSlot(3);
        break;
      case 'build.slot5':
        this.enterBuildSlot(4);
        break;
      case 'build.slot6':
        this.enterBuildSlot(5);
        break;
      case 'build.slot7':
        this.enterBuildSlot(6);
        break;
      case 'build.slot8':
        this.enterBuildSlot(7);
        break;
      case 'build.slot9':
        this.enterBuildSlot(8);
        break;
      case 'build.slot10':
      case 'build.slot11':
      case 'build.slot12':
        this.enterBuildSlot(buildSlotIndexForCommandId(commandId));
        break;
      case 'build.spacingIncrease':
        this.config.increaseBuildLineSpacing();
        break;
      case 'build.spacingDecrease':
        this.config.decreaseBuildLineSpacing();
        break;
      case 'build.rotateClockwise':
        this.config.rotateBuildFacingClockwise();
        break;
      case 'build.rotateCounterClockwise':
        this.config.rotateBuildFacingCounterClockwise();
        break;
      case 'select.allUnits':
        this.config.selectAllOwnedUnits();
        break;
      case 'select.matching':
        this.config.selectAllMatching();
        break;
      case 'select.matchingInView':
        this.config.selectAllMatchingInView();
        break;
      case 'select.previous':
        this.config.selectPreviousSelection();
        break;
      case 'select.previousNotInControlGroups':
        this.config.selectPreviousSelectionNotInControlGroups();
        break;
      case 'select.previousNonBuildersNotInControlGroups':
        this.config.selectPreviousNonBuildersNotInControlGroups();
        break;
      case 'select.groundWeaponUnits':
        this.config.selectGroundWeaponUnits();
        break;
      case 'select.idleBuilders':
        this.config.selectIdleBuilders();
        break;
      case 'select.idleTransports':
        this.config.selectIdleTransports();
        break;
      case 'select.waitingUnits':
        this.config.selectWaitingUnits();
        break;
      case 'select.sameTypeOnly':
        this.config.selectSameTypeOnly();
        break;
      case 'select.mobileOnly':
        this.config.selectMobileOnly();
        break;
      case 'select.damagedOnly':
        this.config.selectDamagedOnly();
        break;
      case 'select.invert':
        this.config.invertSelection();
        break;
      case 'select.split':
        this.config.splitArmySelection();
        break;
      case 'select.loop':
        this.config.loopSelection();
        break;
      case 'ui.pause':
      case 'ui.gameSpeedIncrease':
      case 'ui.gameSpeedDecrease':
      case 'ui.optionsMenu':
      case 'ui.showMapOverview':
      case 'ui.unitStats':
      case 'ui.customGameInfo':
      case 'ui.flipCameraYaw':
      case 'camera.toggleMode':
      case 'camera.fovDecrease':
      case 'camera.fovIncrease':
      case 'camera.viewRadiusIncrease':
      case 'camera.viewRadiusDecrease':
      case 'camera.viewTa':
      case 'camera.viewSpring':
      case 'ui.goToLastPing':
      case 'ui.toggleUiChrome':
      case 'ui.muteSound':
      case 'ui.volumeIncrease':
      case 'ui.volumeDecrease':
      case 'ui.captureScreenshot':
      case 'ui.toggleFullscreen':
      case 'ui.chat':
      case 'ui.mapDraw':
      case 'ui.mapLabel':
      case 'ui.mapErase':
      case 'ui.attackRangeCycleNext':
      case 'ui.attackRangeCyclePrevious':
      case 'ui.toggleLosMap':
      case 'ui.togglePathingMap':
      case 'ui.toggleMetalMap':
      case 'ui.toggleElevationMap':
      case 'camera.anchorFocus1':
      case 'camera.anchorFocus2':
      case 'camera.anchorFocus3':
      case 'camera.anchorFocus4':
      case 'camera.anchorSet1':
      case 'camera.anchorSet2':
      case 'camera.anchorSet3':
      case 'camera.anchorSet4':
        break;
    }
  }

  private enterBuildSlot(index: number): boolean {
    const allowedBuildBlueprintIds = this.config.getSelectedBuilderAllowedBuildBlueprintIds();
    const buildGridCategory = this.config.getBuildGridCategory();
    const resolvedIndex = buildGridCategory === null
      ? this.resolveBuildSlotIndexForEntry(index, Date.now())
      : index;
    const buildingBlueprintId = buildGridCategory === null
      ? getBarHomeBuildMenuStructureBlueprintIdBySlotIndex(
        resolvedIndex,
        allowedBuildBlueprintIds,
      )
      : getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex(
        buildGridCategory,
        resolvedIndex,
        allowedBuildBlueprintIds,
        this.config.getBuildGridPage(),
      );
    if (!buildingBlueprintId || !(this.config.mode.isInBuildMode || this.config.hasSelectedBuilder())) {
      return false;
    }
    this.config.exitSpecialModes(false);
    this.config.mode.enterBuildMode(buildingBlueprintId);
    return true;
  }

  private enterFirstBuildOptionForCategory(categoryId: BarBuildCategoryId): boolean {
    const allowedBuildBlueprintIds = this.config.getSelectedBuilderAllowedBuildBlueprintIds();
    const pageIndex = this.config.getBuildGridPage();
    for (let slotIndex = 0; slotIndex < BAR_GRID_COLUMNS * BAR_GRID_ROWS; slotIndex++) {
      const buildingBlueprintId = getBarCategoryBuildMenuStructureBlueprintIdBySlotIndex(
        categoryId,
        slotIndex,
        allowedBuildBlueprintIds,
        pageIndex,
      );
      if (buildingBlueprintId === null) continue;
      if (!(this.config.mode.isInBuildMode || this.config.hasSelectedBuilder())) return false;
      this.config.exitSpecialModes(false);
      this.config.mode.enterBuildMode(buildingBlueprintId);
      return true;
    }
    return false;
  }

  private enterBarLegacyBuildKey(key: BarLegacyBuildKey, timeMs: number): boolean {
    const allowedBuildBlueprintIds = this.config.getSelectedBuilderAllowedBuildBlueprintIds();
    const matchingBlueprintIds = getBarLegacyBuildMenuStructureBlueprintIdsForKey(
      key,
      allowedBuildBlueprintIds,
    );
    if (matchingBlueprintIds.length === 0) {
      this.barLegacyBuildKeyTap = null;
      return false;
    }

    const previous = this.barLegacyBuildKeyTap;
    const elapsedMs = previous === null ? Number.POSITIVE_INFINITY : timeMs - previous.timeMs;
    const cycleIndex =
      previous !== null &&
      previous.key === key &&
      elapsedMs >= 0 &&
      elapsedMs <= BUILD_COLUMN_CYCLE_TAP_MS
        ? previous.cycleIndex + 1
        : 0;
    this.barLegacyBuildKeyTap = { key, timeMs, cycleIndex };
    this.buildColumnCycleTap = null;

    const buildingBlueprintId = matchingBlueprintIds[cycleIndex % matchingBlueprintIds.length];
    if (!buildingBlueprintId || !(this.config.mode.isInBuildMode || this.config.hasSelectedBuilder())) {
      return false;
    }
    this.config.exitSpecialModes(false);
    this.config.mode.enterBuildMode(buildingBlueprintId);
    return true;
  }

  private resolveBuildSlotIndexForEntry(
    defaultSlotIndex: number,
    timeMs: number,
  ): number {
    if (defaultSlotIndex < 0) return defaultSlotIndex;
    const columnIndex = defaultSlotIndex >= 0 && defaultSlotIndex < BAR_GRID_COLUMNS
      ? defaultSlotIndex
      : -1;
    if (columnIndex < 0) {
      this.buildColumnCycleTap = null;
      return defaultSlotIndex;
    }

    const allowedBuildBlueprintIds = this.config.getSelectedBuilderAllowedBuildBlueprintIds();
    const availableColumnSlots: number[] = [];
    for (let rowIndex = 0; rowIndex < BAR_GRID_ROWS; rowIndex++) {
      const slotIndex = rowIndex * BAR_GRID_COLUMNS + columnIndex;
      if (getBarHomeBuildMenuStructureBlueprintIdBySlotIndex(slotIndex, allowedBuildBlueprintIds) !== null) {
        availableColumnSlots.push(slotIndex);
      }
    }
    if (availableColumnSlots.length === 0) {
      this.buildColumnCycleTap = null;
      return defaultSlotIndex;
    }

    const previous = this.buildColumnCycleTap;
    const elapsedMs = previous === null ? Number.POSITIVE_INFINITY : timeMs - previous.timeMs;
    const cycleIndex =
      previous !== null
      && previous.slotIndex === defaultSlotIndex
      && elapsedMs >= 0
      && elapsedMs <= BUILD_COLUMN_CYCLE_TAP_MS
        ? previous.cycleIndex + 1
        : 0;
    this.buildColumnCycleTap = { slotIndex: defaultSlotIndex, timeMs, cycleIndex };
    return availableColumnSlots[cycleIndex % availableColumnSlots.length] ?? defaultSlotIndex;
  }

  private handleEscape(): void {
    if (this.config.getBuildGridCategory() !== null) {
      this.clearBuildGridCategory();
      return;
    }

    handleEscape(
      [
        { isActive: () => this.config.mode.isInBuildMode, cancel: () => this.config.mode.exitBuildMode() },
        { isActive: () => this.config.mode.isInDGunMode, cancel: () => this.config.mode.exitDGunMode() },
        { isActive: this.config.isRepairAreaMode, cancel: this.config.exitRepairAreaMode },
        { isActive: this.config.isRestoreAreaMode, cancel: this.config.exitRestoreAreaMode },
        { isActive: this.config.isAttackMode, cancel: this.config.exitAttackMode },
        { isActive: this.config.isAttackAreaMode, cancel: this.config.exitAttackAreaMode },
        { isActive: this.config.isAttackGroundMode, cancel: this.config.exitAttackGroundMode },
        { isActive: this.config.isManualLaunchMode, cancel: this.config.exitManualLaunchMode },
        { isActive: this.config.isGuardMode, cancel: this.config.exitGuardMode },
        { isActive: this.config.isReclaimMode, cancel: this.config.exitReclaimMode },
        { isActive: this.config.isCaptureMode, cancel: this.config.exitCaptureMode },
        { isActive: this.config.isResurrectMode, cancel: this.config.exitResurrectMode },
        { isActive: this.config.isResurrectAreaMode, cancel: this.config.exitResurrectAreaMode },
        { isActive: this.config.isLoadTransportMode, cancel: this.config.exitLoadTransportMode },
        { isActive: this.config.isUnloadTransportMode, cancel: this.config.exitUnloadTransportMode },
        { isActive: this.config.isMexUpgradeMode, cancel: this.config.exitMexUpgradeMode },
        { isActive: this.config.isPingMode, cancel: this.config.exitPingMode },
        { isActive: this.config.isTowerTargetMode, cancel: this.config.exitTowerTargetMode },
        { isActive: this.config.isTowerTargetNoGroundMode, cancel: this.config.exitTowerTargetNoGroundMode },
      ],
      this.config.commandQueue,
      this.config.getTick(),
    );
  }

  private clearBuildGridCategory(): void {
    if (this.config.getBuildGridCategory() === null) return;
    this.config.setBuildGridCategory(null);
    if (this.config.mode.isInBuildMode) this.config.mode.exitBuildMode();
  }
}
