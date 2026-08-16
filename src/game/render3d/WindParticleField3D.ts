import * as THREE from 'three';
import { WIND_PARTICLE_CONFIG } from '@/windParticleConfig';
import type { NetworkServerSnapshotMeta } from '../network/NetworkTypes';
import type { RenderViewState3D } from './RenderFrameState3D';
import { createPrimitiveTetrahedronGeometry } from './PrimitiveGeometryQuality3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import { getExposureBrightnessUniform } from './RenderLighting3D';
import { finiteOrZero } from '../math';

type WindState = NonNullable<NetworkServerSnapshotMeta['wind']>;

type WindParticleFieldOptions = {
  mapWidth: number;
  mapHeight: number;
  waterLevelWorld: number;
  highestTerrainWorld: number;
};

/** Wrap the gust-noise drift before f32 uniform precision degrades it. */
const GUST_DRIFT_WRAP_MULTIPLIER = 1024;

/** Smallest lattice window span. The active span is this times a power of
 *  two, chosen with hysteresis so it always covers the follow volume. */
const LATTICE_SPAN_BASE = 512;
/** Horizontal wind offsets wrap at this fixed span. It is a power-of-two
 *  multiple of every possible lattice span, so a wrap subtracts an exact
 *  multiple of the active span and never moves a particle. */
const LATTICE_SPAN_MAX = 65536;

// Wind is rendered as small tetrahedra drifting with the authoritative
// wind vector, hidden and revealed in gust bands by a wind-advected
// value-noise field. Positions are world-anchored on a power-of-two
// lattice window around the camera: camera pan/zoom/orbit only move the
// window, so every camera command leaves the particles stationary in the
// world — motion comes solely from the accumulated wind offset.
// Everything per-frame is uniforms; the instance data is a static seed
// lattice.
const WIND_PARTICLE_VERTEX_SHADER = `
attribute vec3 aSeedFrac;   // static per-instance position fractions in [0,1)
attribute vec2 aRand;       // x: yaw pick, y: gust phase pick
uniform vec2 uWinMin;       // world-space min corner of the lattice window (x, z)
uniform float uLatticeSpan; // power-of-two window span (world units)
uniform float uBandMin;     // air band bottom (world y)
uniform float uBandSize;    // air band height
uniform vec3 uWindOffset;   // accumulated wind displacement, pre-wrapped per axis
uniform float uRadius;      // authored particle radius (world units)
uniform float uMinSizePerDepth; // minScreenSizePx / focalLengthPx
uniform float uAlpha;
uniform vec2 uGust;         // x: 1 / gustScaleWorld, y: visibility threshold
uniform vec2 uGustDrift;    // accumulated gust-field drift (world x, z)
uniform vec4 uFadeDists;    // near0, near1, farStart, farEnd view distances
varying float vAlpha;

float hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// One octave of smoothed value noise — enough structure for gust bands.
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2(1.0, 0.0)), u.x),
    mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

void main() {
  // World-anchored positions: each particle lives at a fixed world point
  // (seed * span + wind offset) folded into the lattice window around the
  // camera. Camera pan/zoom/orbit only move the window, so every camera
  // command leaves the particles stationary in the world; the offset is
  // wrapped CPU-side by exact multiples of the span, so wraps are
  // invisible. The vertical band is static per match, so y wraps on it
  // directly.
  vec2 xz = uWinMin + mod(
    aSeedFrac.xz * uLatticeSpan + uWindOffset.xz - uWinMin,
    vec2(uLatticeSpan));
  float y = uBandMin + mod(aSeedFrac.y * uBandSize + uWindOffset.y, uBandSize);
  vec3 center = vec3(xz.x, y, xz.y);

  vec3 toCamera = cameraPosition - center;
  float viewDist = length(toCamera);

  // Gust bands: a wind-advected noise field decides which particles are
  // visible. aRand.y offsets each particle's sample so band edges dither.
  float gust = valueNoise((center.xz + uGustDrift) * uGust.x + aRand.y * 7.31);
  float visibility = smoothstep(uGust.y - 0.18, uGust.y + 0.18, gust);

  // A particle whose projected size falls below the threshold fades out
  // instead of being size-clamped: a screen-locked size makes particles
  // zoom at a different rate than the world, which reads as drift.
  float projected = uRadius / max(uMinSizePerDepth * viewDist, 1.0e-6);
  float sizeFade = smoothstep(0.5, 1.0, projected);
  float radius = uRadius;

  // Static per-particle yaw so the shared tetrahedron doesn't read as
  // stamped copies of one orientation.
  float yaw = aRand.x * 6.2831853;
  float c = cos(yaw);
  float s = sin(yaw);
  vec3 rotated = vec3(
    position.x * c - position.z * s,
    position.y,
    position.x * s + position.z * c);

  float nearFade = smoothstep(uFadeDists.x, uFadeDists.y, viewDist);
  float farFade = 1.0 - smoothstep(uFadeDists.z, uFadeDists.w, viewDist);
  vAlpha = uAlpha * visibility * sizeFade * nearFade * farFade;

  gl_Position = projectionMatrix * modelViewMatrix
    * vec4(center + rotated * radius, 1.0);
}
`;

