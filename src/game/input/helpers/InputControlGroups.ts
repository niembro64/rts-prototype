import type { Entity, EntityId } from '../../sim/types';

export const CONTROL_GROUP_COUNT = 10;

type ControlGroupEntitySource = {
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
};

type SelectionEnqueue = (entityIds: EntityId[], additive: boolean) => void;

export function controlGroupIndexForKey(e: KeyboardEvent): number {
  const codeMatch = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  if (codeMatch) return Number(codeMatch[1]);
  return /^[0-9]$/.test(e.key) ? Number(e.key) : -1;
}

export class InputControlGroups {
  private source: ControlGroupEntitySource;
  private readonly isSelectable: (entity: Entity | null) => boolean;
  private readonly enqueueSelection: SelectionEnqueue;
  private readonly groups: EntityId[][] = Array.from({ length: CONTROL_GROUP_COUNT }, () => []);
  onChange?: (groups: readonly (readonly EntityId[])[]) => void;

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
    this.groups[index] = ids;
    this.emitChange();
  }

  addToSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const selectedIds = this.getSelectedGroupEntityIds();
    if (selectedIds.length === 0) return;

    const merged = this.groups[index].slice();
    const seen = new Set<EntityId>(merged);
    for (let i = 0; i < selectedIds.length; i++) {
      const id = selectedIds[i];
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
    if (merged.length === this.groups[index].length) return;
    this.groups[index] = merged;
    this.emitChange();
  }

  unsetSelectedFromGroups(): void {
    const selectedIds = this.getSelectedGroupEntityIds();
    if (selectedIds.length === 0) return;
    const selectedSet = new Set<EntityId>(selectedIds);
    let changed = false;
    for (let i = 0; i < this.groups.length; i++) {
      const group = this.groups[i];
      const filtered = group.filter((id) => !selectedSet.has(id));
      if (filtered.length === group.length) continue;
      this.groups[i] = filtered;
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
    this.onChange?.(this.groups.map((group) => group.slice()));
  }
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
