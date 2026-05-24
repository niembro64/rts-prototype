// MetalDepositRenderer3D — chunky low 3D ore deposits at each metal
// deposit. The terrain has been pre-flattened to each deposit's
// configured height inside its circular flat pad
// (see Terrain.setMetalDepositFlatZones). The gameplay/logical area is
// an irregular connected set of build-grid resource cells; this renderer
// smooths that cell silhouette into a sharp-edged, low coin crown.

import * as THREE from 'three';
import type { ConcreteGraphicsQuality, GraphicsConfig } from '@/types/graphics';
import { COLORS } from '@/colorsConfig';
import type { MetalDeposit } from '../../metalDepositConfig';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { getRockDetailTexture } from './RockDetailTexture';

const DEPOSIT_MESH_BY_GRAPHICS_TIER: Record<ConcreteGraphicsQuality, {
  radialStep: number;
  material: 'lambert' | 'standard';
}> = {
  // radialStep samples from the same high-detail smoothed perimeter.
  // Lower tiers keep every Nth point; higher tiers add the skipped
  // points so the coin follows the irregular resource-cell cluster
  // more closely without changing gameplay.
  min:    { radialStep: 12, material: 'lambert' },
  low:    { radialStep: 6, material: 'lambert' },
  medium: { radialStep: 3, material: 'lambert' },
  high:   { radialStep: 2, material: 'standard' },
  max:    { radialStep: 1, material: 'standard' },
};

const DEPOSIT_MAX_RADIAL_SEGMENTS = 96;
const DEPOSIT_PROFILE_SMOOTH_PASSES = 3;
const DEPOSIT_VISUAL_MARGIN = BUILD_GRID_CELL_SIZE * 0.16;
const DEPOSIT_ROCK_UV_WORLD_SIZE = 360;

const DEPOSIT_BASE = new THREE.Color(COLORS.environment.metalDeposit.baseColorHex);
const DEPOSIT_DARK = new THREE.Color(COLORS.environment.metalDeposit.darkColorHex);
const DEPOSIT_LIGHT = new THREE.Color(COLORS.environment.metalDeposit.lightColorHex);
export class MetalDepositRenderer3D {
  private group: THREE.Group;
  private deposits: ReadonlyArray<MetalDeposit>;
  private records: Array<{
    node: THREE.Group;
    tier: ConcreteGraphicsQuality | null;
  }> = [];
  private materials = new Map<string, THREE.Material>();

  constructor(
    parentWorld: THREE.Group,
    deposits: ReadonlyArray<MetalDeposit>,
    initialTier: ConcreteGraphicsQuality = 'medium',
  ) {
    this.deposits = deposits;
    this.group = new THREE.Group();
    parentWorld.add(this.group);
    this.records = [];
    this.buildAll(initialTier);
  }

  update(graphicsConfig: GraphicsConfig): void {
    if (this.deposits.length === 0) return;
    const tier = graphicsConfig.tier;
    for (let i = 0; i < this.deposits.length; i++) {
      const record = this.records[i];
      if (tier !== record.tier) this.setDepositTier(i, tier);
      record.node.visible = true;
      record.node.userData.graphicsTier = tier;
    }
  }

  private buildAll(tier: ConcreteGraphicsQuality): void {
    for (let i = 0; i < this.deposits.length; i++) {
      const node = this.buildDepositNode(i, tier);
      node.visible = true;
      this.records[i] = { node, tier };
      this.group.add(node);
    }
  }

  private setDepositTier(index: number, tier: ConcreteGraphicsQuality): void {
    const record = this.records[index];
    if (record.tier === tier) return;
    disposeDepositNode(record.node);
    this.group.remove(record.node);
    const next = this.buildDepositNode(index, tier);
    next.visible = true;
    this.group.add(next);
    record.node = next;
    record.tier = tier;
  }

  private buildDepositNode(index: number, tier: ConcreteGraphicsQuality): THREE.Group {
    const d = this.deposits[index];
    const meshDetail = DEPOSIT_MESH_BY_GRAPHICS_TIER[tier];
    const coinHeight = METAL_DEPOSIT_CONFIG.coinHeight;
    const node = new THREE.Group();
    const mesh = new THREE.Mesh(
      makeDepositCoinGeometry(d, meshDetail.radialStep, coinHeight),
      this.getMaterial(meshDetail.material),
    );
    node.add(mesh);
    // The mesh contains only the above-ground crown. Relying on the
    // terrain surface to hide below-ground triangles leaks at grazing
    // camera angles because the terrain is a surface, not a solid mask.
    node.position.set(d.x, d.height + 0.04, d.y);
    node.rotation.y = seededNoise(d.id * 991 + 13) * Math.PI * 2;
    node.userData.graphicsTier = tier;
    return node;
  }

