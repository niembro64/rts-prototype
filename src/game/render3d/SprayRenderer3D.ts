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
// Slot allocation is TRANSIENT per frame: each frame we walk active
// sprays, write to slots [0, visibleCount), and set count =
// visibleCount. Inactive sprays' particles aren't written and the
// trailing slots (if any) are bounded out by the count, so off-screen
// / inactive sprays cost zero GPU time.
//
// LOD: particle count scales with `fireExplosionStyle` (flash → inferno
// ≈ 0.15× → 1.0×) — matching the 2D intensity multiplier — so low LODs
// get a handful of particles and MAX LOD gets the full fan. Zero-
// intensity sprays (idle commanders) skip entirely.

import * as THREE from 'three';
import type { SprayTarget } from '../sim/commanderAbilities';
import { getPlayerPrimaryColor } from '../sim/types';
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

/** Global cap on simultaneous particles across every spray on the
 *  map. With MAX_PARTICLES_PER_SPRAY=14 this fits ~36 concurrent
 *  sprays, well above any realistic commander count. */
const MAX_PARTICLES = 512;

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

    const style = getGraphicsConfig().fireExplosionStyle ?? 'burst';
    const lodMult = LOD_INTENSITY[style] ?? 0.5;

    // Visible-count cursor — indexes into the InstancedMesh slots.
    // Walk active sprays, write [0, visibleCount), set count.
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

      // Time → phase in seconds, used to advance each particle's position
      // along the ray and its wobble oscillation.
      const t = this._time / 1000;

      for (let i = 0; i < n; i++) {
        if (visibleCount >= MAX_PARTICLES) break;
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

        // Compose instance matrix: T(px, TRAIL_Y, pz) · S(size).
        this._scratchMat.makeScale(size, size, size);
        this._scratchMat.setPosition(px, TRAIL_Y, pz);
        this.mesh.setMatrixAt(visibleCount, this._scratchMat);
        // Per-instance color (team or heal-white) and global alpha.
        this.colorArr[visibleCount * 3]     = r;
        this.colorArr[visibleCount * 3 + 1] = g;
        this.colorArr[visibleCount * 3 + 2] = b;
        this.alphaArr[visibleCount] = PARTICLE_ALPHA;
        visibleCount++;
      }
      if (visibleCount >= MAX_PARTICLES) break;
    }

    // Cap draw to the live prefix — trailing slots (whatever they
    // happen to hold from previous frames) don't render.
    this.mesh.count = visibleCount;
    if (visibleCount > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }

  destroy(): void {
    this.root.remove(this.mesh);
    this.mesh.dispose();
    this.mat.dispose();
    this.geom.dispose();
    this._teamColorCache.clear();
    this.root.parent?.remove(this.root);
  }
}
