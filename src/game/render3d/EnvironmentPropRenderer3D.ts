import * as THREE from 'three';
import { areRenderTexturesEnabled, registerRenderTexturesReader } from './RenderTextures3D';
import { loadThreeAsset } from './threeAssetLoader';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { COLORS } from '@/colorsConfig';
import { getLodMode } from '@/clientBarConfig';
import {
  FOREST_SPRUCE2_LEAF_COLOR,
  FOREST_SPRUCE2_WOOD_COLOR,
  VEGETATION_WEATHERING_ENABLED,
} from '../../config';
import { getGrassBladeTexture } from './GrassBladeTexture';
import { getTreeLeafTexture } from './TreeLeafTexture';
import {
  patchVegetationWeathering,
  type VegetationWeatherRole,
} from './VegetationWeathering3D';
import { getTreeTrunkTexture } from './TreeTrunkTexture';
import { ViewportFootprint } from '../ViewportFootprint';
import {
  ACTIVE_VEGETATION_ASSETS,
  isWoodVegetationMaterial,
  logActiveVegetationAssets,
  type VegetationAssetSpec,
} from '@/vegetationAssets';
import type { VegetationKindId } from '@/vegetationConfig';
import {
  ensureVegetationGenerated,
  getVegetationRemovedCount,
  readVegetationRemoved,
  type VegetationProp,
} from '../sim/vegetation';
import {
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_GLYPH,
  type DetailRung,
  coverageRungForViewPosition,
  detailLevelForRung,
  detailRungForMode,
  geometryTierForDetail,
  viewExcludesSphere,
} from './EntityDetailLevel3D';
import type { RenderViewState3D } from './RenderFrameState3D';
import type { WorldShade3D } from './WorldShade3D';
import {
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import { configureGroundSilhouetteCasterTree3D } from './GroundSilhouetteShadow3D';

type EnvironmentPropNode = {
  prop: VegetationProp;
  root: THREE.Group | null;
  lods: Record<EnvironmentPropTier, THREE.Object3D> | null;
  batch: EnvironmentPropBatch | null;
  /** Immutable prop-local transform used by instanced vegetation batches. */
  matrix: THREE.Matrix4 | null;
  /** Latched camera-coverage rung (mode-independent); see the update loop. */
  coverageRung: DetailRung;
};

/** The three authored geometry tiers plus `min`: the MIN/GLYPH rung, where
 *  a tree is one tetrahedron and blade vegetation draws nothing. */
type EnvironmentPropTier = PrimitiveGeometryTier | 'min';

type EnvironmentPropBatch = {
  tiers: Record<EnvironmentPropTier, {
    meshes: THREE.InstancedMesh[];
    templateMatrices: THREE.Matrix4[];
  }>;
  counts: Record<EnvironmentPropTier, number>;
};

type LoadedEnvironmentAsset = {
  spec: VegetationAssetSpec;
  templates: Record<EnvironmentPropTier, THREE.Object3D>;
  unitHeight: number;
};

/** World-unit slack added to a prop's radius for the render-scope test,
 *  so a prop whose center just left the scope but whose canopy still
 *  overlaps it keeps drawing. */
const SCOPE_PADDING_EXTRA = 120;
const ENVIRONMENT_TIERS: readonly EnvironmentPropTier[] = ['close', 'mid', 'far', 'min'];
const ENVIRONMENT_BATCH_MATRIX = new THREE.Matrix4();
const ENVIRONMENT_BATCH_POSITION = new THREE.Vector3();
const ENVIRONMENT_BATCH_SCALE = new THREE.Vector3();
const ENVIRONMENT_BATCH_QUATERNION = new THREE.Quaternion();
const ENVIRONMENT_BATCH_UP = new THREE.Vector3(0, 1, 0);

type EnvironmentLodFlatColorRole = 'wood' | 'foliage';

type EnvironmentGrassLodTier = 'mid' | 'far';

type EnvironmentGrassBladeTriangle = {
  positions: readonly number[];
  direction: THREE.Vector3;
  length: number;
};

const ENVIRONMENT_TREE_MEDIUM_VERTEX_REMOVAL_RATIO = 0.35;
const ENVIRONMENT_FOLIAGE_LIGHT_FLOOR = 1.0;
const LAMBERT_OUTGOING_LIGHT =
  'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';

/**
 * The source foliage combines open leaf shells with intentionally steep and
 * downward-facing facets. Rendering only front faces makes the open shells
 * show dark terrain through sharp triangular holes. Stock Lambert lighting
 * then lets the remaining away-facing facets fall back to the very small scene
 * ambient term while their neighbours receive the full sun. After fog shades
 * the already-dark leaf albedo, both failures read as solid black pieces cut
 * into an otherwise green crown.
 *
 * Keep Lambert's directional modelling, but give foliage a diffuse floor based
 * on its post-texture color. Using `diffuseColor` here is important: an
 * emissive material would bypass fog-of-war and make trees glow in unseen
 * terrain. WorldShade3D applies the prop-wide fog veil after this lighting
 * result, so the floor remains fogged normally while face orientation alone
 * can no longer crush a leaf polygon to black.
 */
export function patchEnvironmentFoliageLighting(
  material: THREE.MeshLambertMaterial,
): void {
  if (material.userData.environmentFoliageLighting === true) return;
  material.userData.environmentFoliageLighting = true;
  // Fog-of-war is ground knowledge about the prop as a whole. Sampling it at
  // every canopy fragment lets one coverage edge cut a low-poly crown into
  // black and green faces. WorldShade3D reads this flag and uses the mesh /
  // instance origin as one stable coverage anchor for the complete leaf mesh.
  material.userData.worldShadeAtObjectOrigin = true;
  // Shade the completed Lambert result. Applying the near-black fog color to
  // diffuseColor before lighting makes the ambient term darken it a second
  // time, which is how an entire properly anchored crown still became black.
  material.userData.worldShadeAfterLighting = true;
  // Leaf cards and the undersides of open low-poly crowns are intentional
  // visible surfaces, not enclosed solid geometry.
  material.side = THREE.DoubleSide;
  const previousCompile = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      LAMBERT_OUTGOING_LIGHT,
      [
        'vec3 environmentFoliageDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
        'vec3 outgoingLight = max(',
        '  environmentFoliageDiffuse,',
        `  diffuseColor.rgb * ${ENVIRONMENT_FOLIAGE_LIGHT_FLOOR.toFixed(2)}`,
        ') + totalEmissiveRadiance;',
      ].join('\n'),
    );
  };
  material.customProgramCacheKey = () =>
    `${previousCacheKey()}|environment-foliage-light-floor-v1`;
  material.needsUpdate = true;
}

