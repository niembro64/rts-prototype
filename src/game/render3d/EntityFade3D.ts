// EntityFade3D — the one shared materialization-fade flow for every
// entity kind (units, towers, buildings, turrets).
//
// "Construction mirrors destruction": a single per-piece opacity channel
// runs 0 -> 1 as an entity is built and 1 -> 0 as it dies. Per the design
// philosophy ("Materialization: build-in and death-out are one reversible
// opacity channel") it is realized as actual alpha, so every renderer uses
// the same continuous opacity fade instead of a stippled dissolve.
//
// The alpha patch, the death-linger lifecycle, and the build-in opacity
// math live here so units and buildings share one implementation rather
// than duplicating it across renderers. Only the GPU feeder differs by
// render backend:
//   - instanced pools  → per-instance `aFade` attribute  (units)
//   - per-Mesh objects → per-object `uFade` uniform clone (buildings)
// both of which drive the identical alpha fade below.

import * as THREE from 'three';
import type { EntityId } from '../sim/types';
import { UNIT_DEATH_FADE_MS } from '@/visionConfig';

/** Shared death-out fade duration (ms). Build-in is driven by the sim's
 *  build fraction, so only the cosmetic death fade needs a clock. Sourced
 *  from visionConfig.json (`deathFadeMs`) alongside the leaving-vision and
 *  entering-vision fade durations. */
export const ENTITY_DEATH_FADE_MS = UNIT_DEATH_FADE_MS;

// -- The one fragment alpha patch both backends emit -------------------
const FADE_FRAGMENT_COMMON = ['varying float vFade;', '#include <common>'].join('\n');
const FADE_FRAGMENT_ALPHA = [
  'diffuseColor.a *= clamp(vFade, 0.0, 1.0);',
  '#include <opaque_fragment>',
].join('\n');

function injectFadeFragment(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', FADE_FRAGMENT_COMMON)
    .replace('#include <opaque_fragment>', FADE_FRAGMENT_ALPHA);
}

/** Patch a material so each INSTANCE's `aFade` attribute drives the fade.
 *  Used by the shared unit instanced pools. Custom ShaderMaterials are
 *  self-faded: they declare and apply `aFade` in their own source (the
 *  include-anchor rewrites below would find nothing to patch, and the
 *  transparent/depthWrite flags are the material author's call). */
export function patchInstancedFadeMaterial(material: THREE.Material): void {
  if ((material as THREE.ShaderMaterial).isShaderMaterial === true) return;
  material.transparent = true;
  material.depthWrite = true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        ['attribute float aFade;', 'varying float vFade;', '#include <common>'].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        ['#include <begin_vertex>', 'vFade = aFade;'].join('\n'),
      );
    injectFadeFragment(shader);
  };
  // Share one program across every instanced-faded material, distinct
  // from unpatched and per-object-faded materials.
  material.customProgramCacheKey = () => 'entityFadeInstancedAlpha';
  material.needsUpdate = true;
}

type PerObjectFade = {
  material: THREE.Material;
  setFade(value: number): void;
};

// Per-object fade clones each carry their own `uFade` uniform object, but
// Three stores uniforms per material, not per WebGLProgram. The shader source
// is identical for every clone of the same base variant, so use a stable cache
// key and let those clones share one compiled program. Otherwise construction
// and death fades can compile/link one shader per mesh during gameplay.
const PER_OBJECT_FADE_CACHE_KEY = 'entityFadePerObjectAlpha';

/** Clone a material and patch the clone so a per-object `uFade` uniform
 *  drives the fade. Leaves the (often shared) base material untouched, so
 *  fading one per-Mesh object never bleeds onto others. Used for the
 *  per-Mesh building / tower render path. */
function makePerObjectFadeMaterial(base: THREE.Material): PerObjectFade {
  if ((base as THREE.ShaderMaterial).isShaderMaterial === true) {
    return makeShaderPerObjectFadeMaterial(base as THREE.ShaderMaterial);
  }

  const baseCacheKey = base.customProgramCacheKey();
  const material = base.clone();
  material.transparent = true;
  material.depthWrite = true;
  const uFade = { value: 1 };
  const cacheKey = `${PER_OBJECT_FADE_CACHE_KEY}:${baseCacheKey}`;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    shader.uniforms.uFade = uFade;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        ['uniform float uFade;', 'varying float vFade;', '#include <common>'].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        ['#include <begin_vertex>', 'vFade = uFade;'].join('\n'),
      );
    injectFadeFragment(shader);
  };
  material.customProgramCacheKey = () => cacheKey;
  material.needsUpdate = true;
  return { material, setFade: (value: number): void => { uFade.value = value; } };
}

