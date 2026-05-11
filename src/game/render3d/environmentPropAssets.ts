import type { RenderObjectLodTier } from '@/types/graphics';

export type EnvironmentAssetFormat = 'obj' | 'fbx';
export type EnvironmentAssetKind = 'tree' | 'grass';
export type EnvironmentPalette =
  | 'modular'
  | 'lowTree'
  | 'forestTree';

export type EnvironmentAssetSpec = {
  id: string;
  kind: EnvironmentAssetKind;
  format: EnvironmentAssetFormat;
  path: string;
  materialPath?: string;
  defaultHeight: number;
  defaultRadius: number;
  minTier: RenderObjectLodTier;
  palette: EnvironmentPalette;
};

export type RandomEnvironmentAssetConfig = Readonly<{
  id: string;
  use: boolean;
  scale: number;
  frequency: number;
}>;

export type WeightedEnvironmentAssetOption = Readonly<{
  id: string;
  frequency: number;
}>;

const ASSET_ROOT = 'assets/environment-packs';
const MODULAR_ROOT = ASSET_ROOT + '/modular-terrain-collection';
const FOREST_ROOT = ASSET_ROOT + '/lowpoly-forest-pack';
const FOLIAGE_OBJ_ROOT = ASSET_ROOT + '/low-poly-foliage-pack-001/OBJ Files';
const MODULAR_MTL = MODULAR_ROOT + '/Materials_Modular_Terrain.mtl';

function tree(
  id: string,
  path: string,
  format: EnvironmentAssetFormat,
  palette: EnvironmentPalette,
  defaultHeight: number,
  defaultRadius: number,
  materialPath?: string,
): EnvironmentAssetSpec {
  return {
    id,
    kind: 'tree',
    format,
    path,
    materialPath,
    defaultHeight,
    defaultRadius,
    minTier: 'impostor',
    palette,
  };
}

function grass(
  id: string,
  path: string,
  format: EnvironmentAssetFormat,
  palette: EnvironmentPalette,
  defaultHeight: number,
  defaultRadius: number,
  materialPath?: string,
): EnvironmentAssetSpec {
  return {
    id,
    kind: 'grass',
    format,
    path,
    materialPath,
    defaultHeight,
    defaultRadius,
    minTier: 'mass',
    palette,
  };
}

export const ENVIRONMENT_ASSETS: readonly EnvironmentAssetSpec[] = [
  grass(
    'modGrass1',
    `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_1.obj`,
    'obj',
    'modular',
    42,
    42,
    MODULAR_MTL,
  ),
  grass(
    'modGrass2',
    `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_2.obj`,
    'obj',
    'modular',
    48,
    45,
    MODULAR_MTL,
  ),
  grass(
    'modGrass3',
    `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_3.obj`,
    'obj',
    'modular',
    56,
    48,
    MODULAR_MTL,
  ),
  grass(
    'modGrass4',
    `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_4.obj`,
    'obj',
    'modular',
    52,
    48,
    MODULAR_MTL,
  ),

  tree(
    'lowTree4',
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_004.obj`,
    'obj',
    'lowTree',
    330,
    95,
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_004.mtl`,
  ),
  tree(
    'lowTree5',
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_005.obj`,
    'obj',
    'lowTree',
    390,
    95,
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_005.mtl`,
  ),

  tree(
    'forestSpruce2',
    `${FOREST_ROOT}/Trees/SpruceTree2.fbx`,
    'fbx',
    'forestTree',
    340,
    135,
  ),
];

// Applied after each asset's scale. 1 keeps the current asset sizes unchanged.
export const RANDOM_ENVIRONMENT_ASSET_GLOBAL_SCALE = 2.2;

// Adds +/- this fraction to each placed asset's resolved scale. 0.1 means +/-10%.
export const RANDOM_ENVIRONMENT_ASSET_SCALE_RANDOMNESS = 0.05;

// Toggle random placement here. Scale is a direct multiplier on that asset's world size.
// Frequency is a relative pick weight among enabled assets of the same kind.
export const RANDOM_ENVIRONMENT_ASSETS = [
  { id: 'lowTree4', use: true, scale: 0.1, frequency: 1 },
  { id: 'lowTree5', use: true, scale: 0.1, frequency: 1 },
  { id: 'forestSpruce2', use: true, scale: 0.15, frequency: 1 },
  { id: 'modGrass1', use: true, scale: 0.1, frequency: 1 },
  { id: 'modGrass2', use: true, scale: 0.1, frequency: 1 },
  { id: 'modGrass3', use: true, scale: 0.1, frequency: 1 },
  { id: 'modGrass4', use: true, scale: 0.1, frequency: 1 },
] as const satisfies readonly RandomEnvironmentAssetConfig[];

