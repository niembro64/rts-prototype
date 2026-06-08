import type { CommandQueue } from '../sim/commands';
import type { StructureBlueprintId, WaypointType } from '../sim/types';
import {
  controlGroupIndexForKey,
  getBuildModeBuildingBlueprintIdByIndex,
  getDefaultBuildModeBuildingBlueprintId,
  handleEscape,
  type CommanderModeController,
} from '../input/helpers';
import { resolveCommandHotkey, type CommandHotkeyId } from '../input/commandHotkeys';

type Input3DKeyboardControllerConfig = {
  mode: CommanderModeController;
  commandQueue: CommandQueue;
  getTick: () => number;
  setWaypointMode: (mode: WaypointType) => void;
  storeControlGroupSlot: (index: number) => void;
  addToControlGroupSlot: (index: number) => void;
  recallControlGroupSlot: (index: number, additive: boolean) => boolean;
  toggleControlGroupSlot: (index: number) => boolean;
  unsetSelectedFromControlGroups: () => void;
  hasSelectedBuilder: () => boolean;
  getSelectedBuilderAllowedBuildBlueprintIds: () => readonly StructureBlueprintId[];
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
  selectAllOwnedUnits: () => void;
  selectAllMatching: () => void;
  selectIdleBuilders: () => void;
  selectWaitingUnits: () => void;
  selectSameTypeOnly: () => void;
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

function isControlGroupUnsetKey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey)
    && !e.shiftKey
    && !e.altKey
    && (e.code === 'Backquote' || e.key === '`');
}

export class Input3DKeyboardController {
  private readonly config: Input3DKeyboardControllerConfig;

  constructor(config: Input3DKeyboardControllerConfig) {
    this.config = config;
  }

  handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (isTextEntryTarget(e.target)) return;

    if (isControlGroupUnsetKey(e)) {
      e.preventDefault();
      this.config.unsetSelectedFromControlGroups();
      return;
    }

    const controlGroupIndex = controlGroupIndexForKey(e);
    if (controlGroupIndex >= 0) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
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
        return;
      }
    }

    const numericBuildHotkey = /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
    if (numericBuildHotkey >= 0) {
      const buildingBlueprintId = getBuildModeBuildingBlueprintIdByIndex(
        numericBuildHotkey,
        this.config.getSelectedBuilderAllowedBuildBlueprintIds(),
      );
      if (buildingBlueprintId && (this.config.mode.isInBuildMode || this.config.hasSelectedBuilder())) {
        this.config.exitSpecialModes(false);
        this.config.mode.enterBuildMode(buildingBlueprintId);
      }
      return;
    }

    const commandId = resolveCommandHotkey(e);
    if (commandId !== null) {
      e.preventDefault();
      this.runCommandHotkey(commandId, e);
      return;
    }

    if (e.key.toLowerCase() === 'escape') {
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
      case 'command.undoQueue':
        this.config.removeLastQueuedOrder();
        break;
      case 'command.clearQueue':
        this.config.clearQueuedOrders();
        break;
      case 'command.wait':
        this.config.toggleSelectedWait(e.shiftKey);
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
      case 'select.allUnits':
        this.config.selectAllOwnedUnits();
        break;
      case 'select.matching':
        this.config.selectAllMatching();
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
