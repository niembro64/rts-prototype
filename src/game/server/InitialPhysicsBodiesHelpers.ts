// InitialPhysicsBodiesHelpers - shared building/unit body creation passes.
//
// Extracted from ServerBootstrap so the sync (`bootstrap`) and async
// (`bootstrapAsync`) initial-spawn paths run the exact same two passes.
// Buildings are created first so units can set ignore-static for
// overlapping buildings on the second pass; callers run these helpers in
// that order (and the async path reports progress between the two).

import type { WorldState } from '../sim/WorldState';
import type { Entity } from '../sim/types';
import type { PhysicsEngine3D } from './PhysicsEngine3D';
import { createPhysicsBodyForUnit } from './unitPhysicsBody';
import { createPhysicsBodyForBuilding } from './buildingPhysicsBody';

// Pass 1: create building bodies (buildings + towers share static bodies —
// towers are buildings-with-turrets structurally). Shape policy lives in
// createPhysicsBodyForBuilding, shared with the runtime spawn path.
export function createBuildingBodiesForEntities(
  world: WorldState,
  physics: PhysicsEngine3D,
  entities: Entity[],
): void {
  for (const entity of entities) {
    if (entity.type === 'building') {
      createPhysicsBodyForBuilding(world, physics, entity);
    }
  }
}

// Pass 2: create unit bodies + set ignore-static for overlapping buildings
export function createUnitBodiesForEntities(
  world: WorldState,
  physics: PhysicsEngine3D,
  entities: Entity[],
): void {
  for (const entity of entities) {
    if (entity.type === 'unit' && entity.unit) {
      createPhysicsBodyForUnit(world, physics, entity, {
        ignoreOverlappingBuildings: true,
        overlapPadding: entity.unit.radius.collision,
      });
    }
  }
}
