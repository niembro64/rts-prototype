import type { RenderObjectLodTier } from '@/types/graphics';
import { LAND_CELL_SIZE } from '../../config';
import type { MetalDeposit } from '../../metalDepositConfig';
import { getSpawnPositionForSeat } from '../sim/spawn';
import {
  getSurfaceNormal,
  isFarFromWater,
  isWaterAt,
  WATER_LEVEL,
} from '../sim/Terrain';
import {
  ASSET_BY_ID,
  GRASS_ASSET_OPTIONS,
  TREE_ASSET_OPTIONS,
  getRandomEnvironmentAssetScale,
  getRandomEnvironmentAssetScaleJitter,
  type WeightedEnvironmentAssetOption,
} from './environmentPropAssets';

export type EnvironmentPlacement = {
  assetId: string;
  x: number;
  z: number;
  y: number;
  rotation: number;
  height: number;
  radius: number;
  minTier: RenderObjectLodTier;
};

export type EnvironmentPlacementGenerationOptions = {
  mapWidth: number;
  mapHeight: number;
  playerCount: number;
  metalDeposits: ReadonlyArray<MetalDeposit>;
  sampleTerrainHeight: (x: number, z: number) => number;
};

type PlacementOptions = {
  height?: number;
  radius?: number;
  rotation?: number;
  minTier?: RenderObjectLodTier;
  waterBuffer?: number;
};

type RandomPlacementProfile = Readonly<{
  targetCount: number;
  heightScaleMin: number;
  heightScaleMax: number;
  radiusScaleMin: number;
  radiusScaleMax: number;
  minTier?: RenderObjectLodTier;
  waterBuffer: number;
}>;

type SurfaceNormal = { nx: number; ny: number; nz: number };
type PlacementContext = EnvironmentPlacementGenerationOptions & { playerCount: number };

const METAL_DEPOSIT_CLEARANCE = 260;
const EDGE_CLEARANCE = 180;
const DEFAULT_TREE_WATER_BUFFER = 130;
const DEFAULT_GRASS_WATER_BUFFER = 55;
export const SCOPE_PADDING_EXTRA = 120;
const RANDOM_ENVIRONMENT_PLACEMENT_MAX_ATTEMPTS_PER_TARGET = 80;

// Uses the terrain shader slope metric: 0 is flat, 1 is vertical.
export const RANDOM_ENVIRONMENT_ASSET_MIN_SLOPE = 0.03;
export const RANDOM_ENVIRONMENT_ASSET_MAX_SLOPE = 0.3;
export const RANDOM_ENVIRONMENT_ASSET_MAX_HEIGHT = 100;

// Lower tree roots by the terrain drop across this approximate trunk/base
// footprint so the downhill side does not reveal the asset's underside.
export const RANDOM_ENVIRONMENT_TREE_SLOPE_SINK_RADIUS_FRACTION = 0.35;
export const RANDOM_ENVIRONMENT_TREE_SLOPE_SINK_MAX_HEIGHT_FRACTION = 0.12;

// Target counts at the default map area. Larger/smaller maps scale from these.
export const RANDOM_ENVIRONMENT_TREE_ASSET_COUNT = 1000;
export const RANDOM_ENVIRONMENT_GRASS_ASSET_COUNT = 1000;

export function generateEnvironmentPlacements(
  options: EnvironmentPlacementGenerationOptions,
): EnvironmentPlacement[] {
  const context: PlacementContext = {
    ...options,
    playerCount: Math.max(1, Math.floor(options.playerCount)),
  };
  const placements: EnvironmentPlacement[] = [];
  const seed = hashSeed(
    context.mapWidth,
    context.mapHeight,
    context.playerCount,
    context.metalDeposits.length,
  );
  const rng = mulberry32(seed);
  addRandomEnvironmentAssetPlacements(
    context,
    placements,
    rng,
    TREE_ASSET_OPTIONS,
    {
      targetCount: randomTreeTargetCount(context),
      heightScaleMin: 0.78,
      heightScaleMax: 1.22,
      radiusScaleMin: 0.85,
      radiusScaleMax: 1.2,
      waterBuffer: DEFAULT_TREE_WATER_BUFFER,
    },
  );
  addRandomEnvironmentAssetPlacements(
    context,
    placements,
    rng,
    GRASS_ASSET_OPTIONS,
    {
      targetCount: randomGrassTargetCount(context),
      heightScaleMin: 0.55,
      heightScaleMax: 1.35,
      radiusScaleMin: 0.65,
      radiusScaleMax: 1.25,
      minTier: 'mass',
      waterBuffer: DEFAULT_GRASS_WATER_BUFFER,
    },
  );
  return placements;
}

