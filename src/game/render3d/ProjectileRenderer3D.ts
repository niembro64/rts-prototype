import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import { getProjRangeToggle } from '@/clientBarConfig';
import type { Entity, EntityId } from '../sim/types';
import type { ClientViewState } from '../network/ClientViewState';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { Lod3DState } from './Lod3D';
import {
  objectLodToGraphicsTier,
  type RenderObjectLodTier,
} from './RenderObjectLod';
import {
  detachObject,
  disposeGeometries,
  disposeMaterials,
  disposeMesh,
} from './threeUtils';

const PROJECTILE_MIN_RADIUS = 1.5;
const PROJECTILE_INSTANCED_CAP = 8192;
const CURVED_CONE_CURVE_SEGMENTS = 6;
const CURVED_CONE_RADIAL_SEGMENTS = 10;
const CURVED_CONE_VERTS_PER_TAIL = (CURVED_CONE_CURVE_SEGMENTS + 1) * CURVED_CONE_RADIAL_SEGMENTS;
const CURVED_CONE_INDICES_PER_TAIL = CURVED_CONE_CURVE_SEGMENTS * CURVED_CONE_RADIAL_SEGMENTS * 6;
const TAIL_HISTORY_MAX_SAMPLES = 5;
const TAIL_HISTORY_MIN_MOVE_SQ = 0.01;
const TAIL_HISTORY_MIN_AGE_SEC = 1 / 240;
const PROJ_CYL_AXIS = new THREE.Vector3(0, 1, 0);
const IDENTITY_QUAT = new THREE.Quaternion();
const CURVED_CONE_COS = Array.from(
  { length: CURVED_CONE_RADIAL_SEGMENTS },
  (_, i) => Math.cos((i / CURVED_CONE_RADIAL_SEGMENTS) * Math.PI * 2),
);
const CURVED_CONE_SIN = Array.from(
  { length: CURVED_CONE_RADIAL_SEGMENTS },
  (_, i) => Math.sin((i / CURVED_CONE_RADIAL_SEGMENTS) * Math.PI * 2),
);

const PROJECTILE_RADIUS_BY_TIER: Record<ConcreteGraphicsQuality, number> = {
  min: 0.7,
  low: 0.8,
  medium: 0.9,
  high: 1,
  max: 1,
};

type ProjectileRadiusMeshes = {
  collision?: THREE.LineSegments;
  explosion?: THREE.LineSegments;
};

type ProjectileTailHistory = {
  samples: number;
  x0: number; y0: number; z0: number; t0: number;
  x1: number; y1: number; z1: number; t1: number;
  x2: number; y2: number; z2: number; t2: number;
  x3: number; y3: number; z3: number; t3: number;
  x4: number; y4: number; z4: number; t4: number;
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
  resolveObjectLod: (entity: Entity) => RenderObjectLodTier;
};

