import type {
  Entity,
  EntityId,
  EntityMeta,
  EntityMetaBlueprintKind,
  EntityMetaKind,
  PlayerId,
} from './types';
import { NO_ENTITY_ID } from './types';
import { isConstructionPieceMaterialized } from './buildableHelpers';

export class WorldEntityMetadata {
  private readonly metaById = new Map<EntityId, EntityMeta>();
  private readonly entities: Map<EntityId, Entity>;
  private readonly resolveTeamId: (playerId: PlayerId) => number;

  constructor(
    entities: Map<EntityId, Entity>,
    resolveTeamId: (playerId: PlayerId) => number,
  ) {
    this.entities = entities;
    this.resolveTeamId = resolveTeamId;
  }

  get(id: EntityId): EntityMeta | undefined {
    return this.metaById.get(id);
  }

  resolveMountedTurret(id: EntityId): { host: Entity; turret: NonNullable<Entity['combat']>['turrets'][number] } | undefined {
    const meta = this.metaById.get(id);
    if (meta === undefined || !meta.alive || meta.kind !== 'turret' || meta.parentId === null) {
      return undefined;
    }
    const host = this.entities.get(meta.parentId);
    if (host === undefined) return undefined;
    const combat = host.combat;
    if (combat === null) return undefined;
    const turret = combat.turrets[meta.mountIndex ?? -1];
    if (turret === undefined || turret.id !== id || !this.isHostBodyLive(host)) return undefined;
    return { host, turret };
  }

  resolve(id: EntityId, generation: number): EntityMeta | undefined {
    const meta = this.metaById.get(id);
    if (meta === undefined || !meta.alive || meta.generation !== generation) return undefined;
    return meta;
  }

  register(entity: Entity): void {
    const ownerPlayerId = entity.ownership !== null ? entity.ownership.playerId : null;
    const teamId = ownerPlayerId !== null ? this.resolveTeamId(ownerPlayerId) : null;
    const entityKind: EntityMetaKind = entity.type;
    const rootHostId = entity.projectile !== null
      ? entity.projectile.shotSource.sourceRootEntityId
      : entity.id;
    const bodyTargetable =
      entity.unit !== null
        ? entity.unit.hp > 0 && isConstructionPieceMaterialized(entity, 'body')
        : (entity.building !== null
          ? entity.building.hp > 0 && isConstructionPieceMaterialized(entity, 'body')
          : (entity.projectile !== null ? entity.projectile.hp > 0 : false));
    this.upsert({
      id: entity.id,
      kind: entityKind,
      blueprintKind: this.entityBlueprintKind(entity),
      blueprintId: this.entityBlueprintId(entity),
      ownerPlayerId,
      teamId,
      parentId: null,
      rootHostId,
      mountIndex: null,
      storagePool: 'entities',
      storageSlot: entity.id,
      generation: 0,
      alive: true,
      targetable: bodyTargetable,
    });

    const combat = entity.combat;
    if (combat !== null) {
      for (let i = 0; i < combat.turrets.length; i++) {
        const turret = combat.turrets[i];
        if (turret.id === NO_ENTITY_ID) continue;
        if (!isConstructionPieceMaterialized(entity, 'body')) {
          this.markDead(turret.id);
          continue;
        }
        if (!bodyTargetable) {
          this.markDead(turret.id);
          continue;
        }
        this.upsert({
          id: turret.id,
          kind: 'turret',
          blueprintKind: 'turret',
          blueprintId: turret.config.turretBlueprintId,
          ownerPlayerId,
          teamId,
          parentId: turret.parentId,
          rootHostId: turret.rootHostId,
          mountIndex: turret.mountIndex,
          storagePool: 'combat.turrets',
          storageSlot: i,
          generation: 0,
          alive: true,
          targetable: !turret.config.visualOnly && bodyTargetable,
        });
      }
    }
  }

  markSubEntityDead(id: EntityId): void {
    this.markDead(id);
  }

  refresh(entity: Entity): void {
    this.register(entity);
  }

  setSubEntityTargetable(id: EntityId, targetable: boolean): void {
    const previous = this.metaById.get(id);
    if (previous === undefined || !previous.alive || previous.storagePool === 'entities') return;
    const mountedTurret = previous.kind === 'turret' ? this.resolveMountedTurret(id) : undefined;
    const canEverTarget =
      mountedTurret !== undefined &&
      this.isHostBodyLive(mountedTurret.host) &&
      !mountedTurret.turret.config.visualOnly;
    const nextTargetable = targetable && canEverTarget;
    if (previous.targetable === nextTargetable) return;
    this.metaById.set(id, {
      ...previous,
      targetable: nextTargetable,
    });
  }

  markEntityDead(entity: Entity): void {
    this.markDead(entity.id);
    const combat = entity.combat;
    if (combat !== null) {
      for (let i = 0; i < combat.turrets.length; i++) {
        this.markDead(combat.turrets[i].id);
      }
    }
  }

  private upsert(meta: EntityMeta): void {
    const previous = this.metaById.get(meta.id);
    const generation = previous !== undefined && previous.alive
      ? previous.generation
      : (previous?.generation ?? 0) + 1;
    this.metaById.set(meta.id, {
      ...meta,
      generation,
      alive: true,
    });
  }

  private entityBlueprintKind(entity: Entity): EntityMetaBlueprintKind {
    if (entity.type === 'unit') return 'unit';
    if (entity.type === 'tower') return 'tower';
    if (entity.type === 'building') return 'building';
    if (entity.type === 'shot') return 'shot';
    return 'none';
  }

  private entityBlueprintId(entity: Entity): string | null {
    if (entity.unit !== null) return entity.unit.unitBlueprintId;
    if (entity.buildingBlueprintId !== null) return entity.buildingBlueprintId;
    if (entity.projectile !== null) return entity.projectile.shotBlueprintId;
    return null;
  }

  private isHostBodyLive(entity: Entity): boolean {
    if (entity.unit !== null) return entity.unit.hp > 0 && isConstructionPieceMaterialized(entity, 'body');
    if (entity.building !== null) return entity.building.hp > 0 && isConstructionPieceMaterialized(entity, 'body');
    return false;
  }

  private markDead(id: EntityId): void {
    const previous = this.metaById.get(id);
    if (previous === undefined || !previous.alive) return;
    this.metaById.set(id, {
      ...previous,
      alive: false,
      targetable: false,
    });
  }
}
