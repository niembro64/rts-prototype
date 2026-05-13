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
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import { disposeMesh } from './threeUtils';

const SHADOW_GEOMETRY = new THREE.CircleGeometry(1, 28);
SHADOW_GEOMETRY.rotateX(-Math.PI / 2);
const UNIT_AIR_SHADOW_FADE_BODY_HEIGHTS = 4;
const UNIT_AIR_SHADOW_FADE_MIN_HEIGHT = 80;
const UNIT_AIR_SHADOW_MIN_ALPHA = 0.18;
const UNIT_AIR_SHADOW_CROSS_SCALE_BOOST = 0.45;
const UNIT_AIR_SHADOW_SUN_SCALE_BOOST = 0.7;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function makeContactShadowMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
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
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `
attribute float contactShadowAlpha;
varying float vContactShadowAlpha;
#include <common>
`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
#include <begin_vertex>
vContactShadowAlpha = contactShadowAlpha;
`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `
varying float vContactShadowAlpha;
#include <common>
`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `
diffuseColor.a *= vContactShadowAlpha;
#include <opaque_fragment>
`,
    );
  };
  return material;
}

export class ContactShadowRenderer3D {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly alphas: Float32Array;
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
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
    this.material = makeContactShadowMaterial();
    this.alphas = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphas, 1)
      .setUsage(THREE.DynamicDrawUsage);
    this.mesh = new THREE.InstancedMesh(
      SHADOW_GEOMETRY,
      this.material,
      CONTACT_SHADOW_RENDER_CONFIG.maxInstances,
    );
    this.mesh.geometry.setAttribute('contactShadowAlpha', this.alphaAttr);
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
      const restHeight = Math.max(1, unit.bodyCenterHeight ?? unit.radius.body);
      const groundZ = getLocomotionSurfaceHeight(
        entity.transform.x,
        entity.transform.y,
        this.mapWidth,
        this.mapHeight,
      );
      const casterHeight = Math.max(0, entity.transform.z - groundZ);
      const airHeight = Math.max(0, casterHeight - restHeight);
      const airFadeHeight = Math.max(
        UNIT_AIR_SHADOW_FADE_MIN_HEIGHT,
        restHeight * UNIT_AIR_SHADOW_FADE_BODY_HEIGHTS,
      );
      const airT = clamp01(airHeight / airFadeHeight);
      const crossScale = 1 + airT * UNIT_AIR_SHADOW_CROSS_SCALE_BOOST;
      const sunScale = 1 + airT * UNIT_AIR_SHADOW_SUN_SCALE_BOOST;
      const alpha = 1 - airT * (1 - UNIT_AIR_SHADOW_MIN_ALPHA);
      const scopeRadius =
        radius * Math.max(crossScale, sunScale) +
        CONTACT_SHADOW_RENDER_CONFIG.maxSunOffset;
      if (!scope.inScope(entity.transform.x, entity.transform.y, scopeRadius)) {
        continue;
      }
      if (this.writeShadow(
        cursor,
        entity.transform.x,
        entity.transform.y,
        radius * CONTACT_SHADOW_RENDER_CONFIG.crossSunSquash * crossScale,
        radius * CONTACT_SHADOW_RENDER_CONFIG.sunStretch * sunScale,
        casterHeight,
        CONTACT_SHADOW_RENDER_CONFIG.unitSunOffsetPerHeight,
        alpha,
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
        1,
      )) {
        cursor++;
      }
    }

    this.mesh.count = cursor;
    if (cursor > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, cursor * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.clearUpdateRanges();
      this.alphaAttr.addUpdateRange(0, cursor);
      this.alphaAttr.needsUpdate = true;
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
    alpha: number,
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
    this.alphas[slot] = alpha;
    return true;
  }

  dispose(): void {
    // SHADOW_GEOMETRY is module-shared; skip the geometry leg.
    disposeMesh(this.mesh, { geometry: false });
  }
}
