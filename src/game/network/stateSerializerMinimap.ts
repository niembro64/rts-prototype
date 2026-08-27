import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { getBuildingCombatCenterZ } from '../sim/buildingAnchors';
import { entitySlotRegistry, type EntityStateViews } from '../sim/EntitySlotRegistry';
import {
  ENTITY_STATE_KIND_BUILDING,
  ENTITY_STATE_KIND_TOWER,
  ENTITY_STATE_KIND_UNIT,
} from '../sim-wasm/init';
import type { NetworkServerSnapshotMinimapEntity } from './NetworkManager';
import { createMinimapEntityDto } from './snapshotDtoCopy';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import {
  ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING,
  ENTITY_SNAPSHOT_WIRE_TYPE_SHOT,
  ENTITY_SNAPSHOT_WIRE_TYPE_TOWER,
  ENTITY_SNAPSHOT_WIRE_TYPE_UNIT,
} from './stateSerializerEntities';
import { isProjectileSeenInFull } from './stateSerializerProjectiles';
import {
  deleteSnapshotPoolForKey,
  getOrCreateSnapshotPool,
  getPooledItem,
  resolveSnapshotPoolKey,
  type SnapshotPool,
} from './snapshotPool';
import {
  createFloat64WireRows,
  reserveFloat64WireRows,
  type Float64WireRows,
} from './snapshotWireRows';
import { quantizeMinimapPosition as qPos } from './snapshotQuantization';
import {
  CONTACT_MEDIUM_NONE,
  MINIMAP_CONTACT_FLAG_ALTITUDE,
  MINIMAP_CONTACT_FLAG_RADAR_ONLY,
  contactMediumMaskToMinimapFlags,
  type ContactMediumMask,
} from './contactMedium';

/** id, x, y, coarse type, anonymous owner, flags, contact observation z. */
export const MINIMAP_SNAPSHOT_WIRE_STRIDE = 7;

type MinimapSnapshotWireSource = Float64WireRows;

/** Per-listener pool of NetworkServerSnapshotMinimapEntity DTOs
 *  (FOW-OPT-20, mirrors FOW-OPT-07 for audio). The previous
 *  module-global pool meant every listener's serialize call reset the
 *  same buf, so the publisher couldn't safely cache the result and
 *  hand it to multiple teammates — the next listener's reset would
 *  overwrite the cached slots. Per-listener pools keep each cached
 *  reference stable across the publisher's emit loop. */
const minimapPools = new Map<string, SnapshotPool<NetworkServerSnapshotMinimapEntity>>();
const minimapWireSourcesByKey = new Map<string, MinimapSnapshotWireSource>();
const minimapWireSources = new WeakMap<object, MinimapSnapshotWireSource>();
const directMinimapWireSource = createFloat64WireRows();

export function resetMinimapPoolForKey(key: string | number | undefined): void {
  deleteSnapshotPoolForKey(minimapPools, key);
  if (key !== undefined) minimapWireSourcesByKey.delete(String(key));
}

/** Owner id written for a contact-only entry.
 *
 *  A radar/sonar contact earns POSITION, not identity: the client already
 *  paints these as generic blips and refuses to select them, but the owner was
 *  still travelling on the wire, so the tier was only being enforced by the
 *  renderer's good manners. budget_design_philosophy.html is explicit that the
 *  client "should only receive the contact tier it earned", so strip it at the
 *  serializer instead. The coarse unit/building type stays -- BAR draws
 *  building blips differently from unit blips too. */
const CONTACT_ONLY_OWNER_ID = 0;

function minimapOwnerId(playerId: number, radarOnly: boolean): number {
  return radarOnly ? CONTACT_ONLY_OWNER_ID : playerId;
}

function writeMinimapEntityValues(
  out: NetworkServerSnapshotMinimapEntity,
  id: number,
  type: NetworkServerSnapshotMinimapEntity['type'],
  playerId: PlayerId,
  x: number,
  y: number,
  z: number,
  radarOnly: boolean,
  contactMediumMask: ContactMediumMask,
): NetworkServerSnapshotMinimapEntity {
  out.id = id;
  out.type = type;
  out.playerId = minimapOwnerId(playerId, radarOnly) as PlayerId;
  out.contactMediumMask = radarOnly ? contactMediumMask : null;
  out.contactZ = radarOnly ? z : null;
  out.pos.x = x;
  out.pos.y = y;
  // Reset the pool slot's flag — pool entries are reused so a slot
  // that was radarOnly last frame must be cleared when it now carries
  // a full-vision entity.
  out.radarOnly = radarOnly ? true : null;
  return out;
}

function minimapDtoTypeForEntity(entity: Entity): NetworkServerSnapshotMinimapEntity['type'] {
  if (entity.type === 'unit') return 'unit';
  if (entity.type === 'shot') return 'shot';
  return 'building';
}

