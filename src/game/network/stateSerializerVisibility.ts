import type { RemovedSnapshotEntity, WorldState } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';

export const VISION_CELL_SIZE = 512;
export const UNIT_VISION_RADIUS = 1200;
export const COMMANDER_VISION_RADIUS = 1600;
export const BUILDING_VISION_RADIUS = 1000;
export const RADAR_VISION_RADIUS = 4200;
export const TURRET_VISION_PAD = 250;
export const BUILDER_VISION_PAD = 250;

type VisionSource = {
  x: number;
  y: number;
  radius: number;
};

export class SnapshotVisibility {
  private readonly sources: VisionSource[] = [];
  private readonly sourceCells = new Map<number, number[]>();
  private readonly gridW: number;
  private readonly gridH: number;

  readonly isFiltered: boolean;

  private constructor(
    private readonly recipientPlayerId: PlayerId | undefined,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.isFiltered = recipientPlayerId !== undefined;
    this.gridW = Math.max(1, Math.ceil(mapWidth / VISION_CELL_SIZE));
    this.gridH = Math.max(1, Math.ceil(mapHeight / VISION_CELL_SIZE));
  }

  static forRecipient(world: WorldState, recipientPlayerId: PlayerId | undefined): SnapshotVisibility {
    const filteredPlayerId = world.fogOfWarEnabled ? recipientPlayerId : undefined;
    const visibility = new SnapshotVisibility(filteredPlayerId, world.mapWidth, world.mapHeight);
    if (filteredPlayerId === undefined) return visibility;
    visibility.addPlayerSources(world, filteredPlayerId);
    return visibility;
  }

  canSeePrivateEntityDetails(entity: Entity): boolean {
    return (
      !this.isFiltered ||
      entity.ownership?.playerId === this.recipientPlayerId
    );
  }

  canReferenceEntityId(world: WorldState, entityId: EntityId | undefined): boolean {
    if (entityId === undefined) return false;
    if (!this.isFiltered) return true;
    const entity = world.getEntity(entityId);
    return entity !== undefined && this.isEntityVisible(entity);
  }

  isEntityVisible(entity: Entity): boolean {
    if (!this.isFiltered) return true;
    if (entity.ownership?.playerId === this.recipientPlayerId) return true;
    return this.isPointVisible(
      entity.transform.x,
      entity.transform.y,
      getEntityVisibilityPadding(entity),
    );
  }

  isPointVisible(x: number, y: number, padding = 0): boolean {
    if (!this.isFiltered) return true;
    const cx = Math.floor(x / VISION_CELL_SIZE);
    const cy = Math.floor(y / VISION_CELL_SIZE);
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return false;
    const sourceIndexes = this.sourceCells.get(this.cellKey(cx, cy));
    if (!sourceIndexes) return false;
    for (let i = 0; i < sourceIndexes.length; i++) {
      const source = this.sources[sourceIndexes[i]];
      const dx = x - source.x;
      const dy = y - source.y;
      const r = source.radius + padding;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  shouldSendRemoval(record: RemovedSnapshotEntity): boolean {
    if (!this.isFiltered) return true;
    if (record.playerId === this.recipientPlayerId) return true;
    return this.isPointVisible(record.x, record.y);
  }

  private addPlayerSources(world: WorldState, playerId: PlayerId): void {
    const sources: ReadonlyArray<readonly Entity[]> = [
      world.getUnitsByPlayer(playerId),
      world.getBuildingsByPlayer(playerId),
    ];
    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (!canEntityProvideVision(entity)) continue;
        this.addSource(entity.transform.x, entity.transform.y, getEntityVisionRadius(entity));
      }
    }
  }

  private addSource(x: number, y: number, radius: number): void {
    const index = this.sources.length;
    this.sources.push({ x, y, radius });
    const minCx = Math.max(0, Math.floor((x - radius) / VISION_CELL_SIZE));
    const maxCx = Math.min(this.gridW - 1, Math.floor((x + radius) / VISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((y - radius) / VISION_CELL_SIZE));
    const maxCy = Math.min(this.gridH - 1, Math.floor((y + radius) / VISION_CELL_SIZE));
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.cellKey(cx, cy);
        let bucket = this.sourceCells.get(key);
        if (!bucket) {
          bucket = [];
          this.sourceCells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }

  private cellKey(cx: number, cy: number): number {
    return cy * this.gridW + cx;
  }
}

export function canEntityProvideVision(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (entity.building) return entity.building.hp > 0;
  return false;
}

export function getEntityVisionRadius(entity: Entity): number {
  let radius = entity.unit
    ? (entity.commander ? COMMANDER_VISION_RADIUS : UNIT_VISION_RADIUS)
    : entity.buildingType === 'radar'
      ? RADAR_VISION_RADIUS
      : BUILDING_VISION_RADIUS;

  const turrets = entity.combat?.turrets;
  if (turrets) {
    for (let i = 0; i < turrets.length; i++) {
      radius = Math.max(radius, turrets[i].config.range + TURRET_VISION_PAD);
    }
  }
  if (entity.builder) {
    radius = Math.max(radius, entity.builder.buildRange + BUILDER_VISION_PAD);
  }
  return radius;
}

export function getEntityVisibilityPadding(entity: Entity): number {
  if (entity.unit) {
    return Math.max(
      entity.unit.radius.body,
      entity.unit.radius.shot,
      entity.unit.radius.push,
    );
  }
  if (entity.building) {
    return Math.max(entity.building.width, entity.building.height) * 0.5;
  }
  return 0;
}
