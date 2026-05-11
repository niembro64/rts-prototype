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
  selectEntitiesInScreenRect,
} from './BoxSelection';

export { SelectionChangeTracker } from './SelectionChangeTracker';

export { LinePathAccumulator } from './LinePathAccumulator';

export {
  buildAttackCommandForTarget,
  buildAttackCommandAt,
  buildLinePathMoveCommand,
} from './RightClickCommands';

export { type ModeCancel, handleEscape } from './EscapeHandler';

export {
  CommanderModeController,
  getBuildModeBuildingTypeByIndex,
  getBuildModeBuildingTypes,
  getDefaultBuildModeBuildingType,
} from './CommanderModeController';

export {
  buildRepairAreaCommand,
  buildRepairCommandAt,
  buildFactoryWaypointCommands,
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
  type BuildPlacementCellDiagnostic,
  type BuildPlacementCellReason,
  type BuildPlacementDiagnostics,
  canPlaceBuildingAt,
  getBuildingPlacementDiagnostics,
  getOccupiedBuildingCells,
  getSnappedBuildPosition,
} from './BuildPlacementValidator';
