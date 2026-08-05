import * as THREE from 'three';
import { getTeamTrim } from '@/clientBarConfig';
import { disposeMesh } from './threeUtils';
import {
  createDirtySlotSpan,
  markDirtySlot,
  uploadDirtySlotSpan,
} from './instancedBufferUpdate';

/**
 * TeamTrimRenderer3D — the team-colored trim every entity wears.
 *
 * A seat has two identities (see src/game/sim/teamRoster.ts): the SIDE it
 * plays on and the seat itself. The body carries the player color; this
 * carries the side. Trim is added GEOMETRY, not a recolor of the body —
 * a dorsal fin on a unit, corner pylons on a building — so a unit reads
 * as its alliance from the top-down camera without the hull having to
 * give up its own color.
 *
 * PERFORMANCE. Client frame time here is set by Object3D count, which is
 * why static props live under StaticPropContainer. Trim must therefore
 * never be a child mesh per entity: every piece is one instance in one
 * shared InstancedMesh, and the whole system costs exactly one draw call
 * no matter how many entities are on the map.
 *
 * Slot lifecycle mirrors LegInstancedRenderer: alloc() takes a slot off a
 * LIFO free list, set() writes its world transform and color, free()
 * hides it and returns it, flush() uploads only the dirty spans once per
 * frame. A pool-exhausted alloc() returns -1 and the caller silently
 * skips drawing that piece — trim is cosmetic and must never be able to
 * break a frame.
 */

/** One box per unit plus a handful per building; 16384 leaves headroom
 *  well past the unit cap. */
const SLOT_CAP = 16384;

/** Hidden slots are parked at a zero-scale matrix rather than removed,
 *  so freeing never has to rewrite the buffer layout. */
const ZERO_SCALE = 0;

export class TeamTrimRenderer3D {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshLambertMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly free: number[] = [];
  private nextSlot = 0;
  private readonly matrixDirty = createDirtySlotSpan();
  private readonly colorDirty = createDirtySlotSpan();
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  /** Read once per frame from the CLIENT bar. Ornamentation is a work in
   *  progress, so it ships off and the player opts in. */
  private enabled = false;

  constructor(private readonly world: THREE.Group) {
    // A box reads as painted trim from every angle and needs no LOD tier
    // of its own — 12 triangles is already below any tier we would pick.
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    // `vertexColors` below makes the shader read a per-vertex `color`
    // attribute AND multiply in instanceColor. BoxGeometry ships no
    // color attribute, so without this the per-vertex term is zero and
    // every instance renders black however the instance colors are set.
    // A constant white attribute makes the instance color the only term.
    const vertexCount = this.geometry.getAttribute('position').count;
    const whites = new Float32Array(vertexCount * 3).fill(1);
    this.geometry.setAttribute('color', new THREE.BufferAttribute(whites, 3));
    // `vertexColors` is what lets the fragment stage multiply in
    // instanceColor — without it every instance renders white however
    // the color buffer is filled. Same reason LegInstancedRenderer sets
    // it on its own instanced materials.
    this.material = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
    });
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, SLOT_CAP);
    this.mesh.name = 'TeamTrimRenderer3D';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Trim rides the body's own visibility; culling it independently
    // would pop a fin off a unit that is still on screen.
    this.mesh.frustumCulled = false;
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(SLOT_CAP * 3), 3);
    colors.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = colors;
    world.add(this.mesh);
  }

  /** Latch this frame's CLIENT-bar toggle. Call once before any set().
   *  Gating here rather than at each call site means every trim piece —
   *  present and future — is covered by the one switch, and slots stay
   *  allocated so toggling back on is immediate. */
  beginFrame(): void {
    this.enabled = getTeamTrim();
    if (!this.enabled && this.mesh.visible) this.mesh.visible = false;
    else if (this.enabled && !this.mesh.visible) this.mesh.visible = true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Take a slot, or -1 when the pool is full. */
  alloc(): number {
    const reused = this.free.pop();
    if (reused !== undefined) return reused;
    if (this.nextSlot >= SLOT_CAP) return -1;
    const slot = this.nextSlot++;
    if (this.mesh.count < this.nextSlot) this.mesh.count = this.nextSlot;
    return slot;
  }

  /**
   * Place one trim piece in world space. `sizeX/Y/Z` are full extents, not
   * half-extents, matching the unit box geometry. Callers pass the entity's
   * own world orientation so the trim yaws and tilts with the body.
   */
  set(
    slot: number,
    x: number, y: number, z: number,
    quaternion: THREE.Quaternion,
    sizeX: number, sizeY: number, sizeZ: number,
    colorHex: number,
  ): void {
    if (slot < 0) return;
    if (!this.enabled) {
      this.hide(slot);
      return;
    }
    this.scratchPosition.set(x, y, z);
    this.scratchScale.set(sizeX, sizeY, sizeZ);
    this.scratchMatrix.compose(this.scratchPosition, quaternion, this.scratchScale);
    this.mesh.setMatrixAt(slot, this.scratchMatrix);
    markDirtySlot(this.matrixDirty, slot);

    const colors = this.mesh.instanceColor;
    if (colors !== null) {
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
        markDirtySlot(this.colorDirty, slot);
      }
    }
  }

  /** Hide a slot without releasing it — for a piece whose entity is out
   *  of render scope or shed by LOD this frame but still alive. */
  hide(slot: number): void {
    if (slot < 0) return;
    this.scratchPosition.set(0, 0, 0);
    this.scratchQuaternion.identity();
    this.scratchScale.set(ZERO_SCALE, ZERO_SCALE, ZERO_SCALE);
    this.scratchMatrix.compose(
      this.scratchPosition,
      this.scratchQuaternion,
      this.scratchScale,
    );
    this.mesh.setMatrixAt(slot, this.scratchMatrix);
    markDirtySlot(this.matrixDirty, slot);
  }

  release(slot: number): void {
    if (slot < 0) return;
    this.hide(slot);
    this.free.push(slot);
  }

  /** Upload the frame's dirty spans. Call once, after every entity has
   *  written its trim. */
  flush(): void {
    uploadDirtySlotSpan(this.mesh.instanceMatrix, this.matrixDirty, 16);
    const colors = this.mesh.instanceColor;
    if (colors !== null) uploadDirtySlotSpan(colors, this.colorDirty, 3);
  }

  dispose(): void {
    this.world.remove(this.mesh);
    disposeMesh(this.mesh, { material: false, geometry: false });
    this.geometry.dispose();
    this.material.dispose();
  }
}
