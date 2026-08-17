// MetalDepositRenderer3D — chunky low 3D ore deposits at each metal
// deposit. The terrain has been pre-flattened to each deposit's
// configured height inside its circular flat pad
// (see Terrain.setMetalDepositFlatZones). The gameplay/logical area is
// an irregular connected set of build-grid resource cells; this renderer
// smooths that cell silhouette into a sharp-edged, low coin crown.

import * as THREE from 'three';
import type { GraphicsConfig } from '@/types/graphics';
import type { MetalDeposit } from '../../metalDepositConfig';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import {
  assignPathfindingHierarchyOverlayUniforms,
  pathfindingHierarchyOverlayFragment,
  pathfindingHierarchyOverlayUniformDeclarations,
  type PathfindingHierarchyOverlayUniforms,
} from './PathfindingHierarchyOverlayShader';
import { getRockDetailTexture } from './RockDetailTexture';
import {
  makeMetalDepositVisualClusters,
  type DepositVisualCell,
  type MetalDepositVisualCluster,
} from './MetalDepositVisualClusters';
import { isMetalTerrainSurface } from '../sim/worldSurfaceState';
import { signedPolygonAreaXZ } from '../math/polygonArea';
import {
  METAL_SURFACE_MATERIAL,
  METAL_SURFACE_RESPONSE_GLSL,
  METAL_SURFACE_TRIPLANAR_GLSL,
  metalSurfaceStandardParameters,
} from './MetalSurfaceMaterial3D';
import type { RenderViewState3D } from './RenderFrameState3D';
import { detailLevelForViewPosition, geometryTierForDetail } from './EntityDetailLevel3D';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import {
  WORLD_SHADE_FRAGMENT_PARS,
  worldShadeFragment,
  type WorldShade3D,
} from './WorldShade3D';

const DEPOSIT_MESH_DETAIL = {
  close: { outlineStep: 2, maxOutlinePoints: Number.POSITIVE_INFINITY },
  mid: { outlineStep: 5, maxOutlinePoints: 18 },
  far: { outlineStep: 1, maxOutlinePoints: 8 },
};

const DEPOSIT_BOUNDARY_SMOOTH_PASSES = 2;
const DEPOSIT_VISUAL_MARGIN = BUILD_GRID_CELL_SIZE * 0.16;

export class MetalDepositRenderer3D {
  private group: THREE.Group;
  private clusters: ReadonlyArray<MetalDepositVisualCluster>;
  private records: Array<{
    node: THREE.Group;
    meshes: Record<PrimitiveGeometryTier, THREE.Mesh>;
    cluster: MetalDepositVisualCluster;
  }> = [];
  private material: THREE.MeshStandardMaterial | null = null;

  constructor(
    parentWorld: THREE.Group,
    deposits: ReadonlyArray<MetalDeposit>,
    private readonly pathfindingHierarchyOverlayUniforms: PathfindingHierarchyOverlayUniforms,
    private readonly worldShade: WorldShade3D,
  ) {
    this.clusters = makeMetalDepositVisualClusters(deposits);
    this.group = new THREE.Group();
    parentWorld.add(this.group);
    this.records = [];
    this.buildAll();
  }

  update(_graphicsConfig: GraphicsConfig, view?: RenderViewState3D): void {
    for (const record of this.records) {
      const cluster = record.cluster;
      const tier = view
        ? geometryTierForDetail(detailLevelForViewPosition(
            view,
            cluster.x,
            cluster.y,
            cluster.height,
            Math.max(cluster.resourceHalfSize, BUILD_GRID_CELL_SIZE),
          ))
        : 'close';
      record.meshes.close.visible = tier === 'close';
      record.meshes.mid.visible = tier === 'mid';
      record.meshes.far.visible = tier === 'far';
    }
  }

  private buildAll(): void {
    // SURFACE = METAL builds no crowns: the deposits already did their job by
    // shaping the terrain, and with the whole map metallic there is nothing to
    // single out.
    if (isMetalTerrainSurface()) return;
    for (let i = 0; i < this.clusters.length; i++) {
      const { node, meshes } = this.buildDepositNode(i);
      node.visible = true;
      this.records[i] = { node, meshes, cluster: this.clusters[i] };
      this.group.add(node);
    }
  }

