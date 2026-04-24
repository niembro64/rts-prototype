// Explosion3D — short-lived "fire explosion" effects for projectile impacts
// and unit deaths in the 3D view.
//
// Each spawn creates two nested spheres (a bright yellow-white core + an orange
// fireball shell) plus a small number of radial ember sparks that arc outward
// with gravity. Everything fades on a quadratic alpha curve and is released
// back to a mesh pool when its lifetime expires. Positions and scales animate
// in place — no per-frame Mesh allocation after warmup.
//
// LOD:
//   fireExplosionStyle =
//     - 'flash'   : core only (cheapest)
//     - 'spark'   : core + small shell, no sparks
//     - 'burst'   : core + shell, ~6 sparks
//     - 'blaze'   : core + shell, ~12 sparks
//     - 'inferno' : core + shell, ~20 sparks with longer trails
//
// Units/ground share the same world Y for impact height, matching the Y used
// by the 2D ExplosionRenderer's xy-plane effects.
//
// Triggered by SimEvents of type 'hit' and 'projectileExpire'; the scene calls
// `spawnImpact()` directly with positions/colors pulled from impactContext.

import * as THREE from 'three';
import { getGraphicsConfig } from '@/clientBarConfig';

// (SHOT_HEIGHT is gone — every explosion takes its altitude from the
// SimEvent's pos.z so visuals line up with the sim's exact impact
// point. Callers pass simX / simY / simZ explicitly.)

// Per-spawn defaults. All three layers use a white palette — the low-LOD
// flash-only look was just the core ball, which users liked, so higher
// tiers now layer a cool-tinted white shell and white sparks on top of
// the same bright core instead of warming up to orange. Tier differ-
// entiation comes from spark count + reach (LOD_TABLE below), not from
// adding heat.
const CORE_COLOR = 0xffffff;  // bright white core
const FIRE_COLOR = 0xe8edff;  // faint cool-tinted white shell (subtle vs core)
const SPARK_COLOR = 0xffffff; // white ember

const CORE_LIFETIME_MS = 180;
const FIRE_LIFETIME_MS = 280;
const SPARK_LIFETIME_MS = 450;

// Baseline radius for the duration-scaling curve. A radius at or below this
// value gets the raw lifetimes above; anything larger extends logarithmically
// so big primary/secondary blast radii visibly linger without the curve
// running away (large bombs last a few seconds, not minutes).
const DURATION_BASE_RADIUS = 10;

/** Scale all explosion lifetimes as a log of the impact radius so larger
 *  fires burn longer. Formula: `1 + log2(max(1, r / baseR))` — clamped to
 *  1 at small radii, grows ~one full doubling of lifetime per doubling of
 *  radius. Rough values: r=10 → 1.0, r=20 → 2.0, r=40 → 3.0, r=80 → 4.0,
 *  r=200 → 5.3. */
function durationMultiplier(radius: number): number {
  return 1 + Math.log2(Math.max(1, radius / DURATION_BASE_RADIUS));
}

// Sparks are affected by gravity so they arc. Imported from config.ts
// so explosion sparks, debris, projectiles, and physics all share one
// gravity value.
import { GRAVITY as SPARK_GRAVITY } from '../../config';

// Fireball starts slightly smaller than its final size and expands while it
// brightens, then fades while still expanding. Multipliers are over the base
// impact radius passed in from ImpactContext.
const CORE_EXPAND_START = 0.6;
const CORE_EXPAND_END = 1.6;
const FIRE_EXPAND_START = 0.8;
const FIRE_EXPAND_END = 2.3;

type ExplosionStyle = 'flash' | 'spark' | 'burst' | 'blaze' | 'inferno';

// Particle counts and reach per LOD tier. Values picked to keep the 'inferno'
// tier readable but not overwhelming — at 20 sparks each hit still disposes
// in under half a second.
const LOD_TABLE: Record<ExplosionStyle, { sparks: number; sparkReach: number }> = {
  flash:   { sparks: 0,  sparkReach: 0   },
  spark:   { sparks: 0,  sparkReach: 0   },
  burst:   { sparks: 6,  sparkReach: 1.6 },
  blaze:   { sparks: 12, sparkReach: 2.2 },
  inferno: { sparks: 20, sparkReach: 2.8 },
};

type Puff = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  startR: number;
  endR: number;
  lifetime: number;
  age: number;
  baseColor: number;
  /** true for the outer fireball so it fades quadratically; core fades cubically. */
  isShell: boolean;
};

type Spark = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  /** World-space velocity — sim plane is XZ, +Y is up. */
  vx: number;
  vy: number;
  vz: number;
  size: number;
  lifetime: number;
  age: number;
};

export class Explosion3D {
  private root: THREE.Group;

  // Shared geometry — all puffs and sparks are unit spheres scaled per-use.
  private sphereGeom = new THREE.SphereGeometry(1, 12, 10);

