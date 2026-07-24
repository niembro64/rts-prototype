// EntityFade3D — the one shared materialization flow for every entity
// kind (units, towers, buildings, turrets).
//
// Two presentation channels live here, both consumed by the same
// per-object material clone:
//
//  1. FADE — a plain alpha multiplier. Death-out runs 1 -> 0, the
//     vision fade-in eases newly-seen entities in, and finished
//     entities sit at 1 where the real material is restored for free.
//
//  2. BUILD — the BAR-faithful nanoframe. While an entity's build
//     fraction is below 1 its body is drawn as Beyond All Reason draws
//     a unit under construction:
//       - fraction 0 (queued, nothing paid): the whole model renders
//         as a translucent team-tinted ghost (BAR's queued-build ghost
//         at 24% alpha).
//       - fraction 0..1: the model materializes bottom-to-top through
//         four rising height bands at pow(progress, {3, 1.5, 0.7,
//         0.35}) — finished material below the lowest band, pulsing
//         team tint between bands, flat translucent team color above
//         the highest — with white scan lines climbing at each band
//         and a pulsing team-colored construction grid (world lattice
//         + a model grid that shrinks as progress rises) that fades
//         out over the final 5%.
//     The band math, colors, and thresholds are data in
//     constructionVisualConfig.json (`nanoframe`), compiled into one
//     shared program.
//
// Only the GPU feeder differs by render backend:
//   - instanced pools  → per-instance `aFade` attribute (units): these
//     carry the BAR translucency *curve* (ghost alpha → top-alpha
//     floor → 1) baked into the fade value by the render-state
//     builders, not the per-fragment bands.
//   - per-Mesh objects → per-object uniform clones (buildings and
//     full-detail unit bodies): full nanoframe bands.

import * as THREE from 'three';
import type { EntityId } from '../sim/types';
import { IndexedEntityIdMap } from '../network/IndexedEntityIdCollections';
import { UNIT_DEATH_FADE_MS } from '@/visionConfig';
import { NANOFRAME_VISUAL_CONFIG } from '@/constructionVisualConfig';
import { getBuildAlphaForFraction } from '../sim/buildableHelpers';

/** Shared death-out fade duration (ms). Build-in is driven by the sim's
 *  build fraction, so only the cosmetic death fade needs a clock. Sourced
 *  from visionConfig.json (`deathFadeMs`) alongside the leaving-vision and
 *  entering-vision fade durations. */
export const ENTITY_DEATH_FADE_MS = UNIT_DEATH_FADE_MS;

/** Per-entity nanoframe parameters for the per-object build material.
 *  `progress` is the raw build fraction (0 = queued ghost, 1 = done);
 *  `teamColorHex` tints the ghost/bands; `baseY`/`invHeight` normalize
 *  fragment world height to 0..1 across the entity's visual height. */
export type EntityBuildVisual = {
  progress: number;
  teamColorHex: number;
  baseY: number;
  invHeight: number;
};

// -- Shared clock for the nanoframe pulse/scan animation ---------------
// One uniform object referenced by every patched material; advanced once
// per rendered frame by the entity renderers (idempotent per timestamp).
const BUILD_TIME_UNIFORM = { value: 0 };

export function setEntityBuildTimeMs(timeMs: number): void {
  BUILD_TIME_UNIFORM.value = timeMs / 1000;
}

type BuildVisualMeshCache = {
  group: THREE.Object3D;
  entityBuildVisual?: EntityBuildVisual;
  buildVisualHeight?: number;
  buildVisualBaseOffsetY?: number;
};

const _buildBoundsBox = new THREE.Box3();

/** Fill (and lazily allocate) a mesh's reusable nanoframe parameter
 *  object for this frame. Band height normalization spans the whole
 *  rendered assembly — body plus mounted turret visuals — via the
 *  group's bounding box, measured once per mesh: under-construction
 *  bodies hold still (a reserved build square or a factory bay), so the
 *  box stays valid until the mesh is rebuilt. */
