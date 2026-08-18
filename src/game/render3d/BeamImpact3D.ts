// BeamImpact3D — bounded, consolidated presentation for beam termination.
//
// A live impact is one procedural point sprite per occupied world cell, not a
// stream of expanding mesh puffs. Repeated beams terminating in the same cell
// feed the same site. Small ejecta / vapour particles are born into a fixed
// ring buffer and integrate entirely in the vertex shader from birth time, so
// no particle is walked or rewritten as it ages.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { isRayType } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { RenderViewState3D } from './RenderFrameState3D';
import { disposeMesh } from './threeUtils';
import { applyExposureToRawShader } from './RenderLighting3D';
import {
  clearDirtySlotSpan,
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
  uploadPrefixRange,
} from './instancedBufferUpdate';

export type BeamImpactSurface = 'terrain' | 'water' | 'entity';

export type BeamImpactEnvironment = {
  getTerrainZ(x: number, y: number): number;
  getTerrainNormal?(x: number, y: number): { nx: number; ny: number; nz: number };
  isWaterAt?(x: number, y: number): boolean;
  waterLevel: number;
};

const IMPACT_CELL_SIZE = 4;
const IMPACT_SITE_CAP = 2048;
const IMPACT_SITE_TAIL_SEC = 0.45;
const EJECTA_CAP = 4096;
const MAX_EJECTA_BIRTHS_PER_UPDATE = 96;
const MAX_EJECTA_BIRTHS_PER_SECOND = 1800;
const TERRAIN_ENDPOINT_TOLERANCE = 4;

const SITE_VERTEX_SHADER = /* glsl */`
  attribute float aRadius;
  attribute float aHeat;
  attribute float aKind;
  attribute float aSeed;
  uniform float uViewportHeight;
  varying float vHeat;
  varying float vKind;
  varying float vSeed;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float projectedDiameter =
      aRadius * 2.0 * projectionMatrix[1][1] * uViewportHeight * 0.5 /
      max(1.0, -mv.z);
    gl_PointSize = clamp(projectedDiameter * (0.82 + 0.18 * aHeat), 2.0, 196.0);
    vHeat = aHeat;
    vKind = aKind;
    vSeed = aSeed;
  }
`;

const SITE_FRAGMENT_SHADER = /* glsl */`
  varying float vHeat;
  varying float vKind;
  varying float vSeed;

  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float angle = atan(p.y, p.x);
    float raggedEdge = 0.94 + 0.045 * sin(angle * 7.0 + vSeed * 19.0)
      + 0.025 * sin(angle * 13.0 - vSeed * 31.0);
    if (r > raggedEdge) discard;

    float core = 1.0 - smoothstep(0.05, raggedEdge, r);
    float halo = 1.0 - smoothstep(0.42, raggedEdge, r);
    vec3 terrainColor = mix(vec3(1.0, 0.10, 0.005), vec3(1.0, 0.72, 0.12), core);
    vec3 waterColor = mix(vec3(0.22, 0.58, 0.72), vec3(0.88, 0.98, 1.0), core);
    vec3 entityColor = mix(vec3(1.0, 0.28, 0.03), vec3(1.0, 0.96, 0.72), core);
    vec3 color = vKind < 0.5
      ? terrainColor
      : (vKind < 1.5 ? waterColor : entityColor);
    float alpha = (0.24 * halo + 0.72 * core) * clamp(vHeat, 0.0, 1.25);
    gl_FragColor = vec4(color, alpha);
  }
`;

const PARTICLE_VERTEX_SHADER = /* glsl */`
  attribute vec4 aMotion;
  attribute vec4 aBirthLifeSizeKind;
  attribute float aSeed;
  uniform float uTimeSec;
  uniform float uViewportHeight;
  varying float vAge01;
  varying float vKind;
  varying float vSeed;

  void main() {
    float age = uTimeSec - aBirthLifeSizeKind.x;
    float life = aBirthLifeSizeKind.y;
    vAge01 = age / max(0.001, life);
    vKind = aBirthLifeSizeKind.w;
    vSeed = aSeed;
    vec3 p = position + aMotion.xyz * age;
    p.y += 0.5 * aMotion.w * age * age;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float worldSize = aBirthLifeSizeKind.z * mix(0.65, vKind < 1.5 && vKind > 0.5 ? 2.5 : 0.25, vAge01);
    float projectedSize =
      worldSize * projectionMatrix[1][1] * uViewportHeight /
      max(1.0, -mv.z);
    gl_PointSize = clamp(projectedSize, 1.0, 72.0);
    if (age < 0.0 || age > life) gl_PointSize = 0.0;
  }
`;