/** Fog is a knowledge veil over the final rendered prop, not an albedo edit.
 * Applying desaturation/darkness before Lambert lighting lets the warm sun
 * tint and brighten the material again afterward; that was especially obvious
 * on tree trunks. Mark every environment material for WorldShade3D's
 * post-lighting path so authored 100% color loss remains genuinely grayscale. */
export function configureEnvironmentMaterialFogShading(
  material: THREE.Material,
): void {
  material.userData.worldShadeAfterLighting = true;
}

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

/** Which presentation a prop draws at a resolved detail rung, or null when
 *  it draws nothing. The three geometry rungs map to the authored tiers for
 *  every kind. At the shared MIN/GLYPH rung a tree never disappears: it
 *  becomes one tetrahedron approximating its height and canopy (`min`), so a
 *  strategic zoom still reads a forest as a forest. Blade vegetation (grass,
 *  seaweed) has no silhouette worth a pixel at that size and stops drawing. */
export function environmentPropTierForDetailRung(
  rung: DetailRung,
  kind: VegetationKindId,
): EnvironmentPropTier | null {
  if (rung !== DETAIL_RUNG_GLYPH) return geometryTierForDetail(detailLevelForRung(rung));
  return environmentPropUsesGrassPresentation(kind) ? null : 'min';
}

/** The MIN tree: one tetrahedron standing on the root point whose triangular
 *  base spans the canopy width and whose apex is the authored tree height. */
export function createEnvironmentMinTreeGeometry(
  radius: number,
  height: number,
): THREE.BufferGeometry {
  return createEnvironmentLowTreeCrownGeometry(radius * 2, height, radius * 2);
}

/** Which weathering terms a material takes, from the one thing that is true
 *  about every material key: what the surface is made of. Keyed on the name
 *  rather than passed in, because `sharedMaterial` is reached from four call
 *  sites and a fifth would otherwise be able to skip the classification and
 *  land silently on the default. */
export function vegetationWeatherRoleForKey(key: string): VegetationWeatherRole {
  const lower = key.toLowerCase();
  if (lower.includes('grass') || lower.includes('seaweed')) return 'grass';
  if (lower.includes('trunk') || lower.includes('wood')) return 'trunk';
  return 'foliage';
}

/** Grass and seaweed are one blade-vegetation presentation family. Keeping
 * this classification explicit prevents a non-tree kind from accidentally
 * acquiring the synthetic trunk/crown used by reduced-detail trees. */
export function environmentPropUsesGrassPresentation(
  kind: VegetationKindId,
): boolean {
  return kind === 'grass' || kind === 'seaweed';
}

/** Builds one flat triangle in the authored direction of each High grass or
 * seaweed leaf. Low retains two representative leaves from that same authored
 * set. There is deliberately no central stem primitive at either tier. */
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
  renderScope: ViewportFootprint;
  worldShade: WorldShade3D;
  isTerrainSettled: () => boolean;
};

const FBX_UNKNOWN_MATERIAL_WARNING_FILTER_KEY =
  '__rtsFbxUnknownMaterialWarningFilterInstalled' as const;

type ConsoleWithFbxWarningFilter = Console & {
  [FBX_UNKNOWN_MATERIAL_WARNING_FILTER_KEY]?: boolean;
};

installKnownFbxMaterialWarningFilter();

/** Scratch for StaticPropContainer's world-matrix change test. */
const STATIC_PROP_PREVIOUS_WORLD = new THREE.Matrix4();

