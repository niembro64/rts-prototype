import * as THREE from 'three';
import { WIND_PARTICLE_CONFIG } from '@/windParticleConfig';
import type { NetworkServerSnapshotMeta } from '../network/NetworkTypes';
import type { RenderViewState3D } from './RenderFrameState3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';

type WindState = NonNullable<NetworkServerSnapshotMeta['wind']>;

type WindParticleFieldOptions = {
  mapWidth: number;
  mapHeight: number;
  waterLevelWorld: number;
  highestTerrainWorld: number;
};

/** Wrap the gust-noise drift before f32 uniform precision degrades it. */
const GUST_DRIFT_WRAP_MULTIPLIER = 1024;

// Wind is rendered as a small number of legible, gust-grouped,
// velocity-stretched streaks living in a zoom-proportional volume around
// the camera. Each instance is a billboarded ribbon built in the vertex
// shader from a unit (t, side) quad: stretched along the shared wind
// direction, bright at the leading tip and dim at the tail, hidden and
// revealed in drifting gust bands by a value-noise field advected with
// the wind. Everything per-frame is uniforms; the instance data is a
// static seed lattice that wraps toroidally inside the follow-volume, so
// the flow streams in from the upwind face and out the downwind face.
const WIND_STREAK_VERTEX_SHADER = `
attribute vec3 aSeedFrac;   // static per-instance position fractions in [0,1)
attribute vec2 aRand;       // x: length jitter pick, y: gust phase pick
uniform vec3 uFieldMin;     // world-space minimum corner of the follow volume
uniform vec3 uFieldSize;    // world-space extents of the follow volume
uniform vec3 uWindOffset;   // accumulated wind displacement, pre-wrapped per axis
uniform vec3 uWindDir;      // shared normalized wind direction (three coords)
uniform float uStreakLen;   // authored world length (speed-proportional)
uniform float uStreakWidth;
uniform float uMinLenPerDepth; // minScreenLengthPx / focalLengthPx
uniform float uAlpha;
uniform float uTailAlpha;   // tail alpha as a fraction of the tip alpha
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
  float t = position.x;     // 0 = tail, 1 = leading tip
  float side = position.y;  // -1 / +1 ribbon edge

  vec3 wrapped = mod(aSeedFrac * uFieldSize + uWindOffset, uFieldSize);
  vec3 center = uFieldMin + wrapped;

  vec3 toCamera = cameraPosition - center;
  float viewDist = length(toCamera);

  // Gust bands: a wind-advected noise field decides which streaks are
  // visible. aRand.y offsets each streak's sample so band edges dither.
  float gust = valueNoise((center.xz + uGustDrift) * uGust.x + aRand.y * 7.31);
  float visibility = smoothstep(uGust.y - 0.18, uGust.y + 0.18, gust);

  // Static per-particle length jitter keeps the lattice from reading as
  // stamped copies; the minimum projected length keeps far streaks from
  // collapsing into sub-pixel shimmer.
  float lengthJitter = 0.7 + 0.6 * aRand.x;
  float streakLen = max(uStreakLen * lengthJitter, uMinLenPerDepth * viewDist);

  // Billboard side axis: perpendicular to both the wind and the view ray,
  // with an up-based fallback when they are near-parallel.
  vec3 viewRay = toCamera / max(viewDist, 1.0e-4);
  vec3 sideAxis = cross(viewRay, uWindDir);
  float sideLen = length(sideAxis);
  sideAxis = sideLen > 1.0e-4
    ? sideAxis / sideLen
    : normalize(cross(vec3(0.0, 1.0, 0.0), uWindDir + vec3(1.0e-4, 0.0, 0.0)));

  // Thin tapered ribbon: full width at the tip, narrower at the tail.
  float halfWidth = uStreakWidth * mix(0.35, 1.0, t);
  vec3 world = center
    + uWindDir * (t - 0.5) * streakLen
    + sideAxis * side * halfWidth;

  // Bright tip fading to a dim tail makes the direction legible in a
  // still frame; near/far fades keep the lens clean and add depth.
  float nearFade = smoothstep(uFadeDists.x, uFadeDists.y, viewDist);
  float farFade = 1.0 - smoothstep(uFadeDists.z, uFadeDists.w, viewDist);
  vAlpha = uAlpha * visibility * mix(uTailAlpha, 1.0, t) * nearFade * farFade;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

const WIND_STREAK_FRAGMENT_SHADER = `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, vAlpha);
  #include <colorspace_fragment>
}
`;

/** Wind rendered as velocity-stretched streaks in a camera-following,
 * zoom-proportional volume. Presentation-only: reads the snapshot's wind
 * and feeds nothing back. One instanced draw; per-frame CPU work is a
 * handful of uniform writes. */
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
    uFieldMin: { value: THREE.Vector3 };
    uFieldSize: { value: THREE.Vector3 };
    uWindOffset: { value: THREE.Vector3 };
    uWindDir: { value: THREE.Vector3 };
    uStreakLen: { value: number };
    uStreakWidth: { value: number };
    uMinLenPerDepth: { value: number };
    uAlpha: { value: number };
    uTailAlpha: { value: number };
    uGust: { value: THREE.Vector2 };
    uGustDrift: { value: THREE.Vector2 };
    uFadeDists: { value: THREE.Vector4 };
  };
  /** Accumulated wind displacement, kept wrapped into the current field
   *  span each frame so f32 uniform precision never degrades. */
  private offsetX = 0;
  private offsetY = 0;
  private offsetZ = 0;
  private gustDriftX = 0;
  private gustDriftZ = 0;
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

    // Unit streak quad: x = t along the streak, y = ribbon side.
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([
        0, -1, 0,
        0, 1, 0,
        1, -1, 0,
        1, 1, 0,
      ]), 3),
    );
    this.geometry.setIndex([0, 2, 1, 2, 3, 1]);
    this.geometry.setAttribute(
      'aSeedFrac',
      new THREE.InstancedBufferAttribute(seedFrac, 3),
    );
    this.geometry.setAttribute(
      'aRand',
      new THREE.InstancedBufferAttribute(rand, 2),
    );
    this.geometry.instanceCount = 0;
    // Positions are shader-generated inside the camera-following volume,
    // so CPU-side bounds are meaningless; culling is disabled on the mesh.
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.MAX_SAFE_INTEGER,
    );

    this.uniforms = {
      uColor: { value: new THREE.Color(this.config.colorHex) },
      uFieldMin: { value: new THREE.Vector3() },
      uFieldSize: { value: new THREE.Vector3(1, 1, 1) },
      uWindOffset: { value: new THREE.Vector3() },
      uWindDir: { value: new THREE.Vector3(1, 0, 0) },
      uStreakLen: { value: 1 },
      uStreakWidth: { value: this.config.streakWidthWorld },
      uMinLenPerDepth: { value: 0 },
      uAlpha: { value: this.config.alpha },
      uTailAlpha: { value: this.config.tailAlphaFraction },
      uGust: { value: new THREE.Vector2(1 / this.config.gustScaleWorld, 0.5) },
      uGustDrift: { value: new THREE.Vector2() },
      uFadeDists: { value: new THREE.Vector4(0, 0, 1, 2) },
    };
    // gustVisibleFraction is the approximate fraction of streaks visible:
    // the noise is ~uniform in [0,1], so the threshold is its complement.
    this.uniforms.uGust.value.y = 1 - this.config.gustVisibleFraction;
    this.material = new THREE.ShaderMaterial({
      vertexShader: WIND_STREAK_VERTEX_SHADER,
      fragmentShader: WIND_STREAK_FRAGMENT_SHADER,
      uniforms: this.uniforms,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
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
    // where they are looking, clamped onto the map.
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
    const sizeX = Math.max(1, maxX - minX);
    const sizeY = this.upperPlaneWorld - this.lowerPlaneWorld;
    const sizeZ = Math.max(1, maxZ - minZ);

    const dtSec = Math.max(0, finiteOrZero(dtMs)) / 1000;
    this.offsetX = wrapPositive(this.offsetX + vx * dtSec, sizeX);
    this.offsetY = wrapPositive(this.offsetY + vy * dtSec, sizeY);
    this.offsetZ = wrapPositive(this.offsetZ + vz * dtSec, sizeZ);
    // The gust field drifts with the horizontal wind so bands sweep
    // across the map the way real gust fronts do (sim x -> three x,
    // sim y -> three z).
    const gustWrap = this.config.gustScaleWorld * GUST_DRIFT_WRAP_MULTIPLIER;
    this.gustDriftX = wrapPositive(this.gustDriftX - vx * dtSec, gustWrap);
    this.gustDriftZ = wrapPositive(this.gustDriftZ - vz * dtSec, gustWrap);

    this.uniforms.uFieldMin.value.set(minX, this.lowerPlaneWorld, minZ);
    this.uniforms.uFieldSize.value.set(sizeX, sizeY, sizeZ);
    this.uniforms.uWindOffset.value.set(this.offsetX, this.offsetY, this.offsetZ);
    this.uniforms.uWindDir.value.set(vx / speed, vy / speed, vz / speed);
    this.uniforms.uStreakLen.value = speed * this.config.streakSecondsOfTravel;
    this.uniforms.uGustDrift.value.set(this.gustDriftX, this.gustDriftZ);

    const focalPx =
      (view.viewportHeightPx * 0.5) / Math.tan(Math.max(1e-4, view.fovYRad * 0.5));
    this.uniforms.uMinLenPerDepth.value = this.config.minScreenLengthPx / focalPx;

    const nearFade = viewScale * this.config.nearFadeFraction;
    const farReach = range * 2.2;
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

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Wrap `value` into [0, span). The GLSL-side mod() keeps the sum of a
 *  seed offset (< span) and this wrapped offset inside the field. */
function wrapPositive(value: number, span: number): number {
  if (!(span > 0)) return 0;
  const wrapped = value % span;
  return wrapped < 0 ? wrapped + span : wrapped;
}
