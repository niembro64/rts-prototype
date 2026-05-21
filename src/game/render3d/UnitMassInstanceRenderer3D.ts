import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { ClientViewState } from '../network/ClientViewState';
import type { Entity, EntityId } from '../sim/types';
import type { RenderFrameState3D } from './RenderFrameState3D';
import {
  entityInstanceColorKey,
  setEntityInstanceColor,
} from './EntityInstanceColor3D';
import { disposeMesh } from './threeUtils';

const LOW_INSTANCED_CAP = 16384;
const LOW_INSTANCED_COMPACT_MIN_FREE = 128;
const LOW_INSTANCED_COMPACT_INTERVAL_FRAMES = 30;
const LOW_INSTANCED_COMPACT_MAX_MOVES = 256;

const INST_UP = new THREE.Vector3(0, 1, 0);
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

type DirtyRange = {
  matrixMinSlot: number;
  matrixMaxSlot: number;
};

type UnitMassInstanceRendererOptions = {
  world: THREE.Group;
  clientViewState: ClientViewState;
};

export class UnitMassInstanceRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;

  private readonly geometry = new THREE.SphereGeometry(1, 10, 8);
  private readonly mesh: THREE.InstancedMesh;
  private readonly slots = new Map<EntityId, number>();
  private readonly entityBySlot: (EntityId | undefined)[] = [];
  private readonly colorKeys = new Map<EntityId, number>();
  private readonly hiddenIds = new Set<EntityId>();
  private readonly freeSlots: number[] = [];
  private readonly seenIds = new Set<EntityId>();

  private readonly richUnits: Entity[] = [];

  private nextSlot = 0;
  private compactFrame = 0;
  private lastPrunedEntitySetVersion = -1;

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(options: UnitMassInstanceRendererOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;

    const material = new THREE.MeshLambertMaterial({ color: COLORS.units.turret.barrel.colorHex });
    this.mesh = new THREE.InstancedMesh(this.geometry, material, LOW_INSTANCED_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, this.color.set(COLORS.units.turret.barrel.colorHex));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < LOW_INSTANCED_CAP; i++) {
      this.mesh.setMatrixAt(i, ZERO_MATRIX);
    }
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.world.add(this.mesh);
  }

  hasSlots(): boolean {
    return this.slots.size > 0;
  }

  clearRichUnits(): void {
    this.richUnits.length = 0;
  }

  syncColorForEntity(entity: Entity): void {
    const slot = this.slots.get(entity.id);
    const colorKey = entityInstanceColorKey(entity);
    if (slot === undefined || this.colorKeys.get(entity.id) === colorKey) return;
    setEntityInstanceColor(this.mesh, slot, entity, this.color);
    this.colorKeys.set(entity.id, colorKey);
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(
    _frameState: RenderFrameState3D,
    units?: readonly Entity[],
    collectRichUnits = false,
  ): readonly Entity[] {
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const unitsToProcess = units ?? this.clientViewState.getUnits();

    const seen = this.seenIds;
    seen.clear();
    if (collectRichUnits) this.clearRichUnits();

    let colorDirty = false;
    let matrixMinSlot = Number.POSITIVE_INFINITY;
    let matrixMaxSlot = -1;
    let colorMinSlot = Number.POSITIVE_INFINITY;
    let colorMaxSlot = -1;
    const matrixDirty = { matrixMinSlot, matrixMaxSlot };

    for (const entity of unitsToProcess) {
      seen.add(entity.id);
      if (collectRichUnits) {
        this.addRichUnit(entity);
        this.hideSlot(entity.id, this.slots.get(entity.id), matrixDirty);
        continue;
      }

      let slot = this.slots.get(entity.id);
      if (slot === undefined) {
        if (this.freeSlots.length > 0) {
          slot = this.freeSlots.pop()!;
        } else if (this.nextSlot < LOW_INSTANCED_CAP) {
          slot = this.nextSlot++;
        } else {
          continue;
        }
        this.slots.set(entity.id, slot);
        this.entityBySlot[slot] = entity.id;
      }
      this.hiddenIds.delete(entity.id);

      const radius = entity.unit?.radius.body ?? entity.unit?.radius.shot ?? 15;
      this.pos.set(entity.transform.x, entity.transform.z, entity.transform.y);
      this.quat.setFromAxisAngle(INST_UP, -entity.transform.rotation);
      this.scale.set(radius, radius, radius);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(slot, this.matrix);
      if (slot < matrixDirty.matrixMinSlot) matrixDirty.matrixMinSlot = slot;
      if (slot > matrixDirty.matrixMaxSlot) matrixDirty.matrixMaxSlot = slot;

      const colorKey = entityInstanceColorKey(entity);
      if (this.colorKeys.get(entity.id) !== colorKey) {
        setEntityInstanceColor(this.mesh, slot, entity, this.color);
        this.colorKeys.set(entity.id, colorKey);
        colorDirty = true;
        if (slot < colorMinSlot) colorMinSlot = slot;
        if (slot > colorMaxSlot) colorMaxSlot = slot;
      }
    }

    if (entitySetVersion !== this.lastPrunedEntitySetVersion) {
      for (const [id, slot] of this.slots) {
        if (!seen.has(id)) {
          this.mesh.setMatrixAt(slot, ZERO_MATRIX);
          if (slot < matrixDirty.matrixMinSlot) matrixDirty.matrixMinSlot = slot;
          if (slot > matrixDirty.matrixMaxSlot) matrixDirty.matrixMaxSlot = slot;
          this.freeSlots.push(slot);
          this.entityBySlot[slot] = undefined;
          this.slots.delete(id);
          this.colorKeys.delete(id);
          this.hiddenIds.delete(id);
        }
      }
      this.lastPrunedEntitySetVersion = entitySetVersion;
    }

    matrixMinSlot = matrixDirty.matrixMinSlot;
    matrixMaxSlot = matrixDirty.matrixMaxSlot;
    this.nextSlot = this.trimFreeTail(this.freeSlots, this.nextSlot);
    const compacted = this.compactSlots();
    if (compacted.matrixMaxSlot >= compacted.matrixMinSlot) {
      matrixMinSlot = Math.min(matrixMinSlot, compacted.matrixMinSlot);
      matrixMaxSlot = Math.max(matrixMaxSlot, compacted.matrixMaxSlot);
    }
    if (compacted.colorDirty) {
      colorDirty = true;
      colorMinSlot = Math.min(colorMinSlot, compacted.colorMinSlot);
      colorMaxSlot = Math.max(colorMaxSlot, compacted.colorMaxSlot);
    }

    this.mesh.count = this.nextSlot;
    this.markMatrixRange(matrixMinSlot, matrixMaxSlot);
    if (colorDirty) this.markColorRange(colorMinSlot, colorMaxSlot);
    return this.richUnits;
  }

  releaseAll(): void {
    for (const slot of this.slots.values()) {
      this.mesh.setMatrixAt(slot, ZERO_MATRIX);
    }
    this.slots.clear();
    this.entityBySlot.length = 0;
    this.colorKeys.clear();
    this.hiddenIds.clear();
    this.clearRichUnits();
    this.freeSlots.length = 0;
    this.nextSlot = 0;
    this.compactFrame = 0;
    this.lastPrunedEntitySetVersion = -1;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  destroy(): void {
    this.releaseAll();
    disposeMesh(this.mesh);
    this.seenIds.clear();
  }

  private addRichUnit(entity: Entity): void {
    this.richUnits.push(entity);
  }

  private hideSlot(entityId: EntityId, slot: number | undefined, dirty: DirtyRange): void {
    if (slot === undefined || this.hiddenIds.has(entityId)) return;
    this.mesh.setMatrixAt(slot, ZERO_MATRIX);
    this.hiddenIds.add(entityId);
    if (slot < dirty.matrixMinSlot) dirty.matrixMinSlot = slot;
    if (slot > dirty.matrixMaxSlot) dirty.matrixMaxSlot = slot;
  }

  private compactSlots(): {
    matrixMinSlot: number;
    matrixMaxSlot: number;
    colorMinSlot: number;
    colorMaxSlot: number;
    colorDirty: boolean;
  } {
    const result = {
      matrixMinSlot: Number.POSITIVE_INFINITY,
      matrixMaxSlot: -1,
      colorMinSlot: Number.POSITIVE_INFINITY,
      colorMaxSlot: -1,
      colorDirty: false,
    };

    if (this.freeSlots.length < LOW_INSTANCED_COMPACT_MIN_FREE) return result;
    if ((this.compactFrame++ % LOW_INSTANCED_COMPACT_INTERVAL_FRAMES) !== 0) return result;

    this.freeSlots.sort((a, b) => a - b);
    let moves = 0;
    let nextSlot = this.nextSlot;

    for (let freeIndex = 0; freeIndex < this.freeSlots.length && moves < LOW_INSTANCED_COMPACT_MAX_MOVES;) {
      nextSlot = this.trimFreeTail(this.freeSlots, nextSlot);
      const freeSlot = this.freeSlots[freeIndex];
      if (freeSlot >= nextSlot) {
        this.freeSlots.splice(freeIndex, 1);
        continue;
      }

      let tailSlot = nextSlot - 1;
      while (tailSlot > freeSlot && this.entityBySlot[tailSlot] === undefined) {
        const tailFreeIdx = this.freeSlots.indexOf(tailSlot);
        if (tailFreeIdx >= 0) this.freeSlots.splice(tailFreeIdx, 1);
        nextSlot = tailSlot;
        tailSlot = nextSlot - 1;
      }
      if (tailSlot <= freeSlot) break;

      const tailEntityId = this.entityBySlot[tailSlot];
      if (tailEntityId === undefined) break;

      this.mesh.getMatrixAt(tailSlot, this.matrix);
      this.mesh.setMatrixAt(freeSlot, this.matrix);
      this.mesh.setMatrixAt(tailSlot, ZERO_MATRIX);
      if (this.mesh.instanceColor) {
        this.mesh.getColorAt(tailSlot, this.color);
        this.mesh.setColorAt(freeSlot, this.color);
        result.colorDirty = true;
        result.colorMinSlot = Math.min(result.colorMinSlot, freeSlot, tailSlot);
        result.colorMaxSlot = Math.max(result.colorMaxSlot, freeSlot, tailSlot);
      }

      this.slots.set(tailEntityId, freeSlot);
      this.entityBySlot[freeSlot] = tailEntityId;
      this.entityBySlot[tailSlot] = undefined;

      this.freeSlots.splice(freeIndex, 1);
      this.freeSlots.push(tailSlot);
      result.matrixMinSlot = Math.min(result.matrixMinSlot, freeSlot, tailSlot);
      result.matrixMaxSlot = Math.max(result.matrixMaxSlot, freeSlot, tailSlot);
      moves++;
    }

    this.nextSlot = this.trimFreeTail(this.freeSlots, nextSlot);
    return result;
  }

  private markMatrixRange(minSlot: number, maxSlot: number): void {
    if (maxSlot < minSlot) return;
    const attr = this.mesh.instanceMatrix;
    attr.clearUpdateRanges();
    attr.addUpdateRange(minSlot * 16, (maxSlot - minSlot + 1) * 16);
    attr.needsUpdate = true;
  }

  private markColorRange(minSlot: number, maxSlot: number): void {
    if (!this.mesh.instanceColor || maxSlot < minSlot) return;
    const attr = this.mesh.instanceColor;
    attr.clearUpdateRanges();
    attr.addUpdateRange(minSlot * 3, (maxSlot - minSlot + 1) * 3);
    attr.needsUpdate = true;
  }

  private trimFreeTail(freeSlots: number[], nextSlot: number): number {
    while (nextSlot > 0) {
      const tail = nextSlot - 1;
      const i = freeSlots.indexOf(tail);
      if (i < 0) break;
      freeSlots.splice(i, 1);
      nextSlot = tail;
    }
    return nextSlot;
  }
}
