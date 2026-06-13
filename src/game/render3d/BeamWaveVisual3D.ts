// BeamWaveVisual3D — the beam's "living" wave-material family, shared by
// everything that is literally beam-stuff: the beam cylinders themselves
// (BeamRenderer3D) and the always-on beam-turret emitter rig — the fake
// barrel cone plus the start-point ball at its tip — on both render paths
// (unit instanced pools and per-Mesh tower turrets).
//
// One config source (beamConfig.json wave spacing/speed + colorsConfig
// colors/alphas), one animation style: alpha bands with a waveSpacing
// world-unit period flow along the local +Y axis at waveSpeed, exactly
// like the beam columns. The emitter rig animates continuously, so an
// idle beam turret reads as charging the ball at the barrel tip.
//
// Geometry contract: every wave-shaded shape spans local y ∈ [-0.5, +0.5]
// with +Y pointing along the flow direction (head → muzzle → target), so
// `vAlong = position.y + 0.5` walks 0→1 along the energy path for beam
// segments, barrel cones, and the start ball alike.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import beamConfig from '@/beamConfig.json';

export type BeamVisualConfig = {
  color: readonly number[];
  waveLowAlpha: number;
  waveHighAlpha: number;
  /** Length ratio of high-alpha run to low-alpha run within one repeat.
   *  1 means equal lengths; 0.25 means high alpha is one quarter as long
   *  as the low-alpha region. */
  waveHighToLowAlphaLengthRatio?: number;
  waveSpacing: number;
  waveSpeed: number;
};

/** Start-point ball ("generator orb") sizing config. radiusMultiplier
 *  scales the beam body radius; minRadius floors it so even thin beams
 *  show a visible ball. The ball renders in the shared beam-wave
 *  material, so there is no color field to resolve here. */
type StartPointSphereConfig = {
  radiusMultiplier: number;
  minRadius: number;
};

type BeamConfigFile = Partial<BeamVisualConfig> & {
  outer?: BeamVisualConfig;
  inner?: BeamVisualConfig;
  startPointSphere?: Partial<StartPointSphereConfig> & {
    emissionOffset?: Record<string, number>;
  };
};

// JSON-shape is narrower than BeamConfigFile (no color/alpha fields —
// those come from COLORS at merge time below), so cast through unknown.
const rawBeamConfig = beamConfig as unknown as BeamConfigFile;

const START_POINT_SPHERE_CONFIG: StartPointSphereConfig = {
  radiusMultiplier: rawBeamConfig.startPointSphere?.radiusMultiplier ?? 1.5,
  minRadius: rawBeamConfig.startPointSphere?.minRadius ?? 1.0,
};

const rawOuterVisualConfig = rawBeamConfig.outer ?? (rawBeamConfig as BeamVisualConfig);
export const BEAM_OUTER_VISUAL_CONFIG: BeamVisualConfig = {
  ...rawOuterVisualConfig,
  color: COLORS.effects.beam.outer.colorRgb01,
  waveLowAlpha: COLORS.effects.beam.outer.waveLowAlpha,
  waveHighAlpha: COLORS.effects.beam.outer.waveHighAlpha,
};
export const BEAM_INNER_VISUAL_CONFIG: BeamVisualConfig = {
  ...BEAM_OUTER_VISUAL_CONFIG,
  ...(rawBeamConfig.inner ?? {
    waveSpeed: BEAM_OUTER_VISUAL_CONFIG.waveSpeed * 1.8,
  }),
  color: COLORS.effects.beam.inner.colorRgb01,
  waveLowAlpha: COLORS.effects.beam.inner.waveLowAlpha,
  waveHighAlpha: COLORS.effects.beam.inner.waveHighAlpha,
};

export type BeamWaveLayer = 'outer' | 'inner';

export function beamWaveLayerConfig(layer: BeamWaveLayer): BeamVisualConfig {
  return layer === 'outer' ? BEAM_OUTER_VISUAL_CONFIG : BEAM_INNER_VISUAL_CONFIG;
}

/** The inner layer's radius as a fraction of the outer layer's — beam
 *  columns, emitter cones, start balls, and endpoint spheres all share it. */
export const BEAM_LAYER_INNER_SCALE = 0.45;

/** Transparent wave visuals draw after the opaque world; inner layers
 *  draw over their outer shells. Matches the beam columns' orders. */
export const BEAM_WAVE_RENDER_ORDER: Record<BeamWaveLayer, number> = {
  outer: 12,
  inner: 13,
};

