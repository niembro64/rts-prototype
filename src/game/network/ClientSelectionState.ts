import type { Entity, EntityId } from '../sim/types';

export class ClientSelectionState {
  private readonly selectedIds = new Set<EntityId>();

  constructor(
    private readonly entities: Map<EntityId, Entity>,
    private readonly dirtyUnitRenderIds: Set<EntityId>,
    private readonly markPredictionActive: (entity: Entity) => void,
  ) {}

  has(id: EntityId): boolean {
    return this.selectedIds.has(id);
  }

  delete(id: EntityId): void {
    this.selectedIds.delete(id);
  }

  set(ids: Set<EntityId>): void {
    this.selectedIds.clear();
    for (const id of ids) this.selectedIds.add(id);
    for (const entity of this.entities.values()) {
      if (!entity.selectable) continue;
      const selected = this.selectedIds.has(entity.id);
      if (entity.selectable.selected !== selected && entity.unit) {
        this.dirtyUnitRenderIds.add(entity.id);
      }
      entity.selectable.selected = selected;
      if (selected) this.markPredictionActive(entity);
    }
  }

  get(): Set<EntityId> {
    return this.selectedIds;
  }

  select(id: EntityId): void {
    this.selectedIds.add(id);
    const entity = this.entities.get(id);
    if (!entity?.selectable) return;
    if (!entity.selectable.selected && entity.unit) this.dirtyUnitRenderIds.add(id);
    entity.selectable.selected = true;
    this.markPredictionActive(entity);
  }

  deselect(id: EntityId): void {
    this.selectedIds.delete(id);
    const entity = this.entities.get(id);
    if (!entity?.selectable) return;
    if (entity.selectable.selected && entity.unit) this.dirtyUnitRenderIds.add(id);
    entity.selectable.selected = false;
  }

  clear(): void {
    for (const id of this.selectedIds) {
      const entity = this.entities.get(id);
      if (!entity?.selectable) continue;
      if (entity.selectable.selected && entity.unit) this.dirtyUnitRenderIds.add(id);
      entity.selectable.selected = false;
    }
    this.selectedIds.clear();
  }

  reset(): void {
    this.selectedIds.clear();
  }
}
