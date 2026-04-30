// SprayRenderer3D — shared construction/heal spray trails.
//
// The sim publishes active `SprayTarget`s each tick via
// `ClientViewState.getSprayTargets()` — one entry per active
// construction-emitter → build-area (or commander → unit for heal)
// pair. Active sprays emit small colored particles at the source
// barrel/nozzle. Each particle stores its own target point and flies
// there over a short lifetime, with chaotic perpendicular wobble,
// source fade-in, and target fade-out.
//
// Implementation: ONE shared InstancedMesh of unit-sphere particles,
// drawn in a single draw call for every active spray on the map.
// Per-instance position/scale ride on the instance matrix; per-
// instance team color + alpha ride on aColor / aAlpha
// InstancedBufferAttributes read by a tiny custom shader (matches
// SmokeTrail3D / Explosion3D — same `gl_FragColor = vec4(vColor,
// vAlpha)` pattern across the unified-particles family). Was
// previously one Mesh per particle per spray with team-keyed
// MeshBasicMaterials — fine for a few commanders but scales linearly
// with active spray count. The new path scales with TOTAL active
// particle count, capped at MAX_PARTICLES, in one draw call.
//
// Particle allocation is persistent across frames: when an active
// spray stops, no new particles are emitted, but already-fired
// particles finish their short flight and fade out instead of the
// whole spray popping off instantly.
//
// LOD: particle count scales with `fireExplosionStyle` (flash → inferno
// ≈ 0.15× → 1.0×) — matching the 2D intensity multiplier — so low LODs
// get a handful of particles and MAX LOD gets the full fan. Zero-
// intensity sprays (idle commanders) skip entirely.

import * as THREE from 'three';
import type { SprayTarget } from '../sim/commanderAbilities';
import { getPlayerPrimaryColor } from '../sim/types';
import { getGraphicsConfig } from '@/clientBarConfig';

// Default spray trail altitude for legacy 2D spray targets. Factory
// tower sprays can pass explicit source/target z heights.
const TRAIL_Y = 4;
const PARTICLE_BASE_RADIUS = 2.35;
const MIN_FLIGHT_SEC = 0.16;
const MAX_FLIGHT_SEC = 0.62;
const BUILD_PARTICLE_SPEED = 470;
const HEAL_PARTICLE_SPEED = 560;
const MAX_PARTICLE_SPAWNS_PER_SPRAY_FRAME = 24;

/** LOD multiplier on the raw per-spray particle count, matching the 2D
 *  `SprayParticles.renderSprayEffect`'s fireExplosionStyle scaling. */
const LOD_INTENSITY: Record<string, number> = {
  flash:   0.15,
  spark:   0.3,
  burst:   0.5,
  blaze:   0.8,
  inferno: 1.0,
};

/** Max particles per spray at max LOD — keeps the pool bounded even
 *  when every commander on the map is actively building. */
const MAX_PARTICLES_PER_SPRAY = 42;

/** Global cap on simultaneous particles across every spray on the
 *  map. With MAX_PARTICLES_PER_SPRAY=42 this fits ~36 concurrent
 *  sprays, well above any realistic commander / fabricator count. */
const MAX_PARTICLES = 1536;

/** Heal-spray color — matches the 2D convention where heal sprays
 *  don't take the caster's team color. Constant white. */
const HEAL_R = 1;
const HEAL_G = 1;
const HEAL_B = 1;

/** Build-spray color alpha (matches the previous per-team
 *  MeshBasicMaterial.opacity = 0.85). Heal trails were 0.8 — we use
 *  one global alpha here since the visual difference is tiny. */
const PARTICLE_ALPHA = 0.85;