function addRandomEnvironmentAssetPlacements(
  context: PlacementContext,
  placements: EnvironmentPlacement[],
  rng: () => number,
  assetOptions: readonly WeightedEnvironmentAssetOption[],
  profile: RandomPlacementProfile,
): void {
  if (assetOptions.length === 0 || profile.targetCount <= 0) return;
  let placed = 0;
  const maxAttempts =
    profile.targetCount * RANDOM_ENVIRONMENT_PLACEMENT_MAX_ATTEMPTS_PER_TARGET;
  for (
    let attempt = 0;
    placed < profile.targetCount && attempt < maxAttempts;
    attempt++
  ) {
    const assetId = chooseWeightedEnvironmentAssetIdOrNull(assetOptions, rng);
    if (!assetId) continue;
    const spec = ASSET_BY_ID.get(assetId);
    if (!spec) continue;
    const x = rng() * context.mapWidth;
    const z = rng() * context.mapHeight;
    const added = tryAddPlacement(context, placements, assetId, x, z, rng, {
      height:
        spec.defaultHeight *
        randRange(rng, profile.heightScaleMin, profile.heightScaleMax),
      radius:
        spec.defaultRadius *
        randRange(rng, profile.radiusScaleMin, profile.radiusScaleMax),
      rotation: rng() * Math.PI * 2,
      minTier: profile.minTier,
      waterBuffer: profile.waterBuffer,
    });
    if (added) placed++;
  }
}

function tryAddPlacement(
  context: PlacementContext,
  placements: EnvironmentPlacement[],
  assetId: string,
  x: number,
  z: number,
  rng: () => number,
  options: PlacementOptions = {},
): boolean {
  const spec = ASSET_BY_ID.get(assetId);
  if (!spec) return false;
  const assetScale = getRandomEnvironmentAssetScale(assetId);
  if (assetScale <= 0) return false;
  const jitteredScale = assetScale * getRandomEnvironmentAssetScaleJitter(rng);
  const height = (options.height ?? spec.defaultHeight) * jitteredScale;
  const radius = (options.radius ?? spec.defaultRadius) * jitteredScale;
  if (!canPlaceAt(context, x, z, radius, options)) return false;
  const y = context.sampleTerrainHeight(x, z);
  if (!Number.isFinite(y) || y < WATER_LEVEL) return false;
  if (!isRandomEnvironmentAssetHeightAllowed(y)) return false;
  const normal = getRandomEnvironmentSurfaceNormal(context, x, z);
  if (!isSlopeInRandomEnvironmentAssetZone(terrainSlopeFromNormalUp(normal.nz))) return false;
  const slopeSink =
    spec.kind === 'tree'
      ? treeSlopeBaseSinkFromNormal(normal, radius, height)
      : 0;
  placements.push({
    assetId,
    x,
    z,
    y: y - slopeSink,
    rotation: options.rotation ?? 0,
    height,
    radius,
    minTier: options.minTier ?? spec.minTier,
  });
  return true;
}

function getRandomEnvironmentSurfaceNormal(
  context: PlacementContext,
  x: number,
  z: number,
): SurfaceNormal {
  return getSurfaceNormal(
    x,
    z,
    context.mapWidth,
    context.mapHeight,
    LAND_CELL_SIZE,
  );
}

function canPlaceAt(
  context: PlacementContext,
  x: number,
  z: number,
  radius: number,
  options: PlacementOptions,
): boolean {
  const edge = Math.max(EDGE_CLEARANCE, radius);
  if (
    x < edge ||
    z < edge ||
    x > context.mapWidth - edge ||
    z > context.mapHeight - edge
  ) {
    return false;
  }
  if (isWaterAt(x, z, context.mapWidth, context.mapHeight, LAND_CELL_SIZE)) return false;
  const waterBuffer = options.waterBuffer ?? DEFAULT_GRASS_WATER_BUFFER;
  if (
    waterBuffer > 0 &&
    !isFarFromWater(x, z, context.mapWidth, context.mapHeight, waterBuffer)
  ) {
    return false;
  }
  if (!isClearOfMetalDeposits(context, x, z, radius)) return false;
  if (!isClearOfPlayerStarts(context, x, z, radius)) return false;
  return true;
}

