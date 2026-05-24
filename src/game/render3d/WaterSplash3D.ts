// WaterSplash3D — droplet burst when a projectile hits water.
//
// One InstancedMesh of stretched ellipsoids serves as the pool. Each
// droplet is a low-poly sphere whose per-instance matrix is built
// directly from its velocity vector so the long axis aligns with the
// direction of travel — real water droplets read as streaks, not as
// spheres, because surface tension elongates a fast-moving drop
// along its motion. Drawing them stretched gives the splash visible
// trajectory without any extra geometry or fill cost.
//
// A spawn deposits droplets in three groups so the splash reads as a
// real impact instead of an isotropic puff:
//   - vertical jet: a tight column at the impact point launching
//     near-straight up; this is the iconic central column a heavy
//     splash throws before falling apart.
//   - crown: low-angle lateral droplets fanning outward and biased
//     forward along the projectile's incoming horizontal direction —
//     a shallow shell rakes the crown downrange rather than tossing a
//     symmetric umbrella.
//   - spray: mid-angle droplets filling the cone between the two.
//
// Each droplet integrates under gravity per frame; the elongation
// follows velocity each frame, so arcing droplets visibly bend as
// they fall. Droplets recycle when they fall back to the water
// surface or their lifetime elapses. No per-frame allocations.

import * as THREE from 'three';
import { WATER_LEVEL } from '../sim/Terrain';
import { disposeMesh } from './threeUtils';

const MAX_DROPLETS = 384;
const GRAVITY = 420; // sim u/s² — beefed so droplets fall back quickly
// Per-spawn droplet caps. A single shot dropping in water should
// never burst more than this; with hundreds of in-flight shots the
// pool would otherwise drain in a frame.
const MAX_DROPLETS_PER_SPAWN = 24;

