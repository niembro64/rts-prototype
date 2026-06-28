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

// Pass 1: create building bodies (buildings + towers share static
// cuboid bodies — towers are buildings-with-turrets structurally).
export function createBuildingBodiesForEntities(
  world: WorldState,
  physics: PhysicsEngine3D,
  entities: Entity[],
): void {
  for (const entity of entities) {
    if ((entity.type === 'building' || entity.type === 'tower') && entity.building) {
      // Hovering structures (the fabricator torus) are intangible at ground
      // level — no collision body — so units pass under and falling units drop
      // straight through to the ground. (Mirrors ServerSimulationCore's runtime
      // onBuildingSpawn path.)
      if (entity.building.hovering) continue;
      // baseZ matches WorldState.createBuilding's terrain lookup so
      // the static cuboid body sits where the entity transform says
      // it does — base on the local cube tile top.
      const baseZ = entity.transform.z - entity.building.depth / 2;
      const body = physics.createBuildingBody(
        entity.transform.x,
        entity.transform.y,
        entity.building.width,
        entity.building.height,
        entity.building.depth,
        baseZ,
        entity.building.supportSurface,
        `building_${entity.id}`,
        entity.id,
      );
      entity.body = { physicsBody: body };
      world.refreshEntitySlotState(entity);
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
