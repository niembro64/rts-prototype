// Vegetation — the simulation's view of trees, grass, and seaweed.
//
// These are reclaimable energy deposits (see src/vegetationConfig.ts for
// the BAR feature values they inherit), not scenery, so their layout and
// their remaining yield are simulation state. Rust owns both; this module
// is the TypeScript face of that store: it packs the authored config into
// the kernel's rows, mirrors the generated layout for callers that want
// plain objects, and translates between prop indices and the target ids
// that travel in commands and unit actions.
//
// TARGET IDS. A prop is not an entity. Thousands of trees must not enter
// the entity map, the spatial grid, the snapshot serializer, or the slot
// registry — BAR keeps features in their own lightweight system for the
// same reason, and addresses them from unit orders as
// `featureID + Game.maxUnits`. We use that convention directly: a prop's
// target id is `VEGETATION_TARGET_ID_BASE + index`, which fits in the
// existing numeric `targetId` on reclaim commands and unit actions, so no
// command, action, or wire shape had to grow a second target field. Every
// site that resolves a target id asks `isVegetationTargetId` first.

import {
  VEGETATION_KIND_IDS,
  VEGETATION_PLACEMENT_CONFIG,
  getVegetationKindConfig,
  vegetationKindIdFromIndex,
  type VegetationKindId,
} from '@/vegetationConfig';
import {
  getLiquidSurfaceMode,
  getTerrainSurfaceMode,
  vegetationMediumSupported,
} from './worldSurfaceState';
import {
  getVegetationAssetOptions,
  getVegetationAssetSpec,
  vegetationAssetScale,
  type VegetationAssetSpec,
} from '@/vegetationAssets';
import { getSimWasm } from '../sim-wasm/init';
import type { EntityId } from './types';

/** BAR's `featureID + Game.maxUnits` convention. Entity ids are
 *  allocated from 1 upward, so a base this far above any reachable
 *  entity count keeps the two spaces disjoint while staying an exact
 *  integer in every float64 and int32 field a target id passes through. */
export const VEGETATION_TARGET_ID_BASE = 1_000_000_000;

/** Immutable layout of one generated prop, in simulation coordinates
 *  (x/y horizontal, z up). Mirrors one Rust prop row. */
export type VegetationProp = {
  /** Index into the generated list. Stable for the whole match. */
  index: number;
  /** `VEGETATION_TARGET_ID_BASE + index` — what commands carry. */
  targetId: EntityId;
  kind: VegetationKindId;
  assetId: string;
  assetSlot: number;
  x: number;
  y: number;
  /** World height of the prop's base (its root contact point). */
  z: number;
  rotation: number;
  height: number;
  /** Footprint radius; also the prop's selection/reclaim volume radius. */
  radius: number;
  maxHp: number;
  energyTotal: number;
};

export type VegetationReclaimTick = {
  energy: number;
  metal: number;
  hpRemoved: number;
  /** 1 = untouched, 0 = fully consumed. */
  reclaimFraction: number;
  completed: boolean;
};

const VEGETATION_KIND_ROW_STRIDE = 19;
const VEGETATION_ASSET_ROW_STRIDE = 4;
const VEGETATION_PROP_OUTPUT_STRIDE = 10;
const VEGETATION_PROP_STATE_STRIDE = 6;
const VEGETATION_RECLAIM_TICK_STRIDE = 5;
const VEGETATION_MEDIUM_CODE = { land: 0, waterline: 1 } as const;

const _propStateOut = new Float64Array(VEGETATION_PROP_STATE_STRIDE);
const _reclaimTickOut = new Float64Array(VEGETATION_RECLAIM_TICK_STRIDE);
const _raycastOut = new Float64Array(2);

function requireSimWasm(context: string) {
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error(`${context}: sim-wasm is not initialized`);
  }
  return sim;
}

export function isVegetationTargetId(
  targetId: number | null | undefined,
): targetId is EntityId {
  return (
    typeof targetId === 'number' &&
    Number.isInteger(targetId) &&
    targetId >= VEGETATION_TARGET_ID_BASE
  );
}

export function vegetationTargetIdForIndex(index: number): EntityId {
  return VEGETATION_TARGET_ID_BASE + index;
}