const PARTICLE_VERTEX_SHADER = `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const PARTICLE_FRAGMENT_SHADER = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

export class SprayRenderer3D {
  private root: THREE.Group;
  // Shared sphere geometry for all particles — cheap tessellation since
  // each particle is small on screen.
  private geom = new THREE.SphereGeometry(1, 8, 6);
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.InstancedMesh;
  // Per-instance attribute buffers. Index i in alphaArr / colorArr /
  // instanceMatrix corresponds to the i-th visible particle this
  // frame; the `count` cursor caps the draw bound to the live prefix.
  private alphaArr = new Float32Array(MAX_PARTICLES);
  private colorArr = new Float32Array(MAX_PARTICLES * 3);
  private alphaAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  // Particle state. Kept in typed arrays so the stream can persist
  // across frames without allocating one object per particle.
  private particleCount = 0;
  private pStartX = new Float32Array(MAX_PARTICLES);
  private pStartY = new Float32Array(MAX_PARTICLES);
  private pStartZ = new Float32Array(MAX_PARTICLES);
  private pEndX = new Float32Array(MAX_PARTICLES);
  private pEndY = new Float32Array(MAX_PARTICLES);
  private pEndZ = new Float32Array(MAX_PARTICLES);
  private pAge = new Float32Array(MAX_PARTICLES);
  private pLife = new Float32Array(MAX_PARTICLES);
  private pSize = new Float32Array(MAX_PARTICLES);
  private pWobble = new Float32Array(MAX_PARTICLES);
  private pArc = new Float32Array(MAX_PARTICLES);
  private pSeed = new Float32Array(MAX_PARTICLES);
  private pR = new Float32Array(MAX_PARTICLES);
  private pG = new Float32Array(MAX_PARTICLES);
  private pB = new Float32Array(MAX_PARTICLES);
  private spraySpawnBudget = new Map<string, number>();
  private activeSprayKeys = new Set<string>();
  private rngState = 0x9e3779b9;
  // Phase accumulator — drives the sinusoidal per-particle wobble so
  // successive frames look like a continuous animated stream.
  private _time = 0;
  // Scratch matrix reused across the per-particle write loop —
  // particles are spheres so the rotation component is identity.
  private _scratchMat = new THREE.Matrix4();
  // Scratch Color for per-team color resolution (cached lookup
  // across frames via `_teamColorCache` — getPlayerPrimaryColor
  // returns a hex int, we unpack to RGB once per pid). Keeps the
  // hot per-particle write loop free of re-decoding the same
  // hex → RGB every frame.
  private _teamColorCache = new Map<number, { r: number; g: number; b: number }>();

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);

    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArr, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('aAlpha', this.alphaAttr);
    this.geom.setAttribute('aColor', this.colorAttr);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(this.geom, this.mat, MAX_PARTICLES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Source geometry's bounding sphere is at origin, instances live
    // anywhere on the map — disable cull (same caveat the chassis +
    // particle pools share).
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
  }

  /** Per-frame update. `dtMs` advances the wobble phase so frame rate
   *  doesn't affect the animation speed. */
  update(sprayTargets: readonly SprayTarget[], dtMs: number): void {
    this._time += dtMs;
    const dtSec = Math.max(0, Math.min(dtMs, 100)) / 1000;

    const style = getGraphicsConfig().fireExplosionStyle ?? 'burst';
    const lodMult = LOD_INTENSITY[style] ?? 0.5;

    this.advanceParticles(dtSec);
    this.activeSprayKeys.clear();

    for (const spray of sprayTargets) {
      if (spray.intensity <= 0) continue;
      const scaledIntensity = Math.min(1, spray.intensity) * lodMult;
      // Build sprays are intentionally denser than heal sprays because
      // they represent a construction emitter painting a footprint, not
      // a single repair beam.
      const baseCount = spray.type === 'build' ? 36 : 16;
      const count = Math.max(4, Math.floor(baseCount * scaledIntensity));
      const n = Math.min(count, MAX_PARTICLES_PER_SPRAY);

      // Resolve per-spray color once. Heal sprays are always white,
      // build sprays use the caster's team primary.
      let r: number, g: number, b: number;
      if (spray.type === 'heal' || spray.source.playerId === undefined) {
        r = HEAL_R; g = HEAL_G; b = HEAL_B;
      } else {
        const cached = this._teamColorCache.get(spray.source.playerId);
        if (cached) {
          r = cached.r; g = cached.g; b = cached.b;
        } else {
          const hex = getPlayerPrimaryColor(spray.source.playerId);
          r = ((hex >> 16) & 0xff) / 255;
          g = ((hex >>  8) & 0xff) / 255;
          b = ( hex        & 0xff) / 255;
          this._teamColorCache.set(spray.source.playerId, { r, g, b });
        }
      }

      const sx = spray.source.pos.x;
      const sy = spray.source.z ?? TRAIL_Y;
      const sz = spray.source.pos.y;
      const tx = spray.target.pos.x;
      const ty = spray.target.z ?? TRAIL_Y;
      const tz = spray.target.pos.y;
      const dist = Math.hypot(tx - sx, ty - sy, tz - sz);
      const flightSec = this.flightTimeForDistance(dist, spray.type);
      const key = this.sprayKey(spray);
      this.activeSprayKeys.add(key);
      let budget = this.spraySpawnBudget.get(key) ?? 0;
      budget += (n / Math.max(flightSec, MIN_FLIGHT_SEC)) * dtSec;
      const spawnCount = Math.min(
        MAX_PARTICLE_SPAWNS_PER_SPRAY_FRAME,
        Math.floor(budget),
      );
      budget -= spawnCount;
      this.spraySpawnBudget.set(key, budget);

      for (let i = 0; i < spawnCount; i++) {
        this.emitParticle(spray, scaledIntensity, r, g, b);
      }
    }

    for (const key of this.spraySpawnBudget.keys()) {
      if (!this.activeSprayKeys.has(key)) this.spraySpawnBudget.delete(key);
    }

    const visibleCount = this.writeParticlesToMesh();

    // Cap draw to the live prefix — trailing slots (whatever they
    // happen to hold from previous frames) don't render.
    this.mesh.count = visibleCount;
    if (visibleCount > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, visibleCount * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.clearUpdateRanges();
      this.alphaAttr.addUpdateRange(0, visibleCount);
      this.alphaAttr.needsUpdate = true;
      this.colorAttr.clearUpdateRanges();
      this.colorAttr.addUpdateRange(0, visibleCount * 3);
      this.colorAttr.needsUpdate = true;
    }
  }

  private sprayKey(spray: SprayTarget): string {
    return `${spray.type}:${spray.source.id}:${spray.target.id}`;
  }

  private random(): number {
    // Xorshift32: deterministic, tiny, and plenty for cosmetic spray.
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x;
    return ((x >>> 0) / 0x100000000);
  }

  private flightTimeForDistance(distance: number, type: SprayTarget['type']): number {
    const speed = type === 'build' ? BUILD_PARTICLE_SPEED : HEAL_PARTICLE_SPEED;
    return Math.max(MIN_FLIGHT_SEC, Math.min(MAX_FLIGHT_SEC, distance / speed));
  }

  private emitParticle(
    spray: SprayTarget,
    scaledIntensity: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (this.particleCount >= MAX_PARTICLES) return;

    const sx = spray.source.pos.x;
    const sy = spray.source.z ?? TRAIL_Y;
    const sz = spray.source.pos.y;
    const tx = spray.target.pos.x;
    const ty = spray.target.z ?? TRAIL_Y;
    const tz = spray.target.pos.y;
    const dimSpread = spray.target.dim
      ? Math.min(spray.target.dim.x, spray.target.dim.y) * 0.42
      : 0;
    const targetSpread = spray.type === 'build'
      ? Math.max(spray.target.radius ?? 0, dimSpread)
      : Math.max(spray.target.radius ?? 0, 0) * 0.25;

    const areaPhase = this.random() * Math.PI * 2;
    const areaRing = targetSpread * Math.sqrt(this.random());
    const endX = tx + Math.cos(areaPhase) * areaRing;
    const endZ = tz + Math.sin(areaPhase) * areaRing;
    const endY = ty + (spray.type === 'build'
      ? (this.random() * 2 - 1) * Math.min(targetSpread * 0.16, 10)
      : (this.random() * 2 - 1) * Math.min(targetSpread * 0.1, 5));
    const dx = endX - sx;
    const dy = endY - sy;
    const dz = endZ - sz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return;

    const idx = this.particleCount++;
    const life = this.flightTimeForDistance(len, spray.type) * (0.86 + this.random() * 0.28);
    this.pStartX[idx] = sx;
    this.pStartY[idx] = sy;
    this.pStartZ[idx] = sz;
    this.pEndX[idx] = endX;
    this.pEndY[idx] = endY;
    this.pEndZ[idx] = endZ;
    this.pAge[idx] = 0;
    this.pLife[idx] = life;
    this.pSize[idx] = PARTICLE_BASE_RADIUS
      * (0.72 + this.random() * 0.52)
      * (0.5 + 0.5 * scaledIntensity);
    this.pWobble[idx] = len * 0.018 + targetSpread * 0.035;
    this.pArc[idx] = spray.type === 'build'
      ? Math.min(34, Math.max(5, len * 0.09))
      : Math.min(18, Math.max(3, len * 0.045));
    this.pSeed[idx] = this.random() * Math.PI * 2;
    this.pR[idx] = r;
    this.pG[idx] = g;
    this.pB[idx] = b;
  }

  private advanceParticles(dtSec: number): void {
    if (dtSec <= 0) return;
    for (let i = 0; i < this.particleCount; i++) {
      this.pAge[i] += dtSec;
      if (this.pAge[i] >= this.pLife[i]) {
        this.removeParticle(i);
        i--;
      }
    }
  }

  private removeParticle(index: number): void {
    const last = this.particleCount - 1;
    if (index !== last) {
      this.pStartX[index] = this.pStartX[last];
      this.pStartY[index] = this.pStartY[last];
      this.pStartZ[index] = this.pStartZ[last];
      this.pEndX[index] = this.pEndX[last];
      this.pEndY[index] = this.pEndY[last];
      this.pEndZ[index] = this.pEndZ[last];
      this.pAge[index] = this.pAge[last];
      this.pLife[index] = this.pLife[last];
      this.pSize[index] = this.pSize[last];
      this.pWobble[index] = this.pWobble[last];
      this.pArc[index] = this.pArc[last];
      this.pSeed[index] = this.pSeed[last];
      this.pR[index] = this.pR[last];
      this.pG[index] = this.pG[last];
      this.pB[index] = this.pB[last];
    }
    this.particleCount = last;
  }

  private writeParticlesToMesh(): number {
    const timeSec = this._time / 1000;
    let visibleCount = 0;

    for (let i = 0; i < this.particleCount; i++) {
      const phase = Math.max(0, Math.min(1, this.pAge[i] / this.pLife[i]));
      const sx = this.pStartX[i];
      const sy = this.pStartY[i];
      const sz = this.pStartZ[i];
      const dx = this.pEndX[i] - sx;
      const dy = this.pEndY[i] - sy;
      const dz = this.pEndZ[i] - sz;
      const flatLen = Math.hypot(dx, dz);
      const perpX = flatLen > 1e-3 ? -dz / flatLen : 1;
      const perpZ = flatLen > 1e-3 ? dx / flatLen : 0;
      const envelope = Math.sin(phase * Math.PI);
      const wobble = Math.sin(timeSec * 8.5 + this.pSeed[i] + phase * Math.PI * 4)
        * this.pWobble[i]
        * envelope;
      const px = sx + dx * phase + perpX * wobble;
      const py = sy + dy * phase + this.pArc[i] * envelope;
      const pz = sz + dz * phase + perpZ * wobble;

      const fadeIn = Math.min(1, phase * 4);
      const fadeOut = Math.min(1, (1 - phase) * 3.4);
      const alpha = PARTICLE_ALPHA * fadeIn * fadeOut;
      if (alpha <= 0.002) continue;

      const size = this.pSize[i] * (0.68 + 0.42 * envelope);
      this._scratchMat.makeScale(size, size, size);
      this._scratchMat.setPosition(px, py, pz);
      this.mesh.setMatrixAt(visibleCount, this._scratchMat);
      this.colorArr[visibleCount * 3] = this.pR[i];
      this.colorArr[visibleCount * 3 + 1] = this.pG[i];
      this.colorArr[visibleCount * 3 + 2] = this.pB[i];
      this.alphaArr[visibleCount] = alpha;
      visibleCount++;
    }

    return visibleCount;
  }

  destroy(): void {
    this.root.remove(this.mesh);
    this.mesh.dispose();
    this.mat.dispose();
    this.geom.dispose();
    this._teamColorCache.clear();
    this.spraySpawnBudget.clear();
    this.activeSprayKeys.clear();
    this.root.parent?.remove(this.root);
  }
}
