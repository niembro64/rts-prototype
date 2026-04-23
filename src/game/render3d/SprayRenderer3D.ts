// SprayRenderer3D — the commander's build (and heal) spray trail.
//
// The sim publishes active `SprayTarget`s each tick via
// `ClientViewState.getSprayTargets()` — one entry per active
// commander → building (or commander → unit for heal) pair. For each
// active spray we emit a trail of small colored particles along the
// source→target line that animates with a chaotic perpendicular
// wobble, fades in at the source, and fades out at the target (same
// aesthetic as the 2D SprayParticles renderer).
//
// Implementation: a pool of Mesh(SphereGeometry) with a single
// per-team MeshBasicMaterial. Particles are packed into a single
// Three.js Group parented to the world; per-frame they get
// repositioned + tinted. When a spray stops the particles we allocated
// for it go back to the pool on the next frame's re-pack.
//
// LOD: particle count scales with `fireExplosionStyle` (flash → inferno
// ≈ 0.15× → 1.0×) — matching the 2D intensity multiplier — so low LODs
// get a handful of particles and MAX LOD gets the full fan. Zero-
// intensity sprays (idle commanders) skip entirely.

import * as THREE from 'three';
import type { SprayTarget } from '../sim/commanderAbilities';
import { PLAYER_COLORS } from '../sim/types';
import type { PlayerId } from '../sim/types';
import { getGraphicsConfig } from '@/clientBarConfig';

// Spray trail sits slightly above ground level — high enough to show
// clearly over the tile grid, low enough to still feel "on the ground"
// next to the building.
const TRAIL_Y = 4;
const PARTICLE_BASE_RADIUS = 2.5;

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
const MAX_PARTICLES_PER_SPRAY = 14;

export class SprayRenderer3D {
  private root: THREE.Group;
  // Shared sphere geometry for all particles — cheap tessellation since
  // each particle is small on screen.
  private particleGeom = new THREE.SphereGeometry(1, 8, 6);
  // One material per team (cached lazily). Spray color picks the team
  // primary + a bit of brightness so it reads against dark ground.
  private particleMats = new Map<number, THREE.MeshBasicMaterial>();
  // Fallback material for unknown teams or heal-type sprays (always
  // white — heal uses a white palette in the 2D renderer too).
  private fallbackMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });

  // Active particle pool (all visible at least once). Pool index is
  // stable for pooled meshes; each frame we repack the visible prefix.
  private particles: THREE.Mesh[] = [];
  // Phase accumulator — drives the sinusoidal per-particle wobble so
  // successive frames look like a continuous animated stream.
  private _time = 0;

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
  }

  /** Per-frame update. `dtMs` advances the wobble phase so frame rate
   *  doesn't affect the animation speed. */
  update(sprayTargets: readonly SprayTarget[], dtMs: number): void {
    this._time += dtMs;

    const style = getGraphicsConfig().fireExplosionStyle ?? 'burst';
    const lodMult = LOD_INTENSITY[style] ?? 0.5;

    // How many pool slots we end up needing this frame — tracked so we
    // can hide any leftover particles past this count.
    let visibleCount = 0;

    for (const spray of sprayTargets) {
      if (spray.intensity <= 0) continue;
      const scaledIntensity = Math.min(1, spray.intensity) * lodMult;
      // Particles per spray — 12 at base intensity × lodMult, floored to
      // at least 3 so even the cheapest LOD shows the effect when the
      // commander is actively spraying.
      const count = Math.max(3, Math.floor(12 * scaledIntensity));
      const n = Math.min(count, MAX_PARTICLES_PER_SPRAY);

      const sx = spray.source.pos.x;
      const sz = spray.source.pos.y;
      const tx = spray.target.pos.x;
      const tz = spray.target.pos.y;
      const dx = tx - sx;
      const dz = tz - sz;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const dirX = dx / len;
      const dirZ = dz / len;
      // Perpendicular vector for the wobble offset.
      const perpX = -dirZ;
      const perpZ = dirX;

      const mat = this.getParticleMat(spray.source.playerId, spray.type);
      // Time → phase in seconds, used to advance each particle's position
      // along the ray and its wobble oscillation.
      const t = this._time / 1000;

      for (let i = 0; i < n; i++) {
        const mesh = this.acquireParticle(visibleCount);
        mesh.material = mat;
        // Normalized progress along the ray for this particle — staggered
        // by i so the stream looks continuous, phased by `t` so it flows
        // source → target over time. Wraps modulo 1.
        const phase = (i / n + t * 1.2) % 1;
        const sineWobble = Math.sin(t * 7 + i * 1.3) * (len * 0.03);
        const pos = len * phase;
        const px = sx + dirX * pos + perpX * sineWobble;
        const pz = sz + dirZ * pos + perpZ * sineWobble;
        // Radius taper — particles grow into the stream from the source
        // and shrink near the target so the trail has a visible profile
        // instead of a uniform strip.
        const fadeIn = Math.min(1, phase * 3);
        const fadeOut = Math.min(1, (1 - phase) * 3);
        const size = PARTICLE_BASE_RADIUS * (0.7 + 0.6 * fadeIn * fadeOut)
          * (0.5 + 0.5 * scaledIntensity);
        mesh.position.set(px, TRAIL_Y, pz);
        mesh.scale.setScalar(size);
        visibleCount++;
      }
    }

    // Hide any leftover pool meshes we didn't touch this frame.
    for (let i = visibleCount; i < this.particles.length; i++) {
      this.particles[i].visible = false;
    }
  }

  /** Pull a mesh from the pool (or create + add if short). Visible flag
   *  is flipped on so leftover-pool hiding above can toggle it back. */
  private acquireParticle(i: number): THREE.Mesh {
    let mesh = this.particles[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.particleGeom, this.fallbackMat);
      mesh.renderOrder = 12;
      this.particles.push(mesh);
      this.root.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  /** Shared per-team material. Caches on first use; material swaps are
   *  cheap since Three.js batches by material identity per frame. */
  private getParticleMat(
    pid: PlayerId | undefined,
    type: 'build' | 'heal',
  ): THREE.MeshBasicMaterial {
    // Heal type always renders white — matches the 2D convention where
    // heal sprays don't take the caster's team color.
    if (type === 'heal') return this.fallbackMat;
    if (pid === undefined) return this.fallbackMat;
    let mat = this.particleMats.get(pid);
    if (!mat) {
      const color = PLAYER_COLORS[pid]?.primary ?? 0xffffff;
      mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });
      this.particleMats.set(pid, mat);
    }
    return mat;
  }

  destroy(): void {
    for (const p of this.particles) this.root.remove(p);
    this.particles.length = 0;
    this.particleGeom.dispose();
    for (const m of this.particleMats.values()) m.dispose();
    this.particleMats.clear();
    this.fallbackMat.dispose();
    this.root.parent?.remove(this.root);
  }
}
