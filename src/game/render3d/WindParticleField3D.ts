import * as THREE from 'three';
import { WIND_PARTICLE_CONFIG } from '@/windParticleConfig';
import type { NetworkServerSnapshotMeta } from '../network/NetworkTypes';
import type { ViewportFootprint } from '../ViewportFootprint';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';
import { TRANSPARENT_RENDER_ORDER_3D } from './TransparentRenderOrder3D';
import { disposeMesh } from './threeUtils';

type WindState = NonNullable<NetworkServerSnapshotMeta['wind']>;

type WindParticleFieldOptions = {
  mapWidth: number;
  mapHeight: number;
  renderScope: ViewportFootprint;
  waterLevelWorld: number;
  highestTerrainWorld: number;
};

const PARTICLE_VERTEX_SHADER = `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const PARTICLE_FRAGMENT_SHADER = `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, vAlpha);
  #include <colorspace_fragment>
}
`;

/** Camera-local air particles moved along the authoritative wind vector.
 * One bounded InstancedMesh follows the same typed-buffer particle pattern as
 * SprayRenderer3D and SmokeTrail3D; there are no per-particle scene objects. */
export class WindParticleField3D {
  private readonly config = WIND_PARTICLE_CONFIG;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly renderScope: ViewportFootprint;
  private readonly lowerPlaneWorld: number;
  private readonly upperPlaneWorld: number;
  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.InstancedMesh;
  private readonly alpha: Float32Array;
  private readonly alphaAttribute: THREE.InstancedBufferAttribute;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly z: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly orientation = new THREE.Quaternion();
  private readonly matrix = new THREE.Matrix4();
  private seeded = false;
  private rngState = 0x7f4a7c15;

  constructor(parentWorld: THREE.Group, options: WindParticleFieldOptions) {
    this.mapWidth = options.mapWidth;
    this.mapHeight = options.mapHeight;
    this.renderScope = options.renderScope;
    this.lowerPlaneWorld = options.waterLevelWorld +
      this.config.lowerPlaneDistanceAboveWaterLevelWorld;
    this.upperPlaneWorld = Math.max(
      this.lowerPlaneWorld,
      options.highestTerrainWorld +
        this.config.upperPlaneDistanceAboveHighestTerrainWorld,
    );
    this.scale.setScalar(this.config.radiusWorld);

    const count = this.config.maxParticles;
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.z = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.alphaAttribute = new THREE.InstancedBufferAttribute(this.alpha, 1);
    this.alphaAttribute.setUsage(THREE.DynamicDrawUsage);

    this.geometry = createPrimitiveSphereGeometry('effect', 'far');
    this.geometry.setAttribute('aAlpha', this.alphaAttribute);
    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      uniforms: {
        uColor: { value: new THREE.Color(this.config.colorHex) },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.mesh.name = 'WindParticleField3D';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = TRANSPARENT_RENDER_ORDER_3D.aboveWaterEffects;
    this.mesh.count = 0;
    parentWorld.add(this.mesh);
  }

  update(wind: WindState | undefined, dtMs: number): void {
    if (!this.config.enabled || !wind) {
      this.mesh.count = 0;
      return;
    }

    // sim(x, y, z) -> Three(x, z, y). Preserve the authoritative direction
    // while applying the explicitly authored presentation-only speed scale.
    const vx = finiteOrZero(wind.x) * this.config.speedMultiplier;
    const vy = finiteOrZero(wind.z) * this.config.speedMultiplier;
    const vz = finiteOrZero(wind.y) * this.config.speedMultiplier;
    const speed = Math.hypot(vx, vy, vz);
    if (speed <= 1e-6) {
      this.mesh.count = 0;
      return;
    }

    const bounds = this.fieldBounds();
    if (!bounds) {
      this.mesh.count = 0;
      return;
    }
    if (!this.seeded) {
      for (let i = 0; i < this.config.maxParticles; i++) this.respawn(i, bounds, true);
      this.seeded = true;
    }

    const dtSec = Math.max(0, finiteOrZero(dtMs)) / 1000;

    for (let i = 0; i < this.config.maxParticles; i++) {
      this.age[i] += dtSec;
      this.x[i] += vx * dtSec;
      this.y[i] += vy * dtSec;
      this.z[i] += vz * dtSec;
      if (this.needsRespawn(i, bounds)) this.respawn(i, bounds, false);

      const life = Math.max(Number.EPSILON, this.life[i]);
      const lifeT = this.age[i] / life;
      const fade = this.config.fadeFraction <= 0
        ? 1
        : Math.min(
          1,
          lifeT / this.config.fadeFraction,
          (1 - lifeT) / this.config.fadeFraction,
        );
      this.alpha[i] = this.config.alpha * Math.max(0, fade);
      this.position.set(this.x[i], this.y[i], this.z[i]);
      this.matrix.compose(this.position, this.orientation, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }

    this.mesh.count = this.config.maxParticles;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, this.config.maxParticles * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphaAttribute.clearUpdateRanges();
    this.alphaAttribute.addUpdateRange(0, this.config.maxParticles);
    this.alphaAttribute.needsUpdate = true;
  }

  destroy(): void {
    disposeMesh(this.mesh);
  }

  private fieldBounds(): {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  } | null {
    const bounds = this.renderScope.getBounds(this.config.fieldPaddingWorld);
    const minX = Math.max(0, bounds.minX);
    const maxX = Math.min(this.mapWidth, bounds.maxX);
    const minZ = Math.max(0, bounds.minY);
    const maxZ = Math.min(this.mapHeight, bounds.maxY);
    if (
      !Number.isFinite(minX) || !Number.isFinite(maxX) ||
      !Number.isFinite(minZ) || !Number.isFinite(maxZ) ||
      maxX <= minX || maxZ <= minZ
    ) return null;
    return { minX, maxX, minZ, maxZ };
  }

  private needsRespawn(
    index: number,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  ): boolean {
    return this.age[index] >= this.life[index] ||
      this.x[index] < bounds.minX || this.x[index] > bounds.maxX ||
      this.z[index] < bounds.minZ || this.z[index] > bounds.maxZ;
  }

  private respawn(
    index: number,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    distributeAge: boolean,
  ): void {
    const x = lerp(bounds.minX, bounds.maxX, this.random());
    const z = lerp(bounds.minZ, bounds.maxZ, this.random());
    const worldHeight = lerp(this.lowerPlaneWorld, this.upperPlaneWorld, this.random());
    const life = lerp(
      this.config.lifetimeSeconds.min,
      this.config.lifetimeSeconds.max,
      this.random(),
    );
    this.x[index] = x;
    this.y[index] = worldHeight;
    this.z[index] = z;
    this.life[index] = life;
    this.age[index] = distributeAge ? this.random() * life : 0;
  }

  private random(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 0x100000000;
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