/** Container for the vegetation subtree, which is static: a prop's transform is
 *  written once when it is built and never changes again.
 *
 *  three.js walks the ENTIRE scene graph every frame from
 *  `WebGLRenderer.render` -> `scene.updateMatrixWorld()`, and the recursion into
 *  children is unconditional — `matrixAutoUpdate` only skips composing a node's
 *  local matrix, and because `Scene.matrixAutoUpdate` defaults to true the root
 *  sets `matrixWorldNeedsUpdate` every frame, which passes `force = true` all
 *  the way down and makes every node redo `multiplyMatrices` regardless.
 *
 *  Vegetation is ~94% of this game's scene graph (~79k of 84k Object3Ds on a
 *  default map), so that walk dominated the client: measured in the running
 *  game, `scene.updateMatrixWorld()` alone cost 11.5ms of a 16.7ms frame, and a
 *  CPU profile attributed 52% of non-idle main-thread time to updateMatrixWorld
 *  plus 12% to multiplyMatrices.
 *
 *  This container keeps the standard behaviour for itself but only descends
 *  into its children when something actually changed: an ancestor moved (which
 *  arrives as `force`), or props were added. Prop world matrices are correct
 *  after that one pass and stay correct, so the steady-state cost of ~79k
 *  static nodes drops to a single node visit. */
class StaticPropContainer extends THREE.Group {
  /** Set when props are added, so the next update refreshes their world
   *  matrices exactly once. */
  public childMatricesDirty = true;

  public override updateMatrixWorld(force?: boolean): void {
    if (this.matrixAutoUpdate) this.updateMatrix();
    let worldChanged = false;
    if (this.matrixWorldNeedsUpdate || force === true) {
      // `force` arrives every single frame — Scene.matrixAutoUpdate is true, so
      // the root recomposes and flags itself dirty on each pass — but it only
      // means "an ancestor was re-evaluated", not "an ancestor moved". Compare
      // the recomputed world matrix against the previous one so the children
      // are walked only when this container genuinely moved. Sixteen float
      // compares against ~79k node visits is a trade worth making every time.
      STATIC_PROP_PREVIOUS_WORLD.copy(this.matrixWorld);
      if (this.parent === null) {
        this.matrixWorld.copy(this.matrix);
      } else {
        this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
      worldChanged = !STATIC_PROP_PREVIOUS_WORLD.equals(this.matrixWorld);
    }
    if (!worldChanged && !this.childMatricesDirty) return;
    for (const child of this.children) child.updateMatrixWorld(true);
    this.childMatricesDirty = false;
  }
}

export class EnvironmentPropRenderer3D {
  private readonly root = (() => {
    const group = new StaticPropContainer();
    group.updateMatrix();
    group.matrixAutoUpdate = false;
    return group;
  })();
  private readonly options: EnvironmentPropRenderer3DOptions;
  private readonly renderScope: ViewportFootprint;
  private readonly worldShade: WorldShade3D;
  private props: readonly VegetationProp[] = [];
  private readonly nodes: EnvironmentPropNode[] = [];
  /** Node per prop index, so a reclaimed prop is found in O(1) when the
   *  removal log names it. Sparse: disabled assets create no node. */
  private readonly nodesByPropIndex = new Map<number, EnvironmentPropNode>();
  private readonly propBatches = new Map<string, EnvironmentPropBatch>();
  /** Cursor into the sim's append-only removal log. */
  private removedCursor = 0;
  private readonly materialCache = new Map<string, THREE.MeshLambertMaterial>();
  private unregisterTextures: (() => void) | null = null;
  private readonly mtlCache = new Map<
    string,
    Promise<MTLLoader.MaterialCreator>
  >();
  private readonly assets = new Map<string, LoadedEnvironmentAsset>();
  private destroyed = false;
  private initializationStarted = false;
  private assetLoadingFinished = false;
  private ready = false;
  private loaded = false;
  private lastScopeVersion = -1;
  // Numeric change-detection state replacing a per-frame template-string key.
  // lastLodMode = '' never matches a real mode, so it forces a refresh.
  private lastLodMode = '';
  private lastHasView = false;
  private lastCameraX = NaN;
  private lastCameraY = NaN;
  private lastCameraZ = NaN;
  private lastFovYRad = NaN;
  private lastViewportHeightPx = NaN;
  constructor(
    parentWorld: THREE.Group,
    options: EnvironmentPropRenderer3DOptions,
  ) {
    this.options = options;
    this.renderScope = options.renderScope;
    this.worldShade = options.worldShade;
    this.root.name = 'EnvironmentPropRenderer3D';
    parentWorld.add(this.root);
    logActiveVegetationAssets();
    this.unregisterTextures = registerRenderTexturesReader((enabled) => {
      this.applyTexturesEnabled(enabled);
    });
    // Asset IO can overlap terrain startup. Only placement and node creation
    // wait for the authoritative terrain below.
    void this.loadAssets();
  }

  isReady(): boolean {
    return this.ready || this.destroyed;
  }

