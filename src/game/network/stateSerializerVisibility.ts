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

/** Per-recipient visibility filter.
 *
 *  Two parallel source pools (issues.txt FOW-03):
 *    - fullSources: units and non-radar buildings. Grant FULL info
 *      (entity present in the main snapshot with all fields).
 *    - radarSources: radar buildings. Grant ONLY positional intel —
 *      the entity appears on the minimap as a blip but is omitted
 *      from the main snapshot, so the player learns where without
 *      learning what / HP / orders.
 *
 *  The owner of an entity always sees their own stuff in full; the
 *  owner-aware short-circuit lives in isEntityVisible() and
 *  isEntityOnRadar(). */
export class SnapshotVisibility {
  private readonly fullSources: VisionSource[] = [];
  private readonly fullSourceCells = new Map<number, number[]>();
  private readonly radarSources: VisionSource[] = [];
  private readonly radarSourceCells = new Map<number, number[]>();
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

  /** Full-vision check: gates the MAIN snapshot. Owned entities are
   *  always full-visible; for foreign entities the recipient must have
   *  a full-vision source (unit / non-radar building) covering the
   *  entity position. Radar coverage does NOT grant full visibility. */
  isEntityVisible(entity: Entity): boolean {
    if (!this.isFiltered) return true;
    if (entity.ownership?.playerId === this.recipientPlayerId) return true;
    return this.isPointVisible(
      entity.transform.x,
      entity.transform.y,
      getEntityVisibilityPadding(entity),
    );
  }

  /** Minimap-tier check: full vision OR radar coverage. Used by the
   *  minimap serializer so radar buildings reveal enemy positions
   *  without leaking the rest of the snapshot. */
  isEntityOnRadar(entity: Entity): boolean {
    if (!this.isFiltered) return true;
    if (entity.ownership?.playerId === this.recipientPlayerId) return true;
    const padding = getEntityVisibilityPadding(entity);
    if (this.isPointVisibleIn(this.fullSources, this.fullSourceCells, entity.transform.x, entity.transform.y, padding)) {
      return true;
    }
    return this.isPointVisibleIn(this.radarSources, this.radarSourceCells, entity.transform.x, entity.transform.y, padding);
  }

  /** Full-vision point test. Audio events and projectile spawns hang
   *  off this — radar coverage doesn't leak sound or beam visuals. */
  isPointVisible(x: number, y: number, padding = 0): boolean {
    if (!this.isFiltered) return true;
    return this.isPointVisibleIn(this.fullSources, this.fullSourceCells, x, y, padding);
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
        if (canEntityProvideFullVision(entity)) {
          this.addSource(
            this.fullSources,
            this.fullSourceCells,
            entity.transform.x,
            entity.transform.y,
            getEntityFullVisionRadius(entity),
          );
        }
        if (canEntityProvideRadarVision(entity)) {
          this.addSource(
            this.radarSources,
            this.radarSourceCells,
            entity.transform.x,
            entity.transform.y,
            getEntityRadarRadius(entity),
          );
        }
      }
    }
  }

  private addSource(
    sources: VisionSource[],
    cells: Map<number, number[]>,
    x: number,
    y: number,
    radius: number,
  ): void {
    if (radius <= 0) return;
    const index = sources.length;
    sources.push({ x, y, radius });
    const minCx = Math.max(0, Math.floor((x - radius) / VISION_CELL_SIZE));
    const maxCx = Math.min(this.gridW - 1, Math.floor((x + radius) / VISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((y - radius) / VISION_CELL_SIZE));
    const maxCy = Math.min(this.gridH - 1, Math.floor((y + radius) / VISION_CELL_SIZE));
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.cellKey(cx, cy);
        let bucket = cells.get(key);
        if (!bucket) {
          bucket = [];
          cells.set(key, bucket);
        }
        bucket.push(index);
      }
    }
  }

  private isPointVisibleIn(
    sources: VisionSource[],
    cells: Map<number, number[]>,
    x: number,
    y: number,
    padding: number,
  ): boolean {
    const cx = Math.floor(x / VISION_CELL_SIZE);
    const cy = Math.floor(y / VISION_CELL_SIZE);
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return false;
    const sourceIndexes = cells.get(this.cellKey(cx, cy));
    if (!sourceIndexes) return false;
    for (let i = 0; i < sourceIndexes.length; i++) {
      const source = sources[sourceIndexes[i]];
      const dx = x - source.x;
      const dy = y - source.y;
      const r = source.radius + padding;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  private cellKey(cx: number, cy: number): number {
    return cy * this.gridW + cx;
  }
}

/** True when the entity contributes a normal line-of-sight source
 *  (units, non-radar buildings — alive). Radar buildings are
 *  intentionally excluded: they are sensors, not eyes. */
export function canEntityProvideFullVision(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (entity.building && entity.buildingType !== 'radar') return entity.building.hp > 0;
  return false;
}

/** True when the entity is a radar-class sensor (alive). Currently
 *  only the radar building qualifies; mobile-radar units could be
 *  added by extending this predicate without touching callers. */
export function canEntityProvideRadarVision(entity: Entity): boolean {
  if (!entity.building) return false;
  if (entity.building.hp <= 0) return false;
  return entity.buildingType === 'radar';
}

/** Legacy: returns true if entity contributes ANY vision (full OR
 *  radar). Kept for the client-side shroud renderer, which lights up
 *  terrain wherever the local player has any kind of coverage. */
export function canEntityProvideVision(entity: Entity): boolean {
  return canEntityProvideFullVision(entity) || canEntityProvideRadarVision(entity);
}

export function getEntityFullVisionRadius(entity: Entity): number {
  if (!canEntityProvideFullVision(entity)) return 0;
  let radius = entity.unit
    ? (entity.commander ? COMMANDER_VISION_RADIUS : UNIT_VISION_RADIUS)
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

export function getEntityRadarRadius(entity: Entity): number {
  if (!canEntityProvideRadarVision(entity)) return 0;
  return RADAR_VISION_RADIUS;
}

/** Legacy: returns max of full + radar radii. The client-side shroud
 *  renderer uses this so radar coverage clears the shroud — terrain
 *  inside a radar's footprint counts as "currently visible" for the
 *  exploration overlay even though enemies there only appear as
 *  minimap blips. */
export function getEntityVisionRadius(entity: Entity): number {
  return Math.max(getEntityFullVisionRadius(entity), getEntityRadarRadius(entity));
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
