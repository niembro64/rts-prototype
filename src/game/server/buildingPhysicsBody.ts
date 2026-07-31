// Shared building physics-body creation for the initial-spawn pass and the
// runtime onBuildingSpawn path — one place decides what collision presence a
// building has:
//
// - Grounded buildings (and towers) are static ground-seated cuboids.
// - Hovering buildings (the fabricator torus) get a static annular-cylinder
//   ("ring") body floating at their combat center: aircraft collide with the
//   visible torus, while ground units drive underneath and released
//   production shells fall through the open center hole. Units spawned
//   overlapping the footprint get the standard ignore-static pair
//   (createPhysicsBodyForUnit), so production releases never snag the ring.
//
// A hovering building's only ground-level effect remains its construction
// reservation in the BuildingGrid.

import type { WorldState } from '../sim/WorldState';
import type { Entity } from '../sim/types';
import type { PhysicsEngine3D } from './PhysicsEngine3D';
import { getBuildingCombatCenterZ } from '../sim/buildingAnchors';
import {
  fabricatorTorusRingRadius,
  fabricatorTorusOuterRadius,
} from '../sim/blueprints/buildings';

/** Create and attach the physics body for a building entity. No-op when the
 *  entity already has a body or is not a building. */
export function createPhysicsBodyForBuilding(
  world: WorldState,
  physics: PhysicsEngine3D,
  entity: Entity,
): void {
  if (entity.building === null || entity.body !== null) return;

  if (entity.building.hovering) {
    const width = entity.building.width;
    const height = entity.building.height;
    const ringRadius = fabricatorTorusRingRadius(width, height);
    const outerRadius = fabricatorTorusOuterRadius(width, height);
    const tubeHalfHeight = outerRadius - ringRadius;
    const innerRadius = ringRadius - tubeHalfHeight;
    const body = physics.createHoveringRingBody(
      entity.transform.x,
      entity.transform.y,
      getBuildingCombatCenterZ(entity),
      outerRadius,
      innerRadius,
      tubeHalfHeight,
      `building_${entity.id}`,
      entity.id,
    );
    entity.body = { physicsBody: body };
    world.refreshEntitySlotState(entity);
    return;
  }

  // baseZ matches WorldState.createBuilding's terrain lookup so the static
  // cuboid body sits where the entity transform says it does — base on the
  // local cube tile top.
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
