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

import * as THREE from 'three';
import type { Entity, EntityId } from '../sim/types';

const EMIT_INTERVAL_MS = 40;      // ~25 puffs/sec per rocket
const PARTICLE_LIFESPAN_MS = 700;
const PARTICLE_START_RADIUS = 1.4;
const PARTICLE_END_RADIUS = 4.5;
const PARTICLE_START_ALPHA = 0.55;
const SMOKE_COLOR = 0xcccccc;
// Pool ceiling — bounded even if a dozen rockets stream at once.
const MAX_PARTICLES = 384;

type Puff = {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  /** Seconds of life remaining. Reaches ≤ 0 → returned to pool. */
  timeLeft: number;
  /** Total lifetime in seconds (for interpolating scale / alpha). */
  lifespan: number;
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

    // 1) Advance + fade existing puffs; recycle expired ones.
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
      const r = PARTICLE_START_RADIUS + t * (PARTICLE_END_RADIUS - PARTICLE_START_RADIUS);
      p.mesh.scale.setScalar(r);
      // Quadratic fade-out so puffs linger bright then taper — looks
      // more like smoke dissipating than linear alpha crossfading.
      const k = 1 - t;
      p.mat.opacity = PARTICLE_START_ALPHA * k * k;
      this.active[write++] = p;
    }
    this.active.length = write;

    // 2) For each projectile that leaves a trail, accumulate emission
    //    budget and spawn puffs at its current 3D position.
    const seen = new Set<EntityId>();
    for (const e of projectiles) {
      const shot = e.projectile?.config.shot;
      if (!shot || shot.type !== 'projectile') continue;
      if (!shot.leavesSmokeTrail) continue;
      seen.add(e.id);

      let em = this.emitters.get(e.id);
      if (!em) {
        em = { sinceLastEmit: 0 };
        this.emitters.set(e.id, em);
      }
      em.sinceLastEmit = Math.min(em.sinceLastEmit + dtMs, EMIT_INTERVAL_MS * 3);
      while (em.sinceLastEmit >= EMIT_INTERVAL_MS && this.active.length < MAX_PARTICLES) {
        em.sinceLastEmit -= EMIT_INTERVAL_MS;
        this.spawnPuff(e.transform.x, e.transform.y, e.transform.z);
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

  private spawnPuff(simX: number, simY: number, simZ: number): void {
    let puff = this.pool.pop();
    if (!puff) {
      const mat = new THREE.MeshBasicMaterial({
        color: SMOKE_COLOR,
        transparent: true,
        opacity: PARTICLE_START_ALPHA,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.geom, mat);
      this.root.add(mesh);
      puff = { mesh, mat, timeLeft: 0, lifespan: 0 };
    }
    puff.mesh.visible = true;
    // sim(x, y, z) → three(x, z, y) — smoke stays at the rocket's
    // 3D position when it was emitted and doesn't follow the rocket
    // forward, so a long trail lingers along the flight path.
    puff.mesh.position.set(simX, simZ, simY);
    puff.mesh.scale.setScalar(PARTICLE_START_RADIUS);
    puff.mat.opacity = PARTICLE_START_ALPHA;
    puff.timeLeft = PARTICLE_LIFESPAN_MS / 1000;
    puff.lifespan = PARTICLE_LIFESPAN_MS / 1000;
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
