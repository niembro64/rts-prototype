// Per-instance alpha for THREE.InstancedMesh — the only practical way
// to render a SUBSET of instances translucent without splitting them
// into a separate mesh.
//
// How it works:
//   1. attachInstanceAlphaBuffer(mesh, capacity) adds a Float32 buffer
//      attribute named `instanceAlpha` (one float per instance, 1.0 by
//      default = fully opaque).
//   2. enableInstanceAlphaOnMaterial(mat) patches the shader via
//      onBeforeCompile so the fragment shader multiplies gl_FragColor.a
//      by the per-instance value, and flips the material into
//      transparent + depthWrite-off mode.
//   3. setInstanceAlphaSlot(mesh, slot, alpha) writes the per-slot
//      value and marks the buffer dirty.
//
// Used by Render3DEntities (smoothChassis / polyChassis / turret-head /
// barrel / mirror-panel / mass-unit InstancedMeshes) and by
// LegInstancedRenderer / Locomotion3D so a unit shell is uniformly
// translucent across every part regardless of which renderer drew it.
//
// Tunables (the actual SHELL alpha value, color tint, etc.) live in
// @/shellConfig — this module is shape-only.

import * as THREE from 'three';

const _PATCHED_MATERIALS = new WeakSet<THREE.Material>();

/** Patch a Material to read a per-instance `instanceAlpha` attribute
 *  and use it as a DITHERED-DISCARD threshold. Each fragment with
 *  `instanceAlpha < 1` may be discarded probabilistically based on a
 *  position-stable hash of its screen coordinate; fragments with
 *  `instanceAlpha == 1` always pass through.
 *
 *  Why dither and not alpha blending: alpha blending would force the
 *  shared material into THREE's transparent render pass with
 *  depthWrite OFF for ALL instances — even fully-opaque "complete"
 *  units. The result is z-fighting between completed units (they all
 *  draw in slot order, ignoring depth) and faint translucency
 *  artifacts on completed units. Dither lets the material stay opaque
 *  + depthWrite ON, so completed units render correctly while shells
 *  appear semi-transparent through fragment discard. Idempotent. */
export function enableInstanceAlphaOnMaterial(material: THREE.Material): void {
  if (_PATCHED_MATERIALS.has(material)) return;
  _PATCHED_MATERIALS.add(material);
  // Material stays opaque-by-default — see header comment for why we
  // intentionally don't flip `transparent` / `depthWrite` here.

  const previousOnBefore = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previousOnBefore) previousOnBefore.call(material, shader, renderer);
    shader.vertexShader =
      'attribute float instanceAlpha;\nvarying float vInstanceAlpha;\n'
      + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vInstanceAlpha = instanceAlpha;',
      );
    // Dithered-discard fragment pass. Hash the screen coordinate to a
    // pseudo-random [0..1] threshold; if `vInstanceAlpha` falls below
    // it, discard. For instances at alpha=1 the comparison is always
    // true (1 >= h) so nothing discards — completed units render fully
    // opaque, write depth, and sort correctly with each other.
    shader.fragmentShader =
      'varying float vInstanceAlpha;\n' + shader.fragmentShader;
    const ditherSnippet =
      '  {\n'
      + '    float _shellH = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);\n'
      + '    if (vInstanceAlpha < _shellH) discard;\n'
      + '  }\n';
    if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        ditherSnippet + '#include <opaque_fragment>',
      );
    } else if (shader.fragmentShader.includes('#include <output_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <output_fragment>',
        ditherSnippet + '#include <output_fragment>',
      );
    } else {
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {',
        'void main() {\n' + ditherSnippet,
      );
    }
  };
  material.needsUpdate = true;
}

/** Add (or no-op) a per-instance alpha buffer to an InstancedMesh's
 *  geometry. All slots default to 1.0 (fully opaque). */
export function attachInstanceAlphaBuffer(
  mesh: THREE.InstancedMesh,
  capacity: number,
): void {
  const geom = mesh.geometry;
  if (geom.attributes.instanceAlpha) return;
  const arr = new Float32Array(capacity);
  arr.fill(1.0);
  const attr = new THREE.InstancedBufferAttribute(arr, 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute('instanceAlpha', attr);
}

/** One-shot helper: attach the buffer AND patch the material. Most
 *  callsites want both done in lockstep at InstancedMesh creation. */
export function makeInstanceAlphaCapable(
  mesh: THREE.InstancedMesh,
  capacity: number,
): void {
  attachInstanceAlphaBuffer(mesh, capacity);
  if (Array.isArray(mesh.material)) {
    for (const m of mesh.material) enableInstanceAlphaOnMaterial(m);
  } else {
    enableInstanceAlphaOnMaterial(mesh.material);
  }
}

/** Write a per-slot alpha. No-op if the buffer hasn't been attached. */
export function setInstanceAlphaSlot(
  mesh: THREE.InstancedMesh,
  slot: number,
  alpha: number,
): void {
  const attr = mesh.geometry.attributes.instanceAlpha as
    | THREE.InstancedBufferAttribute
    | undefined;
  if (!attr) return;
  const arr = attr.array as Float32Array;
  if (arr[slot] === alpha) return;
  arr[slot] = alpha;
  attr.needsUpdate = true;
}
