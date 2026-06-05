import { getTransformCosSin } from '../math';
import { getUnitBlueprint } from './blueprints';
import { createBuildable } from './buildableHelpers';
import { DamageSystem } from './damage';
import { spatialGrid } from './SpatialGrid';
import type { EntityId, PlayerId } from './types';
import { NO_ENTITY_ID } from './types';
import { resolveWeaponWorldMount } from './combat/combatUtils';
import { stampCombatTargetingPool } from './combat/targetingInputStamping';
import { getUnitGroundZ } from './unitGeometry';
import { WorldState } from './WorldState';

const TEST_UNIT_BLUEPRINT_ID = 'unitFormik';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[turret host integration] ${message}`);
  }
}

export function runTurretHostIntegrationContractTest(): void {
  spatialGrid.clear();
  try {
    const world = new WorldState(1234, 512, 512);
    world.playerCount = 2;
    const host = world.createUnitFromBlueprint(
      0,
      0,
      1 as PlayerId,
      TEST_UNIT_BLUEPRINT_ID,
    );
    world.addEntity(host);
    spatialGrid.updateUnit(host);
    stampCombatTargetingPool(world);

    const combat = host.combat;
    const hostUnit = host.unit;
    const blueprint = getUnitBlueprint(TEST_UNIT_BLUEPRINT_ID);
    if (combat === null || hostUnit === null) {
      throw new Error('[turret host integration] test host must be an armed unit');
    }
    assertContract(
      combat.turrets.length === blueprint.turrets.length,
      'host runtime turret count must match the authored blueprint assembly',
    );

    const turret = combat.turrets[0];
    assertContract(turret.id !== NO_ENTITY_ID, 'mounted turret must have an addressable id');
    const turretFields = turret as unknown as Record<string, unknown>;
    for (const field of ['hp', 'maxHp', 'cost', 'mass', 'deathExplosion', 'buildable', 'body', 'ownership', 'actions']) {
      assertContract(!(field in turretFields), `mounted turret must not carry independent ${field}`);
    }
    assertContract(world.getEntity(turret.id) === undefined, 'mounted turret must not be a detached entity');

    const meta = world.getEntityMeta(turret.id);
    if (meta === undefined) {
      throw new Error('[turret host integration] mounted turret metadata must be registered');
    }
    assertContract(meta.kind === 'turret', 'mounted turret metadata kind must be turret');
    assertContract(meta.parentId === host.id, 'mounted turret parent must be the host body');
    assertContract(meta.rootHostId === host.id, 'mounted turret root host must be the host body');
    assertContract(meta.mountIndex === turret.mountIndex, 'mounted turret metadata must preserve mount index');
    assertContract(meta.storagePool === 'combat.turrets', 'mounted turret metadata must resolve to the host combat pool');
    assertContract(meta.targetable, 'mounted non-visual turret must be targetable while the host body is live');
    const resolved = world.resolveMountedTurret(turret.id);
    assertContract(resolved?.host === host && resolved.turret === turret, 'mounted turret id must resolve back to its host assembly');

    const cs = getTransformCosSin(host.transform);
    const mount = resolveWeaponWorldMount(
      host,
      turret,
      turret.mountIndex,
      cs.cos,
      cs.sin,
      {
        currentTick: world.getTick(),
        unitGroundZ: getUnitGroundZ(host),
        surfaceN: hostUnit.surfaceNormal,
      },
    );
    // A turret is not a separate hit/collide body — radius.hitbox/collision
    // are removed. Area damage landing on a turret mount must never spawn a
    // separate turret kill, and the turret stays part of its host assembly.
    // (Whether the host body is hit now depends solely on the host's own
    // collider, never on a turret hit-surface, so we don't assert that here.)
    const damageResult = new DamageSystem(world).applyDamage({
      type: 'area',
      sourceEntityId: 9999 as EntityId,
      ownerId: 2 as PlayerId,
      damage: 7,
      excludeEntities: new Set<EntityId>(),
      center: { x: mount.x, y: mount.y, z: mount.z },
      radius: 1,
      knockbackForce: 0,
    });
    assertContract(damageResult.killedTurretIds.size === 0, 'damage at a turret mount must not kill a separate turret body');
    assertContract(world.resolveMountedTurret(turret.id)?.host === host, 'turret must remain mounted after area damage at its mount');

    const authoredTurrets = combat.turrets;
    host.buildable = createBuildable({ energy: 1, metal: 1 });
    host.buildable.pieces.push({
      id: host.id,
      kind: 'body',
      mountIndex: null,
      paid: { energy: 0, metal: 0 },
      required: { energy: 1, metal: 1 },
      healthBuildFraction: 0,
      isActive: false,
      isComplete: false,
    });
    world.refreshEntityMetadata(host);
    assertContract(world.resolveMountedTurret(turret.id) === undefined, 'unmaterialized host body must not leave a live turret');
    assertContract(host.combat?.turrets === authoredTurrets, 'construction state must keep the authored turret list on the host');

    host.buildable = null;
    hostUnit.hp = 0;
    world.refreshEntityMetadata(host);
    assertContract(world.resolveMountedTurret(turret.id) === undefined, 'dead host body must not leave a hostless live turret');
    assertContract(host.combat?.turrets === authoredTurrets, 'host death must keep turrets as part of the host assembly until removal');
  } finally {
    spatialGrid.clear();
  }
}
