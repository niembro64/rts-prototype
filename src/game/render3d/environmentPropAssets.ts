import type { RenderObjectLodTier } from '@/types/graphics';

export type EnvironmentAssetFormat = 'obj' | 'fbx';
export type EnvironmentAssetKind = 'tree' | 'grass';
export type EnvironmentPalette =
  | 'modular'
  | 'lowTree'
  | 'lowGrass'
  | 'forestTree'
  | 'forestDeadTree'
  | 'devilsTree'
  | 'simpleTree'
  | 'simpleGrass'
  | 'freeGrass';

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
const FREE_SHRUBS_ROOT = ASSET_ROOT + '/free-shrubs-flowers-mushrooms';
const DEVILS_ROOT = ASSET_ROOT + '/low-poly-forest-devilswork';
const LOWPOLY_ASSETS_ROOT = ASSET_ROOT + '/lowpoly-assets/LowPolyAssets';
const DEVILS_FBX_ROOT = DEVILS_ROOT + '/FBX 2013';
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
  tree(
    'modCedar1',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Cedar_1.obj`,
    'obj',
    'modular',
    245,
    95,
    MODULAR_MTL,
  ),
  tree(
    'modCedar2',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Cedar_2.obj`,
    'obj',
    'modular',
    245,
    95,
    MODULAR_MTL,
  ),
  tree(
    'modOak1',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Oak_1.obj`,
    'obj',
    'modular',
    285,
    115,
    MODULAR_MTL,
  ),
  tree(
    'modOak2',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Oak_2.obj`,
    'obj',
    'modular',
    330,
    150,
    MODULAR_MTL,
  ),
  tree(
    'modOak3',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Oak_3.obj`,
    'obj',
    'modular',
    330,
    150,
    MODULAR_MTL,
  ),
  tree(
    'modOak4',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Oak_4.obj`,
    'obj',
    'modular',
    380,
    170,
    MODULAR_MTL,
  ),
  tree(
    'modPine1',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Pine_1.obj`,
    'obj',
    'modular',
    335,
    135,
    MODULAR_MTL,
  ),
  tree(
    'modPine2',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Pine_2.obj`,
    'obj',
    'modular',
    360,
    145,
    MODULAR_MTL,
  ),
  tree(
    'modPine3',
    `${MODULAR_ROOT}/Hilly_Prop_Tree_Pine_3.obj`,
    'obj',
    'modular',
    320,
    135,
    MODULAR_MTL,
  ),
  tree(
    'palm1',
    `${MODULAR_ROOT}/Beach_Prop_Tree_Palm_1.obj`,
    'obj',
    'modular',
    310,
    140,
    MODULAR_MTL,
  ),
  tree(
    'palm2',
    `${MODULAR_ROOT}/Beach_Prop_Tree_Palm_2.obj`,
    'obj',
    'modular',
    340,
    145,
    MODULAR_MTL,
  ),
  tree(
    'palm3',
    `${MODULAR_ROOT}/Beach_Prop_Tree_Palm_3.obj`,
    'obj',
    'modular',
    320,
    150,
    MODULAR_MTL,
  ),

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
    'lowTree1',
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_001.obj`,
    'obj',
    'lowTree',
    320,
    155,
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_001.mtl`,
  ),
  tree(
    'lowTree2',
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_002.obj`,
    'obj',
    'lowTree',
    390,
    160,
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_002.mtl`,
  ),
  tree(
    'lowTree3',
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_003.obj`,
    'obj',
    'lowTree',
    380,
    170,
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_003.mtl`,
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
    'lowTree6',
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_006.obj`,
    'obj',
    'lowTree',
    300,
    150,
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_006.mtl`,
  ),
  grass(
    'lowGrass1',
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Grass_001.obj`,
    'obj',
    'lowGrass',
    55,
    55,
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Grass_001.mtl`,
  ),
  grass(
    'lowGrass2',
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Grass_002.obj`,
    'obj',
    'lowGrass',
    44,
    44,
    `${FOLIAGE_OBJ_ROOT}/Low_Poly_Grass_002.mtl`,
  ),

  tree(
    'forestOak1',
    `${FOREST_ROOT}/Trees/OakTree1.fbx`,
    'fbx',
    'forestTree',
    330,
    145,
  ),
  tree(
    'forestOak2',
    `${FOREST_ROOT}/Trees/OakTree2.fbx`,
    'fbx',
    'forestTree',
    360,
    155,
  ),
  tree(
    'forestOak3',
    `${FOREST_ROOT}/Trees/OakTree3.fbx`,
    'fbx',
    'forestTree',
    380,
    165,
  ),
  tree(
    'forestSpruce1',
    `${FOREST_ROOT}/Trees/SpruceTree1.fbx`,
    'fbx',
    'forestTree',
    330,
    130,
  ),
  tree(
    'forestSpruce2',
    `${FOREST_ROOT}/Trees/SpruceTree2.fbx`,
    'fbx',
    'forestTree',
    340,
    135,
  ),
  tree(
    'forestSpruce3',
    `${FOREST_ROOT}/Trees/SpruceTree3.fbx`,
    'fbx',
    'forestTree',
    350,
    140,
  ),
  tree(
    'deadOak1',
    `${FOREST_ROOT}/Trees/DeadOak1.fbx`,
    'fbx',
    'forestDeadTree',
    250,
    105,
  ),
  tree(
    'deadOak2',
    `${FOREST_ROOT}/Trees/DeadOak2.fbx`,
    'fbx',
    'forestDeadTree',
    260,
    110,
  ),
  tree(
    'deadSpruce1',
    `${FOREST_ROOT}/Trees/DeadSpruce1.fbx`,
    'fbx',
    'forestDeadTree',
    250,
    105,
  ),
  tree(
    'deadSpruce2',
    `${FOREST_ROOT}/Trees/DeadSpruce2.fbx`,
    'fbx',
    'forestDeadTree',
    260,
    110,
  ),

  tree(
    'devilsTree01',
    `${DEVILS_FBX_ROOT}/Low_Poly_Forest_tree01.fbx`,
    'fbx',
    'devilsTree',
    360,
    155,
  ),
  tree(
    'devilsTree04',
    `${DEVILS_FBX_ROOT}/Low_Poly_Forest_tree04.fbx`,
    'fbx',
    'devilsTree',
    300,
    120,
  ),
  tree(
    'devilsTreeBlob04',
    `${DEVILS_FBX_ROOT}/Low_Poly_Forest_treeBlob04.fbx`,
    'fbx',
    'devilsTree',
    220,
    100,
  ),
  tree(
    'devilsRoundTop02',
    `${DEVILS_FBX_ROOT}/Low_Poly_Forest_treeRoundTop02.fbx`,
    'fbx',
    'devilsTree',
    380,
    150,
  ),
  tree(
    'devilsRoundTop05',
    `${DEVILS_FBX_ROOT}/Low_Poly_Forest_treeRoundTop05.fbx`,
    'fbx',
    'devilsTree',
    300,
    95,
  ),
  tree(
    'devilsTreeTall02',
    `${DEVILS_FBX_ROOT}/Low_Poly_Forest_treeTall02.fbx`,
    'fbx',
    'devilsTree',
    390,
    135,
  ),
  tree(
    'devilsTreeTall05',
    `${DEVILS_FBX_ROOT}/Low_Poly_Forest_treeTall05.fbx`,
    'fbx',
    'devilsTree',
    210,
    80,
  ),
  tree(
    'devilsTreeThin01',
    `${DEVILS_FBX_ROOT}/Low_Poly_Forest_treeThin01.fbx`,
    'fbx',
    'devilsTree',
    360,
    70,
  ),

  grass(
    'freeGrass1',
    `${FREE_SHRUBS_ROOT}/fbx/_grass_1.fbx`,
    'fbx',
    'freeGrass',
    52,
    48,
  ),
  grass(
    'freeGrass2',
    `${FREE_SHRUBS_ROOT}/fbx/_grass_2.fbx`,
    'fbx',
    'freeGrass',
    48,
    45,
  ),

  tree(
    'simpleTree01',
    `${LOWPOLY_ASSETS_ROOT}/Tree01.FBX`,
    'fbx',
    'simpleTree',
    310,
    125,
  ),
  tree(
    'simpleTree02',
    `${LOWPOLY_ASSETS_ROOT}/Tree02.FBX`,
    'fbx',
    'simpleTree',
    320,
    130,
  ),
  tree(
    'simpleTree03',
    `${LOWPOLY_ASSETS_ROOT}/Tree03.FBX`,
    'fbx',
    'simpleTree',
    300,
    120,
  ),
  tree(
    'simpleTree04',
    `${LOWPOLY_ASSETS_ROOT}/Tree04.FBX`,
    'fbx',
    'simpleTree',
    300,
    120,
  ),
  tree(
    'simpleTree05',
    `${LOWPOLY_ASSETS_ROOT}/Tree05.FBX`,
    'fbx',
    'simpleTree',
    330,
    135,
  ),
  tree(
    'simpleDeadTree',
    `${LOWPOLY_ASSETS_ROOT}/DeadTree.FBX`,
    'fbx',
    'forestDeadTree',
    230,
    95,
  ),
  grass(
    'simpleGrass',
    `${LOWPOLY_ASSETS_ROOT}/Grass.FBX`,
    'fbx',
    'simpleGrass',
    50,
    50,
  ),
];

// Applied after each asset's scale. 1 keeps the current asset sizes unchanged.
export const RANDOM_ENVIRONMENT_ASSET_GLOBAL_SCALE = 2.2;

// Adds +/- this fraction to each placed asset's resolved scale. 0.1 means +/-10%.
export const RANDOM_ENVIRONMENT_ASSET_SCALE_RANDOMNESS = 0.05;

// Toggle random placement here. Scale is a direct multiplier on that asset's world size.
// Frequency is a relative pick weight among enabled assets of the same kind.
export const RANDOM_ENVIRONMENT_ASSETS = [
  { id: 'modCedar1', use: false, scale: 0.1, frequency: 1 }, // bad
  { id: 'modCedar2', use: false, scale: 0.1, frequency: 1 }, // ok
  { id: 'modOak1', use: false, scale: 0.1, frequency: 1 }, //bad
  { id: 'modOak2', use: false, scale: 0.1, frequency: 1 }, // pretty good
  { id: 'modOak3', use: false, scale: 0.1, frequency: 1 }, // pretty good
  { id: 'modOak4', use: false, scale: 0.1, frequency: 1 }, // pretty good
  { id: 'modPine1', use: false, scale: 0.1, frequency: 1 }, // too simple
  { id: 'modPine2', use: false, scale: 0.1, frequency: 1 }, // too simple
  { id: 'modPine3', use: false, scale: 0.1, frequency: 1 }, // too simple
  { id: 'palm1', use: false, scale: 0.1, frequency: 1 }, // meh
  { id: 'palm2', use: false, scale: 0.1, frequency: 1 }, // meh
  { id: 'palm3', use: false, scale: 0.1, frequency: 1 }, // meh
  { id: 'lowTree1', use: false, scale: 0.08, frequency: 0.1 }, // simple
  { id: 'lowTree2', use: false, scale: 0.1, frequency: 1 }, // too complicated
  { id: 'lowTree3', use: false, scale: 0.1, frequency: 1 }, // good
  { id: 'lowTree4', use: true, scale: 0.1, frequency: 1 }, // good simple
  { id: 'lowTree5', use: true, scale: 0.1, frequency: 1 }, // good simple
  { id: 'lowTree6', use: false, scale: 0.1, frequency: 1 }, // terrible
  { id: 'forestOak1', use: false, scale: 0.1, frequency: 1 }, // too complex
  { id: 'forestOak2', use: false, scale: 0.1, frequency: 1 }, // too complex
  { id: 'forestOak3', use: false, scale: 0.1, frequency: 1 }, // too complex
  { id: 'forestSpruce1', use: false, scale: 0.1, frequency: 1 },
  { id: 'forestSpruce2', use: true, scale: 0.15, frequency: 1 },
  { id: 'forestSpruce3', use: false, scale: 0.1, frequency: 1 },
  { id: 'deadOak1', use: false, scale: 0.1, frequency: 1 },
  { id: 'deadOak2', use: false, scale: 0.1, frequency: 1 },
  { id: 'deadSpruce1', use: false, scale: 0.1, frequency: 1 },
  { id: 'deadSpruce2', use: false, scale: 0.1, frequency: 1 },
  { id: 'devilsTree01', use: false, scale: 0.1, frequency: 1 },
  { id: 'devilsTree04', use: false, scale: 0.1, frequency: 1 },
  { id: 'devilsTreeBlob04', use: false, scale: 0.1, frequency: 1 },
  { id: 'devilsRoundTop02', use: false, scale: 0.1, frequency: 1 },
  { id: 'devilsRoundTop05', use: false, scale: 0.1, frequency: 1 },
  { id: 'devilsTreeTall02', use: false, scale: 0.1, frequency: 1 },
  { id: 'devilsTreeTall05', use: false, scale: 0.1, frequency: 1 },
  { id: 'devilsTreeThin01', use: false, scale: 0.1, frequency: 1 },
  { id: 'simpleTree01', use: false, scale: 0.1, frequency: 1 },
  { id: 'simpleTree02', use: false, scale: 0.1, frequency: 1 },
  { id: 'simpleTree03', use: false, scale: 0.1, frequency: 1 },
  { id: 'simpleTree04', use: false, scale: 0.1, frequency: 1 },
  { id: 'simpleTree05', use: false, scale: 0.1, frequency: 1 },
  { id: 'simpleDeadTree', use: false, scale: 0.1, frequency: 1 },
  { id: 'modGrass1', use: true, scale: 0.1, frequency: 1 },
  { id: 'modGrass2', use: true, scale: 0.1, frequency: 1 },
  { id: 'modGrass3', use: true, scale: 0.1, frequency: 1 },
  { id: 'modGrass4', use: true, scale: 0.1, frequency: 1 },
  { id: 'lowGrass1', use: false, scale: 0.1, frequency: 1 },
  { id: 'lowGrass2', use: false, scale: 0.1, frequency: 1 },
  { id: 'freeGrass1', use: false, scale: 0.1, frequency: 1 },
  { id: 'freeGrass2', use: false, scale: 0.1, frequency: 1 },
  { id: 'simpleGrass', use: false, scale: 0.1, frequency: 1 },
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
