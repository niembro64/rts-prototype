// SmokeTrail3D — fading smoke-puff particles trailing projectiles
// whose shot declares a SmokeTrailSpec (rockets, missiles, anything
// thrust-powered).
//
// Each projectile accrues a time-based emission budget: roughly one
// puff every emitIntervalMs at the projectile's current position,
// independent of frame rate. A puff is one slot in a single shared
// InstancedMesh — it stays put in world space as the rocket flies
// away, grows slightly, and fades to transparent over its lifespan.
// When the projectile despawns, the emitter state is dropped;
// still-living puffs continue fading on their own.
//
// One material + one geometry are shared across every puff. Per-puff
// scale, alpha, and color ride on the InstancedMesh's instance
// matrix + custom InstancedBufferAttributes (aAlpha, aColor). The
// fragment shader is `gl_FragColor = vec4(vColor, vAlpha);` — no
// fancy per-tier visual variants. Higher LOD just means more puffs;
// the puffs themselves look identical at every tier.
//
// LOD: density scales with `fireExplosionStyle` (the same LOD axis
// SprayRenderer3D + the 2D explosion effects use). At MIN we emit
// nothing; at `inferno` rockets trail dense streaks. Higher LOD also
// stretches each puff's lifespan so the trail is both denser AND
// longer, giving a clear visual upgrade at MAX without unbounded
// cost at MIN.

import * as THREE from 'three';
import type { Entity, EntityId } from '../sim/types';
import type { FireExplosionStyle } from '@/types/graphics';
import { getGraphicsConfig, getEffectiveQuality } from '@/clientBarConfig';

// Engine fallbacks for any SmokeTrailSpec field a shot blueprint
// leaves unset. Per-shot overrides live on the projectile blueprint
// (see SmokeTrailSpec) — these only kick in when the blueprint is
// silent. Treat them as the "inferno" / max-LOD baseline; the LOD
// multipliers further scale them down for lower tiers.
const DEFAULT_EMIT_INTERVAL_MS = 30;  // ~33 puffs/sec per rocket at max LOD
const DEFAULT_LIFESPAN_MS = 1400;
const DEFAULT_START_RADIUS = 2.5;
const DEFAULT_END_RADIUS = 8.0;
const DEFAULT_START_ALPHA = 0.75;
const DEFAULT_COLOR = 0xcccccc;
// Pool ceiling — bounded so heavy salvo spam can't unbounded-allocate.
// At max LOD, steady state per rocket ≈ lifespan/emitInterval ≈ 47
// particles, so 4000 covers ~20 simultaneous 4-rocket salvos before
// we start dropping emissions. Lower LODs use far fewer.
const MAX_PARTICLES = 4000;

/** LOD multiplier on emission rate. Mirrors the LOD_INTENSITY table
 *  SprayRenderer3D uses so every particle system on screen scales in
 *  lockstep — flipping one LOD lever visibly affects every effect. */
const LOD_EMIT_MULT: Record<FireExplosionStyle, number> = {
  flash:   0.15,
  spark:   0.3,
  burst:   0.55,
  blaze:   0.8,
  inferno: 1.0,
};

/** LOD multiplier on particle lifespan. Blended gently so low LODs
 *  don't produce invisibly-short puffs — min tier stays at 50% of
 *  max tier's lifespan. */
function lodLifespanMult(m: number): number {
  return 0.5 + 0.5 * m;
}

type Puff = {
  /** Seconds of life remaining. Reaches ≤ 0 → swap-popped. */
  timeLeft: number;
  /** Total lifetime in seconds (for interpolating scale / alpha). */
  lifespan: number;
  /** Per-puff visual params, captured at spawn time from the shot's
   *  SmokeTrailSpec so a single SmokeTrail3D can serve many shot
   *  types simultaneously. */
  startRadius: number;
  endRadius: number;
  startAlpha: number;
  /** Fixed spawn position in three.js coords (sim Y → three Z). The
   *  puff stays put as the rocket flies away — only its scale and
   *  alpha change frame-to-frame. */
  threeX: number;
  threeY: number;
  threeZ: number;
  /** Unpacked sRGB color for this puff. Stored on the Puff (not on
   *  a shared material) so shots with different `color` fields can
   *  coexist in the same instanced mesh. */
  r: number;
  g: number;
  b: number;
};

