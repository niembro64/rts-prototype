import { magnitude } from '../math';
import type { Entity } from './types';

export function getBuildRange(entity: Entity): number {
  return entity.builder?.buildRange ?? 0;
}

export function getBuildTargetHorizontalDistance(builder: Entity, target: Entity): number {
  if (target.building) {
    const halfW = target.building.width / 2;
    const halfH = target.building.height / 2;
    const minX = target.transform.x - halfW;
    const maxX = target.transform.x + halfW;
    const minY = target.transform.y - halfH;
    const maxY = target.transform.y + halfH;
    const closestX = Math.max(minX, Math.min(builder.transform.x, maxX));
    const closestY = Math.max(minY, Math.min(builder.transform.y, maxY));
    return magnitude(closestX - builder.transform.x, closestY - builder.transform.y);
  }

  const dx = target.transform.x - builder.transform.x;
  const dy = target.transform.y - builder.transform.y;
  const radius = target.unit?.unitRadiusCollider.push ?? target.unit?.unitRadiusCollider.shot ?? 0;
  return Math.max(0, magnitude(dx, dy) - radius);
}

export function isBuildTargetInRange(builder: Entity, target: Entity): boolean {
  const range = getBuildRange(builder);
  if (range <= 0) return false;
  return getBuildTargetHorizontalDistance(builder, target) <= range;
}
