import * as THREE from 'three';
import { getProjRangeToggle } from '@/clientBarConfig';
import { COLORS } from '@/colorsConfig';
import type { Entity, EntityId } from '../sim/types';
import { getPlayerColors } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { RenderFrameState3D } from './RenderFrameState3D';
import {
  detachObject,
  disposeGeometries,
  disposeMaterials,
  disposeMesh,
} from './threeUtils';

const PROJECTILE_MIN_RADIUS = 0.5;
// 1 revolution per second.
const ROCKET_FIN_ROLL_RATE_RAD_PER_MS = (Math.PI * 2) / 2000;
// Multiples of the rocket body radius — how far the fin rear edge sits
// past the cylinder tail end. Avoids color z-fight at the tail cap.
const FIN_REAR_OVERHANG_MULT = 0.75;
const PROJECTILE_INSTANCED_CAP = 8192;
const PROJECTILE_ROCKET_FIN_COUNT = 3;
const CURVED_CONE_CURVE_SEGMENTS = 6;
const CURVED_CONE_RADIAL_SEGMENTS = 10;
const CURVED_CONE_VERTS_PER_TAIL = (CURVED_CONE_CURVE_SEGMENTS + 1) * CURVED_CONE_RADIAL_SEGMENTS;
const CURVED_CONE_INDICES_PER_TAIL = CURVED_CONE_CURVE_SEGMENTS * CURVED_CONE_RADIAL_SEGMENTS * 6;
// Trail stamps form the centerline of the tail tube. Vertex 0 is the
// live head (entity transform, every frame); vertices 1..N are stamps
// frozen in render space the moment they were laid down, so MOVE POS /
// VEL EMAs only ever affect the head — old stamps don't drift around
// behind the projectile. CAP is one less than the axial vertex count
// because the live head occupies the leading slot.
const TRAIL_STAMP_CAP = CURVED_CONE_CURVE_SEGMENTS;
const TRAIL_MIN_TANGENT_SQ = 1e-6;
const PROJ_CYL_AXIS = new THREE.Vector3(0, 1, 0);
const CURVED_CONE_COS = Array.from(
  { length: CURVED_CONE_RADIAL_SEGMENTS },
  (_, i) => Math.cos((i / CURVED_CONE_RADIAL_SEGMENTS) * Math.PI * 2),
);
const CURVED_CONE_SIN = Array.from(
  { length: CURVED_CONE_RADIAL_SEGMENTS },
  (_, i) => Math.sin((i / CURVED_CONE_RADIAL_SEGMENTS) * Math.PI * 2),
);

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
  // recent stamp; slot count-1 is the oldest. Unused slots are dropped
  // when stamping past the cap (the oldest stamp is evicted).
  points: Float32Array;
  count: number;
};

type DynamicCurvedConeGeometry = {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  normals: Float32Array;
  positionAttr: THREE.BufferAttribute;
  normalAttr: THREE.BufferAttribute;
};

export type ProjectileRenderer3DOptions = {
  world: THREE.Group;
  clientViewState: ClientViewState;
  scope: ViewportFootprint;
  radiusSphereGeom: THREE.BufferGeometry;
};