export function updateEntityBuildVisual(
  mesh: BuildVisualMeshCache,
  progress: number,
  teamColorHex: number,
): EntityBuildVisual {
  let build = mesh.entityBuildVisual;
  if (build === undefined) {
    build = { progress: 1, teamColorHex: 0xffffff, baseY: 0, invHeight: 1 };
    mesh.entityBuildVisual = build;
  }
  if (mesh.buildVisualHeight === undefined) {
    mesh.group.updateWorldMatrix(true, true);
    _buildBoundsBox.setFromObject(mesh.group);
    if (_buildBoundsBox.isEmpty()) {
      mesh.buildVisualHeight = 1;
      mesh.buildVisualBaseOffsetY = 0;
    } else {
      mesh.buildVisualHeight = Math.max(1e-3, _buildBoundsBox.max.y - _buildBoundsBox.min.y);
      mesh.buildVisualBaseOffsetY = _buildBoundsBox.min.y - mesh.group.position.y;
    }
  }
  build.progress = progress;
  build.teamColorHex = teamColorHex;
  build.baseY = mesh.group.position.y + (mesh.buildVisualBaseOffsetY ?? 0);
  build.invHeight = 1 / (mesh.buildVisualHeight ?? 1);
  return build;
}

// -- Instanced backend: plain per-instance alpha ------------------------
const FADE_FRAGMENT_COMMON = ['varying float vFade;', '#include <common>'].join('\n');
const FADE_FRAGMENT_ALPHA = [
  'diffuseColor.a *= clamp(vFade, 0.0, 1.0);',
  '#include <opaque_fragment>',
].join('\n');

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
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', FADE_FRAGMENT_COMMON)
      .replace('#include <opaque_fragment>', FADE_FRAGMENT_ALPHA);
  };
  // Share one program across every instanced-faded material, distinct
  // from unpatched and per-object-faded materials.
  material.customProgramCacheKey = () => 'entityFadeInstancedAlpha';
  material.needsUpdate = true;
}

// -- Per-object backend: fade alpha + full nanoframe bands ---------------

const NF = NANOFRAME_VISUAL_CONFIG;
const glslFloat = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/** The shared directional light comes from due south at 45 degrees
 *  elevation (see the design doc's shadow rules); the flat team-color
 *  band shades against the same sun so a nanoframe reads as lit. */
const BUILD_SUN_DIR = 'vec3(0.0, 0.70710678, -0.70710678)';

const BUILD_VERTEX_COMMON = [
  'varying vec3 vBuildWorldPos;',
  '#include <common>',
].join('\n');

const BUILD_VERTEX_ASSIGN = [
  '#include <begin_vertex>',
  '{',
  '  vec4 bwp = vec4(transformed, 1.0);',
  '  #ifdef USE_INSTANCING',
  '    bwp = instanceMatrix * bwp;',
  '  #endif',
  '  vBuildWorldPos = (modelMatrix * bwp).xyz;',
  '}',
].join('\n');

function buildFragmentCommon(): string {
  return [
    'uniform float uFade;',
    'uniform float uBuild;',
    'uniform vec3 uBuildTeam;',
    'uniform float uBuildBaseY;',
    'uniform float uBuildInvHeight;',
    'uniform float uBuildTime;',
    'varying vec3 vBuildWorldPos;',
    'float buildGridLine(vec2 p) {',
    '  vec2 g = abs(fract(p - 0.5) - 0.5) / max(fwidth(p), vec2(1e-4));',
    '  return 1.0 - min(min(g.x, g.y), 1.0);',
    '}',
    '#include <common>',
  ].join('\n');
}

/** The nanoframe fragment chunk. `lit` variants shade the flat team
 *  band against the shared sun via the geometry `normal`; unlit
 *  variants (MeshBasic parts) skip that dot product. */
