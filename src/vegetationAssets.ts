// Vegetation asset table — shared by the simulation and the renderer.
//
// A prop's model dimensions stopped being purely cosmetic when trees,
// grass, and seaweed became reclaimable energy deposits: `defaultHeight`
// and `defaultRadius` feed the deterministic placement kernel and become
// the prop's selection volume, so both the sim and the renderer must
// read one table. Paths, materials, and palette tags stay here too so
// there is a single place to add or retune a vegetation model.
//
// SLOT ORDER IS A CONTRACT. `getVegetationAssetOptions(kind)` returns
// the enabled assets for a kind in declaration order, and the Rust
// placement kernel stores each prop's pick as an index into that list.
// Reordering or toggling an asset changes the generated layout — which
// is fine at authoring time, but every peer must be running the same
// table, exactly like any other simulation config.

import { VEGETATION_KIND_IDS, type VegetationKindId } from './vegetationConfig';

export type VegetationAssetFormat = 'obj' | 'fbx';

/** Material treatment applied to a loaded model. Seaweed intentionally
 *  uses the same `modular` treatment as grass: placement and proportions
 *  distinguish the simulation kinds, while both remain one coherent
 *  blade-vegetation family in the renderer. */
export type VegetationPalette =
  | 'modular'
  | 'lowTree'
  | 'forestTree';

export type VegetationAssetSpec = {
  id: string;
  kind: VegetationKindId;
  format: VegetationAssetFormat;
  path: string;
  materialPath?: string;
  /** Authored model height in world units before scaling. */
  defaultHeight: number;
  /** Authored model footprint radius in world units before scaling. */
  defaultRadius: number;
  palette: VegetationPalette;
  /** Placement toggle. Disabled assets are absent from the slot list. */
  use: boolean;
  /** Direct multiplier on this asset's world size. */
  scale: number;
  /** Relative pick weight among enabled assets of the same kind. */
  frequency: number;
};

const ASSET_ROOT = 'assets/environment-packs';
const MODULAR_ROOT = ASSET_ROOT + '/modular-terrain-collection';
const FOREST_ROOT = ASSET_ROOT + '/lowpoly-forest-pack';
const FOLIAGE_OBJ_ROOT = ASSET_ROOT + '/low-poly-foliage-pack-001/OBJ Files';
const MODULAR_MTL = MODULAR_ROOT + '/Materials_Modular_Terrain.mtl';

/** Applied after each asset's own scale. */
export const VEGETATION_ASSET_GLOBAL_SCALE = 2.2;
/** Seaweed keeps one uniform 70% size multiplier across every frond so
 *  presentation and its simulation selection/reclaim volume stay aligned. */
export const SEAWEED_ASSET_SCALE = 0.07;

