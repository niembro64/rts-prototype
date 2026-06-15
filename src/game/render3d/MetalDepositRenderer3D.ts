// MetalDepositRenderer3D — chunky low 3D ore deposits at each metal
// deposit. The terrain has been pre-flattened to each deposit's
// configured height inside its circular flat pad
// (see Terrain.setMetalDepositFlatZones). The gameplay/logical area is
// an irregular connected set of build-grid resource cells; this renderer
// smooths that cell silhouette into a sharp-edged, low coin crown.

import * as THREE from 'three';
import type { GraphicsConfig } from '@/types/graphics';
import { COLORS } from '@/colorsConfig';
import type { MetalDeposit } from '../../metalDepositConfig';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';
import {
  METAL_DEPOSIT_ROCK_TEXTURE_BLEND,
  METAL_DEPOSIT_ROCK_TEXTURE_TILE_WORLD_SIZE,
} from '../../config';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import {
  assignBuildGridOverlayUniforms,
  buildGridOverlayFragment,
  buildGridOverlayUniformDeclarations,
  type BuildGridOverlayUniforms,
} from './BuildGridOverlayShader';
import { getRockDetailTexture } from './RockDetailTexture';
import {
  makeMetalDepositVisualClusters,
  type DepositVisualCell,
  type MetalDepositVisualCluster,
} from './MetalDepositVisualClusters';

const DEPOSIT_MESH_DETAIL = {
  outlineStep: 2,
  material: 'standard' as const,
};

const DEPOSIT_BOUNDARY_SMOOTH_PASSES = 2;
const DEPOSIT_VISUAL_MARGIN = BUILD_GRID_CELL_SIZE * 0.16;

const DEPOSIT_BASE = new THREE.Color(COLORS.environment.metalDeposit.baseColorHex);
export class MetalDepositRenderer3D {
  private group: THREE.Group;
  private clusters: ReadonlyArray<MetalDepositVisualCluster>;
  private records: Array<{
    node: THREE.Group;
  }> = [];
  private materials = new Map<string, THREE.Material>();

  constructor(
    parentWorld: THREE.Group,
    deposits: ReadonlyArray<MetalDeposit>,
    private readonly buildGridOverlayUniforms: BuildGridOverlayUniforms,
  ) {
    this.clusters = makeMetalDepositVisualClusters(deposits);
    this.group = new THREE.Group();
    parentWorld.add(this.group);
    this.records = [];
    this.buildAll();
  }

  update(_graphicsConfig: GraphicsConfig): void {
    // Deposits are static world geometry; buildAll() leaves every node
    // visible, and the shared material reads live overlay uniforms.
  }

  private buildAll(): void {
    for (let i = 0; i < this.clusters.length; i++) {
      const node = this.buildDepositNode(i);
      node.visible = true;
      this.records[i] = { node };
      this.group.add(node);
    }
  }

  private buildDepositNode(index: number): THREE.Group {
    const cluster = this.clusters[index];
    const coinHeight = METAL_DEPOSIT_CONFIG.coinHeight;
    const node = new THREE.Group();
    const mesh = new THREE.Mesh(
      makeDepositCoinGeometry(cluster, DEPOSIT_MESH_DETAIL.outlineStep, coinHeight),
      this.getMaterial(DEPOSIT_MESH_DETAIL.material),
    );
    node.add(mesh);
    // The mesh contains only the above-ground crown. Relying on the
    // terrain surface to hide below-ground triangles leaks at grazing
    // camera angles because the terrain is a surface, not a solid mask.
    node.position.set(cluster.x, cluster.height + 0.04, cluster.y);
    node.userData.metalDepositIds = cluster.depositIds;
    return node;
  }

  private getMaterial(kind: 'lambert' | 'standard'): THREE.Material {
    let material = this.materials.get(kind);
    if (!material) {
      material = makeDepositMaterial(kind, this.buildGridOverlayUniforms);
      this.materials.set(kind, material);
    }
    return material;
  }

  dispose(): void {
    for (const record of this.records) {
      disposeDepositNode(record.node);
      this.group.remove(record.node);
    }
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

function disposeDepositNode(node: THREE.Group): void {
  node.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    mesh.geometry?.dispose();
  });
}

function seededNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function makeDepositMaterial(
  kind: 'lambert' | 'standard',
  buildGridOverlayUniforms: BuildGridOverlayUniforms,
): THREE.Material {
  const rockMap = METAL_DEPOSIT_ROCK_TEXTURE_BLEND > 0 ? getRockDetailTexture() : null;
  if (kind === 'standard') {
    const material = new THREE.MeshStandardMaterial({
      color: COLORS.environment.metalDeposit.standardMaterial.colorHex,
      map: rockMap,
      vertexColors: true,
      flatShading: COLORS.environment.metalDeposit.standardMaterial.flatShading,
      metalness: COLORS.environment.metalDeposit.standardMaterial.metalness,
      roughness: COLORS.environment.metalDeposit.standardMaterial.roughness,
    });
    installDepositTextureBlendShader(material, buildGridOverlayUniforms);
    return material;
  }
  const material = new THREE.MeshLambertMaterial({
    color: COLORS.environment.metalDeposit.lambertMaterial.colorHex,
    map: rockMap,
    vertexColors: true,
    flatShading: COLORS.environment.metalDeposit.lambertMaterial.flatShading,
  });
  installDepositTextureBlendShader(material, buildGridOverlayUniforms);
  return material;
}

