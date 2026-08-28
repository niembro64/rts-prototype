// DamageImpact3D — bounded, consolidated presentation for damage endpoints.
//
// Live rays and one-shot projectile detonations feed the same world-cell sites
// instead of spawning expanding fire spheres. Small ejecta are born into a
// fixed ring buffer and integrate entirely in the vertex shader from birth
// time, so no particle is walked or rewritten as it ages.

import * as THREE from 'three';
import { HEAT_RAMP_GLSL } from '@/heatRampPalette';
import type { Entity } from '../sim/types';
import { isRayType } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { RenderViewState3D } from './RenderFrameState3D';
import { disposeMesh } from './threeUtils';
import {
  applyExposureToRawShader,
  configureSelfLitEffectMaterial,
} from './RenderLighting3D';
import { DamageBurnVolume3D } from './BeamBurnVolume3D';
import {
  createPrimitiveTetrahedronGeometry,
} from './PrimitiveGeometryQuality3D';
import {
  DETAIL_LEVEL_FULL,
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_MID,
  detailRungForLevel,
} from './EntityDetailLevel3D';
import {
  clearDirtySlotSpan,
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
  uploadPrefixRange,
} from './instancedBufferUpdate';
import {
  TETRAHEDRON_PARTICLE_LARGE,
  TETRAHEDRON_PARTICLE_MEDIUM,
  TETRAHEDRON_PARTICLE_SMALL,
  TETRAHEDRON_PARTICLE_SPEED_SCALE,
  tetrahedronParticleRadius,
  tetrahedronParticleSpeedVariation,
  type TetrahedronParticleSizeClass,
  writeTetrahedronParticleSpin,
} from '@/tetrahedronParticleProfile';

export type DamageImpactSurface =
  | 'terrain'
  | 'water'
  | 'entity'
  | 'endpoint'
  | 'blast';
type BeamImpactSurface = DamageImpactSurface;

export type DamageImpactEnvironment = {
  getTerrainZ(x: number, y: number): number;
  getTerrainNormal?(x: number, y: number): { nx: number; ny: number; nz: number };
  isWaterAt?(x: number, y: number): boolean;
  waterLevel: number;
  depositGroundBurn?(x: number, y: number, width: number, energy: number): void;
};

export type DamageImpactRequest = {
  x: number;
  y: number;
  z: number;
  /** Exact authoritative damage/splash sphere radius. */
  damageRadius: number;
  /** Damage the detonation deals (blueprint truth). Damage and radius jointly
   *  drive one-shot chunk count and speed; when damage is absent those
   *  presentation values use radius alone. They never change chunk size. */
  damage?: number;
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
  /** Shared screen-coverage detail level at the detonation point. Explosion
   *  chunks resolve this to an exact HIGH/MED/LOW collapse pattern. */
  detailLevel?: number;
  /** Thermal deposit strength; derived from radius when omitted. */
  energy?: number;
  /** Stable provenance used only to vary the consolidated site's shape. */
  seedSource?: number;
};

const IMPACT_CELL_SIZE = 4;
const IMPACT_SITE_CAP = 2048;
const IMPACT_SITE_TAIL_SEC = 0.45;
const EJECTA_CAP = 8192;
const MAX_EJECTA_BIRTHS_PER_UPDATE = 312;
const MAX_EJECTA_BIRTHS_PER_SECOND = 2600;
const MAX_QUEUED_DAMAGE_IMPACTS = 512;
const TERRAIN_ENDPOINT_TOLERANCE = 4;
const SMALL_EXPLOSION_DAMAGE_CEILING = 200;
const LARGE_EXPLOSION_RADIUS_THRESHOLD = 40;
const LARGE_EXPLOSION_RADIUS_GROUP_INTERVAL = 18;
const MAX_DAMAGE_IMPACT_FLASH_RADIUS = 240;
const MAX_BEAM_ENDPOINT_FLASH_RADIUS = 160;
const EXPLOSION_SPEED_REFERENCE_RADIUS = 40;
const EXPLOSION_SPEED_MIN_RADIUS = 8;
const EXPLOSION_SPEED_MAX_RADIUS = 200;
const EXPLOSION_SPEED_REFERENCE_DAMAGE = 60;
const EXPLOSION_SPEED_DAMAGE_LOG_GAIN = 0.12;
const EXPLOSION_SPEED_MAX_DAMAGE_BOOST = 0.75;
const EJECTA_REFERENCE_SPEED = 68;
const WATER_EJECTA_REFERENCE_SPEED = 16;
type ExplosionChunkSpec = Readonly<{
  /** Fixed geometry and motion band: small-fast (0), medium (1), large-slow (2). */
  sizeClass: TetrahedronParticleSizeClass;
}>;