const RANDOM_ENVIRONMENT_ASSET_CONFIG_BY_ID = new Map<
  string,
  RandomEnvironmentAssetConfig
>(RANDOM_ENVIRONMENT_ASSETS.map((config) => [config.id, config]));

export const ACTIVE_ENVIRONMENT_ASSETS = ENVIRONMENT_ASSETS.filter((spec) =>
  isRandomEnvironmentAssetUsable(spec.id),
);

export const ASSET_BY_ID = new Map(
  ACTIVE_ENVIRONMENT_ASSETS.map((spec) => [spec.id, spec]),
);

export const TREE_ASSET_OPTIONS = getWeightedEnvironmentAssetOptions('tree');
export const GRASS_ASSET_OPTIONS = getWeightedEnvironmentAssetOptions('grass');

function isUsableAssetConfig(
  config: RandomEnvironmentAssetConfig | undefined,
): config is RandomEnvironmentAssetConfig {
  return (
    config?.use === true &&
    Number.isFinite(config.scale) &&
    config.scale > 0 &&
    Number.isFinite(config.frequency) &&
    config.frequency > 0
  );
}

export function isRandomEnvironmentAssetUsable(assetId: string): boolean {
  return isUsableAssetConfig(
    RANDOM_ENVIRONMENT_ASSET_CONFIG_BY_ID.get(assetId),
  );
}

export function getRandomEnvironmentAssetScale(assetId: string): number {
  const config = RANDOM_ENVIRONMENT_ASSET_CONFIG_BY_ID.get(assetId);
  if (!isUsableAssetConfig(config)) return 0;
  if (
    !Number.isFinite(RANDOM_ENVIRONMENT_ASSET_GLOBAL_SCALE) ||
    RANDOM_ENVIRONMENT_ASSET_GLOBAL_SCALE <= 0
  ) {
    return 0;
  }
  return config.scale * RANDOM_ENVIRONMENT_ASSET_GLOBAL_SCALE;
}

function getRandomEnvironmentAssetFrequency(assetId: string): number {
  const config = RANDOM_ENVIRONMENT_ASSET_CONFIG_BY_ID.get(assetId);
  if (!isUsableAssetConfig(config)) return 0;
  return config.frequency;
}

function getWeightedEnvironmentAssetOptions(
  kind: EnvironmentAssetKind,
): WeightedEnvironmentAssetOption[] {
  return ACTIVE_ENVIRONMENT_ASSETS.filter((spec) => spec.kind === kind).map(
    (spec) => ({
      id: spec.id,
      frequency: getRandomEnvironmentAssetFrequency(spec.id),
    }),
  );
}

export function getRandomEnvironmentAssetScaleJitter(rng: () => number): number {
  if (
    !Number.isFinite(RANDOM_ENVIRONMENT_ASSET_SCALE_RANDOMNESS) ||
    RANDOM_ENVIRONMENT_ASSET_SCALE_RANDOMNESS <= 0
  ) {
    return 1;
  }
  return Math.max(
    0.001,
    randRange(
      rng,
      1 - RANDOM_ENVIRONMENT_ASSET_SCALE_RANDOMNESS,
      1 + RANDOM_ENVIRONMENT_ASSET_SCALE_RANDOMNESS,
    ),
  );
}

let loggedActiveEnvironmentAssets = false;

export function logActiveEnvironmentAssets(): void {
  if (!import.meta.env.DEV || loggedActiveEnvironmentAssets) return;
  loggedActiveEnvironmentAssets = true;
  const enabledIds = ACTIVE_ENVIRONMENT_ASSETS.map((spec) => spec.id);
  console.info(
    '[EnvironmentPropRenderer3D] enabled random assets (' + enabledIds.length + '): ' +
      (enabledIds.length > 0 ? enabledIds.join(', ') : 'none'),
  );
}

function randRange(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function isWoodMaterialForAsset(
  spec: EnvironmentAssetSpec,
  sourceName: string,
): boolean {
  if (spec.palette === 'lowTree') return sourceName.includes('mat_01');
  if (sourceName.includes('wood')) return true;
  if (sourceName.includes('bark')) return true;
  if (sourceName.includes('trunk')) return true;
  if (sourceName.includes('palm')) return true;
  if (sourceName.includes('leaf')) return false;
  if (sourceName.includes('leaves')) return false;
  if (sourceName.includes('needle')) return false;
  if (sourceName.includes('pine')) return false;
  if (sourceName.includes('cedar')) return false;
  if (sourceName.includes('oak')) return false;
  if (sourceName.includes('grass')) return false;
  return spec.kind === 'tree';
}