  private buildDepositNode(index: number): {
    node: THREE.Group;
    meshes: Record<PrimitiveGeometryTier, THREE.Mesh>;
  } {
    const cluster = this.clusters[index];
    const coinHeight = METAL_DEPOSIT_CONFIG.coinHeight;
    const node = new THREE.Group();
    const material = this.getMaterial();
    const makeMesh = (tier: PrimitiveGeometryTier): THREE.Mesh => {
      const detail = DEPOSIT_MESH_DETAIL[tier];
      const mesh = new THREE.Mesh(
        makeDepositCoinGeometry(
          cluster,
          detail.outlineStep,
          coinHeight,
          detail.maxOutlinePoints,
        ),
        material,
      );
      mesh.visible = tier === 'close';
      node.add(mesh);
      return mesh;
    };
    const meshes = {
      close: makeMesh('close'),
      mid: makeMesh('mid'),
      far: makeMesh('far'),
    };
    // The mesh contains only the above-ground crown. Relying on the
    // terrain surface to hide below-ground triangles leaks at grazing
    // camera angles because the terrain is a surface, not a solid mask.
    node.position.set(cluster.x, cluster.height + 0.04, cluster.y);
    node.userData.metalDepositIds = cluster.depositIds;
    return { node, meshes };
  }

  private getMaterial(): THREE.MeshStandardMaterial {
    if (!this.material) {
      this.material = makeDepositMaterial(
        this.pathfindingHierarchyOverlayUniforms,
        this.worldShade,
      );
    }
    return this.material;
  }

  dispose(): void {
    for (const record of this.records) {
      disposeDepositNode(record.node);
      this.group.remove(record.node);
    }
    this.material?.dispose();
    this.material = null;
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

function disposeDepositNode(node: THREE.Group): void {
  node.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
  });
}

function makeDepositMaterial(
  pathfindingHierarchyOverlayUniforms: PathfindingHierarchyOverlayUniforms,
  worldShade: WorldShade3D,
): THREE.MeshStandardMaterial {
  // The crown deliberately uses the same smooth MeshStandardMaterial
  // response as METAL terrain. Its raised geometry may bend the reflected
  // light, but the material and its shading pipeline are canonical.
  const material = new THREE.MeshStandardMaterial({
    color: METAL_SURFACE_MATERIAL.color,
    vertexColors: false,
    ...metalSurfaceStandardParameters(),
  });
  installDepositMetalSurfaceShader(
    material,
    pathfindingHierarchyOverlayUniforms,
    worldShade,
  );
  return material;
}

