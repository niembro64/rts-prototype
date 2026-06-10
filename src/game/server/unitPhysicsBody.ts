import type { Entity } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import type { Body3D, PhysicsEngine3D } from './PhysicsEngine3D';
import { SUPPORT_SURFACE_CONTACT_EPSILON } from '../sim/supportSurface';

export type UnitPhysicsBodyOptions = {
  ignoreOverlappingBuildings: boolean | undefined;
  overlapPadding: number | undefined;
};

/** Effective physical mass of a mobile unit host. Mounted turrets are
 *  inseparable emitters now, so their weight belongs to the authored host
 *  body instead of being summed as live/detached sub-pieces at runtime. */
export function computeHostEffectiveMass(entity: Entity): number {
  const unit = entity.unit;
  if (unit === null) return 0;
  return unit.mass;
}

function bodyStartsAboveStaticSupport(dynamicBody: Body3D, staticBody: Body3D): boolean {
  if (dynamicBody.shape !== 'sphere' || staticBody.shape !== 'cuboid') return false;
  const topZ = staticBody.supportTopZ;
  if (topZ === null) return false;
  return dynamicBody.z - dynamicBody.groundOffset >= topZ - SUPPORT_SURFACE_CONTACT_EPSILON;
}

export function createPhysicsBodyForUnit(
  world: WorldState,
  physics: PhysicsEngine3D,
  entity: Entity,
  options: UnitPhysicsBodyOptions | undefined = undefined,
): Body3D | undefined {
  if (entity.type !== 'unit' || !entity.unit) return undefined;
  const existingBody = entity.body;
  if (existingBody !== null) return existingBody.physicsBody;

  const body = physics.createUnitBody(
    entity.transform.x,
    entity.transform.y,
    entity.unit.radius.collision,
    entity.unit.bodyCenterHeight,
    entity.unit.supportSurface,
    computeHostEffectiveMass(entity),
    `unit_${entity.id}`,
    entity.id,
    entity.transform.z,
    entity.unit.surfaceNormal,
  );
  entity.body = { physicsBody: body };
  entity.unit.surfaceNormal = body.createSurfaceNormalView();

  if (options !== undefined && options.ignoreOverlappingBuildings === true) {
    const padding = options.overlapPadding !== undefined ? options.overlapPadding : 0;
    const spawnX = entity.transform.x;
    const spawnY = entity.transform.y;
    for (const building of world.getBuildings()) {
      const buildingBody = building.body;
      if (buildingBody === null || building.building === null) continue;
      const bw = building.building.width / 2 + padding;
      const bh = building.building.height / 2 + padding;
      if (
        Math.abs(spawnX - building.transform.x) < bw &&
        Math.abs(spawnY - building.transform.y) < bh
      ) {
        if (bodyStartsAboveStaticSupport(body, buildingBody.physicsBody)) continue;
        physics.setIgnoreStatic(body, buildingBody.physicsBody);
        break;
      }
    }
  }

  return body;
}