const PARTICLE_FRAGMENT_SHADER = /* glsl */`
  varying float vAge01;
  varying float vKind;
  varying float vSeed;

  void main() {
    if (vAge01 < 0.0 || vAge01 > 1.0) discard;
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float fade = (1.0 - vAge01) * (1.0 - smoothstep(0.35, 1.0, r));
    vec3 terrainColor = mix(vec3(1.0, 0.18, 0.01), vec3(0.12, 0.06, 0.025), vAge01);
    vec3 waterColor = mix(vec3(0.82, 0.96, 1.0), vec3(0.34, 0.48, 0.54), vAge01);
    vec3 entityColor = mix(vec3(1.0, 0.92, 0.52), vec3(0.30, 0.07, 0.015), vAge01);
    vec3 color = vKind < 0.5
      ? terrainColor
      : (vKind < 1.5 ? waterColor : entityColor);
    float alpha = fade * (vKind < 1.5 && vKind > 0.5 ? 0.22 : 0.85);
    gl_FragColor = vec4(color, alpha);
  }
`;

type ImpactSite = {
  key: ImpactSiteKey;
  x: number;
  y: number;
  z: number;
  radius: number;
  heat: number;
  lastHitSec: number;
  kind: BeamImpactSurface;
  normalX: number;
  normalY: number;
  normalZ: number;
  incomingX: number;
  incomingY: number;
  incomingZ: number;
  seed: number;
};

type ImpactSiteKey = number | string;

const PACKED_CELL_BASE = 131072;
const PACKED_CELL_OFFSET = PACKED_CELL_BASE / 2;

function packedCellKey3D(
  kind: number,
  x: number,
  y: number,
  z: number,
  cellSize: number,
): ImpactSiteKey {
  const inv = 1 / Math.max(0.001, cellSize);
  const ix = Math.floor(x * inv);
  const iy = Math.floor(y * inv);
  const iz = Math.floor(z * inv);
  if (
    ix >= -PACKED_CELL_OFFSET && ix < PACKED_CELL_OFFSET &&
    iy >= -PACKED_CELL_OFFSET && iy < PACKED_CELL_OFFSET &&
    iz >= -PACKED_CELL_OFFSET && iz < PACKED_CELL_OFFSET
  ) {
    return (((kind * PACKED_CELL_BASE + ix + PACKED_CELL_OFFSET) * PACKED_CELL_BASE +
      iy + PACKED_CELL_OFFSET) * PACKED_CELL_BASE + iz + PACKED_CELL_OFFSET);
  }
  return `${kind}:${ix}:${iy}:${iz}`;
}

function kindNumber(kind: BeamImpactSurface): number {
  return kind === 'terrain' ? 0 : kind === 'water' ? 1 : 2;
}

function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x45d9f3b) ^ Math.imul(b | 0, 0x119de1f3);
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

export function beamImpactCellKey(
  kind: BeamImpactSurface,
  x: number,
  y: number,
  z: number,
  cellSize: number = IMPACT_CELL_SIZE,
): ImpactSiteKey {
  return packedCellKey3D(kindNumber(kind), x, y, z, cellSize);
}

function beamImpactSpatialCellKey(
  x: number,
  y: number,
  z: number,
): ImpactSiteKey {
  return packedCellKey3D(0, x, y, z, IMPACT_CELL_SIZE);
}

export function classifyBeamImpactSurface(
  endpointZ: number,
  terrainZ: number,
  waterAtEndpoint: boolean,
  waterLevel: number,
  tolerance: number = TERRAIN_ENDPOINT_TOLERANCE,
): BeamImpactSurface {
  if (Math.abs(endpointZ - terrainZ) <= tolerance) return 'terrain';
  if (waterAtEndpoint && Math.abs(endpointZ - waterLevel) <= tolerance) return 'water';
  return 'entity';
}

