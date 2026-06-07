import type { Entity, EntityId } from '../../sim/types';

export const CONTROL_GROUP_COUNT = 9;

type ControlGroupEntitySource = {
  getSelectedUnits: () => Entity[];
  getSelectedBuildings: () => Entity[];
  getEntity: (id: EntityId) => Entity | undefined;
};

type SelectionEnqueue = (entityIds: EntityId[], additive: boolean) => void;

export function controlGroupIndexForKey(e: KeyboardEvent): number {
  const codeMatch = /^Digit([1-9])$/.exec(e.code);
  if (codeMatch) return Number(codeMatch[1]) - 1;
  return /^[1-9]$/.test(e.key) ? Number(e.key) - 1 : -1;
}

export class InputControlGroups {
  private readonly source: ControlGroupEntitySource;
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

  storeSlot(index: number): void {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return;
    const ids = this.getSelectedGroupEntityIds();
    if (ids.length === 0) return;
    this.groups[index] = ids;
    this.emitChange();
  }

  recallSlot(index: number, additive: boolean): boolean {
    if (index < 0 || index >= CONTROL_GROUP_COUNT) return false;
    const group = this.groups[index];
    if (group.length === 0) return false;

    const entityIds: EntityId[] = [];
    for (let i = 0; i < group.length; i++) {
      const entity = this.source.getEntity(group[i]) ?? null;
      if (this.isSelectable(entity)) entityIds.push(group[i]);
    }

    if (entityIds.length === 0) {
      group.length = 0;
      this.emitChange();
      return true;
    }

    if (entityIds.length !== group.length) {
      this.groups[index] = entityIds.slice();
      this.emitChange();
    }
    this.enqueueSelection(entityIds, additive);
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

  private emitChange(): void {
    this.onChange?.(this.groups.map((group) => group.slice()));
  }
}
