import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { entityInstanceColorHex } from './EntityInstanceColor3D';

const ENTITY_LOD_PROXY_CAP = 32768;
const ENTITY_LOD_PROXY_OPACITY = 0.72;

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

function writeYawScaleMatrix(
  out: Float32Array,
  slot: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const o = slot * 16;
  out[o] = c * sx; out[o + 1] = 0; out[o + 2] = -s * sx; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = sy; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = s * sz; out[o + 9] = 0; out[o + 10] = c * sz; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}

function writeColorHex(out: Float32Array, slot: number, colorHex: number): void {
  const o = slot * 3;
  out[o] = ((colorHex >> 16) & 0xff) / 255;
  out[o + 1] = ((colorHex >> 8) & 0xff) / 255;
  out[o + 2] = (colorHex & 0xff) / 255;
}

function markInstancedRange(
  mesh: THREE.InstancedMesh,
  colorAttr: THREE.InstancedBufferAttribute,
  count: number,
): void {
  if (count <= 0) return;
  mesh.instanceMatrix.clearUpdateRanges();
  mesh.instanceMatrix.addUpdateRange(0, count * 16);
  mesh.instanceMatrix.needsUpdate = true;
  colorAttr.clearUpdateRanges();
  colorAttr.addUpdateRange(0, count * 3);
  colorAttr.needsUpdate = true;
}

export class EntityLodProxyRenderer3D {
  private readonly sphereGeometry = new THREE.SphereGeometry(1, 8, 6);
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthWrite: false,
    opacity: ENTITY_LOD_PROXY_OPACITY,
    transparent: true,
    vertexColors: true,
    wireframe: true,
  });
  private readonly sphereMesh: THREE.InstancedMesh;
  private readonly sphereMatrices: Float32Array;
  private readonly sphereColors = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  private readonly sphereColorAttr = new THREE.InstancedBufferAttribute(this.sphereColors, 3);
  private readonly boxMesh: THREE.InstancedMesh;
  private readonly boxMatrices: Float32Array;
  private readonly boxColors = new Float32Array(ENTITY_LOD_PROXY_CAP * 3);
  private readonly boxColorAttr = new THREE.InstancedBufferAttribute(this.boxColors, 3);
  private sphereCount = 0;
  private boxCount = 0;

  constructor(private readonly world: THREE.Group) {
    this.sphereColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.boxColorAttr.setUsage(THREE.DynamicDrawUsage);

    this.sphereMesh = new THREE.InstancedMesh(
      this.sphereGeometry,
      this.material,
      ENTITY_LOD_PROXY_CAP,
    );
    this.sphereMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sphereMesh.instanceColor = this.sphereColorAttr;
    this.sphereMesh.frustumCulled = false;
    this.sphereMesh.count = 0;
    this.sphereMesh.renderOrder = 3;
    this.sphereMatrices = this.sphereMesh.instanceMatrix.array as Float32Array;
    this.world.add(this.sphereMesh);

    this.boxMesh = new THREE.InstancedMesh(
      this.boxGeometry,
      this.material,
      ENTITY_LOD_PROXY_CAP,
    );
    this.boxMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxMesh.instanceColor = this.boxColorAttr;
    this.boxMesh.frustumCulled = false;
    this.boxMesh.count = 0;
    this.boxMesh.renderOrder = 3;
    this.boxMatrices = this.boxMesh.instanceMatrix.array as Float32Array;
    this.world.add(this.boxMesh);
  }

  beginFrame(): void {
    this.sphereCount = 0;
    this.boxCount = 0;
  }

  pushUnit(entity: Entity): void {
    const unit = entity.unit;
    if (unit === null || this.sphereCount >= ENTITY_LOD_PROXY_CAP) return;
    const radius = Math.max(1, unit.radius.hitbox || unit.radius.visual || 15);
    const slot = this.sphereCount++;
    writeTranslateScaleMatrix(
      this.sphereMatrices,
      slot,
      entity.transform.x,
      entity.transform.z,
      entity.transform.y,
      radius,
      radius,
      radius,
    );
    writeColorHex(this.sphereColors, slot, entityInstanceColorHex(entity));
  }

  pushBuilding(entity: Entity): void {
    const building = entity.building;
    if (building === null || this.boxCount >= ENTITY_LOD_PROXY_CAP) return;
    const width = Math.max(1, building.width);
    const height = Math.max(1, building.depth);
    const footprintDepth = Math.max(1, building.height);
    const slot = this.boxCount++;
    writeYawScaleMatrix(
      this.boxMatrices,
      slot,
      entity.transform.x,
      entity.transform.z,
      entity.transform.y,
      -entity.transform.rotation,
      width,
      height,
      footprintDepth,
    );
    writeColorHex(this.boxColors, slot, entityInstanceColorHex(entity));
  }

  flush(): void {
    if (this.sphereMesh.count !== this.sphereCount) this.sphereMesh.count = this.sphereCount;
    if (this.boxMesh.count !== this.boxCount) this.boxMesh.count = this.boxCount;
    markInstancedRange(this.sphereMesh, this.sphereColorAttr, this.sphereCount);
    markInstancedRange(this.boxMesh, this.boxColorAttr, this.boxCount);
  }

  destroy(): void {
    this.world.remove(this.sphereMesh);
    this.world.remove(this.boxMesh);
    this.sphereGeometry.dispose();
    this.boxGeometry.dispose();
    this.material.dispose();
  }
}
