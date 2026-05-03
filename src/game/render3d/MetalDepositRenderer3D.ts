// MetalDepositRenderer3D — chunky low 3D ore deposits at each metal
// deposit. The terrain has been pre-flattened to each deposit's
// configured height inside its circular flat pad
// (see Terrain.setMetalDepositFlatZones), while the visual marker
// shares the logical square resource footprint.
//
// The gameplay/logical area is a square build-cell footprint; this renderer
// draws one flattened irregular ore marker. Higher LODs keep
// more of the same deterministic perimeter samples, so the outline refines
// without adding a second mound/cap shape.

import * as THREE from 'three';
import type { ConcreteGraphicsQuality, GraphicsConfig } from '@/types/graphics';
import type { MetalDeposit } from '../../metalDepositConfig';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';
import type { Lod3DState } from './Lod3D';
import {
  objectLodToCameraSphereGraphicsTier,
  type RenderObjectLodTier,
} from './RenderObjectLod';
import { RenderLodGrid } from './RenderLodGrid';

const PLAYER_CLIENT_DEPOSIT_LOD: Record<ConcreteGraphicsQuality, {
  radialStep: number;
  radiusScale: number;
  material: 'lambert' | 'standard';
}> = {
  // radialStep samples from the same 64-point perimeter seed grid.
  // Lower tiers keep every Nth point; higher tiers add the skipped
  // points so the coin becomes more naturally jagged without changing
  // its logical footprint or drawing extra overlays.
  min:    { radialStep: 8, radiusScale: 1, material: 'lambert' },
  low:    { radialStep: 4, radiusScale: 1, material: 'lambert' },
  medium: { radialStep: 2, radiusScale: 1, material: 'lambert' },
  high:   { radialStep: 1, radiusScale: 1, material: 'standard' },
  max:    { radialStep: 1, radiusScale: 1, material: 'standard' },
};

// All deposit LODs are sampled from this same seed grid. Lower tiers keep
// every Nth point; higher tiers insert the skipped points, so the silhouette
// refines instead of reshuffling when crossing a camera-sphere boundary.
const DEPOSIT_MAX_RADIAL_SEGMENTS = 64;

const DEPOSIT_BASE = new THREE.Color(0x272b2e);
const DEPOSIT_DARK = new THREE.Color(0x111416);
const DEPOSIT_LIGHT = new THREE.Color(0x6f7678);
const DEPOSIT_LOD_TIERS: readonly ConcreteGraphicsQuality[] = [
  'min',
  'low',
  'medium',
  'high',
  'max',
];

type DepositLodNodeMap = Partial<Record<ConcreteGraphicsQuality, THREE.Group>>;

export class MetalDepositRenderer3D {
  private group: THREE.Group;
  private deposits: ReadonlyArray<MetalDeposit>;
  private records: Array<{
    nodes: DepositLodNodeMap;
    tier: ConcreteGraphicsQuality | null;
    objectTier: RenderObjectLodTier | null;
  }> = [];
  private materials = new Map<string, THREE.Material>();
  private lodGrid = new RenderLodGrid();

  constructor(
    parentWorld: THREE.Group,
    deposits: ReadonlyArray<MetalDeposit>,
    initialTier: ConcreteGraphicsQuality = 'medium',
  ) {
    this.deposits = deposits;
    this.group = new THREE.Group();
    parentWorld.add(this.group);
    this.records = deposits.map(() => ({ nodes: {}, tier: null, objectTier: null }));
    this.buildAll(initialTier);
  }

  update(
    graphicsConfig: GraphicsConfig,
    lod: Lod3DState,
    sharedLodGrid?: RenderLodGrid,
  ): void {
    if (this.deposits.length === 0) return;
    const lodGrid = sharedLodGrid ?? this.lodGrid;
    if (!sharedLodGrid) lodGrid.beginFrame(lod.view, graphicsConfig);
    for (let i = 0; i < this.deposits.length; i++) {
      const d = this.deposits[i];
      const record = this.records[i];
      const objectTier = lodGrid.resolve(d.x, d.height, d.y);
      record.objectTier = objectTier;
      // Metal deposits are terrain resources, not rich actor graphs.
      // Their mesh detail should visibly follow the camera-sphere band
      // itself; the global PLAYER CLIENT LOD already changes the sphere
      // radii. Capping this by global tier made all visible deposits look
      // identical at MIN/LOW and read as "not responding" to the rings.
      const tier = objectLodToCameraSphereGraphicsTier(objectTier);
      if (tier !== record.tier) this.setDepositTier(i, tier);
      const node = record.nodes[tier];
      if (node) {
        node.visible = true;
        node.userData.objectLodTier = objectTier;
        node.userData.graphicsTier = tier;
      }
    }
  }

  private buildAll(tier: ConcreteGraphicsQuality): void {
    for (let i = 0; i < this.deposits.length; i++) {
      const record = this.records[i];
      for (const lodTier of DEPOSIT_LOD_TIERS) {
        const node = this.buildDepositNode(i, lodTier);
        node.visible = lodTier === tier;
        record.nodes[lodTier] = node;
        this.group.add(node);
      }
      record.tier = tier;
    }
  }

