// SmokeTrail3D — fading smoke-puff particles trailing projectiles
// whose shot declares a SmokeTrailSpec (rockets, missiles, anything
// thrust-powered).
//
// Each projectile samples one puff on selected render frames. The
// cadence is a frame-skip count, not an elapsed-time accumulator, so a
// slow frame never dumps a backlog burst and each trail reads with stable
// visual spacing. A puff is one slot in a single shared InstancedMesh —
// it stays put in world space as the rocket flies away, grows slightly,
// and fades to transparent over its configured fade timing.
//
// Per-puff scale, alpha, and color ride on the InstancedMesh instance
// matrix + custom InstancedBufferAttributes (aAlpha, aColor). Two shared
// materials carry the same instanced geometry: the legacy SPHERE shader
// (`gl_FragColor = vec4(vColor, vAlpha);` — a hard-edged translucent
// ball) and the SOFT shader (a fog-of-war-style radial cosine fade that
// drops alpha to zero before the projected silhouette, so the puff reads
// as a soft blob rather than a sphere). The PLAYER CLIENT bar's SOFT
// toggle (clientBarConfig `smokeSoftEdges`) swaps which material the mesh
// uses at runtime — see update().
//
// One shared instanced pool renders every smoke use. Puff geometry
// resolution comes from smokeConfig.puffGeometry.
//
// Smoke density, velocity, fade timing, size, and per-use caps come
// from flat smokeConfig entries keyed by the actual smoke producer
// (shot blueprint id or locomotion blueprint id).

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { COLORS } from '@/colorsConfig';
import { getSmokeTrails, getSmokeSoftEdges } from '@/clientBarConfig';
import {
  getSmokePuffGeometryConfig,
  getSmokePoolMaxParticles,
  type ResolvedSmokeProfile,
  type SmokeCapPolicy,
  type SmokeUseId,
} from '@/smokeConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import { disposeMesh } from './threeUtils';

const DEFAULT_COLOR = COLORS.effects.smokeTrail.default.colorHex;
const MAX_PARTICLES = getSmokePoolMaxParticles();
const PUFF_GEOMETRY = getSmokePuffGeometryConfig();

type SmokeSpawnProfile = {
  useId: SmokeUseId;
  maxPoolSize: number;
  capPolicy: SmokeCapPolicy;
  emitFramesSkip: number;
  fadeInMs: number;
  fadeOutMs: number;
  startRadius: number;
  endRadiusMultiplier: number;
  maxAlpha: number;
};

type Puff = {
  /** Config use key that owns this puff's per-use budget. */
  useId: SmokeUseId;
  /** Seconds of life remaining. Reaches ≤ 0 → swap-popped. */
  timeLeft: number;
  /** Seconds since birth. Used for fade-in and radius growth. */
  age: number;
  /** Total derived duration in seconds (for interpolating scale / alpha). */
  durationSec: number;
  /** Per-puff visual params, captured at spawn time from the shot's
   *  SmokeTrailSpec so a single SmokeTrail3D can serve many shot
  *  types simultaneously. */
  startRadius: number;
  finalRadius: number;
  maxAlpha: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** Fixed spawn position in three.js coords (sim Y → three Z). The
   *  puff stays put as the rocket flies away — only its scale and
   *  alpha change frame-to-frame. */
  threeX: number;
  threeY: number;
  threeZ: number;
  threeVX: number;
  threeVY: number;
  threeVZ: number;
  /** Unpacked sRGB color for this puff. Stored on the Puff (not on
   *  a shared material) so shots with different `color` fields can
   *  coexist in the same instanced mesh. */
  r: number;
  g: number;
  b: number;
};

export type SmokePuffEmitter = {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  useId: SmokeUseId;
  maxPoolSize: number;
  capPolicy: SmokeCapPolicy;
  emitFramesSkip: number;
  fadeInMs: number;
  fadeOutMs: number;
  startRadius: number;
  endRadiusMultiplier: number;
  maxAlpha: number;
  color?: number;
  phase?: number;
};

