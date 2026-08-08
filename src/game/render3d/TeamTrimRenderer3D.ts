import * as THREE from 'three';
import { getTeamTrim } from '@/clientBarConfig';
import { disposeMesh } from './threeUtils';
import {
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
} from './instancedBufferUpdate';
import {
  createHostOrnamentGeometry,
  collarChartScale,
  createTurretCollarGeometry,
  ornamentChartScale,
  ornamentProfileKey,
  type HostOrnamentProfile,
} from './TeamOrnament3D';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import type { SurfaceChartId } from './SurfaceChart3D';
import {
  attachSurfaceChartAttribute,
  patchSurfaceChartMaterial,
  uploadSurfaceChart,
  writeSurfaceChart,
  type SurfaceChartAttribute,
} from './SurfaceChartMaterial3D';
import { patchInstancedFadeMaterial } from './EntityFade3D';
import type { EntityDeathRenderablePart3D } from './EntityDeathDisassembly3D';

/**
 * TeamTrimRenderer3D — shared team-coloured ornamentation.
 *
 * A seat has two identities (see src/game/sim/teamRoster.ts): the SIDE it
 * plays on and the seat itself. The body carries the player colour; this
 * carries the side. Ornamentation is added geometry, not a recolour of the
 * body, so a unit reads as its alliance without giving up player identity.
 *
 * ONE UNIT KIT, MANY FITS. Every mobile unit wears the same designed body kit
 * (TeamOrnament3D) fitted to its hull, and every turret wears the same collar
 * sized from its own head radius. Buildings are absent from these body-kit
 * pools: each building mesh authors function-specific team ornamentation.
 *
 * PERFORMANCE. Pools are keyed by PROFILE, not by entity: every unit whose kit
 * would be visually identical shares one InstancedMesh, so a hundred of the
 * same unit type cost one draw call and no per-entity Object3D. Pools are
 * created on first use and grow by doubling, so a roster of a dozen body
 * shapes does not pay up front for a battle it may never have.
 */

/** Initial per-pool capacity. Small on purpose — there is one pool per
 *  (profile, tier) now, and reserving the old flat 16k slots in each would
 *  have cost more than a megabyte per body shape for instances that mostly
 *  never exist. */
const INITIAL_SLOT_CAP = 256;
const MAX_SLOT_CAP = 65536;
const ZERO_SCALE = 0;

/** Slot packing. The pool index rides in the slot so callers keep passing one
 *  opaque number, exactly as they did when there were three fixed pools. */
const TRIM_POOL_SHIFT = 16;
const TRIM_INDEX_MASK = (1 << TRIM_POOL_SHIFT) - 1;

function encodeTrimSlot(poolIndex: number, index: number): number {
  return (poolIndex << TRIM_POOL_SHIFT) | index;
}

function trimSlotPool(slot: number): number {
  return slot >>> TRIM_POOL_SHIFT;
}

function trimSlotIndex(slot: number): number {
  return slot & TRIM_INDEX_MASK;
}

type DirtySlotSpan = ReturnType<typeof createDirtySlotSpan>;