const SMALL_FAST = TETRAHEDRON_PARTICLE_SMALL;
const MEDIUM = TETRAHEDRON_PARTICLE_MEDIUM;
const LARGE_SLOW = TETRAHEDRON_PARTICLE_LARGE;

/** One complete explosion group at HIGH: one large-slow, three medium, and
 *  nine small-fast chunks. The first three entries are the same fixed-size
 *  representatives used by every rung. */
const EXPLOSION_PATTERN_HIGH: readonly ExplosionChunkSpec[] = Object.freeze([
  { sizeClass: LARGE_SLOW },
  { sizeClass: MEDIUM },
  { sizeClass: SMALL_FAST },
  { sizeClass: MEDIUM },
  { sizeClass: MEDIUM },
  { sizeClass: SMALL_FAST },
  { sizeClass: SMALL_FAST },
  { sizeClass: SMALL_FAST },
  { sizeClass: SMALL_FAST },
  { sizeClass: SMALL_FAST },
  { sizeClass: SMALL_FAST },
  { sizeClass: SMALL_FAST },
  { sizeClass: SMALL_FAST },
]);

/** MEDIUM keeps one of every three small chunks without promoting its size. */
const EXPLOSION_PATTERN_MEDIUM: readonly ExplosionChunkSpec[] = Object.freeze([
  { sizeClass: LARGE_SLOW },
  { sizeClass: MEDIUM },
  { sizeClass: SMALL_FAST },
  { sizeClass: MEDIUM },
  { sizeClass: MEDIUM },
  { sizeClass: SMALL_FAST },
  { sizeClass: SMALL_FAST },
]);

/** LOW keeps one fixed-size representative from each of the three bands. */
const EXPLOSION_PATTERN_LOW: readonly ExplosionChunkSpec[] = Object.freeze([
  { sizeClass: LARGE_SLOW },
  { sizeClass: MEDIUM },
  { sizeClass: SMALL_FAST },
]);

const MAX_EXPLOSION_BASE_GROUPS = Math.floor(
  MAX_EJECTA_BIRTHS_PER_UPDATE / EXPLOSION_PATTERN_HIGH.length,
);

/** Exact explosion chunk pattern for one base magnitude group at a visual LOD
 *  rung. MIN/GLYPH retains the LOW three-representative pattern: minimum
 *  entity geometry must never make a gameplay explosion disappear. */
export function explosionChunkPatternForDetail(
  detailLevel: number,
): readonly ExplosionChunkSpec[] {
  switch (detailRungForLevel(detailLevel)) {
    case DETAIL_RUNG_CLOSE: return EXPLOSION_PATTERN_HIGH;
    case DETAIL_RUNG_MID: return EXPLOSION_PATTERN_MEDIUM;
    case DETAIL_RUNG_FAR: return EXPLOSION_PATTERN_LOW;
    default: return EXPLOSION_PATTERN_LOW;
  }
}

/** Converts authored explosion strength into N complete 1:3:9 groups. The
 *  small-damage curve is intentionally unchanged through 200 damage. Above
 *  that baseline, damage adds groups logarithmically while radius adds groups
 *  linearly, so either a powerful compact charge or a physically broad blast
 *  reads larger and the two authored dimensions reinforce one another. */
export function explosionBaseChunkGroupCount(
  damageRadius: number,
  damage?: number,
): number {
  const finiteDamageRadius = Number.isFinite(damageRadius)
    ? Math.max(0, damageRadius)
    : 0;
  const finiteDamage = damage !== undefined && Number.isFinite(damage) && damage > 0
    ? damage
    : undefined;
  const smallMagnitudeChunkBudget = finiteDamage !== undefined
    ? 4 + Math.min(finiteDamage, SMALL_EXPLOSION_DAMAGE_CEILING) * 0.15
    : 5 + Math.sqrt(finiteDamageRadius) * 2.4;
  const smallMagnitudeGroups = Math.max(
    1,
    Math.floor(smallMagnitudeChunkBudget / EXPLOSION_PATTERN_HIGH.length),
  );
  const largeDamageGroups = finiteDamage !== undefined
    ? Math.floor(Math.max(
      0,
      Math.log2(finiteDamage / SMALL_EXPLOSION_DAMAGE_CEILING) * 2,
    ))
    : 0;
  const largeRadiusGroups = Math.floor(
    Math.max(0, finiteDamageRadius - LARGE_EXPLOSION_RADIUS_THRESHOLD) /
      LARGE_EXPLOSION_RADIUS_GROUP_INTERVAL,
  );
  return Math.min(
    MAX_EXPLOSION_BASE_GROUPS,
    smallMagnitudeGroups + largeDamageGroups + largeRadiusGroups,
  );
}