/** One shared clock uniform for every beam-wave material — beam columns,
 *  emitter pools, and per-Mesh emitter materials all animate in lockstep.
 *  (Per-object fade clones made by EntityFade3D deep-copy uniforms, so a
 *  mid-fade emitter freezes its bands until the fade releases — fine.) */
export const BEAM_WAVE_TIME: { value: number } = { value: 0 };

export function tickBeamWaveTime(): void {
  BEAM_WAVE_TIME.value = performance.now() * 0.001;
}

/** Start-ball world radius for a ray of the given body radius
 *  (lineRadius = ray width / 2 — the same value the beam columns use). */
export function getBeamEmitterBallRadius(lineRadius: number): number {
  return Math.max(
    START_POINT_SPHERE_CONFIG.minRadius,
    lineRadius * START_POINT_SPHERE_CONFIG.radiusMultiplier,
  );
}

/** Wave repeats so the band period stays = waveSpacing world units
 *  regardless of the shape's length — no clamping. Short shapes (the
 *  emitter cone, the start ball) just show a travelling slice of the
 *  pattern; long beams pack more cycles in. */
export function beamWaveFlowRepeats(length: number, spacing: number): number {
  if (spacing <= 0 || length <= 1e-3) return 1;
  return length / spacing;
}

/** Deterministic per-thing phase hash so neighbouring wave shapes don't
 *  pulse in unison (same recipe the beam segments use). */
