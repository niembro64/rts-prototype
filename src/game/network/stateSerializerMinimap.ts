import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import type { NetworkServerSnapshotMinimapEntity } from './NetworkManager';
import { createMinimapEntityDto } from './snapshotDtoCopy';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import {
  ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING,
  ENTITY_SNAPSHOT_WIRE_TYPE_TOWER,
  ENTITY_SNAPSHOT_WIRE_TYPE_UNIT,
} from './stateSerializerEntities';
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

export const MINIMAP_SNAPSHOT_WIRE_STRIDE = 6;

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

function writeMinimapEntity(
  out: NetworkServerSnapshotMinimapEntity,
  entity: Entity,
  radarOnly: boolean,
): NetworkServerSnapshotMinimapEntity {
  const ownership = entity.ownership;
  out.id = entity.id;
  out.type = entity.type === 'unit'
    ? 'unit'
    : entity.type === 'tower'
      ? 'tower'
      : 'building';
  out.playerId = (ownership !== null ? ownership.playerId : 1) as PlayerId;
  out.pos.x = qPos(entity.transform.x);
  out.pos.y = qPos(entity.transform.y);
  // Reset the pool slot's flag — pool entries are reused so a slot
  // that was radarOnly last frame must be cleared when it now carries
  // a full-vision entity.
  out.radarOnly = radarOnly ? true : null;
  return out;
}

function getOrCreateMinimapWireSource(
  key: string,
  entries: NetworkServerSnapshotMinimapEntity[],
): MinimapSnapshotWireSource {
  let source = minimapWireSourcesByKey.get(key);
  if (source === undefined) {
    source = createFloat64WireRows();
    minimapWireSourcesByKey.set(key, source);
  }
  source.count = 0;
  minimapWireSources.set(entries, source);
  return source;
}

function appendMinimapWireRow(
  source: MinimapSnapshotWireSource,
  entity: Entity,
  radarOnly: boolean,
): void {
  const ownership = entity.ownership;
  const rowIndex = reserveFloat64WireRows(source, 1, MINIMAP_SNAPSHOT_WIRE_STRIDE);
  const values = source.values;
  const base = rowIndex * MINIMAP_SNAPSHOT_WIRE_STRIDE;
  values[base + 0] = entity.id;
  values[base + 1] = qPos(entity.transform.x);
  values[base + 2] = qPos(entity.transform.y);
  values[base + 3] = entity.unit
    ? ENTITY_SNAPSHOT_WIRE_TYPE_UNIT
    : entity.type === 'tower'
      ? ENTITY_SNAPSHOT_WIRE_TYPE_TOWER
      : ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
  values[base + 4] = ownership !== null ? ownership.playerId : 1;
  let flags = 0;
  if (radarOnly) flags |= 0x01;
  values[base + 5] = flags;
}

export function getMinimapSnapshotWireSource(
  entries: readonly NetworkServerSnapshotMinimapEntity[],
): MinimapSnapshotWireSource | undefined {
  return minimapWireSources.get(entries);
}

export function writeMinimapSnapshotWireRowsDirect(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  entries: NetworkServerSnapshotMinimapEntity[],
): NetworkServerSnapshotMinimapEntity[] | undefined {
  directMinimapWireSource.count = 0;
  minimapWireSources.set(entries, directMinimapWireSource);
  entries.length = 0;

  const radarEntityIds = visibility?.getRadarEntityIds();
  if (radarEntityIds !== undefined) {
    const visibleEntityIdSet = visibility!.getVisibleEntityIdSet();
    for (let i = 0; i < radarEntityIds.length; i++) {
      const entity = world.getEntity(radarEntityIds[i]);
      if (!entity) continue;
      const radarOnly = visibleEntityIdSet !== undefined && !visibleEntityIdSet.has(entity.id);
      appendMinimapWireRow(directMinimapWireSource, entity, radarOnly);
    }
  } else {
    const minimapSources: ReadonlyArray<readonly Entity[]> = [
      world.getUnits(),
      world.getBuildings(),
    ];
    for (let s = 0; s < minimapSources.length; s++) {
      const source = minimapSources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower') {
          continue;
        }
        if (visibility && !visibility.isEntityOnRadar(entity)) continue;
        const radarOnly = visibility !== undefined && !visibility.isEntityVisible(entity);
        appendMinimapWireRow(directMinimapWireSource, entity, radarOnly);
      }
    }
  }

  if (directMinimapWireSource.count === 0) return undefined;
  entries.length = directMinimapWireSource.count;
  return entries;
}

export function serializeMinimapSnapshotEntities(
  world: WorldState,
  visibility: SnapshotVisibility | undefined,
  trackingKey: string | number | undefined,
): NetworkServerSnapshotMinimapEntity[] | undefined {
  const poolKey = resolveSnapshotPoolKey(trackingKey);
  const state = getOrCreateSnapshotPool(minimapPools, poolKey);
  const wireSource = getOrCreateMinimapWireSource(poolKey, state.buf);
  state.index = 0;
  state.buf.length = 0;

  const radarEntityIds = visibility?.getRadarEntityIds();
  if (radarEntityIds !== undefined) {
    const visibleEntityIdSet = visibility!.getVisibleEntityIdSet();
    for (let i = 0; i < radarEntityIds.length; i++) {
      const entity = world.getEntity(radarEntityIds[i]);
      if (!entity) continue;
      const radarOnly = visibleEntityIdSet !== undefined && !visibleEntityIdSet.has(entity.id);
      const out = getPooledItem(state, createMinimapEntityDto);
      writeMinimapEntity(out, entity, radarOnly);
      appendMinimapWireRow(wireSource, entity, radarOnly);
      state.buf.push(out);
    }
  } else {
    const minimapSources: ReadonlyArray<readonly Entity[]> = [
      world.getUnits(),
      world.getBuildings(),
    ];
    for (let s = 0; s < minimapSources.length; s++) {
      const source = minimapSources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        if (entity.type !== 'unit' && entity.type !== 'building' && entity.type !== 'tower') {
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
        const out = getPooledItem(state, createMinimapEntityDto);
        writeMinimapEntity(out, entity, radarOnly);
        appendMinimapWireRow(wireSource, entity, radarOnly);
        state.buf.push(out);
      }
    }
  }
  return state.buf;
}
