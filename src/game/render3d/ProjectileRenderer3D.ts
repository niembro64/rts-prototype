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
const PROJ_CYL_AXIS = new THREE.Vector3(0, 1, 0);
const IDENTITY_QUAT = new THREE.Quaternion();

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
  private readonly projectileConeGeom = new THREE.ConeGeometry(1, 1, 10);
  private readonly projectileFinGeom = createProjectileFinGeometry();
  private readonly projectileMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
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
  private readonly coneInstanced: THREE.InstancedMesh;
  private readonly finInstanced: THREE.InstancedMesh;
  private readonly seenProjectileIds = new Set<number>();
  private readonly projectileRenderScratch: Entity[] = [];
  private readonly projectileRadiusMeshes = new Map<number, ProjectileRadiusMeshes>();
  private readonly projectileRadiusMeshPool: THREE.LineSegments[] = [];
  private lastProjectileEntitySetVersion = -1;

  private readonly projDir = new THREE.Vector3();
  private readonly projQuat = new THREE.Quaternion();
  private readonly projPos = new THREE.Vector3();
  private readonly projScale = new THREE.Vector3();
  private readonly projMatrix = new THREE.Matrix4();

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

    this.coneInstanced = new THREE.InstancedMesh(
      this.projectileConeGeom,
      this.projectileMat,
      PROJECTILE_INSTANCED_CAP,
    );
    this.coneInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coneInstanced.frustumCulled = false;
    this.coneInstanced.count = 0;
    this.world.add(this.coneInstanced);

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
    let coneCount = 0;
    let finCount = 0;
    const wantCol = getProjRangeToggle('collision');
    const wantExp = getProjRangeToggle('explosion');

    for (const e of projectiles) {
      if (pruneProjectiles) seen.add(e.id);
      const tx = e.transform.x;
      const ty = e.transform.y;
      const tz = e.transform.z;

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
        } else if (tailShape === 'cone' && coneCount < PROJECTILE_INSTANCED_CAP) {
          this.coneInstanced.setMatrixAt(coneCount++, this.projMatrix);
        }
        if (finSizeMult > 0 && finCount < PROJECTILE_INSTANCED_CAP) {
          this.composeProjectileFinMatrix(tx, ty, tz, r, r * finSizeMult);
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
    this.coneInstanced.count = coneCount;
    if (coneCount > 0) {
      this.markInstanceMatrixRange(this.coneInstanced, 0, coneCount - 1);
    }
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
      this.lastProjectileEntitySetVersion = entitySetVersion;
    }
  }

  destroy(): void {
    disposeMesh(this.sphereInstanced, { material: false, geometry: false });
    disposeMesh(this.cylinderInstanced, { material: false, geometry: false });
    disposeMesh(this.coneInstanced, { material: false, geometry: false });
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
      this.projectileConeGeom,
      this.projectileFinGeom,
    ]);
    disposeMaterials([
      this.projectileMat,
      this.projectileFinMat,
      this.projMatCollision,
      this.projMatExplosion,
    ]);
  }

  private composeProjectileFinMatrix(
    x: number, y: number, z: number,
    bodyRadius: number,
    finScale: number,
  ): void {
    this.projPos.set(
      x + this.projDir.x * bodyRadius,
      z + this.projDir.y * bodyRadius,
      y + this.projDir.z * bodyRadius,
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
// quaternion is applied, matching the cone/cylinder tail convention.
function createProjectileFinGeometry(): THREE.BufferGeometry {
  const FIN_FRONT = 0;
  const FIN_BACK = 2;
  const FIN_OUT = 1;
  const fin = (axis: 'x' | 'z', sign: 1 | -1): number[] => {
    const ox = axis === 'x' ? sign * FIN_OUT : 0;
    const oz = axis === 'z' ? sign * FIN_OUT : 0;
    return [
      0, FIN_FRONT, 0,
      0, FIN_BACK, 0,
      ox, FIN_BACK, oz,
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