function installDepositMetalSurfaceShader(
  material: THREE.MeshStandardMaterial,
  pathfindingHierarchyOverlayUniforms: PathfindingHierarchyOverlayUniforms,
  worldShade: WorldShade3D,
): void {
  // dFdx/dFdy supplies the same per-fragment geometric normal used by terrain's
  // triplanar metal projection. WebGL2 has derivatives in core; this enables
  // the extension on the WebGL1 fallback.
  (material as unknown as { extensions: Record<string, boolean> }).extensions = {
    derivatives: true,
  };
  material.onBeforeCompile = (shader) => {
    assignPathfindingHierarchyOverlayUniforms(
      shader,
      pathfindingHierarchyOverlayUniforms,
    );
    worldShade.assignUniforms(shader);
    shader.uniforms.uMetalSurfaceTexture = { value: getRockDetailTexture() };
    shader.uniforms.uMetalSurfaceColor = {
      value: new THREE.Color(METAL_SURFACE_MATERIAL.color),
    };
    shader.uniforms.uMetalSurfaceTileWorldSize = {
      value: METAL_SURFACE_MATERIAL.rockTileWorldSize,
    };
    shader.uniforms.uMetalSurfaceBlend = {
      value: METAL_SURFACE_MATERIAL.rockTextureBlend,
    };
    shader.uniforms.uMetalSurfaceLitColorBlend = {
      value: METAL_SURFACE_MATERIAL.rockTextureLitColorBlend,
    };
    shader.uniforms.uMetalSurfaceContrast = {
      value: METAL_SURFACE_MATERIAL.rockTextureContrast,
    };
    shader.uniforms.uMetalSurfaceRoughnessVariation = {
      value: METAL_SURFACE_MATERIAL.rockTextureRoughnessVariation,
    };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          'varying vec3 vMetalDepositWorldPos;',
          '#include <common>',
        ].join('\n'),
      )
      .replace(
        '#include <worldpos_vertex>',
        [
          '#include <worldpos_vertex>',
          'vec4 metalDepositWorldPosition = vec4(transformed, 1.0);',
          '#ifdef USE_BATCHING',
          '  metalDepositWorldPosition = batchingMatrix * metalDepositWorldPosition;',
          '#endif',
          '#ifdef USE_INSTANCING',
          '  metalDepositWorldPosition = instanceMatrix * metalDepositWorldPosition;',
          '#endif',
          'metalDepositWorldPosition = modelMatrix * metalDepositWorldPosition;',
          'vMetalDepositWorldPos = metalDepositWorldPosition.xyz;',
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          'uniform sampler2D uMetalSurfaceTexture;',
          'uniform vec3 uMetalSurfaceColor;',
          'uniform float uMetalSurfaceTileWorldSize;',
          'uniform float uMetalSurfaceBlend;',
          'uniform float uMetalSurfaceLitColorBlend;',
          'uniform float uMetalSurfaceContrast;',
          'uniform float uMetalSurfaceRoughnessVariation;',
          METAL_SURFACE_RESPONSE_GLSL,
          METAL_SURFACE_TRIPLANAR_GLSL,
          WORLD_SHADE_FRAGMENT_PARS,
          pathfindingHierarchyOverlayUniformDeclarations(),
          'varying vec3 vMetalDepositWorldPos;',
          '#include <common>',
        ].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          'vec3 metalDepositDpdx = dFdx(vMetalDepositWorldPos);',
          'vec3 metalDepositDpdy = dFdy(vMetalDepositWorldPos);',
          'vec3 metalDepositGeomNormal = normalize(cross(metalDepositDpdx, metalDepositDpdy));',
          'vec3 metalDepositDetail = sampleMetalSurfaceDetail(',
          '  uMetalSurfaceTexture,',
          '  vMetalDepositWorldPos,',
          '  metalDepositGeomNormal,',
          '  uMetalSurfaceTileWorldSize',
          ');',
          'diffuseColor.rgb = metalSurfaceAlbedo(',
          '  uMetalSurfaceColor,',
          '  metalDepositDetail,',
          '  uMetalSurfaceBlend,',
          '  uMetalSurfaceContrast',
          ');',
          worldShadeFragment('vMetalDepositWorldPos', true),
          pathfindingHierarchyOverlayFragment('vMetalDepositWorldPos'),
        ].join('\n'),
      )
      .replace(
        '#include <roughnessmap_fragment>',
        [
          '#include <roughnessmap_fragment>',
          'roughnessFactor = metalSurfaceRoughness(',
          '  roughnessFactor,',
          '  metalDepositDetail,',
          '  uMetalSurfaceContrast,',
          '  uMetalSurfaceRoughnessVariation',
          ');',
        ].join('\n'),
      )
      .replace(
        'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
        [
          'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
          'outgoingLight = metalSurfaceLitColor(',
          '  outgoingLight,',
          '  metalDepositDetail,',
          '  uMetalSurfaceContrast,',
          '  uMetalSurfaceLitColorBlend',
          ');',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () =>
    'metalDeposit-metalSurface-worldShade-pathHierarchy-v7';
}

type DepositOutlinePoint = { x: number; z: number };
type DepositShapeSource = {
  x: number;
  y: number;
  cells: readonly DepositVisualCell[];
  resourceHalfSize: number;
};
type GridEdge = {
  sx: number;
  sy: number;
  ex: number;
  ey: number;
  key: string;
};

function makeDepositCoinGeometry(
  source: MetalDepositVisualCluster,
  outlineStep: number,
  height: number,
  maxOutlinePoints: number = Number.POSITIVE_INFINITY,
): THREE.BufferGeometry {
  const outline = limitDepositOutline(
    makeSmoothedDepositOutline(source, outlineStep),
    maxOutlinePoints,
  );
  const positions: number[] = [];
  const indices: number[] = [];
  const visibleHeight = height * 0.5;

  // The crown keeps a hard lighting boundary between its horizontal cap and
  // raised rim. The cap can therefore match flat METAL terrain without its
  // normal being averaged into the vertical rim.
  const topStart = positions.length / 3;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    positions.push(p.x, visibleHeight, p.z);
  }

  const rimTopStart = positions.length / 3;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    positions.push(p.x, visibleHeight, p.z);
  }

  const rimGroundStart = positions.length / 3;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    positions.push(p.x, 0, p.z);
  }

  const contour = new Array<THREE.Vector2>(outline.length);
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    contour[i] = new THREE.Vector2(p.x, p.z);
  }
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const face of faces) {
    indices.push(topStart + face[0], topStart + face[2], topStart + face[1]);
  }

  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const topA = rimTopStart + i;
    const topB = rimTopStart + next;
    const groundA = rimGroundStart + i;
    const groundB = rimGroundStart + next;

    // Vertical rim follows the same smoothed outline as the top face, so
    // the visible deposit footprint stays tied to the metal-producing cells.
    indices.push(topA, topB, groundA, topB, groundB, groundA);
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  // Smooth within each surface, matching terrain's interpolated lighting
  // normals without rounding the cap into the vertical rim. The geometric
  // derivative used for texture projection remains face-true.
  indexed.computeVertexNormals();
  // Authoritative terrain triangles are back-facing in Three's X/Y/Z space
  // and rendered DoubleSide with upward-authored vertex normals. Three flips
  // those normals for the visible back face, so a flat METAL world lights with
  // an effective downward normal. Match that established appearance on the
  // crown cap while keeping its front-facing topology and its rim normals.
  const normals = indexed.getAttribute('normal');
  for (let i = 0; i < outline.length; i++) {
    normals.setXYZ(topStart + i, 0, -1, 0);
  }
  normals.needsUpdate = true;
  return indexed;
}

