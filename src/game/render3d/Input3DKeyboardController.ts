import type { CommandQueue } from '../sim/commands';
import type { WaypointType } from '../sim/types';
import {
  controlGroupIndexForKey,
  getBuildModeBuildingBlueprintIdByIndex,
  getDefaultBuildModeBuildingBlueprintId,
  handleEscape,
  type CommanderModeController,
} from '../input/helpers';

type Input3DKeyboardControllerConfig = {
  mode: CommanderModeController;
  commandQueue: CommandQueue;
  getTick: () => number;
  setWaypointMode: (mode: WaypointType) => void;
  storeControlGroupSlot: (index: number) => void;
  recallControlGroupSlot: (index: number, additive: boolean) => boolean;
  hasSelectedBuilder: () => boolean;
  exitSpecialModes: (includeTowerTarget?: boolean) => void;
  stopSelectedUnits: () => void;
  removeLastQueuedOrder: () => void;
  clearQueuedOrders: () => void;
  toggleSelectedWait: (queue: boolean) => void;
  toggleSelectedFire: () => void;
  toggleBuildingActive: () => void;
  selfDestructSelected: () => void;
  toggleTowerTargetMode: () => void;
  clearTowerTarget: () => void;
  toggleAttackAreaMode: () => void;
  toggleAttackGroundMode: () => void;
  toggleGuardMode: () => void;
  toggleReclaimMode: () => void;
  toggleRepairAreaMode: () => void;
  togglePingMode: () => void;
  toggleDGunMode: () => void;
  enqueueScanAtCursor: () => void;
  selectActiveCommander: (additive: boolean) => void;
  isRepairAreaMode: () => boolean;
  isAttackAreaMode: () => boolean;
  isAttackGroundMode: () => boolean;
  isGuardMode: () => boolean;
  isReclaimMode: () => boolean;
  isPingMode: () => boolean;
  isTowerTargetMode: () => boolean;
  exitRepairAreaMode: () => void;
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

export class Input3DKeyboardController {
  private readonly config: Input3DKeyboardControllerConfig;

  constructor(config: Input3DKeyboardControllerConfig) {
    this.config = config;
  }

  handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (isTextEntryTarget(e.target)) return;

    const controlGroupIndex = controlGroupIndexForKey(e);
    if (controlGroupIndex >= 0) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.config.storeControlGroupSlot(controlGroupIndex);
        return;
      }
      if (this.config.recallControlGroupSlot(controlGroupIndex, e.shiftKey)) {
        e.preventDefault();
        return;
      }
    }

    const numericBuildHotkey = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
    if (numericBuildHotkey >= 0) {
      const buildingBlueprintId = getBuildModeBuildingBlueprintIdByIndex(numericBuildHotkey);
      if (buildingBlueprintId && (this.config.mode.isInBuildMode || this.config.hasSelectedBuilder())) {
        this.config.exitSpecialModes(false);
        this.config.mode.enterBuildMode(buildingBlueprintId);
      }
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'm':
        this.config.setWaypointMode('move');
        break;
      case 'f':
        this.config.setWaypointMode('fight');
        break;
      case 'h':
        this.config.setWaypointMode('patrol');
        break;
      case 's':
        this.config.stopSelectedUnits();
        break;
      case 'u':
        this.config.removeLastQueuedOrder();
        break;
      case 'x':
        this.config.clearQueuedOrders();
        break;
      case 'w':
        this.config.toggleSelectedWait(e.shiftKey);
        break;
      case 'e':
        this.config.toggleSelectedFire();
        break;
      case 'o':
        this.config.toggleBuildingActive();
        break;
      case 'k':
        this.config.selfDestructSelected();
        break;
      case 'l':
        this.config.toggleTowerTargetMode();
        break;
      case 'j':
        this.config.clearTowerTarget();
        break;
      case 'a':
        this.config.toggleAttackAreaMode();
        break;
      case 't':
        this.config.toggleAttackGroundMode();
        break;
      case 'g':
        this.config.toggleGuardMode();
        break;
      case 'c':
        this.config.toggleReclaimMode();
        break;
      case 'r':
        this.config.toggleRepairAreaMode();
        break;
      case 'p':
        this.config.togglePingMode();
        break;
      case 'y':
        this.config.enqueueScanAtCursor();
        break;
      case 'b':
        if (!this.config.hasSelectedBuilder()) break;
        this.config.exitSpecialModes(false);
        if (!this.config.mode.isInBuildMode) {
          this.config.mode.enterBuildMode(getDefaultBuildModeBuildingBlueprintId());
        } else {
          this.config.mode.cycleBuildingBlueprintId();
        }
        break;
      case 'd':
        this.config.toggleDGunMode();
        break;
      case 'tab':
        e.preventDefault();
        this.config.selectActiveCommander(e.shiftKey);
        break;
      case 'escape':
        this.handleEscape();
        break;
    }
  }

  private handleEscape(): void {
    handleEscape(
      [
        { isActive: () => this.config.mode.isInBuildMode, cancel: () => this.config.mode.exitBuildMode() },
        { isActive: () => this.config.mode.isInDGunMode, cancel: () => this.config.mode.exitDGunMode() },
        { isActive: this.config.isRepairAreaMode, cancel: this.config.exitRepairAreaMode },
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
