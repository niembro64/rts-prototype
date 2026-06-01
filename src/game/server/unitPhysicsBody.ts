import type { Entity } from '../sim/types';
import type { WorldState } from '../sim/WorldState';
import type { Body3D, PhysicsEngine3D } from './PhysicsEngine3D';
import { getTurretBlueprint } from '../sim/blueprints/turrets';

export type UnitPhysicsBodyOptions = {
  ignoreOverlappingBuildings: boolean | undefined;
  overlapPadding: number | undefined;
};

/** Effective physical mass of a mobile unit host = its unit body mass
 *  plus the base mass of every LIVE mounted turret.
 *  A piece that has died (hp <= 0) or detached no longer weighs on the
 *  host, so a tank that loses a turret accelerates and gets knocked around
 *  more. Mass is summed at runtime here, mirroring how cost is summed at
 *  load time (see "Every entity shares one base ledger" / "mass must
 *  matter"). Returns the pre-UNIT_MASS_MULTIPLIER mass the physics body
 *  takes; callers feed it to createUnitBody / setBodyEffectiveMass. */
export function computeHostEffectiveMass(entity: Entity): number {
  const unit = entity.unit;
  if (unit === null) return 0;
  let mass = unit.mass; // unit body mass includes its inline locomotion.
  const combat = entity.combat;
  if (combat !== null) {
    const turrets = combat.turrets;
    for (let i = 0; i < turrets.length; i++) {
      const turret = turrets[i];
      if (turret.hp > 0) {
        mass += getTurretBlueprint(turret.config.turretBlueprintId).base.mass;
      }
    }
  }
  return mass;
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
        physics.setIgnoreStatic(body, buildingBody.physicsBody);
        break;
      }
    }
  }

  return body;
}
