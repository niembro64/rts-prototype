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

function flatZoneBucketKey(gx: number, gy: number): number {
  return (gx + FLAT_ZONE_BUCKET_BIAS) * FLAT_ZONE_BUCKET_BASE
    + (gy + FLAT_ZONE_BUCKET_BIAS);
}

function rebuildDepositFlatZoneBuckets(): void {
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
): void {
  depositFlatZones = zones.slice();
  rebuildDepositFlatZoneBuckets();
  invalidateTerrainConfig();
}

function getDepositFlatZoneCandidates(
  x: number,
  y: number,
): readonly TerrainFlatZone[] {
  if (depositFlatZoneBuckets.size === 0) return [];
  const gx = Math.floor(x / FLAT_ZONE_BUCKET_SIZE);
  const gy = Math.floor(y / FLAT_ZONE_BUCKET_SIZE);
  return depositFlatZoneBuckets.get(flatZoneBucketKey(gx, gy)) ?? [];
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
 *  caller should blend in.
 *
 *  Inside ANY deposit's inner radius: that deposit dominates entirely
 *  (returned with weight 0) so the flat pad stays exact — extractors
 *  rely on it being level. Outside every inner radius, all reachable
 *  blend rings contribute simultaneously: each ring's deposit-side
 *  weight is `w_z` (1 at the edge of its inner radius, smooth fall to
 *  0 at radius + blendRadius). Their combined influence is the
 *  probabilistic union `1 - prod(1 - w_z)`, and the deposit-side pad
 *  height is the w_z-weighted average of every reachable ring's
 *  height. This way two pads with overlapping blend bands hand off
 *  smoothly to each other instead of "snap to whichever deposit is
 *  closest", which used to throw a discontinuous cliff where the
 *  winner flipped. */
export function depositOverride(
  x: number,
  y: number,
): { weight: number; height: number } {
  if (depositFlatZones.length === 0) return { weight: 1, height: 0 };
  const candidates = getDepositFlatZoneCandidates(x, y);
  if (candidates.length === 0) return { weight: 1, height: 0 };

  // First: inner-radius dominance. The closest containing pad wins
  // outright so the flat pad stays exact under the deposit.
  let containing: TerrainFlatZone | null = null;
  let containingD2 = Infinity;
  for (const z of candidates) {
    const dx = x - z.x;
    const dy = y - z.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= z.radius * z.radius && d2 < containingD2) {
      containing = z;
      containingD2 = d2;
    }
  }
  if (containing !== null) return { weight: 0, height: containing.height };

  // Else: smooth multi-zone blend in the union of blend bands.
  let oneMinusProduct = 1;
  let weightedHeight = 0;
  let weightSum = 0;
  for (const z of candidates) {
    const blendRadius = Math.max(0, z.blendRadius);
    if (blendRadius <= 0) continue;
    const dx = x - z.x;
    const dy = y - z.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= z.radius + blendRadius) continue;
    if (d <= z.radius) continue;
    const t = (d - z.radius) / blendRadius;
    const wz = (1 + Math.cos(t * Math.PI)) * 0.5;
    oneMinusProduct *= 1 - wz;
    weightedHeight += wz * z.height;
    weightSum += wz;
  }
  if (weightSum <= 0) return { weight: 1, height: 0 };
  const totalInfluence = 1 - oneMinusProduct;
  return {
    weight: 1 - totalInfluence,
    height: weightedHeight / weightSum,
  };
}
