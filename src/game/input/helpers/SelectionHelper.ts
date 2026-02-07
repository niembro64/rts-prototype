// Selection helper functions for entity selection logic

import type { Entity, EntityId, PlayerId } from '../../sim/types';
import { magnitude } from '../../math';

// Entity source interface for queries
export interface SelectionEntitySource {
  getUnits(): Entity[];
  getBuildings(): Entity[];
}

// Selection rectangle in world coordinates
export interface SelectionRect {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

// Result of selection query
export interface SelectionResult {
  entityIds: EntityId[];
  wasClick: boolean;  // true if single click (not drag)
}

// Find all owned units within a selection rectangle
export function findUnitsInRect(
  entitySource: SelectionEntitySource,
  rect: SelectionRect,
  playerId: PlayerId
): EntityId[] {
  const ids: EntityId[] = [];

  for (const entity of entitySource.getUnits()) {
    const { x, y } = entity.transform;
    if (entity.ownership?.playerId !== playerId) continue;

    if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) {
      ids.push(entity.id);
    }
  }

  return ids;
}

// Find all owned buildings within a selection rectangle
export function findBuildingsInRect(
  entitySource: SelectionEntitySource,
  rect: SelectionRect,
  playerId: PlayerId
): EntityId[] {
  const ids: EntityId[] = [];

  for (const entity of entitySource.getBuildings()) {
    const { x, y } = entity.transform;
    if (entity.ownership?.playerId !== playerId) continue;

    if (x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY) {
      ids.push(entity.id);
    }
  }

  return ids;
}

// Find closest owned unit to a point (for single-click selection)
export function findClosestUnitToPoint(
  entitySource: SelectionEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): { id: EntityId; dist: number } | null {
  let closest: { id: EntityId; dist: number } | null = null;

  for (const entity of entitySource.getUnits()) {
    if (!entity.unit) continue;
    if (entity.ownership?.playerId !== playerId) continue;

    const dx = entity.transform.x - worldX;
    const dy = entity.transform.y - worldY;
    const dist = magnitude(dx, dy);

    // Must be within collision radius
    if (dist < entity.unit.collisionRadius) {
      if (!closest || dist < closest.dist) {
        closest = { id: entity.id, dist };
      }
    }
  }

  return closest;
}

// Find closest owned building to a point (for single-click selection)
export function findClosestBuildingToPoint(
  entitySource: SelectionEntitySource,
  worldX: number,
  worldY: number,
  playerId: PlayerId
): { id: EntityId; dist: number } | null {
  let closest: { id: EntityId; dist: number } | null = null;

  for (const entity of entitySource.getBuildings()) {
    if (!entity.building) continue;
    if (entity.ownership?.playerId !== playerId) continue;

    const { x, y } = entity.transform;
    const halfW = entity.building.width / 2;
    const halfH = entity.building.height / 2;

    // Check if point is inside building bounds
    if (worldX >= x - halfW && worldX <= x + halfW &&
        worldY >= y - halfH && worldY <= y + halfH) {
      const dx = x - worldX;
      const dy = y - worldY;
      const dist = magnitude(dx, dy);

      if (!closest || dist < closest.dist) {
        closest = { id: entity.id, dist };
      }
    }
  }

  return closest;
}

// Calculate drag distance between two points
export function getDragDistance(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): number {
  const dx = endX - startX;
  const dy = endY - startY;
  return magnitude(dx, dy);
}

// Perform complete selection query (rect or click)
// Returns entity IDs found in selection area
export function performSelection(
  entitySource: SelectionEntitySource,
  startWorldX: number,
  startWorldY: number,
  endWorldX: number,
  endWorldY: number,
  playerId: PlayerId,
  dragThreshold: number = 10
): SelectionResult {
  const rect: SelectionRect = {
    minX: Math.min(startWorldX, endWorldX),
    maxX: Math.max(startWorldX, endWorldX),
    minY: Math.min(startWorldY, endWorldY),
    maxY: Math.max(startWorldY, endWorldY),
  };

  const dragDist = getDragDistance(startWorldX, startWorldY, endWorldX, endWorldY);
  const wasClick = dragDist < dragThreshold;

  if (wasClick) {
    // Single click - find closest entity
    const closestUnit = findClosestUnitToPoint(entitySource, startWorldX, startWorldY, playerId);
    if (closestUnit) {
      return { entityIds: [closestUnit.id], wasClick: true };
    }

    const closestBuilding = findClosestBuildingToPoint(entitySource, startWorldX, startWorldY, playerId);
    if (closestBuilding) {
      return { entityIds: [closestBuilding.id], wasClick: true };
    }

    return { entityIds: [], wasClick: true };
  }

  // Drag selection - find entities in rectangle
  // Units take priority over buildings
  const unitIds = findUnitsInRect(entitySource, rect, playerId);
  if (unitIds.length > 0) {
    return { entityIds: unitIds, wasClick: false };
  }

  const buildingIds = findBuildingsInRect(entitySource, rect, playerId);
  return { entityIds: buildingIds, wasClick: false };
}