  private getMaterial(kind: 'lambert' | 'standard'): THREE.Material {
    let material = this.materials.get(kind);
    if (!material) {
      material = makeDepositMaterial(kind);
      this.materials.set(kind, material);
    }
    return material;
  }

  dispose(): void {
    for (const record of this.records) {
      disposeDepositNode(record.node);
      this.group.remove(record.node);
      record.tier = null;
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

function makeDepositMaterial(kind: 'lambert' | 'standard'): THREE.Material {
  const rockMap = getRockDetailTexture();
  if (kind === 'standard') {
    return new THREE.MeshStandardMaterial({
      color: COLORS.environment.metalDeposit.standardMaterial.colorHex,
      map: rockMap,
      vertexColors: true,
      flatShading: COLORS.environment.metalDeposit.standardMaterial.flatShading,
      metalness: COLORS.environment.metalDeposit.standardMaterial.metalness,
      roughness: COLORS.environment.metalDeposit.standardMaterial.roughness,
    });
  }
  return new THREE.MeshLambertMaterial({
    color: COLORS.environment.metalDeposit.lambertMaterial.colorHex,
    map: rockMap,
    vertexColors: true,
    flatShading: COLORS.environment.metalDeposit.lambertMaterial.flatShading,
  });
}

/** Inset of the flat top face relative to the equator (sharp-edge)
 *  ring. The generated radial profile is shared by both rings so the
 *  bevel stays clean while the outline follows the smoothed irregular
 *  metal-cell cluster. 0.65 = top flat is 65% of the equator diameter. */
const COIN_FLAT_RADIUS_FRAC = 0.65;

function makeDepositCoinGeometry(
  deposit: MetalDeposit,
  radialStep: number,
  height: number,
): THREE.BufferGeometry {
  const radialIndices = makeRadialIndices(radialStep);
  const profile = makeSmoothedDepositProfile(deposit);
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const visibleHeight = height * 0.5;
  const seed = deposit.id;

  // Center vertex for the above-ground top flat-disk fan.
  const topCenter = 0;
  positions.push(0, visibleHeight, 0);
  pushDepositUv(uvs, 0, 0, seed);
  pushDepositColor(colors, seed, 0, 0.78);

  // Top rim — flat disk at y=visibleHeight, inset to COIN_FLAT_RADIUS_FRAC.
  const topStart = positions.length / 3;
  for (const i of radialIndices) {
    const p = profilePerimeterPoint(profile, i, COIN_FLAT_RADIUS_FRAC);
    positions.push(p.x, visibleHeight, p.z);
    pushDepositUv(uvs, p.x, p.z, seed);
    pushDepositColor(colors, seed, 1000 + i, 0.7 + seededNoise(seed * 521 + i * 31) * 0.18);
  }

  // Ground ridge — the widest edge sits just above the terrain pad.
  const equatorStart = positions.length / 3;
  for (const i of radialIndices) {
    const p = profilePerimeterPoint(profile, i, 1);
    positions.push(p.x, 0, p.z);
    pushDepositUv(uvs, p.x, p.z, seed);
    pushDepositColor(colors, seed, 1500 + i, 0.45 + seededNoise(seed * 467 + i * 23) * 0.2);
  }

  const n = radialIndices.length;
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const topA = topStart + i;
    const topB = topStart + next;
    const eqA = equatorStart + i;
    const eqB = equatorStart + next;

    // Top flat fan — face normal +Y.
    indices.push(topCenter, topB, topA);
    // Upper bevel — slants from the inset top rim down-and-out to
    // the ground ridge. Two triangles per segment, wound so the normal
    // points up-and-outward.
    indices.push(topA, topB, eqA, topB, eqB, eqA);
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

function makeSmoothedDepositProfile(deposit: MetalDeposit): number[] {
  const profile: number[] = [];
  for (let i = 0; i < DEPOSIT_MAX_RADIAL_SEGMENTS; i++) {
    const a = (i / DEPOSIT_MAX_RADIAL_SEGMENTS) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let radius = BUILD_GRID_CELL_SIZE * 0.5;
    for (const cell of deposit.cells) {
      const minX = cell.gx * BUILD_GRID_CELL_SIZE - deposit.x - DEPOSIT_VISUAL_MARGIN;
      const maxX = minX + BUILD_GRID_CELL_SIZE + DEPOSIT_VISUAL_MARGIN * 2;
      const minZ = cell.gy * BUILD_GRID_CELL_SIZE - deposit.y - DEPOSIT_VISUAL_MARGIN;
      const maxZ = minZ + BUILD_GRID_CELL_SIZE + DEPOSIT_VISUAL_MARGIN * 2;
      radius = Math.max(radius, rayRectExitDistance(dx, dz, minX, minZ, maxX, maxZ));
    }
    profile.push(radius);
  }

  let smoothed = profile;
  for (let pass = 0; pass < DEPOSIT_PROFILE_SMOOTH_PASSES; pass++) {
    const next = new Array<number>(DEPOSIT_MAX_RADIAL_SEGMENTS);
    for (let i = 0; i < DEPOSIT_MAX_RADIAL_SEGMENTS; i++) {
      const prev = smoothed[(i - 1 + DEPOSIT_MAX_RADIAL_SEGMENTS) % DEPOSIT_MAX_RADIAL_SEGMENTS];
      const curr = smoothed[i];
      const nextRadius = smoothed[(i + 1) % DEPOSIT_MAX_RADIAL_SEGMENTS];
      next[i] = prev * 0.23 + curr * 0.54 + nextRadius * 0.23;
    }
    smoothed = next;
  }
  return smoothed;
}

function rayRectExitDistance(
  dx: number,
  dz: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): number {
  let tMin = -Infinity;
  let tMax = Infinity;
  const eps = 1e-8;
  if (Math.abs(dx) < eps) {
    if (0 < minX || 0 > maxX) return 0;
  } else {
    const tx0 = minX / dx;
    const tx1 = maxX / dx;
    tMin = Math.max(tMin, Math.min(tx0, tx1));
    tMax = Math.min(tMax, Math.max(tx0, tx1));
  }
  if (Math.abs(dz) < eps) {
    if (0 < minZ || 0 > maxZ) return 0;
  } else {
    const tz0 = minZ / dz;
    const tz1 = maxZ / dz;
    tMin = Math.max(tMin, Math.min(tz0, tz1));
    tMax = Math.min(tMax, Math.max(tz0, tz1));
  }
  if (tMax < Math.max(0, tMin)) return 0;
  return Math.max(0, tMax);
}

function makeRadialIndices(step: number): number[] {
  const out: number[] = [];
  const stride = Math.max(1, Math.floor(step));
  for (let i = 0; i < DEPOSIT_MAX_RADIAL_SEGMENTS; i += stride) out.push(i);
  return out;
}

function profilePerimeterPoint(profile: readonly number[], i: number, scale: number): { x: number; z: number } {
  const a = (i / DEPOSIT_MAX_RADIAL_SEGMENTS) * Math.PI * 2;
  const radius = profile[i] * scale;
  return {
    x: Math.cos(a) * radius,
    z: Math.sin(a) * radius,
  };
}

function pushDepositUv(uvs: number[], x: number, z: number, seed: number): void {
  const offsetU = seededNoise(seed * 101 + 7);
  const offsetV = seededNoise(seed * 163 + 19);
  uvs.push(
    x / DEPOSIT_ROCK_UV_WORLD_SIZE + offsetU,
    z / DEPOSIT_ROCK_UV_WORLD_SIZE + offsetV,
  );
}

function pushDepositColor(colors: number[], seed: number, idx: number, height01: number): void {
  const spot = seededNoise(seed * 719 + idx * 37);
  const baseMix = 0.18 + Math.max(0, Math.min(1, height01)) * 0.36;
  const target = spot < 0.28 ? DEPOSIT_DARK : spot > 0.72 ? DEPOSIT_LIGHT : DEPOSIT_BASE;
  const color = DEPOSIT_BASE.clone().lerp(target, spot < 0.28 || spot > 0.72 ? 0.82 : baseMix);
  colors.push(color.r, color.g, color.b);
}