const WIND_PARTICLE_FRAGMENT_SHADER = `
uniform vec3 uColor;
uniform float uBrightness;
varying float vAlpha;
void main() {
  // uBrightness carries the tone-mapping exposure by hand: this material sets
  // toneMapped:false, so it has opted out of the stage that would apply it.
  gl_FragColor = vec4(uColor * uBrightness, vAlpha);
  #include <colorspace_fragment>
}
`;

/** Wind rendered as small drifting tetrahedra in a camera-following,
 * zoom-proportional cull window over a world-anchored lattice.
 * Presentation-only: reads the snapshot's wind and feeds nothing back.
 * One instanced draw; per-frame CPU work is a handful of uniform writes. */
export class WindParticleField3D {
  private readonly config = WIND_PARTICLE_CONFIG;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly lowerPlaneWorld: number;
  private readonly upperPlaneWorld: number;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly uniforms: {
    uColor: { value: THREE.Color };
    uBrightness: { value: number };
    uWinMin: { value: THREE.Vector2 };
    uLatticeSpan: { value: number };
    uBandMin: { value: number };
    uBandSize: { value: number };
    uWindOffset: { value: THREE.Vector3 };
    uRadius: { value: number };
    uMinSizePerDepth: { value: number };
    uAlpha: { value: number };
    uGust: { value: THREE.Vector2 };
    uGustDrift: { value: THREE.Vector2 };
    uFadeDists: { value: THREE.Vector4 };
  };
  /** Accumulated wind displacement, kept wrapped so f32 uniform precision
   *  never degrades (horizontal axes wrap at LATTICE_SPAN_MAX, which every
   *  active span divides; the static vertical band wraps on itself). */
  private offsetX = 0;
  private offsetY = 0;
  private offsetZ = 0;
  private gustDriftX = 0;
  private gustDriftZ = 0;
  /** Active lattice window span (power-of-two multiple of the base),
   *  switched with hysteresis so zoom rarely rebins the lattice. */
  private latticeSpan = LATTICE_SPAN_BASE;
  private rngState = 0x7f4a7c15;

  constructor(parentWorld: THREE.Group, options: WindParticleFieldOptions) {
    this.mapWidth = options.mapWidth;
    this.mapHeight = options.mapHeight;
    this.lowerPlaneWorld = options.waterLevelWorld +
      this.config.lowerPlaneDistanceAboveWaterLevelWorld;
    this.upperPlaneWorld = Math.max(
      this.lowerPlaneWorld + 1,
      options.highestTerrainWorld +
        this.config.upperPlaneDistanceAboveHighestTerrainWorld,
    );

    const count = this.config.maxParticles;
    const seedFrac = new Float32Array(count * 3);
    const rand = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      seedFrac[i * 3] = this.random();
      seedFrac[i * 3 + 1] = this.random();
      seedFrac[i * 3 + 2] = this.random();
      rand[i * 2] = this.random();
      rand[i * 2 + 1] = this.random();
    }