const SMOKE_VERTEX_SHADER = `
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

const SMOKE_FRAGMENT_SHADER = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

// SOFT (non-sphere) variant. Same approach as FogOfWarFog3D: carry the
// view-space puff center + radius so the fragment can measure each
// pixel's normalized distance from the projected center and ease alpha
// to zero with a raised cosine BEFORE the geometric silhouette. The hard
// sphere outline is never drawn, so the puff reads as a soft round blob.
// Outer fraction matches the fog field (fogConfig transparentOuterFraction
// = 0.4) so smoke and fog softness feel consistent. Color is output the
// same way as the sphere shader (no colorspace include) so toggling SOFT
// changes only the puff's shape, never its color.
const SMOKE_SOFT_OUTER_FRACTION = 0.4;

const SMOKE_SOFT_VERTEX_SHADER = `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
varying vec3 vViewPosition;
varying vec3 vViewCenter;
varying float vViewRadius;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 viewCenter = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 viewPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  vViewCenter = viewCenter.xyz;
  vViewRadius = length((modelViewMatrix * instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const SMOKE_SOFT_FRAGMENT_SHADER = `
uniform float uTransparentOuterFraction;
varying float vAlpha;
varying vec3 vColor;
varying vec3 vViewPosition;
varying vec3 vViewCenter;
varying float vViewRadius;
void main() {
  float edge = clamp(length(vViewPosition.xy - vViewCenter.xy) / max(vViewRadius, 0.0001), 0.0, 1.0);
  float visibleRadius = max(0.0001, 1.0 - clamp(uTransparentOuterFraction, 0.0, 0.95));
  float center = clamp((visibleRadius - edge) / visibleRadius, 0.0, 1.0);
  float soft = 0.5 - 0.5 * cos(center * 3.141592653589793);
  gl_FragColor = vec4(vColor, vAlpha * soft);
}
`;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** One InstancedMesh pool for every smoke puff. */
type PuffPool = {
  maxParticles: number;
  geom: THREE.SphereGeometry;
  mesh: THREE.InstancedMesh;
  alphaArr: Float32Array;
  colorArr: Float32Array;
  alphaAttr: THREE.InstancedBufferAttribute;
  colorAttr: THREE.InstancedBufferAttribute;
  active: Puff[];
  activeByUse: Map<SmokeUseId, number>;
  evictionCursor: number;
  emitterCursor: number;
  colorUpdateMin: number;
  colorUpdateMax: number;
};

export class SmokeTrail3D {
  private root: THREE.Group;
  // Both materials are built up front and share the one instanced
  // geometry; the SOFT bar toggle picks which the mesh draws with.
  private matSphere: THREE.ShaderMaterial;
  private matSoft: THREE.ShaderMaterial;
  private softEdges: boolean;
  private pool: PuffPool;
  // Scratch buffers reused across frames to avoid per-frame allocs.
  private _eligible: Entity[] = [];
  private readonly _emitPoint = { x: 0, y: 0, z: 0 };
  private _scratchMat = new THREE.Matrix4();
  private emissionCursor = 0;
  /** Per-frame "puffs emitted per smoke-use" tally. Hoisted to an
   *  instance field and cleared each emission pass so update() doesn't
   *  allocate a fresh Map every render frame. */
  private readonly _emittedByUse = new Map<SmokeUseId, number>();

  constructor(worldGroup: THREE.Group) {
    this.root = new THREE.Group();
    worldGroup.add(this.root);

    this.matSphere = new THREE.ShaderMaterial({
      vertexShader: SMOKE_VERTEX_SHADER,
      fragmentShader: SMOKE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });
    this.matSoft = new THREE.ShaderMaterial({
      vertexShader: SMOKE_SOFT_VERTEX_SHADER,
      fragmentShader: SMOKE_SOFT_FRAGMENT_SHADER,
      uniforms: {
        uTransparentOuterFraction: { value: SMOKE_SOFT_OUTER_FRACTION },
      },
      transparent: true,
      depthWrite: false,
    });
    this.softEdges = getSmokeSoftEdges();

    this.pool = this.createPool(
      Math.max(3, PUFF_GEOMETRY.widthSegments | 0),
      Math.max(2, PUFF_GEOMETRY.heightSegments | 0),
      MAX_PARTICLES,
    );
  }

  private activeMaterial(): THREE.ShaderMaterial {
    return this.softEdges ? this.matSoft : this.matSphere;
  }

  private createPool(
    widthSegments: number,
    heightSegments: number,
    maxParticles: number,
  ): PuffPool {
    const geom = new THREE.SphereGeometry(1, widthSegments, heightSegments);
    const alphaArr = new Float32Array(maxParticles);
    const colorArr = new Float32Array(maxParticles * 3);
    // Per-instance attribute buffers. Index i in alphaArr / colorArr
    // / instanceMatrix corresponds to active[i] — the live puff list
    // is kept dense at the front of these buffers via swap-pop, so
    // `mesh.count = active.length` exactly bounds what's drawn.
    const alphaAttr = new THREE.InstancedBufferAttribute(alphaArr, 1);
    alphaAttr.setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.InstancedBufferAttribute(colorArr, 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aAlpha', alphaAttr);
    geom.setAttribute('aColor', colorAttr);

    const mesh = new THREE.InstancedMesh(geom, this.activeMaterial(), maxParticles);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    // Frustum culling on InstancedMesh uses a bounding sphere derived
    // from the source geometry — not the per-instance matrices — so a
    // puff far from the origin would be incorrectly culled. Disable.
    mesh.frustumCulled = false;
    // Draw after water (renderOrder=3), so transparent sorting does not
    // let the water plane blend over puffs that are geometrically above it.
    mesh.renderOrder = 5;
    this.root.add(mesh);

    return {
      maxParticles,
      geom,
      mesh,
      alphaArr,
      colorArr,
      alphaAttr,
      colorAttr,
      active: [],
      activeByUse: new Map(),
      evictionCursor: 0,
      emitterCursor: 0,
      colorUpdateMin: Number.POSITIVE_INFINITY,
      colorUpdateMax: -1,
    };
  }

  /** Per-frame tick: advance existing puffs, emit new ones behind
   *  each qualifying projectile, drop emitter state for projectiles
   *  no longer present. `dtMs` is the clamped effect dt the scene
   *  uses for other particle systems.
   *
   *  RENDER-mode aware: when `scope` is provided, sources outside the
   *  current WIN/PAD/ALL footprint skip spawning. Re-entering scope
   *  resumes on the next matching frame phase with no backlog burst.
   *  Already-live puffs are NOT culled — they fade in place naturally
   *  as the camera pans away from them. */
  update(
    projectiles: readonly Entity[],
    dtMs: number,
    renderFrameIndex: number,
    scope?: ViewportFootprint,
    emitters?: readonly SmokePuffEmitter[],
  ): void {
    // PLAYER CLIENT bar toggle: when off, wipe any live puffs and skip
    // every advance / emit path so toggling off clears the screen
    // immediately and the renderer does no per-frame work.
    if (!getSmokeTrails()) {
      if (this.pool.active.length > 0) {
        this.pool.active.length = 0;
        this.pool.activeByUse.clear();
        this.flushPool(this.pool);
      }
      return;
    }

    // PLAYER CLIENT bar SOFT toggle: swap the mesh between the legacy
    // hard-sphere material and the soft radial-fade material when the
    // setting changes. Live puffs keep their slots — only the shader
    // that draws them changes, so the switch is instant and seamless.
    const wantSoftEdges = getSmokeSoftEdges();
    if (wantSoftEdges !== this.softEdges) {
      this.softEdges = wantSoftEdges;
      this.pool.mesh.material = this.activeMaterial();
    }

    if (
      projectiles.length === 0 &&
      this.pool.active.length === 0 &&
      (!emitters || emitters.length === 0)
    ) return;

    const dtSec = dtMs / 1000;

    // 1) Advance + fade existing puffs in place. Dead
    //    ones are swap-popped: the last live puff takes the dead slot's
    //    index, and we re-process that index without advancing — so a
    //    long chain of die-this-frame puffs collapses correctly in one
    //    pass. Each surviving puff writes matrix + alpha every frame;
    //    color is static after spawn and only moves when swap-pop
    //    compaction changes a puff's slot.
    this.advancePool(this.pool, dtSec);

    // 2) For each projectile that leaves a trail, sample at its
    //    frame-skip cadence. Then apply a steady-state per-use emission
    //    budget so a large salvo does not fill that use's pool in one
    //    burst and then go silent until old puffs expire.
    const eligible = this._eligible;
    eligible.length = 0;
    for (const e of projectiles) {
      const profile = e.projectile?.config.shotProfile;
      if (!profile?.runtime.isProjectile) continue;
      const spec = profile.visual.smokeTrail as ResolvedSmokeProfile | undefined;
      if (!spec) continue;
      // RENDER scope cull: off-screen projectiles do no smoke work.
      // Re-entering scope resumes on the next matching frame phase,
      // with no missed-frame burst to catch up.
      if (scope && !scope.inScope(e.transform.x, e.transform.y)) continue;

      const stride = Math.max(1, Math.max(0, spec.emitFramesSkip) + 1);
      // Phase by projectile id so a salvo does not allocate every puff
      // on the same frame under a sparse emission cadence.
      if ((renderFrameIndex + (e.id % stride)) % stride !== 0) continue;
      eligible.push(e);
    }

    if (eligible.length > 0) {
      const emittedByUse = this._emittedByUse;
      emittedByUse.clear();
      const start = this.emissionCursor % eligible.length;
      let totalEmitted = 0;
      for (let n = 0; n < eligible.length; n++) {
        const e = eligible[(start + n) % eligible.length];
        const proj = e.projectile!;
        const visual = proj.config.shotProfile.visual;
        const spec = visual.smokeTrail as ResolvedSmokeProfile;
        const useEmitted = emittedByUse.get(spec.useId) ?? 0;
        if (useEmitted >= this.emissionBudget(spec, dtSec)) continue;
        const emit = this.getTailEmitterPoint(e, visual.projectileTailLengthMult);
        // Puff exhaust drifts opposite to the projectile's flight
        // direction at `exhaustSpeed`. Zero (the default) keeps puffs
        // stationary in world space, which is the legacy behavior.
        const exhaustSpeed = Math.max(0, spec.exhaustSpeed);
        let puffVx = 0;
        let puffVy = 0;
        let puffVz = 0;
        if (exhaustSpeed > 0) {
          const vx = proj.velocityX;
          const vy = proj.velocityY;
          const vz = proj.velocityZ;
          const len2 = vx * vx + vy * vy + vz * vz;
          if (len2 > 1e-6) {
            const inv = exhaustSpeed / Math.sqrt(len2);
            puffVx = -vx * inv;
            puffVy = -vy * inv;
            puffVz = -vz * inv;
          }
        }
        const spawned = this.spawnPuff(
          this.pool,
          emit.x, emit.y, emit.z,
          puffVx, puffVy, puffVz,
          spec,
          spec.color ?? DEFAULT_COLOR,
        );
        if (!spawned) continue;
        emittedByUse.set(spec.useId, useEmitted + 1);
        totalEmitted++;
      }
      this.emissionCursor = (start + Math.max(1, totalEmitted)) % eligible.length;
    }

    if (emitters && emitters.length > 0) {
      this.emitFromEmitters(
        emitters, scope, dtSec, renderFrameIndex,
      );
    }

    // 3) Push attribute updates to GPU and bound the draw to the
    //    live-puff prefix.
    this.flushPool(this.pool);
  }

  private advancePool(pool: PuffPool, dtSec: number): void {
    let i = 0;
    while (i < pool.active.length) {
      const p = pool.active[i];
      p.timeLeft -= dtSec;
      p.age += dtSec;
      if (p.timeLeft <= 0) {
        this.adjustUseCount(pool, p.useId, -1);
        const last = pool.active.length - 1;
        if (i !== last) {
          pool.active[i] = pool.active[last];
          this.writePuffColor(pool, i, pool.active[i]);
        }
        pool.active.pop();
        continue;
      }
      const t = 1 - p.timeLeft / p.durationSec; // 0 → 1 over life
      const r = p.startRadius + t * (p.finalRadius - p.startRadius);
      const fadeIn = p.fadeInSec <= 0 ? 1 : clamp01(p.age / p.fadeInSec);
      const fadeOutStartSec = Math.max(0, p.durationSec - p.fadeOutSec);
      const fadeOut = p.fadeOutSec <= 0 || p.age <= fadeOutStartSec
        ? 1
        : clamp01((p.durationSec - p.age) / p.fadeOutSec);
      const alpha = p.maxAlpha * fadeIn * fadeOut;

      p.threeX += p.threeVX * dtSec;
      p.threeY += p.threeVY * dtSec;
      p.threeZ += p.threeVZ * dtSec;

      this._scratchMat.makeScale(r, r, r);
      this._scratchMat.setPosition(p.threeX, p.threeY, p.threeZ);
      pool.mesh.setMatrixAt(i, this._scratchMat);
      pool.alphaArr[i] = alpha;
      i++;
    }
  }

  private emitFromEmitters(
    emitters: readonly SmokePuffEmitter[],
    scope: ViewportFootprint | undefined,
    dtSec: number,
    renderFrameIndex: number,
  ): void {
    this.emitFromEmittersForPool(this.pool, emitters, scope, dtSec, renderFrameIndex);
  }

  private emitFromEmittersForPool(
    pool: PuffPool,
    emitters: readonly SmokePuffEmitter[],
    scope: ViewportFootprint | undefined,
    dtSec: number,
    renderFrameIndex: number,
  ): void {
    const len = emitters.length;
    if (len === 0 || pool.maxParticles <= 0) return;
    const start = pool.emitterCursor % len;
    const emittedByUse = this._emittedByUse;
    emittedByUse.clear();
    let emitted = 0;
    for (let n = 0; n < len; n++) {
      const emitter = emitters[(start + n) % len];
      if (scope && !scope.inScope(emitter.x, emitter.y)) continue;
      const stride = Math.max(1, Math.max(0, emitter.emitFramesSkip) + 1);
      const phase = emitter.phase ?? 0;
      if ((renderFrameIndex + phase) % stride !== 0) continue;
      const useEmitted = emittedByUse.get(emitter.useId) ?? 0;
      if (useEmitted >= this.emissionBudget(emitter, dtSec)) continue;
      const spawned = this.spawnPuff(
        pool,
        emitter.x, emitter.y, emitter.z,
        emitter.vx ?? 0, emitter.vy ?? 0, emitter.vz ?? 0,
        emitter,
        emitter.color ?? DEFAULT_COLOR,
      );
      if (!spawned) continue;
      emittedByUse.set(emitter.useId, useEmitted + 1);
      emitted++;
    }
    pool.emitterCursor = (start + Math.max(1, emitted)) % len;
  }

  private flushPool(pool: PuffPool): void {
    if (pool.mesh.count !== pool.active.length) pool.mesh.count = pool.active.length;
    if (pool.active.length > 0) {
      const count = pool.active.length;
      pool.mesh.instanceMatrix.clearUpdateRanges();
      pool.mesh.instanceMatrix.addUpdateRange(0, count * 16);
      pool.mesh.instanceMatrix.needsUpdate = true;
      pool.alphaAttr.clearUpdateRanges();
      pool.alphaAttr.addUpdateRange(0, count);
      pool.alphaAttr.needsUpdate = true;
      if (pool.colorUpdateMax >= pool.colorUpdateMin) {
        pool.colorAttr.clearUpdateRanges();
        pool.colorAttr.addUpdateRange(
          pool.colorUpdateMin * 3,
          (pool.colorUpdateMax - pool.colorUpdateMin + 1) * 3,
        );
        pool.colorAttr.needsUpdate = true;
        pool.colorUpdateMin = Number.POSITIVE_INFINITY;
        pool.colorUpdateMax = -1;
      }
    } else {
      pool.colorUpdateMin = Number.POSITIVE_INFINITY;
      pool.colorUpdateMax = -1;
    }
  }

  private getTailEmitterPoint(
    entity: Entity,
    tailLengthMult: number,
  ): { x: number; y: number; z: number } {
    const out = this._emitPoint;
    const proj = entity.projectile;
    const radius = proj?.config.shotProfile.runtime.radius.visual ?? 0;
    const tailLength = radius * Math.max(0, tailLengthMult);
    const x = entity.transform.x;
    const y = entity.transform.y;
    const z = entity.transform.z;
    out.x = x;
    out.y = y;
    out.z = z;
    if (!proj || tailLength <= 0) return out;

    const vx = proj.velocityX;
    const vy = proj.velocityY;
    const vz = proj.velocityZ;
    const len2 = vx * vx + vy * vy + vz * vz;
    if (len2 > 1e-6) {
      const inv = 1 / Math.sqrt(len2);
      out.x = x - vx * inv * tailLength;
      out.y = y - vy * inv * tailLength;
      out.z = z - vz * inv * tailLength;
      return out;
    }

    out.x = x - Math.cos(entity.transform.rotation) * tailLength;
    out.y = y - Math.sin(entity.transform.rotation) * tailLength;
    return out;
  }

  private writePuffColor(pool: PuffPool, index: number, puff: Puff): void {
    pool.colorArr[index * 3] = puff.r;
    pool.colorArr[index * 3 + 1] = puff.g;
    pool.colorArr[index * 3 + 2] = puff.b;
    if (index < pool.colorUpdateMin) pool.colorUpdateMin = index;
    if (index > pool.colorUpdateMax) pool.colorUpdateMax = index;
  }

  private adjustUseCount(pool: PuffPool, useId: SmokeUseId, delta: number): void {
    const next = (pool.activeByUse.get(useId) ?? 0) + delta;
    if (next <= 0) pool.activeByUse.delete(useId);
    else pool.activeByUse.set(useId, next);
  }

  private emissionBudget(profile: SmokeSpawnProfile, dtSec: number): number {
    const durationSec = this.smokeDurationSec(profile);
    return Math.max(1, Math.ceil((profile.maxPoolSize * dtSec) / durationSec));
  }

  private smokeDurationSec(profile: SmokeSpawnProfile): number {
    const fadeInSec = Math.max(0, profile.fadeInMs / 1000);
    const fadeOutSec = Math.max(0, profile.fadeOutMs / 1000);
    return Math.max(0.001, fadeInSec + fadeOutSec);
  }

  private spawnPuff(
    pool: PuffPool,
    simX: number, simY: number, simZ: number,
    simVX: number, simVY: number, simVZ: number,
    profile: SmokeSpawnProfile,
    color: number,
  ): boolean {
    const useCap = Math.min(pool.maxParticles, Math.max(0, profile.maxPoolSize | 0));
    if (useCap <= 0) return false;

    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    const fadeInSec = Math.max(0, profile.fadeInMs / 1000);
    const fadeOutSec = Math.max(0, profile.fadeOutMs / 1000);
    const durationSec = this.smokeDurationSec(profile);
    const startRadius = Math.max(0, profile.startRadius);
    const finalRadius = startRadius * Math.max(0, profile.endRadiusMultiplier);

    let i: number;
    let puff: Puff;
    const useCount = pool.activeByUse.get(profile.useId) ?? 0;
    if (useCount >= useCap) {
      if (profile.capPolicy === 'skipWhenFull') return false;
      i = this.pickEvictionSlot(pool, profile.useId);
      puff = pool.active[i];
      if (puff.useId !== profile.useId) {
        this.adjustUseCount(pool, puff.useId, -1);
        this.adjustUseCount(pool, profile.useId, 1);
      }
    } else if (pool.active.length < pool.maxParticles) {
      i = pool.active.length;
      puff = this.createPuff(profile.useId);
      pool.active.push(puff);
      this.adjustUseCount(pool, profile.useId, 1);
    } else {
      if (profile.capPolicy === 'skipWhenFull') return false;
      i = this.pickEvictionSlot(pool);
      puff = pool.active[i];
      this.adjustUseCount(pool, puff.useId, -1);
      this.adjustUseCount(pool, profile.useId, 1);
    }

    this.writePuffSpawn(
      puff,
      profile,
      durationSec,
      fadeInSec,
      fadeOutSec,
      startRadius,
      finalRadius,
      simX,
      simY,
      simZ,
      simVX,
      simVY,
      simVZ,
      r,
      g,
      b,
    );
    this._scratchMat.makeScale(startRadius, startRadius, startRadius);
    this._scratchMat.setPosition(puff.threeX, puff.threeY, puff.threeZ);
    pool.mesh.setMatrixAt(i, this._scratchMat);
    pool.alphaArr[i] = 0;
    this.writePuffColor(pool, i, puff);
    return true;
  }

  private createPuff(useId: SmokeUseId): Puff {
    return {
      useId,
      timeLeft: 0,
      age: 0,
      durationSec: 0,
      startRadius: 0,
      finalRadius: 0,
      maxAlpha: 0,
      fadeInSec: 0,
      fadeOutSec: 0,
      threeX: 0,
      threeY: 0,
      threeZ: 0,
      threeVX: 0,
      threeVY: 0,
      threeVZ: 0,
      r: 0,
      g: 0,
      b: 0,
    };
  }

  private writePuffSpawn(
    puff: Puff,
    profile: SmokeSpawnProfile,
    durationSec: number,
    fadeInSec: number,
    fadeOutSec: number,
    startRadius: number,
    finalRadius: number,
    simX: number,
    simY: number,
    simZ: number,
    simVX: number,
    simVY: number,
    simVZ: number,
    r: number,
    g: number,
    b: number,
  ): void {
    // sim(x, y, z) -> three(x, z, y). Puffs stay fixed at their spawn
    // position while the projectile moves away.
    puff.useId = profile.useId;
    puff.timeLeft = durationSec;
    puff.age = 0;
    puff.durationSec = durationSec;
    puff.startRadius = startRadius;
    puff.finalRadius = finalRadius;
    puff.maxAlpha = profile.maxAlpha;
    puff.fadeInSec = fadeInSec;
    puff.fadeOutSec = fadeOutSec;
    puff.threeX = simX;
    puff.threeY = simZ;
    puff.threeZ = simY;
    puff.threeVX = simVX;
    puff.threeVY = simVZ;
    puff.threeVZ = simVY;
    puff.r = r;
    puff.g = g;
    puff.b = b;
  }

  private pickEvictionSlot(pool: PuffPool, useId?: SmokeUseId): number {
    const cap = pool.active.length;
    if (cap <= 1) {
      pool.evictionCursor = 0;
      return 0;
    }
    let best = -1;
    let bestLifeFrac = Number.POSITIVE_INFINITY;
    const start = pool.evictionCursor % cap;
    for (let n = 0; n < cap; n++) {
      const idx = (start + n) % cap;
      const p = pool.active[idx];
      if (useId !== undefined && p.useId !== useId) continue;
      const lifeFrac = p.timeLeft / p.durationSec;
      if (lifeFrac < bestLifeFrac) {
        best = idx;
        bestLifeFrac = lifeFrac;
      }
    }
    if (best < 0) best = start;
    pool.evictionCursor = (best + 1) % cap;
    return best;
  }

  destroy(): void {
    // disposeMesh only frees the mesh's currently-bound material, so
    // dispose both shader materials explicitly.
    disposeMesh(this.pool.mesh, { material: false });
    this.matSphere.dispose();
    this.matSoft.dispose();
    this.pool.active.length = 0;
    this.pool.activeByUse.clear();
    this.root.parent?.remove(this.root);
  }
}
