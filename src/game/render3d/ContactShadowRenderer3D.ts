import * as THREE from 'three';
import {
  CONTACT_SHADOW_RENDER_CONFIG,
  GROUND_RENDER_ORDER,
  MANA_TILE_GROUND_LIFT,
} from '../../config';
import type { GraphicsConfig } from '@/types/graphics';
import type { Entity } from '../sim/types';
import {
  getTerrainMeshHeight,
  getTerrainMeshNormal,
} from '../sim/Terrain';
import { shouldRunOnStride } from '../math';
import type { ViewportFootprint } from '../ViewportFootprint';
import { SUN_DIRECTION_SIM, writeSunDirectionThree } from './SunLighting';
import { disposeMesh } from './threeUtils';

const SHADOW_GEOMETRY = new THREE.CircleGeometry(1, 28);
SHADOW_GEOMETRY.rotateX(-Math.PI / 2);

export class ContactShadowRenderer3D {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly matrix = new THREE.Matrix4();
  private readonly scale = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly sun = new THREE.Vector3();
  private readonly sunTangent = new THREE.Vector3(0, 0, -1);
  private readonly sideTangent = new THREE.Vector3(1, 0, 0);
  private lastOpacity = -1;

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: false,
      opacity: 0.16,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(
      SHADOW_GEOMETRY,
      this.material,
      CONTACT_SHADOW_RENDER_CONFIG.maxInstances,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = GROUND_RENDER_ORDER.contactShadows;
    parent.add(this.mesh);
  }

  update(
    units: readonly Entity[],
    buildings: readonly Entity[],
    graphics: GraphicsConfig,
    frameIndex: number,
    scope: ViewportFootprint,
  ): void {
    if (!CONTACT_SHADOW_RENDER_CONFIG.enabled) {
      this.mesh.count = 0;
      return;
    }

    const stride = Math.max(1, CONTACT_SHADOW_RENDER_CONFIG.frameStride[graphics.tier] | 0);
    if (!shouldRunOnStride(frameIndex, stride) && this.mesh.count > 0) return;

    const opacity = CONTACT_SHADOW_RENDER_CONFIG.opacity[graphics.tier];
    if (opacity !== this.lastOpacity) {
      this.material.opacity = opacity;
      this.material.needsUpdate = true;
      this.lastOpacity = opacity;
    }

    writeSunDirectionThree(this.sun);
    let cursor = 0;
    const cap = CONTACT_SHADOW_RENDER_CONFIG.maxInstances;

    for (let i = 0; i < units.length && cursor < cap; i++) {
      const entity = units[i];
      const unit = entity.unit;
      if (!unit || unit.hp <= 0) continue;
      const radius = unit.radius.shot * CONTACT_SHADOW_RENDER_CONFIG.unitShotRadiusMultiplier;
      const height = unit.bodyCenterHeight ?? unit.radius.body;
      if (!scope.inScope(entity.transform.x, entity.transform.y, radius + CONTACT_SHADOW_RENDER_CONFIG.maxSunOffset)) {
        continue;
      }
      if (this.writeShadow(
        cursor,
        entity.transform.x,
        entity.transform.y,
        radius * CONTACT_SHADOW_RENDER_CONFIG.crossSunSquash,
        radius * CONTACT_SHADOW_RENDER_CONFIG.sunStretch,
        height,
        CONTACT_SHADOW_RENDER_CONFIG.unitSunOffsetPerHeight,
      )) {
        cursor++;
      }
    }

    for (let i = 0; i < buildings.length && cursor < cap; i++) {
      const entity = buildings[i];
      const building = entity.building;
      if (!building || building.hp <= 0) continue;
      const halfWidth = Math.max(
        CONTACT_SHADOW_RENDER_CONFIG.minBuildingRadius,
        building.width * 0.5 * CONTACT_SHADOW_RENDER_CONFIG.buildingRadiusMultiplier,
      );
      const halfDepth = Math.max(
        CONTACT_SHADOW_RENDER_CONFIG.minBuildingRadius,
        building.height * 0.5 * CONTACT_SHADOW_RENDER_CONFIG.buildingRadiusMultiplier,
      );
      const height = Math.max(20, Math.max(building.width, building.height) * 0.35);
      if (!scope.inScope(entity.transform.x, entity.transform.y, Math.max(halfWidth, halfDepth))) {
        continue;
      }
      if (this.writeShadow(
        cursor,
        entity.transform.x,
        entity.transform.y,
        halfWidth,
        halfDepth * CONTACT_SHADOW_RENDER_CONFIG.sunStretch,
        height,
        CONTACT_SHADOW_RENDER_CONFIG.buildingSunOffsetPerHeight,
      )) {
        cursor++;
      }
    }

    this.mesh.count = cursor;
    if (cursor > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, cursor * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private writeShadow(
    slot: number,
    x: number,
    y: number,
    crossRadius: number,
    sunRadius: number,
    casterHeight: number,
    offsetPerHeight: number,
  ): boolean {
    const offset = Math.min(
      CONTACT_SHADOW_RENDER_CONFIG.maxSunOffset,
      casterHeight * offsetPerHeight,
    );
    const sx = x - SUN_DIRECTION_SIM.x * offset;
    const sy = y - SUN_DIRECTION_SIM.y * offset;
    if (sx < 0 || sy < 0 || sx > this.mapWidth || sy > this.mapHeight) return false;

    const ground = getTerrainMeshHeight(sx, sy, this.mapWidth, this.mapHeight) +
      MANA_TILE_GROUND_LIFT +
      CONTACT_SHADOW_RENDER_CONFIG.lift;
    const n = getTerrainMeshNormal(sx, sy, this.mapWidth, this.mapHeight);
    this.normal.set(n.nx, n.nz, n.ny).normalize();
    this.sunTangent.copy(this.sun).addScaledVector(
      this.normal,
      -this.sun.dot(this.normal),
    );
    if (this.sunTangent.lengthSq() < 1e-6) {
      this.sunTangent.set(0, 0, -1);
    } else {
      this.sunTangent.normalize();
    }
    this.sideTangent.crossVectors(this.normal, this.sunTangent).normalize();
    this.pos.set(sx, ground, sy);

    this.matrix.makeBasis(this.sideTangent, this.normal, this.sunTangent);
    this.scale.set(Math.max(1, crossRadius), 1, Math.max(1, sunRadius));
    this.matrix.scale(this.scale);
    this.matrix.setPosition(this.pos);
    this.mesh.setMatrixAt(slot, this.matrix);
    return true;
  }

  dispose(): void {
    // SHADOW_GEOMETRY is module-shared; skip the geometry leg.
    disposeMesh(this.mesh, { geometry: false });
  }
}
