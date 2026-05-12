import type { RemovedSnapshotEntity, WorldState } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type {
  NetworkServerSnapshotScanPulse,
  NetworkServerSnapshotShroud,
} from '../../types/network';
import { hasTerrainLineOfSight } from '../sim/combat/lineOfSight';
import { SHROUD_CELL_SIZE } from '../sim/WorldState';
import { buildRecipientShroudView } from '../sim/shroudBitmap';
import {
  canEntityProvideDetection,
  getEntityDetectionPadding,
  getEntityDetectorRadius,
  isEntityCloaked,
} from '../sim/cloakDetection';

export const VISION_CELL_SIZE = 512;
export const UNIT_VISION_RADIUS = 1200;
export const COMMANDER_VISION_RADIUS = 1600;
export const BUILDING_VISION_RADIUS = 1000;
export const RADAR_VISION_RADIUS = 4200;
export const TURRET_VISION_PAD = 250;
export const BUILDER_VISION_PAD = 250;
/** Additional radius beyond a full-vision source where sounds carry
 *  but visuals do not (FOW-09). A vision-source's effective audio
 *  reach is `radius + EARSHOT_PAD`. Tuned roughly half the unit
 *  vision radius — enough to hear gunfire just over the rim of your
 *  scout's circle, not enough to hear a base under attack across
 *  the map. */
export const EARSHOT_PAD = 600;

/** Eye-height above transform.z assumed for vision sources when
 *  running the terrain LOS check (issues.txt FOW-04). Constant rather
 *  than per-entity-type because the existing transform.z already
 *  encodes ground elevation, so a unit standing on a hill gets the
 *  hill's lift "for free" — this just adds a body/turret-mount offset
 *  on top so two units on flat ground can still see each other over
 *  a small bump. */
const VISION_SOURCE_EYE_HEIGHT = 30;

/** Target-side z offset above transform.z when running the LOS check.
 *  Slightly less than VISION_SOURCE_EYE_HEIGHT — the source is
 *  actively looking (turret head, sensor mast), the target is just a
 *  body to be observed. */
const VISION_TARGET_BODY_HEIGHT = 15;

