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
