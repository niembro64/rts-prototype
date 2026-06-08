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

export function controlGroupIndexForKey(e: KeyboardEvent): number {
  if (/^Numpad[0-9]$/.test(e.code)) return -1;
  const codeMatch = /^Digit([0-9])$/.exec(e.code);
  if (codeMatch) return Number(codeMatch[1]);
  return /^[0-9]$/.test(e.key) ? Number(e.key) : -1;
}

export class InputControlGroups {
  private source: ControlGroupEntitySource;
  private readonly isSelectable: (entity: Entity | null) => boolean;
  private readonly enqueueSelection: SelectionEnqueue;
  private readonly groups: EntityId[][] = Array.from({ length: CONTROL_GROUP_COUNT }, () => []);
  private readonly autoGroupRules: (AutoGroupRule | null)[] =
    Array.from({ length: CONTROL_GROUP_COUNT }, () => null);
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

    const merged = this.groups[index].slice();
    const seen = new Set<EntityId>(merged);
    for (let i = 0; i < selectedIds.length; i++) {
      const id = selectedIds[i];
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    if (merged.length === this.groups[index].length) {
      if (hadAutoRule) this.emitChange();
      return;
    }
    this.groups[index] = merged;
    this.emitChange();
  }

  unsetSelectedFromGroups(): void {
    const selectedIds = this.getSelectedGroupEntityIds();
    if (selectedIds.length === 0) return;
    const removedAutoRuleTypes = this.removeSelectedTypesFromAutoGroupRules();
    const selectedSet = new Set<EntityId>(selectedIds);
    let changed = removedAutoRuleTypes;
    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      const filtered = group.filter((id) => !selectedSet.has(id));
      if (filtered.length === group.length) continue;
      this.groups[i] = filtered;
      changed = true;
    }
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
    const selectedSet = new Set<EntityId>(selectedIds);
    let changed = this.removeSelectedTypesFromAutoGroupRules();
    for (let i = 0; i < this.groups.length; i++) {
      if (this.autoGroupRules[i] === null) continue;
      const filtered = this.groups[i].filter((id) => !selectedSet.has(id));
      if (filtered.length === this.groups[i].length) continue;
      this.groups[i] = filtered;
      changed = true;
    }
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
    return this.autoGroupRules.map(snapshotAutoGroupRule);
  }

  getSlotSnapshots(): ControlGroupSlotSnapshot[] {
    return this.groups.map((group, index) => ({
      entityIds: group.slice(),
      auto: this.autoGroupRules[index] !== null,
    }));
  }

  refreshAutoGroups(): void {
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
    const selectedSet = new Set<EntityId>(selectedIds);
    const groupSet = new Set<EntityId>(groupIds);
    const groupFullySelected = groupIds.every((id) => selectedSet.has(id));
    const nextSelection = groupFullySelected
      ? selectedIds.filter((id) => !groupSet.has(id))
      : mergeEntityIds(selectedIds, groupIds);
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

  private pruneSlotToLiveIds(index: number, entityIds: EntityId[]): void {
    if (arraysEqual(this.groups[index], entityIds)) return;
    this.groups[index] = entityIds.slice();
    this.emitChange();
  }

  private emitChange(): void {
    this.onChange?.(this.getSlotSnapshots());
  }
}

function hydrateAutoGroupRule(snapshot: AutoGroupRuleSnapshot | null): AutoGroupRule | null {
  if (snapshot === null) return null;
  const unitBlueprintIds = Array.isArray(snapshot.unitBlueprintIds)
    ? snapshot.unitBlueprintIds.filter((id): id is string => typeof id === 'string')
    : [];
  const buildingBlueprintIds = Array.isArray(snapshot.buildingBlueprintIds)
    ? snapshot.buildingBlueprintIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (unitBlueprintIds.length === 0 && buildingBlueprintIds.length === 0) return null;
  return {
    unitBlueprintIds: new Set(unitBlueprintIds),
    buildingBlueprintIds: new Set(buildingBlueprintIds),
  };
}

function snapshotAutoGroupRule(rule: AutoGroupRule | null): AutoGroupRuleSnapshot | null {
  if (rule === null) return null;
  return {
    unitBlueprintIds: Array.from(rule.unitBlueprintIds).sort(),
    buildingBlueprintIds: Array.from(rule.buildingBlueprintIds).sort(),
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

function mergeEntityIds(first: readonly EntityId[], second: readonly EntityId[]): EntityId[] {
  const merged = first.slice();
  const seen = new Set<EntityId>(merged);
  for (let i = 0; i < second.length; i++) {
    const id = second[i];
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

function arraysEqual(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