export function beamWaveFlowPhase(seedA: number, seedB: number): number {
  const v = Math.sin(seedA * 12.9898 + seedB * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

// GLSL needs decimal-pointed float literals (`1.0`, not `1`); JSON values
// might be `1` or `0.5`, so format them with a decimal so shader parses.
export const glsl = (n: number): string => {
  const s = n.toString();
  return s.includes('.') ? s : `${s}.0`;
};
export const glslVec3 = (rgb: readonly number[]): string =>
  `vec3(${glsl(rgb[0])}, ${glsl(rgb[1])}, ${glsl(rgb[2])})`;

export function beamWaveHighAlphaStart(config: BeamVisualConfig): number {
  const ratio = config.waveHighToLowAlphaLengthRatio ?? 1;
  const safeRatio = Number.isFinite(ratio) ? Math.max(0.001, ratio) : 1;
  const highFrac = safeRatio / (1 + safeRatio);
  return 1 - highFrac;
}

// ---------------------------------------------------------------------------
// Beam column shaders (used by BeamRenderer3D's instanced segment layers).
// ---------------------------------------------------------------------------

export const BEAM_SEGMENT_VERTEX_SHADER = `
attribute float aAlpha;
attribute vec4 aFlow;
varying float vAlpha;
varying float vAlong;
varying vec4 vFlow;
void main() {
  vAlpha = aAlpha;
  vAlong = position.y + 0.5;
  vFlow = aFlow;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

export const createBeamSegmentFragmentShader = (config: BeamVisualConfig): string => `
uniform float uTime;
varying float vAlpha;
varying float vAlong;
varying vec4 vFlow;
void main() {
  // vFlow = (unused, repeats, phase, speed). Beam alternates between
  // LOW_ALPHA and HIGH_ALPHA sections as the pattern travels along the
  // cylinder. waveHighToLowAlphaLengthRatio controls the high-vs-low
  // run length inside each waveSpacing slice.
  float repeats = max(0.001, vFlow.y);
  float p = fract(vAlong * repeats - uTime * vFlow.w + vFlow.z);
  float pulse = step(${glsl(beamWaveHighAlphaStart(config))}, p);
  float alpha = mix(${glsl(config.waveLowAlpha)}, ${glsl(config.waveHighAlpha)}, pulse) * vAlpha;
  gl_FragColor = vec4(${glslVec3(config.color)}, alpha);
}
`;

export const BEAM_ENDPOINT_VERTEX_SHADER = `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

export const createBeamEndpointFragmentShader = (config: BeamVisualConfig): string => `
varying float vAlpha;
void main() {
  gl_FragColor = vec4(${glslVec3(config.color)}, ${glsl(config.waveHighAlpha)} * vAlpha);
}
`;

// ---------------------------------------------------------------------------
// Emitter rig (fake barrel cone + start ball) wave materials.
//
// Same bands, same config, two delivery mechanisms:
//   - instanced (unit pools): per-instance aFlow2 = (repeats, phase) and the
//     pools' per-instance materialization fade attribute aFade.
//   - per-Mesh (towers / unit fallback): uFlowRepeats / uFlowPhase uniforms;
//     materialization fade arrives via EntityFade3D's per-object uFade clone.
// ---------------------------------------------------------------------------

const EMITTER_INSTANCED_VERTEX_SHADER = `
attribute vec2 aFlow2;
attribute float aFade;
varying float vAlong;
varying vec2 vFlow2;
varying float vFade;
void main() {
  vAlong = position.y + 0.5;
  vFlow2 = aFlow2;
  vFade = aFade;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const createEmitterInstancedFragmentShader = (config: BeamVisualConfig): string => `
uniform float uTime;
varying float vAlong;
varying vec2 vFlow2;
varying float vFade;
void main() {
  float repeats = max(0.001, vFlow2.x);
  float p = fract(vAlong * repeats - uTime * ${glsl(config.waveSpeed)} + vFlow2.y);
  float pulse = step(${glsl(beamWaveHighAlphaStart(config))}, p);
  float alpha = mix(${glsl(config.waveLowAlpha)}, ${glsl(config.waveHighAlpha)}, pulse) * clamp(vFade, 0.0, 1.0);
  gl_FragColor = vec4(${glslVec3(config.color)}, alpha);
}
`;

/** Material for an instanced emitter pool (cone or ball — the geometry
 *  contract makes them interchangeable). One material per layer; flow
 *  params ride the pool's per-instance aFlow2 attribute. */
export function createBeamEmitterInstancedMaterial(layer: BeamWaveLayer): THREE.ShaderMaterial {
  const config = beamWaveLayerConfig(layer);
  const material = new THREE.ShaderMaterial({
    vertexShader: EMITTER_INSTANCED_VERTEX_SHADER,
    fragmentShader: createEmitterInstancedFragmentShader(config),
    uniforms: { uTime: BEAM_WAVE_TIME },
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  material.customProgramCacheKey = () => `beamEmitterWave:inst:${layer}`;
  return material;
}

const EMITTER_MESH_VERTEX_SHADER = `
varying float vAlong;
void main() {
  vAlong = position.y + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const createEmitterMeshFragmentShader = (config: BeamVisualConfig): string => `
uniform float uTime;
uniform float uFlowRepeats;
uniform float uFlowPhase;
varying float vAlong;
void main() {
  float repeats = max(0.001, uFlowRepeats);
  float p = fract(vAlong * repeats - uTime * ${glsl(config.waveSpeed)} + uFlowPhase);
  float pulse = step(${glsl(beamWaveHighAlphaStart(config))}, p);
  float alpha = mix(${glsl(config.waveLowAlpha)}, ${glsl(config.waveHighAlpha)}, pulse);
  gl_FragColor = vec4(${glslVec3(config.color)}, alpha);
}
`;

// Per-Mesh emitter materials are shared across every turret whose shape has
// the same world length (flow params are uniforms, so the cache key is the
// resolved repeats value). One compiled program per layer regardless.
const emitterMeshMaterialCache = new Map<string, THREE.ShaderMaterial>();

/** Material for a per-Mesh emitter shape (tower barrels / unit instanced-cap
 *  fallback). `worldLength` is the shape's span along its local +Y in world
 *  units — barrel length for cones, diameter for balls. */
export function getBeamEmitterMeshMaterial(
  layer: BeamWaveLayer,
  worldLength: number,
): THREE.ShaderMaterial {
  const config = beamWaveLayerConfig(layer);
  const repeats = beamWaveFlowRepeats(worldLength, config.waveSpacing);
  const key = `${layer}:${repeats.toFixed(4)}`;
  const cached = emitterMeshMaterialCache.get(key);
  if (cached !== undefined) return cached;
  const material = new THREE.ShaderMaterial({
    vertexShader: EMITTER_MESH_VERTEX_SHADER,
    fragmentShader: createEmitterMeshFragmentShader(config),
    uniforms: {
      uTime: BEAM_WAVE_TIME,
      uFlowRepeats: { value: repeats },
      uFlowPhase: { value: beamWaveFlowPhase(repeats * 16, layer === 'outer' ? 1 : 2) },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  material.customProgramCacheKey = () => `beamEmitterWave:mesh:${layer}`;
  emitterMeshMaterialCache.set(key, material);
  return material;
}

/** Shared start-ball geometry: radius 0.5 so local y spans [-0.5, +0.5]
 *  (the wave-shader geometry contract) and a world-space uniform scale of
 *  `2 * ballRadius` yields a ball of radius `ballRadius`. Per-Mesh users
 *  share this instance; instanced pools clone it (each pool owns its own
 *  per-instance attributes). */
export const BEAM_EMITTER_BALL_GEOM = new THREE.SphereGeometry(0.5, 16, 12);