export function vegetationIndexFromTargetId(targetId: number): number {
  return targetId - VEGETATION_TARGET_ID_BASE;
}

/** Bitmask over kind ordinals for the Rust query filters. 0 = all kinds. */
export function vegetationKindMask(kinds: readonly VegetationKindId[]): number {
  let mask = 0;
  for (const kind of kinds) mask |= 1 << VEGETATION_KIND_IDS.indexOf(kind);
  return mask;
}

/** Mirror of the Rust prop store's immutable layout. One browser runs
 *  one simulation, so one installed list serves the sim, the command
 *  layer, and the renderer. */
let installedProps: readonly VegetationProp[] = [];
let installedKey = '';

function vegetationGenerationKey(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
): string {
  // The WORLD materials decide which kinds are placed at all, so they are part
  // of the layout's identity — otherwise a mode flip would silently keep the
  // previous world's forest instead of tripping the mismatch error below.
  return `${mapWidth}x${mapHeight}:${playerCount}:${getTerrainSurfaceMode()}:${getLiquidSurfaceMode()}`;
}

/**
 * Generate the map's vegetation once, or return the already-generated
 * list. Unlike metal deposits, props carry mutable reclaim state, so a
 * second generation pass would silently restore consumed energy —
 * hence the idempotent front door. Every caller (server bootstrap and
 * the renderer alike) goes through it, and a caller that asks for a
 * DIFFERENT map than the one already installed is a hard error rather
 * than a quiet divergence.
 */
export function ensureVegetationGenerated(
  mapWidth: number,
  mapHeight: number,
  playerCount: number,
): readonly VegetationProp[] {
  const players = Math.max(1, Math.floor(playerCount));
  const key = vegetationGenerationKey(mapWidth, mapHeight, players);
  // Dropping the terrain mesh also drops the prop store (placement was
  // sampled from that mesh), so an emptied store means the mirror is
  // stale rather than that this is a repeat call.
  if (installedKey !== '' && (getSimWasm()?.vegetationCount() ?? 0) === 0) {
    installedProps = [];
    installedKey = '';
  }
  if (installedKey !== '') {
    if (installedKey !== key) {
      throw new Error(
        `Vegetation was generated for ${installedKey} but ${key} was requested; one simulation owns one prop layout`,
      );
    }
    return installedProps;
  }
  installedProps = generateVegetation(mapWidth, mapHeight);
  installedKey = key;
  return installedProps;
}

/** The installed prop layout, empty before generation. */
export function getVegetationProps(): readonly VegetationProp[] {
  return installedProps;
}

export function getVegetationProp(index: number): VegetationProp | undefined {
  return installedProps[index];
}

/** The prop a reclaim command/action target id addresses, or undefined
 *  when the id is not a vegetation id or names a consumed prop. */
export function getLiveVegetationPropByTargetId(
  targetId: number | null | undefined,
): VegetationProp | undefined {
  if (!isVegetationTargetId(targetId)) return undefined;
  const index = vegetationIndexFromTargetId(targetId);
  const prop = installedProps[index];
  if (prop === undefined || !isVegetationAlive(index)) return undefined;
  return prop;
}

/**
 * Lay out every vegetation prop for one map. Deterministic: the same
 * `(mapWidth, mapHeight, config)` always produces the same candidate
 * stream; the installed terrain alone decides which candidates qualify,
 * so the host and every client can
 * call this independently instead of networking the layout — exactly
 * how `generateMetalDeposits` works.
 *
 * Requires the authoritative terrain mesh to be installed in WASM
 * first; the kernel samples it for bed height, slope, and water depth.
 * Returns an empty list when no mesh is installed yet.
 */