function limitDepositOutline(
  points: readonly DepositOutlinePoint[],
  maxPoints: number,
): DepositOutlinePoint[] {
  const cap = Math.max(3, Math.floor(maxPoints));
  if (!Number.isFinite(maxPoints) || points.length <= cap) return copyDepositLoop(points);
  const out = new Array<DepositOutlinePoint>(cap);
  for (let i = 0; i < cap; i++) {
    out[i] = points[Math.floor((i * points.length) / cap)];
  }
  return out;
}

function makeSmoothedDepositOutline(
  source: DepositShapeSource,
  outlineStep: number,
): DepositOutlinePoint[] {
  const raw = makeDepositCellBoundary(source);
  const padded = offsetDepositLoop(raw, DEPOSIT_VISUAL_MARGIN);
  const smoothed = smoothDepositLoop(padded, DEPOSIT_BOUNDARY_SMOOTH_PASSES);
  return decimateDepositLoop(smoothed, outlineStep);
}

function makeDepositCellBoundary(source: DepositShapeSource): DepositOutlinePoint[] {
  const loops = makeDepositCellBoundaryLoops(source);
  let best: DepositOutlinePoint[] | null = null;
  let bestArea = 0;
  for (const loop of loops) {
    const area = signedPolygonAreaXZ(loop);
    if (area > bestArea) {
      best = loop;
      bestArea = area;
    }
  }
  if (best !== null && best.length >= 3) return best;

  let fallback: DepositOutlinePoint[] | null = null;
  for (const loop of loops) {
    const area = Math.abs(signedPolygonAreaXZ(loop));
    if (area > bestArea) {
      fallback = loop;
      bestArea = area;
    }
  }
  if (fallback !== null && fallback.length >= 3) {
    if (signedPolygonAreaXZ(fallback) < 0) fallback.reverse();
    return fallback;
  }
  return makeFallbackDepositBoundary(source);
}

