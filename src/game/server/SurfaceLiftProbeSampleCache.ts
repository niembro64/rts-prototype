/**
 * Per-unit cache of the surface under each height probe, refreshed on a
 * deterministic bucket rotation instead of every fixed tick.
 *
 * Sampling the lattice is the expensive half of surface following: every
 * probe point costs a terrain-bed lookup plus a support-surface index query,
 * and it ran for every lifted unit on every tick. The surface under a unit
 * changes far more slowly than the tick rate, so units are split into
 * `bucketCount` refresh buckets and exactly one bucket re-samples per tick.
 * A unit therefore pays for its terrain queries once every `bucketCount`
 * ticks rather than every tick.
 *
 * What is NOT staggered is the force. The proposed lift is recomputed every
 * tick from the unit's LIVE altitude against these cached surfaces (see
 * UnitForceSystem.aggregateSurfaceLiftProposedForces), so a body that rises
 * or falls still feels the response change immediately — only the sampled
 * ground beneath it is held. Holding the whole force instead would leave a
 * flyer pushing on half-second-old data and make it visibly bob.
 *
 * The CENTRE point is never cached either. It sits at the body's own
 * position, its support height is the contact surface the tick already
 * resolved, and its medium is one terrain-bed lookup — so the unit's own
 * ground stays exact for free and only the outrigger points, which carry the
 * support-index queries, ride the rotation.
 *
 * Determinism: the bucket is `hash(entityId) % bucketCount` and the refresh
 * test is `tick % bucketCount === bucket`. Both are exact integer operations
 * on values every peer already agrees on, so every peer re-samples the same
 * unit on the same tick. The hash spreads consecutively spawned units (a
 * factory's output, a wave of aircraft) across buckets, which plain `id %`
 * would not. The cache is derivable simulation scratch: it is never
 * serialized, never crosses the wire, and a slot reused by a different
 * entity re-samples on sight.
 */

import type { EntityId } from '../sim/types';
import { growTypedArray } from '../memory/typedArrayGrowth';
import {
  SURFACE_PROBE_MAX_POINTS,
  SURFACE_PROBE_REFRESH_BUCKET_COUNT,
} from '../sim/surfaceProbeSets';

const INITIAL_SLOT_CAPACITY = 512;

/** Stable pseudo-random bucket for one entity. Entity ids never change
 *  during a unit's life, so a unit keeps its refresh phase from spawn to
 *  death and cannot drift onto its neighbours' tick. */
export function surfaceProbeRefreshBucketForEntityId(
  entityId: number,
  bucketCount: number = SURFACE_PROBE_REFRESH_BUCKET_COUNT,
): number {
  const count = Number.isFinite(bucketCount)
    ? Math.max(1, Math.round(bucketCount))
    : 1;
  if (count === 1) return 0;
  let hash = entityId | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) % count;
}

export class SurfaceLiftProbeSampleCache {
  /** Which entity owns each slot's rows. A recycled slot never inherits the
   *  previous occupant's terrain. */
  private ownerEntityId = new Float64Array(INITIAL_SLOT_CAPACITY);
  private sampleCount = new Uint8Array(INITIAL_SLOT_CAPACITY);
  private probeX = new Float64Array(INITIAL_SLOT_CAPACITY * SURFACE_PROBE_MAX_POINTS);
  private probeY = new Float64Array(INITIAL_SLOT_CAPACITY * SURFACE_PROBE_MAX_POINTS);
  private probeGroundZ = new Float64Array(INITIAL_SLOT_CAPACITY * SURFACE_PROBE_MAX_POINTS);
  private probeWaterCovered = new Uint8Array(INITIAL_SLOT_CAPACITY * SURFACE_PROBE_MAX_POINTS);
  private writeCursor = 0;

  /**
   * True when `entityId` must re-sample its lattice on `tick`: it is this
   * tick's bucket, or the slot holds no usable rows for it yet (first sight,
   * or a slot recycled from another entity).
   */
  needsRefresh(slot: number, entityId: EntityId, tick: number): boolean {
    // An unseen slot, or one recycled from another entity, has no lattice
    // for this unit yet and cannot wait for its bucket.
    if (slot >= this.ownerEntityId.length) return true;
    if (this.ownerEntityId[slot] !== entityId) return true;
    const buckets = SURFACE_PROBE_REFRESH_BUCKET_COUNT;
    if (buckets <= 1) return true;
    const phase = ((tick % buckets) + buckets) % buckets;
    return phase === surfaceProbeRefreshBucketForEntityId(entityId, buckets);
  }

  /** Start writing a fresh lattice for `slot`. Every `beginRefresh` must be
   *  followed by its `push` calls and one `endRefresh`. */
  beginRefresh(slot: number, entityId: EntityId): void {
    this.ensureCapacity(slot + 1);
    this.ownerEntityId[slot] = entityId;
    this.sampleCount[slot] = 0;
    this.writeCursor = 0;
  }

  push(
    slot: number,
    x: number,
    y: number,
    groundZ: number,
    waterCovered: boolean,
  ): void {
    if (this.writeCursor >= SURFACE_PROBE_MAX_POINTS) return;
    const index = slot * SURFACE_PROBE_MAX_POINTS + this.writeCursor;
    this.probeX[index] = x;
    this.probeY[index] = y;
    this.probeGroundZ[index] = groundZ;
    this.probeWaterCovered[index] = waterCovered ? 1 : 0;
    this.writeCursor++;
  }

  endRefresh(slot: number): void {
    this.sampleCount[slot] = this.writeCursor;
    this.writeCursor = 0;
  }

  /** Outrigger rows held for `slot` — the lattice minus its centre point.
   *  Zero means the set is centre-only or its inputs were not finite; the
   *  caller then aggregates the live centre alone. */
  count(slot: number): number {
    return slot < this.sampleCount.length ? this.sampleCount[slot] : 0;
  }

  x(slot: number, index: number): number {
    return this.probeX[slot * SURFACE_PROBE_MAX_POINTS + index];
  }

  y(slot: number, index: number): number {
    return this.probeY[slot * SURFACE_PROBE_MAX_POINTS + index];
  }

  groundZ(slot: number, index: number): number {
    return this.probeGroundZ[slot * SURFACE_PROBE_MAX_POINTS + index];
  }

  waterCovered(slot: number, index: number): boolean {
    return this.probeWaterCovered[slot * SURFACE_PROBE_MAX_POINTS + index] !== 0;
  }

  private ensureCapacity(slots: number): void {
    if (slots <= this.sampleCount.length) return;
    let nextCapacity = Math.max(INITIAL_SLOT_CAPACITY, this.sampleCount.length);
    while (nextCapacity < slots) nextCapacity *= 2;
    const points = nextCapacity * SURFACE_PROBE_MAX_POINTS;
    this.ownerEntityId = growTypedArray(this.ownerEntityId, nextCapacity);
    this.sampleCount = growTypedArray(this.sampleCount, nextCapacity);
    this.probeX = growTypedArray(this.probeX, points);
    this.probeY = growTypedArray(this.probeY, points);
    this.probeGroundZ = growTypedArray(this.probeGroundZ, points);
    this.probeWaterCovered = growTypedArray(this.probeWaterCovered, points);
  }
}
