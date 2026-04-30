// MetalDepositRenderer3D — simple ground-disc markers at each metal
// deposit. The terrain has been pre-flattened to each deposit's
// configured height inside flatRadius (see Terrain.setMetalDepositFlatZones),
// so the disc sits cleanly on a level pad. One static InstancedMesh:
// one instance per deposit, never updated after init.
//
// Visual is intentionally restrained — a coppery emissive disc with a
// thin amber rim — so it reads as "claim this spot" without competing
// with capture-tile colors or building meshes for attention.

import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { MetalDeposit } from '../../metalDepositConfig';
import { METAL_DEPOSIT_CONFIG } from '../../metalDepositConfig';

const MARKER_LOD: Record<ConcreteGraphicsQuality, {
  discSegments: number;
  rimSegments: number;
  discOpacity: number;
  rimOpacity: number;
  radiusScale: number;
}> = {
  min:    { discSegments: 12, rimSegments: 0,  discOpacity: 0.55, rimOpacity: 0.00, radiusScale: 0.82 },
  low:    { discSegments: 20, rimSegments: 24, discOpacity: 0.68, rimOpacity: 0.65, radiusScale: 0.9 },
  medium: { discSegments: 32, rimSegments: 40, discOpacity: 0.78, rimOpacity: 0.82, radiusScale: 1.0 },
  high:   { discSegments: 48, rimSegments: 56, discOpacity: 0.85, rimOpacity: 0.92, radiusScale: 1.0 },
  max:    { discSegments: 64, rimSegments: 72, discOpacity: 0.88, rimOpacity: 0.98, radiusScale: 1.05 },
};

export class MetalDepositRenderer3D {
  private group: THREE.Group;
  private deposits: ReadonlyArray<MetalDeposit>;
  private tier: ConcreteGraphicsQuality | null = null;
  private discMesh: THREE.InstancedMesh | null = null;
  private rimMesh: THREE.InstancedMesh | null = null;

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
    const lod = MARKER_LOD[tier];
    const count = deposits.length;
    // Unit disc / annulus geometry — instance scale handles per-deposit radius.
    const discGeo = new THREE.CircleGeometry(1, lod.discSegments);
    const discMat = new THREE.MeshBasicMaterial({
      color: 0x6b3a1a,
      transparent: true,
      opacity: lod.discOpacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.discMesh = new THREE.InstancedMesh(discGeo, discMat, count);

    if (lod.rimOpacity > 0 && lod.rimSegments > 0) {
      const rimGeo = new THREE.RingGeometry(0.92, 1.0, lod.rimSegments);
      const rimMat = new THREE.MeshBasicMaterial({
        color: 0xffaa44,
        transparent: true,
        opacity: lod.rimOpacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.rimMesh = new THREE.InstancedMesh(rimGeo, rimMat, count);
    }

    const m = new THREE.Matrix4();
    const e = new THREE.Euler();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();

    // Marker radius is configured separately from flatRadius so the
    // visual doesn't reach all the way to the falloff edge — buildable
    // area extends past the marker.
    const r = METAL_DEPOSIT_CONFIG.markerRadius * lod.radiusScale;

    for (let i = 0; i < count; i++) {
      const d = deposits[i];
      // Lay the disc flat on the deposit's pad (rotate from xy-plane to xz-plane).
      e.set(-Math.PI / 2, 0, 0);
      q.setFromEuler(e);
      // Sit a hair above the pad height so it never z-fights with the
      // flattened terrain. Three.js Y = sim Z.
      pos.set(d.x, d.height + 0.5, d.y);
      scl.set(r, r, r);
      m.compose(pos, q, scl);
      this.discMesh.setMatrixAt(i, m);
      this.rimMesh?.setMatrixAt(i, m);
    }
    this.discMesh.instanceMatrix.needsUpdate = true;
    this.discMesh.count = count;
    if (this.rimMesh) {
      this.rimMesh.instanceMatrix.needsUpdate = true;
      this.rimMesh.count = count;
    }

    this.group.add(this.discMesh);
    if (this.rimMesh) this.group.add(this.rimMesh);
  }

  private clearMeshes(): void {
    if (this.discMesh) {
      this.discMesh.geometry.dispose();
      (this.discMesh.material as THREE.Material).dispose();
      this.group.remove(this.discMesh);
      this.discMesh = null;
    }
    if (this.rimMesh) {
      this.rimMesh.geometry.dispose();
      (this.rimMesh.material as THREE.Material).dispose();
      this.group.remove(this.rimMesh);
      this.rimMesh = null;
    }
  }

  dispose(): void {
    this.clearMeshes();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
