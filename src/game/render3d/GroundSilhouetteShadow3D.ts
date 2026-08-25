import * as THREE from 'three';

/**
 * A ground shadow is matter blocking the sun, so only lit surface materials
 * participate. This excludes additive effects, debug lines, selection fills,
 * water, and invisible rig pivots while admitting the Lambert/Standard/Phong
 * materials used by units, buildings, and vegetation.
 */
export function materialCastsGroundSilhouette3D(material: THREE.Material): boolean {
  const lit = material as THREE.Material & {
    isMeshLambertMaterial?: boolean;
    isMeshStandardMaterial?: boolean;
    isMeshPhongMaterial?: boolean;
    isMeshToonMaterial?: boolean;
  };
  return material.visible && material.colorWrite !== false && (
    lit.isMeshLambertMaterial === true ||
    lit.isMeshStandardMaterial === true ||
    lit.isMeshPhongMaterial === true ||
    lit.isMeshToonMaterial === true
  );
}

export function meshCastsGroundSilhouette3D(mesh: THREE.Mesh): boolean {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some(materialCastsGroundSilhouette3D);
}

/** Mark a completed render assembly once, at build time. The depth pass then
 * projects the assembly's actual triangles; no hitbox circle or footprint
 * stand-in is involved. */
export function configureGroundSilhouetteCasterTree3D(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    mesh.castShadow = meshCastsGroundSilhouette3D(mesh);
  });
}

/** Shared instanced pools are not descendants of an individual entity root,
 * so their construction sites use this single-mesh form. */
export function configureGroundSilhouetteCaster3D(mesh: THREE.Mesh): void {
  mesh.castShadow = meshCastsGroundSilhouette3D(mesh);
}

export function configureGroundSilhouetteReceiver3D(mesh: THREE.Mesh): void {
  mesh.receiveShadow = true;
}
