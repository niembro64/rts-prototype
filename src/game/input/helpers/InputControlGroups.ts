import type { Entity, EntityId } from '../../sim/types';

export const CONTROL_GROUP_COUNT = 10;

type ControlGroupEntitySource = {
  getUnits: () => Entity[];
  getBuildings: () => Entity[];
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
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
  private readonly scratchEntityIds = new Set<EntityId>();
  private readonly scratchEntityIds2 = new Set<EntityId>();
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
  }

  storeSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const ids = this.getSelectedGroupEntityIds();
    if (ids.length === 0) return;
    this.autoGroupRules[index] = null;
    this.groups[index] = ids;
    this.emitChange();
  }

  addToSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const selectedIds = this.getSelectedGroupEntityIds();
    if (selectedIds.length === 0) return;
    const hadAutoRule = this.autoGroupRules[index] !== null;
    this.autoGroupRules[index] = null;

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
    if (group.length === originalLength) {
      if (hadAutoRule) this.emitChange();
      return;
    }
    this.emitChange();
  }

  unsetSelectedFromGroups(): void {
    const selectedIds = this.getSelectedGroupEntityIds();
    if (selectedIds.length === 0) return;
    const removedAutoRuleTypes = this.removeSelectedTypesFromAutoGroupRules();
    const selectedSet = this.scratchEntityIds;
    fillEntityIdSet(selectedSet, selectedIds);
    let changed = removedAutoRuleTypes;
    for (let i = 0; i < this.groups.length; i++) {
      if (compactEntityIdsExcludingSet(this.groups[i], selectedSet)) changed = true;
    }
    selectedSet.clear();
    if (changed) this.emitChange();
  }

  setAutoGroupSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const rule = this.buildAutoGroupRuleFromSelection();
    if (rule === null) return;
    this.autoGroupRules[index] = rule;
    this.groups[index] = this.collectAutoGroupEntityIds(rule);
    this.emitChange();
  }

  removeSelectedFromAutoGroups(): void {
    const selectedIds = this.getSelectedGroupEntityIds();
    if (selectedIds.length === 0) return;
    const selectedSet = this.scratchEntityIds;
    fillEntityIdSet(selectedSet, selectedIds);
    let changed = this.removeSelectedTypesFromAutoGroupRules();
    for (let i = 0; i < this.groups.length; i++) {
      if (this.autoGroupRules[i] === null) continue;
      if (compactEntityIdsExcludingSet(this.groups[i], selectedSet)) changed = true;
    }
    selectedSet.clear();
    if (changed) this.emitChange();
  }

  loadAutoGroupPreset(rules: readonly (AutoGroupRuleSnapshot | null)[]): void {
    let changed = false;
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const rule = hydrateAutoGroupRule(rules[i] ?? null);
      if (autoGroupRulesEqual(this.autoGroupRules[i], rule)) continue;
      this.autoGroupRules[i] = rule;
      this.groups[i] = rule === null ? [] : this.collectAutoGroupEntityIds(rule);
      changed = true;
    }
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

  refreshAutoGroups(): boolean {
    let changed = false;
    for (let i = 0; i < CONTROL_GROUP_COUNT; i++) {
      const rule = this.autoGroupRules[i];
      if (rule === null) continue;
      const entityIds = this.collectAutoGroupEntityIds(rule);
      if (arraysEqual(this.groups[i], entityIds)) continue;
      this.groups[i] = entityIds;
      changed = true;
    }
    if (changed) this.emitChange();
    return changed;
  }

  recallSlot(index: number, additive: boolean): boolean {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return false;
    const entityIds = this.getLiveSlotEntityIds(index);
    if (entityIds.length === 0) {
      if (this.groups[index].length === 0) return false;
      this.groups[index] = [];
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
        this.groups[index] = [];
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
      const factoryUnitBlueprintId = selectedBuildings[i].factory?.selectedUnitBlueprintId;
      if (factoryUnitBlueprintId) {
        rule.unitBlueprintIds.add(factoryUnitBlueprintId);
        continue;
      }
      const buildingBlueprintId = selectedBuildings[i].buildingBlueprintId;
      if (buildingBlueprintId) rule.buildingBlueprintIds.add(buildingBlueprintId);
    }
    return rule.unitBlueprintIds.size > 0 || rule.buildingBlueprintIds.size > 0
      ? rule
      : null;
  }

  private removeSelectedTypesFromAutoGroupRules(): boolean {
    const selectedRule = this.buildAutoGroupRuleFromSelection();
    if (selectedRule === null) return false;
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
        this.groups[i] = [];
      } else {
        this.groups[i] = this.collectAutoGroupEntityIds(rule);
      }
    }
    return changed;
  }

  private collectAutoGroupEntityIds(rule: AutoGroupRule): EntityId[] {
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
    this.emitChange();
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
