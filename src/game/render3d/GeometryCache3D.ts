import type * as THREE from 'three';

/** Owned lazy geometry cache with one canonical disposal path. */
export class GeometryCache3D<K, G extends THREE.BufferGeometry> {
  private readonly geometries = new Map<K, G>();

  constructor(private readonly create: (key: K) => G) {}

  get(key: K): G {
    let geometry = this.geometries.get(key);
    if (geometry === undefined) {
      geometry = this.create(key);
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
  }
}
