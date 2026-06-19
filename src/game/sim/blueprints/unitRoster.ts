/** Buildable unit roster.
 *
 *  Kept dependency-free so UI config, server spawning, factories, and
 *  selection panels can all derive their unit inventory from the same
 *  source without pulling in the full blueprint/config graph. */
import { isUnitBlueprintId, type UnitBlueprintId } from '../../../types/blueprintIds';
import unitRoster from './unitRoster.json';

type BuildableUnitBlueprintId = Exclude<UnitBlueprintId, 'unitCommander'>;

function readBuildableUnitBlueprintIds(): BuildableUnitBlueprintId[] {
  const unitBlueprintIds = new Array<BuildableUnitBlueprintId>(unitRoster.buildableUnitIds.length);
  for (let i = 0; i < unitRoster.buildableUnitIds.length; i++) {
    const unitBlueprintId = unitRoster.buildableUnitIds[i];
    if (!isUnitBlueprintId(unitBlueprintId) || unitBlueprintId === 'unitCommander') {
      throw new Error(`Invalid buildable unit blueprint id in unitRoster.json: ${unitBlueprintId}`);
    }
    unitBlueprintIds[i] = unitBlueprintId;
  }
  return unitBlueprintIds;
}

export const BUILDABLE_UNIT_BLUEPRINT_IDS = readBuildableUnitBlueprintIds();

const BUILDABLE_UNIT_BLUEPRINT_ID_SET = new Set<string>(BUILDABLE_UNIT_BLUEPRINT_IDS);
const DEFAULT_DISABLED_DEMO_UNIT_BLUEPRINT_IDS = new Set<string>(
  unitRoster.defaultDisabledDemoUnitIds,
);

export function isDemoUnitEnabledByDefault(unitBlueprintId: string): boolean {
  return !DEFAULT_DISABLED_DEMO_UNIT_BLUEPRINT_IDS.has(unitBlueprintId);
}

export function isBuildableUnitBlueprintId(unitBlueprintId: string): unitBlueprintId is BuildableUnitBlueprintId {
  return BUILDABLE_UNIT_BLUEPRINT_ID_SET.has(unitBlueprintId);
}