function generateVegetation(
  mapWidth: number,
  mapHeight: number,
): VegetationProp[] {
  const sim = requireSimWasm('generateVegetation');
  const placement = VEGETATION_PLACEMENT_CONFIG;
  const { kindRows, assetRows, assetSpecs } = packVegetationConfigRows();
  const count = sim.vegetationGenerate(
    mapWidth,
    mapHeight,
    placement.seed,
    placement.areaScaleMin,
    placement.areaScaleMax,
    placement.defaultMapWidth,
    placement.defaultMapHeight,
    placement.maxAttemptsPerTarget,
    placement.edgeClearance,
    placement.assetScaleJitter,
    kindRows,
    assetRows,
  );
  if (count === 0) return [];

  const rows = new Float64Array(count * VEGETATION_PROP_OUTPUT_STRIDE);
  const written = sim.vegetationReadProps(rows);
  if (written !== count) {
    throw new Error(
      `Vegetation kernel generated ${count} props but read back ${written}`,
    );
  }

  const props: VegetationProp[] = new Array(count);
  for (let index = 0; index < count; index++) {
    const base = index * VEGETATION_PROP_OUTPUT_STRIDE;
    const kind = vegetationKindIdFromIndex(rows[base]);
    const assetSlot = rows[base + 1];
    const spec = assetSpecs.get(kind)?.[assetSlot];
    if (spec === undefined) {
      throw new Error(
        `Vegetation prop ${index} referenced ${kind} asset slot ${assetSlot}, which is outside the active asset table`,
      );
    }
    props[index] = {
      index,
      targetId: vegetationTargetIdForIndex(index),
      kind,
      assetId: spec.id,
      assetSlot,
      x: rows[base + 2],
      y: rows[base + 3],
      z: rows[base + 4],
      rotation: rows[base + 5],
      height: rows[base + 6],
      radius: rows[base + 7],
      maxHp: rows[base + 8],
      energyTotal: rows[base + 9],
    };
  }
  return props;
}

/** Drop the whole prop store. Match teardown and deterministic-replay
 *  resets call this so a stale forest cannot leak into the next match. */
export function clearVegetation(): void {
  getSimWasm()?.vegetationClear();
  installedProps = [];
  installedKey = '';
}

/** True while the prop still has work left in it. Consumed props stay
 *  in the list at a stable index and simply report false. */
export function isVegetationAlive(index: number): boolean {
  const sim = getSimWasm();
  if (sim === undefined) return false;
  if (sim.vegetationPropState(index, _propStateOut) === 0) return false;
  return _propStateOut[0] !== 0;
}

/** Remaining reclaim fraction: 1 = untouched, 0 = consumed. Returns 0
 *  for an unknown or consumed prop. */
export function getVegetationReclaimFraction(index: number): number {
  const sim = getSimWasm();
  if (sim === undefined) return 0;
  if (sim.vegetationPropState(index, _propStateOut) === 0) return 0;
  return _propStateOut[5];
}

/** Energy still recoverable from the prop. */
export function getVegetationEnergyLeft(index: number): number {
  const sim = getSimWasm();
  if (sim === undefined) return 0;
  if (sim.vegetationPropState(index, _propStateOut) === 0) return 0;
  return _propStateOut[3];
}

/**
 * One builder-tick of BAR gradual reclaim against a prop. `buildPower`
 * is the builder's construction rate; consuming a prop therefore takes
 * `reclaimTime / buildPower` seconds and pays out the full authored
 * energy, spread evenly across that span. Returns null when the prop is
 * already gone or the tick did no work.
 */
export function applyVegetationReclaimTick(
  index: number,
  buildPower: number,
  dtSec: number,
): VegetationReclaimTick | null {
  const sim = requireSimWasm('applyVegetationReclaimTick');
  if (sim.vegetationApplyReclaimTick(index, buildPower, dtSec, _reclaimTickOut) === 0) {
    return null;
  }
  return {
    energy: _reclaimTickOut[0],
    metal: _reclaimTickOut[1],
    hpRemoved: _reclaimTickOut[2],
    reclaimFraction: _reclaimTickOut[3],
    completed: _reclaimTickOut[4] !== 0,
  };
}

/**
 * Live prop indices inside a world-space disc, ascending. Area reclaim
 * fans out over this, so the ascending order matters: every peer must
 * hand the same props to the same builders.
 */
export function queryVegetationInCircle(
  x: number,
  y: number,
  radius: number,
  out: Uint32Array,
  kindMask = 0,
): number {
  const sim = getSimWasm();
  if (sim === undefined) return 0;
  return sim.vegetationQueryCircle(x, y, radius, kindMask, out);
}

/**
 * Nearest live prop hit by a world-space ray, tested against the prop's
 * upright cylinder — the same selection-volume model `raycastEntity`
 * uses for units and buildings. Returns the prop index, or -1.
 */
