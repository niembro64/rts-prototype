import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { COLORS } from '@/colorsConfig';
import { getLodMode } from '@/clientBarConfig';
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
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_GLYPH,
  DETAIL_RUNG_MID,
  type DetailRung,
  detailLevelForRung,
  detailRungForViewPosition,
  geometryTierForDetail,
} from './EntityDetailLevel3D';
import type { RenderViewState3D } from './RenderFrameState3D';
import type { WorldShade3D } from './WorldShade3D';
import {
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

type EnvironmentPropNode = {
  placement: EnvironmentPlacement;
  root: THREE.Group;
  lods: Record<PrimitiveGeometryTier, THREE.Group>;
  detailRung: DetailRung;
};

type LoadedEnvironmentAsset = {
  spec: EnvironmentAssetSpec;
  templates: Record<PrimitiveGeometryTier, THREE.Group>;
  unitHeight: number;
};

export type EnvironmentLodFlatColorRole = 'wood' | 'foliage';

type EnvironmentGrassLodTier = 'mid' | 'far';

type EnvironmentGrassBladeTriangle = {
  positions: readonly number[];
  direction: THREE.Vector3;
  length: number;
};

const ENVIRONMENT_TREE_MEDIUM_VERTEX_REMOVAL_RATIO = 0.35;

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

/** Vegetation has no strategic glyph: it stops drawing at the shared
 * OFF/GLYPH rung used by entities. */
export function environmentPropVisibleAtDetailRung(rung: DetailRung): boolean {
  return rung !== DETAIL_RUNG_GLYPH;
}

/** Builds one flat triangle in the authored direction of each High grass leaf.
 * Low retains two representative leaves from that same authored set. */
export function buildEnvironmentGrassLodGeometry(
  highTemplate: THREE.Object3D,
  tier: EnvironmentGrassLodTier,
): THREE.BufferGeometry {
  const authoredBlades = collectEnvironmentGrassBladeTriangles(highTemplate);
  const blades = tier === 'mid'
    ? authoredBlades
    : selectRepresentativeGrassBlades(authoredBlades, 2);
  const positions: number[] = [];
  for (let i = 0; i < blades.length; i++) {
    positions.push(...blades[i].positions);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Four-face LOW tree crown with an explicitly horizontal triangular base and
 * one centered apex. Width/depth/height are supplied from that tree's authored
 * foliage bounds, rather than reusing one generic tetrahedron scale. */
export function createEnvironmentLowTreeCrownGeometry(
  width: number,
  height: number,
  depth: number,
): THREE.BufferGeometry {
  const safeWidth = Math.max(0.001, width);
  const safeHeight = Math.max(0.001, height);
  const safeDepth = Math.max(0.001, depth);
  const halfWidth = safeWidth * 0.5;
  const frontZ = safeDepth * 0.5;
  const backZ = -safeDepth * 0.5;
  // An equilateral-style triangle's centroid is one third of the way from its
  // back edge to its front point. Keep the apex directly above that centroid,
  // while the footprint's bounding box remains centered on the canopy.
  const centerZ = -safeDepth / 6;
  const baseFront = [0, 0, frontZ] as const;
  const baseLeft = [-halfWidth, 0, backZ] as const;
  const baseRight = [halfWidth, 0, backZ] as const;
  const apex = [0, safeHeight, centerZ] as const;
  const positions = [
    // Horizontal base, wound downward.
    ...baseFront, ...baseLeft, ...baseRight,
    // Three upward-pointing sides, wound outward.
    ...baseFront, ...baseRight, ...apex,
    ...baseRight, ...baseLeft, ...apex,
    ...baseLeft, ...baseFront, ...apex,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

type EnvironmentPropRenderer3DOptions = {
  mapWidth: number;
  mapHeight: number;
  playerCount: number;
  metalDeposits: ReadonlyArray<MetalDeposit>;
  renderScope: ViewportFootprint;
  worldShade: WorldShade3D;
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
  private readonly worldShade: WorldShade3D;
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
    this.worldShade = options.worldShade;
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
    const lodMode = getLodMode();
    const viewKey = view
      ? `${lodMode}|${view.cameraX}|${view.cameraY}|${view.cameraZ}|${view.fovYRad}|${view.viewportHeightPx}`
      : `${lodMode}|close`;
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
      const rung = view
        ? detailRungForViewPosition(
            view,
            p.x,
            p.z,
            p.y + p.height * 0.5,
            Math.max(p.radius, p.height * 0.5),
            node.detailRung,
          )
        : lodMode === 'off'
          ? DETAIL_RUNG_GLYPH
          : lodMode === 'low'
            ? DETAIL_RUNG_FAR
            : lodMode === 'medium'
              ? DETAIL_RUNG_MID
              : DETAIL_RUNG_CLOSE;
      node.detailRung = rung;
      node.root.visible = environmentPropVisibleAtDetailRung(rung);
      if (!node.root.visible) continue;
      const tier = geometryTierForDetail(detailLevelForRung(rung));
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
        for (const material of mesh.material) this.worldShade.patchMaterial(material);
      } else {
        this.worldShade.patchMaterial(mesh.material);
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
    const geometry = buildEnvironmentGrassLodGeometry(asset.templates.close, tier);
    const material = this.environmentLodFlatMaterial('foliage');
    material.side = THREE.DoubleSide;
    material.needsUpdate = true;
    this.worldShade.patchMaterial(material);
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
    this.worldShade.patchMaterial(trunkMaterial);
    this.worldShade.patchMaterial(leafMaterial);

    // Medium and Low deliberately share one sturdy trunk silhouette. The
    // simplified authored High trunk became too spindly at Medium distance.
    this.addLowStyleTreeTrunk(group, asset, trunkMaterial);

    if (tier === 'mid') {
      this.addMediumTreeFoliage(
        group,
        asset.templates.close,
        leafMaterial,
      );
      return group;
    }

    this.addLowTreeCrown(
      group,
      asset.templates.close,
      leafMaterial,
      radius,
      height,
    );
    return group;
  }

  private addLowStyleTreeTrunk(
    group: THREE.Group,
    asset: LoadedEnvironmentAsset,
    trunkMaterial: THREE.Material,
  ): void {
    const height = asset.unitHeight;
    const radius = height
      * (asset.spec.defaultRadius / Math.max(1, asset.spec.defaultHeight));
    const trunkHeight = height * (asset.spec.palette === 'forestTree' ? 0.34 : 0.48);
    const trunkRadius = Math.max(radius * 0.09, height * 0.018);
    // A square prism preserves visible trunk volume from every view while
    // remaining suitably cheap for both reduced-detail tiers.
    const trunkGeometry = new THREE.BoxGeometry(2, 2, 2);
    const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
    trunk.scale.set(trunkRadius, trunkHeight * 0.5, trunkRadius);
    trunk.position.y = trunkHeight * 0.5;
    group.add(trunk);
  }

  private addMediumTreeFoliage(
    group: THREE.Group,
    highTemplate: THREE.Object3D,
    leafMaterial: THREE.Material,
  ): void {
    const positions = collectEnvironmentTreeTrianglePositions(highTemplate).foliage;
    if (positions.length === 0) return;
    const geometry = simplifyEnvironmentTreeGeometry(positions);
    group.add(new THREE.Mesh(geometry, leafMaterial));
  }

  private addLowTreeCrown(
    group: THREE.Group,
    highTemplate: THREE.Object3D,
    leafMaterial: THREE.Material,
    fallbackRadius: number,
    fallbackTreeHeight: number,
  ): void {
    const foliagePositions = collectEnvironmentTreeTrianglePositions(highTemplate).foliage;
    const bounds = boundsForTrianglePositions(foliagePositions);
    if (bounds.isEmpty()) {
      bounds.min.set(-fallbackRadius, fallbackTreeHeight * 0.36, -fallbackRadius);
      bounds.max.set(fallbackRadius, fallbackTreeHeight, fallbackRadius);
    }
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const geometry = createEnvironmentLowTreeCrownGeometry(
      size.x,
      size.y,
      size.z,
    );
    const crown = new THREE.Mesh(geometry, leafMaterial);
    // Geometry starts at y=0, so place its triangular base at the authored
    // foliage floor and center its footprint on that tree's actual canopy.
    crown.position.set(center.x, bounds.min.y, center.z);
    group.add(crown);
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
      // Tree texture canvases are color-graded to the canonical flat LOD
      // colors, so the map carries the prop's overall hue and the material's
      // color stays white to avoid double-multiplying.
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
      this.nodes.push({
        placement,
        root,
        lods,
        detailRung: DETAIL_RUNG_CLOSE,
      });
    }
  }
}

function collectEnvironmentGrassBladeTriangles(
  highTemplate: THREE.Object3D,
): EnvironmentGrassBladeTriangle[] {
  highTemplate.updateMatrixWorld(true);
  const blades: EnvironmentGrassBladeTriangle[] = [];
  highTemplate.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry?.getAttribute('position');
    if (!position || position.count < 3) return;

    const vertices = collectUniqueTransformedPositions(position, mesh.matrixWorld);
    if (vertices.length < 3) return;
    let root = vertices[0];
    for (let i = 1; i < vertices.length; i++) {
      if (vertices[i].y < root.y) root = vertices[i];
    }
    let tip = vertices[0];
    let lengthSq = -1;
    for (let i = 0; i < vertices.length; i++) {
      const candidateLengthSq = root.distanceToSquared(vertices[i]);
      if (candidateLengthSq > lengthSq) {
        tip = vertices[i];
        lengthSq = candidateLengthSq;
      }
    }
    const length = Math.sqrt(lengthSq);
    if (length <= 1e-6) return;

    const direction = tip.clone().sub(root).normalize();
    const widthDirection = new THREE.Vector3(-direction.z, 0, direction.x);
    if (widthDirection.lengthSq() <= 1e-8) widthDirection.set(1, 0, 0);
    else widthDirection.normalize();

    let greatestAxisDistance = 0;
    const offset = new THREE.Vector3();
    const projected = new THREE.Vector3();
    for (let i = 0; i < vertices.length; i++) {
      offset.copy(vertices[i]).sub(root);
      projected.copy(direction).multiplyScalar(offset.dot(direction));
      greatestAxisDistance = Math.max(
        greatestAxisDistance,
        offset.sub(projected).length(),
      );
    }
    const halfWidth = THREE.MathUtils.clamp(
      greatestAxisDistance * 0.55,
      length * 0.065,
      length * 0.18,
    );
    const left = root.clone().addScaledVector(widthDirection, halfWidth);
    const right = root.clone().addScaledVector(widthDirection, -halfWidth);
    blades.push({
      positions: [
        left.x, left.y, left.z,
        right.x, right.y, right.z,
        tip.x, tip.y, tip.z,
      ],
      direction,
      length,
    });
  });
  return blades;
}

function collectUniqueTransformedPositions(
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  transform: THREE.Matrix4,
): THREE.Vector3[] {
  const seen = new Set<string>();
  const positions: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    const vertex = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(transform);
    const key = quantizedPositionKey(vertex.x, vertex.y, vertex.z);
    if (seen.has(key)) continue;
    seen.add(key);
    positions.push(vertex);
  }
  return positions;
}

