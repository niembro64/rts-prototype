// Explosion3D — short-lived "fire explosion" effects for projectile impacts
// and unit deaths in the 3D view.
//
// Each spawn emits a bright white core puff plus (above 'flash' LOD) a
// cool-tinted shell puff and (above 'spark' LOD) a radial spray of ember
// sparks that arc outward with gravity. Everything fades on a
// quadratic/cubic alpha curve and is dropped from the active list when
// its lifetime expires.
//
// Rendering: every puff and every spark is one slot in one of two
// shared InstancedMeshes. Per-instance scale/position go in the
// instance matrix; per-instance alpha + color go in custom
// InstancedBufferAttributes (aAlpha, aColor) read by a tiny custom
// shader (gl_FragColor = vec4(vColor, vAlpha);). Cost is two draw
// calls regardless of how many explosions are on screen — replaces the
// old per-Mesh + per-MeshBasicMaterial pool which paid one draw call
// per particle.
//
// LOD:
//   fireExplosionStyle =
//     - 'flash'   : core only (cheapest)
//     - 'spark'   : core + shell, no sparks
//     - 'burst'   : core + shell, ~6 sparks
//     - 'blaze'   : core + shell, ~12 sparks
//     - 'inferno' : core + shell, ~20 sparks with longer trails
//
// Triggered by SimEvents of type 'hit' and 'projectileExpire'; the
// scene calls `spawnImpact()` directly with positions/colors pulled
// from impactContext.

import * as THREE from 'three';
import { getGraphicsConfig } from '@/clientBarConfig';
// Sparks are affected by gravity so they arc. Imported from config.ts
// so explosion sparks, debris, projectiles, and physics all share one
// gravity value.
import { GRAVITY as SPARK_GRAVITY } from '../../config';

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

// Pool ceilings — bounded so heavy salvo spam can't unbounded-allocate.
// Steady-state estimates: each impact emits at most 2 puffs (core + shell)
// living up to ~280ms × ~5× duration mult; sparks emit up to 20 lasting
// ~450ms × ~5× mult. 2048 puffs / 4096 sparks comfortably absorb
// dozens of concurrent inferno-tier impacts.
const MAX_PUFFS = 2048;
const MAX_SPARKS = 4096;

type Puff = {
  startR: number;
  endR: number;
  lifetimeMs: number;
  ageMs: number;
  /** true for the outer fireball so it fades quadratically; core fades cubically. */
  isShell: boolean;
  // Position in three coords (sim x → three x, sim z → three y, sim y → three z).
  px: number;
  py: number;
  pz: number;
  // Unpacked sRGB color [0,1] for this puff.
  r: number;
  g: number;
  b: number;
};

type Spark = {
  /** World-space velocity — three coords (sim XZ plane → three XZ; +Y up). */
  vx: number;
  vy: number;
  vz: number;
  size: number;
  lifetimeMs: number;
  ageMs: number;
  px: number;
  py: number;
  pz: number;
  r: number;
  g: number;
  b: number;
};

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

/** A bounded InstancedMesh of unit spheres with per-instance alpha + color.
 *  Slot index i corresponds to the active[i] entry in the owning system's
 *  swap-pop array — the active prefix is kept dense so `mesh.count` is the
 *  exact draw bound. Same shader contract as SmokeTrail3D so all three
 *  particle systems share one fragment behavior (vec4(color, alpha)). */
class InstancedSpherePool {
  private geom: THREE.SphereGeometry;
  private mat: THREE.ShaderMaterial;
  readonly mesh: THREE.InstancedMesh;
  private alphaArr: Float32Array;
  private colorArr: Float32Array;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  // Reusable scratch matrix to avoid allocations in the per-frame write loop.
  private scratch = new THREE.Matrix4();
  readonly cap: number;

  constructor(parent: THREE.Group, cap: number, renderOrder: number) {
    this.cap = cap;
    this.geom = new THREE.SphereGeometry(1, 12, 10);
    this.alphaArr = new Float32Array(cap);
    this.colorArr = new Float32Array(cap * 3);
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
    this.mesh = new THREE.InstancedMesh(this.geom, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Frustum culling on InstancedMesh uses the source geometry's bounding
    // sphere (origin, radius 1) — instances live anywhere on the map, so
    // disable cull. Empty slots leave count at the active prefix length.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    parent.add(this.mesh);
  }

  write(
    i: number,
    x: number, y: number, z: number,
    scale: number,
    r: number, g: number, b: number,
    alpha: number,
  ): void {
    this.scratch.makeScale(scale, scale, scale);
    this.scratch.setPosition(x, y, z);
    this.mesh.setMatrixAt(i, this.scratch);
    this.alphaArr[i] = alpha;
    this.colorArr[i * 3]     = r;
    this.colorArr[i * 3 + 1] = g;
    this.colorArr[i * 3 + 2] = b;
  }

  setCount(n: number): void {
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }

  destroy(): void {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.dispose();
    this.mat.dispose();
    this.geom.dispose();
  }
}

export class Explosion3D {
  private root: THREE.Group;
  private puffPool: InstancedSpherePool;
  private sparkPool: InstancedSpherePool;
  // Active particles, kept dense at the front of the array via swap-pop.
  // Index i in puffs[] corresponds to slot i in puffPool.mesh, same for sparks.
  private puffs: Puff[] = [];
  private sparks: Spark[] = [];

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    // renderOrder mirrors the old per-Mesh values: puffs at 14, sparks at
    // 15 so sparks consistently composite over the fireball shell.
    this.puffPool = new InstancedSpherePool(this.root, MAX_PUFFS, 14);
    this.sparkPool = new InstancedSpherePool(this.root, MAX_SPARKS, 15);
  }