type TrimPool = {
  mesh: THREE.InstancedMesh;
  geometry: THREE.BufferGeometry;
  /** The livery chart this pool's geometry wears. Per-INSTANCE rather than
   *  baked into the geometry, because the band's repeat depends on the host's
   *  size and two hosts of the same body shape can be different sizes. */
  chartId: SurfaceChartId;
  chart: SurfaceChartAttribute;
  capacity: number;
  free: number[];
  nextSlot: number;
  matrixDirty: DirtySlotSpan;
  colorDirty: DirtySlotSpan;
  fade: Float32Array;
  fadeAttribute: THREE.InstancedBufferAttribute;
  fadeDirty: DirtySlotSpan;
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

/** Livery charts at the two near rungs; the far rung's ornament is a few
 *  pixels of team colour and wants nothing between it and the eye. */
function liveryChartFor(chart: SurfaceChartId, tier: PrimitiveGeometryTier): SurfaceChartId {
  return tier === 'far' ? 'none' : chart;
}

export class TeamTrimRenderer3D {
  private readonly material: THREE.MeshLambertMaterial;
  private readonly pools: TrimPool[] = [];
  private readonly poolsByKey = new Map<string, number>();
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  private readonly scratchRotation = new THREE.Quaternion();
  private readonly scratchEuler = new THREE.Euler();
  /** Read once per frame from the CLIENT bar. */
  private enabled = false;

  constructor(private readonly world: THREE.Group) {
    this.material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
    });
    patchSurfaceChartMaterial(this.material, { bump: true });
    patchInstancedFadeMaterial(this.material);
  }

  private poolFor(
    key: string,
    name: string,
    makeGeometry: () => THREE.BufferGeometry,
    chart: SurfaceChartId,
  ): number {
    const existing = this.poolsByKey.get(key);
    if (existing !== undefined) return existing;
    const geometry = makeGeometry();
    addWhiteVertexColors(geometry);
    const index = this.pools.length;
    this.pools.push(this.createPool(name, geometry, INITIAL_SLOT_CAP, chart));
    this.poolsByKey.set(key, index);
    return index;
  }

  private createPool(
    name: string,
    geometry: THREE.BufferGeometry,
    capacity: number,
    chartId: SurfaceChartId,
  ): TrimPool {
    const fade = new Float32Array(capacity);
    const fadeAttribute = new THREE.InstancedBufferAttribute(fade, 1);
    fadeAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aFade', fadeAttribute);
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = this.enabled;
    // Ornamentation rides its host's visibility. Independent frustum culling
    // would pop a stroke/collar off a still-visible host near a screen edge.
    mesh.frustumCulled = false;
    const colors = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    colors.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = colors;
    this.world.add(mesh);
    return {
      mesh,
      geometry,
      chartId,
      chart: attachSurfaceChartAttribute(geometry, capacity),
      capacity,
      free: [],
      nextSlot: 0,
      matrixDirty: createDirtySlotSpan(),
      colorDirty: createDirtySlotSpan(),
      fade,
      fadeAttribute,
      fadeDirty: createDirtySlotSpan(),
    };
  }

  /** Double a pool that has run out, carrying every live instance across.
   *
   *  An InstancedMesh's capacity is fixed at construction, so growth means a
   *  new mesh. The alternative — reserving the worst case in every pool — is
   *  what made a per-profile pool unaffordable in the first place. */
  private growPool(pool: TrimPool): boolean {
    if (pool.capacity >= MAX_SLOT_CAP) return false;
    const capacity = Math.min(MAX_SLOT_CAP, pool.capacity * 2);
    // Snapshot the charts BEFORE the replacement attaches its own attribute:
    // the geometry is shared between the two meshes, so createPool overwrites
    // the label buffer on the way past and the copy has to come first.
    const charts = pool.chart.arr.slice(0, pool.capacity * 4);
    const fades = pool.fade.slice(0, pool.capacity);
    const next = this.createPool(pool.mesh.name, pool.geometry, capacity, pool.chartId);
    next.chart.arr.set(charts);
    next.chart.attr.needsUpdate = true;
    next.fade.set(fades);
    next.fadeAttribute.needsUpdate = true;
    next.mesh.count = pool.mesh.count;
    next.nextSlot = pool.nextSlot;
    next.free.push(...pool.free);
    (next.mesh.instanceMatrix.array as Float32Array)
      .set(pool.mesh.instanceMatrix.array as Float32Array);
    const colors = pool.mesh.instanceColor;
    if (colors !== null && next.mesh.instanceColor !== null) {
      (next.mesh.instanceColor.array as Float32Array).set(colors.array as Float32Array);
    }
    next.mesh.instanceMatrix.needsUpdate = true;
    if (next.mesh.instanceColor !== null) next.mesh.instanceColor.needsUpdate = true;
    this.world.remove(pool.mesh);
    // The geometry is shared with the replacement and the material is shared
    // with every pool, so only the mesh itself goes.
    disposeMesh(pool.mesh, { material: false, geometry: false });
    pool.mesh = next.mesh;
    pool.capacity = capacity;
    pool.chart = next.chart;
    pool.matrixDirty = next.matrixDirty;
    pool.colorDirty = next.colorDirty;
    pool.fade = next.fade;
    pool.fadeAttribute = next.fadeAttribute;
    pool.fadeDirty = next.fadeDirty;
    // createPool pushed nothing to this.pools; drop the temporary record.
    return true;
  }

  /** Latch this frame's CLIENT-bar toggle for every ornament profile. */
  beginFrame(): void {
    this.enabled = getTeamTrim();
    for (const pool of this.pools) {
      if (pool.mesh.visible !== this.enabled) pool.mesh.visible = this.enabled;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private allocFrom(poolIndex: number, hostScale: number): number {
    const pool = this.pools[poolIndex];
    let index = pool.free.pop();
    if (index === undefined) {
      if (pool.nextSlot >= pool.capacity && !this.growPool(pool)) return -1;
      index = pool.nextSlot++;
      if (pool.mesh.count < pool.nextSlot) pool.mesh.count = pool.nextSlot;
    }
    writeSurfaceChart(pool.chart, index, pool.chartId, hostScale);
    pool.fade[index] = 1;
    markDirtySlot(pool.fadeDirty, index);
    return encodeTrimSlot(poolIndex, index);
  }

  /**
   * A unit's rail-and-rib kit, fitted to its own body.
   *
   * The profile decides both the geometry and which pool it lands in, so two
   * units of the same shape share a draw call and a unit of a new shape gets
   * its own kit the first time one is built.
   */
  allocHostKit(
    profile: HostOrnamentProfile,
    instanceScale: number,
    tier: PrimitiveGeometryTier = 'close',
  ): number {
    const key = `host:${ornamentProfileKey(profile)}:${tier}`;
    return this.allocFrom(
      this.poolFor(
        key,
        `TeamTrimRenderer3D.HostKit.${tier}`,
        () => createHostOrnamentGeometry(profile, tier),
        liveryChartFor('liveryStrap', tier),
      ),
      ornamentChartScale(profile, instanceScale),
    );
  }

  /** Every turret's collar. One geometry per tier — the collar is a unit
   *  cylinder along +X and the turret's own head radius is instance scale. */
  allocTurretCollar(collarRadius: number, tier: PrimitiveGeometryTier = 'close'): number {
    const key = `collar:${tier}`;
    return this.allocFrom(
      this.poolFor(
        key,
        `TeamTrimRenderer3D.TurretCollar.${tier}`,
        () => createTurretCollarGeometry(tier),
        liveryChartFor('liveryCollar', tier),
      ),
      collarChartScale(collarRadius),
    );
  }

  /** Place an ornament instance. Sizes are the geometry's own axes: a host
   *  kit is authored in its host's space and takes one uniform scale; a
   *  collar is a unit cylinder along +X and takes (length, radius, radius). */
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
    if (slot < 0) return;
    const pool = this.pools[trimSlotPool(slot)];
    if (pool === undefined) return;
    const index = trimSlotIndex(slot);
    if (!this.enabled) {
      this.hideIn(pool, index);
      return;
    }
    this.scratchPosition.set(x, y, z);
    this.scratchScale.set(sizeX, sizeY, sizeZ);
    this.scratchMatrix.compose(
      this.scratchPosition,
      quaternion,
      this.scratchScale,
    );
    pool.mesh.setMatrixAt(index, this.scratchMatrix);
    markDirtySlot(pool.matrixDirty, index);

    const colors = pool.mesh.instanceColor;
    if (colors === null) return;
    this.scratchColor.setHex(colorHex);
    const i3 = index * 3;
    const arr = colors.array as Float32Array;
    if (
      arr[i3] !== this.scratchColor.r ||
      arr[i3 + 1] !== this.scratchColor.g ||
      arr[i3 + 2] !== this.scratchColor.b
    ) {
      arr[i3] = this.scratchColor.r;
      arr[i3 + 1] = this.scratchColor.g;
      arr[i3 + 2] = this.scratchColor.b;
      markDirtySlot(pool.colorDirty, index);
    }
  }

  /** A unit body kit rides one uniform scale — the host's render radius. */
  setHostKit(
    slot: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    scale: number,
    colorHex: number,
  ): void {
    this.set(slot, x, y, z, quaternion, scale, scale, scale, colorHex);
  }

  setTurretCollar(
    slot: number,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    length: number,
    radius: number,
    colorHex: number,
  ): void {
    this.set(slot, x, y, z, quaternion, length, radius, radius, colorHex);
  }

  private hideIn(pool: TrimPool, index: number): void {
    this.scratchPosition.set(0, 0, 0);
    this.scratchQuaternion.identity();
    this.scratchScale.set(ZERO_SCALE, ZERO_SCALE, ZERO_SCALE);
    this.scratchMatrix.compose(
      this.scratchPosition,
      this.scratchQuaternion,
      this.scratchScale,
    );
    pool.mesh.setMatrixAt(index, this.scratchMatrix);
    markDirtySlot(pool.matrixDirty, index);
  }

  hide(slot: number): void {
    if (slot < 0) return;
    const pool = this.pools[trimSlotPool(slot)];
    if (pool === undefined) return;
    this.hideIn(pool, trimSlotIndex(slot));
  }

  /** Apply the host entity's lifecycle alpha to this ornament instance. */
  fade(slot: number, alpha: number): void {
    if (slot < 0) return;
    const pool = this.pools[trimSlotPool(slot)];
    if (pool === undefined) return;
    const index = trimSlotIndex(slot);
    const clamped = Math.max(0, Math.min(1, alpha));
    if (pool.fade[index] === clamped) return;
    pool.fade[index] = clamped;
    markDirtySlot(pool.fadeDirty, index);
  }

  /** Capture the live textured instance itself as a death piece. */
  captureDeathPart(slot: number): EntityDeathRenderablePart3D | null {
    if (slot < 0) return null;
    const pool = this.pools[trimSlotPool(slot)];
    if (pool === undefined) return null;
    const index = trimSlotIndex(slot);
    const matrix = new THREE.Matrix4().fromArray(
      pool.mesh.instanceMatrix.array as ArrayLike<number>,
      index * 16,
    );
    const worldPosition = new THREE.Vector3().setFromMatrixPosition(matrix);
    return {
      worldPosition,
      applyDelta: (delta): void => {
        matrix.fromArray(pool.mesh.instanceMatrix.array as ArrayLike<number>, index * 16);
        matrix.decompose(this.scratchPosition, this.scratchQuaternion, this.scratchScale);
        this.scratchPosition.x += delta.dx;
        this.scratchPosition.y += delta.dy;
        this.scratchPosition.z += delta.dz;
        const rotation = this.scratchRotation.setFromEuler(
          this.scratchEuler.set(delta.drx, delta.dry, delta.drz, 'XYZ'),
        );
        this.scratchQuaternion.premultiply(rotation);
        matrix.compose(this.scratchPosition, this.scratchQuaternion, this.scratchScale);
        pool.mesh.setMatrixAt(index, matrix);
        markDirtySlot(pool.matrixDirty, index);
      },
    };
  }

  release(slot: number): void {
    if (slot < 0) return;
    const pool = this.pools[trimSlotPool(slot)];
    if (pool === undefined) return;
    const index = trimSlotIndex(slot);
    this.hideIn(pool, index);
    pool.fade[index] = 1;
    markDirtySlot(pool.fadeDirty, index);
    writeSurfaceChart(pool.chart, index, 'none');
    pool.free.push(index);
  }

  /** Upload every profile's dirty ranges once, after all host poses. */
  flush(): void {
    for (const pool of this.pools) {
      uploadDirtySlotSpan(pool.mesh.instanceMatrix, pool.matrixDirty, 16);
      const colors = pool.mesh.instanceColor;
      if (colors !== null) uploadDirtySlotSpan(colors, pool.colorDirty, 3);
      uploadDirtySlotSpan(pool.fadeAttribute, pool.fadeDirty, 1);
      uploadSurfaceChart(pool.chart);
    }
  }

  dispose(): void {
    for (const pool of this.pools) {
      this.world.remove(pool.mesh);
      disposeMesh(pool.mesh, { material: false, geometry: false });
      pool.geometry.dispose();
    }
    this.pools.length = 0;
    this.poolsByKey.clear();
    this.material.dispose();
  }
}
