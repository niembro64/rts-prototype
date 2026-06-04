import type { Entity } from './sim/types';

export function getEntityRenderScopePadding(entity: Entity): number {
  const unit = entity.unit;
  if (unit) {
    const radius = unit.radius.visual ?? unit.radius.hitbox ?? 100;
    return Math.max(350, radius);
  }
  const building = entity.building;
  if (building) {
    const radius = Math.max(building.width, building.height) * 0.75;
    return Math.max(200, radius);
  }
  return 100;
}
