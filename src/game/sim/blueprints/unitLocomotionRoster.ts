/** Unit roster grouped by authored locomotion mechanism.
 *
 *  The BATTLE bar's UNITS group toggles blueprints one at a time or all at
 *  once; this is the middle rung — every ROVER, every DRONE — so a sandbox can
 *  field one chassis family without clicking through the roster. The grouping
 *  key is the authored `unitLocomotion.type` (the rig), NOT the navigation
 *  domain: an amphibian and a submarine both swim, but they are different
 *  families to a player choosing what to watch.
 *
 *  Kept to the blueprint table + the locomotion type list so bars, lobby grids,
 *  and tests all group the same way. */
import type { UnitLocomotionType } from '../../../types/unitLocomotionTypes';
import { UNIT_LOCOMOTION_TYPES } from '../unitLocomotion';
import { UNIT_BLUEPRINTS } from './units';

/** Bar-width labels, upper case like every other bar button. */
export const UNIT_LOCOMOTION_ROSTER_LABEL: Readonly<Record<UnitLocomotionType, string>> = {
  rover: 'ROVER',
  tank: 'TANK',
  'amphibious-tank': 'AMPH TANK',
  crawler: 'CRAWLER',
  bot: 'BOT',
  amphibian: 'AMPHIB',
  drone: 'DRONE',
  plane: 'PLANE',
  submarine: 'SUB',
  aerosub: 'AEROSUB',
};

export type UnitLocomotionRosterGroup<T extends string = string> = Readonly<{
  type: UnitLocomotionType;
  label: string;
  /** Members in the caller's roster order. Never empty. */
  unitBlueprintIds: readonly T[];
}>;

export function getUnitLocomotionType(unitBlueprintId: string): UnitLocomotionType | null {
  return UNIT_BLUEPRINTS[unitBlueprintId]?.unitLocomotion.type ?? null;
}

/** Splits the given roster by locomotion type, groups in
 *  `UNIT_LOCOMOTION_TYPES` order, members in roster order. Empty groups are
 *  omitted, so a roster already narrowed to what a map can field (no water →
 *  no submarines) shows no SUB button. Ids without a blueprint are skipped. */
export function groupUnitBlueprintIdsByLocomotionType<T extends string>(
  unitBlueprintIds: readonly T[],
): readonly UnitLocomotionRosterGroup<T>[] {
  const members = new Map<UnitLocomotionType, T[]>();
  for (const unitBlueprintId of unitBlueprintIds) {
    const type = getUnitLocomotionType(unitBlueprintId);
    if (type === null) continue;
    const bucket = members.get(type);
    if (bucket) bucket.push(unitBlueprintId);
    else members.set(type, [unitBlueprintId]);
  }
  const groups: UnitLocomotionRosterGroup<T>[] = [];
  for (const type of UNIT_LOCOMOTION_TYPES) {
    const bucket = members.get(type);
    if (!bucket) continue;
    groups.push({ type, label: UNIT_LOCOMOTION_ROSTER_LABEL[type], unitBlueprintIds: bucket });
  }
  return groups;
}
