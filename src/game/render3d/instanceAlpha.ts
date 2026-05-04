// Per-instance "shell flag" for THREE.InstancedMesh — paints flagged
// instances as flat unlit pale gray while leaving every other
// instance to render normally (lit, team-colored, full material
// pipeline).
//
// The attribute is still named `instanceAlpha` for backwards-compat
// (legs, joints, and Render3DEntities all wrote into it under that
// name), and still carries a float per instance, but the values are
// now used as a binary flag:
//   - 1.0  → render normally (full Lambert / Standard / Basic shading,
//            instanceColor → team primary, etc).
//   - <1.0 → ignore lighting, paint with SHELL_PALE_RGB.
//
// Switching from "translucent ghost" to "flat unlit pale" sidesteps
// every transparency-related artefact (z-fighting, transparent-pass
// sort order, shared-material depth-write conflicts) — material stays
// opaque + depthWrite=true and completed instances render exactly as
// they did before per-instance shell support landed.
//
// Tunables live in @/shellConfig — this module is shape-only.

import * as THREE from 'three';
import { SHELL_PALE_RGB } from '@/shellConfig';

const _PATCHED_MATERIALS = new WeakSet<THREE.Material>();

/** Inline GLSL constant for the shell pale color. Built from
 *  @/shellConfig at module load so a single tweak to SHELL_PALE_RGB
 *  flows through every patched material. */
const _SHELL_PALE_GLSL =
  `vec3(${SHELL_PALE_RGB[0].toFixed(4)}, ${SHELL_PALE_RGB[1].toFixed(4)}, ${SHELL_PALE_RGB[2].toFixed(4)})`;

/** Patch a Material to read a per-instance `instanceAlpha` attribute
 *  and, for any instance whose value is below 1.0, override the final
 *  fragment color with SHELL_PALE_RGB — flat, unlit, no team tint, no
 *  reflection / specular contribution. Idempotent.
 *
 *  Material settings stay at their defaults (opaque, depthWrite=true,
 *  transparent=false). Completed instances render through the
 *  unmodified standard pipeline, so depth + sort + lighting all match
 *  what they did before per-instance shell support landed. */
export function enableInstanceAlphaOnMaterial(material: THREE.Material): void {
  if (_PATCHED_MATERIALS.has(material)) return;
  _PATCHED_MATERIALS.add(material);

  const previousOnBefore = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (previousOnBefore) previousOnBefore.call(material, shader, renderer);
    shader.vertexShader =
      'attribute float instanceAlpha;\nvarying float vInstanceAlpha;\n'
      + shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vInstanceAlpha = instanceAlpha;',
      );
    // After the standard fragment pipeline has finalised gl_FragColor
    // (with all the lighting / envmap / colorspace / tonemapping
    // chunks done), branch on the shell flag and replace with a flat
    // pale color when the instance is a shell. Completed instances
    // (vInstanceAlpha == 1.0) untouched.
    shader.fragmentShader =
      'varying float vInstanceAlpha;\n' + shader.fragmentShader;
    const overrideSnippet =
      '  if (vInstanceAlpha < 1.0) {\n'
      + `    gl_FragColor = vec4(${_SHELL_PALE_GLSL}, 1.0);\n`
      + '  }\n';
    if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\n' + overrideSnippet,
      );
    } else if (shader.fragmentShader.includes('#include <output_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <output_fragment>',
        '#include <output_fragment>\n' + overrideSnippet,
      );
    } else {
      shader.fragmentShader = shader.fragmentShader.replace(
        /\}\s*$/,
        overrideSnippet + '}',
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

/** Move the shell/normal flag when an InstancedMesh slot is compacted.
 *  Matrix + color copies alone are not enough: a reused slot that
 *  previously belonged to a construction shell can otherwise keep the
 *  pale-shell flag while drawing a completed unit. */
export function copyInstanceAlphaSlot(
  mesh: THREE.InstancedMesh,
  fromSlot: number,
  toSlot: number,
): void {
  const attr = mesh.geometry.attributes.instanceAlpha as
    | THREE.InstancedBufferAttribute
    | undefined;
  if (!attr) return;
  const arr = attr.array as Float32Array;
  if (arr[toSlot] === arr[fromSlot]) return;
  arr[toSlot] = arr[fromSlot];
  attr.needsUpdate = true;
}