  update(view?: RenderViewState3D): void {
    this.initializeAfterTerrainSettles();
    if (!this.loaded || this.nodes.length === 0) return;
    this.dropReclaimedProps();
    const scopeVersion = this.renderScope.getVersion();
    const lodMode = getLodMode();
    const hasView = view !== undefined;
    // P1-24: the exact-equality gate missed on every smoothly moving frame.
    // Camera position is quantized to buckets well inside the 120-unit
    // culling pad (so a sub-bucket pan can never pop a prop at the screen
    // edge) and fov/viewport to thresholds below visual relevance; a
    // smooth pan now repacks static matrices per bucket crossing instead
    // of per frame.
    const camBucketX = view === undefined ? 0 : Math.round(view.cameraX / 48);
    const camBucketY = view === undefined ? 0 : Math.round(view.cameraY / 24);
    const camBucketZ = view === undefined ? 0 : Math.round(view.cameraZ / 48);
    const fovBucket = view === undefined ? 0 : Math.round(view.fovYRad * 200);
    const viewportBucket = view === undefined ? 0 : Math.round(view.viewportHeightPx / 8);
    if (
      scopeVersion === this.lastScopeVersion &&
      lodMode === this.lastLodMode &&
      hasView === this.lastHasView &&
      camBucketX === this.lastCameraX &&
      camBucketY === this.lastCameraY &&
      camBucketZ === this.lastCameraZ &&
      fovBucket === this.lastFovYRad &&
      viewportBucket === this.lastViewportHeightPx
    ) {
      return;
    }
    this.lastScopeVersion = scopeVersion;
    this.lastLodMode = lodMode;
    this.lastHasView = hasView;
    this.lastCameraX = camBucketX;
    this.lastCameraY = camBucketY;
    this.lastCameraZ = camBucketZ;
    this.lastFovYRad = fovBucket;
    this.lastViewportHeightPx = viewportBucket;
    for (const batch of this.propBatches.values()) {
      batch.counts.close = 0;
      batch.counts.mid = 0;
      batch.counts.far = 0;
      batch.counts.min = 0;
    }
    for (const node of this.nodes) {
      const p = node.prop;
      // Sim coords are (x, y) horizontal with z up; three.js is (x, z)
      // horizontal with y up.
      const inScope = this.renderScope.inScope(
        p.x,
        p.y,
        p.radius + SCOPE_PADDING_EXTRA,
      );
      if (!inScope) {
        if (node.root !== null) node.root.visible = false;
        continue;
      }
      // Off-camera props still cost: three.js frustum-culls per Mesh, so it
      // walks each prop's LOD subtree every frame just to reject it. Hiding
      // the prop root skips that walk. Measured in the running game, every one
      // of the ~660 in-scope props was outside the frustum while the camera
      // sat over the battle, so this is the common case, not the edge case.
      // viewExcludesSphere is deliberately conservative (cone strictly
      // containing the frustum), so it never hides a prop that is on screen.
      if (
        view &&
        viewExcludesSphere(
          view,
          p.x,
          p.y,
          p.z + p.height * 0.5,
          Math.max(p.radius, p.height * 0.5) + SCOPE_PADDING_EXTRA,
        )
      ) {
        if (node.root !== null) node.root.visible = false;
        continue;
      }
      // The node stores the CAMERA-COVERAGE rung, never the mode-resolved one,
      // so a manual pin can never be fed back in as if it were coverage; the
      // pin is applied on top for this frame only.
      node.coverageRung = view
        ? coverageRungForViewPosition(
            view,
            p.x,
            p.y,
            p.z + p.height * 0.5,
            Math.max(p.radius, p.height * 0.5),
          )
        : DETAIL_RUNG_CLOSE;
      const rung = detailRungForMode(node.coverageRung);
      const tier = environmentPropTierForDetailRung(rung, p.kind);
      if (node.root !== null) node.root.visible = tier !== null;
      if (tier === null) continue;
      if (node.batch !== null && node.matrix !== null) {
        const slot = node.batch.counts[tier]++;
        const batchTier = node.batch.tiers[tier];
        for (let i = 0; i < batchTier.meshes.length; i++) {
          ENVIRONMENT_BATCH_MATRIX.multiplyMatrices(
            node.matrix,
            batchTier.templateMatrices[i],
          );
          batchTier.meshes[i].setMatrixAt(slot, ENVIRONMENT_BATCH_MATRIX);
        }
        continue;
      }
      if (node.lods !== null) {
        node.lods.close.visible = tier === 'close';
        node.lods.mid.visible = tier === 'mid';
        node.lods.far.visible = tier === 'far';
        node.lods.min.visible = tier === 'min';
      }
    }
    for (const batch of this.propBatches.values()) {
      for (let i = 0; i < ENVIRONMENT_TIERS.length; i++) {
        const tier = ENVIRONMENT_TIERS[i];
        const count = batch.counts[tier];
        const meshes = batch.tiers[tier].meshes;
        for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
          const mesh = meshes[meshIndex];
          mesh.count = count;
          if (count > 0) {
            // Capacity covers every prop using this asset, while a frame
            // normally packs only the scoped, visible subset. Restrict the
            // dynamic upload to matrices actually consumed by this draw.
            mesh.instanceMatrix.clearUpdateRanges();
            mesh.instanceMatrix.addUpdateRange(0, count * 16);
            mesh.instanceMatrix.needsUpdate = true;
          }
        }
      }
    }
  }

