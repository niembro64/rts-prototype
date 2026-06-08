import type { CommandQueue } from '../sim/commands';
import type { StructureBlueprintId, WaypointType } from '../sim/types';
import {
  controlGroupIndexForKey,
  getBuildModeBuildingBlueprintIdByIndex,
  getDefaultBuildModeBuildingBlueprintId,
  handleEscape,
  type CommanderModeController,
} from '../input/helpers';
import { CommandHotkeySequenceResolver, type CommandHotkeyId } from '../input/commandHotkeys';

type Input3DKeyboardControllerConfig = {
  mode: CommanderModeController;
  commandQueue: CommandQueue;
  getTick: () => number;
  setWaypointMode: (mode: WaypointType) => void;
  storeControlGroupSlot: (index: number) => void;
  addToControlGroupSlot: (index: number) => void;
  setAutoControlGroupSlot: (index: number) => void;
  removeSelectedFromAutoControlGroups: () => void;
  recallControlGroupSlot: (index: number, additive: boolean) => boolean;
  toggleControlGroupSlot: (index: number) => boolean;
  unsetSelectedFromControlGroups: () => void;
  focusControlGroupSlot: (index: number) => boolean;
  panCameraByKeyboard: (screenX: number, screenY: number, fine: boolean) => void;
  hasSelectedBuilder: () => boolean;
  getSelectedBuilderAllowedBuildBlueprintIds: () => readonly StructureBlueprintId[];
  exitSpecialModes: (includeTowerTarget?: boolean) => void;
  stopSelectedUnits: () => void;
  skipCurrentOrder: () => void;
  removeLastQueuedOrder: () => void;
  clearQueuedOrders: () => void;
  toggleSelectedWait: (queue: boolean, queueFront?: boolean) => void;
  toggleSelectedFire: () => void;
  toggleBuildingActive: () => void;
  selfDestructSelected: () => void;
  toggleTowerTargetMode: () => void;
  clearTowerTarget: () => void;
  toggleAttackMode: () => void;
  toggleAttackAreaMode: () => void;
  toggleAttackGroundMode: () => void;
  toggleGuardMode: () => void;
  toggleReclaimMode: () => void;
  toggleRepairAreaMode: () => void;
  togglePingMode: () => void;
  toggleDGunMode: () => void;
  enqueueScanAtCursor: () => void;
  selectActiveCommander: (additive: boolean) => void;
  selectAllOwnedUnits: () => void;
  selectAllMatching: () => void;
  selectAllMatchingInView: () => void;
  selectPreviousSelection: () => void;
  selectIdleBuilders: () => void;
  selectWaitingUnits: () => void;
  selectSameTypeOnly: () => void;
  selectMobileOnly: () => void;
  invertSelection: () => void;
  splitArmySelection: () => void;
  loopSelection: () => void;
  isRepairAreaMode: () => boolean;
  isAttackMode: () => boolean;
  isAttackAreaMode: () => boolean;
  isAttackGroundMode: () => boolean;
  isGuardMode: () => boolean;
  isReclaimMode: () => boolean;
  isPingMode: () => boolean;
  isTowerTargetMode: () => boolean;
  exitRepairAreaMode: () => void;
  exitAttackMode: () => void;
  exitAttackAreaMode: () => void;
  exitAttackGroundMode: () => void;
  exitGuardMode: () => void;
  exitReclaimMode: () => void;
  exitPingMode: () => void;
  exitTowerTargetMode: () => void;
};

function isTextEntryTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(element?.isContentEditable);
}

function isControlGroupUnsetKey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey)
    && !e.shiftKey
    && !e.altKey
    && (e.code === 'Backquote' || e.key === '`');
}

function isAutoGroupRemoveKey(e: KeyboardEvent): boolean {
  return e.altKey
    && !e.ctrlKey
    && !e.metaKey
    && !e.shiftKey
    && (e.code === 'Backquote' || e.key === '`' || e.code === 'KeyQ');
}

type CameraPanDirection = {
  x: number;
  y: number;
};

