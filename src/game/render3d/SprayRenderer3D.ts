// SprayRenderer3D — shared construction/heal spray trails.
//
// The sim publishes active `SprayTarget`s each tick via
// `ClientViewState.getSprayTargets()` — one entry per active
// construction-emitter → build-area (or commander → unit for heal)
// pair. Active sprays emit small colored particles at the source
// barrel/nozzle. Each particle stores its own target point and flies
// there over a short lifetime, with chaotic perpendicular wobble.
// Build-spray particles target points distributed throughout the full
// volume of the thing being built (a uniform sphere from `radius`, or
// a uniform box from `dim`), so the stream visibly paints every part
// of the structure rather than a single nozzle dot. Alpha is constant
// across each particle's lifetime — start and end render at the same
// opacity so a particle reads as a solid pellet of resource the whole
// way to the target. Particle size grows linearly from start to end.
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
// particles always finish their full flight (life completes in air,
// arriving at their stored target point) instead of dying mid-stream
// when the build target completes.
//
// Zero-intensity sprays (idle commanders) skip entirely.

import * as THREE from 'three';
import type { SprayTarget } from '../sim/commanderAbilities';
import { getPlayerPrimaryColor } from '../sim/types';
import { hexToRgb01 } from './colorUtils';
import { disposeMesh } from './threeUtils';
import { RESOURCE_CONFIG } from '@/resourceConfig';

// Resource-ball visual tuning lives in resourceConfig.json (Config Is Data).
// Default spray trail altitude for legacy 2D spray targets. Factory
// tower sprays can pass explicit source/target z heights.
const TRAIL_Y = RESOURCE_CONFIG.spray.trailY;
const MIN_FLIGHT_SEC = RESOURCE_CONFIG.spray.minFlightSec;
// Default construction-spray particle visuals. These were historically read
// from the (now-removed) turretConstruction blueprint's constructionEmitter;
// kept here as explicit constants (the exact former blueprint values) so the
// legacy turret blueprint is no longer a render dependency. Factory tower
// sprays still pass explicit per-spray overrides.
const DEFAULT_BUILD_PARTICLE_SPEED = 50;
const DEFAULT_BUILD_PARTICLE_RADIUS = 1.5;
const HEAL_PARTICLE_SPEED = RESOURCE_CONFIG.spray.healParticleSpeed;
const HEAL_MAX_FLIGHT_SEC = RESOURCE_CONFIG.spray.healMaxFlightSec;
const HEAL_PARTICLE_BASE_RADIUS = RESOURCE_CONFIG.spray.healParticleBaseRadius;
const MAX_PARTICLE_SPAWNS_PER_SPRAY_FRAME = RESOURCE_CONFIG.spray.maxSpawnsPerSprayFrame;

/** Max particles per spray — keeps the pool bounded even when every
 *  commander on the map is actively building. */
const MAX_PARTICLES_PER_SPRAY = RESOURCE_CONFIG.spray.maxParticlesPerSpray;

/** Global cap on simultaneous particles across every spray on the map. */
const MAX_PARTICLES = RESOURCE_CONFIG.spray.maxParticles;

/** Heal-spray color — matches the 2D convention where heal sprays
 *  don't take the caster's team color. Constant white. */
const [HEAL_R, HEAL_G, HEAL_B] = RESOURCE_CONFIG.spray.healRgb01;

/** Build-spray color alpha (matches the previous per-team
 *  MeshBasicMaterial.opacity = 0.85). Heal trails were 0.8 — we use
 *  one global alpha here since the visual difference is tiny. */
