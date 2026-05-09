import type { Entity } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import type { Body3D, PhysicsEngine3D } from './PhysicsEngine3D';

export type UnitPhysicsBodyOptions = {
  ignoreOverlappingBuildings?: boolean;
  overlapPadding?: number;
};

export function createPhysicsBodyForUnit(
  world: WorldState,
  physics: PhysicsEngine3D,
  entity: Entity,
  options: UnitPhysicsBodyOptions = {},
): Body3D | undefined {
  if (entity.type !== 'unit' || !entity.unit) return undefined;
  const existing = entity.body?.physicsBody;
  if (existing) return existing;

  const body = physics.createUnitBody(
    entity.transform.x,
    entity.transform.y,
    entity.unit.radius.push,
    entity.unit.bodyCenterHeight,
    entity.unit.mass,
    `unit_${entity.id}`,
    entity.id,
    entity.transform.z,
  );
  entity.body = { physicsBody: body };

  if (options.ignoreOverlappingBuildings) {
    const padding = options.overlapPadding ?? 0;
    const spawnX = entity.transform.x;
    const spawnY = entity.transform.y;
    for (const building of world.getBuildings()) {
      if (!building.body?.physicsBody || !building.building) continue;
      const bw = building.building.width / 2 + padding;
      const bh = building.building.height / 2 + padding;
      if (
        Math.abs(spawnX - building.transform.x) < bw &&
        Math.abs(spawnY - building.transform.y) < bh
      ) {
        physics.setIgnoreStatic(body, building.body.physicsBody);
        break;
      }
    }
  }

  return body;
}