/** Radius of a one-shot impact flash. Small flashes are deliberately more
 *  visible than before; complete magnitude groups then add a bounded boost so
 *  high-damage compact blasts still distinguish themselves from pinpricks. */
export function explosionFlashRadius(
  damageRadius: number,
  damage?: number,
): number {
  const finiteDamageRadius = Number.isFinite(damageRadius)
    ? Math.max(0, damageRadius)
    : 0;
  const groupCount = explosionBaseChunkGroupCount(finiteDamageRadius, damage);
  const magnitudeScale = 1 + Math.min(0.35, Math.max(0, groupCount - 1) * 0.025);
  return Math.min(
    MAX_DAMAGE_IMPACT_FLASH_RADIUS,
    Math.max(2.5, finiteDamageRadius * 0.72 * magnitudeScale),
  );
}

/** Beam endpoints do not carry one-shot damage, so their persistent flash is
 *  sized from both the visible line and its real damage sphere. */
export function beamEndpointFlashRadius(
  lineRadius: number,
  damageSphereRadius: number,
): number {
  const finiteLineRadius = Number.isFinite(lineRadius) ? Math.max(0, lineRadius) : 0;
  const finiteDamageRadius = Number.isFinite(damageSphereRadius)
    ? Math.max(0, damageSphereRadius)
    : 0;
  return Math.min(
    MAX_BEAM_ENDPOINT_FLASH_RADIUS,
    Math.max(3, finiteLineRadius * 2.4, finiteDamageRadius * 0.72),
  );
}

/** Explosion size and power increase ejection speed without touching chunk
 *  geometry or lifetime. Radius supplies the physical scale; damage adds a
 *  bounded logarithmic boost above the ordinary 60-damage reference shot. */
export function explosionChunkMagnitudeSpeedScale(
  damageRadius: number,
  damage?: number,
): number {
  const finiteRadius = Number.isFinite(damageRadius)
    ? Math.max(EXPLOSION_SPEED_MIN_RADIUS, Math.min(EXPLOSION_SPEED_MAX_RADIUS, damageRadius))
    : EXPLOSION_SPEED_MIN_RADIUS;
  const finiteDamage = damage !== undefined && Number.isFinite(damage) && damage > 0
    ? damage
    : undefined;
  const damageBoost = finiteDamage === undefined
    ? 0
    : Math.min(
        EXPLOSION_SPEED_MAX_DAMAGE_BOOST,
        Math.max(
          0,
          Math.log2(finiteDamage / EXPLOSION_SPEED_REFERENCE_DAMAGE) *
            EXPLOSION_SPEED_DAMAGE_LOG_GAIN,
        ),
      );
  return (finiteRadius / EXPLOSION_SPEED_REFERENCE_RADIUS) * (1 + damageBoost);
}
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
    gl_PointSize = clamp(projectedDiameter * (0.82 + 0.18 * aHeat), 2.0, 384.0);
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
  attribute vec4 aSpin;
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
    // One random spin is authored at birth. Rodrigues' formula advances that
    // fixed axis at its fixed signed angular velocity for the whole lifetime.
    float spinAngle = age * aSpin.w;
    float c = cos(spinAngle);
    float s = sin(spinAngle);
    vec3 spinAxis = normalize(aSpin.xyz);
    vec3 local = position * c
      + cross(spinAxis, position) * s
      + spinAxis * dot(spinAxis, position) * (1.0 - c);
    vec4 worldPosition = instanceMatrix * vec4(local, 1.0);
    worldPosition.xyz += aMotion.xyz * age;
    worldPosition.y += 0.5 * aMotion.w * age * age;
    vec4 mv = modelViewMatrix * worldPosition;
    gl_Position = projectionMatrix * mv;
    if (age < 0.0 || age > life) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

