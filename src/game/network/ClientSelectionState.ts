import type { Entity, EntityId } from '../sim/types';

export class ClientSelectionState {
  private readonly selectedIds = new Set<EntityId>();

  constructor(
    private readonly entities: Map<EntityId, Entity>,
    private readonly dirtyUnitRenderIds: Set<EntityId>,
    private readonly dirtyBuildingRenderIds: Set<EntityId>,
    private readonly markPredictionActive: (entity: Entity) => void,
  ) {}

  has(id: EntityId): boolean {
    return this.selectedIds.has(id);
  }

  delete(id: EntityId): void {
    this.selectedIds.delete(id);
  }

  set(ids: Set<EntityId>): void {
    // P1-23: touch only the entities whose membership changes. The old
    // full-world walk re-tested every entity's selectable flag on every
    // selection replacement.
    for (const id of this.selectedIds) {
      if (ids.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity === undefined || entity.selectable === null) continue;
      if (entity.selectable.selected) this.markRenderDirty(entity);
      entity.selectable.selected = false;
    }
    const hadPrevious = this.selectedIds;
    for (const id of ids) {
      const wasSelected = hadPrevious.has(id);
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.selectable !== null) {
        if (!wasSelected && !entity.selectable.selected) this.markRenderDirty(entity);
        entity.selectable.selected = true;
        this.markPredictionActive(entity);
      }
    }
    if (ids !== this.selectedIds) {
      this.selectedIds.clear();
      for (const id of ids) this.selectedIds.add(id);
    }
  }

  get(): Set<EntityId> {
    return this.selectedIds;
  }

  select(id: EntityId): void {
    this.selectedIds.add(id);
    const entity = this.entities.get(id);
    if (entity === undefined || entity.selectable === null) return;
    if (!entity.selectable.selected) this.markRenderDirty(entity);
    entity.selectable.selected = true;
    this.markPredictionActive(entity);
  }

  deselect(id: EntityId): void {
    this.selectedIds.delete(id);
    const entity = this.entities.get(id);
    if (entity === undefined || entity.selectable === null) return;
    if (entity.selectable.selected) this.markRenderDirty(entity);
    entity.selectable.selected = false;
  }

  clear(): void {
    for (const id of this.selectedIds) {
      const entity = this.entities.get(id);
      if (entity === undefined || entity.selectable === null) continue;
      if (entity.selectable.selected) this.markRenderDirty(entity);
      entity.selectable.selected = false;
    }
    this.selectedIds.clear();
  }

  reset(): void {
    this.selectedIds.clear();
  }

  private markRenderDirty(entity: Entity): void {
    if (entity.unit) {
      this.dirtyUnitRenderIds.add(entity.id);
    } else if (entity.building) {
      this.dirtyBuildingRenderIds.add(entity.id);
    }
  }
}
