// Per-entity "shell" material — a single shared gray translucent
// THREE.Material that we swap onto every Mesh inside a shell's group
// for the duration of construction. The original material is cached on
// each mesh's userData and restored when the shell completes (or is
// destroyed). All entities share one SHELL_MATERIAL instance, which
// means a half-built unit reads as a uniform gray ghost regardless of
// player color or chassis detail — matching the "colorless and halfway
// transparent" intent.

import * as THREE from 'three';

const SHELL_OPACITY = 0.45;
const SHELL_COLOR = 0xb8b8b8;

const _shellMaterial = new THREE.MeshBasicMaterial({
  color: SHELL_COLOR,
  transparent: true,
  opacity: SHELL_OPACITY,
  // depthWrite OFF so the shell doesn't punch a hole in the depth
  // buffer that fully-built neighbours would clip against.
  depthWrite: false,
  // A visible silhouette from any angle (interior + exterior of a
  // body sphere reads consistently when transparent).
  side: THREE.DoubleSide,
});

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
    // instances, including non-shell ones. Shell appearance for
    // instanced units is a follow-up concern.
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
