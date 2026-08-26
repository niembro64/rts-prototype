import * as THREE from 'three';
import { getVolumeToggle } from '@/clientBarConfig';
import {
  createEntityVolume,
  writeExplosionVolume,
  writeHitVolume,
  type EntityVolume,
} from '../sim/entityVolumes';
import { COLORS } from '@/colorsConfig';
import type { Entity, EntityId } from '../sim/types';
import { getPlayerColors } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import { IndexedEntityIdMap } from '../network/IndexedEntityIdCollections';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { RenderFrameState3D } from './RenderFrameState3D';
import {
  detachObject,
  disposeGeometries,
  disposeMaterials,
  disposeMesh,
} from './threeUtils';
import {
  setObjectVisibleIfChanged,
  setScaleScalarIfChanged,
  setVector3IfChanged,
} from './threeTransformWriteUtils';
import {
  createExtrudedEquilateralTriangleGeometry,
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';
import { entityDetailLevelForView } from './EntityLod3D';
import {
  DETAIL_RUNG_CLOSE,
  DETAIL_RUNG_FAR,
  DETAIL_RUNG_MID,
  detailLevelForRung,
  detailRungForLevel,
  type DetailRung,
  projectileStyleForDetail,
} from './EntityDetailLevel3D';
import { PlasmaArcPoseBatch3D, ProjectileAxisPoseBatch3D } from './ProjectileAxisPoseBatch3D';
import { isPresentationAnimationPaused } from './presentationClock';
import {
  TRAIL_HIGH_CURVE_SEGMENTS,
  createTrailResampleScratch,
  createTrailStampBuffer,
  insertTrailStamp,
  resampleTrailCenterline,
  stampTrailHeadIfMoved,
  type TrailStampBuffer,
} from './ProjectileTrailHistory3D';
import { configureSelfLitEffectMaterial } from './RenderLighting3D';
import {
  PLASMA_IMPACT_COLLAPSE_DURATION_MS,
  plasmaImpactCollapseTailLength,
} from './PlasmaImpactCollapse3D';

const PROJECTILE_MIN_RADIUS = 0.5;
// 1 revolution per second.
const ROCKET_FIN_ROLL_RATE_RAD_PER_MS = (Math.PI * 2) / 2000;
// Multiples of the rocket body radius — how far the fin rear edge sits
// past the cylinder tail end. Avoids color z-fight at the tail cap.
const FIN_REAR_OVERHANG_MULT = 0.75;
// Medium/Low drop the authored fin blades and read team identity off the
// rocket's own tail instead: this rear fraction of the body is drawn as its
// own segment in the fin color.
const PROJECTILE_TAIL_BAND_FRACTION = 0.2;
const PROJECTILE_INSTANCED_CAP = 8192;
const PROJECTILE_ROCKET_FIN_COUNT = 3;
// The deepest plasma tail sets the trail history's stamp spacing, so the
// two constants are the same number by construction rather than by luck.
const PLASMA_HIGH_CURVE_SEGMENTS = TRAIL_HIGH_CURVE_SEGMENTS;
const PLASMA_HIGH_RADIAL_SEGMENTS = 10;
const PLASMA_MEDIUM_CURVE_SEGMENTS = 3;
const PLASMA_MEDIUM_RADIAL_SEGMENTS = 6;
const TRAIL_MIN_TANGENT_SQ = 1e-6;
const PROJ_CYL_AXIS = new THREE.Vector3(0, 1, 0);

type PlasmaGeometrySpec = {
  readonly curveSegments: number;
  readonly radialSegments: number;
  readonly ringCount: number;
  readonly verticesPerShot: number;
  readonly indicesPerShot: number;
  readonly cos: readonly number[];
  readonly sin: readonly number[];
};

function createPlasmaGeometrySpec(
  curveSegments: number,
  radialSegments: number,
): PlasmaGeometrySpec {
  const cos = new Array<number>(radialSegments);
  const sin = new Array<number>(radialSegments);
  for (let i = 0; i < radialSegments; i++) {
    const angle = (i / radialSegments) * Math.PI * 2;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  // Rounded shoulder + head ring + one ring per interior tail bend.
  // Single shared vertices close the nose and tail without hidden caps.
  const ringCount = curveSegments + 1;
  return {
    curveSegments,
    radialSegments,
    ringCount,
    verticesPerShot: 2 + ringCount * radialSegments,
    indicesPerShot: radialSegments * 6 * (curveSegments + 1),
    cos,
    sin,
  };
}

/** Tip-to-tail heat ramp for plasma shots — the same palette the blast
 *  tetrahedra fade through (see BeamImpact3D's blast colors): white-hot
 *  at the ball tip, through yellow and red, to a dark-red ember tail. */
function writePlasmaHeatRampColor(
  colors: Float32Array,
  vertex: number,
  axial01: number,
): void {
  let r: number;
  let g: number;
  let b: number;
  if (axial01 <= 0.22) {
    const t = axial01 / 0.22;
    r = 1;
    g = 1 + (0.82 - 1) * t;
    b = 1 + (0.06 - 1) * t;
  } else if (axial01 <= 0.58) {
    const t = (axial01 - 0.22) / 0.36;
    r = 1;
    g = 0.82 + (0.2 - 0.82) * t;
    b = 0.06 + (0.008 - 0.06) * t;
  } else {
    const t = (axial01 - 0.58) / 0.42;
    r = 1 + (0.11 - 1) * t;
    g = 0.2 + (0.025 - 0.2) * t;
    b = 0.008;
  }
  const out = vertex * 3;
  colors[out] = r;
  colors[out + 1] = g;
  colors[out + 2] = b;
}

const PLASMA_HIGH_SPEC = createPlasmaGeometrySpec(
  PLASMA_HIGH_CURVE_SEGMENTS,
  PLASMA_HIGH_RADIAL_SEGMENTS,
);
const PLASMA_MEDIUM_SPEC = createPlasmaGeometrySpec(
  PLASMA_MEDIUM_CURVE_SEGMENTS,
  PLASMA_MEDIUM_RADIAL_SEGMENTS,
);
const PLASMA_LOW_INDICES = [
  0, 2, 1,
  0, 1, 3,
  1, 2, 3,
  2, 0, 3,
] as const;

/** Actual submitted triangle count for one plasma projectile at each rung. */
export const PLASMA_PROJECTILE_TRIANGLE_COUNTS = Object.freeze({
  high: PLASMA_HIGH_SPEC.indicesPerShot / 3,
  medium: PLASMA_MEDIUM_SPEC.indicesPerShot / 3,
  low: PLASMA_LOW_INDICES.length / 3,
});

/** Rocket/missile/torpedo body + tube + all three authored fins at High;
 *  body + split tube (forward run + team-colored tail band) below it. Both
 *  band segments reuse their rung's own tube geometry, so the band costs
 *  exactly one more tube instead of a fourth authored shape. */
export const ROCKET_PROJECTILE_TRIANGLE_COUNTS = Object.freeze({
  high: 80 + 32 + 24,
  medium: 36 + 24 + 24,
  low: 8 + 8,
});

/** Plasma is a self-luminous gameplay cue. It keeps its authored heat-ramp
 *  colors even when the CLIENT exposure control is deliberately low. */
export function createPlasmaProjectileMaterial(): THREE.MeshBasicMaterial {
  return configureSelfLitEffectMaterial(new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    side: THREE.DoubleSide,
  }));
}

/** Low rocket/missile/torpedo tube: the same capped, equilateral triangular
 *  prism used by other Low cylinder replacements. Local +Y remains the
 *  projectile axis, so every existing flight pose applies unchanged. */
export function createLowResolutionRocketGeometry(): THREE.BufferGeometry {
  return createExtrudedEquilateralTriangleGeometry(1, 1);
}

/** Geometry-independent projectile pose shared by every visual tier. */
export function composeProjectileTailPose3D(
  pose: Float32Array,
  poseOffset: number,
  x: number, y: number, z: number,
  length: number,
  radius: number,
  outDirection: THREE.Vector3,
  outPosition: THREE.Vector3,
  outQuaternion: THREE.Quaternion,
  outScale: THREE.Vector3,
): void {
  outDirection.set(
    pose[poseOffset],
    pose[poseOffset + 1],
    pose[poseOffset + 2],
  );
  outQuaternion.set(
    pose[poseOffset + 3],
    pose[poseOffset + 4],
    pose[poseOffset + 5],
    pose[poseOffset + 6],
  );
  outPosition.set(
    x + outDirection.x * length * 0.5,
    z + outDirection.y * length * 0.5,
    y + outDirection.z * length * 0.5,
  );
  outScale.set(radius, length, radius);
}