export class ProjectileRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly scope: ViewportFootprint;
  private readonly radiusSphereGeom: THREE.BufferGeometry;
  private readonly resolveObjectLod: (entity: Entity) => RenderObjectLodTier;

  private readonly projectileGeom = new THREE.SphereGeometry(1, 10, 8);
  private readonly projectileCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private readonly projectileFinGeom = createProjectileFinGeometry();
  private readonly projectileMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  private readonly projectileCurvedConeMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  private readonly projectileFinMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
  });
  private readonly projMatCollision = new THREE.LineBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  private readonly projMatExplosion = new THREE.LineBasicMaterial({
    color: 0xff8844,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
  });

  private readonly sphereInstanced: THREE.InstancedMesh;
  private readonly cylinderInstanced: THREE.InstancedMesh;
  private readonly curvedCone: DynamicCurvedConeGeometry;
  private readonly curvedConeMesh: THREE.Mesh;
  private readonly finInstanced: THREE.InstancedMesh;
  private readonly seenProjectileIds = new Set<number>();
  private readonly projectileRenderScratch: Entity[] = [];
  private readonly projectileRadiusMeshes = new Map<number, ProjectileRadiusMeshes>();
  private readonly projectileRadiusMeshPool: THREE.LineSegments[] = [];
  private readonly projectileTailHistories = new Map<number, ProjectileTailHistory>();
  private lastProjectileEntitySetVersion = -1;

  private readonly projDir = new THREE.Vector3();
  private readonly projQuat = new THREE.Quaternion();
  private readonly projPos = new THREE.Vector3();
  private readonly projScale = new THREE.Vector3();
  private readonly projMatrix = new THREE.Matrix4();
  private readonly curveTangent = new THREE.Vector3();
  private readonly curveRight = new THREE.Vector3();
  private readonly curveUp = new THREE.Vector3();
  private readonly curveReference = new THREE.Vector3();

  constructor(options: ProjectileRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.scope = options.scope;
    this.radiusSphereGeom = options.radiusSphereGeom;
    this.resolveObjectLod = options.resolveObjectLod;

    this.sphereInstanced = new THREE.InstancedMesh(
      this.projectileGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.sphereInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sphereInstanced.frustumCulled = false;
    this.sphereInstanced.count = 0;
    this.world.add(this.sphereInstanced);

    this.cylinderInstanced = new THREE.InstancedMesh(
      this.projectileCylinderGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.cylinderInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
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
    this.finInstanced.frustumCulled = false;
    this.finInstanced.count = 0;
    this.world.add(this.finInstanced);
  }

  update(lod: Lod3DState): void {
    const projectiles = this.clientViewState.collectTravelingProjectiles(
      this.projectileRenderScratch,
    );
    const seen = this.seenProjectileIds;
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const pruneProjectiles = entitySetVersion !== this.lastProjectileEntitySetVersion;
    if (pruneProjectiles) seen.clear();

    let sphereCount = 0;
    let cylinderCount = 0;
    let curvedConeCount = 0;
    let finCount = 0;
    const wantCol = getProjRangeToggle('collision');
    const wantExp = getProjRangeToggle('explosion');
    const now = performance.now();

    for (const e of projectiles) {
      if (pruneProjectiles) seen.add(e.id);
      const tx = e.transform.x;
      const ty = e.transform.y;
      const tz = e.transform.z;
      const tailHistory = this.recordProjectileTailHistory(e.id, tx, ty, tz, now);

      if (!this.scope.inScope(tx, ty, 50)) {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }

      const objectTier = this.resolveObjectLod(e);
      if (objectTier === 'marker') {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }

      const projectileGraphicsTier = objectLodToGraphicsTier(objectTier, lod.gfx.tier);
      const richProjectile =
        objectTier === 'rich' || objectTier === 'hero' || objectTier === 'simple';
      const visualProfile = e.projectile?.config.shotProfile.visual;
      const radius = visualProfile?.projectileBodyRadius ?? 4;
      const radiusScale = PROJECTILE_RADIUS_BY_TIER[projectileGraphicsTier];
      const visualRadius = radius * radiusScale;
      const r = Math.max(visualRadius, PROJECTILE_MIN_RADIUS);

      this.projPos.set(tx, tz, ty);

      if (sphereCount >= PROJECTILE_INSTANCED_CAP) {
        this.hideProjRadiusMeshes(e.id);
        continue;
      }
      this.projScale.set(r, r, r);
      this.projMatrix.compose(this.projPos, IDENTITY_QUAT, this.projScale);
      this.sphereInstanced.setMatrixAt(sphereCount++, this.projMatrix);

      const tailShape = visualProfile?.projectileTailShape ?? 'cone';
      const finSizeMult = visualProfile?.projectileFinSizeMult ?? 0;
      if (tailShape !== 'none' || finSizeMult > 0) {
        const tailLength = r * (visualProfile?.projectileTailLengthMult ?? 8);
        const tailRadius = r * (visualProfile?.projectileTailRadiusMult ?? 1);
        this.composeProjectileTailMatrix(e, tx, ty, tz, tailLength, tailRadius);
        if (tailShape === 'cylinder') {
          if (cylinderCount < PROJECTILE_INSTANCED_CAP) {
            this.cylinderInstanced.setMatrixAt(cylinderCount++, this.projMatrix);
          }
        } else if (tailShape === 'cone' && curvedConeCount < PROJECTILE_INSTANCED_CAP) {
          this.writeProjectileCurvedConeTail(
            curvedConeCount++,
            e,
            tailHistory,
            tailLength,
            tailRadius,
          );
        }
        if (finSizeMult > 0 && finCount < PROJECTILE_INSTANCED_CAP) {
          this.composeProjectileFinMatrix(tx, ty, tz, tailLength, r * finSizeMult);
          this.finInstanced.setMatrixAt(finCount++, this.projMatrix);
        }
      }

      if (richProjectile) {
        this.updateProjRadiusMeshes(e, wantCol, wantExp);
      } else {
        this.hideProjRadiusMeshes(e.id);
      }
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

    if (pruneProjectiles) {
      for (const [id, radii] of this.projectileRadiusMeshes) {
        if (!seen.has(id)) {
          this.releaseProjRadiusMesh(radii.collision);
          this.releaseProjRadiusMesh(radii.explosion);
          this.projectileRadiusMeshes.delete(id);
        }
      }
      for (const id of this.projectileTailHistories.keys()) {
        if (!seen.has(id)) {
          this.projectileTailHistories.delete(id);
        }
      }
      this.lastProjectileEntitySetVersion = entitySetVersion;
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

  private recordProjectileTailHistory(
    id: EntityId,
    x: number,
    y: number,
    z: number,
    nowMs: number,
  ): ProjectileTailHistory {
    let history = this.projectileTailHistories.get(id);
    if (!history) {
      history = {
        samples: 1,
        x0: x, y0: y, z0: z, t0: nowMs,
        x1: x, y1: y, z1: z, t1: nowMs,
        x2: x, y2: y, z2: z, t2: nowMs,
        x3: x, y3: y, z3: z, t3: nowMs,
        x4: x, y4: y, z4: z, t4: nowMs,
      };
      this.projectileTailHistories.set(id, history);
      return history;
    }

    const dx = x - history.x0;
    const dy = y - history.y0;
    const dz = z - history.z0;
    if (dx * dx + dy * dy + dz * dz < TAIL_HISTORY_MIN_MOVE_SQ) return history;

    history.x4 = history.x3; history.y4 = history.y3; history.z4 = history.z3; history.t4 = history.t3;
    history.x3 = history.x2; history.y3 = history.y2; history.z3 = history.z2; history.t3 = history.t2;
    history.x2 = history.x1; history.y2 = history.y1; history.z2 = history.z1; history.t2 = history.t1;
    history.x1 = history.x0; history.y1 = history.y0; history.z1 = history.z0; history.t1 = history.t0;
    history.x0 = x; history.y0 = y; history.z0 = z; history.t0 = nowMs;
    history.samples = Math.min(TAIL_HISTORY_MAX_SAMPLES, history.samples + 1);
    return history;
  }

  private writeProjectileCurvedConeTail(
    slot: number,
    entity: Entity,
    history: ProjectileTailHistory,
    length: number,
    radius: number,
  ): void {
    const proj = entity.projectile;
    const vx = proj?.velocityX ?? 0;
    const vy = proj?.velocityY ?? 0;
    const vz = proj?.velocityZ ?? 0;
    const speed = Math.hypot(vx, vy, vz);
    let ax = 0;
    let ay = 0;
    let az = 0;
    let bx = 0;
    let by = 0;
    let bz = 0;
    let useParabola = false;

    if (history.samples >= 3 && speed > 1e-6) {
      let s2 = 0;
      let s3 = 0;
      let s4 = 0;
      let rx1 = 0; let ry1 = 0; let rz1 = 0;
      let rx2 = 0; let ry2 = 0; let rz2 = 0;
      let validSamples = 0;

      for (let sample = 1; sample < history.samples; sample++) {
        let sx = history.x1;
        let sy = history.y1;
        let sz = history.z1;
        let st = history.t1;
        if (sample === 2) {
          sx = history.x2; sy = history.y2; sz = history.z2; st = history.t2;
        } else if (sample === 3) {
          sx = history.x3; sy = history.y3; sz = history.z3; st = history.t3;
        } else if (sample === 4) {
          sx = history.x4; sy = history.y4; sz = history.z4; st = history.t4;
        }

        const age = (history.t0 - st) / 1000;
        if (age < TAIL_HISTORY_MIN_AGE_SEC) continue;
        const age2 = age * age;
        s2 += age2;
        s3 += age2 * age;
        s4 += age2 * age2;
        const dx = sx - history.x0;
        const dy = sy - history.y0;
        const dz = sz - history.z0;
        rx1 += age * dx;
        ry1 += age * dy;
        rz1 += age * dz;
        rx2 += age2 * dx;
        ry2 += age2 * dy;
        rz2 += age2 * dz;
        validSamples++;
      }

      const denom = s2 * s4 - s3 * s3;
      if (validSamples >= 2 && Math.abs(denom) > 1e-9) {
        const invDenom = 1 / denom;
        bx = (rx1 * s4 - rx2 * s3) * invDenom;
        by = (ry1 * s4 - ry2 * s3) * invDenom;
        bz = (rz1 * s4 - rz2 * s3) * invDenom;
        ax = (s2 * rx2 - s3 * rx1) * invDenom;
        ay = (s2 * ry2 - s3 * ry1) * invDenom;
        az = (s2 * rz2 - s3 * rz1) * invDenom;
        useParabola = Number.isFinite(ax + ay + az + bx + by + bz);
      }
    }

    if (!useParabola) {
      const inv = speed > 1e-6 ? 1 / speed : 0;
      bx = speed > 1e-6 ? -vx * inv * speed : -Math.cos(entity.transform.rotation);
      by = speed > 1e-6 ? -vy * inv * speed : -Math.sin(entity.transform.rotation);
      bz = speed > 1e-6 ? -vz * inv * speed : 0;
    }

    const tailTimeSec = speed > 1e-6 ? length / speed : length;
    const positions = this.curvedCone.positions;
    const normals = this.curvedCone.normals;
    const vertexBase = slot * CURVED_CONE_VERTS_PER_TAIL;
    for (let segment = 0; segment <= CURVED_CONE_CURVE_SEGMENTS; segment++) {
      const u = segment / CURVED_CONE_CURVE_SEGMENTS;
      const age = tailTimeSec * u;
      const px = useParabola
        ? history.x0 + bx * age + ax * age * age
        : history.x0 + bx * age;
      const py = useParabola
        ? history.y0 + by * age + ay * age * age
        : history.y0 + by * age;
      const pz = useParabola
        ? history.z0 + bz * age + az * age * age
        : history.z0 + bz * age;
      const tx = useParabola ? bx + 2 * ax * age : bx;
      const ty = useParabola ? by + 2 * ay * age : by;
      const tz = useParabola ? bz + 2 * az * age : bz;
      this.setCurveBasis(tx, ty, tz);
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

  private composeProjectileFinMatrix(
    x: number, y: number, z: number,
    rearOffset: number,
    finScale: number,
  ): void {
    this.projPos.set(
      x + this.projDir.x * rearOffset,
      z + this.projDir.y * rearOffset,
      y + this.projDir.z * rearOffset,
    );
    this.projScale.setScalar(finScale);
    this.projMatrix.compose(this.projPos, this.projQuat, this.projScale);
  }

  private composeProjectileTailMatrix(
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
    this.projMatrix.compose(this.projPos, this.projQuat, this.projScale);
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
      profile.visual.debugCollisionRadius,
      this.projMatCollision,
    );
    this.setProjRadiusMesh(
      radii, 'explosion', wantExp && !proj.hasExploded,
      projX, projY, projZ,
      profile.visual.debugExplosionRadius,
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
  const fin = (axis: 'x' | 'z', sign: 1 | -1): number[] => {
    const ox = axis === 'x' ? sign * FIN_OUT : 0;
    const oz = axis === 'z' ? sign * FIN_OUT : 0;
    return [
      0, FIN_FORWARD, 0,
      0, FIN_REAR, 0,
      ox, FIN_REAR, oz,
    ];
  };
  const verts = new Float32Array([
    ...fin('x', 1),
    ...fin('z', 1),
    ...fin('x', -1),
    ...fin('z', -1),
  ]);
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
