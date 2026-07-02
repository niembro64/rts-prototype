// Input helpers - re-exports


export {
  type SelectionEntitySource,
  findClosestSelectableEntityToPoint,
} from './SelectionHelper';

export {
  
  type ScreenRectSelectionOptions,
  entityMatchesScreenRectSelectionOptions,
  selectEntitiesInScreenRect,
} from './BoxSelection';

export { SelectionChangeTracker } from './SelectionChangeTracker';

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
  buildRepairOrGuardCommandAt,
  buildRepairCommandForTarget,
  buildReclaimAreaCommand,
  buildReclaimCommandForTarget,
  buildCaptureCommandForTarget,
  buildResurrectAreaCommand,
  buildResurrectCommandForTarget,
  buildLoadTransportCommandForTarget,
  buildUnloadTransportCommand,
  buildFactoryGuardCommands,
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