function buildFragmentChunk(lit: boolean): string {
  const e = NF.bandExponents;
  const ndl = lit
    ? `clamp(dot(normalize(normal), ${BUILD_SUN_DIR}), 0.3, 1.0)`
    : '1.0';
  return [
    'if (uBuild < 1.0) {',
    '  float bh = clamp((vBuildWorldPos.y - uBuildBaseY) * uBuildInvHeight, 0.0, 1.0);',
    '  if (uBuild <= 0.0) {',
    `    outgoingLight = mix(outgoingLight, uBuildTeam, ${glslFloat(NF.ghostTeamMix)});`,
    `    diffuseColor.a *= ${glslFloat(NF.ghostAlpha)};`,
    '  } else {',
    `    vec4 bl = pow(vec4(uBuild), vec4(${e.map(glslFloat).join(', ')}));`,
    `    float bPulse01 = 0.5 + 0.5 * sin(uBuildTime * ${glslFloat(NF.pulseRadPerSec)});`,
    `    vec3 bPulseTeam = uBuildTeam * mix(1.0, ${glslFloat(NF.pulseMaxGain)}, bPulse01);`,
    `    float bNdl = ${ndl};`,
    `    if (bh > bl.y) outgoingLight = mix(outgoingLight, bPulseTeam, ${glslFloat(NF.tintMix)});`,
    '    if (bh > bl.z) outgoingLight = bPulseTeam * bNdl;',
    '    if (bh > bl.w) {',
    '      outgoingLight = uBuildTeam * bNdl;',
    `      diffuseColor.a *= max(${glslFloat(NF.topAlphaFloor)}, 1.0 - (bh - bl.w) / max(1e-4, 1.0 - bl.w));`,
    '    }',
    `    float bLine = 1.0 - smoothstep(0.0, ${glslFloat(NF.scanLineHalfWidth)}, abs(bh - bl.x));`,
    `    bLine += 1.0 - smoothstep(0.0, ${glslFloat(NF.scanLineHalfWidth)}, abs(bh - bl.y));`,
    `    bLine += 1.0 - smoothstep(0.0, ${glslFloat(NF.scanLineHalfWidth)}, abs(bh - bl.z));`,
    `    bLine += 1.0 - smoothstep(0.0, ${glslFloat(NF.scanLineHalfWidth)}, abs(bh - bl.w));`,
    `    float bLast = smoothstep(0.0, ${glslFloat(NF.gridLastFraction)}, 1.0 - uBuild);`,
    `    float bWorldGrid = buildGridLine(vBuildWorldPos.xz / ${glslFloat(NF.worldGridCell)});`,
    `    float bModelCell = mix(${glslFloat(NF.modelGridCellMin)}, ${glslFloat(NF.modelGridCellMax)}, 1.0 - uBuild);`,
    '    float bModelGrid = buildGridLine(vBuildWorldPos.xz / bModelCell);',
    `    outgoingLight += bPulseTeam * (bWorldGrid + bModelGrid) * ${glslFloat(NF.gridIntensity)} * bPulse01 * bLast;`,
    '    outgoingLight += vec3(min(bLine, 1.0)) * bLast;',
    '  }',
    '}',
    'diffuseColor.a *= clamp(uFade, 0.0, 1.0);',
    '#include <opaque_fragment>',
  ].join('\n');
}

type PerObjectFade = {
  material: THREE.Material;
  setFade(value: number): void;
  /** Set or clear (null) the nanoframe band parameters. Custom
   *  ShaderMaterial clones cannot run the bands; callers pre-multiply
   *  the CPU alpha curve into `setFade` for those (`bandsSupported`
   *  false). */
  setBuild(build: EntityBuildVisual | null): void;
  bandsSupported: boolean;
};

// Per-object fade clones each carry their own uniform objects, but
// Three stores uniforms per material, not per WebGLProgram. The shader
// source is identical for every clone of the same base variant, so use a
// stable cache key and let those clones share one compiled program.
// Otherwise construction and death fades can compile/link one shader per
// mesh during gameplay.
const PER_OBJECT_FADE_CACHE_KEY = 'entityFadePerObjectAlpha';

function isLitMaterial(material: THREE.Material): boolean {
  return (
    (material as THREE.MeshLambertMaterial).isMeshLambertMaterial === true ||
    (material as THREE.MeshStandardMaterial).isMeshStandardMaterial === true ||
    (material as THREE.MeshPhongMaterial).isMeshPhongMaterial === true
  );
}

/** Clone a material and patch the clone so per-object `uFade`/`uBuild`
 *  uniforms drive the fade and nanoframe bands. Leaves the (often
 *  shared) base material untouched, so fading one per-Mesh object never
 *  bleeds onto others. Used for the per-Mesh building render path and
 *  full-detail unit bodies. */