function writeTranslateScaleMatrix(
  out: Float32Array,
  slot: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const o = slot * 16;
  out[o] = sx; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = sy; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = 0; out[o + 9] = 0; out[o + 10] = sz; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}

function writeComposedMatrix(
  out: Float32Array,
  slot: number,
  x: number,
  y: number,
  z: number,
  quat: THREE.Quaternion,
  sx: number,
  sy: number,
  sz: number,
): void {
  const qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const o = slot * 16;

  out[o] = (1 - (yy + zz)) * sx;
  out[o + 1] = (xy + wz) * sx;
  out[o + 2] = (xz - wy) * sx;
  out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy;
  out[o + 5] = (1 - (xx + zz)) * sy;
  out[o + 6] = (yz + wx) * sy;
  out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz;
  out[o + 9] = (yz - wx) * sz;
  out[o + 10] = (1 - (xx + yy)) * sz;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}

/** A shot's share of the unified VOLUMES group: its HIT sphere (what
 *  collision resolution tests) and its EXP sphere (what it detonates
 *  with). Same two buttons that draw host hit/explosion volumes. */
type ProjectileRadiusMeshes = {
  hit?: THREE.LineSegments;
  explosion?: THREE.LineSegments;
};

type DynamicPlasmaGeometry = {
  spec: PlasmaGeometrySpec;
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  positionAttr: THREE.BufferAttribute;
};

type PlasmaImpactCollapseState = {
  elapsedMs: number;
  headX: number;
  headY: number;
  headZ: number;
};

type PlasmaTrailRenderState = {
  stamps: TrailStampBuffer;
  radius: number;
  tailRadius: number;
  tailLength: number;
  rung: DetailRung;
  directionX: number;
  directionY: number;
  directionZ: number;
  lastHeadX: number;
  lastHeadY: number;
  lastHeadZ: number;
  collapse: PlasmaImpactCollapseState | null;
};

type ProjectileRenderer3DOptions = {
  world: THREE.Group;
  clientViewState: ClientViewState;
  scope: ViewportFootprint;
  radiusSphereGeom: THREE.BufferGeometry;
  isEntityEmissionFarLod?: (entity: Entity) => boolean;
  /** The shared host/projectile AUTO resolver. It gives every entity the
   * exact HIGH/MED/LOW rung selected for this frame. */
  entityDetailRung?: (entity: Entity) => DetailRung | undefined;
};

const NEVER_EMISSION_FAR_LOD = (): boolean => false;

