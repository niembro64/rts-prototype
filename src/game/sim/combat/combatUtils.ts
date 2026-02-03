// Combat utility functions

import type { Entity } from '../types';

// Distance between two points
export function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

// Get target radius for range calculations
export function getTargetRadius(target: Entity): number {
  if (target.unit) {
    return target.unit.collisionRadius;
  } else if (target.building) {
    const bWidth = target.building.width;
    const bHeight = target.building.height;
    return Math.sqrt(bWidth * bWidth + bHeight * bHeight) / 2;
  }
  return 0;
}

// Normalize angle to [-PI, PI]
export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

// Get angle to face based on movement (or body direction if stationary)
// Used by weapons when they have no target - they face movement direction
export function getMovementAngle(unit: Entity): number {
  if (!unit.unit) return unit.transform.rotation;

  const velX = unit.unit.velocityX ?? 0;
  const velY = unit.unit.velocityY ?? 0;
  const speed = Math.sqrt(velX * velX + velY * velY);

  if (speed > 1) {
    // Moving - face movement direction
    return Math.atan2(velY, velX);
  }

  // Stationary - use body direction (weapons maintain their own rotation)
  return unit.transform.rotation;
}