const VS = `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FS = `
varying float vAlpha;
void main() {
  gl_FragColor = vec4(0.78, 0.90, 1.0, vAlpha);
}
`;

type Droplet = {
  active: boolean;
  // World-space three.js coords (sim X → three X, sim Y → three Z).
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  ageMs: number;
  lifetimeMs: number;
  // Streak geometry. width is the cross-section radius; lengthScale
  // multiplies the velocity-aligned long axis on top of speed-derived
  // stretch (so heavier shots throw fatter, longer streaks).
  width: number;
  lengthScale: number;
};

export class WaterSplash3D {
  private root: THREE.Group;
  private geom: THREE.SphereGeometry;
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.InstancedMesh;
  private alphaArr: Float32Array;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private scratch = new THREE.Matrix4();
  private droplets: Droplet[] = [];
  private freeSlots: number[] = [];

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);

    // Coarse sphere — each droplet is small on screen and stretched,
    // so the silhouette only needs to read as a smooth bead.
    this.geom = new THREE.SphereGeometry(1, 5, 3);
    this.alphaArr = new Float32Array(MAX_DROPLETS);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('aAlpha', this.alphaAttr);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.InstancedMesh(this.geom, this.mat, MAX_DROPLETS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.root.add(this.mesh);

    for (let i = MAX_DROPLETS - 1; i >= 0; i--) {
      this.droplets.push({
        active: false,
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        ageMs: 0, lifetimeMs: 0,
        width: 0, lengthScale: 0,
      });
      this.freeSlots.push(i);
    }
  }

  /** Spawn a water-splash burst.
   *  @param simX sim X at impact
   *  @param simY sim Y at impact (becomes three Z)
   *  @param incomingVelX horizontal sim X velocity at impact
   *  @param incomingVelY horizontal sim Y velocity at impact
   *  @param mass projectile mass surrogate (collision radius)
   */
  spawn(
    simX: number,
    simY: number,
    incomingVelX: number,
    incomingVelY: number,
    mass: number,
  ): void {
    const horizSpeed = Math.sqrt(
      incomingVelX * incomingVelX + incomingVelY * incomingVelY,
    );
    // Sim ships 2D projectile velocity; synthesize a downward speed
    // from horizontal motion + mass so the rebound carries believable
    // vertical energy. Kept modest — most of an incoming shell's
    // kinetic energy is absorbed by the water, not flung back out.
    const descentSpeed = Math.max(50, horizSpeed * 0.45) + mass * 1.5;
    const energy = descentSpeed + horizSpeed;

    // Distribute droplets across the three groups, scaling totals
    // with energy but capping aggressively for the 5k-unit budget.
    const total = Math.max(
      6,
      Math.min(MAX_DROPLETS_PER_SPAWN, Math.floor(mass * 1.6 + energy / 80)),
    );
    const jetCount = Math.max(2, Math.floor(total * 0.18));
    const crownCount = Math.max(2, Math.floor(total * 0.42));
    const sprayCount = Math.max(0, total - jetCount - crownCount);

    // Forward direction (where the projectile was traveling) in
    // three.js coords. Used to bias crown / spray arcs downrange.
    const hSpeedSafe = horizSpeed > 0.001 ? horizSpeed : 1;
    const fwdX = incomingVelX / hSpeedSafe;
    const fwdZ = incomingVelY / hSpeedSafe;

    // Only a fraction of the incoming energy comes back out; the
    // rest goes into displacing water. Lateral carry is small —
    // droplets shouldn't sail across half the map after a shell
    // impact, they should fall right back near where they came up.
    const reboundUp = descentSpeed * 0.35;
    const lateralCarry = horizSpeed * 0.12;
    const widthBase = Math.max(0.35, mass * 0.32);

    const threeX = simX;
    const threeZ = simY;
    const threeY = WATER_LEVEL;

    // --- Vertical jet: a tight near-vertical column at the impact.
    for (let i = 0; i < jetCount; i++) {
      if (!this.seed(
        threeX, threeY, threeZ,
        // Very narrow cone (≤ ~15° from vertical), boosted speed —
        // this group makes the central column.
        Math.random() * 0.26,
        Math.random() * Math.PI * 2,
        reboundUp * (0.9 + Math.random() * 0.3),
        // Negligible lateral carry: the jet rises, the crown carries.
        fwdX * lateralCarry * 0.1,
        fwdZ * lateralCarry * 0.1,
        widthBase * (1.0 + Math.random() * 0.4),
        500 + Math.random() * 300,
        0.5, // jet droplets stretch less — column reads as fat beads
      )) return;
    }

    // --- Crown: low-angle, asymmetric. Forward side fans wide,
    // back side is suppressed so the splash visibly leans downrange.
    for (let i = 0; i < crownCount; i++) {
      const theta = Math.PI * 0.32 + Math.random() * Math.PI * 0.22;   // 58°–98° from up
      const phi = forwardBiasedPhi(fwdX, fwdZ);
      if (!this.seed(
        threeX, threeY, threeZ,
        theta, phi,
        reboundUp * (0.4 + Math.random() * 0.4),
        fwdX * lateralCarry * (0.5 + Math.random() * 0.7),
        fwdZ * lateralCarry * (0.5 + Math.random() * 0.7),
        widthBase * (0.7 + Math.random() * 0.6),
        400 + Math.random() * 400,
        1.0,
      )) return;
    }

    // --- Spray: fills the mid-angle band; also forward-biased so
    // the whole burst reads as one directional event.
    for (let i = 0; i < sprayCount; i++) {
      const theta = Math.random() * Math.PI * 0.4;                       // 0°–72°
      const phi = forwardBiasedPhi(fwdX, fwdZ);
      if (!this.seed(
        threeX, threeY, threeZ,
        theta, phi,
        reboundUp * (0.5 + Math.random() * 0.5),
        fwdX * lateralCarry * (0.25 + Math.random() * 0.6),
        fwdZ * lateralCarry * (0.25 + Math.random() * 0.6),
        widthBase * (0.55 + Math.random() * 0.6),
        450 + Math.random() * 400,
        0.85,
      )) return;
    }
  }

  /** Seed one droplet. Returns false when the pool is exhausted. */
  private seed(
    px: number, py: number, pz: number,
    theta: number, phi: number,
    speed: number,
    lateralX: number, lateralZ: number,
    width: number,
    lifetimeMs: number,
    lengthScale: number,
  ): boolean {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return false;
    const d = this.droplets[slot];
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    const dirX = sinT * Math.cos(phi);
    const dirZ = sinT * Math.sin(phi);
    const dirY = cosT;
    d.active = true;
    // Small jitter at the impact center so the column doesn't read
    // as a single co-located point.
    d.x = px + (Math.random() - 0.5) * width * 0.6;
    d.y = py;
    d.z = pz + (Math.random() - 0.5) * width * 0.6;
    d.vx = dirX * speed + lateralX;
    d.vy = dirY * speed;
    d.vz = dirZ * speed + lateralZ;
    d.ageMs = 0;
    d.lifetimeMs = lifetimeMs;
    d.width = width;
    d.lengthScale = lengthScale;
    return true;
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    if (dt <= 0) {
      this.writeInstances();
      return;
    }
    for (let i = 0; i < this.droplets.length; i++) {
      const d = this.droplets[i];
      if (!d.active) continue;
      d.ageMs += dtMs;
      d.vy -= GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      if (d.ageMs >= d.lifetimeMs || (d.vy < 0 && d.y <= WATER_LEVEL)) {
        d.active = false;
        this.freeSlots.push(i);
      }
    }
    this.writeInstances();
  }

  private writeInstances(): void {
    const e = this.scratch.elements;
    let writeIndex = 0;
    for (let i = 0; i < this.droplets.length; i++) {
      const d = this.droplets[i];
      if (!d.active) continue;
      const t = d.ageMs / d.lifetimeMs;
      const fade = t < 0.15
        ? t / 0.15
        : Math.max(0, 1 - (t - 0.15) / 0.85);

      // Velocity-aligned ellipsoid: local +X stretches along the
      // droplet's direction of travel; the other two axes stay
      // round. Streak length scales with speed so a fast droplet
      // reads as a longer streak than a slow one — visible arcs
      // emerge naturally because the long axis follows velocity.
      const speed = Math.sqrt(d.vx * d.vx + d.vy * d.vy + d.vz * d.vz);
      const invSpeed = speed > 0.001 ? 1 / speed : 0;
      const axX = d.vx * invSpeed;
      const axY = d.vy * invSpeed;
      const axZ = d.vz * invSpeed;
      // Build orthonormal basis with world-up as the seed cross axis.
      // If the velocity is near-vertical, fall back to world-X.
      let crossX: number, crossY: number, crossZ: number;
      if (Math.abs(axY) > 0.97) {
        // Near-vertical → use world-X as the perpendicular seed.
        crossX = 0; crossY = 0; crossZ = 1;
      } else {
        crossX = 0; crossY = 1; crossZ = 0;
      }
      // perp = normalize(cross(crossAxis, ax))
      let pxAx = crossY * axZ - crossZ * axY;
      let pyAx = crossZ * axX - crossX * axZ;
      let pzAx = crossX * axY - crossY * axX;
      const perpLen = Math.sqrt(pxAx * pxAx + pyAx * pyAx + pzAx * pzAx) || 1;
      pxAx /= perpLen; pyAx /= perpLen; pzAx /= perpLen;
      // third = cross(ax, perp)
      const qxAx = axY * pzAx - axZ * pyAx;
      const qyAx = axZ * pxAx - axX * pzAx;
      const qzAx = axX * pyAx - axY * pxAx;

      const streakLen =
        d.width * (1.2 + speed * 0.006) * d.lengthScale;
      const w = d.width * (1 - t * 0.35);
      const longScale = streakLen * (1 - t * 0.2);

      // Column-major: col0 = ax * longScale, col1 = perp * w,
      // col2 = third * w, col3 = position.
      e[0] = axX * longScale;  e[1] = axY * longScale;  e[2] = axZ * longScale;  e[3] = 0;
      e[4] = pxAx * w;          e[5] = pyAx * w;          e[6] = pzAx * w;          e[7] = 0;
      e[8] = qxAx * w;          e[9] = qyAx * w;          e[10] = qzAx * w;         e[11] = 0;
      e[12] = d.x;              e[13] = d.y;              e[14] = d.z;              e[15] = 1;
      this.mesh.setMatrixAt(writeIndex, this.scratch);
      this.alphaArr[writeIndex] = Math.min(1, Math.max(0, fade)) * 0.85;
      writeIndex++;
    }
    this.mesh.count = writeIndex;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  destroy(): void {
    disposeMesh(this.mesh);
    this.mat.dispose();
  }
}

/** Pick a phi angle biased toward the incoming horizontal direction.
 *  Returned angle is measured in three.js XZ (atan2(z, x)). Uses
 *  rejection-free sampling: pull a random offset around the forward
 *  heading with a triangular weighting that favors the forward
 *  hemisphere. */
function forwardBiasedPhi(fwdX: number, fwdZ: number): number {
  const baseHeading = Math.atan2(fwdZ, fwdX);
  // Bias: 70% of samples within ±90° of forward, 30% spread fully.
  const r = Math.random();
  if (r < 0.7) {
    return baseHeading + (Math.random() - 0.5) * Math.PI;
  }
  return Math.random() * Math.PI * 2;
}
