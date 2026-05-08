import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { GraphicsConfig, RenderObjectLodTier } from '@/types/graphics';
import { LAND_CELL_SIZE } from '../../config';
import type { MetalDeposit } from '../../metalDepositConfig';
import { ViewportFootprint } from '../ViewportFootprint';
import { getSpawnPositionForSeat } from '../sim/spawn';
import { isFarFromWater, isWaterAt, WATER_LEVEL } from '../sim/Terrain';
import type { Lod3DState } from './Lod3D';
import { RenderLodGrid } from './RenderLodGrid';

type EnvironmentAssetFormat = 'obj' | 'fbx';
type EnvironmentAssetKind = 'tree' | 'grass';
type EnvironmentPalette =
  | 'modular'
  | 'lowTree'
  | 'lowGrass'
  | 'forestTree'
  | 'forestDeadTree'
  | 'devilsTree'
  | 'simpleTree'
  | 'simpleGrass'
  | 'freeGrass';

type EnvironmentAssetSpec = {
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

type WeightedEnvironmentAssetOption = Readonly<{
  id: string;
  frequency: number;
}>;

type LoadedEnvironmentAsset = {
  spec: EnvironmentAssetSpec;
  template: THREE.Group;
  unitHeight: number;
};

type EnvironmentPlacement = {
  assetId: string;
  x: number;
  z: number;
  y: number;
  rotation: number;
  height: number;
  radius: number;
  minTier: RenderObjectLodTier;
};

type PlacementOptions = {
  height?: number;
  radius?: number;
  rotation?: number;
  minTier?: RenderObjectLodTier;
  waterBuffer?: number;
};

type EnvironmentPropNode = {
  placement: EnvironmentPlacement;
  root: THREE.Group;
};

export type EnvironmentPropRenderer3DOptions = {
  mapWidth: number;
  mapHeight: number;
  playerCount: number;
  metalDeposits: ReadonlyArray<MetalDeposit>;
  renderScope: ViewportFootprint;
  sampleTerrainHeight: (x: number, z: number) => number;
};

const ASSET_ROOT = 'assets/environment-packs';
const MODULAR_ROOT = `${ASSET_ROOT}/modular-terrain-collection`;
const FOREST_ROOT = `${ASSET_ROOT}/lowpoly-forest-pack`;
const FOLIAGE_OBJ_ROOT = `${ASSET_ROOT}/low-poly-foliage-pack-001/OBJ Files`;
const FREE_SHRUBS_ROOT = `${ASSET_ROOT}/free-shrubs-flowers-mushrooms`;
const DEVILS_ROOT = `${ASSET_ROOT}/low-poly-forest-devilswork`;
const LOWPOLY_ASSETS_ROOT = `${ASSET_ROOT}/lowpoly-assets/LowPolyAssets`;
const DEVILS_FBX_ROOT = `${DEVILS_ROOT}/FBX 2013`;
const MODULAR_MTL = `${MODULAR_ROOT}/Materials_Modular_Terrain.mtl`;
const METAL_DEPOSIT_CLEARANCE = 260;
const EDGE_CLEARANCE = 180;
const DEFAULT_TREE_WATER_BUFFER = 130;
const DEFAULT_GRASS_WATER_BUFFER = 55;
const SCOPE_PADDING_EXTRA = 120;
const FBX_UNKNOWN_MATERIAL_WARNING_FILTER_KEY =
  '__rtsFbxUnknownMaterialWarningFilterInstalled' as const;

type ConsoleWithFbxWarningFilter = Console & {
  [FBX_UNKNOWN_MATERIAL_WARNING_FILTER_KEY]?: boolean;
};

installKnownFbxMaterialWarningFilter();

const OBJECT_TIER_RANK: Record<RenderObjectLodTier, number> = {
  marker: 0,
  impostor: 1,
  mass: 2,
  simple: 3,
  rich: 4,
  hero: 5,
};

const ENVIRONMENT_ASSETS: readonly EnvironmentAssetSpec[] = [
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
export const RANDOM_ENVIRONMENT_ASSET_GLOBAL_SCALE = 3;

// Adds +/- this fraction to each placed asset's resolved scale. 0.1 means +/-10%.
export const RANDOM_ENVIRONMENT_ASSET_SCALE_RANDOMNESS = 0.1;

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
  { id: 'lowTree1', use: true, scale: 0.08, frequency: 0.05 }, // simple
  { id: 'lowTree2', use: false, scale: 0.1, frequency: 1 }, // too complicated
  { id: 'lowTree3', use: false, scale: 0.1, frequency: 1 }, // good
  { id: 'lowTree4', use: true, scale: 0.1, frequency: 1 }, // good simple
  { id: 'lowTree5', use: true, scale: 0.1, frequency: 1 }, // good simple
  { id: 'lowTree6', use: false, scale: 0.1, frequency: 1 }, // terrible
  { id: 'forestOak1', use: false, scale: 0.1, frequency: 1 },
  { id: 'forestOak2', use: false, scale: 0.1, frequency: 1 },
  { id: 'forestOak3', use: false, scale: 0.1, frequency: 1 },
  { id: 'forestSpruce1', use: false, scale: 0.1, frequency: 1 },
  { id: 'forestSpruce2', use: false, scale: 0.1, frequency: 1 },
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
  { id: 'modGrass1', use: false, scale: 0.1, frequency: 1 },
  { id: 'modGrass2', use: false, scale: 0.1, frequency: 1 },
  { id: 'modGrass3', use: false, scale: 0.1, frequency: 1 },
  { id: 'modGrass4', use: false, scale: 0.1, frequency: 1 },
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
const ACTIVE_ENVIRONMENT_ASSETS = ENVIRONMENT_ASSETS.filter((spec) =>
  isRandomEnvironmentAssetUsable(spec.id),
);
const ASSET_BY_ID = new Map(
  ACTIVE_ENVIRONMENT_ASSETS.map((spec) => [spec.id, spec]),
);
const TREE_ASSET_OPTIONS = getWeightedEnvironmentAssetOptions('tree');
const GRASS_ASSET_OPTIONS = getWeightedEnvironmentAssetOptions('grass');

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

function isRandomEnvironmentAssetUsable(assetId: string): boolean {
  return isUsableAssetConfig(
    RANDOM_ENVIRONMENT_ASSET_CONFIG_BY_ID.get(assetId),
  );
}

function getRandomEnvironmentAssetScale(assetId: string): number {
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

function getRandomEnvironmentAssetScaleJitter(rng: () => number): number {
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

function logActiveEnvironmentAssets(): void {
  if (!import.meta.env.DEV || loggedActiveEnvironmentAssets) return;
  loggedActiveEnvironmentAssets = true;
  const enabledIds = ACTIVE_ENVIRONMENT_ASSETS.map((spec) => spec.id);
  console.info(
    `[EnvironmentPropRenderer3D] enabled random assets (${enabledIds.length}): ${
      enabledIds.length > 0 ? enabledIds.join(', ') : 'none'
    }`,
  );
}

export class EnvironmentPropRenderer3D {
  private readonly root = new THREE.Group();
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly playerCount: number;
  private readonly metalDeposits: ReadonlyArray<MetalDeposit>;
  private readonly renderScope: ViewportFootprint;
  private readonly sampleTerrainHeight: (x: number, z: number) => number;
  private readonly placements: EnvironmentPlacement[];
  private readonly nodes: EnvironmentPropNode[] = [];
  private readonly materialCache = new Map<string, THREE.MeshLambertMaterial>();
  private readonly mtlCache = new Map<
    string,
    Promise<MTLLoader.MaterialCreator>
  >();
  private readonly assets = new Map<string, LoadedEnvironmentAsset>();
  private destroyed = false;
  private loaded = false;
  private lastScopeVersion = -1;
  private lastLodKey = '';

  constructor(
    parentWorld: THREE.Group,
    options: EnvironmentPropRenderer3DOptions,
  ) {
    this.mapWidth = options.mapWidth;
    this.mapHeight = options.mapHeight;
    this.playerCount = Math.max(1, Math.floor(options.playerCount));
    this.metalDeposits = options.metalDeposits;
    this.renderScope = options.renderScope;
    this.sampleTerrainHeight = options.sampleTerrainHeight;
    this.root.name = 'EnvironmentPropRenderer3D';
    parentWorld.add(this.root);
    logActiveEnvironmentAssets();
    this.placements = this.generatePlacements();
    void this.loadAssets();
  }

  update(
    graphicsConfig: GraphicsConfig,
    lod: Lod3DState,
    lodGrid: RenderLodGrid,
  ): void {
    void graphicsConfig;
    if (!this.loaded || this.nodes.length === 0) return;
    const scopeVersion = this.renderScope.getVersion();
    const lodKey = lod.key;
    if (scopeVersion === this.lastScopeVersion && lodKey === this.lastLodKey)
      return;
    this.lastScopeVersion = scopeVersion;
    this.lastLodKey = lodKey;
    for (const node of this.nodes) {
      const p = node.placement;
      if (!isRandomEnvironmentAssetUsable(p.assetId)) {
        node.root.visible = false;
        continue;
      }
      const inScope = this.renderScope.inScope(
        p.x,
        p.z,
        p.radius + SCOPE_PADDING_EXTRA,
      );
      if (!inScope) {
        node.root.visible = false;
        continue;
      }
      const objectTier = lodGrid.resolve(p.x, p.y, p.z);
      node.root.visible =
        OBJECT_TIER_RANK[objectTier] >= OBJECT_TIER_RANK[p.minTier];
      node.root.userData.objectLodTier = objectTier;
    }
  }

  destroy(): void {
    this.destroyed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const node of this.nodes)
      collectDisposableResources(node.root, geometries, materials);
    for (const asset of this.assets.values()) {
      collectDisposableResources(asset.template, geometries, materials);
    }
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const material of this.materialCache.values()) material.dispose();
    this.materialCache.clear();
    this.nodes.length = 0;
    this.assets.clear();
    this.root.clear();
    this.root.parent?.remove(this.root);
  }

  private async loadAssets(): Promise<void> {
    try {
      const loadedAssets = await Promise.all(
        ACTIVE_ENVIRONMENT_ASSETS.map(async (spec) => this.loadAsset(spec)),
      );
      if (this.destroyed) {
        const geometries = new Set<THREE.BufferGeometry>();
        const materials = new Set<THREE.Material>();
        for (const asset of loadedAssets)
          collectDisposableResources(asset.template, geometries, materials);
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) material.dispose();
        return;
      }
      for (const asset of loadedAssets) this.assets.set(asset.spec.id, asset);
      this.buildNodes();
      this.loaded = true;
      this.lastScopeVersion = -1;
      this.lastLodKey = '';
    } catch (error) {
      console.warn('Failed to load environment asset pack props', error);
    }
  }

  private async loadAsset(
    spec: EnvironmentAssetSpec,
  ): Promise<LoadedEnvironmentAsset> {
    const loaderObject =
      spec.format === 'fbx'
        ? await this.loadFbx(publicAssetUrl(spec.path))
        : await this.loadObj(spec);
    return this.normalizeAsset(spec, loaderObject);
  }

  private async loadObj(spec: EnvironmentAssetSpec): Promise<THREE.Group> {
    const loader = new OBJLoader();
    if (spec.materialPath) {
      const materials = await this.loadMtl(spec.materialPath);
      loader.setMaterials(materials);
    }
    return loadObj(loader, publicAssetUrl(spec.path));
  }

  private async loadFbx(url: string): Promise<THREE.Group> {
    const loader = new FBXLoader();
    return loadFbx(loader, url);
  }

  private loadMtl(path: string): Promise<MTLLoader.MaterialCreator> {
    let promise = this.mtlCache.get(path);
    if (!promise) {
      const loader = new MTLLoader();
      promise = loadMtl(loader, publicAssetUrl(path)).then((materials) => {
        materials.preload();
        return materials;
      });
      this.mtlCache.set(path, promise);
    }
    return promise;
  }

  private normalizeAsset(
    spec: EnvironmentAssetSpec,
    source: THREE.Group,
  ): LoadedEnvironmentAsset {
    source.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (geometry && !geometry.getAttribute('normal'))
        geometry.computeVertexNormals();
      mesh.material = this.materialForAsset(spec, mesh.material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    });
    source.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(source);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const unitHeight = Math.max(0.001, size.y);
    const template = new THREE.Group();
    template.name = `environment-template-${spec.id}`;
    source.position.x -= center.x;
    source.position.y -= box.min.y;
    source.position.z -= center.z;
    template.add(source);
    return {
      spec,
      template,
      unitHeight,
    };
  }

  private materialForAsset(
    spec: EnvironmentAssetSpec,
    source: THREE.Material | THREE.Material[],
  ): THREE.Material | THREE.Material[] {
    if (Array.isArray(source)) {
      return source.map(
        (mat) => this.materialForAsset(spec, mat) as THREE.Material,
      );
    }
    if (spec.palette === 'modular') {
      tuneLoadedMaterial(source);
      return source;
    }
    const sourceName = source.name.toLowerCase();
    if (spec.palette === 'lowTree') {
      return sourceName.includes('mat_01')
        ? this.sharedMaterial('lowTree.trunk', 0x5f4b34)
        : this.sharedMaterial('lowTree.leaves', 0x496f31);
    }
    if (spec.palette === 'lowGrass') {
      return sourceName.includes('mat_01')
        ? this.sharedMaterial('lowGrass.dark', 0x3a6a2d)
        : this.sharedMaterial('lowGrass.light', 0x6c8f3f);
    }
    if (spec.palette === 'forestTree') {
      return sourceName.includes('leaf')
        ? this.sharedMaterial('forestTree.leaves', 0x416f35)
        : this.sharedMaterial('forestTree.trunk', 0x5b4230);
    }
    if (spec.palette === 'forestDeadTree') {
      return sourceName.includes('leaf')
        ? this.sharedMaterial('forestDeadTree.needles', 0x475341)
        : this.sharedMaterial('forestDeadTree.trunk', 0x645845);
    }
    if (spec.palette === 'devilsTree') {
      return sourceName.includes('bark')
        ? this.sharedMaterial('devilsTree.bark', 0x5a4631)
        : this.sharedMaterial('devilsTree.leaves', 0x3f6f34);
    }
    if (spec.palette === 'simpleTree') {
      return sourceName.includes('wood') ||
        sourceName.includes('bark') ||
        sourceName.includes('trunk')
        ? this.sharedMaterial('simpleTree.wood', 0x6a4c2f)
        : this.sharedMaterial('simpleTree.leaves', 0x49723a);
    }
    if (spec.palette === 'simpleGrass')
      return this.sharedMaterial('simpleGrass.green', 0x5e8538);
    if (spec.palette === 'freeGrass')
      return this.sharedMaterial('freeGrass.green', 0x608b39);
    return source;
  }

  private sharedMaterial(
    key: string,
    color: number,
  ): THREE.MeshLambertMaterial {
    let material = this.materialCache.get(key);
    if (!material) {
      material = new THREE.MeshLambertMaterial({
        color,
        flatShading: true,
      });
      material.name = key;
      this.materialCache.set(key, material);
    }
    return material;
  }

  private buildNodes(): void {
    for (const placement of this.placements) {
      if (!isRandomEnvironmentAssetUsable(placement.assetId)) continue;
      const asset = this.assets.get(placement.assetId);
      if (!asset) continue;
      const root = asset.template.clone(true);
      root.name = `environment-prop-${placement.assetId}`;
      const scale = placement.height / asset.unitHeight;
      root.position.set(placement.x, placement.y, placement.z);
      root.rotation.y = placement.rotation;
      root.scale.setScalar(scale);
      root.userData.environmentProp = true;
      root.userData.assetId = placement.assetId;
      root.userData.objectLodTier = placement.minTier;
      this.root.add(root);
      this.nodes.push({ placement, root });
    }
  }

  private generatePlacements(): EnvironmentPlacement[] {
    const placements: EnvironmentPlacement[] = [];
    const seed = hashSeed(
      this.mapWidth,
      this.mapHeight,
      this.playerCount,
      this.metalDeposits.length,
    );
    const rng = mulberry32(seed);
    this.addTreeGroves(placements, rng);
    this.addGrassMeadows(placements, rng);
    return placements;
  }

  private addTreeGroves(
    placements: EnvironmentPlacement[],
    rng: () => number,
  ): void {
    if (TREE_ASSET_OPTIONS.length === 0) return;
    const areaScale = this.areaScale();
    const groveCount = clampInt(Math.round(7 * Math.sqrt(areaScale)), 4, 12);
    for (let g = 0; g < groveCount; g++) {
      const center = this.findLandPoint(rng, 180, 1400);
      if (!center) continue;
      const groveRadius = randRange(rng, 340, 820) * Math.sqrt(areaScale);
      const treeCount = clampInt(
        Math.round(randRange(rng, 9, 18) * Math.sqrt(areaScale)),
        7,
        26,
      );
      const grassCount = clampInt(
        Math.round(randRange(rng, 34, 70) * Math.sqrt(areaScale)),
        22,
        96,
      );
      for (let i = 0; i < treeCount; i++) {
        const p = scatterAround(center.x, center.z, groveRadius, rng);
        const assetId = chooseWeightedEnvironmentAssetIdOrNull(
          TREE_ASSET_OPTIONS,
          rng,
        );
        if (!assetId) continue;
        const spec = ASSET_BY_ID.get(assetId);
        if (!spec) continue;
        this.tryAddPlacement(placements, assetId, p.x, p.z, rng, {
          height: spec.defaultHeight * randRange(rng, 0.78, 1.22),
          radius: spec.defaultRadius * randRange(rng, 0.85, 1.2),
          rotation: rng() * Math.PI * 2,
          waterBuffer: DEFAULT_TREE_WATER_BUFFER,
        });
      }
      this.addGrassPatch(
        placements,
        rng,
        center.x,
        center.z,
        groveRadius * 1.1,
        grassCount,
      );
    }
  }

  private addGrassMeadows(
    placements: EnvironmentPlacement[],
    rng: () => number,
  ): void {
    if (GRASS_ASSET_OPTIONS.length === 0) return;
    const areaScale = this.areaScale();
    const meadowCount = clampInt(Math.round(9 * Math.sqrt(areaScale)), 5, 16);
    for (let i = 0; i < meadowCount; i++) {
      const center = this.findLandPoint(rng, 120, 1400);
      if (!center) continue;
      const radius = randRange(rng, 240, 680) * Math.sqrt(areaScale);
      const count = clampInt(
        Math.round(randRange(rng, 28, 64) * Math.sqrt(areaScale)),
        20,
        88,
      );
      this.addGrassPatch(placements, rng, center.x, center.z, radius, count);
    }
  }

  private addGrassPatch(
    placements: EnvironmentPlacement[],
    rng: () => number,
    x: number,
    z: number,
    radius: number,
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const p = scatterAround(x, z, radius, rng);
      const assetId = chooseWeightedEnvironmentAssetIdOrNull(
        GRASS_ASSET_OPTIONS,
        rng,
      );
      if (!assetId) continue;
      const spec = ASSET_BY_ID.get(assetId);
      if (!spec) continue;
      this.tryAddPlacement(placements, assetId, p.x, p.z, rng, {
        height: spec.defaultHeight * randRange(rng, 0.55, 1.35),
        radius: spec.defaultRadius * randRange(rng, 0.65, 1.25),
        rotation: rng() * Math.PI * 2,
        minTier: 'mass',
        waterBuffer: DEFAULT_GRASS_WATER_BUFFER,
      });
    }
  }

  private tryAddPlacement(
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
    const jitteredScale =
      assetScale * getRandomEnvironmentAssetScaleJitter(rng);
    const height = (options.height ?? spec.defaultHeight) * jitteredScale;
    const radius = (options.radius ?? spec.defaultRadius) * jitteredScale;
    if (!this.canPlaceAt(x, z, radius, options)) return false;
    const y = this.sampleTerrainHeight(x, z);
    if (!Number.isFinite(y) || y < WATER_LEVEL) return false;
    placements.push({
      assetId,
      x,
      z,
      y,
      rotation: options.rotation ?? 0,
      height,
      radius,
      minTier: options.minTier ?? spec.minTier,
    });
    return true;
  }

  private canPlaceAt(
    x: number,
    z: number,
    radius: number,
    options: PlacementOptions,
  ): boolean {
    const edge = Math.max(EDGE_CLEARANCE, radius);
    if (
      x < edge ||
      z < edge ||
      x > this.mapWidth - edge ||
      z > this.mapHeight - edge
    )
      return false;
    if (isWaterAt(x, z, this.mapWidth, this.mapHeight, LAND_CELL_SIZE))
      return false;
    const waterBuffer = options.waterBuffer ?? DEFAULT_GRASS_WATER_BUFFER;
    if (
      waterBuffer > 0 &&
      !isFarFromWater(x, z, this.mapWidth, this.mapHeight, waterBuffer)
    )
      return false;
    if (!this.isClearOfMetalDeposits(x, z, radius)) return false;
    if (!this.isClearOfPlayerStarts(x, z, radius)) return false;
    return true;
  }

  private isClearOfMetalDeposits(
    x: number,
    z: number,
    radius: number,
  ): boolean {
    for (const deposit of this.metalDeposits) {
      const clearance =
        deposit.flatPadRadius + METAL_DEPOSIT_CLEARANCE + radius;
      const dx = x - deposit.x;
      const dz = z - deposit.y;
      if (dx * dx + dz * dz < clearance * clearance) return false;
    }
    return true;
  }

  private isClearOfPlayerStarts(x: number, z: number, radius: number): boolean {
    const clearance =
      Math.max(850, Math.min(this.mapWidth, this.mapHeight) * 0.075) + radius;
    for (let seat = 0; seat < this.playerCount; seat++) {
      const spawn = getSpawnPositionForSeat(
        seat,
        this.playerCount,
        this.mapWidth,
        this.mapHeight,
      );
      const dx = x - spawn.x;
      const dz = z - spawn.y;
      if (dx * dx + dz * dz < clearance * clearance) return false;
    }
    return true;
  }

  private findLandPoint(
    rng: () => number,
    radius: number,
    maxAttempts: number,
  ): { x: number; z: number } | null {
    const centerX = this.mapWidth * 0.5;
    const centerZ = this.mapHeight * 0.5;
    const rx = this.mapWidth * 0.42;
    const rz = this.mapHeight * 0.42;
    for (let i = 0; i < maxAttempts; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * 0.96;
      const x = centerX + Math.cos(a) * rx * r;
      const z = centerZ + Math.sin(a) * rz * r;
      if (
        this.canPlaceAt(x, z, radius, {
          waterBuffer: DEFAULT_TREE_WATER_BUFFER,
        })
      ) {
        return { x, z };
      }
    }
    return null;
  }

  private areaScale(): number {
    const defaultArea = 10600 * 10600;
    return clamp((this.mapWidth * this.mapHeight) / defaultArea, 0.35, 2.4);
  }
}

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

function publicAssetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const encodedPath = path
    .replace(/^\/+/, '')
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${normalizedBase}${encodedPath}`;
}

function loadMtl(
  loader: MTLLoader,
  url: string,
): Promise<MTLLoader.MaterialCreator> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

function loadObj(loader: OBJLoader, url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, reject);
  });
}

function loadFbx(loader: FBXLoader, url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    const fileLoader = new THREE.FileLoader(loader.manager);
    fileLoader.setResponseType('arraybuffer');
    fileLoader.load(
      url,
      (buffer) => {
        try {
          const basePath = url.slice(0, url.lastIndexOf('/') + 1);
          const group = suppressKnownFbxMaterialWarning(() =>
            loader.parse(buffer as ArrayBuffer, basePath),
          );
          resolve(group);
        } catch (error) {
          reject(error);
        }
      },
      undefined,
      reject,
    );
  });
}

function suppressKnownFbxMaterialWarning<T>(load: () => T): T {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (isKnownFbxUnknownMaterialWarning(args)) return;
    originalWarn(...args);
  };
  try {
    return load();
  } finally {
    console.warn = originalWarn;
  }
}

function installKnownFbxMaterialWarningFilter(): void {
  const filteredConsole = console as ConsoleWithFbxWarningFilter;
  if (filteredConsole[FBX_UNKNOWN_MATERIAL_WARNING_FILTER_KEY]) return;
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (isKnownFbxUnknownMaterialWarning(args)) return;
    originalWarn(...args);
  };
  filteredConsole[FBX_UNKNOWN_MATERIAL_WARNING_FILTER_KEY] = true;
}

function isKnownFbxUnknownMaterialWarning(args: readonly unknown[]): boolean {
  const message = args[0];
  const materialType = args[1];
  if (typeof message !== 'string') return false;
  if (!message.includes('THREE.FBXLoader: unknown material type')) return false;
  if (message.toLowerCase().includes('"unknown"')) return true;
  return (
    typeof materialType === 'string' && materialType.toLowerCase() === 'unknown'
  );
}

function tuneLoadedMaterial(material: THREE.Material): void {
  const mat = material as THREE.Material & {
    flatShading?: boolean;
    shininess?: number;
    specular?: THREE.Color;
  };
  mat.side = THREE.FrontSide;
  if ('flatShading' in mat) mat.flatShading = true;
  if ('shininess' in mat) mat.shininess = 0;
  if (mat.specular instanceof THREE.Color) mat.specular.setScalar(0.08);
  mat.needsUpdate = true;
}

function collectDisposableResources(
  root: THREE.Object3D,
  geometries: Set<THREE.BufferGeometry>,
  materials: Set<THREE.Material>,
): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (geometry) geometries.add(geometry);
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const mat of material) materials.add(mat);
    } else if (material) {
      materials.add(material);
    }
  });
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

function scatterAround(
  x: number,
  z: number,
  radius: number,
  rng: () => number,
): { x: number; z: number } {
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * radius;
  return {
    x: x + Math.cos(a) * r,
    z: z + Math.sin(a) * r,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
