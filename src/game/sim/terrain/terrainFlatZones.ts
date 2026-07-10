import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { LAND_CELL_SIZE } from '../../../config';
import { invalidateTerrainConfig } from './terrainState';

export type TerrainFlatZone = {
  x: number;
  y: number;
  /** Full circular pad radius. For ungrouped zones the whole pad is
   *  flat at `height`; for grouped zones the pad is the region this
   *  zone claims for its group's smoothed height field. */
  radius: number;
  height: number;
  blendRadius: number;
  /** Hard-flat inner radius. Equal to `radius` for classic ungrouped
   *  pads; the deposit's resource-footprint radius for grouped zones,
   *  whose pad annulus outside it carries the group interpolation. */
  plateauRadius: number;
  /** Zones sharing a non-negative id form a `group-manual` unit: the
   *  union of their pads is fully overridden by one smoothed height
   *  field (exact plateau heights, cosine interpolation between them,
   *  cosine skirt over blendRadius). -1 = classic standalone pad. */
  groupId: number;
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
const depositOverrideGroupIds: number[] = [];
const depositOverrideGroupWeightSums: number[] = [];
const depositOverrideGroupWeightedHeights: number[] = [];
const depositOverrideGroupAlphas: number[] = [];

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

/** Zone whose GUARANTEED-FLAT area contains (x, y) — the full pad for
 *  classic zones, only the plateau for grouped zones (their pad annulus
 *  is a smoothed slope, so callers wanting "terrain here equals
 *  zone.height exactly" must not match it). */
export function findDepositFlatZoneAt(x: number, y: number): TerrainFlatZone | null {
  const candidates = getDepositFlatZoneCandidates(x, y);
  for (const z of candidates) {
    const dx = x - z.x;
    const dy = y - z.y;
    const flatRadius = z.groupId >= 0 ? z.plateauRadius : z.radius;
    if (dx * dx + dy * dy <= flatRadius * flatRadius) return z;
  }
  return null;
}

/** Resolve every deposit's contribution to (x, y). Returns the
 *  natural-terrain weight (`weight`) and the deposit pad height the
 *  caller should blend in. The caller's blend is
 *    `height * (1 - weight) + natural * weight`.
 *
 *  Inside ANY deposit's guaranteed-flat radius (full pad for classic
 *  zones, plateau for grouped zones): that deposit dominates entirely
 *  (returned with weight 0) so the flat pad stays exact — extractors
 *  rely on it being level. If two flat pads overlap, the closest one
 *  wins and the discontinuity is left to the author (the user has
 *  said overlapping `flatPadCells` are allowed to cliff).
 *
 *  GROUPED zones (`group-manual` clusters) are folded into the same
 *  framework as one synthesized entry per group: the group's smoothed
 *  height field W (exact at plateaus, cosine-shaped interpolation
 *  between them across the pad annuli and skirt) enters the combine
 *  with weight alpha = the group's pad-union coverage (1 inside any
 *  member pad, raised-cosine falloff over blendRadius outside). Full
 *  pad-union override and the outer skirt both fall out of the
 *  existing effective-weight combine below.
 *
 *  Outside every guaranteed-flat radius, each reachable entry
 *  contributes via an "effective weight" e_z = w_z · ∏_{j≠z}(1 - w_j),
 *  where w_z = 1 at the edge of z's flat radius and smoothly falls to
 *  0 at radius + blendRadius. The natural-terrain weight is
 *  ∏_z(1 - w_z). This makes the blend continuous across every pad
 *  edge: at deposit z's outer edge of its flat radius, w_z → 1, so
 *  e_z absorbs every other deposit's contribution AND the natural
 *  weight, and the output equals h_z — matching the flat pad
 *  interior. Two pads with overlapping blend bands hand off smoothly
 *  to each other instead of cliffing at the boundary.
 *
 *  MIRROR: metal_deposit_override_from_flat_zone_rows in
 *  rts-sim-wasm/src/deposits.rs implements the same math over the
 *  packed 7-stride rows. Entry order matters for bit-identical float
 *  sums: ungrouped blend entries in zone-row order, then one entry per
 *  group in first-seen zone-row order. */
export function depositOverride(
  x: number,
  y: number,
): { weight: number; height: number } {
  if (depositFlatZones.length === 0) return { weight: 1, height: 0 };
  const candidates = getDepositFlatZoneCandidates(x, y);
  if (candidates.length === 0) return { weight: 1, height: 0 };

  // Single pass: pick up the closest containing pad if any, otherwise
  // build the blend-ring weight list and per-group field accumulators.
  let containing: TerrainFlatZone | null = null;
  let containingD2 = Infinity;
  const blendWeights = depositOverrideBlendWeights;
  const blendHeights = depositOverrideBlendHeights;
  blendWeights.length = 0;
  blendHeights.length = 0;
  const groupIds = depositOverrideGroupIds;
  const groupWeightSums = depositOverrideGroupWeightSums;
  const groupWeightedHeights = depositOverrideGroupWeightedHeights;
  const groupAlphas = depositOverrideGroupAlphas;
  groupIds.length = 0;
  groupWeightSums.length = 0;
  groupWeightedHeights.length = 0;
  groupAlphas.length = 0;
  for (const z of candidates) {
    const dx = x - z.x;
    const dy = y - z.y;
    const d2 = dx * dx + dy * dy;
    const grouped = z.groupId >= 0;
    const flatRadius = grouped ? z.plateauRadius : z.radius;
    if (d2 <= flatRadius * flatRadius) {
      if (d2 < containingD2) {
        containing = z;
        containingD2 = d2;
      }
      continue;
    }
    if (containing !== null) continue;
    const blendRadius = Math.max(0, z.blendRadius);
    const d = DMath.sqrt(d2);
    if (grouped) {
      // Group member: accumulate the plateau-exact interpolation field
      // (weights diverge as d approaches the plateau, so the field
      // meets each plateau height exactly) and the pad-union coverage.
      let groupSlot = -1;
      for (let g = 0; g < groupIds.length; g++) {
        if (groupIds[g] === z.groupId) {
          groupSlot = g;
          break;
        }
      }
      if (groupSlot < 0) {
        groupSlot = groupIds.length;
        groupIds.push(z.groupId);
        groupWeightSums.push(0);
        groupWeightedHeights.push(0);
        groupAlphas.push(0);
      }
      const span = (z.radius - z.plateauRadius) + blendRadius;
      if (span > 0) {
        const t = (d - z.plateauRadius) / span;
        if (t < 1) {
          const tc = t < 0 ? 0 : t;
          const c = (1 + DMath.cos(tc * Math.PI)) * 0.5;
          const w = (c * c) / Math.max(tc * tc, 1e-12);
          groupWeightSums[groupSlot] += w;
          groupWeightedHeights[groupSlot] += w * z.height;
        }
      }
      let alpha = 0;
      if (d <= z.radius) {
        alpha = 1;
      } else if (blendRadius > 0 && d < z.radius + blendRadius) {
        const ta = (d - z.radius) / blendRadius;
        alpha = (1 + DMath.cos(ta * Math.PI)) * 0.5;
      }
      if (alpha > groupAlphas[groupSlot]) groupAlphas[groupSlot] = alpha;
      continue;
    }
    if (blendRadius <= 0) continue;
    if (d >= z.radius + blendRadius) continue;
    const t = (d - z.radius) / blendRadius;
    const wz = (1 + DMath.cos(t * Math.PI)) * 0.5;
    blendWeights.push(wz);
    blendHeights.push(z.height);
  }
  if (containing !== null) return { weight: 0, height: containing.height };
  // Each group joins the combine as one synthesized entry: its
  // interpolated field height, weighted by its pad-union coverage.
  for (let g = 0; g < groupIds.length; g++) {
    if (groupAlphas[g] <= 0 || groupWeightSums[g] <= 0) continue;
    blendWeights.push(groupAlphas[g]);
    blendHeights.push(groupWeightedHeights[g] / groupWeightSums[g]);
  }
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