export class ProjectileRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly scope: ViewportFootprint;
  private readonly radiusSphereGeom: THREE.BufferGeometry;

  private readonly projectileGeom = new THREE.SphereGeometry(1, 10, 8);
  private readonly projectileCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private readonly projectileFinGeom = createProjectileFinGeometry();
  private readonly projectileMat = new THREE.MeshLambertMaterial({
    color: COLORS.effects.projectile.body.colorHex,
  });
  private readonly projectileCurvedConeMat = new THREE.MeshLambertMaterial({
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
  private readonly curvedCone: DynamicCurvedConeGeometry;
  private readonly curvedConeMesh: THREE.Mesh;
  private readonly finInstanced: THREE.InstancedMesh;
  private readonly finMatrices: Float32Array;
  private readonly finColors = new Float32Array(PROJECTILE_INSTANCED_CAP * 3);
  private readonly finColorAttr = new THREE.InstancedBufferAttribute(this.finColors, 3);
  private readonly seenProjectileIds = new Set<number>();
  private readonly projectileRadiusMeshes = new Map<number, ProjectileRadiusMeshes>();
  private readonly projectileRadiusMeshPool: THREE.LineSegments[] = [];
  private readonly trailStamps = new Map<EntityId, TrailStampBuffer>();
  // Scratch buffer used inside writeProjectileCurvedConeTail to assemble
  // the full (CURVED_CONE_CURVE_SEGMENTS + 1) * 3 centerline before
  // emitting rings. Reused across projectiles to avoid per-frame allocs.
  private readonly tailCenterline = new Float32Array((CURVED_CONE_CURVE_SEGMENTS + 1) * 3);
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
  private finColorDirty = false;

  constructor(options: ProjectileRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.scope = options.scope;
    this.radiusSphereGeom = options.radiusSphereGeom;

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

    this.curvedCone = createProjectileCurvedConeGeometry(PROJECTILE_INSTANCED_CAP);
    this.curvedConeMesh = new THREE.Mesh(this.curvedCone.geometry, this.projectileCurvedConeMat);
    this.curvedConeMesh.frustumCulled = false;
    this.curvedConeMesh.visible = false;
    this.world.add(this.curvedConeMesh);

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
  }

  update(frameState: RenderFrameState3D, projectiles: readonly Entity[]): void {
    const seen = this.seenProjectileIds;
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const scopeVersion = this.scope.getVersion();
    const pruneProjectiles =
      entitySetVersion !== this.lastProjectileEntitySetVersion ||
      (this.scope.getMode() !== 'all' && scopeVersion !== this.lastProjectileScopeVersion);
    if (pruneProjectiles) seen.clear();

    let sphereCount = 0;
    let cylinderCount = 0;
    let curvedConeCount = 0;
    let finCount = 0;
    const wantCol = getProjRangeToggle('collision');
    const wantExp = getProjRangeToggle('explosion');
    const projectileStyle = frameState.gfx.projectileStyle;
    const drawProjectileTail = projectileStyle !== 'dot' && projectileStyle !== 'core';
    const drawProjectileFins = projectileStyle === 'full';

    for (const e of projectiles) {
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
      const radius = shotProfile?.runtime.radius.visual ?? 4;
      const visualRadius = radius;
      const r = Math.max(visualRadius, PROJECTILE_MIN_RADIUS);

      if (sphereCount >= PROJECTILE_INSTANCED_CAP) {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }
      writeTranslateScaleMatrix(
        this.sphereMatrices,
        sphereCount++,
        tx, tz, ty,
        r, r, r,
      );

      const tailShape = drawProjectileTail
        ? visualProfile?.projectileTailShape ?? 'cone'
        : 'none';
      const finSizeMult = drawProjectileFins
        ? visualProfile?.projectileFinSizeMult ?? 0
        : 0;
      if (tailShape !== 'none' || finSizeMult > 0) {
        const tailLength = r * (visualProfile?.projectileTailLengthMult ?? 8);
        const tailRadius = r * (visualProfile?.projectileTailRadiusMult ?? 1);
        this.composeProjectileTailPose(e, tx, ty, tz, tailLength, tailRadius);
        if (tailShape === 'cylinder') {
          if (cylinderCount < PROJECTILE_INSTANCED_CAP) {
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
        } else if (
          tailShape === 'cone' &&
          curvedConeCount < PROJECTILE_INSTANCED_CAP &&
          proj
        ) {
          const stamps = this.advanceTrailStamps(e.id, proj, tx, ty, tz, tailLength);
          if (stamps.count >= 1) {
            this.writeProjectileCurvedConeTail(
              curvedConeCount++,
              tx, ty, tz,
              stamps,
              tailRadius,
            );
          }
        }
        if (finSizeMult > 0 && finCount < PROJECTILE_INSTANCED_CAP) {
          const isRocketLike = proj?.config.shotProfile.runtime.isRocketLike === true;
          const rollAngle = proj && isRocketLike
            ? proj.timeAlive * ROCKET_FIN_ROLL_RATE_RAD_PER_MS
            : 0;
          // Push the fin's rear edge past the cylinder tail end so the
          // white fin tips don't z-fight with the rocket body cap.
          const finRearOffset = tailLength + r * FIN_REAR_OVERHANG_MULT;
          this.composeProjectileFinPose(tx, ty, tz, finRearOffset, r * finSizeMult, rollAngle);
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
            this.finColor.set(getPlayerColors(proj.ownerId).primary);
            const colorOffset = finCount * 3;
            this.finColors[colorOffset] = this.finColor.r;
            this.finColors[colorOffset + 1] = this.finColor.g;
            this.finColors[colorOffset + 2] = this.finColor.b;
            this.finColorDirty = true;
          }
          finCount++;
        }
      }

      this.updateProjRadiusMeshes(e, wantCol, wantExp);
    }

    this.sphereInstanced.count = sphereCount;
    if (sphereCount > 0) {
      this.markInstanceMatrixRange(this.sphereInstanced, 0, sphereCount - 1);
    }
    this.cylinderInstanced.count = cylinderCount;
    if (cylinderCount > 0) {
      this.markInstanceMatrixRange(this.cylinderInstanced, 0, cylinderCount - 1);
    }
    this.flushCurvedConeGeometry(curvedConeCount);
    this.finInstanced.count = finCount;
    if (finCount > 0) {
      this.markInstanceMatrixRange(this.finInstanced, 0, finCount - 1);
    }
    if (this.finColorDirty && this.finInstanced.instanceColor) {
      this.finInstanced.instanceColor.clearUpdateRanges();
      this.finInstanced.instanceColor.addUpdateRange(0, finCount * 3);
      this.finInstanced.instanceColor.needsUpdate = true;
      this.finColorDirty = false;
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
    disposeMesh(this.curvedConeMesh, { material: false, geometry: false });
    disposeMesh(this.finInstanced, { material: false, geometry: false });
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
      this.curvedCone.geometry,
      this.projectileFinGeom,
    ]);
    disposeMaterials([
      this.projectileMat,
      this.projectileCurvedConeMat,
      this.projectileFinMat,
      this.projMatCollision,
      this.projMatExplosion,
    ]);
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
      stamps = { points: new Float32Array(TRAIL_STAMP_CAP * 3), count: 0 };
      this.trailStamps.set(id, stamps);
    }
    const pts = stamps.points;

    // Forced reflection stamp: ClientViewState parks the exact
    // shield-sphere / shield-panel contact point on the projectile after each
    // bounce. Insert it ahead of the head's regular distance-threshold
    // stamp so the trail kinks at the actual shield surface rather than
    // one tick past it. The pre-bounce stamps shift deeper into the
    // buffer untouched, preserving the incoming arc.
    const bounceX = proj.pendingReflectionX;
    const bounceY = proj.pendingReflectionY;
    const bounceZ = proj.pendingReflectionZ;
    if (bounceX !== undefined && bounceY !== undefined && bounceZ !== undefined) {
      const newCount = Math.min(TRAIL_STAMP_CAP, stamps.count + 1);
      for (let i = newCount - 1; i >= 1; i--) {
        const dst = i * 3;
        const src = (i - 1) * 3;
        pts[dst] = pts[src];
        pts[dst + 1] = pts[src + 1];
        pts[dst + 2] = pts[src + 2];
      }
      pts[0] = bounceX;
      pts[1] = bounceY;
      pts[2] = bounceZ;
      stamps.count = newCount;
      proj.pendingReflectionX = undefined;
      proj.pendingReflectionY = undefined;
      proj.pendingReflectionZ = undefined;
    }

    // Step size determines how far the head travels between stamps. We
    // pick one segment's worth of tail length so the trail naturally
    // spans the configured visual length when fully populated.
    const stampStep = Math.max(0.25, tailLength / CURVED_CONE_CURVE_SEGMENTS);
    const stampStepSq = stampStep * stampStep;
    let shouldStamp = stamps.count === 0;
    if (!shouldStamp) {
      const dx = headX - pts[0];
      const dy = headY - pts[1];
      const dz = headZ - pts[2];
      if (dx * dx + dy * dy + dz * dz >= stampStepSq) shouldStamp = true;
    }
    if (shouldStamp) {
      const newCount = Math.min(TRAIL_STAMP_CAP, stamps.count + 1);
      // Shift older stamps one slot deeper, dropping the oldest if at cap.
      for (let i = newCount - 1; i >= 1; i--) {
        const dst = i * 3;
        const src = (i - 1) * 3;
        pts[dst] = pts[src];
        pts[dst + 1] = pts[src + 1];
        pts[dst + 2] = pts[src + 2];
      }
      pts[0] = headX;
      pts[1] = headY;
      pts[2] = headZ;
      stamps.count = newCount;
    }
    return stamps;
  }

  private writeProjectileCurvedConeTail(
    slot: number,
    headX: number,
    headY: number,
    headZ: number,
    stamps: TrailStampBuffer,
    radius: number,
  ): void {
    // Centerline layout: vertex 0 is the live head, vertices 1..N are
    // stamped points in newest→oldest order. When fewer than N stamps
    // exist (just-spawned projectile), pad with copies of the oldest
    // available point — the ring radius taper hides the collapsed tail.
    const centerline = this.tailCenterline;
    centerline[0] = headX;
    centerline[1] = headY;
    centerline[2] = headZ;
    const pts = stamps.points;
    const count = stamps.count;
    for (let i = 1; i <= CURVED_CONE_CURVE_SEGMENTS; i++) {
      const stampIdx = i - 1 < count ? i - 1 : count - 1;
      const src = stampIdx * 3;
      const dst = i * 3;
      centerline[dst] = pts[src];
      centerline[dst + 1] = pts[src + 1];
      centerline[dst + 2] = pts[src + 2];
    }

    const positions = this.curvedCone.positions;
    const normals = this.curvedCone.normals;
    const vertexBase = slot * CURVED_CONE_VERTS_PER_TAIL;
    for (let segment = 0; segment <= CURVED_CONE_CURVE_SEGMENTS; segment++) {
      const ci = segment * 3;
      const px = centerline[ci];
      const py = centerline[ci + 1];
      const pz = centerline[ci + 2];

      // Tangent via centered difference (forward at the head, backward
      // at the tail end). Direction sign doesn't matter — setCurveBasis
      // only uses it to build an orthonormal frame for the ring.
      let tanX: number, tanY: number, tanZ: number;
      if (segment === 0) {
        tanX = centerline[3] - px;
        tanY = centerline[4] - py;
        tanZ = centerline[5] - pz;
      } else if (segment === CURVED_CONE_CURVE_SEGMENTS) {
        const pi = (segment - 1) * 3;
        tanX = px - centerline[pi];
        tanY = py - centerline[pi + 1];
        tanZ = pz - centerline[pi + 2];
      } else {
        const ni = (segment + 1) * 3;
        const pi = (segment - 1) * 3;
        tanX = centerline[ni] - centerline[pi];
        tanY = centerline[ni + 1] - centerline[pi + 1];
        tanZ = centerline[ni + 2] - centerline[pi + 2];
      }
      if (tanX * tanX + tanY * tanY + tanZ * tanZ < TRAIL_MIN_TANGENT_SQ) {
        // Padded collapsed tail — fall back to a stable axis so we don't
        // emit NaN rings.
        tanX = 0; tanY = 0; tanZ = 1;
      }
      this.setCurveBasis(tanX, tanY, tanZ);

      const u = segment / CURVED_CONE_CURVE_SEGMENTS;
      const ringRadius = radius * (1 - u);
      for (let radial = 0; radial < CURVED_CONE_RADIAL_SEGMENTS; radial++) {
        const normalX = this.curveRight.x * CURVED_CONE_COS[radial] +
          this.curveUp.x * CURVED_CONE_SIN[radial];
        const normalY = this.curveRight.y * CURVED_CONE_COS[radial] +
          this.curveUp.y * CURVED_CONE_SIN[radial];
        const normalZ = this.curveRight.z * CURVED_CONE_COS[radial] +
          this.curveUp.z * CURVED_CONE_SIN[radial];
        const out = (vertexBase + segment * CURVED_CONE_RADIAL_SEGMENTS + radial) * 3;
        positions[out] = px + normalX * ringRadius;
        positions[out + 1] = pz + normalY * ringRadius;
        positions[out + 2] = py + normalZ * ringRadius;
        normals[out] = normalX;
        normals[out + 1] = normalY;
        normals[out + 2] = normalZ;
      }
    }
  }

  private setCurveBasis(tangentX: number, tangentY: number, tangentZ: number): void {
    this.curveTangent.set(tangentX, tangentZ, tangentY);
    if (this.curveTangent.lengthSq() <= 1e-8) {
      this.curveTangent.set(0, 0, -1);
    } else {
      this.curveTangent.normalize();
    }
    if (Math.abs(this.curveTangent.y) < 0.92) {
      this.curveReference.set(0, 1, 0);
    } else {
      this.curveReference.set(1, 0, 0);
    }
    this.curveRight.crossVectors(this.curveReference, this.curveTangent).normalize();
    this.curveUp.crossVectors(this.curveTangent, this.curveRight).normalize();
  }

  private flushCurvedConeGeometry(count: number): void {
    this.curvedConeMesh.visible = count > 0;
    this.curvedCone.geometry.setDrawRange(0, count * CURVED_CONE_INDICES_PER_TAIL);
    if (count <= 0) return;

    const updatedComponents = count * CURVED_CONE_VERTS_PER_TAIL * 3;
    this.curvedCone.positionAttr.clearUpdateRanges();
    this.curvedCone.positionAttr.addUpdateRange(0, updatedComponents);
    this.curvedCone.positionAttr.needsUpdate = true;
    this.curvedCone.normalAttr.clearUpdateRanges();
    this.curvedCone.normalAttr.addUpdateRange(0, updatedComponents);
    this.curvedCone.normalAttr.needsUpdate = true;
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
    entity: Entity,
    x: number, y: number, z: number,
    length: number,
    radius: number,
  ): void {
    const proj = entity.projectile;
    if (proj) {
      const vx = proj.velocityX, vy = proj.velocityY, vz = proj.velocityZ;
      const len2 = vx * vx + vy * vy + vz * vz;
      if (len2 > 1e-6) {
        const inv = 1 / Math.sqrt(len2);
        this.projDir.set(-vx * inv, -vz * inv, -vy * inv);
      } else {
        this.projDir.set(
          -Math.cos(entity.transform.rotation),
          0,
          -Math.sin(entity.transform.rotation),
        );
      }
    } else {
      this.projDir.set(0, 0, -1);
    }
    this.projQuat.setFromUnitVectors(PROJ_CYL_AXIS, this.projDir);
    this.projPos.set(
      x + this.projDir.x * length * 0.5,
      z + this.projDir.y * length * 0.5,
      y + this.projDir.z * length * 0.5,
    );
    this.projScale.set(radius, length, radius);
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
        if (existing.collision) existing.collision.visible = false;
        if (existing.explosion) existing.explosion.visible = false;
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
    if (radii.collision) radii.collision.visible = false;
    if (radii.explosion) radii.explosion.visible = false;
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
      if (m) m.visible = false;
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
    mesh.visible = true;
    mesh.position.set(x, z, y);
    mesh.scale.setScalar(radius);
  }

  private releaseProjRadiusMesh(mesh?: THREE.LineSegments): void {
    if (!mesh) return;
    mesh.visible = false;
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
  const verts = new Float32Array(
    Array.from({ length: PROJECTILE_ROCKET_FIN_COUNT }, (_, i) =>
      fin((i / PROJECTILE_ROCKET_FIN_COUNT) * Math.PI * 2),
    ).flat(),
  );
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geom.computeVertexNormals();
  return geom;
}

function createProjectileCurvedConeGeometry(capacity: number): DynamicCurvedConeGeometry {
  const positions = new Float32Array(capacity * CURVED_CONE_VERTS_PER_TAIL * 3);
  const normals = new Float32Array(capacity * CURVED_CONE_VERTS_PER_TAIL * 3);
  const indices = new Uint32Array(capacity * CURVED_CONE_INDICES_PER_TAIL);
  for (let slot = 0; slot < capacity; slot++) {
    const vertexBase = slot * CURVED_CONE_VERTS_PER_TAIL;
    let indexOut = slot * CURVED_CONE_INDICES_PER_TAIL;
    for (let segment = 0; segment < CURVED_CONE_CURVE_SEGMENTS; segment++) {
      const ringA = vertexBase + segment * CURVED_CONE_RADIAL_SEGMENTS;
      const ringB = ringA + CURVED_CONE_RADIAL_SEGMENTS;
      for (let radial = 0; radial < CURVED_CONE_RADIAL_SEGMENTS; radial++) {
        const next = (radial + 1) % CURVED_CONE_RADIAL_SEGMENTS;
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
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  const normalAttr = new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('normal', normalAttr);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.setDrawRange(0, 0);
  return { geometry, positions, normals, positionAttr, normalAttr };
}
