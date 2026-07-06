import { EntityCacheManager } from './EntityCacheManager';
import type { Entity, EntityId, EntityType, PlayerId, ProjectileType } from './types';
import { createEmptyEntityComponentSlots, createTransform } from './types';
import { createBuildable } from './buildableHelpers';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[entity cache manager contract] ${message}`);
  }
}

function ids(list: readonly Entity[]): string {
  return list.map((entity) => entity.id).join(',');
}

function values(list: readonly number[]): string {
  return list.join(',');
}

function entityBase(id: EntityId, type: EntityType, playerId: PlayerId | null): Entity {
  const entity = {
    ...createEmptyEntityComponentSlots(),
    id,
    type,
    transform: createTransform(id, id * 2, 0, 0),
  };
  entity.ownership = playerId !== null ? { playerId } : null;
  return entity;
}

function unitEntity(
  id: EntityId,
  playerId: PlayerId,
  options: {
    hp?: number;
    maxHp?: number;
    flying?: boolean;
    builder?: boolean;
    commander?: boolean;
    factory?: boolean;
    shieldPanel?: boolean;
    shieldTurret?: boolean;
    beamTurret?: boolean;
    shell?: boolean;
  } = {},
): Entity {
  const entity = entityBase(id, 'unit', playerId);
  entity.unit = {
    hp: options.hp ?? 100,
    maxHp: options.maxHp ?? 100,
    shieldPanels: options.shieldPanel === true ? [{}] : [],
    locomotion: { type: options.flying === true ? 'flying' : 'ground' },
  } as Entity['unit'];
  if (options.builder === true) entity.builder = {} as Entity['builder'];
  if (options.commander === true) entity.commander = {} as Entity['commander'];
  if (options.factory === true) entity.factory = {} as Entity['factory'];
  if (options.shell === true) {
    entity.buildable = createBuildable({ energy: 100, metal: 100 });
  }
  if (options.shieldTurret === true || options.beamTurret === true) {
    entity.combat = {
      turrets: [
        {
          config: {
            visualOnly: false,
            shot: options.shieldTurret === true
              ? { type: 'shield', barrier: {} }
              : { type: 'beam' },
          },
        },
      ],
    } as Entity['combat'];
  }
  return entity;
}

function buildingEntity(
  id: EntityId,
  playerId: PlayerId,
  blueprintId: Entity['buildingBlueprintId'],
  options: {
    hp?: number;
    maxHp?: number;
    factory?: boolean;
    shell?: boolean;
    beamTurret?: boolean;
  } = {},
): Entity {
  const entity = entityBase(id, 'building', playerId);
  entity.buildingBlueprintId = blueprintId;
  entity.building = {
    hp: options.hp ?? 200,
    maxHp: options.maxHp ?? 200,
  } as Entity['building'];
  if (options.factory === true) entity.factory = {} as Entity['factory'];
  if (options.shell === true) {
    entity.buildable = createBuildable({ energy: 100, metal: 100 });
  }
  if (options.beamTurret === true) {
    entity.combat = {
      turrets: [
        {
          config: {
            visualOnly: false,
            shot: { type: 'beam' },
          },
        },
      ],
    } as Entity['combat'];
  }
  return entity;
}

function projectileEntity(
  id: EntityId,
  projectileType: ProjectileType,
  smokeTrail = false,
): Entity {
  const entity = entityBase(id, 'shot', null);
  entity.projectile = {
    projectileType,
    config: {
      shotProfile: {
        visual: { smokeTrail },
      },
    },
  } as unknown as Entity['projectile'];
  return entity;
}

function rebuildCache(entities: readonly Entity[]): EntityCacheManager {
  const manager = new EntityCacheManager();
  const map = new Map<EntityId, Entity>();
  for (let i = 0; i < entities.length; i++) map.set(entities[i].id, entities[i]);
  manager.rebuildIfNeeded(map);
  return manager;
}

function snapshot(manager: EntityCacheManager): Record<string, string> {
  return {
    all: ids(manager.getAll()),
    units: ids(manager.getUnits()),
    buildings: ids(manager.getBuildings()),
    unitsAndBuildings: ids(manager.getUnitsAndBuildings()),
    combatTargets: ids(manager.getCombatTargetEntities()),
    unitsP1: ids(manager.getUnitsByPlayer(1 as PlayerId)),
    unitsP2: ids(manager.getUnitsByPlayer(2 as PlayerId)),
    buildingsP1: ids(manager.getBuildingsByPlayer(1 as PlayerId)),
    buildingsP2: ids(manager.getBuildingsByPlayer(2 as PlayerId)),
    projectiles: ids(manager.getProjectiles()),
    travelingProjectiles: ids(manager.getTravelingProjectiles()),
    smokeTrailProjectiles: ids(manager.getSmokeTrailProjectiles()),
    lineProjectiles: ids(manager.getLineProjectiles()),
    damagedUnits: ids(manager.getDamagedUnits()),
    healthBarBuildings: ids(manager.getHealthBarBuildings()),
    hudEntities: ids(manager.getHudEntities()),
    windBuildings: ids(manager.getWindBuildings()),
    extractorBuildings: ids(manager.getExtractorBuildings()),
    converterBuildings: ids(manager.getConverterBuildings()),
    activeStateBuildings: ids(manager.getActiveStateBuildings()),
    factoryBuildings: ids(manager.getFactoryBuildings()),
    factoryUnits: ids(manager.getFactoryUnits()),
    factoriesP1: ids(manager.getFactoriesByPlayer(1 as PlayerId)),
    factoriesP2: ids(manager.getFactoriesByPlayer(2 as PlayerId)),
    shieldUnits: ids(manager.getShieldUnits()),
    commanderUnits: ids(manager.getCommanderUnits()),
    builderUnits: ids(manager.getBuilderUnits()),
    flyingUnits: ids(manager.getFlyingUnits()),
    flyingUnitSlots: values(manager.getFlyingUnitSlots()),
    armedEntities: ids(manager.getArmedEntities()),
    beamUnits: ids(manager.getBeamUnits()),
    shieldPanelUnits: ids(manager.getShieldPanelUnits()),
  };
}

function assertMatchesRebuild(
  manager: EntityCacheManager,
  entities: readonly Entity[],
  label: string,
): void {
  const actual = snapshot(manager);
  const expected = snapshot(rebuildCache(entities));
  for (const key of Object.keys(expected)) {
    assertContract(
      actual[key] === expected[key],
      `${label}: ${key} mismatch incremental=${actual[key]} rebuild=${expected[key]}`,
    );
  }
}

export function runEntityCacheManagerContractTest(): void {
  const entities: Entity[] = [
    unitEntity(10 as EntityId, 1 as PlayerId, { shieldTurret: true }),
    buildingEntity(30 as EntityId, 1 as PlayerId, null, { factory: true }),
    projectileEntity(50 as EntityId, 'projectile', true),
  ];
  const manager = rebuildCache(entities);

  const outOfOrderUnit = unitEntity(5 as EntityId, 2 as PlayerId, {
    hp: 25,
    maxHp: 100,
    flying: true,
    builder: true,
    commander: true,
    factory: true,
    shieldPanel: true,
    shell: true,
  });
  entities.push(outOfOrderUnit);
  manager.handleEntityAdded(outOfOrderUnit);
  assertMatchesRebuild(manager, entities, 'after unit add');

  const outOfOrderBuilding = buildingEntity(20 as EntityId, 2 as PlayerId, 'buildingWind', {
    hp: 90,
    maxHp: 200,
    shell: true,
    beamTurret: true,
  });
  entities.push(outOfOrderBuilding);
  manager.handleEntityAdded(outOfOrderBuilding);
  assertMatchesRebuild(manager, entities, 'after building add');

  const lineProjectile = projectileEntity(15 as EntityId, 'beam');
  entities.push(lineProjectile);
  manager.handleEntityAdded(lineProjectile);
  assertMatchesRebuild(manager, entities, 'after projectile add');

  const removed = entities[0];
  entities.splice(0, 1);
  manager.handleEntityRemoved(removed);
  assertMatchesRebuild(manager, entities, 'after unit remove');

  const removedBuildingIndex = entities.indexOf(outOfOrderBuilding);
  entities.splice(removedBuildingIndex, 1);
  manager.handleEntityRemoved(outOfOrderBuilding);
  assertMatchesRebuild(manager, entities, 'after building remove');
}
