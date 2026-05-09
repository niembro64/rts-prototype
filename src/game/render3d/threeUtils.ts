// Shared three.js disposal / texture-setup helpers.
//
// Renderers across this directory used to repeat the same
// detach-and-dispose triplet — `mesh.parent?.remove(mesh);
// mesh.dispose?.(); material.dispose(); geometry.dispose();` — once
// per pool destroy method, with cosmetic differences in field
// aliasing (`this.mat` vs `this.mesh.material`). Centralizing the
// triplet here keeps the dispose order consistent and gives a single
// spot to add new render-resource cleanup steps if the engine grows.

import * as THREE from 'three';

/** Object3D variants that own a material + geometry pair the
 *  renderer is responsible for disposing. Typed loosely so this
 *  helper accepts InstancedMesh, Mesh, Sprite, Points, Line, etc. */
type DisposableMesh = THREE.Object3D & {
  /** Optional because `THREE.Mesh` doesn't have it; `THREE.InstancedMesh`
   *  does. We call it only when present. */
  dispose?: () => void;
  material?: THREE.Material | THREE.Material[];
  geometry?: THREE.BufferGeometry;
};

/** Detach `mesh` from its parent (if any), then dispose the mesh
 *  itself, its material(s), and its geometry. Each step is guarded
 *  so the helper handles meshes whose `dispose()` doesn't exist
 *  (`THREE.Mesh`) and meshes that don't own one of the pair (e.g. a
 *  shared module-level geometry). Pass `{ material: false }` or
 *  `{ geometry: false }` to skip the disposal of resources this
 *  renderer doesn't own. */
export function disposeMesh(
  mesh: DisposableMesh,
  options?: { material?: boolean; geometry?: boolean },
): void {
  mesh.parent?.remove(mesh);
  mesh.dispose?.();
  if (options?.material !== false) {
    const m = mesh.material;
    if (Array.isArray(m)) {
      for (const mat of m) mat.dispose();
    } else if (m) {
      m.dispose();
    }
  }
  if (options?.geometry !== false) {
    mesh.geometry?.dispose();
  }
}