function selectRepresentativeGrassBlades(
  blades: readonly EnvironmentGrassBladeTriangle[],
  maxCount: number,
): EnvironmentGrassBladeTriangle[] {
  if (blades.length <= maxCount) return blades.slice();
  let longestIndex = 0;
  for (let i = 1; i < blades.length; i++) {
    if (blades[i].length > blades[longestIndex].length) longestIndex = i;
  }
  const selected = [blades[longestIndex]];
  while (selected.length < maxCount) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < blades.length; i++) {
      const candidate = blades[i];
      if (selected.includes(candidate)) continue;
      let nearestDirectionDifference = Infinity;
      for (let j = 0; j < selected.length; j++) {
        nearestDirectionDifference = Math.min(
          nearestDirectionDifference,
          1 - candidate.direction.dot(selected[j].direction),
        );
      }
      const score = nearestDirectionDifference * 2 + candidate.length / blades[longestIndex].length;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    selected.push(blades[bestIndex]);
  }
  return selected;
}

function collectEnvironmentTreeTrianglePositions(
  highTemplate: THREE.Object3D,
): Record<EnvironmentLodFlatColorRole, number[]> {
  highTemplate.updateMatrixWorld(true);
  const positionsByRole: Record<EnvironmentLodFlatColorRole, number[]> = {
    wood: [],
    foliage: [],
  };
  const vertex = new THREE.Vector3();
  highTemplate.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const position = geometry?.getAttribute('position');
    if (!geometry || !position) return;
    const index = geometry.getIndex();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geometry.groups.length > 0
      ? geometry.groups
      : [{
          start: 0,
          count: index?.count ?? position.count,
          materialIndex: 0,
        }];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const geometryGroup = groups[groupIndex];
      const material = materials[geometryGroup.materialIndex ?? 0] ?? materials[0];
      const role = environmentTreeRoleForMaterial(material);
      const target = positionsByRole[role];
      const end = geometryGroup.start + geometryGroup.count;
      for (let i = geometryGroup.start; i < end; i++) {
        const vertexIndex = index ? index.getX(i) : i;
        vertex.fromBufferAttribute(position, vertexIndex).applyMatrix4(mesh.matrixWorld);
        target.push(vertex.x, vertex.y, vertex.z);
      }
    }
  });
  return positionsByRole;
}