export function raycastVegetation(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDistance: number,
): number {
  const sim = getSimWasm();
  if (sim === undefined) return -1;
  const hit = sim.vegetationRaycast(
    originX,
    originY,
    originZ,
    dirX,
    dirY,
    dirZ,
    maxDistance,
    0,
    _raycastOut,
  );
  return hit === 0 ? -1 : _raycastOut[0];
}

/** Total entries in the append-only removal log. Presentation keeps a
 *  cursor into it instead of diffing the prop list every frame. */
export function getVegetationRemovedCount(): number {
  return getSimWasm()?.vegetationRemovedCount() ?? 0;
}

/** Copy removal-log entries from `from` onward into `out`. */
export function readVegetationRemoved(from: number, out: Uint32Array): number {
  const sim = getSimWasm();
  if (sim === undefined) return 0;
  return sim.vegetationReadRemoved(from, out);
}

/** Hash of live vegetation state for the canonical state hash. Props are
 *  a contested resource, so a peer whose forest diverged has desynced. */
export function getVegetationStateHash(): number {
  return getSimWasm()?.vegetationStateHash() ?? 0;
}

function packVegetationConfigRows(): {
  kindRows: Float64Array;
  assetRows: Float64Array;
  assetSpecs: Map<VegetationKindId, readonly VegetationAssetSpec[]>;
} {
  const assetSpecs = new Map<VegetationKindId, readonly VegetationAssetSpec[]>();
  const flatAssets: VegetationAssetSpec[] = [];
  const kindRows = new Float64Array(VEGETATION_KIND_IDS.length * VEGETATION_KIND_ROW_STRIDE);

  for (let kindIndex = 0; kindIndex < VEGETATION_KIND_IDS.length; kindIndex++) {
    const kind = VEGETATION_KIND_IDS[kindIndex];
    const config = getVegetationKindConfig(kind);
    const options = getVegetationAssetOptions(kind);
    assetSpecs.set(kind, options);
    const assetRowStart = flatAssets.length;
    flatAssets.push(...options);

    const base = kindIndex * VEGETATION_KIND_ROW_STRIDE;
    // A world that cannot support this medium gets a zero budget rather than
    // a post-filter: the props would otherwise still be reclaimable energy
    // sitting inside metal or lava.
    kindRows[base] = vegetationMediumSupported(config.medium) ? config.targetCount : 0;
    kindRows[base + 1] = VEGETATION_MEDIUM_CODE[config.medium];
    kindRows[base + 2] = config.waterBuffer;
    kindRows[base + 3] = config.waterlineRangeFraction;
    kindRows[base + 4] = config.minSlope;
    kindRows[base + 5] = config.maxSlope;
    kindRows[base + 6] = config.maxTerrainHeight;
    kindRows[base + 7] = config.heightScaleMin;
    kindRows[base + 8] = config.heightScaleMax;
    kindRows[base + 9] = config.radiusScaleMin;
    kindRows[base + 10] = config.radiusScaleMax;
    kindRows[base + 11] = config.slopeSinkRadiusFraction;
    kindRows[base + 12] = config.slopeSinkMaxHeightFraction;
    kindRows[base + 13] = assetRowStart;
    kindRows[base + 14] = options.length;
    kindRows[base + 15] = config.reclaim.hp;
    kindRows[base + 16] = config.reclaim.reclaimTime;
    kindRows[base + 17] = config.reclaim.energy;
    kindRows[base + 18] = config.reclaim.metal;
  }

  const assetRows = new Float64Array(flatAssets.length * VEGETATION_ASSET_ROW_STRIDE);
  for (let i = 0; i < flatAssets.length; i++) {
    const spec = flatAssets[i];
    const base = i * VEGETATION_ASSET_ROW_STRIDE;
    assetRows[base] = spec.frequency;
    assetRows[base + 1] = spec.defaultHeight;
    assetRows[base + 2] = spec.defaultRadius;
    assetRows[base + 3] = vegetationAssetScale(spec);
  }
  return { kindRows, assetRows, assetSpecs };
}

/** Convenience for UI/debug: the asset spec behind a generated prop. */
export function getVegetationPropAsset(
  prop: VegetationProp,
): VegetationAssetSpec | undefined {
  return getVegetationAssetSpec(prop.kind, prop.assetSlot);
}