function installDepositTextureBlendShader(
  material: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial,
  buildGridOverlayUniforms: BuildGridOverlayUniforms,
): void {
  material.onBeforeCompile = (shader) => {
    assignBuildGridOverlayUniforms(shader, buildGridOverlayUniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          'varying vec3 vBuildGridOverlayWorldPos;',
          '#include <common>',
        ].join('\n'),
      )
      .replace(
        '#include <worldpos_vertex>',
        [
          '#include <worldpos_vertex>',
          'vec4 buildGridOverlayWorldPosition = vec4(transformed, 1.0);',
          '#ifdef USE_BATCHING',
          '  buildGridOverlayWorldPosition = batchingMatrix * buildGridOverlayWorldPosition;',
          '#endif',
          '#ifdef USE_INSTANCING',
          '  buildGridOverlayWorldPosition = instanceMatrix * buildGridOverlayWorldPosition;',
          '#endif',
          'buildGridOverlayWorldPosition = modelMatrix * buildGridOverlayWorldPosition;',
          'vBuildGridOverlayWorldPos = buildGridOverlayWorldPosition.xyz;',
        ].join('\n'),
      );
    shader.uniforms.uMetalDepositTextureBlend = { value: METAL_DEPOSIT_ROCK_TEXTURE_BLEND };
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          'uniform float uMetalDepositTextureBlend;',
          buildGridOverlayUniformDeclarations(),
          'varying vec3 vBuildGridOverlayWorldPos;',
          '#include <common>',
        ].join('\n'),
      )
      .replace(
        '#include <map_fragment>',
        [
          '#ifdef USE_MAP',
          '  vec4 sampledDiffuseColor = texture2D(map, vMapUv);',
          '  #ifdef DECODE_VIDEO_TEXTURE',
          '    sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);',
          '  #endif',
          '  float textureBlend = clamp(uMetalDepositTextureBlend, 0.0, 1.0);',
          '  diffuseColor.rgb *= mix(vec3(1.0), sampledDiffuseColor.rgb, textureBlend);',
          '  diffuseColor.a *= sampledDiffuseColor.a;',
          '#endif',
          buildGridOverlayFragment('vBuildGridOverlayWorldPos'),
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'metalDepositTextureBlend-buildGridOverlay';
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
): THREE.BufferGeometry {
  const outline = makeSmoothedDepositOutline(source, outlineStep);
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const visibleHeight = height * 0.5;
  const seed = source.seed;

  const topStart = positions.length / 3;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    positions.push(p.x, visibleHeight, p.z);
    pushDepositUv(uvs, p.x, p.z, seed);
    pushDepositColor(colors);
  }

  const groundStart = positions.length / 3;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i];
    positions.push(p.x, 0, p.z);
    pushDepositUv(uvs, p.x, p.z, seed);
    pushDepositColor(colors);
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
    const topA = topStart + i;
    const topB = topStart + next;
    const groundA = groundStart + i;
    const groundB = groundStart + next;

    // Vertical rim follows the same smoothed outline as the top face, so
    // the visible deposit footprint stays tied to the metal-producing cells.
    indices.push(topA, topB, groundA, topB, groundB, groundA);
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  indexed.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  indexed.setIndex(indices);
  const geom = indexed.toNonIndexed();
  indexed.dispose();
  geom.computeVertexNormals();
  return geom;
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
    const area = signedLoopArea(loop);
    if (area > bestArea) {
      best = loop;
      bestArea = area;
    }
  }
  if (best !== null && best.length >= 3) return best;

  let fallback: DepositOutlinePoint[] | null = null;
  for (const loop of loops) {
    const area = Math.abs(signedLoopArea(loop));
    if (area > bestArea) {
      fallback = loop;
      bestArea = area;
    }
  }
  if (fallback !== null && fallback.length >= 3) {
    if (signedLoopArea(fallback) < 0) fallback.reverse();
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
  const winding = signedLoopArea(points) >= 0 ? 1 : -1;
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

function signedLoopArea(points: readonly DepositOutlinePoint[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area * 0.5;
}

function pushDepositUv(uvs: number[], x: number, z: number, seed: number): void {
  const offsetU = seededNoise(seed * 101 + 7);
  const offsetV = seededNoise(seed * 163 + 19);
  uvs.push(
    x / METAL_DEPOSIT_ROCK_TEXTURE_TILE_WORLD_SIZE + offsetU,
    z / METAL_DEPOSIT_ROCK_TEXTURE_TILE_WORLD_SIZE + offsetV,
  );
}

function pushDepositColor(colors: number[]): void {
  colors.push(DEPOSIT_BASE.r, DEPOSIT_BASE.g, DEPOSIT_BASE.b);
}
