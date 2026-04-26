// SmokeTrail3D — fading smoke-puff particles trailing projectiles
// whose shot declares `leavesSmokeTrail: true` (rockets, missiles,
// anything thrust-powered).
//
// Each projectile accrues a time-based emission budget: roughly one
// puff every EMIT_INTERVAL_MS at the projectile's current position,
// independent of frame rate. A puff is a small sphere mesh parented
// to the world group — it stays put in world space as the rocket
// flies away, grows slightly, and fades to transparent over its
// lifespan. When the projectile despawns, the emitter state is
// dropped; still-living puffs continue fading on their own.
//
// Each puff owns its own material so opacity can interpolate
// per-particle. Meshes + materials are pooled together so long
// rocket streams don't allocate mid-flight.
//
// LOD: density scales with `fireExplosionStyle` (the same LOD axis
// SprayRenderer3D + the 2D explosion effects use). At `flash` we emit
// a whisper of smoke a couple times a second; at `inferno` rockets
// trail dense streaks. Higher LOD also stretches each puff's
// lifespan so the trail is both denser AND longer, giving a clear
// visual upgrade at MAX without unbounded cost at MIN.

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
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  /** Seconds of life remaining. Reaches ≤ 0 → returned to pool. */
  timeLeft: number;
  /** Total lifetime in seconds (for interpolating scale / alpha). */
  lifespan: number;
  /** Per-puff visual params, captured at spawn time from the shot's
   *  SmokeTrailSpec so a single SmokeTrail3D pool can serve many shot
   *  types simultaneously. */
  startRadius: number;
  endRadius: number;
  startAlpha: number;
};

type Emitter = {
  /** Ms of accumulated time since the last puff was emitted. Capped
   *  so a stalled tick doesn't dump a burst on the next frame. */
  sinceLastEmit: number;
};

export class SmokeTrail3D {
  private root: THREE.Group;
  /** Cached unit sphere — every puff scales it per-frame. */
  private geom = new THREE.SphereGeometry(1, 8, 6);
  private active: Puff[] = [];
  private pool: Puff[] = [];
  private emitters = new Map<EntityId, Emitter>();
  // Scratch buffers reused across frames. `_seen` records which
  // emitters were touched this tick so we can prune stale entries;
  // `_eligible` gathers rockets with enough budget to emit at least
  // one puff, for the round-robin pass. Reusing them avoids fresh
  // Set + array allocations every render frame.
  private _seen = new Set<EntityId>();
  private _eligible: Entity[] = [];

  constructor(worldGroup: THREE.Group) {
    this.root = new THREE.Group();
    worldGroup.add(this.root);
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

    // 1) Advance + fade existing puffs; recycle expired ones. Each
    //    puff carries its own start/end radius and start alpha because
    //    the SmokeTrail3D pool is shared across shots that may
    //    declare different SmokeTrailSpec values.
    let write = 0;
    for (let i = 0; i < this.active.length; i++) {
      const p = this.active[i];
      p.timeLeft -= dtSec;
      if (p.timeLeft <= 0) {
        p.mesh.visible = false;
        this.pool.push(p);
        continue;
      }
      const t = 1 - p.timeLeft / p.lifespan; // 0 → 1 over life
      const r = p.startRadius + t * (p.endRadius - p.startRadius);
      p.mesh.scale.setScalar(r);
      // Quadratic fade-out so puffs linger bright then taper — looks
      // more like smoke dissipating than linear alpha crossfading.
      const k = 1 - t;
      p.mat.opacity = p.startAlpha * k * k;
      this.active[write++] = p;
    }
    this.active.length = write;

    // 2) For each projectile that leaves a trail, accumulate emission
    //    budget. Then spawn puffs in a ROUND-ROBIN pass so every
    //    eligible rocket gets a fair share of the pool — otherwise
    //    projectiles early in the iteration could burn the entire
    //    cap on their own backlog and later rockets would silently
    //    produce no trail at all.
    //
    //    MIN tier emits zero new puffs — the LOD floor cuts smoke
    //    entirely. Already-live puffs above keep fading naturally; we
    //    just stop spawning new ones and clear emitter state below so
    //    a tier flip back up doesn't dump a backlogged burst.
    const minTier = getEffectiveQuality() === 'min';
    if (minTier) {
      this.emitters.clear();
      return;
    }
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
    // emission budget slice off each rocket that still has one, until
    // either all emitters drain below threshold or the pool fills.
    // That way 10 rockets with backlog each get 1 puff before any
    // rocket gets 2 — the trail density is uniform across the salvo.
    if (eligible.length > 0) {
      let progress = true;
      while (progress && this.active.length < MAX_PARTICLES) {
        progress = false;
        for (const e of eligible) {
          if (this.active.length >= MAX_PARTICLES) break;
          const em = this.emitters.get(e.id)!;
          // Re-derive per-shot interval each iteration so we burn the
          // budget at the right cadence for each shot type.
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

  private spawnPuff(
    simX: number, simY: number, simZ: number,
    lifespanSec: number,
    startRadius: number,
    endRadius: number,
    startAlpha: number,
    color: number,
  ): void {
    let puff = this.pool.pop();
    if (!puff) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: startAlpha,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geom, mat);
      this.root.add(mesh);
      puff = {
        mesh, mat, timeLeft: 0, lifespan: 0,
        startRadius, endRadius, startAlpha,
      };
    } else {
      // Reuse: per-shot color, alpha, and radius profile may differ
      // from whatever this puff carried last time.
      puff.mat.color.setHex(color);
      puff.startRadius = startRadius;
      puff.endRadius = endRadius;
      puff.startAlpha = startAlpha;
    }
    puff.mesh.visible = true;
    // sim(x, y, z) → three(x, z, y) — smoke stays at the rocket's
    // 3D position when it was emitted and doesn't follow the rocket
    // forward, so a long trail lingers along the flight path.
    puff.mesh.position.set(simX, simZ, simY);
    puff.mesh.scale.setScalar(startRadius);
    puff.mat.opacity = startAlpha;
    // Lifespan is per-puff (set at spawn time) so LOD changes while
    // the game is running don't cut off or extend already-live puffs
    // mid-fade.
    puff.timeLeft = lifespanSec;
    puff.lifespan = lifespanSec;
    this.active.push(puff);
  }

  destroy(): void {
    for (const p of this.active) {
      this.root.remove(p.mesh);
      p.mat.dispose();
    }
    for (const p of this.pool) {
      this.root.remove(p.mesh);
      p.mat.dispose();
    }
    this.active.length = 0;
    this.pool.length = 0;
    this.emitters.clear();
    this.geom.dispose();
    this.root.parent?.remove(this.root);
  }
}
