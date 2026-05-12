import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import type { NetworkServerSnapshotMinimapEntity } from './NetworkManager';
import { createMinimapEntityDto } from './snapshotDtoCopy';
import type { SnapshotVisibility } from './stateSerializerVisibility';

const minimapEntityBuf: NetworkServerSnapshotMinimapEntity[] = [];
const minimapEntityPool: NetworkServerSnapshotMinimapEntity[] = [];
let minimapEntityPoolIndex = 0;

function qPos(n: number): number {
  return Math.round(n);
}

function getPooledMinimapEntity(): NetworkServerSnapshotMinimapEntity {
  let entity = minimapEntityPool[minimapEntityPoolIndex];
  if (!entity) {
    entity = createMinimapEntityDto();
    minimapEntityPool[minimapEntityPoolIndex] = entity;
  }
  minimapEntityPoolIndex++;
  return entity;
}

function writeMinimapEntity(entity: Entity): NetworkServerSnapshotMinimapEntity {
  const out = getPooledMinimapEntity();
  out.id = entity.id;
  out.type = entity.unit ? 'unit' : 'building';
  out.playerId = (entity.ownership?.playerId ?? 1) as PlayerId;
  out.pos.x = qPos(entity.transform.x);
  out.pos.y = qPos(entity.transform.y);
  return out;
}

export function serializeMinimapSnapshotEntities(
  world: WorldState,
  enabled: boolean,
  visibility?: SnapshotVisibility,
): NetworkServerSnapshotMinimapEntity[] | undefined {
  if (!enabled) return undefined;

  minimapEntityPoolIndex = 0;
  minimapEntityBuf.length = 0;
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
      minimapEntityBuf.push(writeMinimapEntity(entity));
    }
  }
  return minimapEntityBuf;
}