  private initializeAfterTerrainSettles(): void {
    if (
      this.initializationStarted ||
      this.destroyed ||
      !this.options.isTerrainSettled()
    ) {
      return;
    }
    this.initializationStarted = true;
    // Props are reclaimable energy deposits, so the layout belongs to the
    // simulation. This is the same idempotent front door the server
    // bootstrap uses: whichever runs first generates, and both end up
    // drawing/working the identical list.
    this.props = ensureVegetationGenerated(
      this.options.mapWidth,
      this.options.mapHeight,
      this.options.playerCount,
    );
    // Props consumed before the renderer came up are already in the log;
    // start the cursor at its end and simply never build nodes for them.
    this.removedCursor = getVegetationRemovedCount();
    logVegetationPropCounts(this.props, this.options);
    this.finishInitializationIfReady();
  }

  /** Drain the sim's removal log and delete the nodes for props that have
   *  been fully reclaimed. The log is append-only and sparse — a few
   *  entries per second at most — so this stays a cursor read rather than
   *  a per-frame diff over thousands of props. */
  private dropReclaimedProps(): void {
    const total = getVegetationRemovedCount();
    if (total <= this.removedCursor) return;
    while (this.removedCursor < total) {
      const read = readVegetationRemoved(this.removedCursor, _removedPropScratch);
      if (read === 0) break;
      for (let i = 0; i < read; i++) {
        this.removeNodeForProp(_removedPropScratch[i]);
      }
      this.removedCursor += read;
    }
    // Node removal changes what is drawn independently of camera/scope, so
    // force the next visibility pass instead of letting the change gate
    // short-circuit it.
    this.lastScopeVersion = -1;
  }

  private removeNodeForProp(propIndex: number): void {
    const node = this.nodesByPropIndex.get(propIndex);
    if (node === undefined) return;
    this.nodesByPropIndex.delete(propIndex);
    const at = this.nodes.indexOf(node);
    if (at >= 0) this.nodes.splice(at, 1);
    if (node.root === null) return;
    this.root.remove(node.root);
    // Geometry and materials are shared with the asset templates and the
    // material cache, which `destroy` owns; only the cloned scene graph
    // goes away here.
    node.root.clear();
  }

  private finishInitializationIfReady(): void {
    if (
      this.ready ||
      this.destroyed ||
      !this.initializationStarted ||
      !this.assetLoadingFinished
    ) {
      return;
    }
    if (this.loaded) this.buildNodes();
    this.ready = true;
  }

  /** CLIENT TEX: every cached vegetation material that carries a map swaps
   *  between the map (white base) and its canonical flat hue. A recompile per
   *  material is unavoidable (`USE_MAP` is a compile-time define) and happens
   *  once per toggle, not per frame. */
  private applyTexturesEnabled(enabled: boolean): void {
    for (const material of this.materialCache.values()) {
      const map = material.userData.texturedMap as THREE.Texture | null | undefined;
      if (!map) continue;
      const flatColor = material.userData.flatColor as number;
      material.map = enabled ? map : null;
      material.color.set(enabled ? COLORS.units.turret.barrel.colorHex : flatColor);
      material.needsUpdate = true;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unregisterTextures?.();
    this.unregisterTextures = null;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    for (const node of this.nodes) {
      if (node.root !== null) collectDisposableResources(node.root, geometries, materials);
    }
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
    this.nodesByPropIndex.clear();
    for (const batch of this.propBatches.values()) {
      for (let i = 0; i < ENVIRONMENT_TIERS.length; i++) {
        const meshes = batch.tiers[ENVIRONMENT_TIERS[i]].meshes;
        for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
          meshes[meshIndex].dispose();
        }
      }
    }
    this.propBatches.clear();
    this.assets.clear();
    this.root.clear();
    this.root.parent?.remove(this.root);
  }

