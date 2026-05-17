/** Buildable unit roster.
 *
 *  Kept dependency-free so UI config, server spawning, factories, and
 *  selection panels can all derive their unit inventory from the same
 *  source without pulling in the full blueprint/config graph. */
import { isUnitTypeId, type UnitTypeId } from '../../../types/blueprintIds';
import unitRoster from './unitRoster.json';

export type BuildableUnitId = Exclude<UnitTypeId, 'commander'>;

function readBuildableUnitIds(): BuildableUnitId[] {
  return unitRoster.buildableUnitIds.map((unitId) => {
    if (!isUnitTypeId(unitId) || unitId === 'commander') {
      throw new Error(`Invalid buildable unit id in unitRoster.json: ${unitId}`);
    }
    return unitId;
  });
}

export const BUILDABLE_UNIT_IDS = readBuildableUnitIds();

const BUILDABLE_UNIT_ID_SET = new Set<string>(BUILDABLE_UNIT_IDS);
const DEFAULT_DISABLED_DEMO_UNIT_IDS = new Set<string>(
  unitRoster.defaultDisabledDemoUnitIds,
);

export function isDemoUnitEnabledByDefault(unitId: string): boolean {
  return !DEFAULT_DISABLED_DEMO_UNIT_IDS.has(unitId);
}

export function isBuildableUnitId(unitId: string): unitId is BuildableUnitId {
  return BUILDABLE_UNIT_ID_SET.has(unitId);
}
