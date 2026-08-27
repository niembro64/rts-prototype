import type { UnitLocomotionType } from '../../../types/unitLocomotionTypes';
import { UNIT_LOCOMOTION_TYPES } from '../unitLocomotion';
import { BUILDABLE_UNIT_BLUEPRINT_IDS } from './unitRoster';
import { UNIT_BLUEPRINTS } from './units';
import {
  UNIT_LOCOMOTION_ROSTER_LABEL,
  getUnitLocomotionType,
  groupUnitBlueprintIdsByLocomotionType,
} from './unitLocomotionRoster';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[unit locomotion roster contract] ${message}`);
}

/** The BATTLE bar's per-locomotion UNITS toggles: every buildable unit lands
 *  in exactly one labelled group, groups follow the canonical locomotion
 *  order, and a roster narrowed by the map never leaks ids from outside it. */
export function runUnitLocomotionRosterContractTest(): void {
  const labels = new Set<string>();
  for (const type of UNIT_LOCOMOTION_TYPES) {
    const label = UNIT_LOCOMOTION_ROSTER_LABEL[type];
    assertContract(typeof label === 'string' && label.length > 0, `locomotion type ${type} has no bar label`);
    assertContract(label === label.toUpperCase(), `bar label ${label} for ${type} must be upper case like every other bar button`);
    assertContract(!labels.has(label), `bar label ${label} is shared by two locomotion types`);
    labels.add(label);
  }

  const groups = groupUnitBlueprintIdsByLocomotionType(BUILDABLE_UNIT_BLUEPRINT_IDS);
  const seen = new Set<string>();
  let lastTypeIndex = -1;
  for (const group of groups) {
    assertContract(group.unitBlueprintIds.length > 0, `group ${group.type} is empty but was emitted`);
    assertContract(group.label === UNIT_LOCOMOTION_ROSTER_LABEL[group.type], `group ${group.type} carries label ${group.label}`);
    const typeIndex = (UNIT_LOCOMOTION_TYPES as readonly UnitLocomotionType[]).indexOf(group.type);
    assertContract(typeIndex > lastTypeIndex, `group ${group.type} is out of canonical locomotion order`);
    lastTypeIndex = typeIndex;
    let lastRosterIndex = -1;
    for (const unitBlueprintId of group.unitBlueprintIds) {
      assertContract(!seen.has(unitBlueprintId), `${unitBlueprintId} appears in two locomotion groups`);
      seen.add(unitBlueprintId);
      assertContract(
        UNIT_BLUEPRINTS[unitBlueprintId].unitLocomotion.type === group.type,
        `${unitBlueprintId} sits in group ${group.type} but is authored as ${UNIT_BLUEPRINTS[unitBlueprintId].unitLocomotion.type}`,
      );
      const rosterIndex = BUILDABLE_UNIT_BLUEPRINT_IDS.indexOf(unitBlueprintId);
      assertContract(rosterIndex > lastRosterIndex, `${unitBlueprintId} breaks roster order inside group ${group.type}`);
      lastRosterIndex = rosterIndex;
    }
  }
  for (const unitBlueprintId of BUILDABLE_UNIT_BLUEPRINT_IDS) {
    assertContract(seen.has(unitBlueprintId), `buildable unit ${unitBlueprintId} belongs to no locomotion group`);
  }
  assertContract(getUnitLocomotionType('unitNotABlueprint') === null, 'unknown ids must resolve to no locomotion type');

  // A map-narrowed roster (what the bar actually shows) yields only groups
  // with members from that roster, so toggling a group never touches units
  // the map cannot field.
  const narrowed = BUILDABLE_UNIT_BLUEPRINT_IDS.filter((id) => !UNIT_BLUEPRINTS[id].requiresWater);
  const narrowedSet = new Set<string>(narrowed);
  const narrowedGroups = groupUnitBlueprintIdsByLocomotionType(narrowed);
  assertContract(narrowedGroups.length > 0 && narrowedGroups.length <= groups.length, 'narrowing the roster must not add groups');
  for (const group of narrowedGroups) {
    for (const unitBlueprintId of group.unitBlueprintIds) {
      assertContract(narrowedSet.has(unitBlueprintId), `narrowed group ${group.type} leaked ${unitBlueprintId}`);
    }
  }
  assertContract(groupUnitBlueprintIdsByLocomotionType([]).length === 0, 'an empty roster has no groups');
}