const VEGETATION_ASSETS: readonly VegetationAssetSpec[] = [
  {
    id: 'lowTree4',
    kind: 'tree',
    format: 'obj',
    path: `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_004.obj`,
    materialPath: `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_004.mtl`,
    defaultHeight: 330,
    defaultRadius: 95,
    palette: 'lowTree',
    use: true,
    scale: 0.1,
    frequency: 1,
  },
  {
    id: 'lowTree5',
    kind: 'tree',
    format: 'obj',
    path: `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_005.obj`,
    materialPath: `${FOLIAGE_OBJ_ROOT}/Low_Poly_Tree_005.mtl`,
    defaultHeight: 390,
    defaultRadius: 95,
    palette: 'lowTree',
    use: true,
    scale: 0.1,
    frequency: 1,
  },
  {
    id: 'forestSpruce2',
    kind: 'tree',
    format: 'fbx',
    path: `${FOREST_ROOT}/Trees/SpruceTree2.fbx`,
    defaultHeight: 340,
    defaultRadius: 135,
    palette: 'forestTree',
    use: true,
    scale: 0.15,
    frequency: 1,
  },

  {
    id: 'modGrass1',
    kind: 'grass',
    format: 'obj',
    path: `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_1.obj`,
    materialPath: MODULAR_MTL,
    defaultHeight: 42,
    defaultRadius: 42,
    palette: 'modular',
    use: true,
    scale: 0.1,
    frequency: 1,
  },
  {
    id: 'modGrass2',
    kind: 'grass',
    format: 'obj',
    path: `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_2.obj`,
    materialPath: MODULAR_MTL,
    defaultHeight: 48,
    defaultRadius: 45,
    palette: 'modular',
    use: true,
    scale: 0.1,
    frequency: 1,
  },
  {
    id: 'modGrass3',
    kind: 'grass',
    format: 'obj',
    path: `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_3.obj`,
    materialPath: MODULAR_MTL,
    defaultHeight: 56,
    defaultRadius: 48,
    palette: 'modular',
    use: true,
    scale: 0.1,
    frequency: 1,
  },
  {
    id: 'modGrass4',
    kind: 'grass',
    format: 'obj',
    path: `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_4.obj`,
    materialPath: MODULAR_MTL,
    defaultHeight: 52,
    defaultRadius: 48,
    palette: 'modular',
    use: true,
    scale: 0.1,
    frequency: 1,
  },

  // Seaweed reuses the grass clump geometry and grass palette at a taller,
  // narrower profile, uniformly reduced to 70% of its previous world size.
  // Waterline placement and frond proportions sell "shore growth" without
  // inventing a second color language for the same blade geometry.
  {
    id: 'seaweedFrond1',
    kind: 'seaweed',
    format: 'obj',
    path: `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_1.obj`,
    materialPath: MODULAR_MTL,
    defaultHeight: 126,
    defaultRadius: 34,
    palette: 'modular',
    use: true,
    scale: SEAWEED_ASSET_SCALE,
    frequency: 1,
  },
  {
    id: 'seaweedFrond3',
    kind: 'seaweed',
    format: 'obj',
    path: `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_3.obj`,
    materialPath: MODULAR_MTL,
    defaultHeight: 168,
    defaultRadius: 38,
    palette: 'modular',
    use: true,
    scale: SEAWEED_ASSET_SCALE,
    frequency: 1,
  },
  {
    id: 'seaweedFrond4',
    kind: 'seaweed',
    format: 'obj',
    path: `${MODULAR_ROOT}/Hilly_Prop_Grass_Clump_4.obj`,
    materialPath: MODULAR_MTL,
    defaultHeight: 148,
    defaultRadius: 40,
    palette: 'modular',
    use: true,
    scale: SEAWEED_ASSET_SCALE,
    frequency: 1,
  },
];

function isUsableVegetationAsset(spec: VegetationAssetSpec): boolean {
  return (
    spec.use &&
    Number.isFinite(spec.scale) &&
    spec.scale > 0 &&
    Number.isFinite(spec.frequency) &&
    spec.frequency > 0 &&
    spec.defaultHeight > 0 &&
    spec.defaultRadius > 0
  );
}

const OPTIONS_BY_KIND = new Map<VegetationKindId, readonly VegetationAssetSpec[]>();
for (const kind of VEGETATION_KIND_IDS) {
  OPTIONS_BY_KIND.set(
    kind,
    Object.freeze(
      VEGETATION_ASSETS.filter((spec) => spec.kind === kind && isUsableVegetationAsset(spec)),
    ),
  );
}

/** Every enabled asset, across kinds, in declaration order. The renderer
 *  loads exactly this set. */
export const ACTIVE_VEGETATION_ASSETS: readonly VegetationAssetSpec[] = Object.freeze(
  VEGETATION_ASSETS.filter(isUsableVegetationAsset),
);

/** The kind's enabled assets. Index into this list is the `assetSlot`
 *  the placement kernel stores per prop. */
export function getVegetationAssetOptions(
  kind: VegetationKindId,
): readonly VegetationAssetSpec[] {
  return OPTIONS_BY_KIND.get(kind) ?? [];
}

export function getVegetationAssetSpec(
  kind: VegetationKindId,
  assetSlot: number,
): VegetationAssetSpec | undefined {
  return getVegetationAssetOptions(kind)[assetSlot];
}

/** Resolved world-size multiplier for one asset, before per-prop jitter
 *  (which the placement kernel applies). */
export function vegetationAssetScale(spec: VegetationAssetSpec): number {
  return spec.scale * VEGETATION_ASSET_GLOBAL_SCALE;
}

export function isWoodVegetationMaterial(
  spec: VegetationAssetSpec,
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

let loggedActiveVegetationAssets = false;

export function logActiveVegetationAssets(): void {
  if (!import.meta.env.DEV || loggedActiveVegetationAssets) return;
  loggedActiveVegetationAssets = true;
  const ids = ACTIVE_VEGETATION_ASSETS.map((spec) => `${spec.kind}:${spec.id}`);
  console.info(
    '[vegetation] enabled assets (' + ids.length + '): ' +
      (ids.length > 0 ? ids.join(', ') : 'none'),
  );
}
