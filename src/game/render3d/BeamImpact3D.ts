// DamageImpact3D — bounded, consolidated presentation for damage endpoints.
//
// Live rays and one-shot projectile detonations feed the same world-cell sites
// instead of spawning expanding fire spheres. Small ejecta are born into a
// fixed ring buffer and integrate entirely in the vertex shader from birth
// time, so no particle is walked or rewritten as it ages.

import * as THREE from 'three';
import { getVolumeToggle } from '@/clientBarConfig';
import { COLORS } from '@/colorsConfig';
import type { Entity } from '../sim/types';
import { isRayType } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { RenderViewState3D } from './RenderFrameState3D';
import { disposeMesh } from './threeUtils';
import { applyExposureToRawShader } from './RenderLighting3D';
import { DamageBurnVolume3D } from './BeamBurnVolume3D';
import {
  createPrimitiveSphereGeometry,
  createPrimitiveTetrahedronGeometry,
} from './PrimitiveGeometryQuality3D';
import {
  clearDirtySlotSpan,
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
  uploadPrefixRange,
} from './instancedBufferUpdate';

export type DamageImpactSurface =
  | 'terrain'
  | 'water'
  | 'entity'
  | 'endpoint'
  | 'blast';
export type BeamImpactSurface = DamageImpactSurface;

export type DamageImpactEnvironment = {
  getTerrainZ(x: number, y: number): number;
  getTerrainNormal?(x: number, y: number): { nx: number; ny: number; nz: number };
  isWaterAt?(x: number, y: number): boolean;
  waterLevel: number;
  depositGroundBurn?(x: number, y: number, width: number, energy: number): void;
};
export type BeamImpactEnvironment = DamageImpactEnvironment;

export type DamageImpactRequest = {
  x: number;
  y: number;
  z: number;
  /** Exact authoritative damage/splash sphere radius. */
  damageRadius: number;
  /** Incoming shot direction or momentum in simulation XYZ coordinates. */
  incomingX?: number;
  incomingY?: number;
  incomingZ?: number;
  /** True only when the terminal event is known to have struck a body. */
  hitEntity?: boolean;
  /** Explicit presentation surface for events whose semantics are already
   *  known. Entity deaths are free-space fire blasts even when their centre
   *  happens to lie within the terrain endpoint tolerance. */
  surface?: DamageImpactSurface;
  /** Presentation density selected by the shared effect LOD policy. */
  detailScale?: number;
  /** Thermal deposit strength; derived from radius when omitted. */
  energy?: number;
  /** Stable provenance used only to vary the consolidated site's shape. */
  seedSource?: number;
};

const IMPACT_CELL_SIZE = 4;
const IMPACT_SITE_CAP = 2048;
const IMPACT_SITE_TAIL_SEC = 0.45;
const EJECTA_CAP = 4096;
const MAX_EJECTA_BIRTHS_PER_UPDATE = 96;
const MAX_EJECTA_BIRTHS_PER_SECOND = 2600;
const MAX_QUEUED_DAMAGE_IMPACTS = 512;
const TERRAIN_ENDPOINT_TOLERANCE = 4;
const EJECTA_SIZE_SCALE = [0.55, 1, 1.55] as const;
const EJECTA_SPEED_SCALE = [1.55, 1, 0.62] as const;
const ENDPOINT_EJECTA_FORWARD_SPEED = 0.85 * 3;
const ENDPOINT_EJECTA_RANDOM_SPREAD = 0.65;

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
    vec3 entityColor = mix(vec3(1.0, 0.08, 0.005), vec3(1.0, 0.64, 0.08), core);
    vec3 endpointColor = mix(vec3(0.72, 0.78, 0.84), vec3(1.0), core);
    vec3 blastColor = mix(vec3(1.0, 0.055, 0.002), vec3(1.0, 0.82, 0.16), core);
    vec3 color = vKind < 0.5
      ? terrainColor
      : (vKind < 1.5
        ? waterColor
        : (vKind < 2.5
          ? entityColor
          : (vKind < 3.5 ? endpointColor : blastColor)));
    float alpha = (0.24 * halo + 0.72 * core) * clamp(vHeat, 0.0, 1.25);
    gl_FragColor = vec4(color, alpha);
  }