const PARTICLE_ALPHA = RESOURCE_CONFIG.spray.particleAlpha;

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
  private pMidX = new Float32Array(MAX_PARTICLES);
  private pMidY = new Float32Array(MAX_PARTICLES);
  private pMidZ = new Float32Array(MAX_PARTICLES);
  private pMidSplit = new Float32Array(MAX_PARTICLES);
  private pMid2X = new Float32Array(MAX_PARTICLES);
  private pMid2Y = new Float32Array(MAX_PARTICLES);
  private pMid2Z = new Float32Array(MAX_PARTICLES);
  private pMid2Split = new Float32Array(MAX_PARTICLES);
  private pAge = new Float32Array(MAX_PARTICLES);
  private pLife = new Float32Array(MAX_PARTICLES);
  private pSize = new Float32Array(MAX_PARTICLES);
  // 1 for build particles (uniform size, no per-particle jitter or
  // mid-flight growth), 0 for heal (existing per-particle variation).
  private pUniformSize = new Uint8Array(MAX_PARTICLES);
  // Per-particle alpha-fade mode.
  //   0  → constant alpha (heal sprays)
  //   1  → opaque at start, transparent at end
  //  -1  → transparent at start, opaque at end
  //   2  → fade only at the source/sink endpoints; never at a pylon tip
  private pFadeDir = new Int8Array(MAX_PARTICLES);
  private pWobble = new Float32Array(MAX_PARTICLES);
  private pArc = new Float32Array(MAX_PARTICLES);
  private pSeed = new Float32Array(MAX_PARTICLES);
  private pR = new Float32Array(MAX_PARTICLES);
  private pG = new Float32Array(MAX_PARTICLES);
  private pB = new Float32Array(MAX_PARTICLES);
  private pEndR = new Float32Array(MAX_PARTICLES);
  private pEndG = new Float32Array(MAX_PARTICLES);
  private pEndB = new Float32Array(MAX_PARTICLES);
  private pTubeHandoffKey = new Array<string | null>(MAX_PARTICLES).fill(null);
  private pTubeHandoffIntensity = new Float32Array(MAX_PARTICLES);
  private livePylonTips = new Map<string, { x: number; y: number; z: number }>();
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
    // Draw after water (renderOrder=3) so transparent sorting doesn't
    // let the water plane blend over particles geometrically above it.
    this.mesh.renderOrder = 5;
    this.root.add(this.mesh);
  }

  /** Per-frame update. `dtMs` advances the wobble phase so frame rate
   *  doesn't affect the animation speed. */
  update(
    sprayTargets: readonly SprayTarget[],
    dtMs: number,
    oneShotSprays: readonly SprayTarget[] = [],
    onPylonTubeHandoff?: (flowKey: string, intensity: number) => void,
  ): void {
    if (
      sprayTargets.length === 0
      && oneShotSprays.length === 0
      && this.particleCount === 0
      && this.spraySpawnBudget.size === 0
    ) {
      return;
    }

    this._time += dtMs;
    const dtSec = Math.max(0, Math.min(dtMs, 100)) / 1000;

    this.advanceParticles(dtSec, onPylonTubeHandoff);
    this.livePylonTips.clear();
    this.activeSprayKeys.clear();

    for (const spray of oneShotSprays) {
      if (spray.intensity <= 0) continue;
      const scaledIntensity = Math.min(1, spray.intensity);
      const color = this.resolveSprayColor(spray);
      this.emitParticle(spray, scaledIntensity, color.r, color.g, color.b);
    }

    for (const spray of sprayTargets) {
      this.registerLivePylonTip(spray);
      const hasAbsoluteBallRate = spray.ballSpawnRate !== undefined;
      const ballSpawnRate = hasAbsoluteBallRate && Number.isFinite(spray.ballSpawnRate)
        ? Math.max(0, spray.ballSpawnRate as number)
        : 0;
      // Abs-rate sprays render whenever their ball rate is positive, even
      // if the cap-normalized intensity rounds to ~0 (a big host at a low
      // fraction still moves real resources).
      if (hasAbsoluteBallRate) {
        if (ballSpawnRate <= 0) continue;
      } else if (spray.intensity <= 0) {
        continue;
      }
      const scaledIntensity = Math.min(1, spray.intensity);
      // Build sprays are intentionally denser than heal sprays because
      // they represent a construction emitter painting a footprint, not
      // a single repair beam.
      const baseCount = spray.type === 'build' ? 36 : 16;
      // Legacy fallback: sprays without an absolute ball rate (old 2D
      // targets) scale their spawn count with intensity. Pylon/build/repair
      // sprays carry ballSpawnRate and spawn from absolute throughput.
      const minCount = spray.type === 'build' ? 1 : 4;
      const count = Math.max(minCount, Math.floor(baseCount * scaledIntensity));
      const n = Math.min(count, MAX_PARTICLES_PER_SPRAY);

      // Resolve per-spray color once. Per-spray colorRGB override
      // wins (used by the factory + commander per-resource sprays so
      // each colored stream reads as its resource regardless of
      // team). Otherwise heal sprays are white and build sprays use
      // the caster's team primary.
      const color = this.resolveSprayColor(spray);

      const dist = this.estimatePathDistance(spray);
      const flightSec = this.flightTimeForDistance(dist, spray);
      const key = this.sprayKey(spray);
      this.activeSprayKeys.add(key);
      let budget = this.spraySpawnBudget.get(key) ?? 0;
      // Absolute-rate spawn: balls/second comes straight from the resource
      // transfer rate. The budget accumulator integrates it over time, so a
      // step change in rate retunes the cadence without popping in-flight
      // particles. Falls back to the intensity-derived count for sprays that
      // carry no absolute rate (legacy).
      const spawnRatePerSec = hasAbsoluteBallRate
        ? ballSpawnRate
        : n / Math.max(flightSec, MIN_FLIGHT_SEC);
      budget += spawnRatePerSec * dtSec;
      const spawnCount = Math.min(
        MAX_PARTICLE_SPAWNS_PER_SPRAY_FRAME,
        Math.floor(budget),
      );
      budget -= spawnCount;
      this.spraySpawnBudget.set(key, budget);

      for (let i = 0; i < spawnCount; i++) {
        this.emitParticle(spray, scaledIntensity, color.r, color.g, color.b);
      }
    }

    this.retargetPylonTipParticles();

    for (const key of this.spraySpawnBudget.keys()) {
      if (!this.activeSprayKeys.has(key)) this.spraySpawnBudget.delete(key);
    }

    const visibleCount = this.writeParticlesToMesh();

    // Cap draw to the live prefix — trailing slots (whatever they
    // happen to hold from previous frames) don't render.
    if (this.mesh.count !== visibleCount) this.mesh.count = visibleCount;
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
    return `${spray.type}:${spray.source.id}:${spray.target.id}:${spray.channel}:${spray.flow}`;
  }

  private registerLivePylonTip(spray: SprayTarget): void {
    const key = spray.pylonTubeHandoffKey;
    if (!key) return;
    let tip = this.livePylonTips.get(key);
    if (!tip) {
      tip = { x: 0, y: 0, z: 0 };
      this.livePylonTips.set(key, tip);
    }
    tip.x = spray.target.pos.x;
    tip.y = spray.target.z ?? TRAIL_Y;
    tip.z = spray.target.pos.y;
  }

  private retargetPylonTipParticles(): void {
    if (this.livePylonTips.size === 0) return;
    for (let i = 0; i < this.particleCount; i++) {
      const key = this.pTubeHandoffKey[i];
      if (key === null) continue;
      const tip = this.livePylonTips.get(key);
      if (!tip) continue;
      this.pEndX[i] = tip.x;
      this.pEndY[i] = tip.y;
      this.pEndZ[i] = tip.z;
      if (this.pMidSplit[i] > 0) {
        this.pMidX[i] = tip.x;
        this.pMidY[i] = tip.y;
        this.pMidZ[i] = tip.z;
      }
    }
  }

  private resolveSprayColor(spray: SprayTarget): { r: number; g: number; b: number } {
    if (spray.colorRGB) {
      return spray.colorRGB;
    }
    if (spray.type === 'heal' || spray.source.playerId === undefined) {
      return { r: HEAL_R, g: HEAL_G, b: HEAL_B };
    }
    const cached = this._teamColorCache.get(spray.source.playerId);
    if (cached) return cached;
    const color = hexToRgb01(getPlayerPrimaryColor(spray.source.playerId));
    this._teamColorCache.set(spray.source.playerId, color);
    return color;
  }

  private endpointFadeDir(spray: SprayTarget): number {
    if (spray.type !== 'build') return 0;
    switch (spray.endpointFade) {
      case 'none': return 0;
      case 'start': return -1;
      case 'end': return 1;
      case 'both':
      case undefined:
        return 2;
    }
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

  private flightTimeForDistance(distance: number, spray: Pick<SprayTarget, 'type' | 'speed'>): number {
    if (spray.type === 'build') {
      // Build sprays travel at constant speed end-to-end with no
      // lifespan ceiling — flight time is purely distance / speed.
      return distance / this.buildParticleSpeed(spray.speed);
    }
    return Math.max(
      MIN_FLIGHT_SEC,
      Math.min(HEAL_MAX_FLIGHT_SEC, distance / HEAL_PARTICLE_SPEED),
    );
  }

  private buildParticleSpeed(speed: number | undefined): number {
    return speed !== undefined && Number.isFinite(speed) && speed > 0
      ? speed
      : DEFAULT_BUILD_PARTICLE_SPEED;
  }

  private buildParticleRadius(radius: number | undefined): number {
    return radius !== undefined && Number.isFinite(radius) && radius > 0
      ? radius
      : DEFAULT_BUILD_PARTICLE_RADIUS;
  }

  private estimatePathDistance(spray: SprayTarget): number {
    const sx = spray.source.pos.x;
    const sy = spray.source.z ?? TRAIL_Y;
    const sz = spray.source.pos.y;
    const tx = spray.target.pos.x;
    const ty = spray.target.z ?? TRAIL_Y;
    const tz = spray.target.pos.y;
    const wp1 = spray.waypoint;
    const wp2 = spray.waypoint2;
    if (wp1 && wp2) {
      const m1x = wp1.pos.x;
      const m1y = wp1.z ?? TRAIL_Y;
      const m1z = wp1.pos.y;
      const m2x = wp2.pos.x;
      const m2y = wp2.z ?? TRAIL_Y;
      const m2z = wp2.pos.y;
      return Math.max(
        1,
        Math.hypot(m1x - sx, m1y - sy, m1z - sz) +
          Math.hypot(m2x - m1x, m2y - m1y, m2z - m1z) +
          Math.hypot(tx - m2x, ty - m2y, tz - m2z),
      );
    }
    if (wp1) {
      const mx = wp1.pos.x;
      const my = wp1.z ?? TRAIL_Y;
      const mz = wp1.pos.y;
      return Math.max(
        1,
        Math.hypot(mx - sx, my - sy, mz - sz) +
          Math.hypot(tx - mx, ty - my, tz - mz),
      );
    }
    if (spray.flow === 'randomInbound') {
      return Math.max(
        1,
        spray.flowRadius + Math.hypot(tx - sx, ty - sy, tz - sz),
      );
    }
    if (spray.flow === 'randomOutbound') {
      return Math.max(
        1,
        Math.hypot(tx - sx, ty - sy, tz - sz) + spray.flowRadius,
      );
    }
    return Math.max(1, Math.hypot(tx - sx, ty - sy, tz - sz));
  }

  private emitParticle(
    spray: SprayTarget,
    scaledIntensity: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (this.particleCount >= MAX_PARTICLES) return;

    let sx = spray.source.pos.x;
    let sy = spray.source.z ?? TRAIL_Y;
    let sz = spray.source.pos.y;
    let tx = spray.target.pos.x;
    let ty = spray.target.z ?? TRAIL_Y;
    let tz = spray.target.pos.y;
    let midX = spray.waypoint?.pos.x ?? 0;
    let midY = spray.waypoint?.z ?? 0;
    let midZ = spray.waypoint?.pos.y ?? 0;
    let hasMid = spray.waypoint !== undefined;
    let mid2X = spray.waypoint2?.pos.x ?? 0;
    let mid2Y = spray.waypoint2?.z ?? 0;
    let mid2Z = spray.waypoint2?.pos.y ?? 0;
    let hasMid2 = spray.waypoint2 !== undefined;
    if (spray.flow !== 'direct') {
      const radius = Math.max(1, spray.flowRadius);
      const coneAxis = spray.coneAxis;
      const coneAngle = spray.coneAngle;
      const useCone = coneAxis !== undefined
        && coneAngle !== undefined
        && coneAngle > 0
        && coneAngle < Math.PI;
      let ox: number;
      let oy: number;
      let oz: number;
      if (useCone) {
        // Standardized ray + cone: the pylon tip is the cone apex. For
        // the 3-leg economy stream (root -> tip -> world) the tip is the
        // waypoint; for a bare free leg (tip -> world) it's the source.
        // Either way the cone opens from the tip toward the lock-on spot
        // along `coneAxis`, dispersed within half-angle `coneAngle`.
        const apexX = hasMid ? midX : sx;
        const apexY = hasMid ? midY : sy;
        const apexZ = hasMid ? midZ : sz;
        // Sample a direction inside the cone — uniform in solid angle so
        // the spread reads evenly rather than bunching on the axis.
        const cosA = Math.cos(coneAngle!);
        const cosTheta = 1 - this.random() * (1 - cosA);
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        const phi = this.random() * Math.PI * 2;
        const ax = coneAxis!.x;
        const ay = coneAxis!.y;
        const az = coneAxis!.z;
        // Orthonormal basis (t1, t2) perpendicular to the axis. Pick a
        // helper that isn't parallel to the axis, then Gram-Schmidt.
        let hx = 0;
        let hy = 1;
        let hz = 0;
        if (Math.abs(ay) > 0.9) { hx = 1; hy = 0; hz = 0; }
        let t1x = hy * az - hz * ay;
        let t1y = hz * ax - hx * az;
        let t1z = hx * ay - hy * ax;
        const t1len = Math.hypot(t1x, t1y, t1z) || 1;
        t1x /= t1len; t1y /= t1len; t1z /= t1len;
        const t2x = ay * t1z - az * t1y;
        const t2y = az * t1x - ax * t1z;
        const t2z = ax * t1y - ay * t1x;
        const sc = sinTheta * Math.cos(phi);
        const ss = sinTheta * Math.sin(phi);
        const dirX = t1x * sc + t2x * ss + ax * cosTheta;
        const dirY = t1y * sc + t2y * ss + ay * cosTheta;
        const dirZ = t1z * sc + t2z * ss + az * cosTheta;
        const shell = radius * (0.55 + this.random() * 0.45);
        ox = apexX + dirX * shell;
        oy = apexY + dirY * shell;
        oz = apexZ + dirZ * shell;
        if (spray.flow === 'randomInbound') {
          midX = apexX; midY = apexY; midZ = apexZ;
          hasMid = true;
          sx = ox; sy = oy; sz = oz;
        } else {
          midX = apexX; midY = apexY; midZ = apexZ;
          hasMid = true;
          hasMid2 = false;
          tx = ox; ty = oy; tz = oz;
        }
      } else {
        // Legacy: random point on the full sphere shell around the source.
        const azimuth = this.random() * Math.PI * 2;
        const cosTheta = 1 - 2 * this.random();
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        const shell = radius * (0.45 + this.random() * 0.55);
        ox = sx + Math.cos(azimuth) * sinTheta * shell;
        oy = sy + cosTheta * shell;
        oz = sz + Math.sin(azimuth) * sinTheta * shell;
        if (spray.flow === 'randomInbound') {
          midX = sx;
          midY = sy;
          midZ = sz;
          hasMid = true;
          sx = ox;
          sy = oy;
          sz = oz;
        } else {
          midX = tx;
          midY = ty;
          midZ = tz;
          hasMid = true;
          hasMid2 = false;
          tx = ox;
          ty = oy;
          tz = oz;
        }
      }
    }
    const dim = spray.target.dim;
    const sphereRadius = Math.max(spray.target.radius ?? 0, 0);

    let endX = tx;
    let endY = ty;
    let endZ = tz;
    if (spray.type === 'build' && spray.flow !== 'direct') {
      endX = tx;
      endY = ty;
      endZ = tz;
    } else if (spray.type === 'build' && spray.waypoint && spray.flowRadius > 0) {
      endX = tx;
      endY = ty;
      endZ = tz;
    } else if (spray.type === 'build') {
      // Build sprays paint the full volume of the thing being built so
      // particles arrive distributed across every part of the target —
      // a uniform 3D sphere when only `radius` is supplied, or a
      // uniform box when explicit `dim` extents are given. Either way
      // the endpoints fill the volume rather than a flat disk slice.
      if (dim) {
        const halfX = dim.x * 0.5;
        const halfZ = dim.y * 0.5;
        const halfY = sphereRadius > 0 ? sphereRadius : Math.min(halfX, halfZ);
        endX = tx + (this.random() * 2 - 1) * halfX;
        endY = ty + (this.random() * 2 - 1) * halfY;
        endZ = tz + (this.random() * 2 - 1) * halfZ;
      } else {
        // Uniform-volume sphere: cube-root for radial CDF, then a
        // random unit vector via cos(θ) ∈ [-1,1].
        const r = sphereRadius * Math.cbrt(this.random());
        const cosTheta = 1 - 2 * this.random();
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        const phi = this.random() * Math.PI * 2;
        endX = tx + r * sinTheta * Math.cos(phi);
        endY = ty + r * cosTheta;
        endZ = tz + r * sinTheta * Math.sin(phi);
      }
    } else {
      // Heal: small disk + tiny vertical jitter around the target — a
      // beam-like stream rather than a volumetric paint.
      const healSpread = sphereRadius * 0.25;
      const areaPhase = this.random() * Math.PI * 2;
      const areaRing = healSpread * Math.sqrt(this.random());
      endX = tx + Math.cos(areaPhase) * areaRing;
      endZ = tz + Math.sin(areaPhase) * areaRing;
      endY = ty + (this.random() * 2 - 1) * Math.min(healSpread * 0.4, 5);
    }
    const targetSpread = spray.flow !== 'direct'
      ? Math.max(1, spray.flowRadius)
      : spray.type === 'build'
        ? (dim ? Math.max(dim.x, dim.y, sphereRadius * 2) * 0.5 : sphereRadius)
        : sphereRadius * 0.25;
    let len = Math.hypot(endX - sx, endY - sy, endZ - sz);
    let split = 0;
    let split2 = 0;
    if (hasMid && hasMid2) {
      const lenA = Math.hypot(midX - sx, midY - sy, midZ - sz);
      const lenB = Math.hypot(mid2X - midX, mid2Y - midY, mid2Z - midZ);
      const lenC = Math.hypot(endX - mid2X, endY - mid2Y, endZ - mid2Z);
      len = lenA + lenB + lenC;
      if (len > 1e-3) {
        split = lenA / len;
        split2 = (lenA + lenB) / len;
      }
    } else if (hasMid) {
      const lenA = Math.hypot(midX - sx, midY - sy, midZ - sz);
      const lenB = Math.hypot(endX - midX, endY - midY, endZ - midZ);
      len = lenA + lenB;
      split = len > 1e-3 ? lenA / len : 0;
    }
    if (len < 1e-3) return;

    const idx = this.particleCount++;
    const life = this.flightTimeForDistance(len, spray) * (0.86 + this.random() * 0.28);
    this.pStartX[idx] = sx;
    this.pStartY[idx] = sy;
    this.pStartZ[idx] = sz;
    this.pEndX[idx] = endX;
    this.pEndY[idx] = endY;
    this.pEndZ[idx] = endZ;
    this.pMidX[idx] = midX;
    this.pMidY[idx] = midY;
    this.pMidZ[idx] = midZ;
    this.pMidSplit[idx] = hasMid ? Math.max(0.001, Math.min(0.999, split)) : 0;
    this.pMid2X[idx] = mid2X;
    this.pMid2Y[idx] = mid2Y;
    this.pMid2Z[idx] = mid2Z;
    this.pMid2Split[idx] = hasMid && hasMid2
      ? Math.max(this.pMidSplit[idx] + 0.001, Math.min(0.999, split2))
      : 0;
    this.pAge[idx] = 0;
    this.pLife[idx] = life;
    if (spray.type === 'build') {
      // All build particles render at exactly the construction
      // emitter particle radius — no per-particle jitter, no scaling, no
      // mid-flight growth (see writeParticlesToMesh).
      this.pSize[idx] = this.buildParticleRadius(spray.particleRadius);
      this.pUniformSize[idx] = 1;
      this.pFadeDir[idx] = this.endpointFadeDir(spray);
    } else {
      this.pSize[idx] = HEAL_PARTICLE_BASE_RADIUS
        * (0.72 + this.random() * 0.52)
        * (0.5 + 0.5 * scaledIntensity);
      this.pUniformSize[idx] = 0;
      this.pFadeDir[idx] = 0;
    }
    // Build sprays travel in a straight line (no wiggle); heal sprays
    // keep the perpendicular sine oscillation for a stream-like read.
    this.pWobble[idx] = spray.type === 'build'
      ? 0
      : len * 0.018 + targetSpread * 0.035;
    // Build sprays are renderer-owned straight-line particles: no
    // gravity, no lob arc.
    this.pArc[idx] = spray.type === 'build'
      ? 0
      : Math.min(18, Math.max(3, len * 0.045));
    this.pSeed[idx] = this.random() * Math.PI * 2;
    this.pR[idx] = r;
    this.pG[idx] = g;
    this.pB[idx] = b;
    this.pEndR[idx] = spray.endColorRGB?.r ?? r;
    this.pEndG[idx] = spray.endColorRGB?.g ?? g;
    this.pEndB[idx] = spray.endColorRGB?.b ?? b;
    this.pTubeHandoffKey[idx] = spray.pylonTubeHandoffKey ?? null;
    this.pTubeHandoffIntensity[idx] = scaledIntensity;
  }

  private advanceParticles(
    dtSec: number,
    onPylonTubeHandoff: ((flowKey: string, intensity: number) => void) | undefined,
  ): void {
    if (dtSec <= 0) return;
    for (let i = 0; i < this.particleCount; i++) {
      this.pAge[i] += dtSec;
      if (this.pAge[i] >= this.pLife[i]) {
        const handoffKey = this.pTubeHandoffKey[i];
        if (handoffKey !== null) {
          onPylonTubeHandoff?.(handoffKey, this.pTubeHandoffIntensity[i]);
        }
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
      this.pMidX[index] = this.pMidX[last];
      this.pMidY[index] = this.pMidY[last];
      this.pMidZ[index] = this.pMidZ[last];
      this.pMidSplit[index] = this.pMidSplit[last];
      this.pMid2X[index] = this.pMid2X[last];
      this.pMid2Y[index] = this.pMid2Y[last];
      this.pMid2Z[index] = this.pMid2Z[last];
      this.pMid2Split[index] = this.pMid2Split[last];
      this.pAge[index] = this.pAge[last];
      this.pLife[index] = this.pLife[last];
      this.pSize[index] = this.pSize[last];
      this.pUniformSize[index] = this.pUniformSize[last];
      this.pFadeDir[index] = this.pFadeDir[last];
      this.pWobble[index] = this.pWobble[last];
      this.pArc[index] = this.pArc[last];
      this.pSeed[index] = this.pSeed[last];
      this.pR[index] = this.pR[last];
      this.pG[index] = this.pG[last];
      this.pB[index] = this.pB[last];
      this.pEndR[index] = this.pEndR[last];
      this.pEndG[index] = this.pEndG[last];
      this.pEndB[index] = this.pEndB[last];
      this.pTubeHandoffKey[index] = this.pTubeHandoffKey[last];
      this.pTubeHandoffIntensity[index] = this.pTubeHandoffIntensity[last];
    }
    this.pTubeHandoffKey[last] = null;
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
      let segStartX = sx;
      let segStartY = sy;
      let segStartZ = sz;
      let segEndX = this.pEndX[i];
      let segEndY = this.pEndY[i];
      let segEndZ = this.pEndZ[i];
      let segmentPhase = phase;
      const split = this.pMidSplit[i];
      const split2 = this.pMid2Split[i];
      if (split > 0 && split2 > split) {
        if (phase < split) {
          segEndX = this.pMidX[i];
          segEndY = this.pMidY[i];
          segEndZ = this.pMidZ[i];
          segmentPhase = phase / split;
        } else if (phase < split2) {
          segStartX = this.pMidX[i];
          segStartY = this.pMidY[i];
          segStartZ = this.pMidZ[i];
          segEndX = this.pMid2X[i];
          segEndY = this.pMid2Y[i];
          segEndZ = this.pMid2Z[i];
          segmentPhase = (phase - split) / (split2 - split);
        } else {
          segStartX = this.pMid2X[i];
          segStartY = this.pMid2Y[i];
          segStartZ = this.pMid2Z[i];
          segmentPhase = (phase - split2) / (1 - split2);
        }
      } else if (split > 0) {
        if (phase < split) {
          segEndX = this.pMidX[i];
          segEndY = this.pMidY[i];
          segEndZ = this.pMidZ[i];
          segmentPhase = phase / split;
        } else {
          segStartX = this.pMidX[i];
          segStartY = this.pMidY[i];
          segStartZ = this.pMidZ[i];
          segmentPhase = (phase - split) / (1 - split);
        }
      }
      const dx = segEndX - segStartX;
      const dy = segEndY - segStartY;
      const dz = segEndZ - segStartZ;
      const flatLen = Math.hypot(dx, dz);
      const perpX = flatLen > 1e-3 ? -dz / flatLen : 1;
      const perpZ = flatLen > 1e-3 ? dx / flatLen : 0;
      const envelope = Math.sin(phase * Math.PI);
      const wobble = Math.sin(timeSec * 8.5 + this.pSeed[i] + phase * Math.PI * 4)
        * this.pWobble[i]
        * envelope;
      const px = segStartX + dx * segmentPhase + perpX * wobble;
      const py = segStartY + dy * segmentPhase + this.pArc[i] * envelope;
      const pz = segStartZ + dz * segmentPhase + perpZ * wobble;

      // Pylon particles fade only at their creation/destruction
      // endpoints. The pylon tip is just a waypoint, so a particle
      // remains visible while it passes through the head.
      const fadeDir = this.pFadeDir[i];
      const fadeScale = fadeDir === 0
        ? 1
        : fadeDir === 2
          ? Math.min(1, phase / 0.14, (1 - phase) / 0.14)
        : fadeDir > 0
          ? 1 - phase
          : phase;
      const alpha = PARTICLE_ALPHA * fadeScale;

      // Heal particles inflate slightly as they fly (start 0.78×, end
      // 1.14×). Build particles render at uniform size — pSize is the
      // exact final radius from the blueprint.
      const size = this.pUniformSize[i]
        ? this.pSize[i]
        : this.pSize[i] * (0.78 + 0.36 * phase);
      this._scratchMat.makeScale(size, size, size);
      this._scratchMat.setPosition(px, py, pz);
      this.mesh.setMatrixAt(visibleCount, this._scratchMat);
      const colorPhase = split > 0 && split2 > split
        ? phase <= split
          ? 0
          : phase >= split2
            ? 1
            : (phase - split) / (split2 - split)
        : phase;
      this.colorArr[visibleCount * 3] = this.pR[i] + (this.pEndR[i] - this.pR[i]) * colorPhase;
      this.colorArr[visibleCount * 3 + 1] = this.pG[i] + (this.pEndG[i] - this.pG[i]) * colorPhase;
      this.colorArr[visibleCount * 3 + 2] = this.pB[i] + (this.pEndB[i] - this.pB[i]) * colorPhase;
      this.alphaArr[visibleCount] = alpha;
      visibleCount++;
    }

    return visibleCount;
  }

  destroy(): void {
    disposeMesh(this.mesh);
    this._teamColorCache.clear();
    this.spraySpawnBudget.clear();
    this.activeSprayKeys.clear();
    this.root.parent?.remove(this.root);
  }
}
