import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { LAND_CELL_SIZE } from '../../../config';
import { invalidateTerrainConfig } from './terrainState';

export type TerrainFlatZone = {
  x: number;
  y: number;
  radius: number;
  height: number;
  blendRadius: number;
};

let depositFlatZones: ReadonlyArray<TerrainFlatZone> = [];
let depositFlatZoneBuckets = new Map<number, TerrainFlatZone[]>();

const FLAT_ZONE_BUCKET_SIZE = LAND_CELL_SIZE;
const FLAT_ZONE_BUCKET_BIAS = 10000;
const FLAT_ZONE_BUCKET_BASE = 20000;
const EMPTY_FLAT_ZONES: readonly TerrainFlatZone[] = [];
let cachedDepositFlatZoneBucketGx = Number.NaN;
let cachedDepositFlatZoneBucketGy = Number.NaN;
let cachedDepositFlatZoneCandidates: readonly TerrainFlatZone[] = EMPTY_FLAT_ZONES;
const depositOverrideBlendWeights: number[] = [];
const depositOverrideBlendHeights: number[] = [];

function flatZoneBucketKey(gx: number, gy: number): number {
  return (gx + FLAT_ZONE_BUCKET_BIAS) * FLAT_ZONE_BUCKET_BASE
    + (gy + FLAT_ZONE_BUCKET_BIAS);
}

function rebuildDepositFlatZoneBuckets(): void {
  cachedDepositFlatZoneBucketGx = Number.NaN;
  cachedDepositFlatZoneBucketGy = Number.NaN;
  cachedDepositFlatZoneCandidates = EMPTY_FLAT_ZONES;
  const buckets = new Map<number, TerrainFlatZone[]>();
  const size = FLAT_ZONE_BUCKET_SIZE;
  for (const z of depositFlatZones) {
    const influenceRadius = z.radius + Math.max(0, z.blendRadius);
    const minGx = Math.floor((z.x - influenceRadius) / size);
    const maxGx = Math.floor((z.x + influenceRadius) / size);
    const minGy = Math.floor((z.y - influenceRadius) / size);
    const maxGy = Math.floor((z.y + influenceRadius) / size);
    for (let gx = minGx; gx <= maxGx; gx++) {
      for (let gy = minGy; gy <= maxGy; gy++) {
        const key = flatZoneBucketKey(gx, gy);
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        list.push(z);
      }
    }
  }
  depositFlatZoneBuckets = buckets;
}

export function setMetalDepositFlatZones(
  zones: ReadonlyArray<TerrainFlatZone>,
  invalidate = true,
): void {
  depositFlatZones = zones.slice();
  rebuildDepositFlatZoneBuckets();
  if (invalidate) invalidateTerrainConfig();
}

export function getMetalDepositFlatZones(): readonly TerrainFlatZone[] {
  return depositFlatZones;
}

function getDepositFlatZoneCandidates(
  x: number,
  y: number,
): readonly TerrainFlatZone[] {
  if (depositFlatZoneBuckets.size === 0) return EMPTY_FLAT_ZONES;
  const gx = Math.floor(x / FLAT_ZONE_BUCKET_SIZE);
  const gy = Math.floor(y / FLAT_ZONE_BUCKET_SIZE);
  if (
    gx === cachedDepositFlatZoneBucketGx &&
    gy === cachedDepositFlatZoneBucketGy
  ) {
    return cachedDepositFlatZoneCandidates;
  }
  const candidates = depositFlatZoneBuckets.get(flatZoneBucketKey(gx, gy)) ?? EMPTY_FLAT_ZONES;
  cachedDepositFlatZoneBucketGx = gx;
  cachedDepositFlatZoneBucketGy = gy;
  cachedDepositFlatZoneCandidates = candidates;
  return candidates;
}

export function findDepositFlatZoneAt(x: number, y: number): TerrainFlatZone | null {
  const candidates = getDepositFlatZoneCandidates(x, y);
  for (const z of candidates) {
    const dx = x - z.x;
    const dy = y - z.y;
    if (dx * dx + dy * dy <= z.radius * z.radius) return z;
  }
  return null;
}