export class BeamImpact3D {
  private readonly root = new THREE.Group();
  private readonly sites = new Map<ImpactSiteKey, ImpactSite>();
  private readonly siteScratch: ImpactSite[] = [];
  private timeSec = 0;
  private spawnCarry = 0;
  private spawnSerial = 0;
  private spawnCursor = 0;

  private readonly sitePositions = new Float32Array(IMPACT_SITE_CAP * 3);
  private readonly siteRadius = new Float32Array(IMPACT_SITE_CAP);
  private readonly siteHeat = new Float32Array(IMPACT_SITE_CAP);
  private readonly siteKind = new Float32Array(IMPACT_SITE_CAP);
  private readonly siteSeed = new Float32Array(IMPACT_SITE_CAP);
  private readonly siteGeometry = new THREE.BufferGeometry();
  private readonly siteMaterial: THREE.ShaderMaterial;
  private readonly sitePoints: THREE.Points;

  private readonly particlePositions = new Float32Array(EJECTA_CAP * 3);
  private readonly particleMotion = new Float32Array(EJECTA_CAP * 4);
  private readonly particleBirthLifeSizeKind = new Float32Array(EJECTA_CAP * 4);
  private readonly particleSeed = new Float32Array(EJECTA_CAP);
  private readonly particleGeometry = new THREE.BufferGeometry();
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly particlePoints: THREE.Points;
  private readonly particlePosAttr: THREE.BufferAttribute;
  private readonly particleMotionAttr: THREE.BufferAttribute;
  private readonly particleBirthAttr: THREE.BufferAttribute;
  private readonly particleSeedAttr: THREE.BufferAttribute;
  private readonly particlePosDirty = createDirtySlotSpan();
  private readonly particleMotionDirty = createDirtySlotSpan();
  private readonly particleBirthDirty = createDirtySlotSpan();
  private readonly particleSeedDirty = createDirtySlotSpan();
  private particleCursor = 0;
  private particleHighWater = 0;

