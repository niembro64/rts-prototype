// MetalDepositRenderer3D — chunky low 3D ore mounds at each metal
// deposit. The terrain has been pre-flattened to each deposit's
// configured height inside flatRadius (see Terrain.setMetalDepositFlatZones),
// so the mounds sit cleanly on a level pad.
//
// The gameplay/logical area remains the circular flatRadius; this renderer
// intentionally draws a smaller irregular buried ellipsoid so deposits read
// as natural metal outcrops rather than clean UI discs.

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
  shape: 'circle' | 'sphere' | 'deposit';
  radialStep: number;
  verticalStep: number;
  radiusScale: number;
  heightScale: number;
  material: 'lambert' | 'standard';
  veinCount: number;
}> = {
  // Lowest tier: a flat, super-simple circle marker on the deposit's pad.
  // Reads as "ore here" from far camera distances without paying for any
  // 3D geometry. radialStep doubles as the circle's segment count.
  min:    { shape: 'circle',  radialStep: 8, verticalStep: 1, radiusScale: 1, heightScale: 1, material: 'lambert',  veinCount: 0 },
  low:    { shape: 'sphere',  radialStep: 8, verticalStep: 8, radiusScale: 1, heightScale: 1, material: 'lambert',  veinCount: 0 },
  medium: { shape: 'deposit', radialStep: 4, verticalStep: 4, radiusScale: 1, heightScale: 1, material: 'lambert',  veinCount: 0 },
  high:   { shape: 'deposit', radialStep: 2, verticalStep: 4, radiusScale: 1, heightScale: 1, material: 'standard', veinCount: 3 },
  // The previous distinct 'max' tier (radialStep:1, verticalStep:1, 14 veins,
  // brighter veinMax material) was overkill — visually indistinguishable
  // from 'high' at gameplay distances. Collapse it to match 'high' so
  // every camera-sphere band still resolves to a valid config without
  // paying for the extra geometry or the second vein material.
  max:    { shape: 'deposit', radialStep: 2, verticalStep: 4, radiusScale: 1, heightScale: 1, material: 'standard', veinCount: 3 },
};

// All deposit LODs are sampled from this same seed grid. Lower tiers keep
// every Nth point; higher tiers insert the skipped points, so the silhouette
// refines instead of reshuffling when crossing a camera-sphere boundary.
const DEPOSIT_MAX_RADIAL_SEGMENTS = 64;
const DEPOSIT_MAX_VERTICAL_SEGMENTS = 24;

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
    const r = METAL_DEPOSIT_CONFIG.markerRadius * lod.radiusScale;
    const node = new THREE.Group();
    const geom = lod.shape === 'circle'
      ? makeDepositCircleGeometry(r, lod.radialStep)
      : lod.shape === 'sphere'
        ? makeDepositMarkerSphereGeometry(d.id, r)
        : makeChunkyDepositGeometry(
            d.id,
            r,
            lod.radialStep,
            lod.verticalStep,
            lod.heightScale,
          );
    const mesh = new THREE.Mesh(geom, this.getMaterial(lod.material));
    node.add(mesh);
    if (lod.shape === 'deposit' && lod.veinCount > 0) {
      const veins = new THREE.LineSegments(
        makeDepositVeinGeometry(d.id, r, lod.heightScale, lod.veinCount),
        this.getMaterial('vein'),
      );
      node.add(veins);
    }
    node.position.set(d.x, d.height + 0.25, d.y);
    node.rotation.y = seededNoise(d.id * 991 + 13) * Math.PI * 2;
    node.userData.graphicsTier = tier;
    return node;
  }

  private getMaterial(kind: 'lambert' | 'standard' | 'vein'): THREE.Material {
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
    const mesh = obj as THREE.Mesh | THREE.LineSegments;
    mesh.geometry?.dispose();
  });
}

function seededNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function makeDepositMaterial(kind: 'lambert' | 'standard' | 'vein'): THREE.Material {
  if (kind === 'standard') {
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      metalness: 0.42,
      roughness: 0.58,
    });
  }
  if (kind === 'vein') {
    return new THREE.LineBasicMaterial({
      color: 0x909b9e,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
  }
  return new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    flatShading: true,
  });
}

function getDepositRadii(seed: number, radius: number, heightScale: number): {
  radiusX: number;
  radiusZ: number;
  verticalRadius: number;
  burial: number;
} {
  const radiusX = radius * (0.96 + seededNoise(seed * 17 + 5) * 0.22);
  const radiusZ = radius * (0.68 + seededNoise(seed * 23 + 9) * 0.22);
  const verticalRadius = Math.max(8, radius * heightScale * (0.34 + seededNoise(seed * 29 + 7) * 0.06));
  return { radiusX, radiusZ, verticalRadius, burial: verticalRadius * 0.18 };
}

function makeChunkyDepositGeometry(
  seed: number,
  radius: number,
  radialStep: number,
  verticalStep: number,
  heightScale: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const { radiusX, radiusZ, verticalRadius, burial } = getDepositRadii(seed, radius, heightScale);
  const radialIndices = makeRadialIndices(radialStep);
  const verticalIndices = makeVerticalIndices(verticalStep);

  for (const j of verticalIndices) {
    const v = j / DEPOSIT_MAX_VERTICAL_SEGMENTS;
    const phi = -Math.PI / 2 + v * Math.PI;
    const ringRadius = Math.max(0, Math.cos(phi));
    const height = Math.sin(phi);
    const verticalRough = 1 + (seededNoise(seed * 101 + j * 37) - 0.5) * 0.08;

    for (const i of radialIndices) {
      const a = (i / DEPOSIT_MAX_RADIAL_SEGMENTS) * Math.PI * 2;
      const rough =
        0.92 +
        seededNoise(seed * 211 + i * 19 + j * 43) * 0.18 +
        Math.sin(a * 3 + seed * 0.73 + j * 0.41) * 0.045 +
        Math.cos(a * 5 + seed * 1.41) * 0.035;
      const chip = seededNoise(seed * 397 + i * 31 + j * 17) > 0.86
        ? 0.82 + seededNoise(seed * 571 + i * 11 + j * 23) * 0.12
        : 1;
      const rr = Math.max(0.78, Math.min(1.08, rough * chip));
      const x = Math.cos(a) * radiusX * ringRadius * rr;
      const z = Math.sin(a) * radiusZ * ringRadius * rr;
      const y = verticalRadius * height * verticalRough - burial;
      positions.push(x, y, z);
      pushDepositColor(colors, seed, j * DEPOSIT_MAX_RADIAL_SEGMENTS + i, (height + 1) * 0.5);
    }
  }

  const indices: number[] = [];
  const radialCount = radialIndices.length;
  for (let y = 0; y < verticalIndices.length - 1; y++) {
    for (let x = 0; x < radialCount; x++) {
      const a = y * radialCount + x;
      const b = y * radialCount + ((x + 1) % radialCount);
      const c = (y + 1) * radialCount + x;
      const d = (y + 1) * radialCount + ((x + 1) % radialCount);
      indices.push(a, c, b, b, c, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function makeDepositCircleGeometry(radius: number, segments: number): THREE.BufferGeometry {
  // Simplest possible deposit marker: a flat lit disc lying on the
  // pad. Used at the lowest camera-sphere LOD so distant deposits
  // still read as "ore here" without paying for any 3D geometry.
  // Segment count is bounded low by the LOD config (typically 8).
  const geom = new THREE.CircleGeometry(radius, Math.max(6, segments | 0));
  geom.rotateX(-Math.PI / 2);
  // Per-vertex color attribute keeps the lambert material instance
  // shared with the higher tiers (they all use vertexColors: true).
  // Using a single deposit-base tone reads as a unified "metal pile"
  // patch from the far camera band.
  const position = geom.getAttribute('position');
  const colors: number[] = [];
  for (let i = 0; i < position.count; i++) {
    colors.push(DEPOSIT_BASE.r, DEPOSIT_BASE.g, DEPOSIT_BASE.b);
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geom;
}

function makeDepositMarkerSphereGeometry(seed: number, radius: number): THREE.BufferGeometry {
  // Lowest LOD is still a sphere-class proxy, but it must follow the
  // same half-buried, squashed deposit volume as the higher tiers.
  // A full radius-tall ball can cover the short metal extractor that
  // sits on the same pad, making the building look like it vanished.
  const { radiusX, radiusZ, verticalRadius, burial } = getDepositRadii(seed, radius, 1);
  const geom = new THREE.SphereGeometry(1, 8, 6);
  geom.scale(radiusX, verticalRadius, radiusZ);
  geom.translate(0, -burial, 0);
  const position = geom.getAttribute('position');
  const colors: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const height01 = Math.max(0, Math.min(1, (position.getY(i) + burial + verticalRadius) / (verticalRadius * 2)));
    pushDepositColor(colors, seed, i, height01);
  }
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geom;
}

function makeRadialIndices(step: number): number[] {
  const out: number[] = [];
  const stride = Math.max(1, Math.floor(step));
  for (let i = 0; i < DEPOSIT_MAX_RADIAL_SEGMENTS; i += stride) out.push(i);
  return out;
}

function makeVerticalIndices(step: number): number[] {
  const out: number[] = [];
  const stride = Math.max(1, Math.floor(step));
  for (let i = 0; i <= DEPOSIT_MAX_VERTICAL_SEGMENTS; i += stride) out.push(i);
  if (out[out.length - 1] !== DEPOSIT_MAX_VERTICAL_SEGMENTS) {
    out.push(DEPOSIT_MAX_VERTICAL_SEGMENTS);
  }
  return out;
}

function makeDepositVeinGeometry(
  seed: number,
  radius: number,
  heightScale: number,
  count: number,
): THREE.BufferGeometry {
  const { radiusX, radiusZ, verticalRadius, burial } = getDepositRadii(seed, radius, heightScale);
  const positions: number[] = [];
  const surfaceY = (x: number, z: number): number => {
    const nx = x / radiusX;
    const nz = z / radiusZ;
    const inside = Math.max(0, 1 - nx * nx - nz * nz);
    return verticalRadius * Math.sqrt(inside) - burial + 0.85;
  };

  for (let i = 0; i < count; i++) {
    const a = seededNoise(seed * 823 + i * 47) * Math.PI * 2;
    const r01 = 0.14 + seededNoise(seed * 911 + i * 53) * 0.56;
    const tangent = a + Math.PI / 2 + (seededNoise(seed * 677 + i * 31) - 0.5) * 0.8;
    const halfLen = radius * (0.08 + seededNoise(seed * 991 + i * 67) * 0.13);
    const cx = Math.cos(a) * radiusX * r01;
    const cz = Math.sin(a) * radiusZ * r01;
    const dx = Math.cos(tangent) * halfLen;
    const dz = Math.sin(tangent) * halfLen;
    const x0 = cx - dx;
    const z0 = cz - dz;
    const x1 = cx + dx;
    const z1 = cz + dz;
    positions.push(
      x0, surfaceY(x0, z0), z0,
      x1, surfaceY(x1, z1), z1,
    );
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geom;
}

function pushDepositColor(colors: number[], seed: number, idx: number, height01: number): void {
  const spot = seededNoise(seed * 719 + idx * 37);
  const baseMix = 0.18 + Math.max(0, Math.min(1, height01)) * 0.36;
  const target = spot < 0.28 ? DEPOSIT_DARK : spot > 0.72 ? DEPOSIT_LIGHT : DEPOSIT_BASE;
  const color = DEPOSIT_BASE.clone().lerp(target, spot < 0.28 || spot > 0.72 ? 0.82 : baseMix);
  colors.push(color.r, color.g, color.b);
}