function boundsForTrianglePositions(positions: readonly number[]): THREE.Box3 {
  const bounds = new THREE.Box3();
  const vertex = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    vertex.set(positions[i], positions[i + 1], positions[i + 2]);
    bounds.expandByPoint(vertex);
  }
  return bounds;
}

function environmentTreeRoleForMaterial(
  material: THREE.Material | undefined,
): EnvironmentLodFlatColorRole {
  const name = material?.name.toLowerCase() ?? '';
  return name.includes('trunk') || name.includes('wood') || name.includes('bark')
    ? 'wood'
    : 'foliage';
}

function simplifyEnvironmentTreeGeometry(
  positions: readonly number[],
): THREE.BufferGeometry {
  const source = new THREE.BufferGeometry();
  source.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const uniquePositionCount = countUniquePositions(positions);
  const removalCount = Math.min(
    Math.max(0, uniquePositionCount - 4),
    Math.floor(uniquePositionCount * ENVIRONMENT_TREE_MEDIUM_VERTEX_REMOVAL_RATIO),
  );
  const geometry = removalCount > 0
    ? new SimplifyModifier().modify(source, removalCount)
    : source;
  if (geometry !== source) source.dispose();
  geometry.computeVertexNormals();
  return geometry;
}

function countUniquePositions(positions: readonly number[]): number {
  const unique = new Set<string>();
  for (let i = 0; i < positions.length; i += 3) {
    unique.add(quantizedPositionKey(positions[i], positions[i + 1], positions[i + 2]));
  }
  return unique.size;
}

function quantizedPositionKey(x: number, y: number, z: number): string {
  const precision = 1e5;
  return `${Math.round(x * precision)},${Math.round(y * precision)},${Math.round(z * precision)}`;
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
