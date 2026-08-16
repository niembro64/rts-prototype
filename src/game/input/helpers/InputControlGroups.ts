import type { Entity, EntityId } from '../../sim/types';

export const CONTROL_GROUP_COUNT = 10;

type ControlGroupEntitySource = {
  getUnits: () => Entity[];
  getBuildings: () => Entity[];
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
  getEntitySetVersion?: () => number;
};

type SelectionEnqueue = (entityIds: EntityId[], additive: boolean) => void;
type AutoGroupRule = {
  unitBlueprintIds: Set<string>;
  buildingBlueprintIds: Set<string>;
};
export type AutoGroupRuleSnapshot = {
  unitBlueprintIds: string[];
  buildingBlueprintIds: string[];
};
export type ControlGroupSlotSnapshot = {
  entityIds: EntityId[];
  auto: boolean;
};

function createEmptyControlGroups(): EntityId[][] {
  const groups = new Array<EntityId[]>(CONTROL_GROUP_COUNT);
  for (let i = 0; i < CONTROL_GROUP_COUNT; i++) groups[i] = [];
  return groups;
}

function createEmptyAutoGroupRules(): (AutoGroupRule | null)[] {
  const rules = new Array<AutoGroupRule | null>(CONTROL_GROUP_COUNT);
  for (let i = 0; i < CONTROL_GROUP_COUNT; i++) rules[i] = null;
  return rules;
}

function createEmptyEntityIdSets(): Set<EntityId>[] {
  return Array.from({ length: CONTROL_GROUP_COUNT }, () => new Set<EntityId>());
}

export function controlGroupIndexForKey(e: Pick<KeyboardEvent, 'code' | 'key'>): number {
  if (/^Numpad[0-9]$/.test(e.code)) return -1;
  const codeMatch = /^Digit([0-9])$/.exec(e.code);
  if (codeMatch) return Number(codeMatch[1]);
  return /^[0-9]$/.test(e.key) ? Number(e.key) : -1;
}

export class InputControlGroups {
  private source: ControlGroupEntitySource;
  private readonly isSelectable: (entity: Entity | null) => boolean;
  private readonly enqueueSelection: SelectionEnqueue;
  private readonly groups: EntityId[][] = createEmptyControlGroups();
  private readonly autoGroupRules: (AutoGroupRule | null)[] = createEmptyAutoGroupRules();
  /** Membership last assigned by an auto-group operation. Manual group
   *  changes remove ids from these sets but deliberately leave the type rule
   *  intact, matching BAR's separate unitDef->group preset map. */
  private readonly autoOwnedEntityIds: Set<EntityId>[] = createEmptyEntityIdSets();
  /** Auto Group reacts to newly created units; it does not poll and steal a
   *  live unit back after a manual group change. */
  private readonly knownEntityIds = new Set<EntityId>();
  private readonly scratchEntityIds = new Set<EntityId>();
  private readonly scratchEntityIds2 = new Set<EntityId>();
  private lastRefreshedEntitySetVersion: number | null = null;
  onChange?: (groups: readonly ControlGroupSlotSnapshot[]) => void;

  constructor(
    source: ControlGroupEntitySource,
    isSelectable: (entity: Entity | null) => boolean,
    enqueueSelection: SelectionEnqueue,
  ) {
    this.source = source;
    this.isSelectable = isSelectable;
    this.enqueueSelection = enqueueSelection;
  }

  setSource(source: ControlGroupEntitySource): void {
    this.source = source;
    this.lastRefreshedEntitySetVersion = null;
  }

  storeSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const ids = this.getSelectedGroupEntityIds();
    if (ids.length === 0) return;
    this.removeEntityIdsFromAllGroups(ids);
    this.groups[index] = ids;
    this.autoOwnedEntityIds[index].clear();
    this.emitChange();
  }

  addToSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const selectedIds = this.getSelectedGroupEntityIds();
    if (selectedIds.length === 0) return;
    this.removeEntityIdsFromAllGroups(selectedIds);

    const group = this.groups[index];
    const originalLength = group.length;
    const seen = this.scratchEntityIds;
    seen.clear();
    for (let i = 0; i < group.length; i++) seen.add(group[i]);
    for (let i = 0; i < selectedIds.length; i++) {
      const id = selectedIds[i];
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(id);
    }
    seen.clear();
    if (group.length === originalLength) return;
    this.emitChange();
  }

  unsetSelectedFromGroups(): void {
    const selectedIds = this.getSelectedGroupEntityIds();
    if (selectedIds.length === 0) return;
    const selectedSet = this.scratchEntityIds;
    fillEntityIdSet(selectedSet, selectedIds);
    let changed = false;
    for (let i = 0; i < this.groups.length; i++) {
      if (compactEntityIdsExcludingSet(this.groups[i], selectedSet)) changed = true;
      for (const id of selectedSet) this.autoOwnedEntityIds[i].delete(id);
    }
    selectedSet.clear();
    if (changed) this.emitChange();
  }

  setAutoGroupSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const selectedRule = this.buildAutoGroupRuleFromSelection();
    if (selectedRule === null) return;

    // BAR stores one unitDef->group entry. Reassign the selected types from
    // every previous rule, while retaining unrelated types already mapped to
    // the destination group.
    this.removeRuleTypesFromEverySlot(selectedRule);
    const targetRule = this.autoGroupRules[index] ?? {
      unitBlueprintIds: new Set<string>(),
      buildingBlueprintIds: new Set<string>(),
    };
    for (const id of selectedRule.unitBlueprintIds) targetRule.unitBlueprintIds.add(id);
    for (const id of selectedRule.buildingBlueprintIds) targetRule.buildingBlueprintIds.add(id);
    this.autoGroupRules[index] = targetRule;

    const matchingIds = this.collectEntityIdsMatchingRule(selectedRule);
    this.removeEntityIdsFromAllGroups(matchingIds);
    this.appendUniqueEntityIds(index, matchingIds);
    for (let i = 0; i < matchingIds.length; i++) this.autoOwnedEntityIds[index].add(matchingIds[i]);
    this.markAllLiveEntitiesKnown();
    this.emitChange();
    if (matchingIds.length > 0) this.enqueueSelection(matchingIds, true);
  }

  removeSelectedFromAutoGroups(): void {
    const selectedRule = this.buildAutoGroupRuleFromSelection();
    if (selectedRule === null) return;
    const matchingIds = this.collectEntityIdsMatchingRule(selectedRule);
    const matchingSet = this.scratchEntityIds;
    fillEntityIdSet(matchingSet, matchingIds);
    let changed = this.removeRuleTypesFromEverySlot(selectedRule);
    for (let i = 0; i < this.groups.length; i++) {
      if (compactEntityIdsExcludingSet(this.groups[i], matchingSet)) changed = true;
      for (const id of matchingSet) this.autoOwnedEntityIds[i].delete(id);
    }
    matchingSet.clear();
    if (changed) this.emitChange();
  }

  loadAutoGroupPreset(rules: readonly (AutoGroupRuleSnapshot | null)[]): void {
    let changed = false;
    // Remove membership still owned by the old preset, but preserve entities
    // the player manually moved elsewhere.
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      if (compactEntityIdsExcludingSet(this.groups[i], this.autoOwnedEntityIds[i])) changed = true;
      this.autoOwnedEntityIds[i].clear();
    }
    const claimedUnitBlueprintIds = new Set<string>();
    const claimedBuildingBlueprintIds = new Set<string>();
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const rule = hydrateUniqueAutoGroupRule(
        rules[i] ?? null,
        claimedUnitBlueprintIds,
        claimedBuildingBlueprintIds,
      );
      if (autoGroupRulesEqual(this.autoGroupRules[i], rule)) continue;
      this.autoGroupRules[i] = rule;
      changed = true;
    }
    if (this.addUngroupedLiveAutoMatches()) changed = true;
    this.markAllLiveEntitiesKnown();
    if (changed) this.emitChange();
  }

  getAutoGroupPresetSnapshot(): (AutoGroupRuleSnapshot | null)[] {
    const snapshots = new Array<AutoGroupRuleSnapshot | null>(this.autoGroupRules.length);
    for (let i = 0; i < this.autoGroupRules.length; i++) {
      snapshots[i] = snapshotAutoGroupRule(this.autoGroupRules[i]);
    }
    return snapshots;
  }

  getSlotSnapshots(): ControlGroupSlotSnapshot[] {
    const snapshots = new Array<ControlGroupSlotSnapshot>(this.groups.length);
    for (let i = 0; i < this.groups.length; i++) {
      snapshots[i] = {
        entityIds: copyEntityIds(this.groups[i]),
        auto: this.autoGroupRules[i] !== null,
      };
    }
    return snapshots;
  }

  refreshAutoGroups(force = false): boolean {
    const entitySetVersion = this.source.getEntitySetVersion?.();
    if (
      !force &&
      entitySetVersion !== undefined &&
      this.lastRefreshedEntitySetVersion === entitySetVersion
    ) return false;
    this.lastRefreshedEntitySetVersion = entitySetVersion ?? null;
    const liveIds = this.scratchEntityIds2;
    liveIds.clear();
    const units = this.source.getUnits();
    for (let i = 0; i < units.length; i++) {
      if (this.isSelectable(units[i])) liveIds.add(units[i].id);
    }
    const buildings = this.source.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      if (this.isSelectable(buildings[i])) liveIds.add(buildings[i].id);
    }
    let changed = this.pruneDeadGroupMemberships(liveIds);
    for (const id of this.knownEntityIds) {
      if (!liveIds.has(id)) this.knownEntityIds.delete(id);
    }
    for (let i = 0; i < units.length; i++) {
      if (this.addNewEntityToAutoGroup(units[i])) changed = true;
    }
    for (let i = 0; i < buildings.length; i++) {
      if (this.addNewEntityToAutoGroup(buildings[i])) changed = true;
    }
    liveIds.clear();
    if (changed) this.emitChange();
    return changed;
  }

  recallSlot(index: number, additive: boolean): boolean {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return false;
    const entityIds = this.getLiveSlotEntityIds(index);
    if (entityIds.length === 0) {
      if (this.groups[index].length === 0) return false;
      this.clearSlotMembership(index);
      this.emitChange();
      return true;
    }

    this.pruneSlotToLiveIds(index, entityIds);
    this.enqueueSelection(entityIds, additive);
    return true;
  }

  toggleSlotSelection(index: number): boolean {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return false;
    const groupIds = this.getLiveSlotEntityIds(index);
    if (groupIds.length === 0) {
      if (this.groups[index].length > 0) {
        this.clearSlotMembership(index);
        this.emitChange();
        return true;
      }
      return false;
    }
    this.pruneSlotToLiveIds(index, groupIds);

    const selectedIds = this.getSelectedGroupEntityIds();
    const selectedSet = this.scratchEntityIds;
    fillEntityIdSet(selectedSet, selectedIds);
    let groupFullySelected = true;
    for (let i = 0; i < groupIds.length; i++) {
      if (selectedSet.has(groupIds[i])) continue;
      groupFullySelected = false;
      break;
    }
    const nextSelection: EntityId[] = [];
    if (groupFullySelected) {
      const groupSet = this.scratchEntityIds2;
      fillEntityIdSet(groupSet, groupIds);
      for (let i = 0; i < selectedIds.length; i++) {
        const id = selectedIds[i];
        if (!groupSet.has(id)) nextSelection.push(id);
      }
      groupSet.clear();
    } else {
      for (let i = 0; i < selectedIds.length; i++) nextSelection.push(selectedIds[i]);
      for (let i = 0; i < groupIds.length; i++) {
        const id = groupIds[i];
        if (selectedSet.has(id)) continue;
        selectedSet.add(id);
        nextSelection.push(id);
      }
    }
    selectedSet.clear();
    this.enqueueSelection(nextSelection, false);
    return true;
  }

  private getSelectedGroupEntityIds(): EntityId[] {
    const entityIds: EntityId[] = [];
    const selectedUnits = this.source.getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) entityIds.push(selectedUnits[i].id);
    const selectedBuildings = this.source.getSelectedBuildings();
    for (let i = 0; i < selectedBuildings.length; i++) entityIds.push(selectedBuildings[i].id);
    return entityIds;
  }

  private buildAutoGroupRuleFromSelection(): AutoGroupRule | null {
    const rule: AutoGroupRule = {
      unitBlueprintIds: new Set<string>(),
      buildingBlueprintIds: new Set<string>(),
    };
    const selectedUnits = this.source.getSelectedUnits();
    for (let i = 0; i < selectedUnits.length; i++) {
      const unitBlueprintId = selectedUnits[i].unit?.unitBlueprintId;
      if (unitBlueprintId) rule.unitBlueprintIds.add(unitBlueprintId);
    }
    const selectedBuildings = this.source.getSelectedBuildings();
    for (let i = 0; i < selectedBuildings.length; i++) {
      const buildingBlueprintId = selectedBuildings[i].buildingBlueprintId;
      if (buildingBlueprintId) rule.buildingBlueprintIds.add(buildingBlueprintId);
    }
    return rule.unitBlueprintIds.size > 0 || rule.buildingBlueprintIds.size > 0
      ? rule
      : null;
  }

  private removeRuleTypesFromEverySlot(selectedRule: AutoGroupRule): boolean {
    let changed = false;
    for (let i = 0; i < this.autoGroupRules.length; i++) {
      const rule = this.autoGroupRules[i];
      if (rule === null) continue;
      for (const unitBlueprintId of selectedRule.unitBlueprintIds) {
        if (rule.unitBlueprintIds.delete(unitBlueprintId)) changed = true;
      }
      for (const buildingBlueprintId of selectedRule.buildingBlueprintIds) {
        if (rule.buildingBlueprintIds.delete(buildingBlueprintId)) changed = true;
      }
      if (rule.unitBlueprintIds.size === 0 && rule.buildingBlueprintIds.size === 0) {
        this.autoGroupRules[i] = null;
      }
    }
    return changed;
  }

  private collectEntityIdsMatchingRule(rule: AutoGroupRule): EntityId[] {
    const entityIds: EntityId[] = [];
    const units = this.source.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      const unitBlueprintId = entity.unit?.unitBlueprintId;
      if (!unitBlueprintId || !rule.unitBlueprintIds.has(unitBlueprintId)) continue;
      if (this.isSelectable(entity)) entityIds.push(entity.id);
    }
    const buildings = this.source.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      const buildingBlueprintId = entity.buildingBlueprintId;
      if (!buildingBlueprintId || !rule.buildingBlueprintIds.has(buildingBlueprintId)) continue;
      if (this.isSelectable(entity)) entityIds.push(entity.id);
    }
    return entityIds;
  }

  private removeEntityIdsFromAllGroups(entityIds: readonly EntityId[]): boolean {
    if (entityIds.length === 0) return false;
    const ids = this.scratchEntityIds;
    fillEntityIdSet(ids, entityIds);
    let changed = false;
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      if (compactEntityIdsExcludingSet(this.groups[i], ids)) changed = true;
      for (const id of ids) this.autoOwnedEntityIds[i].delete(id);
    }
    ids.clear();
    return changed;
  }

  private appendUniqueEntityIds(index: number, entityIds: readonly EntityId[]): void {
    const group = this.groups[index];
    const seen = this.scratchEntityIds;
    fillEntityIdSet(seen, group);
    for (let i = 0; i < entityIds.length; i++) {
      const id = entityIds[i];
      if (seen.has(id)) continue;
      seen.add(id);
      group.push(id);
    }
    seen.clear();
  }

  private entityHasGroup(entityId: EntityId): boolean {
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      if (this.groups[i].includes(entityId)) return true;
    }
    return false;
  }

  private autoGroupIndexForEntity(entity: Entity): number {
    const unitBlueprintId = entity.unit?.unitBlueprintId;
    const buildingBlueprintId = entity.buildingBlueprintId;
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const rule = this.autoGroupRules[i];
      if (rule === null) continue;
      if (unitBlueprintId !== undefined && rule.unitBlueprintIds.has(unitBlueprintId)) return i;
      if (typeof buildingBlueprintId === 'string' && rule.buildingBlueprintIds.has(buildingBlueprintId)) return i;
    }
    return -1;
  }

  private addNewEntityToAutoGroup(entity: Entity): boolean {
    if (!this.isSelectable(entity) || this.knownEntityIds.has(entity.id)) return false;
    this.knownEntityIds.add(entity.id);
    const targetIndex = this.autoGroupIndexForEntity(entity);
    if (targetIndex < 0 || this.entityHasGroup(entity.id)) return false;
    this.groups[targetIndex].push(entity.id);
    this.autoOwnedEntityIds[targetIndex].add(entity.id);
    return true;
  }

  private addUngroupedLiveAutoMatches(): boolean {
    let changed = false;
    const groupedIds = this.scratchEntityIds;
    groupedIds.clear();
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const ids = this.groups[i];
      for (let j = 0; j < ids.length; j++) groupedIds.add(ids[j]);
    }
    const units = this.source.getUnits();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (!this.isSelectable(entity) || groupedIds.has(entity.id)) continue;
      const targetIndex = this.autoGroupIndexForEntity(entity);
      if (targetIndex < 0) continue;
      this.groups[targetIndex].push(entity.id);
      this.autoOwnedEntityIds[targetIndex].add(entity.id);
      groupedIds.add(entity.id);
      changed = true;
    }
    const buildings = this.source.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      if (!this.isSelectable(entity) || groupedIds.has(entity.id)) continue;
      const targetIndex = this.autoGroupIndexForEntity(entity);
      if (targetIndex < 0) continue;
      this.groups[targetIndex].push(entity.id);
      this.autoOwnedEntityIds[targetIndex].add(entity.id);
      groupedIds.add(entity.id);
      changed = true;
    }
    groupedIds.clear();
    return changed;
  }

  private markAllLiveEntitiesKnown(): void {
    const units = this.source.getUnits();
    for (let i = 0; i < units.length; i++) {
      if (this.isSelectable(units[i])) this.knownEntityIds.add(units[i].id);
    }
    const buildings = this.source.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      if (this.isSelectable(buildings[i])) this.knownEntityIds.add(buildings[i].id);
    }
  }

  private pruneDeadGroupMemberships(liveIds: ReadonlySet<EntityId>): boolean {
    let changed = false;
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      if (compactEntityIdsIncludingSet(this.groups[i], liveIds)) changed = true;
      for (const id of this.autoOwnedEntityIds[i]) {
        if (!liveIds.has(id)) this.autoOwnedEntityIds[i].delete(id);
      }
    }
    return changed;
  }

  getLiveSlotEntityIds(index: number): EntityId[] {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return [];
    const group = this.groups[index];
    const entityIds: EntityId[] = [];
    for (let i = 0; i < group.length; i++) {
      const entity = this.source.getEntity(group[i]) ?? null;
      if (this.isSelectable(entity)) entityIds.push(group[i]);
    }
    return entityIds;
  }

  getLiveGroupedEntityIds(): EntityId[] {
    const entityIds: EntityId[] = [];
    const seen = this.scratchEntityIds;
    seen.clear();
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const slotIds = this.getLiveSlotEntityIds(i);
      for (let j = 0; j < slotIds.length; j++) {
        const id = slotIds[j];
        if (seen.has(id)) continue;
        seen.add(id);
        entityIds.push(id);
      }
    }
    seen.clear();
    return entityIds;
  }

  private pruneSlotToLiveIds(index: number, entityIds: EntityId[]): void {
    if (arraysEqual(this.groups[index], entityIds)) return;
    this.groups[index] = copyEntityIds(entityIds);
    const liveIds = this.scratchEntityIds;
    fillEntityIdSet(liveIds, entityIds);
    for (const id of this.autoOwnedEntityIds[index]) {
      if (!liveIds.has(id)) this.autoOwnedEntityIds[index].delete(id);
    }
    liveIds.clear();
    this.emitChange();
  }

  private clearSlotMembership(index: number): void {
    this.groups[index] = [];
    this.autoOwnedEntityIds[index].clear();
  }

  private emitChange(): void {
    this.onChange?.(this.getSlotSnapshots());
  }
}