function isClearOfMetalDeposits(
  context: PlacementContext,
  x: number,
  z: number,
  radius: number,
): boolean {
  for (const deposit of context.metalDeposits) {
    const clearance = deposit.flatPadRadius + METAL_DEPOSIT_CLEARANCE + radius;
    const dx = x - deposit.x;
    const dz = z - deposit.y;
    if (dx * dx + dz * dz < clearance * clearance) return false;
  }
  return true;
}

function isClearOfPlayerStarts(
  context: PlacementContext,
  x: number,
  z: number,
  radius: number,
): boolean {
  const clearance =
    Math.max(850, Math.min(context.mapWidth, context.mapHeight) * 0.075) + radius;
  for (let seat = 0; seat < context.playerCount; seat++) {
    const spawn = getSpawnPositionForSeat(
      seat,
      context.playerCount,
      context.mapWidth,
      context.mapHeight,
    );
    const dx = x - spawn.x;
    const dz = z - spawn.y;
    if (dx * dx + dz * dz < clearance * clearance) return false;
  }
  return true;
}

function areaScale(context: PlacementContext): number {
  const defaultArea = 10600 * 10600;
  return clamp((context.mapWidth * context.mapHeight) / defaultArea, 0.35, 2.4);
}

function randomTreeTargetCount(context: PlacementContext): number {
  return Math.round(RANDOM_ENVIRONMENT_TREE_ASSET_COUNT * areaScale(context));
}

function randomGrassTargetCount(context: PlacementContext): number {
  return Math.round(RANDOM_ENVIRONMENT_GRASS_ASSET_COUNT * areaScale(context));
}

function hashSeed(a: number, b: number, c: number, d: number): number {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ Math.floor(a), 16777619);
  h = Math.imul(h ^ Math.floor(b), 16777619);
  h = Math.imul(h ^ Math.floor(c), 16777619);
  h = Math.imul(h ^ Math.floor(d), 16777619);
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randRange(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

function chooseWeightedEnvironmentAssetIdOrNull(
  options: readonly WeightedEnvironmentAssetOption[],
  rng: () => number,
): string | null {
  let totalFrequency = 0;
  for (const option of options) totalFrequency += option.frequency;
  if (totalFrequency <= 0) return null;

  let target = rng() * totalFrequency;
  let fallback: string | null = null;
  for (const option of options) {
    fallback = option.id;
    target -= option.frequency;
    if (target <= 0) return option.id;
  }
  return fallback;
}

function terrainSlopeFromNormalUp(normalUp: number): number {
  return 1 - clamp(Math.abs(normalUp), 0, 1);
}

function treeSlopeBaseSinkFromNormal(
  normal: SurfaceNormal,
  radius: number,
  height: number,
): number {
  if (radius <= 0 || height <= 0) return 0;
  const normalUp = Math.max(Math.abs(normal.nz), 0.001);
  const horizontalNormal = Math.sqrt(
    normal.nx * normal.nx + normal.ny * normal.ny,
  );
  const terrainGrade = horizontalNormal / normalUp;
  const baseFootprintRadius =
    radius * RANDOM_ENVIRONMENT_TREE_SLOPE_SINK_RADIUS_FRACTION;
  const maxSink =
    height * RANDOM_ENVIRONMENT_TREE_SLOPE_SINK_MAX_HEIGHT_FRACTION;
  return clamp(terrainGrade * baseFootprintRadius, 0, maxSink);
}

function isSlopeInRandomEnvironmentAssetZone(slope: number): boolean {
  if (
    !Number.isFinite(RANDOM_ENVIRONMENT_ASSET_MIN_SLOPE) ||
    !Number.isFinite(RANDOM_ENVIRONMENT_ASSET_MAX_SLOPE)
  ) {
    return false;
  }
  const minSlope = clamp(RANDOM_ENVIRONMENT_ASSET_MIN_SLOPE, 0, 1);
  const maxSlope = clamp(RANDOM_ENVIRONMENT_ASSET_MAX_SLOPE, 0, 1);
  return minSlope <= maxSlope && slope >= minSlope && slope <= maxSlope;
}

function isRandomEnvironmentAssetHeightAllowed(height: number): boolean {
  if (!Number.isFinite(RANDOM_ENVIRONMENT_ASSET_MAX_HEIGHT)) return true;
  return height <= RANDOM_ENVIRONMENT_ASSET_MAX_HEIGHT;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
