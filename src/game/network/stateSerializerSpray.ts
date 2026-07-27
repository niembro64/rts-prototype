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
import {
  createFloat64WireRows,
  reserveFloat64WireRows,
  type Float64WireRows,
} from './snapshotWireRows';
import { getOrCreateKeyedWireSource } from './stateSerializerMinimap';
import { getSprayTargetWireFlags } from './sprayTargetWireHelpers';

/** Per-listener pool of pooled NetworkServerSnapshotSprayTarget DTOs
 *  plus the serializer's outbound buf (FOW-OPT-20, mirrors
 *  FOW-OPT-07 for audio). The previous module-global pool shared one
 *  buf array across every listener, so the publisher's per-team
 *  output-caching could not safely retain references to the slots:
 *  the next listener's serialize call would reset the head index and
 *  overwrite them in place. Per-listener pools keep each cached
 *  reference stable for the duration of the emit. */
const sprayPools = new Map<string, SnapshotPool<NetworkServerSnapshotSprayTarget>>();
const sprayWireSourcesByKey = new Map<string, SprayTargetWireSource>();
const directSprayWireSource = createFloat64WireRows();
const sprayWireSources = new WeakMap<object, SprayTargetWireSource>();

export const SPRAY_TARGET_WIRE_STRIDE = 17;

type SprayTargetWireSource = Float64WireRows;

export function resetSprayPoolForKey(key: string | number | undefined): void {
  deleteSnapshotPoolForKey(sprayPools, key);
  if (key !== undefined) sprayWireSourcesByKey.delete(String(key));
}

/** Shared spray wire-row body for the DTO and direct-sim writers. The
 *  target dim is pre-normalized at each call site because the two input
 *  shapes mark an absent dim differently (DTO: null, sim: undefined);
 *  every other field reads identically off both shapes. */
function appendSprayWireRowFields(
  source: SprayTargetWireSource,
  spray: NetworkServerSnapshotSprayTarget | SprayTarget,
  targetDimX: number,
  targetDimY: number,
): void {
  const rowIndex = reserveFloat64WireRows(source, 1, SPRAY_TARGET_WIRE_STRIDE);
  const values = source.values;
  const base = rowIndex * SPRAY_TARGET_WIRE_STRIDE;
  values[base + 0] = spray.source.id;
  values[base + 1] = spray.source.pos.x;
  values[base + 2] = spray.source.pos.y;
  values[base + 3] = spray.source.z ?? 0;
  values[base + 4] = spray.source.playerId;
  values[base + 5] = spray.target.id;
  values[base + 6] = spray.target.pos.x;
  values[base + 7] = spray.target.pos.y;
  values[base + 8] = spray.target.z ?? 0;
  values[base + 9] = targetDimX;
  values[base + 10] = targetDimY;
  values[base + 11] = spray.target.radius ?? 0;
  values[base + 12] = spray.intensity;
  values[base + 13] = spray.speed ?? 0;
  values[base + 14] = spray.particleRadius ?? 0;
  values[base + 15] = spray.ballSpawnRate ?? 0;
  values[base + 16] = getSprayTargetWireFlags(spray);
}

function appendSprayWireRow(
  source: SprayTargetWireSource,
  spray: NetworkServerSnapshotSprayTarget,
): void {
  const targetDim = spray.target.dim;
  appendSprayWireRowFields(
    source,
    spray,
    targetDim !== null ? targetDim.x : 0,
    targetDim !== null ? targetDim.y : 0,
  );
}

function appendDirectSprayWireRow(
  source: SprayTargetWireSource,
  spray: SprayTarget,
): void {
  const targetDim = spray.target.dim;
  appendSprayWireRowFields(
    source,
    spray,
    targetDim !== undefined ? targetDim.x : 0,
    targetDim !== undefined ? targetDim.y : 0,
  );
}

export function getSprayTargetWireSource(
  sprays: readonly NetworkServerSnapshotSprayTarget[],
): SprayTargetWireSource | undefined {
  return sprayWireSources.get(sprays);
}

export function writeSprayTargetWireRowsDirect(
  sprayTargets: SprayTarget[] | undefined,
  visibility: SnapshotVisibility | undefined,
  sprays: NetworkServerSnapshotSprayTarget[],
): NetworkServerSnapshotSprayTarget[] | undefined {
  directSprayWireSource.count = 0;
  sprayWireSources.set(sprays, directSprayWireSource);
  sprays.length = 0;
  if (!sprayTargets || sprayTargets.length === 0) return undefined;

  for (let i = 0; i < sprayTargets.length; i++) {
    const source = sprayTargets[i];
    if (
      visibility &&
      !visibility.isPointVisible(source.source.pos.x, source.source.pos.y) &&
      !visibility.isPointVisible(source.target.pos.x, source.target.pos.y)
    ) {
      continue;
    }
    appendDirectSprayWireRow(directSprayWireSource, source);
  }

  if (directSprayWireSource.count === 0) return undefined;
  sprays.length = directSprayWireSource.count;
  return sprays;
}

export function serializeSprayTargets(
  sprayTargets: SprayTarget[] | undefined,
  visibility: SnapshotVisibility | undefined,
  trackingKey: string | number | undefined,
): NetworkServerSnapshotSprayTarget[] | undefined {
  const poolKey = resolveSnapshotPoolKey(trackingKey);
  const state = getOrCreateSnapshotPool(sprayPools, poolKey);
  state.index = 0;
  const wireSource = getOrCreateKeyedWireSource(sprayWireSourcesByKey, poolKey, state.buf, sprayWireSources);
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
    out.source.z = source.source.z ?? null;
    out.source.playerId = source.source.playerId;
    out.target.id = source.target.id;
    out.target.pos.x = source.target.pos.x;
    out.target.pos.y = source.target.pos.y;
    out.target.z = source.target.z ?? null;
    if (source.target.dim) {
      if (!out.target.dim) out.target.dim = { x: 0, y: 0 };
      out.target.dim.x = source.target.dim.x;
      out.target.dim.y = source.target.dim.y;
    } else {
      out.target.dim = null;
    }
    out.target.radius = source.target.radius ?? null;
    out.type = source.type;
    out.intensity = source.intensity;
    out.speed = source.speed ?? null;
    out.particleRadius = source.particleRadius ?? null;
    out.ballSpawnRate = source.ballSpawnRate ?? null;
    sprayBuf.push(out);
    appendSprayWireRow(wireSource, out);
  }
  return sprayBuf.length > 0 ? sprayBuf : undefined;
}
