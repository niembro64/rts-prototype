import * as THREE from 'three';
import { WIND_PARTICLE_CONFIG } from '@/windParticleConfig';
import type { NetworkServerSnapshotMeta } from '../network/NetworkTypes';
import type { ViewportFootprint } from '../ViewportFootprint';
import { createPrimitiveTetrahedronGeometry } from './PrimitiveGeometryQuality3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';

type WindState = NonNullable<NetworkServerSnapshotMeta['wind']>;

type WindParticleFieldOptions = {
  mapWidth: number;
  mapHeight: number;
  renderScope: ViewportFootprint;
  waterLevelWorld: number;
  highestTerrainWorld: number;
};

/** Wrap the shader clock before f32 uniform precision degrades the
 *  per-particle fade phase. The wrap scrambles each particle's phase for
 *  one frame (a single-frame twinkle) once every ~8.5 minutes. */
const TIME_WRAP_SECONDS = 512;

// The particle field is fully GPU-advected: each instance carries only a
// static seed, and the vertex shader derives its wrapped position inside
// the camera-following field volume from a handful of per-frame uniforms.
// The CPU never touches per-particle state after construction.
const WIND_PARTICLE_VERTEX_SHADER = `
attribute vec3 aSeedFrac;   // static per-instance position fractions in [0,1)
attribute vec2 aLifeFrac;   // x: lifetime pick fraction, y: fade phase fraction
uniform vec3 uFieldMin;     // world-space minimum corner of the field volume
uniform vec3 uFieldSize;    // world-space extents of the field volume
uniform vec3 uWindOffset;   // accumulated wind displacement, pre-wrapped per axis
uniform float uTime;
uniform float uLifeMin;
uniform float uLifeRange;
uniform float uFadeFraction;
uniform float uAlpha;
uniform float uRadius;
varying float vAlpha;
void main() {
  float life = uLifeMin + uLifeRange * aLifeFrac.x;
  float lifeT = fract(uTime / life + aLifeFrac.y);
  float fade = uFadeFraction <= 0.0
    ? 1.0
    : min(1.0, min(lifeT / uFadeFraction, (1.0 - lifeT) / uFadeFraction));
  vAlpha = uAlpha * max(fade, 0.0);
  vec3 wrapped = mod(aSeedFrac * uFieldSize + uWindOffset, uFieldSize);
  vec3 world = uFieldMin + wrapped;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world + position * uRadius, 1.0);
}
`;

const WIND_PARTICLE_FRAGMENT_SHADER = `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, vAlpha);
  #include <colorspace_fragment>
}
`;

/** Camera-local air particles moved along the authoritative wind vector.
 * Presentation-only: reads the snapshot's wind state and feeds nothing back.
 * The whole field is one instanced draw of 4-triangle tetrahedra whose
 * positions are computed in the vertex shader from static seeds + per-frame
 * uniforms — per frame the CPU does a few dozen float ops and uploads no
 * buffers. Direction (x, y, z) is conveyed by the shared drift motion. */
