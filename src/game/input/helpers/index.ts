// Input helpers - re-exports

export {
  type WorldPoint,
  getPathLength,
  getPointAtDistance,
  calculateLinePathTargets,
  assignUnitsToTargets,
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
  buildFormationPreservingMoveCommand,
  buildFormationPreservingMoveTargets,
  buildGuardCommandAt,
  buildGuardCommandForTarget,
  buildLinePathMoveCommand,
  shouldCollapseLinePathToSingleMove,
} from './RightClickCommands';

export { type ModeCancel, handleEscape } from './EscapeHandler';

export {
  CommanderModeController,
  getBuildModeBuildingBlueprintIdByIndex,
  getBuildModeBuildingBlueprintIds,
  getDefaultBuildModeBuildingBlueprintId,
} from './CommanderModeController';

export {
  buildRepairAreaCommand,
  buildRepairCommandAt,
  buildReclaimAreaCommand,
  buildReclaimCommandAt,
  buildReclaimCommandForTarget,
  buildFactoryGuardCommands,
  buildFactoryRallyCommands,
} from './CommanderCommands';

export {
  type RepairEntitySource,
  findRepairTargetAt,
  findIncompleteBuildingAt,
  findDamagedUnitAt,
} from './RepairTargetHelper';

export {
  type AttackEntitySource,
  findAttackTargetAt,
} from './AttackTargetHelper';

export {
  type GuardEntitySource,
  findGuardTargetAt,
  isGuardableFriendlyTarget,
} from './GuardTargetHelper';

export {
  type ReclaimEntitySource,
  findReclaimTargetAt,
} from './ReclaimTargetHelper';

export {
  type BuildPlacementCellDiagnostic,
  type BuildPlacementCellReason,
  type BuildPlacementDiagnostics,
  canPlaceBuildingAt,
  getBuildingPlacementDiagnostics,
  getOccupiedBuildingCells,
  getSnappedBuildPosition,
} from './BuildPlacementValidator';
