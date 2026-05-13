import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import type { NetworkServerSnapshotMinimapEntity } from './NetworkManager';
import { createMinimapEntityDto } from './snapshotDtoCopy';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import {
  deleteSnapshotPoolForKey,
  getOrCreateSnapshotPool,
  getPooledItem,
  resolveSnapshotPoolKey,
  type SnapshotPool,
} from './snapshotPool';

/** Per-listener pool of NetworkServerSnapshotMinimapEntity DTOs
 *  (issues.txt FOW-OPT-20, mirrors FOW-OPT-07 for audio). The previous
 *  module-global pool meant every listener's serialize call reset the
 *  same buf, so the publisher couldn't safely cache the result and
 *  hand it to multiple teammates — the next listener's reset would
 *  overwrite the cached slots. Per-listener pools keep each cached
 *  reference stable across the publisher's emit loop. */
const minimapPools = new Map<string, SnapshotPool<NetworkServerSnapshotMinimapEntity>>();

export function resetMinimapPoolForKey(key: string | number | undefined): void {
  deleteSnapshotPoolForKey(minimapPools, key);
}

function qPos(n: number): number {
  return Math.round(n);
}

function writeMinimapEntity(
  out: NetworkServerSnapshotMinimapEntity,
  entity: Entity,
  radarOnly: boolean,
): NetworkServerSnapshotMinimapEntity {
  out.id = entity.id;
  out.type = entity.unit ? 'unit' : 'building';
  out.playerId = (entity.ownership?.playerId ?? 1) as PlayerId;
  out.pos.x = qPos(entity.transform.x);
  out.pos.y = qPos(entity.transform.y);
  // Reset the pool slot's flag — pool entries are reused so a slot
  // that was radarOnly last frame must be cleared when it now carries
  // a full-vision entity.
  if (radarOnly) out.radarOnly = true;
  else delete out.radarOnly;
  return out;
}

export function serializeMinimapSnapshotEntities(
  world: WorldState,
  enabled: boolean,
  visibility?: SnapshotVisibility,
  trackingKey?: string | number,
): NetworkServerSnapshotMinimapEntity[] | undefined {
  if (!enabled) return undefined;
  const state = getOrCreateSnapshotPool(minimapPools, resolveSnapshotPoolKey(trackingKey));
  state.index = 0;
  state.buf.length = 0;

  const minimapSources: ReadonlyArray<readonly Entity[]> = [
    world.getUnits(),
    world.getBuildings(),
  ];
  for (let s = 0; s < minimapSources.length; s++) {
    const source = minimapSources[s];
    for (let i = 0; i < source.length; i++) {
      const entity = source[i];
      if (entity.type !== 'unit' && entity.type !== 'building') continue;
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
      state.buf.push(out);
    }
  }
  return state.buf;
}