export class WindParticleField3D {
  private readonly config = WIND_PARTICLE_CONFIG;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly renderScope: ViewportFootprint;
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
    uTime: { value: number };
    uLifeMin: { value: number };
    uLifeRange: { value: number };
    uFadeFraction: { value: number };
    uAlpha: { value: number };
    uRadius: { value: number };
  };
  /** Accumulated wind displacement, kept wrapped into the current field
   *  span each frame so f32 uniform precision never degrades. */
  private offsetX = 0;
  private offsetY = 0;
  private offsetZ = 0;
  private timeSeconds = 0;
  private rngState = 0x7f4a7c15;

  constructor(parentWorld: THREE.Group, options: WindParticleFieldOptions) {
    this.mapWidth = options.mapWidth;
    this.mapHeight = options.mapHeight;
    this.renderScope = options.renderScope;
    this.lowerPlaneWorld = options.waterLevelWorld +
      this.config.lowerPlaneDistanceAboveWaterLevelWorld;
    this.upperPlaneWorld = Math.max(
      this.lowerPlaneWorld + 1,
      options.highestTerrainWorld +
        this.config.upperPlaneDistanceAboveHighestTerrainWorld,
    );

    const count = this.config.maxParticles;
    const seedFrac = new Float32Array(count * 3);
    const lifeFrac = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      seedFrac[i * 3] = this.random();
      seedFrac[i * 3 + 1] = this.random();
      seedFrac[i * 3 + 2] = this.random();
      lifeFrac[i * 2] = this.random();
      lifeFrac[i * 2 + 1] = this.random();
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
      'aLifeFrac',
      new THREE.InstancedBufferAttribute(lifeFrac, 2),
    );
    this.geometry.instanceCount = 0;
    // Positions are shader-generated inside the camera-following field, so
    // the geometry has no meaningful CPU-side bounds; culling is disabled
    // on the mesh below.
    this.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      Number.MAX_SAFE_INTEGER,
    );

    const lifeMin = this.config.lifetimeSeconds.min;
    const lifeMax = this.config.lifetimeSeconds.max;
    this.uniforms = {
      uColor: { value: new THREE.Color(this.config.colorHex) },
      uFieldMin: { value: new THREE.Vector3() },
      uFieldSize: { value: new THREE.Vector3(1, 1, 1) },
      uWindOffset: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uLifeMin: { value: Math.max(Number.EPSILON, lifeMin) },
      uLifeRange: { value: Math.max(0, lifeMax - lifeMin) },
      uFadeFraction: { value: this.config.fadeFraction },
      uAlpha: { value: this.config.alpha },
      uRadius: { value: this.config.radiusWorld },
    };
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

  update(wind: WindState | undefined, dtMs: number): void {
    if (!this.config.enabled || !wind) {
      this.geometry.instanceCount = 0;
      return;
    }

    // sim(x, y, z) -> Three(x, z, y). Preserve the authoritative direction
    // while applying the explicitly authored presentation-only speed scale.
    const vx = finiteOrZero(wind.x) * this.config.speedMultiplier;
    const vy = finiteOrZero(wind.z) * this.config.speedMultiplier;
    const vz = finiteOrZero(wind.y) * this.config.speedMultiplier;
    if (Math.hypot(vx, vy, vz) <= 1e-6) {
      this.geometry.instanceCount = 0;
      return;
    }

    const bounds = this.renderScope.getBounds(this.config.fieldPaddingWorld);
    const minX = Math.max(0, bounds.minX);
    const maxX = Math.min(this.mapWidth, bounds.maxX);
    const minZ = Math.max(0, bounds.minY);
    const maxZ = Math.min(this.mapHeight, bounds.maxY);
    if (
      !Number.isFinite(minX) || !Number.isFinite(maxX) ||
      !Number.isFinite(minZ) || !Number.isFinite(maxZ) ||
      maxX <= minX || maxZ <= minZ
    ) {
      this.geometry.instanceCount = 0;
      return;
    }
    const sizeX = maxX - minX;
    const sizeY = this.upperPlaneWorld - this.lowerPlaneWorld;
    const sizeZ = maxZ - minZ;

    const dtSec = Math.max(0, finiteOrZero(dtMs)) / 1000;
    this.offsetX = wrapPositive(this.offsetX + vx * dtSec, sizeX);
    this.offsetY = wrapPositive(this.offsetY + vy * dtSec, sizeY);
    this.offsetZ = wrapPositive(this.offsetZ + vz * dtSec, sizeZ);
    this.timeSeconds = (this.timeSeconds + dtSec) % TIME_WRAP_SECONDS;

    this.uniforms.uFieldMin.value.set(minX, this.lowerPlaneWorld, minZ);
    this.uniforms.uFieldSize.value.set(sizeX, sizeY, sizeZ);
    this.uniforms.uWindOffset.value.set(this.offsetX, this.offsetY, this.offsetZ);
    this.uniforms.uTime.value = this.timeSeconds;
    // Constant apparent density: the drawn count scales with the camera-
    // following field's footprint, so zooming in never packs the full
    // particle budget into a small viewport, and the authored floor keeps
    // the wind readable at every zoom. Drawing a prefix of the seed array
    // is a uniform spatial subset because the seeds are i.i.d. uniform.
    const targetCount = Math.floor(sizeX * sizeZ * this.config.particlesPerWorldArea);
    this.geometry.instanceCount = Math.max(
      this.config.minParticles,
      Math.min(this.config.maxParticles, targetCount),
    );
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
