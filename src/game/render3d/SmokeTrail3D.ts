// SmokeTrail3D — fading smoke-puff particles trailing projectiles
// whose shot declares a SmokeTrailSpec (rockets, missiles, anything
// thrust-powered).
//
// Each projectile samples one puff on selected render frames. The
// cadence is a frame-skip count, not an elapsed-time accumulator, so a
// slow frame never dumps a backlog burst and each LOD reads with stable
// visual spacing. A puff is one slot in a single shared InstancedMesh —
// it stays put in world space as the rocket flies away, grows slightly,
// and fades to transparent over its lifespan.
//
// One material + one geometry are shared across every puff. Per-puff
// scale, alpha, and color ride on the InstancedMesh's instance
// matrix + custom InstancedBufferAttributes (aAlpha, aColor). The
// fragment shader is `gl_FragColor = vec4(vColor, vAlpha);` — no
// fancy per-tier visual variants. Higher LOD just means more puffs;
// the puffs themselves look identical at every tier.
//
// LOD: density scales with `smokeTrailFramesSkip`, while the existing
// fireExplosionStyle tier still caps the total particle budget. Higher
// LOD also stretches each puff's lifespan so the trail is both denser
// AND longer, giving a clear visual upgrade at MAX without unbounded
// cost at MIN.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import type { ConcreteGraphicsQuality, FireExplosionStyle } from '@/types/graphics';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import { hexToRgb01 } from './colorUtils';
import { disposeMesh } from './threeUtils';

/** Per-puff scope padding in sim-world units. Smoke trails extend
 *  BEHIND the projectile along its flight path, so a rocket whose
 *  current position is just barely off-screen could still be the
 *  source of a puff that's plainly inside the viewport. 200 mirrors
 *  the projectile padding BeamRenderer3D / Render3DEntities use for
 *  the same reason — projectile visuals routinely overhang the
 *  entity's center by more than a unit's body radius. */
const SMOKE_SCOPE_PADDING = 200;

// Engine fallbacks for any SmokeTrailSpec field a shot blueprint
// leaves unset. Per-shot overrides live on the projectile blueprint
// (see SmokeTrailSpec) — these only kick in when the blueprint is
// silent. Treat them as the max-LOD baseline; the LOD frame-skip table
// further thins emissions for lower tiers.
const DEFAULT_EMIT_FRAMES_SKIP = 0;  // sample every render frame at max LOD
const DEFAULT_LIFESPAN_MS = 1400;
const DEFAULT_START_RADIUS = 2.5;
const DEFAULT_END_RADIUS = 8.0;
const DEFAULT_START_ALPHA = 0.75;
const DEFAULT_COLOR = 0xcccccc;
// Pool ceiling — bounded so heavy salvo spam can't unbounded-allocate.
// At max LOD, steady state per rocket is roughly one puff per render
// frame for lifespanMs, so 4000 covers heavy salvos before we start
// dropping emissions. Lower LODs use far fewer.
const MAX_PARTICLES = 4000;
const SMOKE_EVICTION_SCAN = 16;

const LOD_PARTICLE_CAP: Record<FireExplosionStyle, number> = {
  flash: 700,
  spark: 1200,
  burst: 2200,
  blaze: 3200,
  inferno: MAX_PARTICLES,
};