/** Resolve every deposit's contribution to (x, y). Returns the
 *  natural-terrain weight (`weight`) and the deposit pad height the
 *  caller should blend in. The caller's blend is
 *    `height * (1 - weight) + natural * weight`.
 *
 *  Inside ANY deposit's inner radius: that deposit dominates entirely
 *  (returned with weight 0) so the flat pad stays exact — extractors
 *  rely on it being level. If two flat pads overlap, the closest one
 *  wins and the discontinuity is left to the author (the user has
 *  said overlapping `flatPadCells` are allowed to cliff).
 *
 *  Outside every inner radius, each reachable blend ring contributes
 *  via an "effective weight" e_z = w_z · ∏_{j≠z}(1 - w_j), where
 *  w_z = 1 at the edge of z's inner radius and smoothly falls to 0
 *  at radius + blendRadius. The natural-terrain weight is
 *  ∏_z(1 - w_z). This makes the blend continuous across every pad
 *  edge: at deposit z's outer edge of its inner radius, w_z → 1, so
 *  e_z absorbs every other deposit's contribution AND the natural
 *  weight, and the output equals h_z — matching the flat pad
 *  interior. Two pads with overlapping blend bands hand off smoothly
 *  to each other instead of cliffing at the boundary. */
export function depositOverride(
  x: number,
  y: number,
): { weight: number; height: number } {
  if (depositFlatZones.length === 0) return { weight: 1, height: 0 };
  const candidates = getDepositFlatZoneCandidates(x, y);
  if (candidates.length === 0) return { weight: 1, height: 0 };

  // Single pass: pick up the closest containing pad if any, otherwise
  // build the blend-ring weight list.
  let containing: TerrainFlatZone | null = null;
  let containingD2 = Infinity;
  const blendWeights = depositOverrideBlendWeights;
  const blendHeights = depositOverrideBlendHeights;
  blendWeights.length = 0;
  blendHeights.length = 0;
  for (const z of candidates) {
    const dx = x - z.x;
    const dy = y - z.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= z.radius * z.radius) {
      if (d2 < containingD2) {
        containing = z;
        containingD2 = d2;
      }
      continue;
    }
    if (containing !== null) continue;
    const blendRadius = Math.max(0, z.blendRadius);
    if (blendRadius <= 0) continue;
    const d = DMath.sqrt(d2);
    if (d >= z.radius + blendRadius) continue;
    const t = (d - z.radius) / blendRadius;
    const wz = (1 + DMath.cos(t * Math.PI)) * 0.5;
    blendWeights.push(wz);
    blendHeights.push(z.height);
  }
  if (containing !== null) return { weight: 0, height: containing.height };
  const n = blendWeights.length;
  if (n === 0) return { weight: 1, height: 0 };

  // Effective per-deposit weights e_z = w_z · ∏_{j≠z}(1 - w_j) and
  // natural weight ∏_z(1 - w_z). When any w_i → 1 the corresponding
  // (1 - w_i) zeroes every other deposit's e AND the natural weight,
  // so e_i absorbs everything and the output collapses to h_i —
  // continuous with the flat-pad interior on the other side of the
  // edge.
  let prodAll = 1;
  for (let i = 0; i < n; i++) prodAll *= 1 - blendWeights[i];

  let weightedHeightSum = 0;
  let effectiveSum = 0;
  for (let i = 0; i < n; i++) {
    const oneMinus = 1 - blendWeights[i];
    let ei: number;
    if (oneMinus > 1e-12) {
      ei = blendWeights[i] * (prodAll / oneMinus);
    } else {
      // w_i is numerically 1; compute the leave-one-out product directly.
      let prodExcl = 1;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        prodExcl *= 1 - blendWeights[j];
      }
      ei = blendWeights[i] * prodExcl;
    }
    weightedHeightSum += ei * blendHeights[i];
    effectiveSum += ei;
  }
  const totalWeight = effectiveSum + prodAll;
  if (totalWeight <= 0) return { weight: 1, height: 0 };
  if (effectiveSum <= 0) return { weight: 1, height: 0 };

  return {
    weight: prodAll / totalWeight,
    height: weightedHeightSum / effectiveSum,
  };
}