function makeShaderPerObjectFadeMaterial(base: THREE.ShaderMaterial): PerObjectFade {
  const baseCacheKey = base.customProgramCacheKey();
  const material = base.clone();
  material.transparent = true;
  material.depthWrite = true;
  const uFade = { value: 1 };
  material.uniforms = {
    ...material.uniforms,
    uFade,
  };
  material.fragmentShader = `uniform float uFade;\n${material.fragmentShader.replace(
    /gl_FragColor\s*=\s*([^;]+);/g,
    'gl_FragColor = $1;\n  gl_FragColor.a *= clamp(uFade, 0.0, 1.0);',
  )}`;
  material.customProgramCacheKey = () => `${PER_OBJECT_FADE_CACHE_KEY}:shader:${baseCacheKey}`;
  material.needsUpdate = true;
  return { material, setFade: (value: number): void => { uFade.value = value; } };
}

type FadeMeshCache = {
  /** The real (shared) material this mesh renders with when fully built.
   *  Captured the frame the mesh first enters a fade so the per-object
   *  clone can be restored to it. */
  _fadeReal?: THREE.Material;
  /** Lazily-built per-object fade clone wrapping `_fadeReal`. Reused
   *  across frames; rebuilt only when the real material instance changes
   *  (team recolor, ghost, engaged head). */
  _fadeHandle?: PerObjectFade;
};

function fadeMeshMaterial(mesh: THREE.Mesh, fade: number): void {
  const ud = mesh.userData as FadeMeshCache;
  if (fade >= 1) {
    // Fully built: restore the real material and stop paying the patch.
    if (ud._fadeReal !== undefined) {
      mesh.material = ud._fadeReal;
      ud._fadeReal = undefined;
    }
    return;
  }
  const handle = ud._fadeHandle;
  // Clone already applied (untouched since last frame): just set the value.
  if (handle !== undefined && mesh.material === handle.material) {
    handle.setFade(fade);
    return;
  }
  // Otherwise `mesh.material` is currently the real material. Reuse the
  // existing clone iff it wraps that same real instance; rebuild only when
  // the real material actually changed.
  const current = mesh.material;
  if (Array.isArray(current)) return; // multi-material meshes not faded
  if (handle !== undefined && ud._fadeReal === current) {
    mesh.material = handle.material;
    handle.setFade(fade);
    return;
  }
  ud._fadeReal = current;
  handle?.material.dispose();
  ud._fadeHandle = makePerObjectFadeMaterial(current);
  mesh.material = ud._fadeHandle.material;
  ud._fadeHandle.setFade(fade);
}

/** Apply a uniform materialization fade to every per-Mesh object under a
 *  group (buildings/towers and their turrets). At fade>=1 every mesh is
 *  restored to its real material, so finished entities pay nothing.
 *  InstancedMesh objects are skipped — they fade through their own
 *  per-instance `aFade` attribute. */
export function applyEntityGroupFade(group: THREE.Object3D, fade: number): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    if ((obj as THREE.InstancedMesh).isInstancedMesh === true) return;
    fadeMeshMaterial(mesh, fade);
  });
}

/** Restore real materials and dispose every per-object fade clone under a
 *  group — call on entity teardown so clones don't leak. */
export function disposeEntityGroupFade(group: THREE.Object3D): void {
  group.traverse((obj) => {
    const ud = obj.userData as FadeMeshCache;
    if (ud._fadeHandle !== undefined) {
      if (ud._fadeReal !== undefined) (obj as THREE.Mesh).material = ud._fadeReal;
      ud._fadeHandle.material.dispose();
      ud._fadeHandle = undefined;
      ud._fadeReal = undefined;
    }
  });
}

/** Generic death-out lifecycle: hold a dead entity's mesh, ramp its fade
 *  1 → 0 over `durationMs`, then tear it down. Backend-agnostic — the
 *  caller supplies how to apply the fade and how to finally free the mesh,
 *  so units (instanced) and buildings (per-Mesh) share one implementation.
 */
export class DyingMeshFade<TMesh> {
  private readonly dying = new Map<EntityId, { mesh: TMesh; fade: number }>();

  constructor(
    private readonly durationMs: number,
    private readonly applyFade: (mesh: TMesh, fade: number, dtMs: number) => void,
    private readonly teardown: (id: EntityId, mesh: TMesh) => void,
  ) {}

  get size(): number {
    return this.dying.size;
  }

  has(id: EntityId): boolean {
    return this.dying.has(id);
  }

  /** Begin (or restart) a mesh's death fade at full opacity. */
  markDying(id: EntityId, mesh: TMesh): void {
    this.dying.set(id, { mesh, fade: 1 });
  }

  /** Tear down a dying mesh immediately (e.g. its id reappeared). */
  finalize(id: EntityId): void {
    const d = this.dying.get(id);
    if (d === undefined) return;
    this.teardown(id, d.mesh);
    this.dying.delete(id);
  }

  /** Advance every fade by `dtMs`; free meshes whose fade has run out. */
  update(dtMs: number): void {
    if (this.dying.size === 0) return;
    for (const [id, d] of this.dying) {
      d.fade -= dtMs / this.durationMs;
      if (d.fade <= 0) {
        this.teardown(id, d.mesh);
        this.dying.delete(id);
      } else {
        this.applyFade(d.mesh, d.fade, dtMs);
      }
    }
  }

  destroyAll(): void {
    for (const [id, d] of this.dying) this.teardown(id, d.mesh);
    this.dying.clear();
  }
}
