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
import { getUnitGroundZ } from '../sim/unitGeometry';
import {
  fabricatorTorusRingRadius,
  fabricatorTorusOuterRadius,
} from '../sim/fabricatorGeometry';
import { SUPPORT_SURFACE_CONTACT_EPSILON } from '../sim/supportSurface';

/** Create and attach the physics body for a building entity. No-op when the
 *  entity already has a body or is not a building. */
export function createPhysicsBodyForBuilding(
  world: WorldState,
  physics: PhysicsEngine3D,
  entity: Entity,
): void {
  if (entity.building === null || entity.body !== null) return;

  if (entity.building.hoveringType === 'fabricator') {
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

  if (entity.building.hoveringType === 'directionalFabricator') {
    // Aircraft specialists are floating, directional flight decks rather
    // than annuli. Their cuboid follows the visible deck in the air while the
    // ground-level placement reservation stays non-blocking.
    const centerZ = getBuildingCombatCenterZ(entity);
    const body = physics.createBuildingBody(
      entity.transform.x,
      entity.transform.y,
      entity.building.width,
      entity.building.height,
      entity.building.depth,
      centerZ - entity.building.depth / 2,
      entity.building.supportSurface,
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
  const baseZ = getUnitGroundZ(entity);
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

/** Runtime placement can create a static shell around the builder (or another
 * unit) before pathing has moved it clear. Temporarily ignore that one new
 * cuboid for every sphere genuinely starting inside it; PhysicsEngine3D
 * removes each pair as soon as the sphere exits the expanded bounds. */
export function ignoreNewBuildingBodyForOverlappingUnits(
  world: WorldState,
  physics: Pick<PhysicsEngine3D, 'setIgnoreStatic'>,
  buildingEntity: Entity,
): number {
  const staticBody = buildingEntity.body?.physicsBody;
  if (staticBody === undefined || staticBody.shape !== 'cuboid') return 0;
  let ignoredCount = 0;
  for (const unitEntity of world.getUnits()) {
    const dynamicBody = unitEntity.body?.physicsBody;
    if (dynamicBody === undefined || dynamicBody.shape !== 'sphere') continue;
    // A unit already resting on or above the new top should keep ordinary
    // support/collision. The escape ignore is only for a body enclosed by it.
    if (
      staticBody.supportTopZ !== null &&
      dynamicBody.z - dynamicBody.groundOffset >=
        staticBody.supportTopZ - SUPPORT_SURFACE_CONTACT_EPSILON
    ) {
      continue;
    }
    const clearance = dynamicBody.radius;
    if (
      Math.abs(dynamicBody.x - staticBody.x) > staticBody.halfX + clearance ||
      Math.abs(dynamicBody.y - staticBody.y) > staticBody.halfY + clearance ||
      Math.abs(dynamicBody.z - staticBody.z) > staticBody.halfZ + clearance
    ) {
      continue;
    }
    physics.setIgnoreStatic(dynamicBody, staticBody);
    ignoredCount++;
  }
  return ignoredCount;
}