export class ProjectileRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  /** Wall-clock value held for the duration of a presentation pause. */
  private pausedRenderNowMs: number | null = null;
  private readonly scope: ViewportFootprint;
  private readonly radiusSphereGeom: THREE.BufferGeometry;
  private readonly isEntityEmissionFarLod: (entity: Entity) => boolean;
  private readonly entityDetailRung: (entity: Entity) => DetailRung | undefined;

  private readonly projectileGeom = createPrimitiveSphereGeometry('projectile', 'close');
  private readonly projectileCylinderGeom = createPrimitiveCylinderGeometry('projectile', 'close');
  private readonly projectileFinGeom = createProjectileFinGeometry();
  private readonly projectileMediumGeom = createPrimitiveSphereGeometry('projectile', 'mid');
  private readonly projectileMediumCylinderGeom = createPrimitiveCylinderGeometry('projectile', 'mid');
  private readonly projectileMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.projectile.body.colorHex,
  });
  // Plasma stays exactly white under every terrain/sun light: the body and
  // tail are one unlit surface instead of two differently shaded meshes.
  // Vertex colors carry the white-tip -> ember-tail heat ramp; the base
  // color multiplies it, so it must stay pure white for the ramp to read
  // exactly (see writePlasmaHeatRampColor).
  private readonly plasmaMat = createPlasmaProjectileMaterial();
  private readonly projectileFinMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.projectile.fin.colorHex,
    side: THREE.DoubleSide,
  });
  private readonly projMatCollision = configureSelfLitEffectMaterial(new THREE.LineBasicMaterial({
    color: COLORS.effects.projectile.collisionRadius.colorHex,
    transparent: true,
    opacity: COLORS.effects.projectile.collisionRadius.opacity,
    depthWrite: false,
  }));
  private readonly projMatExplosion = configureSelfLitEffectMaterial(new THREE.LineBasicMaterial({
    color: COLORS.effects.projectile.explosionRadius.colorHex,
    transparent: true,
    opacity: COLORS.effects.projectile.explosionRadius.opacity,
    depthWrite: false,
  }));

  private readonly sphereInstanced: THREE.InstancedMesh;
  private readonly sphereMatrices: Float32Array;
  private readonly cylinderInstanced: THREE.InstancedMesh;
  private readonly cylinderMatrices: Float32Array;
  private readonly mediumSphereInstanced: THREE.InstancedMesh;
  private readonly mediumSphereMatrices: Float32Array;
  private readonly mediumCylinderInstanced: THREE.InstancedMesh;
  private readonly mediumCylinderMatrices: Float32Array;
  private readonly plasmaHigh: DynamicPlasmaGeometry;
  private readonly plasmaHighMesh: THREE.Mesh;
  private readonly plasmaMedium: DynamicPlasmaGeometry;
  private readonly plasmaMediumMesh: THREE.Mesh;
  private readonly plasmaLowGeom = createLowResolutionPlasmaGeometry();
  private readonly plasmaLowInstanced: THREE.InstancedMesh;
  private readonly plasmaLowMatrices: Float32Array;
  private readonly rocketLowGeom = createLowResolutionRocketGeometry();
  private readonly rocketLowInstanced: THREE.InstancedMesh;
  private readonly rocketLowMatrices: Float32Array;
  private readonly finInstanced: THREE.InstancedMesh;
  private readonly finMatrices: Float32Array;
  private readonly finColors = new Float32Array(PROJECTILE_INSTANCED_CAP * 3);
  private readonly finColorAttr = new THREE.InstancedBufferAttribute(this.finColors, 3);
  private readonly mediumTailBandInstanced: THREE.InstancedMesh;
  private readonly mediumTailBandMatrices: Float32Array;
  private readonly mediumTailBandColors = new Float32Array(PROJECTILE_INSTANCED_CAP * 3);
  private readonly mediumTailBandColorAttr = new THREE.InstancedBufferAttribute(
    this.mediumTailBandColors,
    3,
  );
  private readonly lowTailBandInstanced: THREE.InstancedMesh;
  private readonly lowTailBandMatrices: Float32Array;
  private readonly lowTailBandColors = new Float32Array(PROJECTILE_INSTANCED_CAP * 3);
  private readonly lowTailBandColorAttr = new THREE.InstancedBufferAttribute(
    this.lowTailBandColors,
    3,
  );
  private readonly seenProjectileIds = new Set<number>();
  private readonly projectileRadiusMeshes = new Map<number, ProjectileRadiusMeshes>();
  /** Scratch volume reused by the per-shot HIT/EXP wireframe writers. */
  private readonly projVolume = createEntityVolume();
  private readonly projectileRadiusMeshPool: THREE.LineSegments[] = [];
  private readonly plasmaTrailStates = new IndexedEntityIdMap<PlasmaTrailRenderState>();
  private readonly projectileAxisPose = new ProjectileAxisPoseBatch3D();
  private readonly plasmaArcPose = new PlasmaArcPoseBatch3D();
  // One resample working set reused across every projectile in a frame,
  // sized for the deepest rung any of them can select.
  private readonly trailScratch = createTrailResampleScratch(PLASMA_HIGH_CURVE_SEGMENTS);
  private lastProjectileEntitySetVersion = -1;
  private lastProjectileScopeVersion = -1;

  private readonly projDir = new THREE.Vector3();
  private readonly projQuat = new THREE.Quaternion();
  private readonly projPos = new THREE.Vector3();
  private readonly projScale = new THREE.Vector3();
  private readonly curveTangent = new THREE.Vector3();
  private readonly curveRight = new THREE.Vector3();
  private readonly curveUp = new THREE.Vector3();
  private readonly curveReference = new THREE.Vector3();
  private readonly finRollQuat = new THREE.Quaternion();
  private readonly finQuat = new THREE.Quaternion();
  private readonly finColor = new THREE.Color();
  private finColorDirtyMin = Number.POSITIVE_INFINITY;
  private finColorDirtyMax = -1;
  private plasmaHighCount = 0;
  private plasmaMediumCount = 0;
  private plasmaLowCount = 0;

  constructor(options: ProjectileRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.scope = options.scope;
    this.radiusSphereGeom = options.radiusSphereGeom;
    this.isEntityEmissionFarLod =
      options.isEntityEmissionFarLod ?? NEVER_EMISSION_FAR_LOD;
    this.entityDetailRung = options.entityDetailRung ?? (() => undefined);

    this.sphereInstanced = new THREE.InstancedMesh(
      this.projectileGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.sphereInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sphereMatrices = this.sphereInstanced.instanceMatrix.array as Float32Array;
    this.sphereInstanced.frustumCulled = false;
    this.sphereInstanced.count = 0;
    this.world.add(this.sphereInstanced);

    this.cylinderInstanced = new THREE.InstancedMesh(
      this.projectileCylinderGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.cylinderInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cylinderMatrices = this.cylinderInstanced.instanceMatrix.array as Float32Array;
    this.cylinderInstanced.frustumCulled = false;
    this.cylinderInstanced.count = 0;
    this.world.add(this.cylinderInstanced);

    this.mediumSphereInstanced = new THREE.InstancedMesh(
      this.projectileMediumGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.mediumSphereInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mediumSphereMatrices = this.mediumSphereInstanced.instanceMatrix.array as Float32Array;
    this.mediumSphereInstanced.frustumCulled = false;
    this.mediumSphereInstanced.count = 0;
    this.world.add(this.mediumSphereInstanced);

    this.mediumCylinderInstanced = new THREE.InstancedMesh(
      this.projectileMediumCylinderGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.mediumCylinderInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mediumCylinderMatrices = this.mediumCylinderInstanced.instanceMatrix.array as Float32Array;
    this.mediumCylinderInstanced.frustumCulled = false;
    this.mediumCylinderInstanced.count = 0;
    this.world.add(this.mediumCylinderInstanced);

    this.plasmaHigh = createDynamicPlasmaGeometry(PROJECTILE_INSTANCED_CAP, PLASMA_HIGH_SPEC);
    this.plasmaHighMesh = new THREE.Mesh(this.plasmaHigh.geometry, this.plasmaMat);
    this.plasmaHighMesh.frustumCulled = false;
    this.plasmaHighMesh.visible = false;
    this.world.add(this.plasmaHighMesh);

    this.plasmaMedium = createDynamicPlasmaGeometry(
      PROJECTILE_INSTANCED_CAP,
      PLASMA_MEDIUM_SPEC,
    );
    this.plasmaMediumMesh = new THREE.Mesh(this.plasmaMedium.geometry, this.plasmaMat);
    this.plasmaMediumMesh.frustumCulled = false;
    this.plasmaMediumMesh.visible = false;
    this.world.add(this.plasmaMediumMesh);

    this.plasmaLowInstanced = new THREE.InstancedMesh(
      this.plasmaLowGeom,
      this.plasmaMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.plasmaLowInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.plasmaLowMatrices = this.plasmaLowInstanced.instanceMatrix.array as Float32Array;
    this.plasmaLowInstanced.frustumCulled = false;
    this.plasmaLowInstanced.count = 0;
    this.world.add(this.plasmaLowInstanced);

    this.rocketLowInstanced = new THREE.InstancedMesh(
      this.rocketLowGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.rocketLowInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rocketLowMatrices = this.rocketLowInstanced.instanceMatrix.array as Float32Array;
    this.rocketLowInstanced.frustumCulled = false;
    this.rocketLowInstanced.count = 0;
    this.world.add(this.rocketLowInstanced);

    this.finInstanced = new THREE.InstancedMesh(
      this.projectileFinGeom,
      this.projectileFinMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.finInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.finMatrices = this.finInstanced.instanceMatrix.array as Float32Array;
    this.finColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.finInstanced.instanceColor = this.finColorAttr;
    this.finInstanced.frustumCulled = false;
    this.finInstanced.count = 0;
    this.world.add(this.finInstanced);

    // Each tail band is the same tube its rung already draws the body with,
    // scaled to the rear slice of the same axis and colored per instance.
    this.mediumTailBandInstanced = new THREE.InstancedMesh(
      this.projectileMediumCylinderGeom,
      this.projectileFinMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.mediumTailBandInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mediumTailBandMatrices =
      this.mediumTailBandInstanced.instanceMatrix.array as Float32Array;
    this.mediumTailBandColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mediumTailBandInstanced.instanceColor = this.mediumTailBandColorAttr;
    this.mediumTailBandInstanced.frustumCulled = false;
    this.mediumTailBandInstanced.count = 0;
    this.world.add(this.mediumTailBandInstanced);

    this.lowTailBandInstanced = new THREE.InstancedMesh(
      this.rocketLowGeom,
      this.projectileFinMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.lowTailBandInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lowTailBandMatrices =
      this.lowTailBandInstanced.instanceMatrix.array as Float32Array;
    this.lowTailBandColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.lowTailBandInstanced.instanceColor = this.lowTailBandColorAttr;
    this.lowTailBandInstanced.frustumCulled = false;
    this.lowTailBandInstanced.count = 0;
    this.world.add(this.lowTailBandInstanced);
  }

  /** Begin the anonymous post-despawn visual for a plasma shot. The caller
   * supplies the authoritative terminal event point; non-plasma ids and shots
   * that were never rendered are deliberately ignored. */
  startPlasmaImpactCollapse(
    id: EntityId,
    impactX: number,
    impactY: number,
    impactZ: number,
  ): boolean {
    const state = this.plasmaTrailStates.get(id);
    if (state === undefined || state.collapse !== null) return false;
    if (!Number.isFinite(impactX) || !Number.isFinite(impactY) || !Number.isFinite(impactZ)) {
      return false;
    }
    const stamps = state.stamps;
    const dx = stamps.count > 0 ? state.lastHeadX - stamps.points[0] : 1;
    const dy = stamps.count > 0 ? state.lastHeadY - stamps.points[1] : 0;
    const dz = stamps.count > 0 ? state.lastHeadZ - stamps.points[2] : 0;
    if (stamps.count === 0 || dx * dx + dy * dy + dz * dz > 1e-6) {
      // The live head is not necessarily an ordinary distance stamp. Freeze
      // it into the path before replacing it with the exact impact head, so
      // collapse retraces the final visible curve instead of cutting a chord.
      insertTrailStamp(
        stamps,
        state.lastHeadX,
        state.lastHeadY,
        state.lastHeadZ,
        false,
      );
    }
    state.collapse = {
      elapsedMs: 0,
      headX: impactX,
      headY: impactY,
      headZ: impactZ,
    };
    return true;
  }

  update(
    frameState: RenderFrameState3D,
    projectiles: readonly Entity[],
    dtMs: number,
  ): void {
    // Held while paused so rocket fins stop rolling with everything else.
    const renderNowMs = isPresentationAnimationPaused()
      ? (this.pausedRenderNowMs ??= performance.now())
      : (this.pausedRenderNowMs = null, performance.now());
    const seen = this.seenProjectileIds;
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const scopeVersion = this.scope.getVersion();
    const pruneProjectiles =
      entitySetVersion !== this.lastProjectileEntitySetVersion ||
      (this.scope.getMode() !== 'all' && scopeVersion !== this.lastProjectileScopeVersion);
    if (pruneProjectiles) seen.clear();

    let sphereCount = 0;
    let cylinderCount = 0;
    let mediumSphereCount = 0;
    let mediumCylinderCount = 0;
    let rocketLowCount = 0;
    this.plasmaHighCount = 0;
    this.plasmaMediumCount = 0;
    this.plasmaLowCount = 0;
    let finCount = 0;
    let mediumTailBandCount = 0;
    let lowTailBandCount = 0;
    const wantHitForSelected = getVolumeToggle('hit');
    const wantExpForSelected = getVolumeToggle('explosion');
    // Every scratch has to finish growing before any view is bound:
    // growing one detaches wasm memory out from under views taken earlier,
    // and the axis output stays live across the whole loop below while
    // plasma LOW rows are still being written into the arc-pose input.
    const plasmaPoseCapacity = projectiles.length + this.plasmaTrailStates.size;
    this.plasmaArcPose.ensure(plasmaPoseCapacity);
    this.projectileAxisPose.begin(projectiles.length);
    this.plasmaArcPose.bind(plasmaPoseCapacity);
    for (let i = 0; i < projectiles.length; i++) {
      const entity = projectiles[i];
      const projectile = entity.projectile;
      this.projectileAxisPose.write(
        i,
        projectile?.velocityX ?? 0,
        projectile?.velocityY ?? 0,
        projectile?.velocityZ ?? 0,
        entity.transform.rotation,
      );
    }
    const projectileAxisOutput = this.projectileAxisPose.compute(projectiles.length);
    const projectileAxisOutputStride = this.projectileAxisPose.outputStride;

    for (let projectileIndex = 0; projectileIndex < projectiles.length; projectileIndex++) {
      const e = projectiles[projectileIndex];
      // TURR CIR / VOLUMES are selection-scoped diagnostics. Projectiles do
      // not normally expose selection today, but retaining the entity gate
      // here keeps the contract correct if selectable shots return later.
      const selected = e.selectable?.selected === true;
      const wantHit = selected && wantHitForSelected;
      const wantExp = selected && wantExpForSelected;
      if (pruneProjectiles) seen.add(e.id);
      const tx = e.transform.x;
      const ty = e.transform.y;
      const tz = e.transform.z;
      const proj = e.projectile;

      if (!this.scope.inScope(tx, ty, 50)) {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }

      const shotProfile = e.projectile?.config.shotProfile;
      const visualProfile = shotProfile?.visual;
      const radius = shotProfile?.runtime.radius.other ?? 4;
      const visualRadius = radius;
      const r = Math.max(visualRadius, PROJECTILE_MIN_RADIUS);
      const isPlasma = shotProfile?.runtime.type === 'plasma';
      const tailLength = r * (visualProfile?.projectileTailLengthMult ?? 8);
      const sharedRung = this.entityDetailRung(e);
      const detailLevel = sharedRung === undefined
        ? entityDetailLevelForView(frameState.view, e)
        : detailLevelForRung(sharedRung);
      const projectileStyle = projectileStyleForDetail(
        detailLevel,
        frameState.gfx.projectileStyle,
      );
      const drawProjectileTail = projectileStyle !== 'dot' && projectileStyle !== 'core';
      const drawProjectileFins = projectileStyle === 'full';
      const emissionFarLod = this.isEntityEmissionFarLod(e);

      // Every projectile owns real Low geometry. The legacy emission gate
      // now forces that rung instead of making rockets/missiles disappear.

      if (isPlasma && proj) {
        const tailRadius = r * (visualProfile?.projectileTailRadiusMult ?? 1);
        // Plasma poses itself from its flight path, so the velocity axis is
        // wanted only as writePlasmaGeometry's degenerate-tangent fallback.
        // Reading the direction alone skips composing a position, rotation,
        // and scale that no plasma rung consumes any more.
        const axisBase = projectileIndex * projectileAxisOutputStride;
        this.projDir.set(
          projectileAxisOutput[axisBase],
          projectileAxisOutput[axisBase + 1],
          projectileAxisOutput[axisBase + 2],
        );
        const trailState = this.getOrCreatePlasmaTrailState(e.id);
        // A terminal event may reach the scene immediately before the matching
        // despawn row. Once collapse begins, the exact event point owns the
        // head even if the live cache survives for this one render frame.
        if (trailState.collapse !== null) {
          this.hideProjRadiusMeshes(e.id);
          continue;
        }
        this.advanceTrailStamps(trailState.stamps, proj, tx, ty, tz, tailLength);
        // DOT/CORE graphics ceilings still shed to the minimum plasma mesh;
        // they no longer make the projectile disappear altogether.
        const rung = drawProjectileTail
          ? sharedRung ?? detailRungForLevel(detailLevel)
          : DETAIL_RUNG_FAR;
        trailState.radius = r;
        trailState.tailRadius = tailRadius;
        trailState.tailLength = tailLength;
        trailState.rung = rung;
        trailState.directionX = this.projDir.x;
        trailState.directionY = this.projDir.y;
        trailState.directionZ = this.projDir.z;
        trailState.lastHeadX = tx;
        trailState.lastHeadY = ty;
        trailState.lastHeadZ = tz;
        this.enqueuePlasmaVisual(
          rung,
          tx,
          ty,
          tz,
          trailState.stamps,
          tailLength,
          r,
          tailRadius,
          this.projDir.x,
          this.projDir.y,
          this.projDir.z,
        );
        this.updateProjRadiusMeshes(e, wantHit, wantExp);
        continue;
      }

      const tailShape = drawProjectileTail
        ? visualProfile?.projectileTailShape ?? 'cone'
        : 'none';
      const finSizeMult = visualProfile?.projectileFinSizeMult ?? 0;
      const tailRadius = r * (visualProfile?.projectileTailRadiusMult ?? 1);
      this.composeProjectileTailPose(
        projectileAxisOutput,
        projectileIndex * projectileAxisOutputStride,
        tx,
        ty,
        tz,
        tailLength,
        tailRadius,
      );
      const rawRocketRung = sharedRung ?? detailRungForLevel(detailLevel);
      // MISSILES (the fast family, 20-33x rocket speed) are deliberately
      // plain at EVERY distance: the Low extruded triangle — triangle nose
      // and tail caps, three quad sides — plus the team tail band. No nose
      // sphere, no spinning fin blades, no per-rung upgrade: they cross the
      // screen in a blink and read by silhouette, so forcing the FAR rung
      // here IS their entire look. Rockets and torpedoes keep the ladder.
      const isMissile = shotProfile?.runtime.type === 'missile';
      const rocketRung =
        isMissile || emissionFarLod || (!drawProjectileTail && !drawProjectileFins)
          ? DETAIL_RUNG_FAR
          : rawRocketRung;

      // Only High still spends triangles on the fin blades. Every coarser
      // rung hands that team read to the tail band, so its tube is drawn as
      // a forward run plus a fin-colored rear slice of the same axis.
      const banded = finSizeMult > 0 && rocketRung !== DETAIL_RUNG_CLOSE;
      const bandLength = banded ? tailLength * PROJECTILE_TAIL_BAND_FRACTION : 0;
      const bodyLength = tailLength - bandLength;

      if (rocketRung === DETAIL_RUNG_CLOSE) {
        if (sphereCount < PROJECTILE_INSTANCED_CAP) {
          writeTranslateScaleMatrix(
            this.sphereMatrices,
            sphereCount++,
            tx, tz, ty,
            r, r, r,
          );
        }
        if (tailShape === 'cylinder' && cylinderCount < PROJECTILE_INSTANCED_CAP) {
          writeComposedMatrix(
            this.cylinderMatrices,
            cylinderCount++,
            this.projPos.x,
            this.projPos.y,
            this.projPos.z,
            this.projQuat,
            this.projScale.x,
            this.projScale.y,
            this.projScale.z,
          );
        }
      } else if (rocketRung === DETAIL_RUNG_MID) {
        if (mediumSphereCount < PROJECTILE_INSTANCED_CAP) {
          writeTranslateScaleMatrix(
            this.mediumSphereMatrices,
            mediumSphereCount++,
            tx, tz, ty,
            r, r, r,
          );
        }
        if (
          tailShape === 'cylinder' &&
          mediumCylinderCount < PROJECTILE_INSTANCED_CAP
        ) {
          this.writeAxialSegmentMatrix(
            this.mediumCylinderMatrices,
            mediumCylinderCount++,
            tx, ty, tz,
            bodyLength * 0.5,
            tailRadius,
            bodyLength,
          );
        }
      } else if (rocketLowCount < PROJECTILE_INSTANCED_CAP) {
        this.writeAxialSegmentMatrix(
          this.rocketLowMatrices,
          rocketLowCount++,
          tx, ty, tz,
          bodyLength * 0.5,
          r,
          bodyLength,
        );
      }

      if (banded) {
        const medium = rocketRung === DETAIL_RUNG_MID;
        const slot = medium ? mediumTailBandCount : lowTailBandCount;
        if (slot < PROJECTILE_INSTANCED_CAP) {
          this.writeAxialSegmentMatrix(
            medium ? this.mediumTailBandMatrices : this.lowTailBandMatrices,
            slot,
            tx, ty, tz,
            tailLength - bandLength * 0.5,
            medium ? tailRadius : r,
            bandLength,
          );
          if (proj) {
            this.writeInstanceTeamColor(
              medium ? this.mediumTailBandColors : this.lowTailBandColors,
              slot,
              proj.ownerId,
            );
          }
          if (medium) mediumTailBandCount++;
          else lowTailBandCount++;
        }
      }

      if (finSizeMult > 0 && rocketRung === DETAIL_RUNG_CLOSE) {
        const isRocketLike = proj?.config.shotProfile.runtime.isRocketLike === true;
        const rollAngle = proj && isRocketLike
          ? (renderNowMs + (e.id % 64) * 31) * ROCKET_FIN_ROLL_RATE_RAD_PER_MS
          : 0;
        const finRearOffset = tailLength + r * FIN_REAR_OVERHANG_MULT;
        this.composeProjectileFinPose(
          tx, ty, tz, finRearOffset, r * finSizeMult, rollAngle,
        );
        if (finCount < PROJECTILE_INSTANCED_CAP) {
          writeComposedMatrix(
            this.finMatrices,
            finCount,
            this.projPos.x,
            this.projPos.y,
            this.projPos.z,
            this.finQuat,
            this.projScale.x,
            this.projScale.y,
            this.projScale.z,
          );
          if (proj) {
            this.writeInstanceTeamColor(this.finColors, finCount, proj.ownerId);
            this.markFinColorDirty(finCount);
          }
          finCount++;
        }
      }

      this.updateProjRadiusMeshes(e, wantHit, wantExp);
    }

    this.enqueuePlasmaImpactCollapses(dtMs);

    if (this.sphereInstanced.count !== sphereCount) this.sphereInstanced.count = sphereCount;
    if (sphereCount > 0) {
      this.markInstanceMatrixRange(this.sphereInstanced, 0, sphereCount - 1);
    }
    if (this.cylinderInstanced.count !== cylinderCount) this.cylinderInstanced.count = cylinderCount;
    if (cylinderCount > 0) {
      this.markInstanceMatrixRange(this.cylinderInstanced, 0, cylinderCount - 1);
    }
    if (this.mediumSphereInstanced.count !== mediumSphereCount) {
      this.mediumSphereInstanced.count = mediumSphereCount;
    }
    if (mediumSphereCount > 0) {
      this.markInstanceMatrixRange(
        this.mediumSphereInstanced,
        0,
        mediumSphereCount - 1,
      );
    }
    if (this.mediumCylinderInstanced.count !== mediumCylinderCount) {
      this.mediumCylinderInstanced.count = mediumCylinderCount;
    }
    if (mediumCylinderCount > 0) {
      this.markInstanceMatrixRange(
        this.mediumCylinderInstanced,
        0,
        mediumCylinderCount - 1,
      );
    }
    this.flushPlasmaGeometry(this.plasmaHigh, this.plasmaHighMesh, this.plasmaHighCount);
    this.flushPlasmaGeometry(
      this.plasmaMedium,
      this.plasmaMediumMesh,
      this.plasmaMediumCount,
    );
    if (this.plasmaLowInstanced.count !== this.plasmaLowCount) {
      this.plasmaLowInstanced.count = this.plasmaLowCount;
    }
    if (this.plasmaLowCount > 0) {
      // Rust composed every LOW matrix from its head/tip pair. Both runs are
      // contiguous and in the same order, so the mass rung lands in one copy
      // rather than per-shot quaternion and matrix work.
      const arcPoses = this.plasmaArcPose.compute(this.plasmaLowCount);
      this.plasmaLowMatrices.set(
        arcPoses.subarray(0, this.plasmaLowCount * this.plasmaArcPose.outputStride),
      );
      this.markInstanceMatrixRange(
        this.plasmaLowInstanced,
        0,
        this.plasmaLowCount - 1,
      );
    }
    if (this.rocketLowInstanced.count !== rocketLowCount) {
      this.rocketLowInstanced.count = rocketLowCount;
    }
    if (rocketLowCount > 0) {
      this.markInstanceMatrixRange(this.rocketLowInstanced, 0, rocketLowCount - 1);
    }
    if (this.finInstanced.count !== finCount) this.finInstanced.count = finCount;
    if (finCount > 0) {
      this.markInstanceMatrixRange(this.finInstanced, 0, finCount - 1);
    }
    if (
      this.finColorDirtyMax >= this.finColorDirtyMin &&
      this.finInstanced.instanceColor
    ) {
      const min = this.finColorDirtyMin;
      const max = this.finColorDirtyMax;
      this.finInstanced.instanceColor.clearUpdateRanges();
      this.finInstanced.instanceColor.addUpdateRange(min * 3, (max - min + 1) * 3);
      this.finInstanced.instanceColor.needsUpdate = true;
      this.finColorDirtyMin = Number.POSITIVE_INFINITY;
      this.finColorDirtyMax = -1;
    }
    this.flushColoredInstances(
      this.mediumTailBandInstanced,
      this.mediumTailBandColorAttr,
      mediumTailBandCount,
    );
    this.flushColoredInstances(
      this.lowTailBandInstanced,
      this.lowTailBandColorAttr,
      lowTailBandCount,
    );

    if (pruneProjectiles) {
      for (const [id, radii] of this.projectileRadiusMeshes) {
        if (!seen.has(id)) {
          this.releaseProjRadiusMesh(radii.hit);
          this.releaseProjRadiusMesh(radii.explosion);
          this.projectileRadiusMeshes.delete(id);
        }
      }
      for (const [id, state] of this.plasmaTrailStates) {
        if (!seen.has(id) && state.collapse === null) {
          this.plasmaTrailStates.delete(id);
        }
      }
      this.lastProjectileEntitySetVersion = entitySetVersion;
      this.lastProjectileScopeVersion = scopeVersion;
    }
  }

  private getOrCreatePlasmaTrailState(id: EntityId): PlasmaTrailRenderState {
    let state = this.plasmaTrailStates.get(id);
    if (state !== undefined) return state;
    state = {
      stamps: createTrailStampBuffer(),
      radius: PROJECTILE_MIN_RADIUS,
      tailRadius: PROJECTILE_MIN_RADIUS,
      tailLength: 0,
      rung: DETAIL_RUNG_FAR,
      directionX: 1,
      directionY: 0,
      directionZ: 0,
      lastHeadX: 0,
      lastHeadY: 0,
      lastHeadZ: 0,
      collapse: null,
    };
    this.plasmaTrailStates.set(id, state);
    return state;
  }

  private enqueuePlasmaImpactCollapses(dtMs: number): void {
    const advanceMs = Math.max(0, dtMs);
    for (const [id, state] of this.plasmaTrailStates) {
      const collapse = state.collapse;
      if (collapse === null) continue;
      if (collapse.elapsedMs >= PLASMA_IMPACT_COLLAPSE_DURATION_MS) {
        this.plasmaTrailStates.delete(id);
        continue;
      }
      const remainingTailLength = plasmaImpactCollapseTailLength(
        state.tailLength,
        collapse.elapsedMs,
      );
      if (this.scope.inScope(collapse.headX, collapse.headY, 50)) {
        this.enqueuePlasmaVisual(
          state.rung,
          collapse.headX,
          collapse.headY,
          collapse.headZ,
          state.stamps,
          remainingTailLength,
          state.radius,
          state.tailRadius,
          state.directionX,
          state.directionY,
          state.directionZ,
        );
      }
      collapse.elapsedMs += advanceMs;
    }
  }

  private enqueuePlasmaVisual(
    rung: DetailRung,
    headX: number,
    headY: number,
    headZ: number,
    stamps: TrailStampBuffer,
    tailLength: number,
    radius: number,
    tailRadius: number,
    directionX: number,
    directionY: number,
    directionZ: number,
  ): void {
    this.projDir.set(directionX, directionY, directionZ);
    if (rung === DETAIL_RUNG_CLOSE) {
      if (this.plasmaHighCount >= PROJECTILE_INSTANCED_CAP) return;
      const drawnSpan = resampleTrailCenterline(
        this.trailScratch,
        headX,
        headY,
        headZ,
        stamps,
        tailLength,
        PLASMA_HIGH_SPEC.curveSegments,
      );
      this.writePlasmaGeometry(
        this.plasmaHigh,
        this.plasmaHighCount++,
        radius,
        tailRadius,
        drawnSpan,
      );
      return;
    }
    if (rung === DETAIL_RUNG_MID) {
      if (this.plasmaMediumCount >= PROJECTILE_INSTANCED_CAP) return;
      const drawnSpan = resampleTrailCenterline(
        this.trailScratch,
        headX,
        headY,
        headZ,
        stamps,
        tailLength,
        PLASMA_MEDIUM_SPEC.curveSegments,
      );
      this.writePlasmaGeometry(
        this.plasmaMedium,
        this.plasmaMediumCount++,
        radius,
        tailRadius,
        drawnSpan,
      );
      return;
    }
    if (this.plasmaLowCount >= PROJECTILE_INSTANCED_CAP) return;
    // Ring 1 of a one-segment resample sits at the same drawn-span endpoint
    // as the deepest rung. That remains true while the collapse horizon
    // shrinks, so LOW reaches the fixed head on exactly the same frame.
    resampleTrailCenterline(
      this.trailScratch,
      headX,
      headY,
      headZ,
      stamps,
      tailLength,
      1,
    );
    const centerline = this.trailScratch.centerline;
    this.plasmaArcPose.write(
      this.plasmaLowCount++,
      headX,
      headZ,
      headY,
      centerline[3],
      centerline[5],
      centerline[4],
      radius,
    );
  }

  destroy(): void {
    disposeMesh(this.sphereInstanced, { material: false, geometry: false });
    disposeMesh(this.cylinderInstanced, { material: false, geometry: false });
    disposeMesh(this.mediumSphereInstanced, { material: false, geometry: false });
    disposeMesh(this.mediumCylinderInstanced, { material: false, geometry: false });
    disposeMesh(this.plasmaHighMesh, { material: false, geometry: false });
    disposeMesh(this.plasmaMediumMesh, { material: false, geometry: false });
    disposeMesh(this.plasmaLowInstanced, { material: false, geometry: false });
    disposeMesh(this.rocketLowInstanced, { material: false, geometry: false });
    disposeMesh(this.finInstanced, { material: false, geometry: false });
    disposeMesh(this.mediumTailBandInstanced, { material: false, geometry: false });
    disposeMesh(this.lowTailBandInstanced, { material: false, geometry: false });
    for (const radii of this.projectileRadiusMeshes.values()) {
      if (radii.hit) {
        disposeMesh(radii.hit, { material: false, geometry: false });
      }
      if (radii.explosion) {
        disposeMesh(radii.explosion, { material: false, geometry: false });
      }
    }
    for (const mesh of this.projectileRadiusMeshPool) {
      disposeMesh(mesh, { material: false, geometry: false });
    }
    this.seenProjectileIds.clear();
    this.plasmaTrailStates.clear();
    this.projectileRadiusMeshes.clear();
    this.projectileRadiusMeshPool.length = 0;
    disposeGeometries([
      this.projectileGeom,
      this.projectileCylinderGeom,
      this.projectileMediumGeom,
      this.projectileMediumCylinderGeom,
      this.plasmaHigh.geometry,
      this.plasmaMedium.geometry,
      this.plasmaLowGeom,
      this.rocketLowGeom,
      this.projectileFinGeom,
    ]);
    disposeMaterials([
      this.projectileMat,
      this.plasmaMat,
      this.projectileFinMat,
      this.projMatCollision,
      this.projMatExplosion,
    ]);
  }

  // Owns the per-entity trail history: the buffer lifetime, the forced
  // shield-contact stamp, and the ordinary distance stamp. The polyline
  // shape and its resampler live in ProjectileTrailHistory3D.
  private advanceTrailStamps(
    stamps: TrailStampBuffer,
    proj: NonNullable<Entity['projectile']>,
    headX: number,
    headY: number,
    headZ: number,
    tailLength: number,
  ): void {
    // Forced reflection stamp: ClientViewState parks the exact
    // shield-sphere / shield-panel contact point on the projectile after each
    // bounce. Insert it ahead of the head's regular distance-threshold
    // stamp so the trail kinks at the actual shield surface rather than
    // one tick past it. The pre-bounce stamps shift deeper into the
    // buffer untouched, preserving the incoming arc.
    const bounceX = proj.pendingReflectionX;
    const bounceY = proj.pendingReflectionY;
    const bounceZ = proj.pendingReflectionZ;
    if (bounceX !== null && bounceY !== null && bounceZ !== null) {
      insertTrailStamp(stamps, bounceX, bounceY, bounceZ, true);
      proj.pendingReflectionX = null;
      proj.pendingReflectionY = null;
      proj.pendingReflectionZ = null;
    }

    stampTrailHeadIfMoved(stamps, headX, headY, headZ, tailLength);
  }

  private writePlasmaGeometry(
    dynamic: DynamicPlasmaGeometry,
    slot: number,
    bodyRadius: number,
    tailRadius: number,
    drawnSpan: number,
  ): void {
    // One continuous surface replaces the old overlapping sphere + open
    // cone. The front apex and shoulder make the plasma ball; the same
    // indexed surface then tapers through the resampled trail to one tail
    // vertex, so there are no hidden sphere or cone-cap triangles.
    const spec = dynamic.spec;
    const centerline = this.trailScratch.centerline;
    const dists = this.trailScratch.ringDist;
    const invSpan = drawnSpan > 1e-4 ? 1 / drawnSpan : 0;
    const positions = dynamic.positions;
    const vertexBase = slot * spec.verticesPerShot;
    const headX = centerline[0];
    const headY = centerline[2];
    const headZ = centerline[1];

    let tanX = centerline[3] - centerline[0];
    let tanY = centerline[4] - centerline[1];
    let tanZ = centerline[5] - centerline[2];
    if (tanX * tanX + tanY * tanY + tanZ * tanZ < TRAIL_MIN_TANGENT_SQ) {
      // projDir is already in THREE coordinates; map it back to sim order
      // because setCurveBasis performs the sim -> THREE axis conversion.
      tanX = this.projDir.x;
      tanY = this.projDir.z;
      tanZ = this.projDir.y;
    }
    this.setCurveBasis(tanX, tanY, tanZ, true);

    this.writePlasmaVertex(
      positions,
      vertexBase,
      headX - this.curveTangent.x * bodyRadius,
      headY - this.curveTangent.y * bodyRadius,
      headZ - this.curveTangent.z * bodyRadius,
    );
    let ringVertex = vertexBase + 1;
    this.writePlasmaRing(
      positions,
      ringVertex,
      spec,
      headX - this.curveTangent.x * bodyRadius * 0.45,
      headY - this.curveTangent.y * bodyRadius * 0.45,
      headZ - this.curveTangent.z * bodyRadius * 0.45,
      bodyRadius * 0.9,
    );
    ringVertex += spec.radialSegments;
    this.writePlasmaRing(
      positions,
      ringVertex,
      spec,
      headX,
      headY,
      headZ,
      bodyRadius,
    );
    ringVertex += spec.radialSegments;

    for (let segment = 1; segment < spec.curveSegments; segment++) {
      const ci = segment * 3;
      const px = centerline[ci];
      const py = centerline[ci + 1];
      const pz = centerline[ci + 2];

      const ni = (segment + 1) * 3;
      const pi = (segment - 1) * 3;
      tanX = centerline[ni] - centerline[pi];
      tanY = centerline[ni + 1] - centerline[pi + 1];
      tanZ = centerline[ni + 2] - centerline[pi + 2];
      if (tanX * tanX + tanY * tanY + tanZ * tanZ < TRAIL_MIN_TANGENT_SQ) {
        tanX = this.projDir.x;
        tanY = this.projDir.z;
        tanZ = this.projDir.y;
      }
      this.setCurveBasis(tanX, tanY, tanZ, false);

      const ringRadius = invSpan > 0
        ? tailRadius * (1 - dists[segment] * invSpan)
        : 0;
      this.writePlasmaRing(
        positions,
        ringVertex,
        spec,
        px,
        pz,
        py,
        ringRadius,
      );
      ringVertex += spec.radialSegments;
    }

    const tailOffset = spec.curveSegments * 3;
    this.writePlasmaVertex(
      positions,
      vertexBase + spec.verticesPerShot - 1,
      centerline[tailOffset],
      centerline[tailOffset + 2],
      centerline[tailOffset + 1],
    );
  }

  private writePlasmaRing(
    positions: Float32Array,
    vertexStart: number,
    spec: PlasmaGeometrySpec,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
  ): void {
    for (let radial = 0; radial < spec.radialSegments; radial++) {
      const normalX = this.curveRight.x * spec.cos[radial] +
        this.curveUp.x * spec.sin[radial];
      const normalY = this.curveRight.y * spec.cos[radial] +
        this.curveUp.y * spec.sin[radial];
      const normalZ = this.curveRight.z * spec.cos[radial] +
        this.curveUp.z * spec.sin[radial];
      this.writePlasmaVertex(
        positions,
        vertexStart + radial,
        centerX + normalX * radius,
        centerY + normalY * radius,
        centerZ + normalZ * radius,
      );
    }
  }

  private writePlasmaVertex(
    positions: Float32Array,
    vertex: number,
    x: number,
    y: number,
    z: number,
  ): void {
    const out = vertex * 3;
    positions[out] = x;
    positions[out + 1] = y;
    positions[out + 2] = z;
  }

  private setCurveBasis(
    tangentX: number,
    tangentY: number,
    tangentZ: number,
    seed: boolean,
  ): void {
    this.curveTangent.set(tangentX, tangentZ, tangentY);
    if (this.curveTangent.lengthSq() <= 1e-8) {
      this.curveTangent.set(0, 0, -1);
    } else {
      this.curveTangent.normalize();
    }
    const t = this.curveTangent;
    if (!seed) {
      // Parallel-transport the previous ring's frame: project the previous
      // right vector onto the plane perpendicular to the new tangent. Ring
      // orientation then varies continuously along the whole curve — there
      // is no world-axis reference and so no travel direction where the
      // frame flips and pinches the tube.
      this.curveRight.addScaledVector(t, -this.curveRight.dot(t));
      if (this.curveRight.lengthSq() > 1e-6) {
        this.curveRight.normalize();
        this.curveUp.crossVectors(t, this.curveRight).normalize();
        return;
      }
      // Adjacent rings bent ~90° (degenerate projection) — reseed below.
    }
    // Seed frame: use the world axis least aligned with the tangent so the
    // cross product is always well-conditioned. The seed only fixes the
    // arbitrary roll of the circular cross-section; transported rings keep
    // every subsequent ring aligned with it.
    const ax = Math.abs(t.x);
    const ay = Math.abs(t.y);
    const az = Math.abs(t.z);
    if (ax <= ay && ax <= az) this.curveReference.set(1, 0, 0);
    else if (ay <= az) this.curveReference.set(0, 1, 0);
    else this.curveReference.set(0, 0, 1);
    this.curveRight.crossVectors(this.curveReference, t).normalize();
    this.curveUp.crossVectors(t, this.curveRight).normalize();
  }

  private flushPlasmaGeometry(
    dynamic: DynamicPlasmaGeometry,
    mesh: THREE.Mesh,
    count: number,
  ): void {
    setObjectVisibleIfChanged(mesh, count > 0);
    const drawCount = count * dynamic.spec.indicesPerShot;
    if (
      dynamic.geometry.drawRange.start !== 0 ||
      dynamic.geometry.drawRange.count !== drawCount
    ) {
      dynamic.geometry.setDrawRange(0, drawCount);
    }
    if (count <= 0) return;

    const updatedComponents = count * dynamic.spec.verticesPerShot * 3;
    dynamic.positionAttr.clearUpdateRanges();
    dynamic.positionAttr.addUpdateRange(0, updatedComponents);
    dynamic.positionAttr.needsUpdate = true;
  }

  private composeProjectileFinPose(
    x: number, y: number, z: number,
    rearOffset: number,
    finScale: number,
    rollAngle: number,
  ): void {
    this.projPos.set(
      x + this.projDir.x * rearOffset,
      z + this.projDir.y * rearOffset,
      y + this.projDir.z * rearOffset,
    );
    this.projScale.setScalar(finScale);
    if (rollAngle !== 0) {
      // Fin geometry's local +Y is the rocket axis (projDir after projQuat),
      // so rolling around local Y spins the blades around that axis.
      this.finRollQuat.setFromAxisAngle(PROJ_CYL_AXIS, rollAngle);
      this.finQuat.copy(this.projQuat).multiply(this.finRollQuat);
    } else {
      this.finQuat.copy(this.projQuat);
    }
  }

  /** Places one body-axis segment of `length`, centered `centerOffset` back
   *  from the head along the flight axis. Body runs, tail bands and the Low
   *  tube all pose off the same call, so a split tube stays exactly collinear
   *  with the tube it was split out of. */
  private writeAxialSegmentMatrix(
    matrices: Float32Array,
    slot: number,
    x: number, y: number, z: number,
    centerOffset: number,
    radius: number,
    length: number,
  ): void {
    writeComposedMatrix(
      matrices,
      slot,
      x + this.projDir.x * centerOffset,
      z + this.projDir.y * centerOffset,
      y + this.projDir.z * centerOffset,
      this.projQuat,
      radius,
      length,
      radius,
    );
  }

  private writeInstanceTeamColor(
    colors: Float32Array,
    slot: number,
    ownerId: number,
  ): void {
    this.finColor.set(getPlayerColors(ownerId).primary);
    const colorOffset = slot * 3;
    colors[colorOffset] = this.finColor.r;
    colors[colorOffset + 1] = this.finColor.g;
    colors[colorOffset + 2] = this.finColor.b;
  }

  private flushColoredInstances(
    mesh: THREE.InstancedMesh,
    colorAttr: THREE.InstancedBufferAttribute,
    count: number,
  ): void {
    if (mesh.count !== count) mesh.count = count;
    if (count <= 0) return;
    this.markInstanceMatrixRange(mesh, 0, count - 1);
    colorAttr.clearUpdateRanges();
    colorAttr.addUpdateRange(0, count * 3);
    colorAttr.needsUpdate = true;
  }

  private composeProjectileTailPose(
    pose: Float32Array,
    poseOffset: number,
    x: number, y: number, z: number,
    length: number,
    radius: number,
  ): void {
    composeProjectileTailPose3D(
      pose,
      poseOffset,
      x, y, z,
      length,
      radius,
      this.projDir,
      this.projPos,
      this.projQuat,
      this.projScale,
    );
  }

  private updateProjRadiusMeshes(
    entity: Entity,
    wantHit: boolean,
    wantExp: boolean,
  ): void {
    const proj = entity.projectile;
    if (!proj) return;
    if (!proj.config.shotProfile.runtime.isProjectile) return;

    if (!wantHit && !wantExp) {
      const existing = this.projectileRadiusMeshes.get(entity.id);
      if (existing) this.hideProjRadiusMeshRecord(existing);
      return;
    }

    let radii = this.projectileRadiusMeshes.get(entity.id);
    if (!radii) {
      radii = {};
      this.projectileRadiusMeshes.set(entity.id, radii);
    }

    // Both spheres come from the shared entityVolumes writers, the same
    // ones the host overlay and the mouse picker use.
    this.setProjRadiusMesh(
      radii, 'hit',
      wantHit && writeHitVolume(entity, this.projVolume),
      this.projVolume, this.projMatCollision,
    );
    this.setProjRadiusMesh(
      radii, 'explosion',
      wantExp && writeExplosionVolume(entity, this.projVolume),
      this.projVolume, this.projMatExplosion,
    );
  }

  private hideProjRadiusMeshes(entityId: EntityId): void {
    const radii = this.projectileRadiusMeshes.get(entityId);
    if (radii) this.hideProjRadiusMeshRecord(radii);
  }

  private hideProjRadiusMeshRecord(radii: ProjectileRadiusMeshes): void {
    if (radii.hit) setObjectVisibleIfChanged(radii.hit, false);
    if (radii.explosion) setObjectVisibleIfChanged(radii.explosion, false);
  }

  private setProjRadiusMesh(
    radii: ProjectileRadiusMeshes,
    key: 'hit' | 'explosion',
    want: boolean,
    volume: EntityVolume,
    mat: THREE.LineBasicMaterial,
  ): void {
    const radius = volume.halfX;
    if (!want || radius <= 0) {
      const m = radii[key];
      if (m) setObjectVisibleIfChanged(m, false);
      return;
    }
    const x = volume.x;
    const y = volume.y;
    const z = volume.z;
    let mesh = radii[key];
    if (!mesh) {
      mesh = this.projectileRadiusMeshPool.pop() ??
        new THREE.LineSegments(this.radiusSphereGeom, mat);
      mesh.material = mat;
      this.world.add(mesh);
      radii[key] = mesh;
    }
    setObjectVisibleIfChanged(mesh, true);
    setVector3IfChanged(mesh.position, x, z, y);
    setScaleScalarIfChanged(mesh.scale, radius);
  }

  private releaseProjRadiusMesh(mesh?: THREE.LineSegments): void {
    if (!mesh) return;
    setObjectVisibleIfChanged(mesh, false);
    detachObject(mesh);
    this.projectileRadiusMeshPool.push(mesh);
  }

  private markInstanceMatrixRange(
    mesh: THREE.InstancedMesh,
    minSlot: number,
    maxSlot: number,
  ): void {
    if (maxSlot < minSlot) return;
    const attr = mesh.instanceMatrix;
    attr.clearUpdateRanges();
    attr.addUpdateRange(minSlot * 16, (maxSlot - minSlot + 1) * 16);
    attr.needsUpdate = true;
  }

  private markFinColorDirty(slot: number): void {
    if (slot < this.finColorDirtyMin) this.finColorDirtyMin = slot;
    if (slot > this.finColorDirtyMax) this.finColorDirtyMax = slot;
  }
}

// Local +Y aligns with projDir (rocket-rearward) after the instance
// quaternion is applied. The local origin sits at the fin's rear edge so
// the caller can place it directly at the rocket tail end; the fin tapers
// forward along local -Y toward the rocket body.
function createProjectileFinGeometry(): THREE.BufferGeometry {
  const FIN_FORWARD = -2;
  const FIN_REAR = 0;
  const FIN_OUT = 1;
  // Half-thickness perpendicular to each blade's plane.
  const FIN_THICK = 0.15;
  // Each blade becomes a triangular prism: front face + back face + 3 side
  // quads, all emitted as non-indexed triangles.
  const fin = (angleRad: number): number[] => {
    const radialX = Math.cos(angleRad);
    const radialZ = Math.sin(angleRad);
    const ox = radialX * FIN_OUT;
    const oz = radialZ * FIN_OUT;
    const px = -radialZ * FIN_THICK;
    const pz = radialX * FIN_THICK;
    // Six prism vertices: A/B/C with +perp, A'/B'/C' with -perp.
    const A = [0, FIN_FORWARD, 0];
    const B = [0, FIN_REAR, 0];
    const C = [ox, FIN_REAR, oz];
    const Ap = [A[0] + px, A[1], A[2] + pz];
    const Bp = [B[0] + px, B[1], B[2] + pz];
    const Cp = [C[0] + px, C[1], C[2] + pz];
    const An = [A[0] - px, A[1], A[2] - pz];
    const Bn = [B[0] - px, B[1], B[2] - pz];
    const Cn = [C[0] - px, C[1], C[2] - pz];
    return [
      // Front face (perp side).
      ...Ap, ...Bp, ...Cp,
      // Back face (opposite winding).
      ...An, ...Cn, ...Bn,
      // Forward edge quad (apex A → rear-inner B), connecting Ap-Bp to An-Bn.
      ...Ap, ...An, ...Bp,
      ...Bp, ...An, ...Bn,
      // Rear edge quad (B → C).
      ...Bp, ...Bn, ...Cp,
      ...Cp, ...Bn, ...Cn,
      // Outer slanted edge (C → A).
      ...Cp, ...Cn, ...Ap,
      ...Ap, ...Cn, ...An,
    ];
  };
  const rawVerts: number[] = [];
  for (let i = 0; i < PROJECTILE_ROCKET_FIN_COUNT; i++) {
    rawVerts.push(...fin((i / PROJECTILE_ROCKET_FIN_COUNT) * Math.PI * 2));
  }
  const verts = new Float32Array(rawVerts);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geom.computeVertexNormals();
  return geom;
}

function createDynamicPlasmaGeometry(
  capacity: number,
  spec: PlasmaGeometrySpec,
): DynamicPlasmaGeometry {
  const positions = new Float32Array(capacity * spec.verticesPerShot * 3);
  // STATIC per-vertex heat ramp: the slot topology (nose, head-to-tail
  // rings, tail point) never changes, so tip-white -> ember-tail colors
  // are written once and cost nothing per frame.
  const colors = new Float32Array(capacity * spec.verticesPerShot * 3);
  const indices = new Uint32Array(capacity * spec.indicesPerShot);
  for (let slot = 0; slot < capacity; slot++) {
    const vertexBase = slot * spec.verticesPerShot;
    const nose = vertexBase;
    writePlasmaHeatRampColor(colors, nose, 0);
    for (let ring = 0; ring < spec.ringCount; ring++) {
      const axial = (ring + 1) / (spec.ringCount + 1);
      for (let radial = 0; radial < spec.radialSegments; radial++) {
        writePlasmaHeatRampColor(
          colors,
          vertexBase + 1 + ring * spec.radialSegments + radial,
          axial,
        );
      }
    }
    writePlasmaHeatRampColor(colors, vertexBase + spec.verticesPerShot - 1, 1);
    const firstRing = vertexBase + 1;
    const tail = vertexBase + spec.verticesPerShot - 1;
    let indexOut = slot * spec.indicesPerShot;
    for (let radial = 0; radial < spec.radialSegments; radial++) {
      const next = (radial + 1) % spec.radialSegments;
      indices[indexOut++] = nose;
      indices[indexOut++] = firstRing + radial;
      indices[indexOut++] = firstRing + next;
    }
    for (let ring = 0; ring < spec.ringCount - 1; ring++) {
      const ringA = firstRing + ring * spec.radialSegments;
      const ringB = ringA + spec.radialSegments;
      for (let radial = 0; radial < spec.radialSegments; radial++) {
        const next = (radial + 1) % spec.radialSegments;
        const a = ringA + radial;
        const b = ringB + radial;
        const c = ringB + next;
        const d = ringA + next;
        indices[indexOut++] = a;
        indices[indexOut++] = b;
        indices[indexOut++] = d;
        indices[indexOut++] = b;
        indices[indexOut++] = c;
        indices[indexOut++] = d;
      }
    }
    const lastRing = firstRing + (spec.ringCount - 1) * spec.radialSegments;
    for (let radial = 0; radial < spec.radialSegments; radial++) {
      const next = (radial + 1) % spec.radialSegments;
      indices[indexOut++] = lastRing + radial;
      indices[indexOut++] = tail;
      indices[indexOut++] = lastRing + next;
    }
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  return { spec, geometry, positions, positionAttr };
}

/** Four triangles total: one equilateral front face and three long faces
 *  meeting at the rear tail point. Local +Y is the projectile rearward
 *  axis; the caller scales Y to the chord from the head back to the drawn
 *  end of the resampled trail, so the length shortens with the arc rather
 *  than staying pinned at the authored plasma-tail length. */
function createLowResolutionPlasmaGeometry(): THREE.BufferGeometry {
  const halfSqrt3 = Math.sqrt(3) * 0.5;
  const positions = new Float32Array([
    0, -0.5, 1,
    halfSqrt3, -0.5, -0.5,
    -halfSqrt3, -0.5, -0.5,
    0, 0.5, 0,
  ]);
  const indices = new Uint16Array(PLASMA_LOW_INDICES);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // The instance matrix spans head -> tail along +Y, so the base
  // triangle is the fat white-hot head and the apex is the ember tail
  // tip — the same two ends the high mesh ramps between.
  const colors = new Float32Array(4 * 3);
  writePlasmaHeatRampColor(colors, 0, 0.1);
  writePlasmaHeatRampColor(colors, 1, 0.1);
  writePlasmaHeatRampColor(colors, 2, 0.1);
  writePlasmaHeatRampColor(colors, 3, 1);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}