function hydrateAutoGroupRule(snapshot: AutoGroupRuleSnapshot | null): AutoGroupRule | null {
  if (snapshot === null) return null;
  const unitBlueprintIds: string[] = [];
  if (Array.isArray(snapshot.unitBlueprintIds)) {
    for (let i = 0; i < snapshot.unitBlueprintIds.length; i++) {
      const id = snapshot.unitBlueprintIds[i];
      if (typeof id === 'string') unitBlueprintIds.push(id);
    }
  }
  const buildingBlueprintIds: string[] = [];
  if (Array.isArray(snapshot.buildingBlueprintIds)) {
    for (let i = 0; i < snapshot.buildingBlueprintIds.length; i++) {
      const id = snapshot.buildingBlueprintIds[i];
      if (typeof id === 'string') buildingBlueprintIds.push(id);
    }
  }
  if (unitBlueprintIds.length === 0 && buildingBlueprintIds.length === 0) return null;
  return {
    unitBlueprintIds: new Set(unitBlueprintIds),
    buildingBlueprintIds: new Set(buildingBlueprintIds),
  };
}

function hydrateUniqueAutoGroupRule(
  snapshot: AutoGroupRuleSnapshot | null,
  claimedUnitBlueprintIds: Set<string>,
  claimedBuildingBlueprintIds: Set<string>,
): AutoGroupRule | null {
  const rule = hydrateAutoGroupRule(snapshot);
  if (rule === null) return null;
  for (const id of rule.unitBlueprintIds) {
    if (claimedUnitBlueprintIds.has(id)) rule.unitBlueprintIds.delete(id);
    else claimedUnitBlueprintIds.add(id);
  }
  for (const id of rule.buildingBlueprintIds) {
    if (claimedBuildingBlueprintIds.has(id)) rule.buildingBlueprintIds.delete(id);
    else claimedBuildingBlueprintIds.add(id);
  }
  return rule.unitBlueprintIds.size > 0 || rule.buildingBlueprintIds.size > 0
    ? rule
    : null;
}

