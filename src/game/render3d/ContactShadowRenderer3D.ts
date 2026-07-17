import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import {
  CONTACT_SHADOW_RENDER_CONFIG,
  GROUND_RENDER_ORDER,
  LAND_TILE_GROUND_LIFT,
} from '../../config';
import type { Entity } from '../sim/types';
import {
  getTerrainMeshHeight,
  getTerrainMeshNormal,
} from '../sim/Terrain';
import { clamp01, shouldRunOnStride } from '../math';
import type { ViewportFootprint } from '../ViewportFootprint';
import { SUN_DIRECTION_SIM, writeSunDirectionThree } from './SunLighting';
import { getLocomotionSurfaceHeight } from './LocomotionTerrainSampler';
import { disposeMesh } from './threeUtils';
import {
  createPrimitiveCircleGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import type { RenderViewState3D } from './RenderFrameState3D';
import { detailLevelForViewPosition, geometryTierForDetail } from './EntityDetailLevel3D';
const UNIT_AIR_SHADOW_FADE_BODY_HEIGHTS = 4;
const UNIT_AIR_SHADOW_FADE_MIN_HEIGHT = 80;
const UNIT_AIR_SHADOW_MIN_ALPHA = 0.18;
const UNIT_AIR_SHADOW_CROSS_SCALE_BOOST = 0.45;
const UNIT_AIR_SHADOW_SUN_SCALE_BOOST = 0.7;

type DirtySpan = {
  minSlot: number;
  maxSlot: number;
};

function createDirtySpan(): DirtySpan {
  return { minSlot: Number.POSITIVE_INFINITY, maxSlot: -1 };
}

function markDirtySlot(span: DirtySpan, slot: number): void {
  if (slot < span.minSlot) span.minSlot = slot;
  if (slot > span.maxSlot) span.maxSlot = slot;
}

function clearDirtySpan(span: DirtySpan): void {
  span.minSlot = Number.POSITIVE_INFINITY;
  span.maxSlot = -1;
}

function uploadDirtySpan(
  attr: THREE.InstancedBufferAttribute,
  span: DirtySpan,
  itemSize: number,
): void {
  if (span.maxSlot < span.minSlot) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(
    span.minSlot * itemSize,
    (span.maxSlot - span.minSlot + 1) * itemSize,
  );
  attr.needsUpdate = true;
  clearDirtySpan(span);
}

function writeMatrixAt(
  mesh: THREE.InstancedMesh,
  slot: number,
  matrix: THREE.Matrix4,
  dirty: DirtySpan,
): void {
  const out = mesh.instanceMatrix.array;
  const src = matrix.elements;
  const offset = slot * 16;
  let changed = false;
  for (let i = 0; i < 16; i++) {
    if (out[offset + i] !== Math.fround(src[i])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  for (let i = 0; i < 16; i++) out[offset + i] = Math.fround(src[i]);
  markDirtySlot(dirty, slot);
}

export class ContactShadowRenderPacket3D {
  readonly x = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
  readonly y = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
  readonly crossRadius = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
  readonly sunRadius = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
  readonly casterHeight = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
  readonly offsetPerHeight = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
  readonly alpha = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  pushUnit(
    entity: Entity,
    mapWidth: number,
    mapHeight: number,
    scope: ViewportFootprint,
  ): void {
    const unit = entity.unit;
    if (!unit || unit.hp <= 0) return;
    const radius = unit.radius.hitbox * CONTACT_SHADOW_RENDER_CONFIG.unitShotRadiusMultiplier;
    const restHeight = Math.max(1, unit.bodyCenterHeight ?? unit.radius.other);
    const groundZ = getLocomotionSurfaceHeight(
      entity.transform.x,
      entity.transform.y,
      mapWidth,
      mapHeight,
      entity.id,
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
    const scopeRadius =
      radius * Math.max(crossScale, sunScale) +
      CONTACT_SHADOW_RENDER_CONFIG.maxSunOffset;
    if (!scope.inScope(entity.transform.x, entity.transform.y, scopeRadius)) return;
    this.push(
      entity.transform.x,
      entity.transform.y,
      radius * CONTACT_SHADOW_RENDER_CONFIG.crossSunSquash * crossScale,
      radius * CONTACT_SHADOW_RENDER_CONFIG.sunStretch * sunScale,
      casterHeight,
      CONTACT_SHADOW_RENDER_CONFIG.unitSunOffsetPerHeight,
      1 - airT * (1 - UNIT_AIR_SHADOW_MIN_ALPHA),
    );
  }

  pushUnitState(
    entityId: number,
    x: number,
    y: number,
    z: number,
    hp: number,
    radiusHitbox: number,
    restHeight: number,
    mapWidth: number,
    mapHeight: number,
    scope: ViewportFootprint,
  ): void {
    if (hp <= 0) return;
    const radius = radiusHitbox * CONTACT_SHADOW_RENDER_CONFIG.unitShotRadiusMultiplier;
    const bodyRestHeight = Math.max(1, restHeight);
    const groundZ = getLocomotionSurfaceHeight(
      x,
      y,
      mapWidth,
      mapHeight,
      entityId,
    );
    const casterHeight = Math.max(0, z - groundZ);
    const airHeight = Math.max(0, casterHeight - bodyRestHeight);
    const airFadeHeight = Math.max(
      UNIT_AIR_SHADOW_FADE_MIN_HEIGHT,
      bodyRestHeight * UNIT_AIR_SHADOW_FADE_BODY_HEIGHTS,
    );
    const airT = clamp01(airHeight / airFadeHeight);
    const crossScale = 1 + airT * UNIT_AIR_SHADOW_CROSS_SCALE_BOOST;
    const sunScale = 1 + airT * UNIT_AIR_SHADOW_SUN_SCALE_BOOST;
    const scopeRadius =
      radius * Math.max(crossScale, sunScale) +
      CONTACT_SHADOW_RENDER_CONFIG.maxSunOffset;
    if (!scope.inScope(x, y, scopeRadius)) return;
    this.push(
      x,
      y,
      radius * CONTACT_SHADOW_RENDER_CONFIG.crossSunSquash * crossScale,
      radius * CONTACT_SHADOW_RENDER_CONFIG.sunStretch * sunScale,
      casterHeight,
      CONTACT_SHADOW_RENDER_CONFIG.unitSunOffsetPerHeight,
      1 - airT * (1 - UNIT_AIR_SHADOW_MIN_ALPHA),
    );
  }

  pushBuilding(entity: Entity, scope: ViewportFootprint): void {
    const building = entity.building;
    if (!building || building.hp <= 0) return;
    const halfWidth = Math.max(
      CONTACT_SHADOW_RENDER_CONFIG.minBuildingRadius,
      building.width * 0.5 * CONTACT_SHADOW_RENDER_CONFIG.buildingRadiusMultiplier,
    );
    const halfDepth = Math.max(
      CONTACT_SHADOW_RENDER_CONFIG.minBuildingRadius,
      building.height * 0.5 * CONTACT_SHADOW_RENDER_CONFIG.buildingRadiusMultiplier,
    );
    if (!scope.inScope(entity.transform.x, entity.transform.y, Math.max(halfWidth, halfDepth))) {
      return;
    }
    this.push(
      entity.transform.x,
      entity.transform.y,
      halfWidth,
      halfDepth * CONTACT_SHADOW_RENDER_CONFIG.sunStretch,
      Math.max(20, Math.max(building.width, building.height) * 0.35),
      CONTACT_SHADOW_RENDER_CONFIG.buildingSunOffsetPerHeight,
      1,
    );
  }

  pushBuildingState(
    x: number,
    y: number,
    hp: number,
    width: number,
    footprintDepth: number,
    scope: ViewportFootprint,
  ): void {
    if (hp <= 0) return;
    const halfWidth = Math.max(
      CONTACT_SHADOW_RENDER_CONFIG.minBuildingRadius,
      width * 0.5 * CONTACT_SHADOW_RENDER_CONFIG.buildingRadiusMultiplier,
    );
    const halfDepth = Math.max(
      CONTACT_SHADOW_RENDER_CONFIG.minBuildingRadius,
      footprintDepth * 0.5 * CONTACT_SHADOW_RENDER_CONFIG.buildingRadiusMultiplier,
    );
    if (!scope.inScope(x, y, Math.max(halfWidth, halfDepth))) {
      return;
    }
    this.push(
      x,
      y,
      halfWidth,
      halfDepth * CONTACT_SHADOW_RENDER_CONFIG.sunStretch,
      Math.max(20, Math.max(width, footprintDepth) * 0.35),
      CONTACT_SHADOW_RENDER_CONFIG.buildingSunOffsetPerHeight,
      1,
    );
  }

  pushRow(
    x: number,
    y: number,
    crossRadius: number,
    sunRadius: number,
    casterHeight: number,
    offsetPerHeight: number,
    alpha: number,
  ): void {
    this.push(x, y, crossRadius, sunRadius, casterHeight, offsetPerHeight, alpha);
  }

  private push(
    x: number,
    y: number,
    crossRadius: number,
    sunRadius: number,
    casterHeight: number,
    offsetPerHeight: number,
    alpha: number,
  ): void {
    const cursor = this.count;
    if (cursor >= CONTACT_SHADOW_RENDER_CONFIG.maxInstances) return;
    this.x[cursor] = x;
    this.y[cursor] = y;
    this.crossRadius[cursor] = crossRadius;
    this.sunRadius[cursor] = sunRadius;
    this.casterHeight[cursor] = casterHeight;
    this.offsetPerHeight[cursor] = offsetPerHeight;
    this.alpha[cursor] = alpha;
    this.count = cursor + 1;
  }
}

function makeContactShadowMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: COLORS.world.contactShadow.colorHex,
    transparent: true,
    opacity: COLORS.world.contactShadow.opacity,
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

type ContactShadowPool = {
  mesh: THREE.InstancedMesh;
  alphas: Float32Array;
  alphaAttr: THREE.InstancedBufferAttribute;
  matrixDirty: DirtySpan;
  alphaDirty: DirtySpan;
};

export class ContactShadowRenderer3D {
  private readonly pools: Record<PrimitiveGeometryTier, ContactShadowPool>;
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
    this.material = makeContactShadowMaterial();
    this.pools = {
      close: this.createPool(parent, 'close'),
      mid: this.createPool(parent, 'mid'),
      far: this.createPool(parent, 'far'),
    };
  }

  private createPool(parent: THREE.Group, tier: PrimitiveGeometryTier): ContactShadowPool {
    const geometry = tier === 'far'
      ? new THREE.PlaneGeometry(2, 2)
      : createPrimitiveCircleGeometry('effect', tier);
    geometry.rotateX(-Math.PI / 2);
    const alphas = new Float32Array(CONTACT_SHADOW_RENDER_CONFIG.maxInstances);
    const alphaAttr = new THREE.InstancedBufferAttribute(alphas, 1)
      .setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('contactShadowAlpha', alphaAttr);
    const mesh = new THREE.InstancedMesh(
      geometry,
      this.material,
      CONTACT_SHADOW_RENDER_CONFIG.maxInstances,
    );
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = GROUND_RENDER_ORDER.contactShadows;
    parent.add(mesh);
    return {
      mesh,
      alphas,
      alphaAttr,
      matrixDirty: createDirtySpan(),
      alphaDirty: createDirtySpan(),
    };
  }

  shouldUpdate(frameIndex: number): boolean {
    if (!CONTACT_SHADOW_RENDER_CONFIG.enabled) {
      return Object.values(this.pools).some((pool) => pool.mesh.count > 0);
    }
    const stride = Math.max(1, CONTACT_SHADOW_RENDER_CONFIG.frameStride | 0);
    return shouldRunOnStride(frameIndex, stride)
      || Object.values(this.pools).every((pool) => pool.mesh.count === 0);
  }

  shouldBuildPacket(frameIndex: number): boolean {
    return CONTACT_SHADOW_RENDER_CONFIG.enabled && this.shouldUpdate(frameIndex);
  }

  update(
    packet: ContactShadowRenderPacket3D,
    frameIndex: number,
    view?: RenderViewState3D,
  ): void {
    if (!CONTACT_SHADOW_RENDER_CONFIG.enabled) {
      this.clearPools();
      return;
    }

    if (packet.count === 0) {
      this.clearPools();
      return;
    }

    const stride = Math.max(1, CONTACT_SHADOW_RENDER_CONFIG.frameStride | 0);
    if (
      !shouldRunOnStride(frameIndex, stride)
      && Object.values(this.pools).some((pool) => pool.mesh.count > 0)
    ) return;

    const opacity = CONTACT_SHADOW_RENDER_CONFIG.opacity;
    if (opacity !== this.lastOpacity) {
      this.material.opacity = opacity;
      this.material.needsUpdate = true;
      this.lastOpacity = opacity;
    }

    writeSunDirectionThree(this.sun);
    const cursors: Record<PrimitiveGeometryTier, number> = { close: 0, mid: 0, far: 0 };
    const cap = CONTACT_SHADOW_RENDER_CONFIG.maxInstances;

    for (let i = 0; i < packet.count; i++) {
      const radius = Math.max(packet.crossRadius[i], packet.sunRadius[i]);
      const tier = view
        ? geometryTierForDetail(detailLevelForViewPosition(
            view,
            packet.x[i],
            packet.y[i],
            packet.casterHeight[i],
            radius,
          ))
        : 'close';
      const cursor = cursors[tier];
      if (cursor >= cap) continue;
      if (this.writeShadow(
        this.pools[tier],
        cursor,
        packet.x[i],
        packet.y[i],
        packet.crossRadius[i],
        packet.sunRadius[i],
        packet.casterHeight[i],
        packet.offsetPerHeight[i],
        packet.alpha[i],
      )) {
        cursors[tier]++;
      }
    }

    for (const tier of ['close', 'mid', 'far'] as const) {
      const pool = this.pools[tier];
      pool.mesh.count = cursors[tier];
      if (cursors[tier] > 0) {
        uploadDirtySpan(pool.mesh.instanceMatrix, pool.matrixDirty, 16);
        uploadDirtySpan(pool.alphaAttr, pool.alphaDirty, 1);
      }
    }
  }

  private clearPools(): void {
    for (const pool of Object.values(this.pools)) {
      pool.mesh.count = 0;
      clearDirtySpan(pool.matrixDirty);
      clearDirtySpan(pool.alphaDirty);
    }
  }

  private writeShadow(
    pool: ContactShadowPool,
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
      LAND_TILE_GROUND_LIFT +
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
    writeMatrixAt(pool.mesh, slot, this.matrix, pool.matrixDirty);
    const nextAlpha = Math.fround(alpha);
    if (pool.alphas[slot] !== nextAlpha) {
      pool.alphas[slot] = nextAlpha;
      markDirtySlot(pool.alphaDirty, slot);
    }
    return true;
  }

  dispose(): void {
    for (const pool of Object.values(this.pools)) {
      disposeMesh(pool.mesh, { material: false });
    }
    this.material.dispose();
  }
}