`;

const PARTICLE_VERTEX_SHADER = /* glsl */`
  attribute vec4 aMotion;
  attribute vec4 aBirthLifeKindSeed;
  uniform float uTimeSec;
  varying float vAge01;
  varying float vKind;
  varying float vSeed;

  void main() {
    float age = uTimeSec - aBirthLifeKindSeed.x;
    float life = aBirthLifeKindSeed.y;
    vAge01 = age / max(0.001, life);
    vKind = aBirthLifeKindSeed.z;
    vSeed = aBirthLifeKindSeed.w;
    float spin = age * (7.0 + vSeed * 15.0);
    float c = cos(spin);
    float s = sin(spin);
    vec3 local = position;
    local.yz = mat2(c, -s, s, c) * local.yz;
    float c2 = cos(spin * (0.63 + vSeed * 0.31));
    float s2 = sin(spin * (0.63 + vSeed * 0.31));
    local.xz = mat2(c2, -s2, s2, c2) * local.xz;
    vec4 worldPosition = instanceMatrix * vec4(local, 1.0);
    worldPosition.xyz += aMotion.xyz * age;
    worldPosition.y += 0.5 * aMotion.w * age * age;
    vec4 mv = modelViewMatrix * worldPosition;
    gl_Position = projectionMatrix * mv;
    if (age < 0.0 || age > life) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const PARTICLE_FRAGMENT_SHADER = /* glsl */`
  varying float vAge01;
  varying float vKind;
  varying float vSeed;

  void main() {
    if (vAge01 < 0.0 || vAge01 > 1.0) discard;
    float fadeIn = smoothstep(0.0, 0.08, vAge01);
    float fadeOut = 1.0 - smoothstep(0.56, 1.0, vAge01);
    float fade = fadeIn * fadeOut;
    vec3 terrainColor = mix(vec3(1.0, 0.18, 0.01), vec3(0.12, 0.06, 0.025), vAge01);
    vec3 waterColor = mix(vec3(0.82, 0.96, 1.0), vec3(0.34, 0.48, 0.54), vAge01);
    vec3 entityColor = mix(vec3(1.0, 0.16, 0.008), vec3(0.12, 0.035, 0.012), vAge01);
    vec3 endpointColor = mix(vec3(1.0), vec3(0.52, 0.57, 0.62), vAge01);
    vec3 blastColor = mix(vec3(1.0, 0.20, 0.008), vec3(0.11, 0.025, 0.008), vAge01);
    vec3 color = vKind < 0.5
      ? terrainColor
      : (vKind < 1.5
        ? waterColor
        : (vKind < 2.5
          ? entityColor
          : (vKind < 3.5 ? endpointColor : blastColor)));
    float alpha = fade * (vKind < 1.5 && vKind > 0.5 ? 0.48 : 0.92);
    gl_FragColor = vec4(color, alpha);
  }
`;

type ImpactSite = {
  key: ImpactSiteKey;
  x: number;
  y: number;
  z: number;
  radius: number;
  damageRadius: number;
  radiusUpdateSerial: number;
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

function kindNumber(kind: DamageImpactSurface): number {
  return kind === 'terrain'
    ? 0
    : kind === 'water'
      ? 1
      : kind === 'entity'
        ? 2
        : kind === 'endpoint'
          ? 3
          : 4;
}

function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x45d9f3b) ^ Math.imul(b | 0, 0x119de1f3);
  h ^= h >>> 16;
  h = Math.imul(h, 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

export function damageImpactCellKey(
  kind: DamageImpactSurface,
  x: number,
  y: number,
  z: number,
  cellSize: number = IMPACT_CELL_SIZE,
): ImpactSiteKey {
  return packedCellKey3D(kindNumber(kind), x, y, z, cellSize);
}

export const beamImpactCellKey = damageImpactCellKey;

function damageImpactSpatialCellKey(
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
  hitEntity: boolean = false,
): BeamImpactSurface {
  if (Math.abs(endpointZ - terrainZ) <= tolerance) return 'terrain';
  if (waterAtEndpoint && Math.abs(endpointZ - waterLevel) <= tolerance) return 'water';
  return hitEntity ? 'entity' : 'endpoint';
}

export function classifyDamageImpactSurface(
  endpointZ: number,
  terrainZ: number,
  waterAtEndpoint: boolean,
  waterLevel: number,
  hitEntity: boolean,
  tolerance: number = TERRAIN_ENDPOINT_TOLERANCE,
): DamageImpactSurface {
  if (Math.abs(endpointZ - terrainZ) <= tolerance) return 'terrain';
  if (waterAtEndpoint && Math.abs(endpointZ - waterLevel) <= tolerance) return 'water';
  return hitEntity ? 'entity' : 'blast';
}

export class DamageImpact3D {
  private readonly root = new THREE.Group();
  private readonly burnVolume: DamageBurnVolume3D;
  private readonly sites = new Map<ImpactSiteKey, ImpactSite>();
  private readonly siteScratch: ImpactSite[] = [];
  private timeSec = 0;
  private spawnCarry = 0;
  private spawnSerial = 0;
  private spawnCursor = 0;
  private particleBirthsThisUpdate = 0;
  private updateSerial = 0;
  private readonly pendingImpacts: DamageImpactRequest[] = [];

  private readonly sitePositions = new Float32Array(IMPACT_SITE_CAP * 3);
  private readonly siteRadius = new Float32Array(IMPACT_SITE_CAP);
  private readonly siteHeat = new Float32Array(IMPACT_SITE_CAP);
  private readonly siteKind = new Float32Array(IMPACT_SITE_CAP);
  private readonly siteSeed = new Float32Array(IMPACT_SITE_CAP);
  private readonly siteGeometry = new THREE.BufferGeometry();
  private readonly siteMaterial: THREE.ShaderMaterial;
  private readonly sitePoints: THREE.Points;
  private readonly debugDamageVolumeGeometry = createPrimitiveSphereGeometry('effect', 'far');
  private readonly debugDamageVolumeMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.effects.projectile.explosionRadius.colorHex,
    transparent: true,
    opacity: Math.max(0.3, COLORS.effects.projectile.explosionRadius.opacity),
    depthTest: true,
    depthWrite: false,
    wireframe: true,
  });
  private readonly debugDamageVolumeMesh: THREE.InstancedMesh;
  private readonly debugDamageVolumeMatrix = new THREE.Matrix4();

  private readonly particleMotion = new Float32Array(EJECTA_CAP * 4);
  private readonly particleBirthLifeKindSeed = new Float32Array(EJECTA_CAP * 4);
  private readonly particleGeometry = createPrimitiveTetrahedronGeometry(1);
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly particleMesh: THREE.InstancedMesh;
  private readonly particleMotionAttr: THREE.InstancedBufferAttribute;
  private readonly particleBirthAttr: THREE.InstancedBufferAttribute;
  private readonly particleMatrixDirty = createDirtySlotSpan();
  private readonly particleMotionDirty = createDirtySlotSpan();
  private readonly particleBirthDirty = createDirtySlotSpan();
  private readonly particlePosition = new THREE.Vector3();
  private readonly particleScale = new THREE.Vector3();
  private readonly particleQuaternion = new THREE.Quaternion();
  private readonly particleEuler = new THREE.Euler();
  private readonly particleMatrix = new THREE.Matrix4();
  private particleCursor = 0;
  private particleHighWater = 0;

  constructor(
    parentWorld: THREE.Group,
    private readonly scope: ViewportFootprint,
    private readonly environment: DamageImpactEnvironment,
  ) {
    parentWorld.add(this.root);
    this.burnVolume = new DamageBurnVolume3D(this.root);

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

    this.debugDamageVolumeMesh = new THREE.InstancedMesh(
      this.debugDamageVolumeGeometry,
      this.debugDamageVolumeMaterial,
      IMPACT_SITE_CAP,
    );
    this.debugDamageVolumeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debugDamageVolumeMesh.count = 0;
    this.debugDamageVolumeMesh.frustumCulled = false;
    this.debugDamageVolumeMesh.renderOrder = 15;
    this.root.add(this.debugDamageVolumeMesh);

    this.particleMotionAttr = new THREE.InstancedBufferAttribute(this.particleMotion, 4)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleBirthAttr = new THREE.InstancedBufferAttribute(this.particleBirthLifeKindSeed, 4)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleGeometry.setAttribute('aMotion', this.particleMotionAttr);
    this.particleGeometry.setAttribute('aBirthLifeKindSeed', this.particleBirthAttr);
    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      uniforms: {
        uTimeSec: { value: 0 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    applyExposureToRawShader(this.particleMaterial);
    this.particleMesh = new THREE.InstancedMesh(
      this.particleGeometry,
      this.particleMaterial,
      EJECTA_CAP,
    );
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particleMesh.count = 0;
    this.particleMesh.frustumCulled = false;
    this.particleMesh.renderOrder = 12;
    this.root.add(this.particleMesh);
  }

  /** Queue a one-shot damage event. Events are consumed with the next render
   *  update so scorch, residue, site consolidation, and GPU uploads share the
   *  exact same bounded frame lifecycle as continuous beam endpoints. */
  spawnDamageImpact(request: DamageImpactRequest): void {
    if (this.pendingImpacts.length >= MAX_QUEUED_DAMAGE_IMPACTS) return;
    if (
      !Number.isFinite(request.x) ||
      !Number.isFinite(request.y) ||
      !Number.isFinite(request.z) ||
      !Number.isFinite(request.damageRadius) ||
      request.damageRadius <= 0
    ) return;
    this.pendingImpacts.push(request);
  }

  update(
    projectiles: readonly Entity[],
    dtMs: number,
    view?: RenderViewState3D,
  ): void {
    const dtSec = Math.min(0.25, Math.max(0, dtMs) / 1000);
    this.updateSerial = (this.updateSerial + 1) & 0x3fffffff;
    this.timeSec += dtSec;
    const viewportHeight = Math.max(1, view?.viewportHeightPx ?? 1080);
    this.siteMaterial.uniforms.uViewportHeight.value = viewportHeight;
    this.particleMaterial.uniforms.uTimeSec.value = this.timeSec;
    this.burnVolume.beginFrame(this.timeSec, dtMs);
    this.siteScratch.length = 0;
    this.particleBirthsThisUpdate = 0;
    this.processPendingDamageImpacts();

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
      const hitEntity = projectile.obstructionT !== null;
      const key = damageImpactSpatialCellKey(end.x, end.y, end.z);
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
          TERRAIN_ENDPOINT_TOLERANCE,
          hitEntity,
        );
        site = {
          key,
          x: end.x,
          y: end.y,
          z: end.z,
          radius: 1,
          damageRadius: 0,
          radiusUpdateSerial: -1,
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
        // The same endpoint cell can alternate between a clear range endpoint
        // and an obstructing body as units move through the beam. Terrain and
        // water are stable spatial classifications; body occupancy is not.
        if (
          site.kind === 'entity' ||
          site.kind === 'endpoint' ||
          site.kind === 'blast'
        ) {
          site.kind = hitEntity ? 'entity' : 'endpoint';
        }
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
      if (site.kind === 'entity' || site.kind === 'endpoint' || isNewSite) {
        this.writeSurfaceNormal(site);
      }
      const visual = projectile.config.shotProfile.visual;
      this.recordSiteRadii(
        site,
        Math.min(56, Math.max(visual.lineRadius * 1.4, visual.lineDamageSphereRadius * 0.42)),
        visual.lineDamageSphereRadius,
      );
      const shot = projectile.config.shot;
      const dps = shot.type === 'beam' || shot.type === 'laser'
        ? Math.max(0, shot.dps)
        : 0;
      if (site.kind === 'entity' || site.kind === 'endpoint') {
        const damageRadius = Math.max(
          visual.lineRadius * 2,
          visual.lineDamageSphereRadius,
        );
        const depositedEnergy = Math.max(
          0.012,
          dps * dtSec / Math.max(6, damageRadius),
        );
        this.burnVolume.deposit(
          end.x,
          end.y,
          end.z,
          Math.min(24, Math.max(4, visual.lineRadius, damageRadius * 0.24)),
          depositedEnergy,
        );
      }
      site.heat = Math.min(1.25, site.heat + dtSec * (2.4 + Math.sqrt(dps) * 0.09));
      site.lastHitSec = this.timeSec;
      this.siteScratch.push(site);
    }

    this.rebuildSites();
    this.spawnEjecta(dtSec);
    this.uploadParticles();
    this.burnVolume.endFrame();
  }

  private processPendingDamageImpacts(): void {
    const pending = this.pendingImpacts;
    for (let i = 0; i < pending.length; i++) {
      const impact = pending[i];
      if (!this.scope.inScope(impact.x, impact.y, 200)) continue;
      const damageRadius = Math.max(0.01, impact.damageRadius);
      const terrainZ = this.environment.getTerrainZ(impact.x, impact.y);
      const kind = impact.surface ?? classifyDamageImpactSurface(
        impact.z,
        terrainZ,
        this.environment.isWaterAt?.(impact.x, impact.y) ?? false,
        this.environment.waterLevel,
        impact.hitEntity === true,
        Math.max(TERRAIN_ENDPOINT_TOLERANCE, damageRadius * 0.08),
      );
      const key = damageImpactSpatialCellKey(impact.x, impact.y, impact.z);
      let site = this.sites.get(key);
      if (!site) {
        if (this.sites.size >= IMPACT_SITE_CAP) this.evictOldestSite();
        site = {
          key,
          x: impact.x,
          y: impact.y,
          z: impact.z,
          radius: 1,
          damageRadius: 0,
          radiusUpdateSerial: -1,
          heat: 0,
          lastHitSec: this.timeSec,
          kind,
          normalX: 0,
          normalY: 0,
          normalZ: 1,
          incomingX: 0,
          incomingY: 0,
          incomingZ: 0,
          seed: hash01(
            impact.seedSource ?? this.spawnSerial,
            Math.floor(impact.x / IMPACT_CELL_SIZE) ^
              Math.imul(Math.floor(impact.y / IMPACT_CELL_SIZE), 73856093) ^
              Math.imul(Math.floor(impact.z / IMPACT_CELL_SIZE), 19349663),
          ),
        };
        this.sites.set(key, site);
      } else {
        this.sites.delete(key);
        this.sites.set(key, site);
      }

      const age = Math.max(0, this.timeSec - site.lastHitSec);
      site.heat *= Math.exp(-age / 0.2);
      site.x = impact.x;
      site.y = impact.y;
      site.z = impact.z;
      site.kind = kind;
      const incomingX = impact.incomingX ?? 0;
      const incomingY = impact.incomingY ?? 0;
      const incomingZ = impact.incomingZ ?? 0;
      const incomingLength = Math.sqrt(
        incomingX * incomingX + incomingY * incomingY + incomingZ * incomingZ,
      );
      if (incomingLength > 1e-6) {
        site.incomingX = incomingX / incomingLength;
        site.incomingY = incomingY / incomingLength;
        site.incomingZ = incomingZ / incomingLength;
      } else {
        site.incomingX = 0;
        site.incomingY = 0;
        site.incomingZ = 0;
      }
      this.writeSurfaceNormal(site);
      this.recordSiteRadii(
        site,
        Math.min(56, Math.max(1.5, damageRadius * 0.42)),
        damageRadius,
      );
      const energy = Math.max(
        0.2,
        Number.isFinite(impact.energy) ? impact.energy ?? 0 : Math.sqrt(damageRadius) * 0.16,
      );
      site.heat = Math.min(1.25, Math.max(site.heat, 0.86) + energy * 0.12);
      site.lastHitSec = this.timeSec;

      const residueRadius = Math.min(24, Math.max(4, damageRadius * 0.24));
      if (kind === 'terrain') {
        this.environment.depositGroundBurn?.(
          impact.x,
          impact.y,
          Math.max(4, damageRadius * 1.2),
          energy,
        );
      } else if (kind !== 'water') {
        this.burnVolume.deposit(
          impact.x,
          impact.y,
          impact.z,
          residueRadius,
          energy,
        );
      }

      const detailScale = Math.max(0, Math.min(1, impact.detailScale ?? 1));
      const requestedBirths = Math.max(
        1,
        Math.round((5 + Math.sqrt(damageRadius) * 2.4) * detailScale),
      );
      const availableBirths = Math.max(
        0,
        MAX_EJECTA_BIRTHS_PER_UPDATE - this.particleBirthsThisUpdate,
      );
      const birthCount = Math.min(requestedBirths, availableBirths);
      for (let birth = 0; birth < birthCount; birth++) this.spawnParticle(site);
      this.particleBirthsThisUpdate += birthCount;
    }
    pending.length = 0;
  }

  private recordSiteRadii(
    site: ImpactSite,
    visualRadius: number,
    damageRadius: number,
  ): void {
    if (site.radiusUpdateSerial !== this.updateSerial) {
      site.radius = visualRadius;
      site.damageRadius = damageRadius;
      site.radiusUpdateSerial = this.updateSerial;
      return;
    }
    site.radius = Math.max(site.radius, visualRadius);
    site.damageRadius = Math.max(site.damageRadius, damageRadius);
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
    } else if (site.kind === 'entity') {
      // The snapshot does not expose collider-face normals. Opposing the
      // terminal ray is a stable physical approximation for body ejecta.
      site.normalX = -site.incomingX;
      site.normalY = -site.incomingY;
      site.normalZ = -site.incomingZ;
    } else {
      // A finite/free endpoint is not a surface. Its white marker ejecta uses
      // forward scatter, while a free-space blast uses radial scatter. This
      // normal is only a harmless fallback for either non-surface category.
      site.normalX = 0;
      site.normalY = 0;
      site.normalZ = 1;
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
    let debugDamageVolumeCount = 0;
    const showDamageVolumes = getVolumeToggle('explosion');
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
      if (showDamageVolumes && site.damageRadius > 0) {
        this.debugDamageVolumeMatrix.makeScale(
          site.damageRadius,
          site.damageRadius,
          site.damageRadius,
        );
        this.debugDamageVolumeMatrix.setPosition(site.x, site.z, site.y);
        this.debugDamageVolumeMesh.setMatrixAt(
          debugDamageVolumeCount++,
          this.debugDamageVolumeMatrix,
        );
      }
      count++;
    }
    this.siteGeometry.setDrawRange(0, count);
    this.debugDamageVolumeMesh.count = debugDamageVolumeCount;
    if (debugDamageVolumeCount > 0) {
      this.debugDamageVolumeMesh.instanceMatrix.needsUpdate = true;
    }
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
    const birthsPerSec = Math.min(MAX_EJECTA_BIRTHS_PER_SECOND, active.length * 28);
    this.spawnCarry += birthsPerSec * dtSec;
    const availableBirths = Math.max(
      0,
      MAX_EJECTA_BIRTHS_PER_UPDATE - this.particleBirthsThisUpdate,
    );
    const requestedBirths = Math.floor(this.spawnCarry);
    const birthCount = Math.min(availableBirths, requestedBirths);
    // A one-shot burst may consume this frame's bounded birth budget. Discard
    // the starved whole births instead of replaying a stale particle avalanche
    // after combat becomes quiet; preserve only the fractional carry.
    this.spawnCarry -= requestedBirths;
    for (let i = 0; i < birthCount; i++) {
      const site = active[this.spawnCursor % active.length];
      this.spawnCursor++;
      this.spawnParticle(site);
    }
    this.particleBirthsThisUpdate += birthCount;
  }

  private uploadParticles(): void {
    if (this.particleHighWater > 0) {
      this.particleMesh.count = this.particleHighWater;
      uploadDirtySlotSpan(this.particleMesh.instanceMatrix, this.particleMatrixDirty, 16);
      uploadDirtySlotSpan(this.particleMotionAttr, this.particleMotionDirty, 4);
      uploadDirtySlotSpan(this.particleBirthAttr, this.particleBirthDirty, 4);
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
    const r3 = hash01(serial, 71);
    const sizeRoll = hash01(serial, 97);
    // Most fragments are light chips, with fewer medium pieces and occasional
    // heavy chunks. The inverse speed relationship reads as different mass:
    // small pieces accept more acceleration while large pieces retain inertia.
    const sizeClass = sizeRoll < 0.48 ? 0 : sizeRoll < 0.83 ? 1 : 2;
    const sizeScale = EJECTA_SIZE_SCALE[sizeClass];
    const speedScale = EJECTA_SPEED_SCALE[sizeClass];
    const baseSpeed = site.kind === 'water'
      ? 8 + 16 * r3
      : 32 + 72 * r3;
    const speed = baseSpeed * speedScale;
    let vx: number;
    let vy: number;
    let vz: number;
    if (site.kind === 'endpoint') {
      // A clear finite/range endpoint is not a physical surface. Give its
      // white marker chunks isotropic 3D scatter plus an independent component
      // in the beam's forward direction. The forward component is deliberately
      // not normalized away: it carries three times its previous downrange
      // speed while leaving the random component unchanged.
      const randomZ = r0 * 2 - 1;
      const randomRadial = Math.sqrt(Math.max(0, 1 - randomZ * randomZ));
      const randomAzimuth = r1 * Math.PI * 2;
      const randomX = Math.cos(randomAzimuth) * randomRadial;
      const randomY = Math.sin(randomAzimuth) * randomRadial;
      vx = (site.incomingX * ENDPOINT_EJECTA_FORWARD_SPEED +
        randomX * ENDPOINT_EJECTA_RANDOM_SPREAD) * speed;
      vy = (site.incomingY * ENDPOINT_EJECTA_FORWARD_SPEED +
        randomY * ENDPOINT_EJECTA_RANDOM_SPREAD) * speed;
      vz = (site.incomingZ * ENDPOINT_EJECTA_FORWARD_SPEED +
        randomZ * ENDPOINT_EJECTA_RANDOM_SPREAD) * speed;
    } else if (site.kind === 'blast') {
      // Free-space detonations inherit some shot momentum but remain radial:
      // the damage volume is spherical even while its hot matter drifts with
      // the projectile that supplied the energy.
      const randomZ = r0 * 2 - 1;
      const randomRadial = Math.sqrt(Math.max(0, 1 - randomZ * randomZ));
      const randomAzimuth = r1 * Math.PI * 2;
      const randomX = Math.cos(randomAzimuth) * randomRadial;
      const randomY = Math.sin(randomAzimuth) * randomRadial;
      vx = (randomX + site.incomingX * 0.35) * speed;
      vy = (randomY + site.incomingY * 0.35) * speed;
      vz = (randomZ + site.incomingZ * 0.35) * speed;
    } else {
      // Real terrain/water/body contacts do have a response normal. Build an
      // orthonormal basis around it so debris reacts to the impact surface.
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
      const tangentSpeed = speed * (0.2 + r2 * 0.6) *
        (site.kind === 'water' ? 0.35 : 0.8);
      vx = site.normalX * speed + tangentX * tangentSpeed;
      vy = site.normalY * speed + tangentY * tangentSpeed;
      vz = site.normalZ * speed + tangentZ * tangentSpeed +
        (site.kind === 'water' ? 10 : 18) * r2;
    }
    const m = slot * 4;
    this.particleMotion[m] = vx;
    this.particleMotion[m + 1] = vz;
    this.particleMotion[m + 2] = vy;
    this.particleMotion[m + 3] = site.kind === 'water' ? 18 : -150;
    this.particleBirthLifeKindSeed[m] = this.timeSec;
    this.particleBirthLifeKindSeed[m + 1] = site.kind === 'water'
      ? 0.75 + r1 * 0.6
      : 0.48 + r1 * 0.5;
    this.particleBirthLifeKindSeed[m + 2] = kindNumber(site.kind);
    this.particleBirthLifeKindSeed[m + 3] = r2;
    const baseChunkSize = site.kind === 'water'
      ? Math.max(1.4, site.radius * 0.09)
      : Math.max(1.2, site.radius * 0.075);
    const chunkSize = baseChunkSize * sizeScale;
    const surfaceOffset = site.kind === 'endpoint' || site.kind === 'blast'
      ? 0
      : chunkSize * 0.35;
    this.particlePosition.set(
      site.x + site.normalX * surfaceOffset,
      site.z + site.normalZ * surfaceOffset,
      site.y + site.normalY * surfaceOffset,
    );
    this.particleEuler.set(r0 * Math.PI * 2, r1 * Math.PI * 2, r2 * Math.PI * 2);
    this.particleQuaternion.setFromEuler(this.particleEuler);
    this.particleScale.set(
      chunkSize * (0.75 + r0 * 0.5),
      chunkSize * (0.62 + r1 * 0.42),
      chunkSize * (0.72 + r2 * 0.48),
    );
    this.particleMatrix.compose(
      this.particlePosition,
      this.particleQuaternion,
      this.particleScale,
    );
    this.particleMesh.setMatrixAt(slot, this.particleMatrix);
    markDirtySlot(this.particleMatrixDirty, slot);
    markDirtySlot(this.particleMotionDirty, slot);
    markDirtySlot(this.particleBirthDirty, slot);
  }

  private evictOldestSite(): void {
    const oldest = this.sites.keys().next();
    if (!oldest.done) this.sites.delete(oldest.value);
  }

  destroy(): void {
    this.sites.clear();
    this.siteScratch.length = 0;
    this.pendingImpacts.length = 0;
    clearDirtySlotSpan(this.particleMatrixDirty);
    clearDirtySlotSpan(this.particleMotionDirty);
    clearDirtySlotSpan(this.particleBirthDirty);
    this.burnVolume.destroy();
    disposeMesh(this.sitePoints);
    disposeMesh(this.particleMesh);
    disposeMesh(this.debugDamageVolumeMesh);
    this.root.parent?.remove(this.root);
  }
}

/** Compatibility export for call sites that have not yet adopted the shared
 * damage-impact name. New code should use DamageImpact3D. */
export { DamageImpact3D as BeamImpact3D };