function minimapWireTypeForEntity(entity: Entity): number {
  if (entity.unit) return ENTITY_SNAPSHOT_WIRE_TYPE_UNIT;
  if (entity.projectile) return ENTITY_SNAPSHOT_WIRE_TYPE_SHOT;
  return ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
}

function writeMinimapEntity(
  out: NetworkServerSnapshotMinimapEntity,
  entity: Entity,
  radarOnly: boolean,
  contactMediumMask: ContactMediumMask,
): NetworkServerSnapshotMinimapEntity {
  const ownership = entity.ownership;
  return writeMinimapEntityValues(
    out,
    entity.id,
    minimapDtoTypeForEntity(entity),
    (ownership !== null ? ownership.playerId : 1) as PlayerId,
    qPos(entity.transform.x),
    qPos(entity.transform.y),
    qPos(entity.building !== null ? getBuildingCombatCenterZ(entity) : entity.transform.z),
    radarOnly,
    contactMediumMask,
  );
}

function minimapDtoTypeFromEntityStateKind(
  kind: number,
): NetworkServerSnapshotMinimapEntity['type'] | null {
  if (kind === ENTITY_STATE_KIND_UNIT) return 'unit';
  if (kind === ENTITY_STATE_KIND_TOWER) return 'building';
  if (kind === ENTITY_STATE_KIND_BUILDING) return 'building';
  return null;
}

function minimapWireTypeFromEntityStateKind(kind: number): number {
  if (kind === ENTITY_STATE_KIND_UNIT) return ENTITY_SNAPSHOT_WIRE_TYPE_UNIT;
  if (kind === ENTITY_STATE_KIND_TOWER) return ENTITY_SNAPSHOT_WIRE_TYPE_TOWER;
  return ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
}

function canReadMinimapEntityStateSlot(
  views: EntityStateViews | null,
  slot: number,
  entityId: number,
): views is EntityStateViews {
  if (views === null || slot < 0 || slot >= views.capacity) return false;
  if (views.entityId[slot] !== entityId) return false;
  return minimapDtoTypeFromEntityStateKind(views.kind[slot]) !== null;
}

function writeMinimapEntityFromSlot(
  out: NetworkServerSnapshotMinimapEntity,
  views: EntityStateViews,
  slot: number,
  radarOnly: boolean,
  contactMediumMask: ContactMediumMask,
): NetworkServerSnapshotMinimapEntity {
  const type = minimapDtoTypeFromEntityStateKind(views.kind[slot]);
  if (type === null) {
    throw new Error('writeMinimapEntityFromSlot called with non-minimap entity state kind');
  }
  return writeMinimapEntityValues(
    out,
    views.entityId[slot],
    type,
    (views.ownerPlayerId[slot] || 1) as PlayerId,
    qPos(views.posX[slot]),
    qPos(views.posY[slot]),
    qPos(views.posZ[slot]),
    radarOnly,
    contactMediumMask,
  );
}

/** Get-or-create the keyed wire-rows buffer for `key`, reset it, and
 *  register it for the entries array about to be (re)filled. Shared by
 *  the minimap and spray serializers, whose per-listener wire-source
 *  bookkeeping is identical. */
export function getOrCreateKeyedWireSource(
  sourcesByKey: Map<string, Float64WireRows>,
  key: string,
  entries: object,
  sourcesByEntries: WeakMap<object, Float64WireRows>,
): Float64WireRows {
  let source = sourcesByKey.get(key);
  if (source === undefined) {
    source = createFloat64WireRows();
    sourcesByKey.set(key, source);
  }
  source.count = 0;
  sourcesByEntries.set(entries, source);
  return source;
}

function appendMinimapWireRowValues(
  source: MinimapSnapshotWireSource,
  id: number,
  x: number,
  y: number,
  z: number,
  typeTag: number,
  playerId: number,
  radarOnly: boolean,
  contactMediumMask: ContactMediumMask,
): void {
  const rowIndex = reserveFloat64WireRows(source, 1, MINIMAP_SNAPSHOT_WIRE_STRIDE);
  const values = source.values;
  const base = rowIndex * MINIMAP_SNAPSHOT_WIRE_STRIDE;
  values[base + 0] = id;
  values[base + 1] = x;
  values[base + 2] = y;
  values[base + 3] = typeTag;
  values[base + 4] = minimapOwnerId(playerId, radarOnly);
  let flags = 0;
  if (radarOnly) {
    flags |= MINIMAP_CONTACT_FLAG_RADAR_ONLY;
    flags |= contactMediumMaskToMinimapFlags(contactMediumMask);
    flags |= MINIMAP_CONTACT_FLAG_ALTITUDE;
  }
  values[base + 5] = flags;
  values[base + 6] = radarOnly ? z : 0;
}