  constructor(
    parentWorld: THREE.Group,
    private readonly scope: ViewportFootprint,
    private readonly environment: BeamImpactEnvironment,
  ) {
    parentWorld.add(this.root);

    this.siteGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.sitePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.siteGeometry.setAttribute(
      'aRadius',
      new THREE.BufferAttribute(this.siteRadius, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.siteGeometry.setAttribute(
      'aHeat',
      new THREE.BufferAttribute(this.siteHeat, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.siteGeometry.setAttribute(
      'aKind',
      new THREE.BufferAttribute(this.siteKind, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.siteGeometry.setAttribute(
      'aSeed',
      new THREE.BufferAttribute(this.siteSeed, 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.siteGeometry.setDrawRange(0, 0);
    this.siteMaterial = new THREE.ShaderMaterial({
      vertexShader: SITE_VERTEX_SHADER,
      fragmentShader: SITE_FRAGMENT_SHADER,
      uniforms: { uViewportHeight: { value: 1080 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
    });
    applyExposureToRawShader(this.siteMaterial);
    this.sitePoints = new THREE.Points(this.siteGeometry, this.siteMaterial);
    this.sitePoints.frustumCulled = false;
    this.sitePoints.renderOrder = 13;
    this.root.add(this.sitePoints);

    this.particlePosAttr = new THREE.BufferAttribute(this.particlePositions, 3)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleMotionAttr = new THREE.BufferAttribute(this.particleMotion, 4)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleBirthAttr = new THREE.BufferAttribute(this.particleBirthLifeSizeKind, 4)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleSeedAttr = new THREE.BufferAttribute(this.particleSeed, 1)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleGeometry.setAttribute('position', this.particlePosAttr);
    this.particleGeometry.setAttribute('aMotion', this.particleMotionAttr);
    this.particleGeometry.setAttribute('aBirthLifeSizeKind', this.particleBirthAttr);
    this.particleGeometry.setAttribute('aSeed', this.particleSeedAttr);
    this.particleGeometry.setDrawRange(0, 0);
    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      uniforms: {
        uTimeSec: { value: 0 },
        uViewportHeight: { value: 1080 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    applyExposureToRawShader(this.particleMaterial);
    this.particlePoints = new THREE.Points(this.particleGeometry, this.particleMaterial);
    this.particlePoints.frustumCulled = false;
    this.particlePoints.renderOrder = 12;
    this.root.add(this.particlePoints);
  }

  update(
    projectiles: readonly Entity[],
    dtMs: number,
    view?: RenderViewState3D,
  ): void {
    const dtSec = Math.min(0.25, Math.max(0, dtMs) / 1000);
    this.timeSec += dtSec;
    const viewportHeight = Math.max(1, view?.viewportHeightPx ?? 1080);
    this.siteMaterial.uniforms.uViewportHeight.value = viewportHeight;
    this.particleMaterial.uniforms.uViewportHeight.value = viewportHeight;
    this.particleMaterial.uniforms.uTimeSec.value = this.timeSec;
    this.siteScratch.length = 0;

    for (let i = 0; i < projectiles.length; i++) {
      const entity = projectiles[i];
      const projectile = entity.projectile;
      if (
        !projectile ||
        !isRayType(projectile.projectileType) ||
        projectile.endpointDamageable === false
      ) continue;
      const points = projectile.points;
      if (!points || points.length < 2) continue;
      const end = points[points.length - 1];
      if (!this.scope.inScope(end.x, end.y, 200)) continue;
      const prev = points[points.length - 2];
      const key = beamImpactSpatialCellKey(end.x, end.y, end.z);
      let site = this.sites.get(key);
      const isNewSite = site === undefined;
      if (!site) {
        if (this.sites.size >= IMPACT_SITE_CAP) this.evictOldestSite();
        const terrainZ = this.environment.getTerrainZ(end.x, end.y);
        const kind = classifyBeamImpactSurface(
          end.z,
          terrainZ,
          this.environment.isWaterAt?.(end.x, end.y) ?? false,
          this.environment.waterLevel,
        );
        site = {
          key,
          x: end.x,
          y: end.y,
          z: end.z,
          radius: 1,
          heat: 0,
          lastHitSec: this.timeSec,
          kind,
          normalX: 0,
          normalY: 0,
          normalZ: 1,
          incomingX: 0,
          incomingY: 0,
          incomingZ: -1,
          seed: hash01(
            entity.id,
            Math.floor(end.x / IMPACT_CELL_SIZE) ^
              Math.imul(Math.floor(end.y / IMPACT_CELL_SIZE), 73856093) ^
              Math.imul(Math.floor(end.z / IMPACT_CELL_SIZE), 19349663),
          ),
        };
        this.sites.set(key, site);
      } else {
        // Refresh Map insertion order so the hard cap behaves as an O(1)
        // least-recently-used queue without a per-eviction scan.
        this.sites.delete(key);
        this.sites.set(key, site);
      }

      const age = Math.max(0, this.timeSec - site.lastHitSec);
      site.heat *= Math.exp(-age / 0.2);
      const dx = end.x - prev.x;
      const dy = end.y - prev.y;
      const dz = end.z - prev.z;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length > 1e-6) {
        site.incomingX = dx / length;
        site.incomingY = dy / length;
        site.incomingZ = dz / length;
      }
      site.x = end.x;
      site.y = end.y;
      site.z = end.z;
      if (site.kind === 'entity' || isNewSite) this.writeSurfaceNormal(site);
      const visual = projectile.config.shotProfile.visual;
      site.radius = Math.max(
        site.radius,
        Math.min(56, Math.max(visual.lineRadius * 1.4, visual.lineDamageSphereRadius * 0.42)),
      );
      const shot = projectile.config.shot;
      const dps = shot.type === 'beam' || shot.type === 'laser'
        ? Math.max(0, shot.dps)
        : 0;
      site.heat = Math.min(1.25, site.heat + dtSec * (2.4 + Math.sqrt(dps) * 0.09));
      site.lastHitSec = this.timeSec;
      this.siteScratch.push(site);
    }

    this.rebuildSites();
    this.spawnEjecta(dtSec);
  }

  private writeSurfaceNormal(site: ImpactSite): void {
    if (site.kind === 'terrain') {
      const n = this.environment.getTerrainNormal?.(site.x, site.y);
      site.normalX = n?.nx ?? 0;
      site.normalY = n?.ny ?? 0;
      site.normalZ = n?.nz ?? 1;
    } else if (site.kind === 'water') {
      site.normalX = 0;
      site.normalY = 0;
      site.normalZ = 1;
    } else {
      // Without exposing hidden target identity on the wire, the stable
      // physically useful entity normal is the face opposing the ray.
      site.normalX = -site.incomingX;
      site.normalY = -site.incomingY;
      site.normalZ = -site.incomingZ;
    }
    const len = Math.sqrt(
      site.normalX * site.normalX +
      site.normalY * site.normalY +
      site.normalZ * site.normalZ,
    );
    if (len > 1e-6) {
      site.normalX /= len;
      site.normalY /= len;
      site.normalZ /= len;
    } else {
      site.normalX = 0;
      site.normalY = 0;
      site.normalZ = 1;
    }
  }

  private rebuildSites(): void {
    let count = 0;
    for (const [key, site] of this.sites) {
      const age = Math.max(0, this.timeSec - site.lastHitSec);
      if (age > IMPACT_SITE_TAIL_SEC) {
        this.sites.delete(key);
        continue;
      }
      if (count >= IMPACT_SITE_CAP) break;
      const heat = site.heat * Math.exp(-age / 0.18);
      const p = count * 3;
      this.sitePositions[p] = site.x;
      this.sitePositions[p + 1] = site.z;
      this.sitePositions[p + 2] = site.y;
      this.siteRadius[count] = site.radius;
      this.siteHeat[count] = heat;
      this.siteKind[count] = kindNumber(site.kind);
      this.siteSeed[count] = site.seed;
      count++;
    }
    this.siteGeometry.setDrawRange(0, count);
    if (count <= 0) return;
    uploadPrefixRange(this.siteGeometry.getAttribute('position') as THREE.BufferAttribute, count * 3);
    uploadPrefixRange(this.siteGeometry.getAttribute('aRadius') as THREE.BufferAttribute, count);
    uploadPrefixRange(this.siteGeometry.getAttribute('aHeat') as THREE.BufferAttribute, count);
    uploadPrefixRange(this.siteGeometry.getAttribute('aKind') as THREE.BufferAttribute, count);
    uploadPrefixRange(this.siteGeometry.getAttribute('aSeed') as THREE.BufferAttribute, count);
  }

  private spawnEjecta(dtSec: number): void {
    const active = this.siteScratch;
    if (active.length === 0 || dtSec <= 0) return;
    const birthsPerSec = Math.min(MAX_EJECTA_BIRTHS_PER_SECOND, active.length * 10);
    this.spawnCarry += birthsPerSec * dtSec;
    const birthCount = Math.min(MAX_EJECTA_BIRTHS_PER_UPDATE, Math.floor(this.spawnCarry));
    this.spawnCarry -= birthCount;
    for (let i = 0; i < birthCount; i++) {
      const site = active[this.spawnCursor % active.length];
      this.spawnCursor++;
      this.spawnParticle(site);
    }
    if (this.particleHighWater > 0) {
      this.particleGeometry.setDrawRange(0, this.particleHighWater);
      uploadDirtySlotSpan(this.particlePosAttr, this.particlePosDirty, 3);
      uploadDirtySlotSpan(this.particleMotionAttr, this.particleMotionDirty, 4);
      uploadDirtySlotSpan(this.particleBirthAttr, this.particleBirthDirty, 4);
      uploadDirtySlotSpan(this.particleSeedAttr, this.particleSeedDirty, 1);
    }
  }

  private spawnParticle(site: ImpactSite): void {
    const slot = this.particleCursor;
    this.particleCursor = (this.particleCursor + 1) % EJECTA_CAP;
    this.particleHighWater = Math.max(this.particleHighWater, slot + 1);
    const serial = this.spawnSerial++;
    const r0 = hash01(serial, 11);
    const r1 = hash01(serial, 29);
    const r2 = hash01(serial, 47);
    // Build an orthonormal basis around the surface normal. Ejecta therefore
    // fans along the actual slope/entity tangent plane instead of a global XY
    // plane, while the positive normal component carries it away from matter.
    let tangent1X: number;
    let tangent1Y: number;
    let tangent1Z: number;
    if (Math.abs(site.normalZ) < 0.9) {
      tangent1X = -site.normalY;
      tangent1Y = site.normalX;
      tangent1Z = 0;
    } else {
      tangent1X = 0;
      tangent1Y = -site.normalZ;
      tangent1Z = site.normalY;
    }
    const tangentLength = Math.sqrt(
      tangent1X * tangent1X + tangent1Y * tangent1Y + tangent1Z * tangent1Z,
    );
    tangent1X /= tangentLength;
    tangent1Y /= tangentLength;
    tangent1Z /= tangentLength;
    const tangent2X = site.normalY * tangent1Z - site.normalZ * tangent1Y;
    const tangent2Y = site.normalZ * tangent1X - site.normalX * tangent1Z;
    const tangent2Z = site.normalX * tangent1Y - site.normalY * tangent1X;
    const angle = r0 * Math.PI * 2;
    const tangentCos = Math.cos(angle);
    const tangentSin = Math.sin(angle);
    const tangentX = tangent1X * tangentCos + tangent2X * tangentSin;
    const tangentY = tangent1Y * tangentCos + tangent2Y * tangentSin;
    const tangentZ = tangent1Z * tangentCos + tangent2Z * tangentSin;
    const speed = site.kind === 'water'
      ? 8 + 16 * r1
      : 32 + 72 * r1;
    const tangentSpeed = speed * (0.2 + r2 * 0.6) * (site.kind === 'water' ? 0.35 : 0.8);
    const vx = site.normalX * speed + tangentX * tangentSpeed;
    const vy = site.normalY * speed + tangentY * tangentSpeed;
    const vz = site.normalZ * speed + tangentZ * tangentSpeed +
      (site.kind === 'water' ? 10 : 18) * r2;
    const p = slot * 3;
    this.particlePositions[p] = site.x + site.normalX * 0.5;
    this.particlePositions[p + 1] = site.z + site.normalZ * 0.5;
    this.particlePositions[p + 2] = site.y + site.normalY * 0.5;
    const m = slot * 4;
    this.particleMotion[m] = vx;
    this.particleMotion[m + 1] = vz;
    this.particleMotion[m + 2] = vy;
    this.particleMotion[m + 3] = site.kind === 'water' ? 18 : -150;
    this.particleBirthLifeSizeKind[m] = this.timeSec;
    this.particleBirthLifeSizeKind[m + 1] = site.kind === 'water'
      ? 0.65 + r1 * 0.55
      : 0.32 + r1 * 0.42;
    this.particleBirthLifeSizeKind[m + 2] = site.kind === 'water'
      ? Math.max(1.5, site.radius * 0.16)
      : Math.max(0.8, site.radius * 0.075);
    this.particleBirthLifeSizeKind[m + 3] = kindNumber(site.kind);
    this.particleSeed[slot] = r2;
    markDirtySlot(this.particlePosDirty, slot);
    markDirtySlot(this.particleMotionDirty, slot);
    markDirtySlot(this.particleBirthDirty, slot);
    markDirtySlot(this.particleSeedDirty, slot);
  }

  private evictOldestSite(): void {
    const oldest = this.sites.keys().next();
    if (!oldest.done) this.sites.delete(oldest.value);
  }

  destroy(): void {
    this.sites.clear();
    this.siteScratch.length = 0;
    clearDirtySlotSpan(this.particlePosDirty);
    clearDirtySlotSpan(this.particleMotionDirty);
    clearDirtySlotSpan(this.particleBirthDirty);
    clearDirtySlotSpan(this.particleSeedDirty);
    disposeMesh(this.sitePoints);
    disposeMesh(this.particlePoints);
    this.root.parent?.remove(this.root);
  }
}