  private async loadAssets(): Promise<void> {
    try {
      const loadPromises = new Array<Promise<LoadedEnvironmentAsset>>(ACTIVE_VEGETATION_ASSETS.length);
      for (let i = 0; i < ACTIVE_VEGETATION_ASSETS.length; i++) {
        loadPromises[i] = this.loadAsset(ACTIVE_VEGETATION_ASSETS[i]);
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
      this.loaded = true;
      this.lastScopeVersion = -1;
      this.lastLodMode = '';
    } catch (error) {
      console.warn('Failed to load environment asset pack props', error);
    } finally {
      this.assetLoadingFinished = true;
      this.finishInitializationIfReady();
    }
  }

  private async loadAsset(
    spec: VegetationAssetSpec,
  ): Promise<LoadedEnvironmentAsset> {
    const loaderObject =
      spec.format === 'fbx'
        ? await this.loadFbx(publicAssetUrl(spec.path))
        : await this.loadObj(spec);
    return this.normalizeAsset(spec, loaderObject);
  }

  private async loadObj(spec: VegetationAssetSpec): Promise<THREE.Group> {
    const loader = new OBJLoader();
    if (spec.materialPath) {
      const materials = await this.loadMtl(spec.materialPath);
      loader.setMaterials(materials);
    }
    return loadThreeAsset(loader, publicAssetUrl(spec.path));
  }

  private async loadFbx(url: string): Promise<THREE.Group> {
    const loader = new FBXLoader();
    return loadFbx(loader, url);
  }

  private loadMtl(path: string): Promise<MTLLoader.MaterialCreator> {
    let promise = this.mtlCache.get(path);
    if (!promise) {
      const loader = new MTLLoader();
      promise = loadThreeAsset(loader, publicAssetUrl(path)).then((materials) => {
        materials.preload();
        return materials;
      });
      this.mtlCache.set(path, promise);
    }
    return promise;
  }

  private normalizeAsset(
    spec: VegetationAssetSpec,
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
        for (const material of mesh.material) {
          configureEnvironmentMaterialFogShading(material);
          this.worldShade.patchMaterial(material);
        }
      } else {
        configureEnvironmentMaterialFogShading(mesh.material);
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
        min: new THREE.Group(),
      },
      unitHeight,
    };
    asset.templates.mid = this.makeEnvironmentLodTemplate(asset, 'mid');
    asset.templates.far = this.makeEnvironmentLodTemplate(asset, 'far');
    asset.templates.min = this.makeEnvironmentMinTemplate(asset);
    // After the reduced tiers are derived from the close tier, drop the
    // wrapper groups every prop would otherwise clone.
    asset.templates.close = flattenPropTemplate(asset.templates.close);
    asset.templates.mid = flattenPropTemplate(asset.templates.mid);
    asset.templates.far = flattenPropTemplate(asset.templates.far);
    asset.templates.min = flattenPropTemplate(asset.templates.min);
    configureGroundSilhouetteCasterTree3D(asset.templates.close);
    configureGroundSilhouetteCasterTree3D(asset.templates.mid);
    configureGroundSilhouetteCasterTree3D(asset.templates.far);
    configureGroundSilhouetteCasterTree3D(asset.templates.min);
    return asset;
  }

  /** The MIN tier: a tree is exactly one tetrahedron in the flat foliage
   *  material (so it takes the same fog, weathering, and light floor as the
   *  LOW crown it replaces); grass and seaweed contribute no geometry. */
  private makeEnvironmentMinTemplate(asset: LoadedEnvironmentAsset): THREE.Group {
    const group = new THREE.Group();
    group.name = `environment-template-${asset.spec.id}-min`;
    if (environmentPropUsesGrassPresentation(asset.spec.kind)) return group;
    const height = asset.unitHeight;
    const radius = height
      * (asset.spec.defaultRadius / Math.max(1, asset.spec.defaultHeight));
    const material = this.environmentLodFlatMaterial('foliage');
    configureEnvironmentMaterialFogShading(material);
    this.worldShade.patchMaterial(material);
    group.add(new THREE.Mesh(createEnvironmentMinTreeGeometry(radius, height), material));
    return group;
  }

  private makeEnvironmentLodTemplate(
    asset: LoadedEnvironmentAsset,
    tier: 'mid' | 'far',
  ): THREE.Group {
    return environmentPropUsesGrassPresentation(asset.spec.kind)
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
    configureEnvironmentMaterialFogShading(material);
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
    configureEnvironmentMaterialFogShading(trunkMaterial);
    configureEnvironmentMaterialFogShading(leafMaterial);
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
    spec: VegetationAssetSpec,
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
    spec: VegetationAssetSpec,
    sourceName: string,
  ): THREE.MeshLambertMaterial | null {
    if (environmentPropUsesGrassPresentation(spec.kind)) {
      // Land grass and waterline seaweed share one blade material across every
      // tier, so changing LOD cannot change their palette.
      //
      // It used to carry NO MAP — one flat colour, which is the flat-colour
      // fallback tier the surface-texturing rule exists to forbid, and the
      // reason a field of grass read as a field of identical plastic shapes.
      // The tile is projected by world position, so a clump's tone comes from
      // where it grew and two clumps a metre apart differ.
      return this.sharedMaterial(
        'randomEnvironment.forestSpruce2.grass-leaves',
        FOREST_SPRUCE2_LEAF_COLOR,
        getGrassBladeTexture(),
        true,
      );
    }
    const isWood = isWoodVegetationMaterial(spec, sourceName);
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
      true,
    );
  }

  private sharedMaterial(
    key: string,
    color: number,
    map?: THREE.Texture,
    foliageLighting = false,
  ): THREE.MeshLambertMaterial {
    let material = this.materialCache.get(key);
    if (!material) {
      // Tree texture canvases are color-graded to the canonical flat LOD
      // colors, so the map carries the prop's overall hue and the material's
      // color stays white to avoid double-multiplying. With textures off
      // (CLIENT TEX) the map is dropped and the canonical hue comes back —
      // see applyTexturesEnabled, which flips every cached material at once.
      const texturesOn = areRenderTexturesEnabled();
      material = new THREE.MeshLambertMaterial({
        color: map && texturesOn ? COLORS.units.turret.barrel.colorHex : color,
        map: texturesOn ? map ?? null : null,
        flatShading: true,
      });
      material.name = key;
      material.userData.texturedMap = map ?? null;
      material.userData.flatColor = color;
      if (foliageLighting) patchEnvironmentFoliageLighting(material);
      // THE COVERAGE CHOKE POINT. Every vegetation material in the game is
      // created here — trunk, foliage and grass, textured close tier and flat
      // reduced tiers alike — so weathering everything means weathering it
      // here. Patching only the textured tier would make the treatment pop on
      // and off as a prop crosses a detail rung; the reduced tiers take the
      // weathering without a map and shed only what the map was carrying.
      if (VEGETATION_WEATHERING_ENABLED) {
        patchVegetationWeathering(material, vegetationWeatherRoleForKey(key));
      }
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
      role === 'foliage',
    );
  }

  private buildNodes(): void {
    const batchCapacities = new Map<string, number>();
    for (let i = 0; i < this.props.length; i++) {
      const prop = this.props[i];
      const asset = this.assets.get(prop.assetId);
      if (!asset) continue;
      batchCapacities.set(prop.assetId, (batchCapacities.get(prop.assetId) ?? 0) + 1);
    }
    for (const [assetId, capacity] of batchCapacities) {
      const asset = this.assets.get(assetId);
      if (!asset) continue;
      const batch = this.createPropBatch(asset, capacity);
      if (batch !== null) this.propBatches.set(assetId, batch);
    }

    for (const prop of this.props) {
      const asset = this.assets.get(prop.assetId);
      if (!asset) continue;
      const batch = this.propBatches.get(prop.assetId) ?? null;
      if (batch !== null) {
        const scale = prop.height / asset.unitHeight;
        ENVIRONMENT_BATCH_POSITION.set(prop.x, prop.z, prop.y);
        ENVIRONMENT_BATCH_SCALE.setScalar(scale);
        ENVIRONMENT_BATCH_QUATERNION.setFromAxisAngle(ENVIRONMENT_BATCH_UP, prop.rotation);
        const matrix = new THREE.Matrix4().compose(
          ENVIRONMENT_BATCH_POSITION,
          ENVIRONMENT_BATCH_QUATERNION,
          ENVIRONMENT_BATCH_SCALE,
        );
        const node: EnvironmentPropNode = {
          prop,
          root: null,
          lods: null,
          batch,
          matrix,
          coverageRung: DETAIL_RUNG_CLOSE,
        };
        this.nodes.push(node);
        this.nodesByPropIndex.set(prop.index, node);
        continue;
      }
      const root = new THREE.Group();
      root.name = `vegetation-${prop.kind}-${prop.assetId}`;
      const lods = {
        close: asset.templates.close.clone(true),
        mid: asset.templates.mid.clone(true),
        far: asset.templates.far.clone(true),
        min: asset.templates.min.clone(true),
      };
      lods.close.visible = true;
      lods.mid.visible = false;
      lods.far.visible = false;
      lods.min.visible = false;
      root.add(lods.close, lods.mid, lods.far, lods.min);
      const scale = prop.height / asset.unitHeight;
      // Sim (x, y, z) with z up maps to three.js (x, z, y) with y up.
      root.position.set(prop.x, prop.z, prop.y);
      root.rotation.y = prop.rotation;
      root.scale.setScalar(scale);
      root.userData.vegetationProp = true;
      root.userData.assetId = prop.assetId;
      // Vegetation never moves: a prop's transform is written once, here, and
      // `update()` afterwards only toggles LOD `visible` flags. Compose each
      // local matrix now and take the whole subtree off three.js's per-frame
      // matrix recomputation.
      //
      // This is the single biggest cost in the client. Vegetation is ~94% of
      // the scene graph (79k of 84k Object3Ds on a default map), and
      // `scene.updateMatrixWorld()` walks every node every frame: a CPU
      // profile of the running game put updateMatrixWorld at 51% and
      // multiplyMatrices at 13% of all non-idle main-thread time. With
      // matrixAutoUpdate off, both the compose and the parent multiply are
      // skipped for these nodes.
      //
      // matrixWorldNeedsUpdate forces one world-matrix pass so the parked
      // matrices start correct; if an ancestor ever moves, three.js still
      // propagates `force` down to these children, so they stay correct.
      root.traverse((object) => {
        object.updateMatrix();
        object.matrixAutoUpdate = false;
      });
      this.root.add(root);
      const node: EnvironmentPropNode = {
        prop,
        root,
        lods,
        batch: null,
        matrix: null,
        coverageRung: DETAIL_RUNG_CLOSE,
      };
      this.nodes.push(node);
      this.nodesByPropIndex.set(prop.index, node);
    }
    // New props need one world-matrix pass; after that the subtree is static.
    this.root.childMatricesDirty = true;
  }

  private createPropBatch(
    asset: LoadedEnvironmentAsset,
    capacity: number,
  ): EnvironmentPropBatch | null {
    const tiers = {} as EnvironmentPropBatch['tiers'];
    const counts: Record<EnvironmentPropTier, number> = { close: 0, mid: 0, far: 0, min: 0 };
    for (let i = 0; i < ENVIRONMENT_TIERS.length; i++) {
      const tier = ENVIRONMENT_TIERS[i];
      const template = asset.templates[tier];
      template.updateMatrixWorld(true);
      const meshes: THREE.InstancedMesh[] = [];
      const templateMatrices: THREE.Matrix4[] = [];
      let unsupported = false;
      template.traverse((object) => {
        if (!objectVisibleWithinTemplate(object, template)) return;
        const renderable = object as THREE.Object3D & {
          isLight?: boolean;
          isLine?: boolean;
          isLOD?: boolean;
          isPoints?: boolean;
          isSprite?: boolean;
        };
        const source = object as THREE.Mesh;
        if (!source.isMesh) {
          // A plain transform/group is harmless, but silently omitting another
          // renderable kind would change the asset. Keep that unusual asset on
          // the original cloned-tree path instead.
          if (
            renderable.isLight ||
            renderable.isLine ||
            renderable.isLOD ||
            renderable.isPoints ||
            renderable.isSprite
          ) {
            unsupported = true;
          }
          return;
        }
        const materials = Array.isArray(source.material)
          ? source.material
          : [source.material];
        if ((source as THREE.SkinnedMesh).isSkinnedMesh) {
          unsupported = true;
          return;
        }
        if (
          materials.some((material) => material.transparent) ||
          Object.keys(source.geometry.morphAttributes).length > 0 ||
          source.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender ||
          source.onAfterRender !== THREE.Object3D.prototype.onAfterRender
        ) {
          // Transparent instances cannot retain per-prop depth sorting, while
          // morphs and custom callbacks can carry per-object state. The direct
          // fallback preserves those semantics exactly.
          unsupported = true;
          return;
        }
        templateMatrices.push(source.matrixWorld.clone());
        const mesh = new THREE.InstancedMesh(source.geometry, source.material, capacity);
        mesh.name = `vegetation-batch-${asset.spec.id}-${tier}-${meshes.length}`;
        mesh.count = 0;
        mesh.castShadow = source.castShadow;
        mesh.receiveShadow = source.receiveShadow;
        mesh.renderOrder = source.renderOrder;
        mesh.layers.mask = source.layers.mask;
        mesh.customDepthMaterial = source.customDepthMaterial;
        mesh.customDistanceMaterial = source.customDistanceMaterial;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Visibility is packed explicitly from the same scope/frustum/LOD
        // test used by direct prop nodes; aggregate bounds would be looser.
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        meshes.push(mesh);
        this.root.add(mesh);
      });
      // `min` is legitimately empty for blade vegetation, which draws nothing
      // at the glyph rung; every geometry tier must carry a mesh.
      if (unsupported || (meshes.length === 0 && tier !== 'min')) {
        for (const builtTier of Object.values(tiers)) {
          for (let meshIndex = 0; meshIndex < builtTier.meshes.length; meshIndex++) {
            this.root.remove(builtTier.meshes[meshIndex]);
            builtTier.meshes[meshIndex].dispose();
          }
        }
        for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
          this.root.remove(meshes[meshIndex]);
          meshes[meshIndex].dispose();
        }
        return null;
      }
      tiers[tier] = { meshes, templateMatrices };
    }
    return { tiers, counts };
  }
}