function makePerObjectFadeMaterial(base: THREE.Material): PerObjectFade {
  if ((base as THREE.ShaderMaterial).isShaderMaterial === true) {
    return makeShaderPerObjectFadeMaterial(base as THREE.ShaderMaterial);
  }

  const lit = isLitMaterial(base);
  const baseCacheKey = base.customProgramCacheKey();
  const material = base.clone();
  material.transparent = true;
  material.depthWrite = true;
  const uFade = { value: 1 };
  const uBuild = { value: 1 };
  const uBuildTeam = { value: new THREE.Color(1, 1, 1) };
  const uBuildBaseY = { value: 0 };
  const uBuildInvHeight = { value: 1 };
  const cacheKey = `${PER_OBJECT_FADE_CACHE_KEY}:${lit ? 'lit' : 'unlit'}:${baseCacheKey}`;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    shader.uniforms.uFade = uFade;
    shader.uniforms.uBuild = uBuild;
    shader.uniforms.uBuildTeam = uBuildTeam;
    shader.uniforms.uBuildBaseY = uBuildBaseY;
    shader.uniforms.uBuildInvHeight = uBuildInvHeight;
    shader.uniforms.uBuildTime = BUILD_TIME_UNIFORM;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', BUILD_VERTEX_COMMON)
      .replace('#include <begin_vertex>', BUILD_VERTEX_ASSIGN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', buildFragmentCommon())
      .replace('#include <opaque_fragment>', buildFragmentChunk(lit));
  };
  material.customProgramCacheKey = () => cacheKey;
  material.needsUpdate = true;
  return {
    material,
    setFade: (value: number): void => { uFade.value = value; },
    setBuild: (build: EntityBuildVisual | null): void => {
      if (build === null) {
        uBuild.value = 1;
        return;
      }
      uBuild.value = build.progress;
      uBuildTeam.value.setHex(build.teamColorHex);
      uBuildBaseY.value = build.baseY;
      uBuildInvHeight.value = build.invHeight;
    },
    bandsSupported: true,
  };
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
  return {
    material,
    setFade: (value: number): void => { uFade.value = value; },
    setBuild: (): void => {},
    bandsSupported: false,
  };
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

function fadeMeshMaterial(
  mesh: THREE.Mesh,
  fade: number,
  build: EntityBuildVisual | null,
): void {
  const ud = mesh.userData as FadeMeshCache;
  if (fade >= 1 && build === null) {
    // Fully built and fully faded in: restore the real material and stop
    // paying the patch.
    if (ud._fadeReal !== undefined) {
      mesh.material = ud._fadeReal;
      ud._fadeReal = undefined;
    }
    return;
  }
  const applyChannels = (handle: PerObjectFade): void => {
    if (handle.bandsSupported) {
      handle.setFade(fade);
      handle.setBuild(build);
    } else {
      // Custom shader parts cannot run the bands: fold the BAR
      // translucency curve into their single alpha instead.
      handle.setFade(build === null ? fade : fade * getBuildAlphaForFraction(build.progress));
    }
  };
  const handle = ud._fadeHandle;
  // Clone already applied (untouched since last frame): just set values.
  if (handle !== undefined && mesh.material === handle.material) {
    applyChannels(handle);
    return;
  }
  // Otherwise `mesh.material` is currently the real material. Reuse the
  // existing clone iff it wraps that same real instance; rebuild only when
  // the real material actually changed.
  const current = mesh.material;
  if (Array.isArray(current)) return; // multi-material meshes not faded
  if (handle !== undefined && ud._fadeReal === current) {
    mesh.material = handle.material;
    applyChannels(handle);
    return;
  }
  ud._fadeReal = current;
  handle?.material.dispose();
  ud._fadeHandle = makePerObjectFadeMaterial(current);
  mesh.material = ud._fadeHandle.material;
  applyChannels(ud._fadeHandle);
}

/** Apply a uniform materialization fade — and, while under
 *  construction, the nanoframe band parameters — to every per-Mesh
 *  object under a group (buildings/towers and their turrets). At
 *  fade>=1 with no build in progress every mesh is restored to its real
 *  material, so finished entities pay nothing. InstancedMesh objects
 *  are skipped — they fade through their own per-instance `aFade`
 *  attribute. */
export function applyEntityGroupFade(
  group: THREE.Object3D,
  fade: number,
  build: EntityBuildVisual | null = null,
): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    if ((obj as THREE.InstancedMesh).isInstancedMesh === true) return;
    fadeMeshMaterial(mesh, fade, build);
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
  private readonly dying = new IndexedEntityIdMap<{ mesh: TMesh; fade: number }>();

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
