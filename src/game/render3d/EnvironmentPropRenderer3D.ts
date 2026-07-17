import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { COLORS } from '@/colorsConfig';
import { FOREST_SPRUCE2_LEAF_COLOR, FOREST_SPRUCE2_WOOD_COLOR } from '../../config';
import { getTreeLeafTexture } from './TreeLeafTexture';
import { getTreeTrunkTexture } from './TreeTrunkTexture';
import type { MetalDeposit } from '../../metalDepositConfig';
import { ViewportFootprint } from '../ViewportFootprint';
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
import {
  detailLevelForViewPosition,
  geometryTierForDetail,
} from './EntityDetailLevel3D';
import type { RenderViewState3D } from './RenderFrameState3D';
import type { FogOfWarShade3D } from './FogOfWarShade3D';
import {
  getSharedExtrudedEquilateralTriangleGeometry,
  getSharedPrimitiveTetrahedronGeometry,
  createPrimitiveConeGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

type EnvironmentPropNode = {
  placement: EnvironmentPlacement;
  root: THREE.Group;
  lods: Record<PrimitiveGeometryTier, THREE.Group>;
};

type LoadedEnvironmentAsset = {
  spec: EnvironmentAssetSpec;
  templates: Record<PrimitiveGeometryTier, THREE.Group>;
  unitHeight: number;
};

export type EnvironmentLodFlatColorRole = 'wood' | 'foliage';

/** Medium/Low environment geometry deliberately drops texture maps, but its
 *  base hues must remain identical to the canonical textured High assets. */
export function environmentLodFlatMaterialSpec(
  role: EnvironmentLodFlatColorRole,
): Readonly<{ key: string; color: number; map: null }> {
  return role === 'wood'
    ? {
        key: 'environmentLod.flat.wood',
        color: FOREST_SPRUCE2_WOOD_COLOR,
        map: null,
      }
    : {
        key: 'environmentLod.flat.foliage',
        color: FOREST_SPRUCE2_LEAF_COLOR,
        map: null,
      };
}

type EnvironmentPropRenderer3DOptions = {
  mapWidth: number;
  mapHeight: number;
  playerCount: number;
  metalDeposits: ReadonlyArray<MetalDeposit>;
  renderScope: ViewportFootprint;
  fogOfWarShade: FogOfWarShade3D;
  sampleTerrainHeight: (x: number, z: number) => number;
};

const FBX_UNKNOWN_MATERIAL_WARNING_FILTER_KEY =
  '__rtsFbxUnknownMaterialWarningFilterInstalled' as const;

type ConsoleWithFbxWarningFilter = Console & {
  [FBX_UNKNOWN_MATERIAL_WARNING_FILTER_KEY]?: boolean;
};

installKnownFbxMaterialWarningFilter();

export class EnvironmentPropRenderer3D {
  private readonly root = new THREE.Group();
  private readonly renderScope: ViewportFootprint;
  private readonly fogOfWarShade: FogOfWarShade3D;
  private readonly placements: EnvironmentPlacement[];
  private readonly nodes: EnvironmentPropNode[] = [];
  private readonly materialCache = new Map<string, THREE.MeshLambertMaterial>();
  private readonly mtlCache = new Map<
    string,
    Promise<MTLLoader.MaterialCreator>
  >();
  private readonly assets = new Map<string, LoadedEnvironmentAsset>();
  private destroyed = false;
  private ready = false;
  private loaded = false;
  private lastScopeVersion = -1;
  private lastViewKey = '';

  constructor(
    parentWorld: THREE.Group,
    options: EnvironmentPropRenderer3DOptions,
  ) {
    this.renderScope = options.renderScope;
    this.fogOfWarShade = options.fogOfWarShade;
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
    logEnvironmentPlacementCounts(this.placements, options);
    void this.loadAssets();
  }

  isReady(): boolean {
    return this.ready || this.destroyed;
  }

  update(view?: RenderViewState3D): void {
    if (!this.loaded || this.nodes.length === 0) return;
    const scopeVersion = this.renderScope.getVersion();
    const viewKey = view
      ? `${view.cameraX}|${view.cameraY}|${view.cameraZ}|${view.fovYRad}|${view.viewportHeightPx}`
      : 'close';
    if (scopeVersion === this.lastScopeVersion && viewKey === this.lastViewKey) return;
    this.lastScopeVersion = scopeVersion;
    this.lastViewKey = viewKey;
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
      node.root.visible = true;
      const tier = view
        ? geometryTierForDetail(detailLevelForViewPosition(
            view,
            p.x,
            p.z,
            p.y + p.height * 0.5,
            Math.max(p.radius, p.height * 0.5),
          ))
        : 'close';
      node.lods.close.visible = tier === 'close';
      node.lods.mid.visible = tier === 'mid';
      node.lods.far.visible = tier === 'far';
    }
  }

  destroy(): void {
    this.destroyed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const node of this.nodes)
      collectDisposableResources(node.root, geometries, materials);
    for (const asset of this.assets.values()) {
      for (const template of Object.values(asset.templates)) {
        collectDisposableResources(template, geometries, materials);
      }
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
      const loadPromises = new Array<Promise<LoadedEnvironmentAsset>>(ACTIVE_ENVIRONMENT_ASSETS.length);
      for (let i = 0; i < ACTIVE_ENVIRONMENT_ASSETS.length; i++) {
        loadPromises[i] = this.loadAsset(ACTIVE_ENVIRONMENT_ASSETS[i]);
      }
      const loadedAssets = await Promise.all(loadPromises);
      if (this.destroyed) {
        const geometries = new Set<THREE.BufferGeometry>();
        const materials = new Set<THREE.Material>();
        for (const asset of loadedAssets) {
          for (const template of Object.values(asset.templates)) {
            collectDisposableResources(template, geometries, materials);
          }
        }
        for (const geometry of geometries) geometry.dispose();
        for (const material of materials) material.dispose();
        return;
      }
      for (const asset of loadedAssets) this.assets.set(asset.spec.id, asset);
      this.buildNodes();
      this.loaded = true;
      this.lastScopeVersion = -1;
      this.lastViewKey = '';
    } catch (error) {
      console.warn('Failed to load environment asset pack props', error);
    } finally {
      this.ready = true;
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
      if (Array.isArray(mesh.material)) {
        for (const material of mesh.material) this.fogOfWarShade.patchMaterial(material);
      } else {
        this.fogOfWarShade.patchMaterial(mesh.material);
      }
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    });
    source.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(source);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const unitHeight = Math.max(0.001, size.y);
    const template = new THREE.Group();
    template.name = `environment-template-${spec.id}-close`;
    source.position.x -= center.x;
    source.position.y -= box.min.y;
    source.position.z -= center.z;
    template.add(source);
    const asset: LoadedEnvironmentAsset = {
      spec,
      templates: {
        close: template,
        mid: new THREE.Group(),
        far: new THREE.Group(),
      },
      unitHeight,
    };
    asset.templates.mid = this.makeEnvironmentLodTemplate(asset, 'mid');
    asset.templates.far = this.makeEnvironmentLodTemplate(asset, 'far');
    return asset;
  }

  private makeEnvironmentLodTemplate(
    asset: LoadedEnvironmentAsset,
    tier: 'mid' | 'far',
  ): THREE.Group {
    return asset.spec.kind === 'grass'
      ? this.makeGrassLodTemplate(asset, tier)
      : this.makeTreeLodTemplate(asset, tier);
  }

  private makeGrassLodTemplate(
    asset: LoadedEnvironmentAsset,
    tier: 'mid' | 'far',
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = `environment-template-${asset.spec.id}-${tier}`;
    const bladeCount = tier === 'far'
      ? 2
      : Math.max(10, Number(asset.spec.id.slice(-1)) * 2 + 8);
    const radius = asset.unitHeight
      * (asset.spec.defaultRadius / Math.max(1, asset.spec.defaultHeight));
    const positions: number[] = [];
    for (let i = 0; i < bladeCount; i++) {
      const angle = (i / bladeCount) * Math.PI;
      const radial = tier === 'far' ? 0 : radius * 0.48 * ((i % 3) / 2);
      const centerX = Math.cos(angle * 2.37) * radial;
      const centerZ = Math.sin(angle * 2.37) * radial;
      const halfWidth = radius * (tier === 'far' ? 0.46 : 0.2 + (i % 3) * 0.025);
      const height = asset.unitHeight * (tier === 'far' ? 0.9 : 0.7 + (i % 4) * 0.08);
      const dx = Math.cos(angle) * halfWidth;
      const dz = Math.sin(angle) * halfWidth;
      positions.push(
        centerX - dx, 0, centerZ - dz,
        centerX + dx, 0, centerZ + dz,
        centerX + dx * 0.22, height, centerZ + dz * 0.22,
        centerX - dx, 0, centerZ - dz,
        centerX + dx * 0.22, height, centerZ + dz * 0.22,
        centerX - dx * 0.22, height, centerZ - dz * 0.22,
      );
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const material = this.environmentLodFlatMaterial('foliage');
    material.side = THREE.DoubleSide;
    material.needsUpdate = true;
    this.fogOfWarShade.patchMaterial(material);
    group.add(new THREE.Mesh(geometry, material));
    return group;
  }

  private makeTreeLodTemplate(
    asset: LoadedEnvironmentAsset,
    tier: 'mid' | 'far',
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = `environment-template-${asset.spec.id}-${tier}`;
    const height = asset.unitHeight;
    const radius = height
      * (asset.spec.defaultRadius / Math.max(1, asset.spec.defaultHeight));
    // Every authored tree uses the same canonical wood/foliage palette at
    // High. Medium and Low keep those exact base colors but intentionally
    // omit the bark/leaf texture maps.
    const trunkMaterial = this.environmentLodFlatMaterial('wood');
    const leafMaterial = this.environmentLodFlatMaterial('foliage');
    this.fogOfWarShade.patchMaterial(trunkMaterial);
    this.fogOfWarShade.patchMaterial(leafMaterial);

    const trunkHeight = height * (asset.spec.palette === 'forestTree' ? 0.34 : 0.48);
    const trunkRadius = Math.max(radius * 0.09, height * 0.018);
    const trunkGeometry = tier === 'far'
      ? new THREE.PlaneGeometry(2, 2)
      : getSharedExtrudedEquilateralTriangleGeometry(1, 1).clone();
    const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
    if (tier === 'far') {
      trunk.scale.set(trunkRadius, trunkHeight * 0.5, 1);
      trunk.position.y = trunkHeight * 0.5;
    } else {
      trunk.scale.set(trunkRadius, trunkHeight, trunkRadius);
      trunk.position.y = trunkHeight * 0.5;
    }
    group.add(trunk);

    if (asset.spec.palette === 'forestTree') {
      const crownBottom = height * 0.18;
      const crownHeight = height * 0.82;
      const layerCount = tier === 'far' ? 1 : 3;
      for (let i = 0; i < layerCount; i++) {
        const layerT = layerCount === 1 ? 0.5 : i / (layerCount - 1);
        const layerHeight = tier === 'far' ? crownHeight : crownHeight * 0.48;
        const layerRadius = radius * (1 - layerT * 0.42);
        const geometry = createPrimitiveConeGeometry(
          'environment',
          tier,
          layerRadius,
          layerHeight,
        );
        const crown = new THREE.Mesh(geometry, leafMaterial);
        crown.position.y = crownBottom + layerHeight * 0.5 + layerT * crownHeight * 0.5;
        group.add(crown);
      }
    } else if (tier === 'far') {
      const crown = new THREE.Mesh(getSharedPrimitiveTetrahedronGeometry(1).clone(), leafMaterial);
      crown.scale.set(radius, height * 0.34, radius);
      crown.position.y = height * 0.7;
      group.add(crown);
    } else {
      for (const [x, y, z, scale] of [
        [-0.32, 0.69, 0, 0.72],
        [0.32, 0.7, 0.04, 0.72],
      ] as const) {
        const crown = new THREE.Mesh(new THREE.OctahedronGeometry(1), leafMaterial);
        crown.scale.set(radius * scale, height * 0.24, radius * scale);
        crown.position.set(radius * x, height * y, radius * z);
        group.add(crown);
      }
    }
    return group;
  }

  private materialForAsset(
    spec: EnvironmentAssetSpec,
    source: THREE.Material | THREE.Material[],
  ): THREE.Material | THREE.Material[] {
    if (Array.isArray(source)) {
      const materials = new Array<THREE.Material>(source.length);
      for (let i = 0; i < source.length; i++) {
        materials[i] = this.materialForAsset(spec, source[i]) as THREE.Material;
      }
      return materials;
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
        ? this.sharedMaterial('lowTree.trunk', COLORS.environment.lowTree.trunk.colorHex)
        : this.sharedMaterial('lowTree.leaves', COLORS.environment.lowTree.leaves.colorHex);
    }
    if (spec.palette === 'forestTree') {
      return sourceName.includes('leaf')
        ? this.sharedMaterial('forestTree.leaves', FOREST_SPRUCE2_LEAF_COLOR)
        : this.sharedMaterial('forestTree.trunk', FOREST_SPRUCE2_WOOD_COLOR);
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
        color: map ? COLORS.units.turret.barrel.colorHex : color,
        map: map ?? null,
        flatShading: true,
      });
      material.name = key;
      this.materialCache.set(key, material);
    }
    return material;
  }

  private environmentLodFlatMaterial(
    role: EnvironmentLodFlatColorRole,
  ): THREE.MeshLambertMaterial {
    const spec = environmentLodFlatMaterialSpec(role);
    return this.sharedMaterial(
      spec.key,
      spec.color,
      spec.map ?? undefined,
    );
  }

  private buildNodes(): void {
    for (const placement of this.placements) {
      if (!isRandomEnvironmentAssetUsable(placement.assetId)) continue;
      const asset = this.assets.get(placement.assetId);
      if (!asset) continue;
      const root = new THREE.Group();
      root.name = `environment-prop-${placement.assetId}`;
      const lods = {
        close: asset.templates.close.clone(true),
        mid: asset.templates.mid.clone(true),
        far: asset.templates.far.clone(true),
      };
      lods.close.visible = true;
      lods.mid.visible = false;
      lods.far.visible = false;
      root.add(lods.close, lods.mid, lods.far);
      const scale = placement.height / asset.unitHeight;
      root.position.set(placement.x, placement.y, placement.z);
      root.rotation.y = placement.rotation;
      root.scale.setScalar(scale);
      root.userData.environmentProp = true;
      root.userData.assetId = placement.assetId;
      this.root.add(root);
      this.nodes.push({ placement, root, lods });
    }
  }
}

function publicAssetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const parts = path.replace(/^\/+/, '').split('/');
  let encodedPath = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) encodedPath += '/';
    encodedPath += encodeURIComponent(parts[i]);
  }
  return `${normalizedBase}${encodedPath}`;
}

function logEnvironmentPlacementCounts(
  placements: readonly EnvironmentPlacement[],
  options: EnvironmentPropRenderer3DOptions,
): void {
  if (!import.meta.env.DEV) return;
  const counts = new Map<string, number>();
  for (const placement of placements) {
    counts.set(placement.assetId, (counts.get(placement.assetId) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([assetId, count]) => `${assetId}: ${count}`);
  console.info(
    '[EnvironmentPropRenderer3D] generated placements (' +
      placements.length +
      `, map ${options.mapWidth}x${options.mapHeight}, players ${options.playerCount}` +
      '): ' +
      (parts.length > 0 ? parts.join(', ') : 'none'),
  );
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
