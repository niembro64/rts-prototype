import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotMinimapEntity,
} from './NetworkTypes';
import {
  ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING,
  ENTITY_SNAPSHOT_WIRE_TYPE_UNIT,
} from './stateSerializerEntities';

const PACKED_MINIMAP_ENTITIES_VERSION = 1;
const PACKED_MINIMAP_ENTITY_STRIDE = 6;
const MINIMAP_ENTITY_FLAG_RADAR_ONLY = 0x01;

export type PackedMinimapEntitiesWire = {
  v: typeof PACKED_MINIMAP_ENTITIES_VERSION;
  r: number[];
};

export function packMinimapEntitiesForWire(
  entries: readonly NetworkServerSnapshotMinimapEntity[] | undefined,
): PackedMinimapEntitiesWire | undefined {
  if (entries === undefined) return undefined;

  const rows = new Array<number>(entries.length * PACKED_MINIMAP_ENTITY_STRIDE);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const base = i * PACKED_MINIMAP_ENTITY_STRIDE;
    rows[base + 0] = entry.id;
    rows[base + 1] = entry.pos.x;
    rows[base + 2] = entry.pos.y;
    rows[base + 3] = entry.type === 'unit'
      ? ENTITY_SNAPSHOT_WIRE_TYPE_UNIT
      : ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING;
    rows[base + 4] = entry.playerId;
    rows[base + 5] = entry.radarOnly === true ? MINIMAP_ENTITY_FLAG_RADAR_ONLY : 0;
  }

  return {
    v: PACKED_MINIMAP_ENTITIES_VERSION,
    r: rows,
  };
}

export function unpackMinimapEntitiesFromWire(
  packed: PackedMinimapEntitiesWire,
): NetworkServerSnapshot['minimapEntities'] {
  const rows = packed.r;
  const count = Math.floor(rows.length / PACKED_MINIMAP_ENTITY_STRIDE);
  const entries: NetworkServerSnapshotMinimapEntity[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const base = i * PACKED_MINIMAP_ENTITY_STRIDE;
    const flags = rows[base + 5] ?? 0;
    const entry: NetworkServerSnapshotMinimapEntity = {
      id: rows[base + 0] ?? 0,
      pos: {
        x: rows[base + 1] ?? 0,
        y: rows[base + 2] ?? 0,
      },
      type: rows[base + 3] === ENTITY_SNAPSHOT_WIRE_TYPE_BUILDING
        ? 'building'
        : 'unit',
      playerId: (rows[base + 4] ?? 1) as NetworkServerSnapshotMinimapEntity['playerId'],
    };
    if ((flags & MINIMAP_ENTITY_FLAG_RADAR_ONLY) !== 0) {
      entry.radarOnly = true;
    }
    entries[i] = entry;
  }

  return entries;
}

export function isPackedMinimapEntitiesWire(
  value: unknown,
): value is PackedMinimapEntitiesWire {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<PackedMinimapEntitiesWire>;
  return (
    candidate.v === PACKED_MINIMAP_ENTITIES_VERSION &&
    Array.isArray(candidate.r)
  );
}
