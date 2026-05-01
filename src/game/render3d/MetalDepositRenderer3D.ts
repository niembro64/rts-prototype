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
import { snapshotLod } from './Lod3D';
import { objectLodToGraphicsTier } from './RenderObjectLod';
import { RenderLodGrid } from './RenderLodGrid';

const PLAYER_CLIENT_DEPOSIT_LOD: Record<ConcreteGraphicsQuality, {
  radialSegments: number;
  verticalSegments: number;
  radiusScale: number;
  heightScale: number;
  chunkiness: number;
  material: 'lambert' | 'standard';
  veinCount: number;
}> = {
  min:    { radialSegments: 8,  verticalSegments: 3,  radiusScale: 1, heightScale: 1, chunkiness: 0.35, material: 'lambert',  veinCount: 0 },
  low:    { radialSegments: 12, verticalSegments: 4,  radiusScale: 1, heightScale: 1, chunkiness: 0.5,  material: 'lambert',  veinCount: 0 },
  medium: { radialSegments: 18, verticalSegments: 5,  radiusScale: 1, heightScale: 1, chunkiness: 0.7,  material: 'standard', veinCount: 3 },
  high:   { radialSegments: 28, verticalSegments: 7,  radiusScale: 1, heightScale: 1, chunkiness: 0.9,  material: 'standard', veinCount: 7 },
  max:    { radialSegments: 48, verticalSegments: 12, radiusScale: 1, heightScale: 1, chunkiness: 1.0,  material: 'standard', veinCount: 14 },
};

const DEPOSIT_BASE = new THREE.Color(0x272b2e);
const DEPOSIT_DARK = new THREE.Color(0x111416);
const DEPOSIT_LIGHT = new THREE.Color(0x6f7678);

export class MetalDepositRenderer3D {
  private group: THREE.Group;
  private deposits: ReadonlyArray<MetalDeposit>;
  private records: Array<{
    node: THREE.Group | null;
    tier: ConcreteGraphicsQuality | null;
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
    this.records = deposits.map(() => ({ node: null, tier: null }));
    this.buildAll(initialTier);
  }

  update(
    graphicsConfig: GraphicsConfig,
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
  ): void {
    if (this.deposits.length === 0) return;
    const lod = snapshotLod(camera, viewportHeightPx);
    this.lodGrid.beginFrame(lod.view, graphicsConfig);
    for (let i = 0; i < this.deposits.length; i++) {
      const d = this.deposits[i];
      const objectTier = this.lodGrid.resolve(d.x, d.height, d.y);
      const tier = objectLodToGraphicsTier(objectTier, graphicsConfig.tier);
      if (tier !== this.records[i].tier) this.rebuildDeposit(i, tier);
    }
  }

  private buildAll(tier: ConcreteGraphicsQuality): void {
    for (let i = 0; i < this.deposits.length; i++) this.rebuildDeposit(i, tier);
  }

  private rebuildDeposit(index: number, tier: ConcreteGraphicsQuality): void {
    const record = this.records[index];
    if (record.node) {
      disposeDepositNode(record.node);
      this.group.remove(record.node);
    }
    const d = this.deposits[index];
    const lod = PLAYER_CLIENT_DEPOSIT_LOD[tier];
    const r = METAL_DEPOSIT_CONFIG.markerRadius * lod.radiusScale;
    const node = new THREE.Group();
    const geom = makeChunkyDepositGeometry(
      d.id,
      r,
      lod.radialSegments,
      lod.verticalSegments,
      lod.heightScale,
      lod.chunkiness,
    );
    const mesh = new THREE.Mesh(geom, this.getMaterial(lod.material));
    node.add(mesh);
    if (lod.veinCount > 0) {
      const veins = new THREE.LineSegments(
        makeDepositVeinGeometry(d.id, r, lod.heightScale, lod.veinCount),
        this.getMaterial(tier === 'max' ? 'veinMax' : 'vein'),
      );
      node.add(veins);
    }
    node.position.set(d.x, d.height + 0.25, d.y);
    node.rotation.y = seededNoise(d.id * 991 + 13) * Math.PI * 2;
    record.node = node;
    record.tier = tier;
    this.group.add(node);
  }

  private getMaterial(kind: 'lambert' | 'standard' | 'vein' | 'veinMax'): THREE.Material {
    let material = this.materials.get(kind);
    if (!material) {
      material = makeDepositMaterial(kind);
      this.materials.set(kind, material);
    }
    return material;
  }

  dispose(): void {
    for (const record of this.records) {
      if (!record.node) continue;
      disposeDepositNode(record.node);
      this.group.remove(record.node);
      record.node = null;
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

function makeDepositMaterial(kind: 'lambert' | 'standard' | 'vein' | 'veinMax'): THREE.Material {
  if (kind === 'standard') {
    return new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      flatShading: true,
      metalness: 0.42,
      roughness: 0.58,
    });
  }
  if (kind === 'vein' || kind === 'veinMax') {
    return new THREE.LineBasicMaterial({
      color: kind === 'veinMax' ? 0xd2dde0 : 0x909b9e,
      transparent: true,
      opacity: kind === 'veinMax' ? 0.82 : 0.55,
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
  radialSegments: number,
  verticalSegments: number,
  heightScale: number,
  chunkiness: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const { radiusX, radiusZ, verticalRadius, burial } = getDepositRadii(seed, radius, heightScale);

  for (let j = 0; j <= verticalSegments; j++) {
    const v = j / verticalSegments;
    const phi = -Math.PI / 2 + v * Math.PI;
    const ringRadius = Math.max(0, Math.cos(phi));
    const height = Math.sin(phi);
    const verticalRough = 1 + (seededNoise(seed * 101 + j * 37) - 0.5) * 0.08 * chunkiness;

    for (let i = 0; i < radialSegments; i++) {
      const a = (i / radialSegments) * Math.PI * 2;
      const rough =
        0.92 +
        seededNoise(seed * 211 + i * 19 + j * 43) * 0.18 * chunkiness +
        Math.sin(a * 3 + seed * 0.73 + j * 0.41) * 0.045 * chunkiness +
        Math.cos(a * 5 + seed * 1.41) * 0.035 * chunkiness;
      const chip = seededNoise(seed * 397 + i * 31 + j * 17) > 0.86
        ? 0.82 + seededNoise(seed * 571 + i * 11 + j * 23) * 0.12
        : 1;
      const rr = Math.max(0.78, Math.min(1.08, rough * chip));
      const x = Math.cos(a) * radiusX * ringRadius * rr;
      const z = Math.sin(a) * radiusZ * ringRadius * rr;
      const y = verticalRadius * height * verticalRough - burial;
      positions.push(x, y, z);
      pushDepositColor(colors, seed, j * radialSegments + i, (height + 1) * 0.5);
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < verticalSegments; j++) {
    for (let i = 0; i < radialSegments; i++) {
      const a = j * radialSegments + i;
      const b = j * radialSegments + ((i + 1) % radialSegments);
      const c = (j + 1) * radialSegments + i;
      const d = (j + 1) * radialSegments + ((i + 1) % radialSegments);
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