function makeDepositCellBoundaryLoops(source: DepositShapeSource): DepositOutlinePoint[][] {
  const occupied = new Set<string>();
  for (const cell of source.cells) occupied.add(gridCellKey(cell.gx, cell.gy));

  const edges: GridEdge[] = [];
  const pushEdge = (sx: number, sy: number, ex: number, ey: number): void => {
    edges.push({ sx, sy, ex, ey, key: `${sx},${sy}->${ex},${ey}` });
  };

  for (const cell of source.cells) {
    const gx = cell.gx;
    const gy = cell.gy;
    if (!occupied.has(gridCellKey(gx, gy - 1))) pushEdge(gx, gy, gx + 1, gy);
    if (!occupied.has(gridCellKey(gx + 1, gy))) pushEdge(gx + 1, gy, gx + 1, gy + 1);
    if (!occupied.has(gridCellKey(gx, gy + 1))) pushEdge(gx + 1, gy + 1, gx, gy + 1);
    if (!occupied.has(gridCellKey(gx - 1, gy))) pushEdge(gx, gy + 1, gx, gy);
  }

  const outgoing = new Map<string, GridEdge[]>();
  for (const edge of edges) {
    const key = gridPointKey(edge.sx, edge.sy);
    const list = outgoing.get(key);
    if (list) list.push(edge);
    else outgoing.set(key, [edge]);
  }

  const used = new Set<string>();
  const loops: DepositOutlinePoint[][] = [];
  for (const first of edges) {
    if (used.has(first.key)) continue;
    const loop: DepositOutlinePoint[] = [];
    let current: GridEdge | null = first;
    const startKey = gridPointKey(first.sx, first.sy);
    for (let guard = 0; current !== null && guard < edges.length + 4; guard++) {
      used.add(current.key);
      loop.push(gridPointToLocal(current.sx, current.sy, source));
      const endKey = gridPointKey(current.ex, current.ey);
      if (endKey === startKey) {
        current = null;
        break;
      }
      current = pickNextDepositBoundaryEdge(outgoing.get(endKey) ?? [], used);
    }
    if (current === null && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function pickNextDepositBoundaryEdge(
  candidates: readonly GridEdge[],
  used: ReadonlySet<string>,
): GridEdge | null {
  for (const edge of candidates) {
    if (!used.has(edge.key)) return edge;
  }
  return null;
}

function gridCellKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

function gridPointKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

function gridPointToLocal(
  gx: number,
  gy: number,
  source: DepositShapeSource,
): DepositOutlinePoint {
  return {
    x: gx * BUILD_GRID_CELL_SIZE - source.x,
    z: gy * BUILD_GRID_CELL_SIZE - source.y,
  };
}

function makeFallbackDepositBoundary(source: DepositShapeSource): DepositOutlinePoint[] {
  const halfSize = Math.max(BUILD_GRID_CELL_SIZE * 0.5, source.resourceHalfSize);
  return [
    { x: -halfSize, z: -halfSize },
    { x: halfSize, z: -halfSize },
    { x: halfSize, z: halfSize },
    { x: -halfSize, z: halfSize },
  ];
}

function offsetDepositLoop(
  points: readonly DepositOutlinePoint[],
  margin: number,
): DepositOutlinePoint[] {
  if (margin <= 0 || points.length < 3) return copyDepositLoop(points);
  const winding = signedPolygonAreaXZ(points) >= 0 ? 1 : -1;
  const out: DepositOutlinePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    const prevEdge = normalizeDepositVector(curr.x - prev.x, curr.z - prev.z);
    const nextEdge = normalizeDepositVector(next.x - curr.x, next.z - curr.z);
    const prevNormal = outwardDepositNormal(prevEdge, winding);
    const nextNormal = outwardDepositNormal(nextEdge, winding);
    let mx = prevNormal.x + nextNormal.x;
    let mz = prevNormal.z + nextNormal.z;
    const mLen = Math.hypot(mx, mz);
    if (mLen < 1e-6) {
      out.push({
        x: curr.x + prevNormal.x * margin,
        z: curr.z + prevNormal.z * margin,
      });
      continue;
    }
    mx /= mLen;
    mz /= mLen;
    const denom = Math.max(0.35, mx * prevNormal.x + mz * prevNormal.z);
    const distance = Math.min(margin * 2.6, margin / denom);
    out.push({
      x: curr.x + mx * distance,
      z: curr.z + mz * distance,
    });
  }
  return out;
}

function smoothDepositLoop(
  points: readonly DepositOutlinePoint[],
  passes: number,
): DepositOutlinePoint[] {
  let current = copyDepositLoop(points);
  for (let pass = 0; pass < passes && current.length >= 3; pass++) {
    const next: DepositOutlinePoint[] = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 },
      );
    }
    current = next;
  }
  return current;
}

function decimateDepositLoop(
  points: readonly DepositOutlinePoint[],
  step: number,
): DepositOutlinePoint[] {
  const stride = Math.max(1, Math.floor(step));
  if (stride <= 1) return copyDepositLoop(points);
  const out: DepositOutlinePoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  return out.length >= 3 ? out : copyDepositLoop(points);
}

function copyDepositLoop(points: readonly DepositOutlinePoint[]): DepositOutlinePoint[] {
  const copy = new Array<DepositOutlinePoint>(points.length);
  for (let i = 0; i < points.length; i++) copy[i] = points[i];
  return copy;
}

function normalizeDepositVector(x: number, z: number): DepositOutlinePoint {
  const len = Math.hypot(x, z);
  if (len < 1e-6) return { x: 0, z: 0 };
  return { x: x / len, z: z / len };
}

function outwardDepositNormal(
  edge: DepositOutlinePoint,
  winding: number,
): DepositOutlinePoint {
  return winding >= 0
    ? { x: edge.z, z: -edge.x }
    : { x: -edge.z, z: edge.x };
}