function cameraPanDirectionForKey(e: KeyboardEvent): CameraPanDirection | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.code) {
    case 'ArrowUp':
    case 'Numpad8':
      return { x: 0, y: 1 };
    case 'ArrowDown':
    case 'Numpad2':
      return { x: 0, y: -1 };
    case 'ArrowLeft':
    case 'Numpad4':
      return { x: -1, y: 0 };
    case 'ArrowRight':
    case 'Numpad6':
      return { x: 1, y: 0 };
    case 'Numpad7':
      return { x: -Math.SQRT1_2, y: Math.SQRT1_2 };
    case 'Numpad9':
      return { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    case 'Numpad1':
      return { x: -Math.SQRT1_2, y: -Math.SQRT1_2 };
    case 'Numpad3':
      return { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
    default:
      return null;
  }
}

export const CONTROL_GROUP_FOCUS_DOUBLE_TAP_MS = 500;

export type ControlGroupRecallTapState = {
  index: number;
  timeMs: number;
};

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

  constructor(config: Input3DKeyboardControllerConfig) {
    this.config = config;
  }

  handleKeyDown(e: KeyboardEvent): void {
    if (isTextEntryTarget(e.target)) return;

    const cameraPanDirection = cameraPanDirectionForKey(e);
    if (cameraPanDirection !== null) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.config.panCameraByKeyboard(
        cameraPanDirection.x,
        cameraPanDirection.y,
        e.shiftKey,
      );
      return;
    }

    if (e.repeat) return;

    if (isControlGroupUnsetKey(e)) {
      e.preventDefault();
      this.commandHotkeys.reset();
      this.config.unsetSelectedFromControlGroups();
      return;
    }

    if (isAutoGroupRemoveKey(e)) {
      e.preventDefault();
      this.commandHotkeys.reset();
      resetControlGroupRecallTap(this.controlGroupRecallTap);
      this.config.removeSelectedFromAutoControlGroups();
      return;
    }

    const controlGroupIndex = controlGroupIndexForKey(e);
    if (controlGroupIndex >= 0) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        this.commandHotkeys.reset();
        resetControlGroupRecallTap(this.controlGroupRecallTap);
        this.config.setAutoControlGroupSlot(controlGroupIndex);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
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
      if (e.altKey) return;
      if (this.config.recallControlGroupSlot(controlGroupIndex, e.shiftKey)) {
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

    const numericBuildHotkey = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
    if (numericBuildHotkey >= 0) {
      if (this.enterBuildSlot(numericBuildHotkey)) {
        this.commandHotkeys.reset();
        return;
      }
    }

    const hotkey = this.commandHotkeys.resolve(e);
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

  private runCommandHotkey(commandId: CommandHotkeyId, e: KeyboardEvent): void {
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
        this.config.toggleSelectedWait(e.shiftKey, isQueueFrontModifier(e));
        break;
      case 'command.fireToggle':
        this.config.toggleSelectedFire();
        break;
      case 'command.buildingActive':
        this.config.toggleBuildingActive();
        break;
      case 'command.selfDestruct':
        this.config.selfDestructSelected();
        break;
      case 'combat.towerTargetSet':
        this.config.toggleTowerTargetMode();
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
      case 'combat.guard':
        this.config.toggleGuardMode();
        break;
      case 'combat.reclaim':
        this.config.toggleReclaimMode();
        break;
      case 'combat.repairArea':
        this.config.toggleRepairAreaMode();
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
      case 'select.idleBuilders':
        this.config.selectIdleBuilders();
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
      case 'select.invert':
        this.config.invertSelection();
        break;
      case 'select.split':
        this.config.splitArmySelection();
        break;
      case 'select.loop':
        this.config.loopSelection();
        break;
      case 'ui.optionsMenu':
      case 'ui.chat':
      case 'ui.mapDraw':
      case 'ui.mapLabel':
      case 'ui.mapErase':
        break;
    }
  }

  private enterBuildSlot(index: number): boolean {
    const buildingBlueprintId = getBuildModeBuildingBlueprintIdByIndex(
      index,
      this.config.getSelectedBuilderAllowedBuildBlueprintIds(),
    );
    if (!buildingBlueprintId || !(this.config.mode.isInBuildMode || this.config.hasSelectedBuilder())) {
      return false;
    }
    this.config.exitSpecialModes(false);
    this.config.mode.enterBuildMode(buildingBlueprintId);
    return true;
  }

  private handleEscape(): void {
    handleEscape(
      [
        { isActive: () => this.config.mode.isInBuildMode, cancel: () => this.config.mode.exitBuildMode() },
        { isActive: () => this.config.mode.isInDGunMode, cancel: () => this.config.mode.exitDGunMode() },
        { isActive: this.config.isRepairAreaMode, cancel: this.config.exitRepairAreaMode },
        { isActive: this.config.isAttackMode, cancel: this.config.exitAttackMode },
        { isActive: this.config.isAttackAreaMode, cancel: this.config.exitAttackAreaMode },
        { isActive: this.config.isAttackGroundMode, cancel: this.config.exitAttackGroundMode },
        { isActive: this.config.isGuardMode, cancel: this.config.exitGuardMode },
        { isActive: this.config.isReclaimMode, cancel: this.config.exitReclaimMode },
        { isActive: this.config.isPingMode, cancel: this.config.exitPingMode },
        { isActive: this.config.isTowerTargetMode, cancel: this.config.exitTowerTargetMode },
      ],
      this.config.commandQueue,
      this.config.getTick(),
    );
  }
}

function isQueueFrontModifier(e: KeyboardEvent): boolean {
  return e.shiftKey && (e.ctrlKey || e.metaKey);
}
