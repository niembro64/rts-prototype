import * as THREE from 'three';
import { getTeamTrim } from '@/clientBarConfig';
import { disposeMesh } from './threeUtils';
import {
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
} from './instancedBufferUpdate';
import {
  createFormikBodyOrnamentGeometry,
  createFormikTurretAnchorGeometry,
} from './FormikOrnament3D';

/**
 * TeamTrimRenderer3D — shared team-colored ornamentation.
 *
 * A seat has two identities (see src/game/sim/teamRoster.ts): the SIDE it
 * plays on and the seat itself. The body carries the player color; this
 * carries the side. Ornamentation is added geometry, not a recolor of the
 * body, so a unit reads as its alliance without giving up player identity.
 *
 * PERFORMANCE. Each ornament profile owns one InstancedMesh. The generic
 * box, the Formik's complete four-stroke body kit, and all Formik turret
 * collars therefore cost three draw calls total no matter how many entities
 * use them; no ornament adds a per-entity Object3D.
 */

const SLOT_CAP = 16384;
const ZERO_SCALE = 0;

type DirtySlotSpan = ReturnType<typeof createDirtySlotSpan>;

type TrimPool = {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  free: number[];
  nextSlot: number;
  matrixDirty: DirtySlotSpan;
  colorDirty: DirtySlotSpan;
};

function addWhiteVertexColors(geometry: THREE.BufferGeometry): void {
  // `vertexColors` makes MeshLambertMaterial multiply instanceColor by a
  // vertex color. The ornament geometries are authored without color data,
  // so seed a constant white term and let instanceColor be the only tint.
  const vertexCount = geometry.getAttribute('position').count;
  geometry.setAttribute(
    'color',
    new THREE.BufferAttribute(new Float32Array(vertexCount * 3).fill(1), 3),
  );
}

export class TeamTrimRenderer3D {
  private readonly material: THREE.MeshLambertMaterial;
  private readonly pools: TrimPool[];
  private readonly genericPool: TrimPool;
  private readonly formikBodyPool: TrimPool;
  private readonly formikTurretAnchorPool: TrimPool;
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  /** Read once per frame from the CLIENT bar. */
  private enabled = false;

