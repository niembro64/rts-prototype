// WaterSplash3D — droplet burst when a projectile hits water.
//
// All tunables live in splashConfig.json (loaded via splashConfig.ts).
// This file owns the render-side data structures and per-frame math
// only; numbers like rebound fractions, gravity, droplet count, and
// per-group cone shape come from SPLASH_CONFIG so the splash can be
// retuned without touching code.
//
// Each droplet is a low-poly sphere whose per-instance matrix is
// built directly from its velocity vector so the long axis aligns
// with direction of travel — real water droplets read as streaks,
// not as spheres, because surface tension elongates a fast-moving
// drop along its motion. A spawn deposits droplets in three groups
// (vertical jet at the impact, forward-biased crown, forward-biased
// spray) so the splash reads as a real directional impact instead
// of an isotropic puff. No per-frame allocations.

import * as THREE from 'three';
import { WATER_LEVEL } from '../sim/Terrain';
import { SPLASH_CONFIG } from '@/splashConfig';
import { disposeMesh } from './threeUtils';

const VS = `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FS = `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, vAlpha);
}
`;

type Droplet = {
  active: boolean;
  // World-space three.js coords (sim X → three X, sim Y → three Z).
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  ageMs: number;
  lifetimeMs: number;
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
    const cfg = SPLASH_CONFIG;
    this.root = new THREE.Group();
    parentWorld.add(this.root);

    this.geom = new THREE.SphereGeometry(
      1,
      cfg.geometry.sphereWidthSegments,
      cfg.geometry.sphereHeightSegments,
    );
    this.alphaArr = new Float32Array(cfg.pool.maxDroplets);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('aAlpha', this.alphaAttr);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: {
        uColor: {
          value: new THREE.Color(
            cfg.appearance.colorR,
            cfg.appearance.colorG,
            cfg.appearance.colorB,
          ),
        },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.InstancedMesh(this.geom, this.mat, cfg.pool.maxDroplets);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 14;
    this.root.add(this.mesh);

    for (let i = cfg.pool.maxDroplets - 1; i >= 0; i--) {
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
    const cfg = SPLASH_CONFIG;
    const horizSpeed = Math.sqrt(
      incomingVelX * incomingVelX + incomingVelY * incomingVelY,
    );
    const descentSpeed =
      Math.max(cfg.descent.minSpeed, horizSpeed * cfg.descent.horizScale)
      + mass * cfg.descent.massScale;
    const energy = descentSpeed + horizSpeed;

    const total = Math.max(
      cfg.count.minTotal,
      Math.min(
        cfg.pool.maxDropletsPerSpawn,
        Math.floor(mass * cfg.count.massScale + energy / cfg.count.energyDivisor),
      ),
    );
    const jetCount = Math.max(2, Math.floor(total * cfg.count.jetFraction));
    const crownCount = Math.max(2, Math.floor(total * cfg.count.crownFraction));
    const sprayCount = Math.max(0, total - jetCount - crownCount);

    const hSpeedSafe = horizSpeed > 0.001 ? horizSpeed : 1;
    const fwdX = incomingVelX / hSpeedSafe;
    const fwdZ = incomingVelY / hSpeedSafe;

    const reboundUp = descentSpeed * cfg.rebound.verticalFraction;
    const lateralCarry = horizSpeed * cfg.rebound.lateralCarryFraction;
    const widthBase = Math.max(
      cfg.dropletWidth.min,
      mass * cfg.dropletWidth.massScale,
    );

    const threeX = simX;
    const threeZ = simY;
    const threeY = WATER_LEVEL;

    // --- Vertical jet.
    const jet = cfg.jet;
    for (let i = 0; i < jetCount; i++) {
      if (!this.seed(
        threeX, threeY, threeZ,
        Math.random() * jet.thetaRangeRad,
        Math.random() * Math.PI * 2,
        reboundUp * (jet.speedScaleMin + Math.random() * jet.speedScaleRange),
        fwdX * lateralCarry * jet.lateralCarryFactor,
        fwdZ * lateralCarry * jet.lateralCarryFactor,
        widthBase * (jet.widthMultMin + Math.random() * jet.widthMultRange),
        jet.lifetimeMinMs + Math.random() * jet.lifetimeRangeMs,
        jet.lengthScale,
      )) return;
    }

    // --- Crown.
    const crown = cfg.crown;
    for (let i = 0; i < crownCount; i++) {
      const theta = crown.thetaMinRad + Math.random() * crown.thetaRangeRad;
      const phi = forwardBiasedPhi(fwdX, fwdZ);
      if (!this.seed(
        threeX, threeY, threeZ,
        theta, phi,
        reboundUp * (crown.speedScaleMin + Math.random() * crown.speedScaleRange),
        fwdX * lateralCarry * (crown.lateralCarryMultMin + Math.random() * crown.lateralCarryMultRange),
        fwdZ * lateralCarry * (crown.lateralCarryMultMin + Math.random() * crown.lateralCarryMultRange),
        widthBase * (crown.widthMultMin + Math.random() * crown.widthMultRange),
        crown.lifetimeMinMs + Math.random() * crown.lifetimeRangeMs,
        crown.lengthScale,
      )) return;
    }

    // --- Spray.
    const spray = cfg.spray;
    for (let i = 0; i < sprayCount; i++) {
      const theta = Math.random() * spray.thetaRangeRad;
      const phi = forwardBiasedPhi(fwdX, fwdZ);
      if (!this.seed(
        threeX, threeY, threeZ,
        theta, phi,
        reboundUp * (spray.speedScaleMin + Math.random() * spray.speedScaleRange),
        fwdX * lateralCarry * (spray.lateralCarryMultMin + Math.random() * spray.lateralCarryMultRange),
        fwdZ * lateralCarry * (spray.lateralCarryMultMin + Math.random() * spray.lateralCarryMultRange),
        widthBase * (spray.widthMultMin + Math.random() * spray.widthMultRange),
        spray.lifetimeMinMs + Math.random() * spray.lifetimeRangeMs,
        spray.lengthScale,
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
    const gravity = SPLASH_CONFIG.physics.gravity;
    for (let i = 0; i < this.droplets.length; i++) {
      const d = this.droplets[i];
      if (!d.active) continue;
      d.ageMs += dtMs;
      d.vy -= gravity * dt;
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
    const cfg = SPLASH_CONFIG;
    const fadeIn = cfg.appearance.fadeInFraction;
    const maxAlpha = cfg.appearance.maxAlpha;
    const streakBase = cfg.streak.base;
    const streakSpeedScale = cfg.streak.speedScale;
    const widthFadePerLife = cfg.streak.widthFadePerLife;
    const lengthFadePerLife = cfg.streak.lengthFadePerLife;
    const e = this.scratch.elements;
    let writeIndex = 0;
    for (let i = 0; i < this.droplets.length; i++) {
      const d = this.droplets[i];
      if (!d.active) continue;
      const t = d.ageMs / d.lifetimeMs;
      const fade = t < fadeIn
        ? t / fadeIn
        : Math.max(0, 1 - (t - fadeIn) / (1 - fadeIn));

      // Velocity-aligned ellipsoid: local +X stretches along motion;
      // other two axes stay round. Streak length scales with speed
      // so arcing droplets visibly bend.
      const speed = Math.sqrt(d.vx * d.vx + d.vy * d.vy + d.vz * d.vz);
      const invSpeed = speed > 0.001 ? 1 / speed : 0;
      const axX = d.vx * invSpeed;
      const axY = d.vy * invSpeed;
      const axZ = d.vz * invSpeed;
      let crossX: number, crossY: number, crossZ: number;
      if (Math.abs(axY) > 0.97) {
        crossX = 0; crossY = 0; crossZ = 1;
      } else {
        crossX = 0; crossY = 1; crossZ = 0;
      }
      let pxAx = crossY * axZ - crossZ * axY;
      let pyAx = crossZ * axX - crossX * axZ;
      let pzAx = crossX * axY - crossY * axX;
      const perpLen = Math.sqrt(pxAx * pxAx + pyAx * pyAx + pzAx * pzAx) || 1;
      pxAx /= perpLen; pyAx /= perpLen; pzAx /= perpLen;
      const qxAx = axY * pzAx - axZ * pyAx;
      const qyAx = axZ * pxAx - axX * pzAx;
      const qzAx = axX * pyAx - axY * pxAx;

      const streakLen =
        d.width * (streakBase + speed * streakSpeedScale) * d.lengthScale;
      const w = d.width * (1 - t * widthFadePerLife);
      const longScale = streakLen * (1 - t * lengthFadePerLife);

      e[0] = axX * longScale;  e[1] = axY * longScale;  e[2] = axZ * longScale;  e[3] = 0;
      e[4] = pxAx * w;          e[5] = pyAx * w;          e[6] = pzAx * w;          e[7] = 0;
      e[8] = qxAx * w;          e[9] = qyAx * w;          e[10] = qzAx * w;         e[11] = 0;
      e[12] = d.x;              e[13] = d.y;              e[14] = d.z;              e[15] = 1;
      this.mesh.setMatrixAt(writeIndex, this.scratch);
      this.alphaArr[writeIndex] = Math.min(1, Math.max(0, fade)) * maxAlpha;
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

/** Pick a phi angle biased toward the incoming horizontal direction. */
function forwardBiasedPhi(fwdX: number, fwdZ: number): number {
  const bias = SPLASH_CONFIG.forwardBias;
  const baseHeading = Math.atan2(fwdZ, fwdX);
  if (Math.random() < bias.weightedFraction) {
    return baseHeading + (Math.random() - 0.5) * 2 * bias.weightedHalfRangeRad;
  }
  return Math.random() * Math.PI * 2;
}
