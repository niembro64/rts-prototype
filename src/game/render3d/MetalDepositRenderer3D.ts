// MetalDepositRenderer3D — chunky low 3D ore mounds at each metal
// deposit. The terrain has been pre-flattened to each deposit's
// configured height inside flatRadius (see Terrain.setMetalDepositFlatZones),
// so the mounds sit cleanly on a level pad.
//
// The gameplay/logical area remains the circular flatRadius; this renderer
// intentionally draws a smaller irregular buried ellipsoid so deposits read
// as natural metal outcrops rather than clean UI discs.

import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { MetalDeposit } from '../../metalDepositConfig';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';

const PLAYER_CLIENT_DEPOSIT_LOD: Record<ConcreteGraphicsQuality, {
  radialSegments: number;
  verticalSegments: number;
  radiusScale: number;
  heightScale: number;
  chunkiness: number;
  material: 'lambert' | 'standard';
}> = {
  min:    { radialSegments: 8,  verticalSegments: 3, radiusScale: 0.72, heightScale: 0.68, chunkiness: 0.45, material: 'lambert' },
  low:    { radialSegments: 12, verticalSegments: 4, radiusScale: 0.82, heightScale: 0.78, chunkiness: 0.65, material: 'lambert' },
  medium: { radialSegments: 18, verticalSegments: 5, radiusScale: 0.92, heightScale: 0.9,  chunkiness: 0.9,  material: 'standard' },
  high:   { radialSegments: 26, verticalSegments: 6, radiusScale: 0.98, heightScale: 1.0,  chunkiness: 1.12, material: 'standard' },
  max:    { radialSegments: 34, verticalSegments: 8, radiusScale: 1.04, heightScale: 1.08, chunkiness: 1.3,  material: 'standard' },
};

const DEPOSIT_BASE = new THREE.Color(0x272b2e);
const DEPOSIT_DARK = new THREE.Color(0x111416);
const DEPOSIT_LIGHT = new THREE.Color(0x6f7678);

export class MetalDepositRenderer3D {
  private group: THREE.Group;
  private deposits: ReadonlyArray<MetalDeposit>;
  private tier: ConcreteGraphicsQuality | null = null;
  private rockMeshes: THREE.Mesh[] = [];
  private material: THREE.Material | null = null;

  constructor(
    parentWorld: THREE.Group,
    deposits: ReadonlyArray<MetalDeposit>,
    initialTier: ConcreteGraphicsQuality = 'medium',
  ) {
    this.deposits = deposits;
    this.group = new THREE.Group();
    parentWorld.add(this.group);
    this.update(initialTier);
  }

  update(tier: ConcreteGraphicsQuality): void {
    if (tier === this.tier) return;
    this.clearMeshes();
    this.tier = tier;
    if (this.deposits.length > 0) this.build(tier);
  }

  private build(tier: ConcreteGraphicsQuality): void {
    const deposits = this.deposits;
    const lod = PLAYER_CLIENT_DEPOSIT_LOD[tier];
    const r = METAL_DEPOSIT_CONFIG.markerRadius * lod.radiusScale;
    this.material = makeDepositMaterial(lod.material);

    for (let i = 0; i < deposits.length; i++) {
      const d = deposits[i];
      const geom = makeChunkyDepositGeometry(
        d.id,
        r,
        lod.radialSegments,
        lod.verticalSegments,
        lod.heightScale,
        lod.chunkiness,
      );
      const mesh = new THREE.Mesh(geom, this.material);
      mesh.position.set(d.x, d.height + 0.25, d.y);
      mesh.rotation.y = seededNoise(d.id * 991 + 13) * Math.PI * 2;
      this.rockMeshes.push(mesh);
      this.group.add(mesh);
    }
  }

  private clearMeshes(): void {
    for (const mesh of this.rockMeshes) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.rockMeshes = [];
    this.material?.dispose();
    this.material = null;
  }

  dispose(): void {
    this.clearMeshes();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
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
  const radiusX = radius * (0.96 + seededNoise(seed * 17 + 5) * 0.22);
  const radiusZ = radius * (0.68 + seededNoise(seed * 23 + 9) * 0.22);
  const verticalRadius = Math.max(8, radius * heightScale * (0.34 + seededNoise(seed * 29 + 7) * 0.06));
  const burial = verticalRadius * 0.18;

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
      const rr = rough * chip;
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

function pushDepositColor(colors: number[], seed: number, idx: number, height01: number): void {
  const spot = seededNoise(seed * 719 + idx * 37);
  const baseMix = 0.18 + Math.max(0, Math.min(1, height01)) * 0.36;
  const target = spot < 0.28 ? DEPOSIT_DARK : spot > 0.72 ? DEPOSIT_LIGHT : DEPOSIT_BASE;
  const color = DEPOSIT_BASE.clone().lerp(target, spot < 0.28 || spot > 0.72 ? 0.82 : baseMix);
  colors.push(color.r, color.g, color.b);
}