function appendMinimapWireRow(
  source: MinimapSnapshotWireSource,
  entity: Entity,
  radarOnly: boolean,
  contactMediumMask: ContactMediumMask,
): void {
  const ownership = entity.ownership;
  appendMinimapWireRowValues(
    source,
    entity.id,
    qPos(entity.transform.x),
    qPos(entity.transform.y),
    qPos(entity.building !== null ? getBuildingCombatCenterZ(entity) : entity.transform.z),
    minimapWireTypeForEntity(entity),
    ownership !== null ? ownership.playerId : 1,
    radarOnly,
    contactMediumMask,
  );
}

function appendMinimapWireRowFromSlot(
  source: MinimapSnapshotWireSource,
  views: EntityStateViews,
  slot: number,
  radarOnly: boolean,
  contactMediumMask: ContactMediumMask,
): void {
  appendMinimapWireRowValues(
    source,
    views.entityId[slot],
    qPos(views.posX[slot]),
    qPos(views.posY[slot]),
    qPos(views.posZ[slot]),
    minimapWireTypeFromEntityStateKind(views.kind[slot]),
    views.ownerPlayerId[slot] || 1,
    radarOnly,
    contactMediumMask,
  );
}

export function getMinimapSnapshotWireSource(
  entries: readonly NetworkServerSnapshotMinimapEntity[],
): MinimapSnapshotWireSource | undefined {
  return minimapWireSources.get(entries);
}

/** Shared minimap traversal for the direct wire-row writer and the
 *  pooled-DTO serializer: identical iteration order, radar/full branch
 *  selection, filtering, and radarOnly derivation — only the per-entity
 *  emission differs between the two callers. Bodies first, then the enemy
 *  emissions the recipient hears but cannot see. */
function forEachMinimapCandidate(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  emitFromSlot: (
    views: EntityStateViews,
    slot: number,
    radarOnly: boolean,
    contactMediumMask: ContactMediumMask,
  ) => void,
  emitFromEntity: (
    entity: Entity,
    radarOnly: boolean,
    contactMediumMask: ContactMediumMask,
  ) => void,
): void {
  forEachMinimapBodyCandidate(world, visibility, emitFromSlot, emitFromEntity);
  forEachMinimapEmissionContact(world, visibility, emitFromEntity);
}

/** Enemy emissions on the contact tier. Own/allied or fully visible shots
 *  ride the projectile channel; completely unsensed shots are absent. A
 *  hostile shot under air-radar or water-radar but outside vision is only an
 *  anonymous contact dot, with no blueprint, owner, or retained trajectory. */
function forEachMinimapEmissionContact(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  emitFromEntity: (
    entity: Entity,
    radarOnly: boolean,
    contactMediumMask: ContactMediumMask,
  ) => void,
): void {
  if (visibility === undefined || !visibility.isFiltered) return;
  const projectiles = world.getProjectiles();
  for (let i = 0; i < projectiles.length; i++) {
    const entity = projectiles[i];
    const proj = entity.projectile;
    if (!proj) continue;
    if (isProjectileSeenInFull(entity, proj, visibility)) continue;
    const contactMediumMask = visibility.getPointContactMediumMask(
      proj.ownerId,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
    );
    if (contactMediumMask === CONTACT_MEDIUM_NONE) continue;
    emitFromEntity(entity, true, contactMediumMask);
  }
}

