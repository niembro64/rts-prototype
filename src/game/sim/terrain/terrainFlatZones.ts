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

export function depositOverride(
  x: number,
  y: number,
): { weight: number; height: number } {
  if (depositFlatZones.length === 0) return { weight: 1, height: 0 };
  const candidates = getDepositFlatZoneCandidates(x, y);
  if (candidates.length === 0) return { weight: 1, height: 0 };
  let minWeight = 1;
  let bestHeight = 0;
  for (const z of candidates) {
    const dx = x - z.x;
    const dy = y - z.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= z.radius) return { weight: 0, height: z.height };
    const blendRadius = Math.max(0, z.blendRadius);
    if (blendRadius > 0 && d < z.radius + blendRadius) {
      const t = (d - z.radius) / blendRadius;
      const w = (1 - Math.cos(t * Math.PI)) * 0.5;
      if (w < minWeight) {
        minWeight = w;
        bestHeight = z.height;
      }
    }
  }
  return { weight: minWeight, height: bestHeight };
}
