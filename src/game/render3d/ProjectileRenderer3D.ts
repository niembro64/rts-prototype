import * as THREE from 'three';
import { getProjRangeToggle } from '@/clientBarConfig';
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
import { ProjectileAxisPoseBatch3D } from './ProjectileAxisPoseBatch3D';

const PROJECTILE_MIN_RADIUS = 0.5;
// 1 revolution per second.
const ROCKET_FIN_ROLL_RATE_RAD_PER_MS = (Math.PI * 2) / 2000;
// Multiples of the rocket body radius — how far the fin rear edge sits
// past the cylinder tail end. Avoids color z-fight at the tail cap.
const FIN_REAR_OVERHANG_MULT = 0.75;
const PROJECTILE_INSTANCED_CAP = 8192;
const PROJECTILE_ROCKET_FIN_COUNT = 3;
const PLASMA_HIGH_CURVE_SEGMENTS = 6;
const PLASMA_HIGH_RADIAL_SEGMENTS = 10;
const PLASMA_MEDIUM_CURVE_SEGMENTS = 3;
const PLASMA_MEDIUM_RADIAL_SEGMENTS = 6;
// Trail stamps record the projectile's recent path as a polyline of
// positions frozen in render space the moment they were laid down, so
// MOVE POS / VEL EMAs only ever affect the live head — old stamps don't
// drift around behind the projectile. The drawn tail is resampled from
// this history every frame (resampleTrailCenterline) instead of mapping
// stamps to rings one-to-one, so the buffer is deeper than the ring
// count: the resample horizon is 7/6 of the tail length (kink pin +
// relax window), ordinary stamps land one drawn-segment-length apart,
// and forced reflection stamps can land arbitrarily close together.
// The extra slots keep the recorded polyline longer than the horizon,
// so evicting the oldest stamp never moves drawn geometry.
const TRAIL_STAMP_CAP = PLASMA_HIGH_CURVE_SEGMENTS + 4;
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

/** Rocket/missile/torpedo body + tube + all three authored fins. */
export const ROCKET_PROJECTILE_TRIANGLE_COUNTS = Object.freeze({
  high: 80 + 32 + 24,
  medium: 36 + 24 + 3,
  low: 8,
});

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

type ProjectileRadiusMeshes = {
  collision?: THREE.LineSegments;
  explosion?: THREE.LineSegments;
};

type TrailStampBuffer = {
  // Length TRAIL_STAMP_CAP * 3, indexed newest-first. Slot 0 is the most
  // recent stamp; slot count-1 is the oldest. The oldest stamp is
  // evicted when stamping past the cap.
  points: Float32Array;
  // 1 where the matching slot is a forced reflection stamp (the exact
  // shield contact point), 0 for ordinary distance stamps. Kept in
  // lockstep with points so the resampler can pin a ring onto the kink.
  flags: Uint8Array;
  count: number;
};