type VisionSource = {
  x: number;
  y: number;
  z: number;
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
 *  isEntityOnRadar().
 *
 *  Cloak detection is a third, independent source pool: detector
 *  coverage never grants vision by itself, but cloaked entities must
 *  be inside detector coverage before normal full/radar checks can
 *  reveal them. */
export class SnapshotVisibility {
  private readonly fullSources: VisionSource[] = [];
  private readonly fullSourceCells = new Map<number, number[]>();
  private readonly radarSources: VisionSource[] = [];
  private readonly radarSourceCells = new Map<number, number[]>();
  private readonly detectorSources: VisionSource[] = [];
  private readonly detectorSourceCells = new Map<number, number[]>();
  private readonly gridW: number;
  private readonly gridH: number;
  /** Recipient + their declared allies (FOW-06). Populated whenever a
   *  recipient is set, regardless of fog status — that way delta
   *  resolution still distinguishes owned from observed entities
   *  even with `fogOfWarEnabled=false`. Used by isOwnedByRecipientOrAlly
   *  so every ownership check across the serializer treats allies
   *  symmetrically with the recipient — private fields, AOI
   *  persistence, delta resolution, kill credit, the lot. */
  private readonly viewPlayerIds: Set<PlayerId> = new Set();

  /** True when fog-of-war filtering is active for this snapshot
   *  (recipient set AND world.fogOfWarEnabled). Distinct from "has a
   *  recipient" — a recipient with fog disabled still wants
   *  owned-vs-observed delta resolution. */
  readonly isFiltered: boolean;

  private constructor(
    recipientPlayerId: PlayerId | undefined,
    fogEnabled: boolean,
    private readonly world: WorldState,
    mapWidth: number,
    mapHeight: number,
  ) {
    this.isFiltered = fogEnabled && recipientPlayerId !== undefined;
    this.gridW = Math.max(1, Math.ceil(mapWidth / VISION_CELL_SIZE));
    this.gridH = Math.max(1, Math.ceil(mapHeight / VISION_CELL_SIZE));
    if (recipientPlayerId !== undefined) {
      this.viewPlayerIds.add(recipientPlayerId);
      for (const allyId of world.getAllies(recipientPlayerId)) {
        this.viewPlayerIds.add(allyId);
      }
    }
  }

  static forRecipient(world: WorldState, recipientPlayerId: PlayerId | undefined): SnapshotVisibility {
    const visibility = new SnapshotVisibility(
      recipientPlayerId,
      world.fogOfWarEnabled,
      world,
      world.mapWidth,
      world.mapHeight,
    );
    if (!visibility.isFiltered) return visibility;
    for (const playerId of visibility.viewPlayerIds) {
      visibility.addPlayerSources(world, playerId);
    }
    visibility.addScanPulseSources(world);
    return visibility;
  }

  /** True when the given playerId belongs to the recipient or one of
   *  their allies. Works regardless of fog status — a recipient with
   *  fog disabled still gets the team-aware "this is one of ours"
   *  answer for delta resolution, AOI persistence, etc. */
  isOwnedByRecipientOrAlly(playerId: PlayerId | undefined): boolean {
    if (playerId === undefined) return false;
    return this.viewPlayerIds.has(playerId);
  }

  canSeePrivateEntityDetails(entity: Entity): boolean {
    if (!this.isFiltered) return true;
    return this.isOwnedByRecipientOrAlly(entity.ownership?.playerId);
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
   *  entity position AND have an unobstructed terrain sightline to it
   *  (FOW-04). Radar coverage does NOT grant full visibility. */
  isEntityVisible(entity: Entity): boolean {
    if (!this.isFiltered) return true;
    if (this.isOwnedByRecipientOrAlly(entity.ownership?.playerId)) return true;
    const padding = getEntityVisibilityPadding(entity);
    if (!this.canSeeCloakedEntity(entity, padding)) return false;
    return this.isEntityVisibleWithLos(
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
      padding,
    );
  }

  /** Distance-then-LOS scan over fullSources. Reuses the spatial hash
   *  for the distance candidate set, then runs hasTerrainLineOfSight
   *  against the heightmap only on the candidates that pass distance
   *  — so a tank behind a tall ridge falls out of vision even when
   *  the source's 2D circle covers its position. */
  private isEntityVisibleWithLos(
    x: number,
    y: number,
    z: number,
    padding: number,
  ): boolean {
    const cx = Math.floor(x / VISION_CELL_SIZE);
    const cy = Math.floor(y / VISION_CELL_SIZE);
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return false;
    const sourceIndexes = this.fullSourceCells.get(this.cellKey(cx, cy));
    if (!sourceIndexes) return false;
    const targetZ = z + VISION_TARGET_BODY_HEIGHT;
    for (let i = 0; i < sourceIndexes.length; i++) {
      const source = this.fullSources[sourceIndexes[i]];
      const dx = x - source.x;
      const dy = y - source.y;
      const r = source.radius + padding;
      if (dx * dx + dy * dy > r * r) continue;
      if (hasTerrainLineOfSight(
        this.world,
        source.x, source.y, source.z,
        x, y, targetZ,
      )) {
        return true;
      }
    }
    return false;
  }

  /** Minimap-tier check: full vision OR radar coverage. Used by the
   *  minimap serializer so radar buildings reveal enemy positions
   *  without leaking the rest of the snapshot. */
  isEntityOnRadar(entity: Entity): boolean {
    if (!this.isFiltered) return true;
    if (this.isOwnedByRecipientOrAlly(entity.ownership?.playerId)) return true;
    const padding = getEntityVisibilityPadding(entity);
    if (!this.canSeeCloakedEntity(entity, padding)) return false;
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

  /** True when the point sits inside any of the recipient's
   *  full-vision sources extended by EARSHOT_PAD. Used by the audio
   *  serializer for the FOW-09 distant-gunfire forwarding: events
   *  outside isPointVisible but inside the earshot pad ride along
   *  with audioOnly=true. Returns true unconditionally when fog is
   *  off, so admin observers still hear everything. */
  isPointWithinEarshot(x: number, y: number): boolean {
    if (!this.isFiltered) return true;
    return this.isPointVisibleIn(this.fullSources, this.fullSourceCells, x, y, EARSHOT_PAD);
  }

  shouldSendRemoval(record: RemovedSnapshotEntity): boolean {
    if (!this.isFiltered) return true;
    if (this.isOwnedByRecipientOrAlly(record.playerId)) return true;
    return this.isPointVisible(record.x, record.y);
  }

  /** True when the recipient (or any of their allies under FOW-06)
   *  authored the event and so should receive it regardless of vision.
   *  Callers:
   *
   *    - FOW-17 kill credit. Death SimEvents carry the killer's
   *      playerId; passing that here keeps the death notification in
   *      the killer's (and their teammates') audio stream even when
   *      the corpse falls outside their full vision.
   *    - Own pings. Minimap pings carry the pinger's playerId; the
   *      pinger plus their team see the marker even on fog points.
   *    - FOW-08 attackAlert (victimPlayerId). The victim and their
   *      allies see the marker at the attacker's position when an
   *      otherwise-silent splash from fog lands on a teammate's unit. */
  isAuthoredByRecipient(authorPlayerId: PlayerId | undefined): boolean {
    return this.isOwnedByRecipientOrAlly(authorPlayerId);
  }

  private canSeeCloakedEntity(entity: Entity, padding: number): boolean {
    if (!isEntityCloaked(entity)) return true;
    return this.isPointVisibleIn(
      this.detectorSources,
      this.detectorSourceCells,
      entity.transform.x,
      entity.transform.y,
      padding,
    );
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
        // Eye z = entity's ground height plus a fixed offset (FOW-04).
        // A unit standing on a hill already has transform.z lifted by
        // the hill, so the constant just adds the body / turret mount
        // height — units on flat ground can still see over a small
        // bump, units behind a tall ridge can't.
        const eyeZ = entity.transform.z + VISION_SOURCE_EYE_HEIGHT;
        if (canEntityProvideFullVision(entity)) {
          this.addSource(
            this.fullSources,
            this.fullSourceCells,
            entity.transform.x,
            entity.transform.y,
            eyeZ,
            getEntityFullVisionRadius(entity),
          );
        }
        if (canEntityProvideRadarVision(entity)) {
          this.addSource(
            this.radarSources,
            this.radarSourceCells,
            entity.transform.x,
            entity.transform.y,
            eyeZ,
            getEntityRadarRadius(entity),
          );
        }
        if (canEntityProvideDetectorVision(entity)) {
          this.addSource(
            this.detectorSources,
            this.detectorSourceCells,
            entity.transform.x,
            entity.transform.y,
            eyeZ,
            getEntityDetectorRadius(entity),
          );
        }
      }
    }
  }

  /** Merge active scan pulses into the full-vision source pool for any
   *  pulse owned by the recipient or one of their allies (FOW-14 +
   *  FOW-06). Pulses don't currently grant radar or detector vision —
   *  treat them as a brief floodlight only. */
  private addScanPulseSources(world: WorldState): void {
    const pulses = world.scanPulses;
    if (pulses.length === 0) return;
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      if (!this.viewPlayerIds.has(pulse.playerId)) continue;
      this.addSource(
        this.fullSources,
        this.fullSourceCells,
        pulse.x,
        pulse.y,
        pulse.z + VISION_SOURCE_EYE_HEIGHT,
        pulse.radius,
      );
    }
  }

  private addSource(
    sources: VisionSource[],
    cells: Map<number, number[]>,
    x: number,
    y: number,
    z: number,
    radius: number,
  ): void {
    if (radius <= 0) return;
    const index = sources.length;
    sources.push({ x, y, z, radius });
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
 *  (units, non-radar buildings — alive AND finished). Radar buildings
 *  are intentionally excluded: they are sensors, not eyes. Buildings
 *  under construction or still in placement-ghost state provide no
 *  vision (issues.txt FOW-16): they don't physically exist yet, so a
 *  half-built sensor exposing its full radius from 1 HP would leak
 *  intel before the structure is online. */
export function canEntityProvideFullVision(entity: Entity): boolean {
  if (entity.unit) return entity.unit.hp > 0;
  if (!entity.building || entity.building.hp <= 0) return false;
  if (entity.buildingType === 'radar') return false;
  if (entity.buildable && !entity.buildable.isComplete) return false;
  return true;
}

/** True when the entity is a radar-class sensor (alive AND finished).
 *  Same construction-gate as full vision — a half-built radar has no
 *  signal output. Currently only the radar building qualifies; mobile-
 *  radar units could be added by extending this predicate without
 *  touching callers. */
export function canEntityProvideRadarVision(entity: Entity): boolean {
  if (!entity.building || entity.building.hp <= 0) return false;
  if (entity.buildingType !== 'radar') return false;
  if (entity.buildable && !entity.buildable.isComplete) return false;
  return true;
}

export function canEntityProvideDetectorVision(entity: Entity): boolean {
  return canEntityProvideDetection(entity);
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
  return getEntityDetectionPadding(entity);
}

/** Build the FOW-11 keyframe shroud payload for the given recipient,
 *  team-merging with their allies. Returns undefined when the
 *  recipient has no recorded history yet so the snapshot field stays
 *  absent on the empty-keyframe-1 case. */
export function serializeShroudPayload(
  world: WorldState,
  recipientPlayerId: PlayerId,
): NetworkServerSnapshotShroud | undefined {
  const view = buildRecipientShroudView(world, recipientPlayerId);
  if (!view) return undefined;
  return {
    gridW: world.shroudGridW,
    gridH: world.shroudGridH,
    cellSize: SHROUD_CELL_SIZE,
    bitmap: view,
  };
}

/** Reusable buffer so we don't allocate per snapshot — the wire shape
 *  is small and tightly bounded (a handful of pulses at most). */
const _scanPulseBuf: NetworkServerSnapshotScanPulse[] = [];

/** Filter the world's active scan pulses down to the ones the
 *  recipient's team owns (FOW-14 + FOW-06). When no team owns any
 *  live pulses, returns undefined so the snapshot field stays absent.
 *  When fog is disabled, returns all pulses regardless of owner —
 *  admin / observer modes should see the whole picture. */
export function serializeScanPulses(
  world: WorldState,
  visibility: SnapshotVisibility,
): NetworkServerSnapshotScanPulse[] | undefined {
  const pulses = world.scanPulses;
  if (pulses.length === 0) return undefined;
  _scanPulseBuf.length = 0;
  const filtered = visibility.isFiltered;
  for (let i = 0; i < pulses.length; i++) {
    const pulse = pulses[i];
    if (filtered && !visibility.isOwnedByRecipientOrAlly(pulse.playerId)) continue;
    _scanPulseBuf.push({
      playerId: pulse.playerId,
      x: pulse.x,
      y: pulse.y,
      z: pulse.z,
      radius: pulse.radius,
      expiresAtTick: pulse.expiresAtTick,
    });
  }
  return _scanPulseBuf.length > 0 ? _scanPulseBuf : undefined;
}
