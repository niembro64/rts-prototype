import type { SprayTarget } from '../sim/commanderAbilities';
import type { NetworkServerSnapshotSprayTarget } from './NetworkManager';
import { createSprayDto } from './snapshotDtoCopy';
import type { SnapshotVisibility } from './stateSerializerVisibility';
import {
  deleteSnapshotPoolForKey,
  getOrCreateSnapshotPool,
  getPooledItem,
  resolveSnapshotPoolKey,
  type SnapshotPool,
} from './snapshotPool';

/** Per-listener pool of pooled NetworkServerSnapshotSprayTarget DTOs
 *  plus the serializer's outbound buf (issues.txt FOW-OPT-20, mirrors
 *  FOW-OPT-07 for audio). The previous module-global pool shared one
 *  buf array across every listener, so the publisher's per-team
 *  output-caching could not safely retain references to the slots:
 *  the next listener's serialize call would reset the head index and
 *  overwrite them in place. Per-listener pools keep each cached
 *  reference stable for the duration of the emit. */
const sprayPools = new Map<string, SnapshotPool<NetworkServerSnapshotSprayTarget>>();

export function resetSprayPoolForKey(key: string | number | undefined): void {
  deleteSnapshotPoolForKey(sprayPools, key);
}

export function serializeSprayTargets(
  sprayTargets?: SprayTarget[],
  visibility?: SnapshotVisibility,
  trackingKey?: string | number,
): NetworkServerSnapshotSprayTarget[] | undefined {
  const state = getOrCreateSnapshotPool(sprayPools, resolveSnapshotPoolKey(trackingKey));
  state.index = 0;
  if (!sprayTargets || sprayTargets.length === 0) return undefined;

  const sprayBuf = state.buf;
  sprayBuf.length = 0;
  for (let i = 0; i < sprayTargets.length; i++) {
    const source = sprayTargets[i];
    if (
      visibility &&
      !visibility.isPointVisible(source.source.pos.x, source.source.pos.y) &&
      !visibility.isPointVisible(source.target.pos.x, source.target.pos.y)
    ) {
      continue;
    }
    const out = getPooledItem(state, createSprayDto);
    out.source.id = source.source.id;
    out.source.pos.x = source.source.pos.x;
    out.source.pos.y = source.source.pos.y;
    out.source.z = source.source.z;
    out.source.playerId = source.source.playerId;
    out.target.id = source.target.id;
    out.target.pos.x = source.target.pos.x;
    out.target.pos.y = source.target.pos.y;
    out.target.z = source.target.z;
    if (source.target.dim) {
      if (!out.target.dim) out.target.dim = { x: 0, y: 0 };
      out.target.dim.x = source.target.dim.x;
      out.target.dim.y = source.target.dim.y;
    } else {
      out.target.dim = undefined;
    }
    out.target.radius = source.target.radius;
    out.type = source.type;
    out.intensity = source.intensity;
    out.speed = source.speed;
    out.particleRadius = source.particleRadius;
    sprayBuf.push(out);
  }
  return sprayBuf.length > 0 ? sprayBuf : undefined;
}
