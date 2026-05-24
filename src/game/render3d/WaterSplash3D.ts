// WaterSplash3D — droplet burst when a projectile hits water.
//
// One InstancedMesh of small spheres serves as the pool. spawnSplash
// seeds N droplets with reflected, randomized trajectories: the
// projectile's incoming horizontal momentum carries forward (a shell
// rakes droplets in its direction of travel), the vertical component
// is reversed so the spray launches upward, and a per-droplet random
// cone widens the cluster. Larger / faster shots make more, faster,
// further-reaching droplets. Each droplet integrates under gravity
// and is recycled when its altitude drops back to the water surface
// or its lifetime elapses.

import * as THREE from 'three';
import { WATER_LEVEL } from '../sim/Terrain';
import { disposeMesh } from './threeUtils';

const MAX_DROPLETS = 512;
const GRAVITY = 280; // sim units per second² — slightly arcadey, reads from a moving RTS camera

// Sim → three: sim X = three X, sim Y = three Z, sim Z = three Y.
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
  // Cool water-droplet white-blue with the per-droplet alpha as the
  // fade-out track. Additive blend on water reads as a bright pearl.
  gl_FragColor = vec4(0.78, 0.90, 1.0, vAlpha);
}
`;

type Droplet = {
  active: boolean;
  // World-space three.js coords.
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  ageMs: number;
  lifetimeMs: number;
  startRadius: number;
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

    this.geom = new THREE.SphereGeometry(1, 6, 4);
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
        startRadius: 0,
      });
      this.freeSlots.push(i);
    }
  }

  /** Spawn a water-splash droplet burst.
   *  @param simX simulation X at impact
   *  @param simY simulation Y at impact (becomes three Z)
   *  @param incomingVelX horizontal sim X velocity at impact
   *  @param incomingVelY horizontal sim Y velocity at impact
   *  @param mass projectile mass surrogate — its collision radius
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
    // No live data for the incoming vertical component; assume a
    // typical ballistic descent steeper than horizontal motion so the
    // splash reads upward rather than sideways. Heavier/faster shots
    // come in harder.
    const synthesizedDescentSpeed = Math.max(120, horizSpeed * 1.2) + mass * 6;

    // Droplet count scales with mass and impact energy, capped so
    // huge shells don't drain the pool in one event.
    const energy = synthesizedDescentSpeed + horizSpeed;
    const count = Math.max(
      8,
      Math.min(40, Math.floor(mass * 2 + energy / 60)),
    );

    // Speed scale for the rebound spray. The reflective component
    // (vertical) gets ~60% of the inbound vertical speed back, plus
    // some random energy proportional to mass; the lateral component
    // smears forward with the incoming horizontal motion.
    const reboundUp = synthesizedDescentSpeed * 0.6;
    const lateralCarry = horizSpeed * 0.45;
    const radius = Math.max(1.4, mass * 0.45);

    const threeX = simX;
    const threeZ = simY;
    const threeY = WATER_LEVEL;

    for (let i = 0; i < count; i++) {
      const slot = this.freeSlots.pop();
      if (slot === undefined) break;
      const d = this.droplets[slot];
      d.active = true;

      // Random cone direction biased upward. theta = pitch angle from
      // vertical (0 = straight up, π/2 = horizontal). Keep most of
      // the energy in the upper hemisphere so the splash reads as a
      // crown rather than a horizontal slap.
      const theta = Math.random() * (Math.PI * 0.45); // 0..81°
      const phi = Math.random() * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const dirX = sinT * Math.cos(phi);
      const dirZ = sinT * Math.sin(phi);
      const dirY = cosT;

      // Per-droplet speed varies so the crown doesn't collapse into a
      // single sphere. Heavier shots throw faster droplets.
      const speedScale = 0.6 + Math.random() * 0.8;
      const vBase = reboundUp * speedScale;

      // Lateral push: smear droplets forward in the incoming
      // direction so a low-angle shell rakes the spray downrange.
      const lateralBias = lateralCarry * (0.5 + Math.random() * 0.7);
      const lateralX = horizSpeed > 0.001 ? (incomingVelX / horizSpeed) * lateralBias : 0;
      const lateralZ = horizSpeed > 0.001 ? (incomingVelY / horizSpeed) * lateralBias : 0;

      d.x = threeX + (Math.random() - 0.5) * radius * 0.6;
      d.y = threeY;
      d.z = threeZ + (Math.random() - 0.5) * radius * 0.6;
      d.vx = dirX * vBase + lateralX;
      d.vy = dirY * vBase;
      d.vz = dirZ * vBase + lateralZ;
      d.ageMs = 0;
      d.lifetimeMs = 600 + Math.random() * 600 + mass * 40;
      d.startRadius = (0.35 + Math.random() * 0.5) * Math.max(1, mass * 0.55);
    }
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
      // Recycle when the droplet falls back to (or below) the water
      // surface or its lifetime elapses. The first condition is what
      // makes the spray look anchored to the water — droplets don't
      // sink through it.
      if (d.ageMs >= d.lifetimeMs || (d.vy < 0 && d.y <= WATER_LEVEL)) {
        d.active = false;
        this.freeSlots.push(i);
      }
    }
    this.writeInstances();
  }

  private writeInstances(): void {
    let writeIndex = 0;
    for (let i = 0; i < this.droplets.length; i++) {
      const d = this.droplets[i];
      if (!d.active) continue;
      const t = d.ageMs / d.lifetimeMs;
      const fade = t < 0.15
        ? t / 0.15            // fade-in
        : Math.max(0, 1 - (t - 0.15) / 0.85);
      const scale = d.startRadius * (1 - t * 0.3);
      this.scratch.makeScale(scale, scale, scale);
      this.scratch.setPosition(d.x, d.y, d.z);
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