type Emitter = {
  /** Ms of accumulated time since the last puff was emitted. Capped
   *  so a stalled tick doesn't dump a burst on the next frame. */
  sinceLastEmit: number;
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

export class SmokeTrail3D {
  private root: THREE.Group;
  // Reduced from (8, 6) ≈ 80 tris to (6, 4) ≈ 36 tris per puff. The
  // puffs are small, fade fast, and blend with neighbors — the extra
  // segments weren't visible. Same geometry at every LOD tier; only
  // the count of live instances varies.
  private geom = new THREE.SphereGeometry(1, 6, 4);
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.InstancedMesh;
  // Per-instance attribute buffers. Index i in alphaArr / colorArr
  // / instanceMatrix corresponds to active[i] — the live puff list
  // is kept dense at the front of these buffers via swap-pop, so
  // `mesh.count = active.length` exactly bounds what's drawn.
  private alphaArr = new Float32Array(MAX_PARTICLES);
  private colorArr = new Float32Array(MAX_PARTICLES * 3);
  private alphaAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  private active: Puff[] = [];
  private emitters = new Map<EntityId, Emitter>();
  // Scratch buffers reused across frames to avoid per-frame allocs.
  private _seen = new Set<EntityId>();
  private _eligible: Entity[] = [];
  private _scratchMat = new THREE.Matrix4();

  constructor(worldGroup: THREE.Group) {
    this.root = new THREE.Group();
    worldGroup.add(this.root);

    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArr, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('aAlpha', this.alphaAttr);
    this.geom.setAttribute('aColor', this.colorAttr);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: SMOKE_VERTEX_SHADER,
      fragmentShader: SMOKE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.InstancedMesh(this.geom, this.mat, MAX_PARTICLES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Frustum culling on InstancedMesh uses a bounding sphere derived
    // from the source geometry — not the per-instance matrices — so a
    // puff far from the origin would be incorrectly culled. Disable.
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
  }

  /** Per-frame tick: advance existing puffs, emit new ones behind
   *  each qualifying projectile, drop emitter state for projectiles
   *  no longer present. `dtMs` is the clamped effect dt the scene
   *  uses for other particle systems. */
  update(projectiles: readonly Entity[], dtMs: number): void {
    const dtSec = dtMs / 1000;

    // Sample LOD once per frame. Emission rate and lifespan are
    // multiplied by per-shot SmokeTrailSpec values then scaled by the
    // current fireExplosionStyle tier — so a higher LOD yields a
    // denser AND longer trail and a lower LOD produces a sparse short
    // wisp regardless of which shot the trail belongs to.
    const style = (getGraphicsConfig().fireExplosionStyle as FireExplosionStyle) ?? 'burst';
    const lodEmitMult = LOD_EMIT_MULT[style] ?? 0.55;
    const lodLifeMult = lodLifespanMult(lodEmitMult);

    // 1) Advance + fade existing puffs in place. Dead ones are
    //    swap-popped: the last live puff takes the dead slot's index,
    //    and we re-process that index without advancing — so a long
    //    chain of die-this-frame puffs collapses correctly in one
    //    pass. Each surviving puff writes its matrix + alpha + color
    //    to the instance attributes at its (possibly swapped) index.
    let i = 0;
    while (i < this.active.length) {
      const p = this.active[i];
      p.timeLeft -= dtSec;
      if (p.timeLeft <= 0) {
        const last = this.active.length - 1;
        if (i !== last) this.active[i] = this.active[last];
        this.active.pop();
        continue;
      }
      const t = 1 - p.timeLeft / p.lifespan; // 0 → 1 over life
      const r = p.startRadius + t * (p.endRadius - p.startRadius);
      // Quadratic fade-out so puffs linger bright then taper — looks
      // more like smoke dissipating than linear alpha crossfading.
      const k = 1 - t;
      const alpha = p.startAlpha * k * k;

      this._scratchMat.makeScale(r, r, r);
      this._scratchMat.setPosition(p.threeX, p.threeY, p.threeZ);
      this.mesh.setMatrixAt(i, this._scratchMat);
      this.alphaArr[i] = alpha;
      this.colorArr[i * 3]     = p.r;
      this.colorArr[i * 3 + 1] = p.g;
      this.colorArr[i * 3 + 2] = p.b;
      i++;
    }

    // MIN tier emits zero new puffs — the LOD floor cuts smoke
    // entirely. Already-live puffs above keep fading naturally; we
    // just stop spawning new ones and clear emitter state so a tier
    // flip back up doesn't dump a backlogged burst.
    const minTier = getEffectiveQuality() === 'min';
    if (minTier) {
      this.emitters.clear();
    } else {
      // 2) For each projectile that leaves a trail, accumulate emission
      //    budget. Then spawn puffs in a ROUND-ROBIN pass so every
      //    eligible rocket gets a fair share of the pool — otherwise
      //    projectiles early in the iteration could burn the entire
      //    cap on their own backlog and later rockets would silently
      //    produce no trail at all.
      const seen = this._seen;
      const eligible = this._eligible;
      seen.clear();
      eligible.length = 0;
      for (const e of projectiles) {
        const shot = e.projectile?.config.shot;
        if (!shot || shot.type !== 'projectile') continue;
        const spec = shot.smokeTrail;
        if (!spec) continue;
        seen.add(e.id);

        const baseInterval = spec.emitIntervalMs ?? DEFAULT_EMIT_INTERVAL_MS;
        const emitIntervalMs = baseInterval / lodEmitMult;

        let em = this.emitters.get(e.id);
        if (!em) {
          em = { sinceLastEmit: 0 };
          this.emitters.set(e.id, em);
        }
        em.sinceLastEmit = Math.min(em.sinceLastEmit + dtMs, emitIntervalMs * 3);
        if (em.sinceLastEmit >= emitIntervalMs) eligible.push(e);
      }

      // Round-robin: repeatedly walk the eligible list, taking one
      // emission budget slice off each rocket that still has one,
      // until either all emitters drain below threshold or the pool
      // fills. That way 10 rockets with backlog each get 1 puff before
      // any rocket gets 2 — the trail density is uniform across the
      // salvo.
      if (eligible.length > 0) {
        let progress = true;
        while (progress && this.active.length < MAX_PARTICLES) {
          progress = false;
          for (const e of eligible) {
            if (this.active.length >= MAX_PARTICLES) break;
            const em = this.emitters.get(e.id)!;
            const spec = (e.projectile!.config.shot as { smokeTrail?: import('@/types/blueprints').SmokeTrailSpec }).smokeTrail!;
            const baseInterval = spec.emitIntervalMs ?? DEFAULT_EMIT_INTERVAL_MS;
            const emitIntervalMs = baseInterval / lodEmitMult;
            if (em.sinceLastEmit < emitIntervalMs) continue;
            em.sinceLastEmit -= emitIntervalMs;
            const lifespanSec = ((spec.lifespanMs ?? DEFAULT_LIFESPAN_MS) * lodLifeMult) / 1000;
            this.spawnPuff(
              e.transform.x, e.transform.y, e.transform.z,
              lifespanSec,
              spec.startRadius ?? DEFAULT_START_RADIUS,
              spec.endRadius ?? DEFAULT_END_RADIUS,
              spec.startAlpha ?? DEFAULT_START_ALPHA,
              spec.color ?? DEFAULT_COLOR,
            );
            progress = true;
          }
        }
      }

      // 3) Drop emitter state for rockets that despawned this frame.
      //    Their in-flight puffs continue fading independently.
      if (this.emitters.size > seen.size) {
        for (const id of this.emitters.keys()) {
          if (!seen.has(id)) this.emitters.delete(id);
        }
      }
    }

    // 4) Push attribute updates to GPU and bound the draw to the
    //    live-puff prefix.
    this.mesh.count = this.active.length;
    if (this.active.length > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }

  private spawnPuff(
    simX: number, simY: number, simZ: number,
    lifespanSec: number,
    startRadius: number,
    endRadius: number,
    startAlpha: number,
    color: number,
  ): void {
    if (this.active.length >= MAX_PARTICLES) return;

    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8)  & 0xff) / 255;
    const b = ( color        & 0xff) / 255;

    // sim(x, y, z) → three(x, z, y) — smoke stays at the rocket's
    // 3D position when it was emitted and doesn't follow the rocket
    // forward, so a long trail lingers along the flight path.
    const puff: Puff = {
      timeLeft: lifespanSec,
      lifespan: lifespanSec,
      startRadius,
      endRadius,
      startAlpha,
      threeX: simX,
      threeY: simZ,
      threeZ: simY,
      r, g, b,
    };

    const i = this.active.length;
    this.active.push(puff);

    this._scratchMat.makeScale(startRadius, startRadius, startRadius);
    this._scratchMat.setPosition(puff.threeX, puff.threeY, puff.threeZ);
    this.mesh.setMatrixAt(i, this._scratchMat);
    this.alphaArr[i] = startAlpha;
    this.colorArr[i * 3]     = r;
    this.colorArr[i * 3 + 1] = g;
    this.colorArr[i * 3 + 2] = b;
  }

  destroy(): void {
    this.root.remove(this.mesh);
    this.mesh.dispose();
    this.mat.dispose();
    this.geom.dispose();
    this.active.length = 0;
    this.emitters.clear();
    this.root.parent?.remove(this.root);
  }
}