function snapshotAutoGroupRule(rule: AutoGroupRule | null): AutoGroupRuleSnapshot | null {
  if (rule === null) return null;
  const unitBlueprintIds: string[] = [];
  for (const id of rule.unitBlueprintIds) unitBlueprintIds.push(id);
  unitBlueprintIds.sort();
  const buildingBlueprintIds: string[] = [];
  for (const id of rule.buildingBlueprintIds) buildingBlueprintIds.push(id);
  buildingBlueprintIds.sort();
  return {
    unitBlueprintIds,
    buildingBlueprintIds,
  };
}

function autoGroupRulesEqual(a: AutoGroupRule | null, b: AutoGroupRule | null): boolean {
  if (a === null || b === null) return a === b;
  return setsEqual(a.unitBlueprintIds, b.unitBlueprintIds)
    && setsEqual(a.buildingBlueprintIds, b.buildingBlueprintIds);
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function fillEntityIdSet(set: Set<EntityId>, ids: readonly EntityId[]): void {
  set.clear();
  for (let i = 0; i < ids.length; i++) set.add(ids[i]);
}

function compactEntityIdsExcludingSet(entityIds: EntityId[], excluded: ReadonlySet<EntityId>): boolean {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < entityIds.length; readIndex++) {
    const id = entityIds[readIndex];
    if (excluded.has(id)) continue;
    if (writeIndex !== readIndex) entityIds[writeIndex] = id;
    writeIndex++;
  }
  if (writeIndex === entityIds.length) return false;
  entityIds.length = writeIndex;
  return true;
}

function compactEntityIdsIncludingSet(entityIds: EntityId[], included: ReadonlySet<EntityId>): boolean {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < entityIds.length; readIndex++) {
    const id = entityIds[readIndex];
    if (!included.has(id)) continue;
    if (writeIndex !== readIndex) entityIds[writeIndex] = id;
    writeIndex++;
  }
  if (writeIndex === entityIds.length) return false;
  entityIds.length = writeIndex;
  return true;
}

function copyEntityIds(entityIds: readonly EntityId[]): EntityId[] {
  const copy = new Array<EntityId>(entityIds.length);
  for (let i = 0; i < entityIds.length; i++) copy[i] = entityIds[i];
  return copy;
}

function arraysEqual(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