const LOD_LIFESPAN_MULT: Record<ConcreteGraphicsQuality, number> = {
  min: 0.5,
  low: 0.65,
  medium: 0.8,
  high: 0.9,
  max: 1.0,
};

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
  // Scratch buffers reused across frames to avoid per-frame allocs.
  private _eligible: Entity[] = [];
  private _scratchMat = new THREE.Matrix4();
  private emissionCursor = 0;
  private evictionCursor = 0;
  private colorUpdateMin = Number.POSITIVE_INFINITY;
  private colorUpdateMax = -1;

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
   *  uses for other particle systems.
   *
   *  RENDER-mode aware: when `scope` is provided and its mode is
   *  not 'all', projectiles whose current position is outside the
   *  padded scope are skipped. Re-entering scope resumes on the next
   *  matching frame phase with no backlog burst. Already-live puffs
   *  are NOT culled — they fade in place naturally as the camera pans
   *  away from them. */
  update(
    projectiles: readonly Entity[],
    dtMs: number,
    renderFrameIndex: number,
    scope?: ViewportFootprint,
  ): void {
    if (projectiles.length === 0 && this.active.length === 0) return;

    const dtSec = dtMs / 1000;

    // Sample LOD once per render frame. Smoke density is controlled
    // by integer frame skips, not elapsed milliseconds, so trail
    // spacing stays consistent under hitches and across LOD tiers.
    const gfx = getGraphicsConfig();
    const style = (gfx.fireExplosionStyle as FireExplosionStyle) ?? 'burst';
    const lodFramesSkip = Math.max(0, gfx.smokeTrailFramesSkip | 0);
    const lodLifeMult = LOD_LIFESPAN_MULT[gfx.tier] ?? 0.8;
    const particleCap = Math.min(MAX_PARTICLES, LOD_PARTICLE_CAP[style] ?? 2200);
    const defaultLifespanSec = Math.max(0.001, (DEFAULT_LIFESPAN_MS * lodLifeMult) / 1000);

    // 1) Advance + fade existing puffs in place. Dead ones are
    //    swap-popped: the last live puff takes the dead slot's index,
    //    and we re-process that index without advancing — so a long
    //    chain of die-this-frame puffs collapses correctly in one
    //    pass. Each surviving puff writes matrix + alpha every frame;
    //    color is static after spawn and only moves when swap-pop
    //    compaction changes a puff's slot.
    let i = 0;
    while (i < this.active.length) {
      const p = this.active[i];
      p.timeLeft -= dtSec;
      if (p.timeLeft <= 0) {
        const last = this.active.length - 1;
        if (i !== last) {
          this.active[i] = this.active[last];
          this.writePuffColor(i, this.active[i]);
        }
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
      i++;
    }
    if (this.active.length > particleCap) {
      this.active.length = particleCap;
      if (this.evictionCursor >= particleCap) this.evictionCursor = 0;
    }

    // 2) For each projectile that leaves a trail, sample at its
    //    frame-skip cadence. Then apply a steady-state global emission
    //    budget so a large salvo does not fill the entire pool in one
    //    burst and then go silent until old puffs expire.
    const eligible = this._eligible;
    eligible.length = 0;
    for (const e of projectiles) {
      const profile = e.projectile?.config.shotProfile;
      if (!profile?.runtime.isProjectile) continue;
      const spec = profile.visual.smokeTrail;
      if (!spec) continue;
      // RENDER scope cull: off-screen projectiles do no smoke work.
      // Re-entering scope resumes on the next matching frame phase,
      // with no missed-frame burst to catch up.
      if (scope && !scope.inScope(e.transform.x, e.transform.y, SMOKE_SCOPE_PADDING)) continue;

      const shotFramesSkip = Math.max(0, spec.emitFramesSkip ?? DEFAULT_EMIT_FRAMES_SKIP);
      const stride = Math.max(1, Math.max(lodFramesSkip, shotFramesSkip) + 1);
      // Phase by projectile id so a salvo does not allocate every puff
      // on the same frame at low LOD.
      if ((renderFrameIndex + (e.id % stride)) % stride !== 0) continue;
      eligible.push(e);
    }

    if (eligible.length > 0 && particleCap > 0) {
      const steadyBudget = Math.max(1, Math.ceil((particleCap * dtSec) / defaultLifespanSec));
      const emissions = Math.min(eligible.length, steadyBudget);
      let start = 0;
      if (eligible.length > emissions) {
        start = this.emissionCursor % eligible.length;
        this.emissionCursor = (this.emissionCursor + emissions) % eligible.length;
      } else {
        this.emissionCursor = 0;
      }
      for (let n = 0; n < emissions; n++) {
        const e = eligible[(start + n) % eligible.length];
        const spec = e.projectile!.config.shotProfile.visual.smokeTrail!;
        const lifespanSec = ((spec.lifespanMs ?? DEFAULT_LIFESPAN_MS) * lodLifeMult) / 1000;
        this.spawnPuff(
          e.transform.x, e.transform.y, e.transform.z,
          lifespanSec,
          spec.startRadius ?? DEFAULT_START_RADIUS,
          spec.endRadius ?? DEFAULT_END_RADIUS,
          spec.startAlpha ?? DEFAULT_START_ALPHA,
          spec.color ?? DEFAULT_COLOR,
          particleCap,
        );
      }
    }

    // 3) Push attribute updates to GPU and bound the draw to the
    //    live-puff prefix.
    this.mesh.count = this.active.length;
    if (this.active.length > 0) {
      const count = this.active.length;
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, count * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.clearUpdateRanges();
      this.alphaAttr.addUpdateRange(0, count);
      this.alphaAttr.needsUpdate = true;
      if (this.colorUpdateMax >= this.colorUpdateMin) {
        this.colorAttr.clearUpdateRanges();
        this.colorAttr.addUpdateRange(
          this.colorUpdateMin * 3,
          (this.colorUpdateMax - this.colorUpdateMin + 1) * 3,
        );
        this.colorAttr.needsUpdate = true;
        this.colorUpdateMin = Number.POSITIVE_INFINITY;
        this.colorUpdateMax = -1;
      }
    } else {
      this.colorUpdateMin = Number.POSITIVE_INFINITY;
      this.colorUpdateMax = -1;
    }
  }

  private writePuffColor(index: number, puff: Puff): void {
    this.colorArr[index * 3] = puff.r;
    this.colorArr[index * 3 + 1] = puff.g;
    this.colorArr[index * 3 + 2] = puff.b;
    if (index < this.colorUpdateMin) this.colorUpdateMin = index;
    if (index > this.colorUpdateMax) this.colorUpdateMax = index;
  }

  private spawnPuff(
    simX: number, simY: number, simZ: number,
    lifespanSec: number,
    startRadius: number,
    endRadius: number,
    startAlpha: number,
    color: number,
    particleCap: number,
  ): void {
    const cap = Math.min(MAX_PARTICLES, Math.max(0, particleCap | 0));
    if (cap <= 0) return;

    const { r, g, b } = hexToRgb01(color);

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

    let i: number;
    if (this.active.length < cap) {
      i = this.active.length;
      this.active.push(puff);
    } else {
      i = this.pickEvictionSlot(cap);
      this.active[i] = puff;
    }

    this._scratchMat.makeScale(startRadius, startRadius, startRadius);
    this._scratchMat.setPosition(puff.threeX, puff.threeY, puff.threeZ);
    this.mesh.setMatrixAt(i, this._scratchMat);
    this.alphaArr[i] = startAlpha;
    this.writePuffColor(i, puff);
  }

  private pickEvictionSlot(cap: number): number {
    if (cap <= 1) {
      this.evictionCursor = 0;
      return 0;
    }
    const scan = Math.min(SMOKE_EVICTION_SCAN, cap);
    let best = this.evictionCursor % cap;
    let bestLifeFrac = this.active[best]
      ? this.active[best].timeLeft / this.active[best].lifespan
      : -1;
    for (let n = 1; n < scan; n++) {
      const idx = (this.evictionCursor + n) % cap;
      const p = this.active[idx];
      if (!p) {
        best = idx;
        bestLifeFrac = -1;
        break;
      }
      const lifeFrac = p.timeLeft / p.lifespan;
      if (lifeFrac < bestLifeFrac) {
        best = idx;
        bestLifeFrac = lifeFrac;
      }
    }
    this.evictionCursor = (best + 1) % cap;
    return best;
  }

  destroy(): void {
    disposeMesh(this.mesh);
    this.active.length = 0;
    this.root.parent?.remove(this.root);
  }
}