  private setDepositTier(index: number, tier: ConcreteGraphicsQuality): void {
    const record = this.records[index];
    if (record.tier === tier) return;
    if (record.tier) {
      const previous = record.nodes[record.tier];
      if (previous) previous.visible = false;
    }
    const next = record.nodes[tier];
    if (next) next.visible = true;
    record.tier = tier;
  }

  private buildDepositNode(index: number, tier: ConcreteGraphicsQuality): THREE.Group {
    const d = this.deposits[index];
    const lod = PLAYER_CLIENT_DEPOSIT_LOD[tier];
    const r = d.resourceHalfSize * lod.radiusScale;
    const coinHeight = METAL_DEPOSIT_CONFIG.coinHeight;
    const node = new THREE.Group();
    const mesh = new THREE.Mesh(
      makeDepositCoinGeometry(d.id, r, lod.radialStep, coinHeight),
      this.getMaterial(lod.material),
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
      for (const tier of DEPOSIT_LOD_TIERS) {
        const node = record.nodes[tier];
        if (!node) continue;
        disposeDepositNode(node);
        this.group.remove(node);
        delete record.nodes[tier];
      }
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
  if (kind === 'standard') {
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      metalness: 0.42,
      roughness: 0.58,
    });
  }
  return new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    flatShading: true,
  });
}

/** Inset of the flat top and bottom faces relative to the equator
 *  (sharp-edge) ring. The base profile is a beveled lens: a sharp
 *  ridge runs all the way around the coin's widest circle at half
 *  height, with the flat top and bottom inset to this fraction of the
 *  equator radius. Higher-LOD irregularities ride on top of this
 *  profile via the same `coinPerimeterPoint` rough/chip pattern,
 *  scaled identically for every ring so the bevel angle stays clean
 *  while the silhouette stays varied. 0.65 = top/bottom flats are 65%
 *  the diameter of the equator ridge. */
const COIN_FLAT_RADIUS_FRAC = 0.65;

function makeDepositCoinGeometry(
  seed: number,
  radius: number,
  radialStep: number,
  height: number,
): THREE.BufferGeometry {
  const radialIndices = makeRadialIndices(radialStep);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const visibleHeight = height * 0.5;

  // Center vertex for the above-ground top flat-disk fan.
  const topCenter = 0;
  positions.push(0, visibleHeight, 0);
  pushDepositColor(colors, seed, 0, 0.78);

  // Top rim — flat disk at y=visibleHeight, inset to COIN_FLAT_RADIUS_FRAC.
  const topStart = positions.length / 3;
  for (const i of radialIndices) {
    const p = coinPerimeterPoint(seed, radius * COIN_FLAT_RADIUS_FRAC, i);
    positions.push(p.x, visibleHeight, p.z);
    pushDepositColor(colors, seed, 1000 + i, 0.7 + seededNoise(seed * 521 + i * 31) * 0.18);
  }

  // Ground ridge — the widest edge sits just above the terrain pad.
  const equatorStart = positions.length / 3;
  for (const i of radialIndices) {
    const p = coinPerimeterPoint(seed, radius, i);
    positions.push(p.x, 0, p.z);
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
  indexed.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  indexed.setIndex(indices);
  const geom = indexed.toNonIndexed();
  indexed.dispose();
  geom.computeVertexNormals();
  return geom;
}

function makeRadialIndices(step: number): number[] {
  const out: number[] = [];
  const stride = Math.max(1, Math.floor(step));
  for (let i = 0; i < DEPOSIT_MAX_RADIAL_SEGMENTS; i += stride) out.push(i);
  return out;
}

function coinPerimeterPoint(seed: number, radius: number, i: number): { x: number; z: number } {
  const a = (i / DEPOSIT_MAX_RADIAL_SEGMENTS) * Math.PI * 2;
  const rough =
    0.9 +
    seededNoise(seed * 211 + i * 19) * 0.2 +
    Math.sin(a * 3 + seed * 0.73) * 0.06 +
    Math.cos(a * 5 + seed * 1.41) * 0.045;
  const chip = seededNoise(seed * 397 + i * 31) > 0.84
    ? 0.78 + seededNoise(seed * 571 + i * 11) * 0.16
    : 1;
  const rr = Math.max(0.76, Math.min(1, rough * chip));
  return {
    x: Math.cos(a) * radius * rr,
    z: Math.sin(a) * radius * rr,
  };
}

function pushDepositColor(colors: number[], seed: number, idx: number, height01: number): void {
  const spot = seededNoise(seed * 719 + idx * 37);
  const baseMix = 0.18 + Math.max(0, Math.min(1, height01)) * 0.36;
  const target = spot < 0.28 ? DEPOSIT_DARK : spot > 0.72 ? DEPOSIT_LIGHT : DEPOSIT_BASE;
  const color = DEPOSIT_BASE.clone().lerp(target, spot < 0.28 || spot > 0.72 ? 0.82 : baseMix);
  colors.push(color.r, color.g, color.b);
}
