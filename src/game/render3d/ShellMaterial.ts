// Per-entity "shell" material — a single shared FLAT UNLIT pale
// THREE.Material that we swap onto every Mesh inside a shell's group
// for the duration of construction. The original material is cached on
// each mesh's userData and restored when the shell completes (or is
// destroyed). MeshBasicMaterial is unlit by definition — same flat
// color regardless of sun direction, normals, or material setup —
// which is exactly the "no reflections / no shading / no team color"
// look we want for an in-progress shell. Translucent (50% opacity)
// with depthWrite=true so the silhouette still reads but completed
// internals show through faintly.
//
// All shell-render colour tuning lives in @/shellConfig. Instanced
// render paths use ordinary instance colors; this file is only for
// Mesh objects that own their material.

import * as THREE from 'three';
import { SHELL_PALE_HEX } from '@/shellConfig';

export function createShellMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: SHELL_PALE_HEX,
    transparent: true,
    opacity: 0.5,
    depthWrite: true,
    // Render BOTH sides of every face — chassis sphere geometries are
    // single-sided, but with the shell material's flat colour both
    // sides reading the same is the cleaner visual.
    side: THREE.DoubleSide,
  });
}

const _shellMaterial = createShellMaterial();

type ShellCache = {
  /** Original material captured the first frame this mesh entered
   *  shell state. Restored on the first frame the shell is no longer
   *  in shell state. */
  _shellOrig?: THREE.Material | THREE.Material[];
};

/** Walk the entity's THREE.Group and apply (or restore) the shared
 *  shell material on every Mesh-like object that owns its own
 *  material. InstancedMesh objects are skipped — their materials are
 *  shared across many entities and overriding them would tint
 *  bystander entities. Idempotent: safe to call every frame. */
export function applyShellOverride(group: THREE.Object3D, isShell: boolean): void {
  group.traverse((obj) => {
    if (!isMaterialBearing(obj)) return;
    // Don't touch InstancedMesh — its material is shared across all
    // instances, including non-shell ones. Instanced shell appearance
    // is handled by instanceColor writes in Render3DEntities.
    if ((obj as THREE.InstancedMesh).isInstancedMesh) return;
    const cache = obj.userData as ShellCache;
    if (isShell) {
      if (cache._shellOrig === undefined) {
        cache._shellOrig = (obj as THREE.Mesh).material;
      }
      (obj as THREE.Mesh).material = _shellMaterial;
    } else if (cache._shellOrig !== undefined) {
      (obj as THREE.Mesh).material = cache._shellOrig;
      cache._shellOrig = undefined;
    }
  });
}

function isMaterialBearing(obj: THREE.Object3D): obj is THREE.Mesh {
  return (
    (obj as THREE.Mesh).isMesh === true ||
    (obj as unknown as { isLine?: boolean }).isLine === true ||
    (obj as unknown as { isPoints?: boolean }).isPoints === true
  );
}