function forEachMinimapBodyCandidate(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  emitFromSlot: (
    views: EntityStateViews,
    slot: number,
    radarOnly: boolean,
    contactMediumMask: ContactMediumMask,
  ) => void,
  emitFromEntity: (
    entity: Entity,
    radarOnly: boolean,
    contactMediumMask: ContactMediumMask,
  ) => void,
): void {
  const radarEntityIds = visibility?.getRadarEntityIds();
  if (radarEntityIds !== undefined) {
    const visibleEntityIdSet = visibility!.getVisibleEntityIdSet();
    const radarEntitySlots = visibility!.getRadarEntitySlots();
    const views = entitySlotRegistry.getViews();
    for (let i = 0; i < radarEntityIds.length; i++) {
      const slot = radarEntitySlots !== undefined ? radarEntitySlots[i] : -1;
      if (canReadMinimapEntityStateSlot(views, slot, radarEntityIds[i])) {
        const radarOnly = visibleEntityIdSet !== undefined && !visibleEntityIdSet.has(radarEntityIds[i]);
        const contactMediumMask = radarOnly
          ? visibility!.getEntityContactMediumMaskById(radarEntityIds[i])
          : CONTACT_MEDIUM_NONE;
        emitFromSlot(views, slot, radarOnly, contactMediumMask);
        continue;
      }
      const entity = world.getEntity(radarEntityIds[i]);
      if (!entity) continue;
      const radarOnly = visibleEntityIdSet !== undefined && !visibleEntityIdSet.has(entity.id);
      const contactMediumMask = radarOnly
        ? visibility!.getEntityContactMediumMask(entity)
        : CONTACT_MEDIUM_NONE;
      emitFromEntity(entity, radarOnly, contactMediumMask);
    }
    return;
  }
  const minimapSources: ReadonlyArray<readonly Entity[]> = [
    world.getUnits(),
    world.getBuildings(),
  ];
  for (let s = 0; s < minimapSources.length; s++) {
    const source = minimapSources[s];
    for (let i = 0; i < source.length; i++) {
      const entity = source[i];
      if (entity.type !== 'unit' && entity.type !== 'building') {
        continue;
      }
      // Minimap uses the wider full-vision-OR-radar check (FOW-03):
      // radar buildings reveal enemy positions on the minimap without
      // sending them through the main snapshot. Audio events and
      // projectiles still gate on isPointVisible (full vision only).
      if (visibility && !visibility.isEntityOnRadar(entity)) continue;
      // FOW-03a: tag entities the recipient only sees via radar so
      // the client minimap can render them as generic blips (no team
      // color, no type icon). Full-vision contacts get the normal
      // identifiable rendering.
      const radarOnly = visibility !== undefined && !visibility.isEntityVisible(entity);
      const contactMediumMask = radarOnly
        ? visibility!.getEntityContactMediumMask(entity)
        : CONTACT_MEDIUM_NONE;
      emitFromEntity(entity, radarOnly, contactMediumMask);
    }
  }
}

export function writeMinimapSnapshotWireRowsDirect(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  entries: NetworkServerSnapshotMinimapEntity[],
): NetworkServerSnapshotMinimapEntity[] | undefined {
  directMinimapWireSource.count = 0;
  minimapWireSources.set(entries, directMinimapWireSource);
  entries.length = 0;

  forEachMinimapCandidate(
    world,
    visibility,
    (views, slot, radarOnly, contactMediumMask) => {
      appendMinimapWireRowFromSlot(
        directMinimapWireSource,
        views,
        slot,
        radarOnly,
        contactMediumMask,
      );
    },
    (entity, radarOnly, contactMediumMask) => {
      appendMinimapWireRow(directMinimapWireSource, entity, radarOnly, contactMediumMask);
    },
  );

  if (directMinimapWireSource.count === 0) return undefined;
  entries.length = directMinimapWireSource.count;
  return entries;
}

export function serializeMinimapSnapshotEntities(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  trackingKey: string | number | undefined,
  includeWireRows = true,
): NetworkServerSnapshotMinimapEntity[] | undefined {
  const poolKey = resolveSnapshotPoolKey(trackingKey);
  const state = getOrCreateSnapshotPool(minimapPools, poolKey);
  // Registered (and reset to count 0) even when rows are skipped, so a
  // listener that never encodes leaves an EMPTY wire source rather than
  // a stale one from an earlier configuration.
  const wireSource = getOrCreateKeyedWireSource(minimapWireSourcesByKey, poolKey, state.buf, minimapWireSources);
  state.index = 0;
  state.buf.length = 0;

  if (!includeWireRows) {
    forEachMinimapCandidate(
      world,
      visibility,
      (views, slot, radarOnly, contactMediumMask) => {
        const out = getPooledItem(state, createMinimapEntityDto);
        writeMinimapEntityFromSlot(out, views, slot, radarOnly, contactMediumMask);
        state.buf.push(out);
      },
      (entity, radarOnly, contactMediumMask) => {
        const out = getPooledItem(state, createMinimapEntityDto);
        writeMinimapEntity(out, entity, radarOnly, contactMediumMask);
        state.buf.push(out);
      },
    );
    return state.buf;
  }

  forEachMinimapCandidate(
    world,
    visibility,
    (views, slot, radarOnly, contactMediumMask) => {
      const out = getPooledItem(state, createMinimapEntityDto);
      writeMinimapEntityFromSlot(out, views, slot, radarOnly, contactMediumMask);
      appendMinimapWireRowFromSlot(wireSource, views, slot, radarOnly, contactMediumMask);
      state.buf.push(out);
    },
    (entity, radarOnly, contactMediumMask) => {
      const out = getPooledItem(state, createMinimapEntityDto);
      writeMinimapEntity(out, entity, radarOnly, contactMediumMask);
      appendMinimapWireRow(wireSource, entity, radarOnly, contactMediumMask);
      state.buf.push(out);
    },
  );
  return state.buf;
}
