// Input helpers - re-exports


export {
  type SelectionEntitySource,
  findClosestSelectableEntityToPoint,
} from './SelectionHelper';

export {
  resolveScreenRectSelectionModifiers,
  selectBoxHeldModifierForKeyCode,
  type ScreenRectSelectionOptions,
  entityMatchesScreenRectSelectionOptions,
  selectEntitiesInScreenRect,
  isBarSameTypeSelectionDoubleClick,
} from './BoxSelection';

export { SelectionChangeTracker } from './SelectionChangeTracker';

export {
  resolveBarDefaultPointerAction,
} from './BarDefaultPointerAction';

export { LinePathAccumulator } from './LinePathAccumulator';

export {
  CONTROL_GROUP_COUNT,
  InputControlGroups,
  controlGroupIndexForKey,
  type AutoGroupRuleSnapshot,
  type ControlGroupSlotSnapshot,
} from './InputControlGroups';

export { InputSelectedCommands } from './InputSelectedCommands';

export {
  buildAttackAreaCommand,
  buildAttackCommandForTarget,
  buildAttackCommandAt,
  buildAttackGroundCommand,
  buildFormationPreservingMoveTargets,
  buildGuardCommandAt,
  buildGuardCommandForTarget,
  buildLinePathMoveCommand,
  shouldCollapseLinePathToSingleMove,
} from './RightClickCommands';

export {  handleEscape } from './EscapeHandler';

export {
  CommanderModeController,
  
  getDefaultBuildModeBuildingBlueprintId,
} from './CommanderModeController';

export {
  buildRepairAreaCommand,
  buildRepairOrGuardCommandForTarget,
  buildRepairCommandForTarget,
  buildReclaimAreaCommand,
  buildReclaimCommandForTarget,
  buildReclaimCommandForTargetId,
  buildCaptureCommandForTarget,
  buildLoadTransportAreaCommand,
  buildLoadTransportCommandForTarget,
  buildUnloadTransportCommand,
  buildFactoryGuardCommands,
  buildFactorySelfGuardCommands,
  buildFactoryRallyCommands,
  getSelectedClientTransports,
} from './CommanderCommands';




export {
  type BuildPlacementCellDiagnostic,
  type BuildPlacementDiagnostics,
  getBuildingPlacementDiagnostics,
  getOccupiedBuildingCells,
  getSnappedBuildPosition,
} from './BuildPlacementValidator';