    const base = createPrimitiveTetrahedronGeometry();
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute('position', base.getAttribute('position'));
    const index = base.getIndex();
    if (index !== null) this.geometry.setIndex(index);
    this.geometry.setAttribute(
      'aSeedFrac',
      new THREE.InstancedBufferAttribute(seedFrac, 3),
    );
    this.geometry.setAttribute(
      'aRand',
      new THREE.InstancedBufferAttribute(rand, 2),
    );
    this.geometry.instanceCount = 0;
    // Positions are shader-generated inside the camera-following window,
    // so CPU-side bounds are meaningless; culling is disabled on the mesh.
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.MAX_SAFE_INTEGER,
    );

    this.uniforms = {
      uColor: { value: new THREE.Color(this.config.colorHex) },
      uBrightness: getExposureBrightnessUniform(),
      uWinMin: { value: new THREE.Vector2() },
      uLatticeSpan: { value: LATTICE_SPAN_BASE },
      uBandMin: { value: this.lowerPlaneWorld },
      uBandSize: { value: this.upperPlaneWorld - this.lowerPlaneWorld },
      uWindOffset: { value: new THREE.Vector3() },
      uRadius: { value: this.config.radiusWorld },
      uMinSizePerDepth: { value: 0 },
      uAlpha: { value: this.config.alpha },
      uGust: { value: new THREE.Vector2(1 / this.config.gustScaleWorld, 0.5) },
      uGustDrift: { value: new THREE.Vector2() },
      uFadeDists: { value: new THREE.Vector4(0, 0, 1, 2) },
    };
    // gustVisibleFraction is the approximate fraction of particles
    // visible: the noise is ~uniform in [0,1], so the threshold is its
    // complement.
    this.uniforms.uGust.value.y = 1 - this.config.gustVisibleFraction;
    this.material = new THREE.ShaderMaterial({
      vertexShader: WIND_PARTICLE_VERTEX_SHADER,
      fragmentShader: WIND_PARTICLE_FRAGMENT_SHADER,
      uniforms: this.uniforms,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'WindParticleField3D';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects;
    parentWorld.add(this.mesh);
  }

  update(
    wind: WindState | undefined,
    dtMs: number,
    view: RenderViewState3D | null = null,
  ): void {
    if (!this.config.enabled || !wind || view === null) {
      this.geometry.instanceCount = 0;
      return;
    }

    // sim(x, y, z) -> Three(x, z, y). Preserve the authoritative direction
    // while applying the explicitly authored presentation-only speed scale.
    const vx = finiteOrZero(wind.x) * this.config.speedMultiplier;
    const vy = finiteOrZero(wind.z) * this.config.speedMultiplier;
    const vz = finiteOrZero(wind.y) * this.config.speedMultiplier;
    const speed = Math.hypot(vx, vy, vz);
    if (speed <= 1e-6) {
      this.geometry.instanceCount = 0;
      return;
    }

    // Zoom-proportional follow volume: anchored a little ahead of the
    // camera along its view direction so pitched cameras get the field
    // where they are looking, clamped onto the map. The volume only sizes
    // the lattice window and the fades — particle positions are anchored
    // to the world, never to this volume.
    const viewScale = Math.min(
      this.config.maxViewScaleWorld,
      Math.max(this.config.minViewScaleWorld, view.cameraY - this.lowerPlaneWorld),
    );
    const range = viewScale * this.config.viewRangeMultiplier;
    let anchorX = view.cameraX;
    let anchorZ = view.cameraZ;
    const forwardLen = Math.hypot(view.forwardX, view.forwardZ);
    if (forwardLen > 1e-4) {
      anchorX += (view.forwardX / forwardLen) * viewScale * 0.6;
      anchorZ += (view.forwardZ / forwardLen) * viewScale * 0.6;
    }
    const minX = Math.max(0, Math.min(anchorX - range, this.mapWidth - 2 * range));
    const maxX = Math.min(this.mapWidth, minX + 2 * range);
    const minZ = Math.max(0, Math.min(anchorZ - range, this.mapHeight - 2 * range));
    const maxZ = Math.min(this.mapHeight, minZ + 2 * range);
    const sizeY = this.upperPlaneWorld - this.lowerPlaneWorld;

    // Lattice span: the smallest power-of-two multiple of the base that
    // covers the follow volume, with hysteresis so a zoom gesture rarely
    // rebins the lattice (a rebin repositions particles once).
    const maxDim = Math.max(1, maxX - minX, maxZ - minZ);
    let neededSpan = LATTICE_SPAN_BASE;
    while (neededSpan < maxDim && neededSpan < LATTICE_SPAN_MAX) neededSpan *= 2;
    if (neededSpan > this.latticeSpan || maxDim < this.latticeSpan * 0.45) {
      this.latticeSpan = neededSpan;
    }
    const span = this.latticeSpan;
    const winMinX = (minX + maxX) * 0.5 - span * 0.5;
    const winMinZ = (minZ + maxZ) * 0.5 - span * 0.5;

    const dtSec = Math.max(0, finiteOrZero(dtMs)) / 1000;
    this.offsetX = wrapPositive(this.offsetX + vx * dtSec, LATTICE_SPAN_MAX);
    this.offsetY = wrapPositive(this.offsetY + vy * dtSec, sizeY);
    this.offsetZ = wrapPositive(this.offsetZ + vz * dtSec, LATTICE_SPAN_MAX);
    // The gust field drifts with the horizontal wind so bands sweep
    // across the map the way real gust fronts do (sim x -> three x,
    // sim y -> three z).
    const gustWrap = this.config.gustScaleWorld * GUST_DRIFT_WRAP_MULTIPLIER;
    this.gustDriftX = wrapPositive(this.gustDriftX - vx * dtSec, gustWrap);
    this.gustDriftZ = wrapPositive(this.gustDriftZ - vz * dtSec, gustWrap);

    this.uniforms.uWinMin.value.set(winMinX, winMinZ);
    this.uniforms.uLatticeSpan.value = span;
    this.uniforms.uBandSize.value = sizeY;
    this.uniforms.uWindOffset.value.set(this.offsetX, this.offsetY, this.offsetZ);
    this.uniforms.uGustDrift.value.set(this.gustDriftX, this.gustDriftZ);

    const focalPx =
      (view.viewportHeightPx * 0.5) / Math.tan(Math.max(1e-4, view.fovYRad * 0.5));
    this.uniforms.uMinSizePerDepth.value = this.config.minScreenSizePx / focalPx;

    // The far fade reaches most of the lattice window, so medium-far air
    // stays populated; only the outermost ring fades out.
    const nearFade = viewScale * this.config.nearFadeFraction;
    const farReach = span * 0.75;
    this.uniforms.uFadeDists.value.set(
      nearFade * 0.5,
      nearFade,
      farReach * this.config.farFadeStartFraction,
      farReach,
    );

    this.geometry.instanceCount = this.config.maxParticles;
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }

  private random(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 0x100000000;
  }
}

/** Wrap `value` into [0, span). The GLSL-side mod() keeps the sum of a
 *  seed offset (< span) and this wrapped offset inside the window. */
function wrapPositive(value: number, span: number): number {
  if (!(span > 0)) return 0;
  const wrapped = value % span;
  return wrapped < 0 ? wrapped + span : wrapped;
}
