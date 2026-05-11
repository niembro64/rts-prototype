import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import type { GraphicsConfig, RenderObjectLodTier } from '@/types/graphics';
import { FOREST_SPRUCE2_LEAF_COLOR, FOREST_SPRUCE2_WOOD_COLOR } from '../../config';
import { getTreeLeafTexture } from './TreeLeafTexture';
import { getTreeTrunkTexture } from './TreeTrunkTexture';
import type { MetalDeposit } from '../../metalDepositConfig';
import { ViewportFootprint } from '../ViewportFootprint';
import type { Lod3DState } from './Lod3D';
import { RenderLodGrid } from './RenderLodGrid';
import {
  ACTIVE_ENVIRONMENT_ASSETS,
  type EnvironmentAssetSpec,
  isRandomEnvironmentAssetUsable,
  isWoodMaterialForAsset,
  logActiveEnvironmentAssets,
} from './environmentPropAssets';
import {
  SCOPE_PADDING_EXTRA,
  generateEnvironmentPlacements,
  type EnvironmentPlacement,
} from './environmentPropPlacement';

type EnvironmentPropNode = {
  placement: EnvironmentPlacement;
  root: THREE.Group;
};

type LoadedEnvironmentAsset = {
  spec: EnvironmentAssetSpec;
  template: THREE.Group;
  unitHeight: number;
};

export type EnvironmentPropRenderer3DOptions = {
  mapWidth: number;
  mapHeight: number;
  playerCount: number;
  metalDeposits: ReadonlyArray<MetalDeposit>;
  renderScope: ViewportFootprint;
  sampleTerrainHeight: (x: number, z: number) => number;
};

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

export class EnvironmentPropRenderer3D {
  private readonly root = new THREE.Group();
  private readonly renderScope: ViewportFootprint;
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
    this.renderScope = options.renderScope;
    this.root.name = 'EnvironmentPropRenderer3D';
    parentWorld.add(this.root);
    logActiveEnvironmentAssets();
    this.placements = generateEnvironmentPlacements({
      mapWidth: options.mapWidth,
      mapHeight: options.mapHeight,
      playerCount: options.playerCount,
      metalDeposits: options.metalDeposits,
      sampleTerrainHeight: options.sampleTerrainHeight,
    });
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
    const sourceName = source.name.toLowerCase();
    const selectedMaterial = this.materialForSelectedRandomAsset(
      spec,
      sourceName,
    );
    if (selectedMaterial) return selectedMaterial;
    if (spec.palette === 'modular') {
      tuneLoadedMaterial(source);
      return source;
    }
    if (spec.palette === 'lowTree') {
      return sourceName.includes('mat_01')
        ? this.sharedMaterial('lowTree.trunk', 0x5f4b34)
        : this.sharedMaterial('lowTree.leaves', 0x496f31);
    }
    if (spec.palette === 'forestTree') {
      return sourceName.includes('leaf')
        ? this.sharedMaterial('forestTree.leaves', 0x416f35)
        : this.sharedMaterial('forestTree.trunk', 0x5b4230);
    }
    return source;
  }

  private materialForSelectedRandomAsset(
    spec: EnvironmentAssetSpec,
    sourceName: string,
  ): THREE.MeshLambertMaterial | null {
    if (!isRandomEnvironmentAssetUsable(spec.id)) return null;
    if (spec.kind === 'grass') {
      // Grass props deliberately keep the plain leaf-color material with no
      // texture map. The user-facing distinction: grass clumps blend into
      // the ground green carpet uniformly, while tree foliage carries the
      // tree-leaf texture's per-fragment color variation.
      return this.sharedMaterial(
        'randomEnvironment.forestSpruce2.grass-leaves',
        FOREST_SPRUCE2_LEAF_COLOR,
      );
    }
    const isWood = isWoodMaterialForAsset(spec, sourceName);
    if (isWood) {
      return this.sharedMaterial(
        'randomEnvironment.forestSpruce2.tree-trunk',
        FOREST_SPRUCE2_WOOD_COLOR,
        getTreeTrunkTexture(),
      );
    }
    return this.sharedMaterial(
      'randomEnvironment.forestSpruce2.tree-leaves',
      FOREST_SPRUCE2_LEAF_COLOR,
      getTreeLeafTexture(),
    );
  }

  private sharedMaterial(
    key: string,
    color: number,
    map?: THREE.Texture,
  ): THREE.MeshLambertMaterial {
    let material = this.materialCache.get(key);
    if (!material) {
      // When a texture map is supplied, the canvas was pre-filled with the
      // exact same hex color, so the map carries the prop's overall hue and
      // the material's color stays white to avoid double-multiplying.
      material = new THREE.MeshLambertMaterial({
        color: map ? 0xffffff : color,
        map: map ?? null,
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