/** Every hot tetrahedron (terrain, entity, beam endpoint, death blast) fades
 *  through the shared plasma heat ramp — white, yellow, red, dark red — over
 *  its lifetime; only water ejecta keeps its liquid palette. */
export const DAMAGE_IMPACT_PARTICLE_FRAGMENT_SHADER = /* glsl */`
  varying float vAge01;
  varying float vKind;
  varying float vSeed;

  ${HEAT_RAMP_GLSL}

  void main() {
    if (vAge01 < 0.0 || vAge01 > 1.0) discard;
    float fadeIn = smoothstep(0.0, 0.08, vAge01);
    float fadeOut = 1.0 - smoothstep(0.56, 1.0, vAge01);
    float fade = fadeIn * fadeOut;
    vec3 waterColor = mix(vec3(0.82, 0.96, 1.0), vec3(0.34, 0.48, 0.54), vAge01);
    bool isWater = vKind > 0.5 && vKind < 1.5;
    vec3 color = isWater ? waterColor : heatRamp(vAge01);
    float alpha = fade * (isWater ? 0.48 : 0.92);
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

export function beamImpactCellKey(
  kind: DamageImpactSurface,
  x: number,
  y: number,
  z: number,
  cellSize: number = IMPACT_CELL_SIZE,
): ImpactSiteKey {
  return packedCellKey3D(kindNumber(kind), x, y, z, cellSize);
}


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

  private readonly particleMotion = new Float32Array(EJECTA_CAP * 4);
  private readonly particleSpin = new Float32Array(EJECTA_CAP * 4);
  private readonly particleBirthLifeKindSeed = new Float32Array(EJECTA_CAP * 4);
  private readonly particleGeometry = createPrimitiveTetrahedronGeometry(1);
  private readonly particleMaterial: THREE.ShaderMaterial;
  private readonly particleMesh: THREE.InstancedMesh;
  private readonly particleMotionAttr: THREE.InstancedBufferAttribute;
  private readonly particleSpinAttr: THREE.InstancedBufferAttribute;
  private readonly particleBirthAttr: THREE.InstancedBufferAttribute;
  private readonly particleMatrixDirty = createDirtySlotSpan();
  private readonly particleMotionDirty = createDirtySlotSpan();
  private readonly particleSpinDirty = createDirtySlotSpan();
  private readonly particleBirthDirty = createDirtySlotSpan();
  private readonly particlePosition = new THREE.Vector3();
  private readonly particleScale = new THREE.Vector3();
  private readonly particleQuaternion = new THREE.Quaternion();
  private readonly particleEuler = new THREE.Euler();
  private readonly particleMatrix = new THREE.Matrix4();
  private readonly particleSpinAxis = { x: 0, y: 1, z: 0 };
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

    this.particleMotionAttr = new THREE.InstancedBufferAttribute(this.particleMotion, 4)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleSpinAttr = new THREE.InstancedBufferAttribute(this.particleSpin, 4)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleBirthAttr = new THREE.InstancedBufferAttribute(this.particleBirthLifeKindSeed, 4)
      .setUsage(THREE.DynamicDrawUsage);
    this.particleGeometry.setAttribute('aMotion', this.particleMotionAttr);
    this.particleGeometry.setAttribute('aSpin', this.particleSpinAttr);
    this.particleGeometry.setAttribute('aBirthLifeKindSeed', this.particleBirthAttr);
    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: DAMAGE_IMPACT_PARTICLE_FRAGMENT_SHADER,
      uniforms: {
        uTimeSec: { value: 0 },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    configureSelfLitEffectMaterial(this.particleMaterial);
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
        beamEndpointFlashRadius(
          visual.lineRadius,
          visual.lineDamageSphereRadius,
        ),
        visual.lineDamageSphereRadius,
      );
      const shot = projectile.config.shot;
      const dps = shot.type === 'beam'
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
      const requestedGroups = explosionBaseChunkGroupCount(
        damageRadius,
        impact.damage,
      );
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
        explosionFlashRadius(damageRadius, impact.damage),
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

      const chunkPattern = explosionChunkPatternForDetail(
        impact.detailLevel ?? DETAIL_LEVEL_FULL,
      );
      // Damage and physical radius reinforce one another in count and speed.
      // The fixed three chunk sizes and their fade lifetime never scale with
      // explosion magnitude.
      const magnitudeSpeedScale = explosionChunkMagnitudeSpeedScale(
        damageRadius,
        impact.damage,
      );
      const availableBirths = Math.max(
        0,
        MAX_EJECTA_BIRTHS_PER_UPDATE - this.particleBirthsThisUpdate,
      );
      const birthGroups = chunkPattern.length > 0
        ? Math.min(requestedGroups, Math.floor(availableBirths / chunkPattern.length))
        : 0;
      const birthCount = birthGroups * chunkPattern.length;
      for (let group = 0; group < birthGroups; group++) {
        for (let chunk = 0; chunk < chunkPattern.length; chunk++) {
          const spec = chunkPattern[chunk];
          this.spawnParticle(
            site,
            spec.sizeClass,
            magnitudeSpeedScale,
          );
        }
      }
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
      uploadDirtySlotSpan(this.particleSpinAttr, this.particleSpinDirty, 4);
      uploadDirtySlotSpan(this.particleBirthAttr, this.particleBirthDirty, 4);
    }
  }

  private spawnParticle(
    site: ImpactSite,
    authoredSizeClass?: TetrahedronParticleSizeClass,
    magnitudeSpeedScale: number = explosionChunkMagnitudeSpeedScale(site.damageRadius),
  ): void {
    const slot = this.particleCursor;
    this.particleCursor = (this.particleCursor + 1) % EJECTA_CAP;
    this.particleHighWater = Math.max(this.particleHighWater, slot + 1);
    const serial = this.spawnSerial++;
    const r0 = hash01(serial, 11);
    const r1 = hash01(serial, 29);
    const r2 = hash01(serial, 47);
    const r3 = hash01(serial, 71);
    const sizeRoll = hash01(serial, 97);
    const spinAzimuth = hash01(serial, 113);
    const spinVertical = hash01(serial, 131);
    const spinSpeed = hash01(serial, 151);
    const spinDirection = hash01(serial, 173);
    const randomClass: TetrahedronParticleSizeClass = sizeRoll < 0.48
      ? SMALL_FAST
      : sizeRoll < 0.83
        ? MEDIUM
        : LARGE_SLOW;
    const sizeClass = authoredSizeClass ?? randomClass;
    const speedScale = TETRAHEDRON_PARTICLE_SPEED_SCALE[sizeClass];
    // A narrow shared variation preserves texture without allowing a large
    // chunk to outrun a medium one or a medium chunk to outrun a small one.
    const speedVariation = tetrahedronParticleSpeedVariation(r3);
    const baseSpeed = (site.kind === 'water'
      ? WATER_EJECTA_REFERENCE_SPEED
      : EJECTA_REFERENCE_SPEED) * speedVariation * magnitudeSpeedScale;
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
    const angularSpeed = writeTetrahedronParticleSpin(
      this.particleSpinAxis,
      spinAzimuth,
      spinVertical,
      spinSpeed,
      spinDirection,
    );
    this.particleSpin[m] = this.particleSpinAxis.x;
    this.particleSpin[m + 1] = this.particleSpinAxis.y;
    this.particleSpin[m + 2] = this.particleSpinAxis.z;
    this.particleSpin[m + 3] = angularSpeed;
    this.particleBirthLifeKindSeed[m] = this.timeSec;
    const baseLifetime = site.kind === 'water'
      ? 0.75 + r1 * 0.6
      : 0.48 + r1 * 0.5;
    this.particleBirthLifeKindSeed[m + 1] = baseLifetime;
    this.particleBirthLifeKindSeed[m + 2] = kindNumber(site.kind);
    this.particleBirthLifeKindSeed[m + 3] = r2;
    const chunkSize = tetrahedronParticleRadius(sizeClass);
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
    this.particleScale.setScalar(chunkSize);
    this.particleMatrix.compose(
      this.particlePosition,
      this.particleQuaternion,
      this.particleScale,
    );
    this.particleMesh.setMatrixAt(slot, this.particleMatrix);
    markDirtySlot(this.particleMatrixDirty, slot);
    markDirtySlot(this.particleMotionDirty, slot);
    markDirtySlot(this.particleSpinDirty, slot);
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
    clearDirtySlotSpan(this.particleSpinDirty);
    clearDirtySlotSpan(this.particleBirthDirty);
    this.burnVolume.destroy();
    disposeMesh(this.sitePoints);
    disposeMesh(this.particleMesh);
    this.root.parent?.remove(this.root);
  }
}