  /**
   * Fire an impact explosion at a full 3D sim position.
   *   `simX` / `simY`  = horizontal plane (sim.x / sim.y)
   *   `simZ`           = altitude (sim.z, authoritative event altitude)
   * Internally maps to Three.js (x=simX, y=simZ, z=simY).
   *
   * `momentumX/Z` is an optional bias (sim X/Y → world X/Z units per
   * second) added to every spark's random launch velocity, so the
   * spark cloud drifts in the direction of the combined impact
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
  spawnImpact(
    simX: number, simY: number, simZ: number, radius: number,
    momentumX: number = 0, momentumZ: number = 0,
    shellColor?: number,
  ): void {
    const style = this.getStyle();
    // Tiny safety floor so a zero-radius call still renders one
    // visible pixel; callers are expected to pass the correct size
    // (projectile explosion zones size themselves; beam/laser hits
    // size to the beam half-width). Previously a 6-unit floor was
    // lifting beam sparks to read like projectile pops.
    const r = Math.max(radius, 1.5);
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
    color: number, lifetimeMs: number,
    startR: number, endR: number, isShell: boolean,
  ): void {
    if (this.puffs.length >= MAX_PUFFS) return;
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8)  & 0xff) / 255;
    const b = ( color        & 0xff) / 255;
    // Three.js (x, y, z) ← sim (x, z, y): simX → three-x, sim altitude
    // (simZ) → three-y, sim.y (ground plane) → three-z. Canonical axis swap.
    this.puffs.push({
      startR, endR, lifetimeMs, ageMs: 0, isShell,
      px: simX, py: simZ, pz: simY,
      r, g, b,
    });
  }

  private addSparks(
    simX: number, simY: number, simZ: number,
    reach: number, count: number, lifetimeMs: number,
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
    const r = ((SPARK_COLOR >> 16) & 0xff) / 255;
    const g = ((SPARK_COLOR >> 8)  & 0xff) / 255;
    const b = ( SPARK_COLOR        & 0xff) / 255;
    for (let i = 0; i < count; i++) {
      if (this.sparks.length >= MAX_SPARKS) break;
      // Random direction biased slightly upward — sparks that go under the
      // ground get culled, so biasing up yields fewer wasted particles.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI - Math.PI * 0.3; // -54° to +126°
      // Speed is derived from (reach / lifetime) so sparks cover roughly
      // `reach` world units over the extended lifetime — longer-lasting
      // explosions have slower drifting sparks rather than faster-traveling
      // ones, which keeps the explosion's visible footprint reasonable.
      const speed = (0.6 + Math.random() * 0.5) * reach * (1000 / lifetimeMs);
      const vx = Math.cos(theta) * Math.cos(phi) * speed + biasX;
      const vz = Math.sin(theta) * Math.cos(phi) * speed + biasZ;
      const vy = Math.sin(phi) * speed;
      const size = 0.9 + Math.random() * 1.2;
      this.sparks.push({
        vx, vy, vz, size, lifetimeMs, ageMs: 0,
        px: simX, py: simZ, pz: simY,
        r, g, b,
      });
    }
  }

  update(dtMs: number): void {
    const dtSec = dtMs / 1000;

    // 1) Puffs: expand radius linearly with progress, fade alpha. Core fades
    //    cubically (stays bright then disappears quickly); shell fades
    //    quadratically so the warm glow lingers. Swap-pop drops dead puffs.
    let i = 0;
    while (i < this.puffs.length) {
      const p = this.puffs[i];
      p.ageMs += dtMs;
      if (p.ageMs >= p.lifetimeMs) {
        const last = this.puffs.length - 1;
        if (i !== last) this.puffs[i] = this.puffs[last];
        this.puffs.pop();
        continue;
      }
      const t = p.ageMs / p.lifetimeMs;
      const scale = p.startR + (p.endR - p.startR) * t;
      const fade = p.isShell
        ? (1 - t) * (1 - t)
        : (1 - t) * (1 - t) * (1 - t);
      this.puffPool.write(i, p.px, p.py, p.pz, scale, p.r, p.g, p.b, fade);
      i++;
    }
    this.puffPool.setCount(this.puffs.length);

    // 2) Sparks: integrate gravity, drift with velocity, fade + shrink.
    //    A spark that falls below ground is clamped at y=0 (so we don't
    //    see fire under the terrain slab). Swap-pop drops dead sparks.
    let j = 0;
    while (j < this.sparks.length) {
      const s = this.sparks[j];
      s.ageMs += dtMs;
      if (s.ageMs >= s.lifetimeMs) {
        const last = this.sparks.length - 1;
        if (j !== last) this.sparks[j] = this.sparks[last];
        this.sparks.pop();
        continue;
      }
      s.vy -= SPARK_GRAVITY * dtSec;
      s.px += s.vx * dtSec;
      s.py += s.vy * dtSec;
      s.pz += s.vz * dtSec;
      if (s.py < 0) s.py = 0;
      const t = s.ageMs / s.lifetimeMs;
      const fade = (1 - t) * (1 - t);
      const scale = s.size * (0.3 + 0.7 * fade);
      this.sparkPool.write(j, s.px, s.py, s.pz, scale, s.r, s.g, s.b, fade);
      j++;
    }
    this.sparkPool.setCount(this.sparks.length);
  }

  private getStyle(): ExplosionStyle {
    return (getGraphicsConfig().fireExplosionStyle ?? 'burst') as ExplosionStyle;
  }

  destroy(): void {
    this.puffs.length = 0;
    this.sparks.length = 0;
    this.puffPool.destroy();
    this.sparkPool.destroy();
    this.root.parent?.remove(this.root);
  }
}