  constructor(private readonly world: THREE.Group) {
    this.material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
    });
    this.genericPool = this.createPool(
      'TeamTrimRenderer3D.Generic',
      new THREE.BoxGeometry(1, 1, 1),
    );
    this.formikBodyPool = this.createPool(
      'TeamTrimRenderer3D.FormikBody',
      createFormikBodyOrnamentGeometry(),
    );
    this.formikTurretAnchorPool = this.createPool(
      'TeamTrimRenderer3D.FormikTurretAnchor',
      createFormikTurretAnchorGeometry(),
    );
    this.pools = [
      this.genericPool,
      this.formikBodyPool,
      this.formikTurretAnchorPool,
    ];
  }

  private createPool(name: string, geometry: THREE.BufferGeometry): TrimPool {
    addWhiteVertexColors(geometry);
    const mesh = new THREE.InstancedMesh(geometry, this.material, SLOT_CAP);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    // Ornamentation rides its host's visibility. Independent frustum culling
    // would pop a stroke/collar off a still-visible host near a screen edge.
    mesh.frustumCulled = false;
    const colors = new THREE.InstancedBufferAttribute(
      new Float32Array(SLOT_CAP * 3),
      3,
    );
    colors.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = colors;
    this.world.add(mesh);
    return {
      mesh,
      geometry,
      free: [],
      nextSlot: 0,
      matrixDirty: createDirtySlotSpan(),
      colorDirty: createDirtySlotSpan(),
    };
  }

  /** Latch this frame's CLIENT-bar toggle for every ornament profile. */
  beginFrame(): void {
    this.enabled = getTeamTrim();
    for (const pool of this.pools) {
      if (!this.enabled && pool.mesh.visible) pool.mesh.visible = false;
      else if (this.enabled && !pool.mesh.visible) pool.mesh.visible = true;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private allocFrom(pool: TrimPool): number {
    const reused = pool.free.pop();
    if (reused !== undefined) return reused;
    if (pool.nextSlot >= SLOT_CAP) return -1;
    const slot = pool.nextSlot++;
    if (pool.mesh.count < pool.nextSlot) pool.mesh.count = pool.nextSlot;
    return slot;
  }

  /** Generic box trim retained for units/buildings without a bespoke kit. */
  alloc(): number {
    return this.allocFrom(this.genericPool);
  }

  allocFormikBody(): number {
    return this.allocFrom(this.formikBodyPool);
  }

  allocFormikTurretAnchor(): number {
    return this.allocFrom(this.formikTurretAnchorPool);
  }

  private setPool(
    pool: TrimPool,
    slot: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    colorHex: number,
  ): void {
    if (slot < 0) return;
    if (!this.enabled) {
      this.hideIn(pool, slot);
      return;
    }
    this.scratchPosition.set(x, y, z);
    this.scratchScale.set(sizeX, sizeY, sizeZ);
    this.scratchMatrix.compose(
      this.scratchPosition,
      quaternion,
      this.scratchScale,
    );
    pool.mesh.setMatrixAt(slot, this.scratchMatrix);
    markDirtySlot(pool.matrixDirty, slot);

    const colors = pool.mesh.instanceColor;
    if (colors === null) return;
    this.scratchColor.setHex(colorHex);
    const i3 = slot * 3;
    const arr = colors.array as Float32Array;
    if (
      arr[i3] !== this.scratchColor.r ||
      arr[i3 + 1] !== this.scratchColor.g ||
      arr[i3 + 2] !== this.scratchColor.b
    ) {
      arr[i3] = this.scratchColor.r;
      arr[i3 + 1] = this.scratchColor.g;
      arr[i3 + 2] = this.scratchColor.b;
      markDirtySlot(pool.colorDirty, slot);
    }
  }

  /** Generic box sizes are full extents, matching BoxGeometry. */
  set(
    slot: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    colorHex: number,
  ): void {
    this.setPool(
      this.genericPool,
      slot,
      x,
      y,
      z,
      quaternion,
      sizeX,
      sizeY,
      sizeZ,
      colorHex,
    );
  }

  /** The Formik body kit is authored in unit-radius-1 space. */
  setFormikBody(
    slot: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    unitRadius: number,
    colorHex: number,
  ): void {
    this.setPool(
      this.formikBodyPool,
      slot,
      x,
      y,
      z,
      quaternion,
      unitRadius,
      unitRadius,
      unitRadius,
      colorHex,
    );
  }

  /** Anchor geometry is a unit cylinder pre-aligned along local +X. */
  setFormikTurretAnchor(
    slot: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    length: number,
    radius: number,
    colorHex: number,
  ): void {
    this.setPool(
      this.formikTurretAnchorPool,
      slot,
      x,
      y,
      z,
      quaternion,
      length,
      radius,
      radius,
      colorHex,
    );
  }

  private hideIn(pool: TrimPool, slot: number): void {
    if (slot < 0) return;
    this.scratchPosition.set(0, 0, 0);
    this.scratchQuaternion.identity();
    this.scratchScale.set(ZERO_SCALE, ZERO_SCALE, ZERO_SCALE);
    this.scratchMatrix.compose(
      this.scratchPosition,
      this.scratchQuaternion,
      this.scratchScale,
    );
    pool.mesh.setMatrixAt(slot, this.scratchMatrix);
    markDirtySlot(pool.matrixDirty, slot);
  }

  hide(slot: number): void {
    this.hideIn(this.genericPool, slot);
  }

  hideFormikBody(slot: number): void {
    this.hideIn(this.formikBodyPool, slot);
  }

  hideFormikTurretAnchor(slot: number): void {
    this.hideIn(this.formikTurretAnchorPool, slot);
  }

  private releaseFrom(pool: TrimPool, slot: number): void {
    if (slot < 0) return;
    this.hideIn(pool, slot);
    pool.free.push(slot);
  }

  release(slot: number): void {
    this.releaseFrom(this.genericPool, slot);
  }

  releaseFormikBody(slot: number): void {
    this.releaseFrom(this.formikBodyPool, slot);
  }

  releaseFormikTurretAnchor(slot: number): void {
    this.releaseFrom(this.formikTurretAnchorPool, slot);
  }

  /** Upload every profile's dirty ranges once, after all host poses. */
  flush(): void {
    for (const pool of this.pools) {
      uploadDirtySlotSpan(pool.mesh.instanceMatrix, pool.matrixDirty, 16);
      const colors = pool.mesh.instanceColor;
      if (colors !== null) uploadDirtySlotSpan(colors, pool.colorDirty, 3);
    }
  }

  dispose(): void {
    for (const pool of this.pools) {
      this.world.remove(pool.mesh);
      disposeMesh(pool.mesh, { material: false, geometry: false });
      pool.geometry.dispose();
    }
    this.material.dispose();
  }
}
