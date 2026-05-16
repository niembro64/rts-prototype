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
  private readonly projectileMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
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
      const isCylinder =
        richProjectile && visualProfile?.projectileShape === 'cylinder';

      this.projPos.set(tx, tz, ty);

      if (isCylinder) {
        if (cylinderCount >= PROJECTILE_INSTANCED_CAP) {
          this.hideProjRadiusMeshes(e.id);
          continue;
        }
        const r = Math.max(visualRadius, PROJECTILE_MIN_RADIUS);
        const length = r * visualProfile.cylinderLengthMult;
        const diameter = r * visualProfile.cylinderDiameterMult;
        this.projScale.set(diameter, length, diameter);
        this.projQuat.identity();
        const proj = e.projectile;
        if (proj) {
          const vx = proj.velocityX, vy = proj.velocityY, vz = proj.velocityZ;
          const len2 = vx * vx + vy * vy + vz * vz;
          if (len2 > 1e-6) {
            const inv = 1 / Math.sqrt(len2);
            this.projDir.set(vx * inv, vz * inv, vy * inv);
            this.projQuat.setFromUnitVectors(PROJ_CYL_AXIS, this.projDir);
          }
        }
        this.projMatrix.compose(this.projPos, this.projQuat, this.projScale);
        this.cylinderInstanced.setMatrixAt(cylinderCount++, this.projMatrix);
      } else {
        if (sphereCount >= PROJECTILE_INSTANCED_CAP) {
          this.hideProjRadiusMeshes(e.id);
          continue;
        }
        const r = Math.max(visualRadius, PROJECTILE_MIN_RADIUS);
        this.projScale.set(r, r, r);
        this.projMatrix.compose(this.projPos, IDENTITY_QUAT, this.projScale);
        this.sphereInstanced.setMatrixAt(sphereCount++, this.projMatrix);
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
    disposeGeometries([this.projectileGeom, this.projectileCylinderGeom]);
    disposeMaterials([this.projectileMat, this.projMatCollision, this.projMatExplosion]);
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
