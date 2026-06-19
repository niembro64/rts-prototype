// Input helpers - re-exports

export {
  type WorldPoint,
  
  
  
  
} from './PathDistribution';

export {
  type SelectionEntitySource,
  findClosestSelectableEntityToPoint,
} from './SelectionHelper';

export {
  type ScreenRect,
  type ProjectToScreen,
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

export { type ModeCancel, handleEscape } from './EscapeHandler';

export {
  CommanderModeController,
  
  
  getDefaultBuildModeBuildingBlueprintId,
} from './CommanderModeController';

export {
  buildRepairAreaCommand,
  buildRepairCommandAt,
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
  type RepairEntitySource,
  
  
  
} from './RepairTargetHelper';

export {
  type AttackEntitySource,
  
} from './AttackTargetHelper';

export {
  type GuardEntitySource,
  
  
} from './GuardTargetHelper';

export {
  type ReclaimEntitySource,
  
} from './ReclaimTargetHelper';

export {
  type BuildPlacementCellDiagnostic,
  type BuildPlacementCellReason,
  type BuildPlacementDiagnostics,
  
  getBuildingPlacementDiagnostics,
  getOccupiedBuildingCells,
  getSnappedBuildPosition,
} from './BuildPlacementValidator';