type DynamicPlasmaGeometry = {
  spec: PlasmaGeometrySpec;
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  positionAttr: THREE.BufferAttribute;
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
  private readonly scope: ViewportFootprint;
  private readonly radiusSphereGeom: THREE.BufferGeometry;
  private readonly isEntityEmissionFarLod: (entity: Entity) => boolean;
  private readonly entityDetailRung: (entity: Entity) => DetailRung | undefined;

  private readonly projectileGeom = createPrimitiveSphereGeometry('projectile', 'close');
  private readonly projectileCylinderGeom = createPrimitiveCylinderGeometry('projectile', 'close');
  private readonly projectileFinGeom = createProjectileFinGeometry();
  private readonly projectileMediumGeom = createPrimitiveSphereGeometry('projectile', 'mid');
  private readonly projectileMediumCylinderGeom = createPrimitiveCylinderGeometry('projectile', 'mid');
  private readonly projectileMediumFinGeom = createProjectileFinGeometry(false);
  private readonly projectileMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.projectile.body.colorHex,
  });
  // Plasma stays exactly white under every terrain/sun light: the body and
  // tail are one unlit surface instead of two differently shaded meshes.
  private readonly plasmaMat = new THREE.MeshBasicMaterial({
    color: COLORS.effects.projectile.curvedCone.colorHex,
    side: THREE.DoubleSide,
  });
  private readonly projectileFinMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.projectile.fin.colorHex,
    side: THREE.DoubleSide,
  });
  private readonly projMatCollision = new THREE.LineBasicMaterial({
    color: COLORS.effects.projectile.collisionRadius.colorHex,
    transparent: true,
    opacity: COLORS.effects.projectile.collisionRadius.opacity,
    depthWrite: false,
  });
  private readonly projMatExplosion = new THREE.LineBasicMaterial({
    color: COLORS.effects.projectile.explosionRadius.colorHex,
    transparent: true,
    opacity: COLORS.effects.projectile.explosionRadius.opacity,
    depthWrite: false,
  });

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
  private readonly mediumFinInstanced: THREE.InstancedMesh;
  private readonly mediumFinMatrices: Float32Array;
  private readonly mediumFinColors = new Float32Array(PROJECTILE_INSTANCED_CAP * 3);
  private readonly mediumFinColorAttr = new THREE.InstancedBufferAttribute(
    this.mediumFinColors,
    3,
  );
  private readonly seenProjectileIds = new Set<number>();
  private readonly projectileRadiusMeshes = new Map<number, ProjectileRadiusMeshes>();
  private readonly projectileRadiusMeshPool: THREE.LineSegments[] = [];
  private readonly trailStamps = new IndexedEntityIdMap<TrailStampBuffer>();
  private readonly projectileAxisPose = new ProjectileAxisPoseBatch3D();
  // Scratch buffers reused across projectiles to avoid per-frame allocs.
  // resampleTrailCenterline fills tailCenterline with the drawn ring
  // centers, tailRingDist with each ring's arc distance behind the head,
  // and trailArcScratch with cumulative stamp-polyline arc lengths.
  private readonly tailCenterline = new Float32Array((PLASMA_HIGH_CURVE_SEGMENTS + 1) * 3);
  private readonly tailRingDist = new Float32Array(PLASMA_HIGH_CURVE_SEGMENTS + 1);
  private readonly trailArcScratch = new Float32Array(TRAIL_STAMP_CAP + 1);
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

    this.mediumFinInstanced = new THREE.InstancedMesh(
      this.projectileMediumFinGeom,
      this.projectileFinMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.mediumFinInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mediumFinMatrices = this.mediumFinInstanced.instanceMatrix.array as Float32Array;
    this.mediumFinColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.mediumFinInstanced.instanceColor = this.mediumFinColorAttr;
    this.mediumFinInstanced.frustumCulled = false;
    this.mediumFinInstanced.count = 0;
    this.world.add(this.mediumFinInstanced);
  }

  update(frameState: RenderFrameState3D, projectiles: readonly Entity[]): void {
    const renderNowMs = performance.now();
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
    let plasmaHighCount = 0;
    let plasmaMediumCount = 0;
    let plasmaLowCount = 0;
    let finCount = 0;
    let mediumFinCount = 0;
    const wantCol = getProjRangeToggle('collision');
    const wantExp = getProjRangeToggle('explosion');
    this.projectileAxisPose.begin(projectiles.length);
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
        this.composeProjectileTailPose(
          projectileAxisOutput,
          projectileIndex * projectileAxisOutputStride,
          tx,
          ty,
          tz,
          tailLength,
          tailRadius,
        );
        const stamps = this.advanceTrailStamps(e.id, proj, tx, ty, tz, tailLength);
        // DOT/CORE graphics ceilings still shed to the minimum plasma mesh;
        // they no longer make the projectile disappear altogether.
        const rung = drawProjectileTail
          ? sharedRung ?? detailRungForLevel(detailLevel)
          : DETAIL_RUNG_FAR;
        if (rung === DETAIL_RUNG_CLOSE && plasmaHighCount < PROJECTILE_INSTANCED_CAP) {
          const drawnSpan = this.resampleTrailCenterline(
            tx, ty, tz, stamps, tailLength, PLASMA_HIGH_SPEC.curveSegments,
          );
          this.writePlasmaGeometry(
            this.plasmaHigh,
            plasmaHighCount++,
            r,
            tailRadius,
            drawnSpan,
          );
        } else if (
          rung === DETAIL_RUNG_MID &&
          plasmaMediumCount < PROJECTILE_INSTANCED_CAP
        ) {
          const drawnSpan = this.resampleTrailCenterline(
            tx, ty, tz, stamps, tailLength, PLASMA_MEDIUM_SPEC.curveSegments,
          );
          this.writePlasmaGeometry(
            this.plasmaMedium,
            plasmaMediumCount++,
            r,
            tailRadius,
            drawnSpan,
          );
        } else if (plasmaLowCount < PROJECTILE_INSTANCED_CAP) {
          writeComposedMatrix(
            this.plasmaLowMatrices,
            plasmaLowCount++,
            this.projPos.x,
            this.projPos.y,
            this.projPos.z,
            this.projQuat,
            r,
            tailLength,
            r,
          );
        }
        this.updateProjRadiusMeshes(e, wantCol, wantExp);
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
      const rocketRung = emissionFarLod || (!drawProjectileTail && !drawProjectileFins)
        ? DETAIL_RUNG_FAR
        : rawRocketRung;

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
          writeComposedMatrix(
            this.mediumCylinderMatrices,
            mediumCylinderCount++,
            this.projPos.x,
            this.projPos.y,
            this.projPos.z,
            this.projQuat,
            this.projScale.x,
            this.projScale.y,
            this.projScale.z,
          );
        }
      } else if (rocketLowCount < PROJECTILE_INSTANCED_CAP) {
        writeComposedMatrix(
          this.rocketLowMatrices,
          rocketLowCount++,
          this.projPos.x,
          this.projPos.y,
          this.projPos.z,
          this.projQuat,
          r,
          tailLength,
          r,
        );
      }

      if (
        finSizeMult > 0 &&
        (rocketRung === DETAIL_RUNG_CLOSE || rocketRung === DETAIL_RUNG_MID)
      ) {
        const isRocketLike = proj?.config.shotProfile.runtime.isRocketLike === true;
        const rollAngle = proj && isRocketLike
          ? (renderNowMs + (e.id % 64) * 31) * ROCKET_FIN_ROLL_RATE_RAD_PER_MS
          : 0;
        const finRearOffset = tailLength + r * FIN_REAR_OVERHANG_MULT;
        this.composeProjectileFinPose(
          tx, ty, tz, finRearOffset, r * finSizeMult, rollAngle,
        );
        const medium = rocketRung === DETAIL_RUNG_MID;
        const slot = medium ? mediumFinCount : finCount;
        if (slot < PROJECTILE_INSTANCED_CAP) {
          const matrices = medium ? this.mediumFinMatrices : this.finMatrices;
          writeComposedMatrix(
            matrices,
            slot,
            this.projPos.x,
            this.projPos.y,
            this.projPos.z,
            this.finQuat,
            this.projScale.x,
            this.projScale.y,
            this.projScale.z,
          );
          if (proj) {
            this.finColor.set(getPlayerColors(proj.ownerId).primary);
            const colors = medium ? this.mediumFinColors : this.finColors;
            const colorOffset = slot * 3;
            colors[colorOffset] = this.finColor.r;
            colors[colorOffset + 1] = this.finColor.g;
            colors[colorOffset + 2] = this.finColor.b;
            if (!medium) this.markFinColorDirty(slot);
          }
          if (medium) mediumFinCount++;
          else finCount++;
        }
      }

      this.updateProjRadiusMeshes(e, wantCol, wantExp);
    }

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
    this.flushPlasmaGeometry(this.plasmaHigh, this.plasmaHighMesh, plasmaHighCount);
    this.flushPlasmaGeometry(this.plasmaMedium, this.plasmaMediumMesh, plasmaMediumCount);
    if (this.plasmaLowInstanced.count !== plasmaLowCount) {
      this.plasmaLowInstanced.count = plasmaLowCount;
    }
    if (plasmaLowCount > 0) {
      this.markInstanceMatrixRange(this.plasmaLowInstanced, 0, plasmaLowCount - 1);
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
    if (this.mediumFinInstanced.count !== mediumFinCount) {
      this.mediumFinInstanced.count = mediumFinCount;
    }
    if (mediumFinCount > 0) {
      this.markInstanceMatrixRange(this.mediumFinInstanced, 0, mediumFinCount - 1);
      this.mediumFinColorAttr.clearUpdateRanges();
      this.mediumFinColorAttr.addUpdateRange(0, mediumFinCount * 3);
      this.mediumFinColorAttr.needsUpdate = true;
    }

    if (pruneProjectiles) {
      for (const [id, radii] of this.projectileRadiusMeshes) {
        if (!seen.has(id)) {
          this.releaseProjRadiusMesh(radii.collision);
          this.releaseProjRadiusMesh(radii.explosion);
          this.projectileRadiusMeshes.delete(id);
        }
      }
      for (const id of this.trailStamps.keys()) {
        if (!seen.has(id)) this.trailStamps.delete(id);
      }
      this.lastProjectileEntitySetVersion = entitySetVersion;
      this.lastProjectileScopeVersion = scopeVersion;
    }
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
    disposeMesh(this.mediumFinInstanced, { material: false, geometry: false });
    for (const radii of this.projectileRadiusMeshes.values()) {
      if (radii.collision) {
        disposeMesh(radii.collision, { material: false, geometry: false });
      }
      if (radii.explosion) {
        disposeMesh(radii.explosion, { material: false, geometry: false });
      }
    }
    for (const mesh of this.projectileRadiusMeshPool) {
      disposeMesh(mesh, { material: false, geometry: false });
    }
    this.seenProjectileIds.clear();
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
      this.projectileMediumFinGeom,
    ]);
    disposeMaterials([
      this.projectileMat,
      this.plasmaMat,
      this.projectileFinMat,
      this.projMatCollision,
      this.projMatExplosion,
    ]);
  }

  // Shifts older stamps one slot deeper (dropping the oldest if at cap)
  // and writes the new stamp into slot 0.
  private insertTrailStamp(
    stamps: TrailStampBuffer,
    x: number,
    y: number,
    z: number,
    isReflection: boolean,
  ): void {
    const pts = stamps.points;
    const flags = stamps.flags;
    const newCount = Math.min(TRAIL_STAMP_CAP, stamps.count + 1);
    for (let i = newCount - 1; i >= 1; i--) {
      const dst = i * 3;
      const src = (i - 1) * 3;
      pts[dst] = pts[src];
      pts[dst + 1] = pts[src + 1];
      pts[dst + 2] = pts[src + 2];
      flags[i] = flags[i - 1];
    }
    pts[0] = x;
    pts[1] = y;
    pts[2] = z;
    flags[0] = isReflection ? 1 : 0;
    stamps.count = newCount;
  }

  private advanceTrailStamps(
    id: EntityId,
    proj: NonNullable<Entity['projectile']>,
    headX: number,
    headY: number,
    headZ: number,
    tailLength: number,
  ): TrailStampBuffer {
    let stamps = this.trailStamps.get(id);
    if (!stamps) {
      stamps = {
        points: new Float32Array(TRAIL_STAMP_CAP * 3),
        flags: new Uint8Array(TRAIL_STAMP_CAP),
        count: 0,
      };
      this.trailStamps.set(id, stamps);
    }

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
      this.insertTrailStamp(stamps, bounceX, bounceY, bounceZ, true);
      proj.pendingReflectionX = null;
      proj.pendingReflectionY = null;
      proj.pendingReflectionZ = null;
    }

    // Step size determines how far the head travels between stamps. We
    // pick one segment's worth of tail length so the recorded polyline
    // naturally spans the resample horizon when fully populated.
    const stampStep = Math.max(0.25, tailLength / PLASMA_HIGH_CURVE_SEGMENTS);
    const stampStepSq = stampStep * stampStep;
    const pts = stamps.points;
    let shouldStamp = stamps.count === 0;
    if (!shouldStamp) {
      const dx = headX - pts[0];
      const dy = headY - pts[1];
      const dz = headZ - pts[2];
      if (dx * dx + dy * dy + dz * dz >= stampStepSq) shouldStamp = true;
    }
    if (shouldStamp) this.insertTrailStamp(stamps, headX, headY, headZ, false);
    return stamps;
  }

  // Rebuilds tailCenterline + tailRingDist by resampling the stamp
  // polyline [head, stamp0, stamp1, ...] at uniform arc-length spacing
  // over the drawn span. This decouples the drawn rings from the raw
  // stamps: every ring position is a continuous function of head motion,
  // so laying or evicting a stamp never moves tail geometry (the old
  // one-stamp-per-ring centerline popped the tail tip forward a whole
  // segment every time the oldest stamp dropped off). Returns the drawn
  // span — the arc length the emitted tail actually covers, which is
  // shorter than tailLength while a young projectile accumulates path.
  //
  // Reflection kinks stay exact: the newest reflection stamp inside the
  // horizon gets a ring pinned onto it, because the kink is the player's
  // evidence that a shot bounced and uniform resampling alone would cut
  // the corner. The pin slides continuously: while the kink's arc
  // distance sits between ring slots j and j+1 (tau in [j, j+1)), ring j
  // holds the kink and ring j-1 walks linearly back to its uniform spot
  // from the kink duty it just finished. At every handoff the affected
  // rings coincide, so no ring ever teleports.
  private resampleTrailCenterline(
    headX: number,
    headY: number,
    headZ: number,
    stamps: TrailStampBuffer,
    tailLength: number,
    curveSegments: number,
  ): number {
    const pts = stamps.points;
    const count = stamps.count;
    const cum = this.trailArcScratch;
    cum[0] = 0;
    let prevX = headX, prevY = headY, prevZ = headZ;
    let total = 0;
    for (let k = 0; k < count; k++) {
      const o = k * 3;
      const dx = pts[o] - prevX;
      const dy = pts[o + 1] - prevY;
      const dz = pts[o + 2] - prevZ;
      total += Math.sqrt(dx * dx + dy * dy + dz * dz);
      cum[k + 1] = total;
      prevX = pts[o];
      prevY = pts[o + 1];
      prevZ = pts[o + 2];
    }

    const centerline = this.tailCenterline;
    const dists = this.tailRingDist;
    centerline[0] = headX;
    centerline[1] = headY;
    centerline[2] = headZ;
    dists[0] = 0;

    const drawnSpan = Math.min(tailLength, total);
    if (drawnSpan < 1e-4) {
      // No usable path yet (fresh spawn) — collapse every ring onto the
      // head. writePlasmaGeometry collapses the tail rings onto that point.
      for (let i = 1; i <= curveSegments; i++) {
        const dst = i * 3;
        centerline[dst] = headX;
        centerline[dst + 1] = headY;
        centerline[dst + 2] = headZ;
        dists[i] = 0;
      }
      return 0;
    }

    const step = drawnSpan / curveSegments;
    for (let i = 1; i <= curveSegments; i++) dists[i] = i * step;

    // Pin the newest reflection kink onto a ring (holder), and let the
    // ring that held it during the previous slot window relax home.
    const flags = stamps.flags;
    for (let k = 0; k < count; k++) {
      if (!flags[k]) continue;
      const d = cum[k + 1];
      const tau = d / step;
      const j = Math.floor(tau);
      // Ring 0 is the live head and the tip must stay at the span end,
      // so only interior rings hold the kink; once tau passes the last
      // segment, the kink and its relax window have left the drawn tail.
      if (j >= 1 && j < curveSegments) dists[j] = d;
      if (j >= 2 && j <= curveSegments) {
        dists[j - 1] = (2 * j - tau) * step;
      }
      break;
    }

    // Single forward walk emitting ring centers at each target distance
    // (dists is monotone by construction).
    let seg = 0;
    for (let i = 1; i <= curveSegments; i++) {
      let d = dists[i];
      if (d > total) d = total;
      while (seg < count - 1 && cum[seg + 1] < d) seg++;
      const segLen = cum[seg + 1] - cum[seg];
      let t = segLen > 1e-6 ? (d - cum[seg]) / segLen : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ao = (seg - 1) * 3;
      const ax = seg === 0 ? headX : pts[ao];
      const ay = seg === 0 ? headY : pts[ao + 1];
      const az = seg === 0 ? headZ : pts[ao + 2];
      const bo = seg * 3;
      const dst = i * 3;
      centerline[dst] = ax + (pts[bo] - ax) * t;
      centerline[dst + 1] = ay + (pts[bo + 1] - ay) * t;
      centerline[dst + 2] = az + (pts[bo + 2] - az) * t;
    }
    return drawnSpan;
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
    const centerline = this.tailCenterline;
    const dists = this.tailRingDist;
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
    wantCol: boolean,
    wantExp: boolean,
  ): void {
    const proj = entity.projectile;
    if (!proj) return;
    const profile = proj.config.shotProfile;
    if (!profile.runtime.isProjectile) return;

    if (!wantCol && !wantExp) {
      const existing = this.projectileRadiusMeshes.get(entity.id);
      if (existing) {
        if (existing.collision) setObjectVisibleIfChanged(existing.collision, false);
        if (existing.explosion) setObjectVisibleIfChanged(existing.explosion, false);
      }
      return;
    }

    let radii = this.projectileRadiusMeshes.get(entity.id);
    if (!radii) {
      radii = {};
      this.projectileRadiusMeshes.set(entity.id, radii);
    }

    const projX = entity.transform.x;
    const projY = entity.transform.y;
    const projZ = entity.transform.z;

    this.setProjRadiusMesh(
      radii, 'collision', wantCol,
      projX, projY, projZ,
      profile.runtime.radius.collision,
      this.projMatCollision,
    );
    this.setProjRadiusMesh(
      radii, 'explosion', wantExp && !proj.hasExploded,
      projX, projY, projZ,
      profile.runtime.deathExplosionRadius,
      this.projMatExplosion,
    );
  }

  private hideProjRadiusMeshes(entityId: EntityId): void {
    const radii = this.projectileRadiusMeshes.get(entityId);
    if (!radii) return;
    if (radii.collision) setObjectVisibleIfChanged(radii.collision, false);
    if (radii.explosion) setObjectVisibleIfChanged(radii.explosion, false);
  }

  private setProjRadiusMesh(
    radii: ProjectileRadiusMeshes,
    key: 'collision' | 'explosion',
    want: boolean,
    x: number, y: number, z: number,
    radius: number,
    mat: THREE.LineBasicMaterial,
  ): void {
    if (!want || radius <= 0) {
      const m = radii[key];
      if (m) setObjectVisibleIfChanged(m, false);
      return;
    }
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
function createProjectileFinGeometry(extruded: boolean = true): THREE.BufferGeometry {
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
    if (!extruded) {
      // One double-sided material triangle per authored fin. It retains
      // the exact three-fin silhouette/roll transform while shedding the
      // hidden prism thickness at Medium.
      return [...A, ...B, ...C];
    }
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
  const indices = new Uint32Array(capacity * spec.indicesPerShot);
  for (let slot = 0; slot < capacity; slot++) {
    const vertexBase = slot * spec.verticesPerShot;
    const nose = vertexBase;
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
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  return { spec, geometry, positions, positionAttr };
}

/** Four triangles total: one equilateral front face and three long faces
 *  meeting at the rear tail point. Local +Y is the projectile rearward
 *  axis; the caller scales Y to the authored plasma-tail length. */
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
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}