function objectVisibleWithinTemplate(
  object: THREE.Object3D,
  template: THREE.Object3D,
): boolean {
  let current: THREE.Object3D | null = object;
  while (current !== null) {
    if (!current.visible) return false;
    if (current === template) return true;
    current = current.parent;
  }
  return false;
}

/** Scratch for the removal-log drain. Sized well past the few props a
 *  frame can plausibly consume; the drain loops if it ever fills. */
const _removedPropScratch = new Uint32Array(64);

/** Collapses a prop LOD template whose entire subtree is a single mesh down to
 *  just that mesh, baking the wrapper transforms into it.
 *
 *  Templates arrive as `Group -> loaded source root -> Mesh`, and every prop
 *  clones all three LOD templates, so each prop cost 10 Object3Ds to draw at
 *  most one mesh. three.js walks the whole scene graph every frame
 *  (`scene.updateMatrixWorld`), and vegetation is ~94% of that graph, so those
 *  wrapper nodes dominated frame time: a CPU profile of the running game put
 *  updateMatrixWorld at 52%, multiplyMatrices at 12% and projectObject at 10%
 *  of all non-idle main-thread work. Flattening takes a prop from 10 nodes to
 *  4 (root + one mesh per LOD).
 *
 *  Geometry and material are reused untouched and the baked matrix reproduces
 *  the same world transform, so this is invisible in the render. Templates
 *  that legitimately hold several meshes are left alone. */
function flattenPropTemplate(template: THREE.Object3D): THREE.Object3D {
  template.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  template.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  if (meshes.length !== 1) return template;
  const source = meshes[0];
  const flat = new THREE.Mesh(source.geometry, source.material);
  flat.name = template.name;
  flat.castShadow = false;
  flat.receiveShadow = false;
  flat.userData = { ...template.userData, ...source.userData };
  // matrixWorld here is relative to the (unparented) template root, so it is
  // exactly the transform the flattened mesh must carry in its place.
  flat.applyMatrix4(source.matrixWorld);
  return flat;
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

function logVegetationPropCounts(
  props: readonly VegetationProp[],
  options: EnvironmentPropRenderer3DOptions,
): void {
  if (!import.meta.env.DEV) return;
  const counts = new Map<string, number>();
  for (const prop of props) {
    const key = `${prop.kind}/${prop.assetId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}: ${count}`);
  console.info(
    '[vegetation] props (' +
      props.length +
      `, map ${options.mapWidth}x${options.mapHeight}, players ${options.playerCount}` +
      '): ' +
      (parts.length > 0 ? parts.join(', ') : 'none'),
  );
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