  // Active effects, updated each frame. When their age exceeds lifetime the
  // mesh is hidden (not removed) and appended back to the pool.
  private puffs: Puff[] = [];
  private sparks: Spark[] = [];

  // Mesh pools for cheap reuse. Each pool entry caches (mesh, material) pairs
  // so we avoid re-allocating MeshBasicMaterials for every hit.
  private puffPool: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] = [];
  private sparkPool: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] = [];

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
  }

  /**
   * Spawn a fire explosion at (x, z) with a given base radius. Called by
   * the scene's SimEvent dispatcher for 'hit' and 'projectileExpire'.
   *
   * `momentumX/Z` is an optional bias (sim X/Y → world X/Z units per
   * second) that gets added to every spark's random launch velocity, so
   * the spark cloud drifts in the direction of the combined impact
   * momentum rather than radiating uniformly. Callers pre-compute it
   * from a weighted combination of the projectile velocity, penetration
   * direction, and target velocity — matching the 2D
   * `DeathEffectsHandler` which breaks the impulse into the same three
   * components.
   *
   * `shellColor` overrides the default cool-white shell (used by the
   * 2D code for team-tinted death blasts; unused here now that all
   * explosions are white).
   */
  /**
   * Fire an impact explosion at a full 3D sim position.
   *   `simX` / `simY`  = horizontal plane (sim.x / sim.y)
   *   `simZ`           = altitude (sim.z, authoritative event altitude)
   * Internally maps to Three.js (x=simX, y=simZ, z=simY).
   */
  spawnImpact(
    simX: number, simY: number, simZ: number, radius: number,
    momentumX: number = 0, momentumZ: number = 0,
    shellColor?: number,
  ): void {
    const style = this.getStyle();
    const r = Math.max(radius, 6);
    // Stretch all three lifetimes by a log factor of the radius so a tank's
    // cannon blast lingers visibly longer than a scout bullet hit.
    const durMult = durationMultiplier(r);

    // Always render a core even at the cheapest LOD — a plain white ball is
    // the simplest "something happened here" signal.
    this.addPuff(
      simX, simY, simZ, CORE_COLOR, CORE_LIFETIME_MS * durMult,
      r * CORE_EXPAND_START, r * CORE_EXPAND_END, false,
    );
    if (style === 'flash') return;

    this.addPuff(
      simX, simY, simZ, shellColor ?? FIRE_COLOR, FIRE_LIFETIME_MS * durMult,
      r * FIRE_EXPAND_START, r * FIRE_EXPAND_END, true,
    );
    if (style === 'spark') return;

    const lod = LOD_TABLE[style];
    if (lod.sparks > 0) {
      this.addSparks(
        simX, simY, simZ, r * lod.sparkReach, lod.sparks,
        SPARK_LIFETIME_MS * durMult,
        momentumX, momentumZ,
      );
    }
  }

  /**
   * Unit-death blast: a large white fireball at 2.5× the unit's collision
   * radius, matching the 2D DeathEffectsHandler which calls
   * `addExplosion(..., 'death', ...)` with `radius = ctx.radius * 2.5`.
   * Team identity comes through in the Debris3D pieces that spawn alongside.
   *
   * `momentumX/Z` is the combined impact/unit/projectile impulse (same
   * meaning as spawnImpact) so debris sparks trail in the direction the
   * unit was pushed when it died.
   */
  spawnDeath(
    simX: number, simY: number, simZ: number, radius: number,
    momentumX: number = 0, momentumZ: number = 0,
  ): void {
    this.spawnImpact(simX, simY, simZ, radius * 2.5, momentumX, momentumZ);
  }

  private addPuff(
    simX: number, simY: number, simZ: number,
    color: number, lifetime: number,
    startR: number, endR: number, isShell: boolean,
  ): void {
    const pooled = this.puffPool.pop();
    let mesh: THREE.Mesh;
    let material: THREE.MeshBasicMaterial;
    if (pooled) {
      mesh = pooled.mesh;
      material = pooled.material;
      material.color.setHex(color);
      material.opacity = 1;
      mesh.visible = true;
    } else {
      material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      mesh = new THREE.Mesh(this.sphereGeom, material);
      mesh.renderOrder = 14;
      this.root.add(mesh);
    }
    // Three.js (x, y, z) ← sim (x, z, y): simX goes to three-x, sim
    // altitude (simZ) goes to three-y, sim.y (ground plane) goes to
    // three-z. This is the canonical sim-to-render axis swap.
    mesh.position.set(simX, simZ, simY);
    mesh.scale.setScalar(startR);

    this.puffs.push({
      mesh, material, startR, endR, lifetime, age: 0,
      baseColor: color, isShell,
    });
  }

  private addSparks(
    simX: number, simY: number, simZ: number,
    reach: number, count: number, lifetime: number,
    momentumX: number = 0, momentumZ: number = 0,
  ): void {
    // Sparks spray over the full sphere so the explosion reads in 3D from any
    // camera angle — an XY-plane spray would look flat when viewed from above.
    // Momentum is added as a constant velocity offset on top of the random
    // spray, which makes the cloud drift in the direction of the combined
    // impact force rather than radiating symmetrically. `BIAS_FACTOR` tempers
    // it so sparks still have visible random spread at 0 momentum.
    const BIAS_FACTOR = 0.35;
    const biasX = momentumX * BIAS_FACTOR;
    const biasZ = momentumZ * BIAS_FACTOR;
    for (let i = 0; i < count; i++) {
      const pooled = this.sparkPool.pop();
      let mesh: THREE.Mesh;
      let material: THREE.MeshBasicMaterial;
      if (pooled) {
        mesh = pooled.mesh;
        material = pooled.material;
        material.color.setHex(SPARK_COLOR);
        material.opacity = 1;
        mesh.visible = true;
      } else {
        material = new THREE.MeshBasicMaterial({
          color: SPARK_COLOR,
          transparent: true,
          opacity: 1,
          depthWrite: false,
        });
        mesh = new THREE.Mesh(this.sphereGeom, material);
        mesh.renderOrder = 15;
        this.root.add(mesh);
      }

      // Random direction biased slightly upward — sparks that go under the
      // ground get culled, so biasing up yields fewer wasted particles.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI - Math.PI * 0.3; // -54° to +126°
      // Speed is derived from (reach / lifetime) so sparks cover roughly
      // `reach` world units over the extended lifetime — longer-lasting
      // explosions have slower drifting sparks rather than faster-traveling
      // ones, which keeps the explosion's visible footprint reasonable.
      const speed = (0.6 + Math.random() * 0.5) * reach * (1000 / lifetime);
      const vx = Math.cos(theta) * Math.cos(phi) * speed + biasX;
      const vz = Math.sin(theta) * Math.cos(phi) * speed + biasZ;
      const vy = Math.sin(phi) * speed;

      const size = 0.9 + Math.random() * 1.2;
      mesh.position.set(simX, simZ, simY);
      mesh.scale.setScalar(size);

      this.sparks.push({
        mesh, material, vx, vy, vz, size,
        lifetime, age: 0,
      });
    }
  }

  update(dtMs: number): void {
    const dtSec = dtMs / 1000;

    // Animate puffs: expand radius linearly with progress, fade alpha.
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dtMs;
      const t = Math.min(1, p.age / p.lifetime);
      const r = p.startR + (p.endR - p.startR) * t;
      p.mesh.scale.setScalar(r);
      // Core fades cubically (stays bright then disappears quickly); shell
      // fades quadratically so the warm glow lingers.
      const fade = p.isShell ? (1 - t) * (1 - t) : (1 - t) * (1 - t) * (1 - t);
      p.material.opacity = fade;
      if (p.age >= p.lifetime) {
        p.mesh.visible = false;
        this.puffPool.push({ mesh: p.mesh, material: p.material });
        this.puffs.splice(i, 1);
      }
    }

    // Integrate sparks with gravity; fade alpha and scale toward zero.
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dtMs;
      const t = Math.min(1, s.age / s.lifetime);
      s.vy -= SPARK_GRAVITY * dtSec;
      s.mesh.position.x += s.vx * dtSec;
      s.mesh.position.y += s.vy * dtSec;
      s.mesh.position.z += s.vz * dtSec;
      // Hide sparks that fall below the ground so we don't see fire under the
      // terrain slab.
      if (s.mesh.position.y < 0) s.mesh.position.y = 0;
      const fade = (1 - t) * (1 - t);
      s.material.opacity = fade;
      s.mesh.scale.setScalar(s.size * (0.3 + 0.7 * fade));
      if (s.age >= s.lifetime) {
        s.mesh.visible = false;
        this.sparkPool.push({ mesh: s.mesh, material: s.material });
        this.sparks.splice(i, 1);
      }
    }
  }

  private getStyle(): ExplosionStyle {
    return (getGraphicsConfig().fireExplosionStyle ?? 'burst') as ExplosionStyle;
  }

  destroy(): void {
    for (const p of this.puffs) {
      p.material.dispose();
      this.root.remove(p.mesh);
    }
    for (const s of this.sparks) {
      s.material.dispose();
      this.root.remove(s.mesh);
    }
    for (const { mesh, material } of this.puffPool) {
      material.dispose();
      this.root.remove(mesh);
    }
    for (const { mesh, material } of this.sparkPool) {
      material.dispose();
      this.root.remove(mesh);
    }
    this.puffs.length = 0;
    this.sparks.length = 0;
    this.puffPool.length = 0;
    this.sparkPool.length = 0;
    this.sphereGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
