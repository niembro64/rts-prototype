import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import { landCellIndexForSize } from '../landGrid';
import { normalizeLodCellSize } from '../lodGridMath';
import { shouldRunOnStride } from '../math';
import type { Entity, EntityId } from '../sim/types';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { Lod3DState } from './Lod3D';
import {
  isRichObjectLod,
  type RenderObjectLodTier,
} from './RenderObjectLod';
import {
  entityInstanceColorKey,
  isConstructionShell,
  setEntityInstanceColor,
} from './EntityInstanceColor3D';
import { disposeMesh } from './threeUtils';

const LOW_INSTANCED_CAP = 16384;
const LOW_INSTANCED_COMPACT_MIN_FREE = 128;
const LOW_INSTANCED_COMPACT_INTERVAL_FRAMES = 30;
const LOW_INSTANCED_COMPACT_MAX_MOVES = 256;
const UNIT_INSTANCED_FULL_REFRESH_INTERVAL_FRAMES = 120;
const RICH_UNIT_PROMOTION_BUDGET_PER_FRAME = 64;
const MASS_INSTANCE_VERTICAL_TRANSFORM_EPSILON = 0.05;
const MASS_INSTANCE_VERTICAL_VELOCITY_EPSILON = 0.05;
const MASS_INSTANCE_MATRIX_STRIDE: Record<RenderObjectLodTier, number> = {
  hero: 1,
  rich: 1,
  simple: 1,
  mass: 2,
  impostor: 4,
  marker: 8,
};

const INST_UP = new THREE.Vector3(0, 1, 0);
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

type DirtyRange = {
  matrixMinSlot: number;
  matrixMaxSlot: number;
};

type UnitMassInstanceRendererOptions = {
  world: THREE.Group;
  clientViewState: ClientViewState;
  scope: ViewportFootprint;
  resolveObjectLod: (entity: Entity) => RenderObjectLodTier;
  hasSceneMesh: (entityId: EntityId) => boolean;
};

export class UnitMassInstanceRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly scope: ViewportFootprint;
  private readonly resolveObjectLod: (entity: Entity) => RenderObjectLodTier;
  private readonly hasSceneMesh: (entityId: EntityId) => boolean;

  private readonly geometry = new THREE.SphereGeometry(1, 10, 8);
  private readonly mesh: THREE.InstancedMesh;
  private readonly slots = new Map<EntityId, number>();
  private readonly entityBySlot: (EntityId | undefined)[] = [];
  private readonly colorKeys = new Map<EntityId, number>();
  private readonly lastMatrixZ = new Map<EntityId, number>();
  private readonly hiddenIds = new Set<EntityId>();
  private readonly freeSlots: number[] = [];
  private readonly seenIds = new Set<EntityId>();

  private readonly richIds = new Set<EntityId>();
  private readonly richUnits: Entity[] = [];
  private readonly richUnitIndex = new Map<EntityId, number>();
  private readonly richObjectTiers = new Map<EntityId, RenderObjectLodTier>();
  private readonly activeUnits: Entity[] = [];

  private nextSlot = 0;
  private compactFrame = 0;
  private frame = 0;
  private lastFullPassFrame = -1;
  private lastFullPassEntitySetVersion = -1;
  private lastPrunedEntitySetVersion = -1;
  private lastFullPassLodKey = '';
  private lastFullPassCellSize = 0;
  private lastFullPassCameraCellX = 0;
  private lastFullPassCameraCellY = 0;

  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(options: UnitMassInstanceRendererOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.scope = options.scope;
    this.resolveObjectLod = options.resolveObjectLod;
    this.hasSceneMesh = options.hasSceneMesh;

    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(this.geometry, material, LOW_INSTANCED_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, this.color.set(0xffffff));
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

  getRichObjectTier(entityId: EntityId): RenderObjectLodTier | undefined {
    return this.richObjectTiers.get(entityId);
  }

  clearRichUnits(): void {
    this.richIds.clear();
    this.richUnits.length = 0;
    this.richUnitIndex.clear();
    this.richObjectTiers.clear();
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
    lod: Lod3DState,
    units?: readonly Entity[],
    collectRichUnits = false,
  ): readonly Entity[] {
    this.frame = (this.frame + 1) & 0x3fffffff;
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const fullPass = this.shouldRunFullPass(lod, entitySetVersion, collectRichUnits);
    const unitsToProcess = fullPass
      ? (units ?? this.clientViewState.getUnits())
      : this.clientViewState.collectActiveUnitRenderEntities(this.activeUnits);
    if (fullPass) this.lastFullPassFrame = this.frame;

    const seen = this.seenIds;
    seen.clear();
    if (collectRichUnits && fullPass) this.clearRichUnits();

    let colorDirty = false;
    let matrixMinSlot = Number.POSITIVE_INFINITY;
    let matrixMaxSlot = -1;
    let colorMinSlot = Number.POSITIVE_INFINITY;
    let colorMaxSlot = -1;
    const matrixDirty = { matrixMinSlot, matrixMaxSlot };
    let richPromotionsThisFrame = 0;

    for (const entity of unitsToProcess) {
      seen.add(entity.id);
      const objectTier = this.resolveObjectLod(entity);
      const inScope = this.scope.inScope(entity.transform.x, entity.transform.y, 100);
      if (collectRichUnits) {
        if (inScope && (isConstructionShell(entity) || isRichObjectLod(objectTier) || objectTier === 'simple')) {
          const alreadyRich = this.richIds.has(entity.id);
          const hasSceneMesh = this.hasSceneMesh(entity.id);
          const canPromote =
            alreadyRich ||
            hasSceneMesh ||
            richPromotionsThisFrame < RICH_UNIT_PROMOTION_BUDGET_PER_FRAME;
          if (canPromote) {
            if (!alreadyRich && !hasSceneMesh) richPromotionsThisFrame++;
            this.addRichUnit(entity, objectTier);
            this.hideSlot(entity.id, this.slots.get(entity.id), matrixDirty);
            continue;
          }
        }
        this.removeRichUnit(entity.id);
      }

      let slot = this.slots.get(entity.id);
      let slotWasNew = false;
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
        slotWasNew = true;
      }
      const wasHidden = this.hiddenIds.delete(entity.id);

      if (this.shouldUpdateMatrix(entity, objectTier, slotWasNew, wasHidden)) {
        const radius = entity.unit?.radius.body ?? entity.unit?.radius.shot ?? 15;
        this.pos.set(entity.transform.x, entity.transform.z, entity.transform.y);
        this.quat.setFromAxisAngle(INST_UP, -entity.transform.rotation);
        this.scale.set(radius, radius, radius);
        this.matrix.compose(this.pos, this.quat, this.scale);
        this.mesh.setMatrixAt(slot, this.matrix);
        this.lastMatrixZ.set(entity.id, entity.transform.z);
        if (slot < matrixDirty.matrixMinSlot) matrixDirty.matrixMinSlot = slot;
        if (slot > matrixDirty.matrixMaxSlot) matrixDirty.matrixMaxSlot = slot;
      }

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
          this.lastMatrixZ.delete(id);
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
    this.lastMatrixZ.clear();
    this.hiddenIds.clear();
    this.clearRichUnits();
    this.freeSlots.length = 0;
    this.nextSlot = 0;
    this.compactFrame = 0;
    this.frame = 0;
    this.lastFullPassFrame = -1;
    this.lastFullPassEntitySetVersion = -1;
    this.lastPrunedEntitySetVersion = -1;
    this.lastFullPassLodKey = '';
    this.lastFullPassCellSize = 0;
    this.lastFullPassCameraCellX = 0;
    this.lastFullPassCameraCellY = 0;
    this.activeUnits.length = 0;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  destroy(): void {
    this.releaseAll();
    disposeMesh(this.mesh);
    this.seenIds.clear();
  }

  private shouldUpdateMatrix(
    entity: Entity,
    tier: RenderObjectLodTier,
    slotWasNew: boolean,
    wasHidden: boolean,
  ): boolean {
    if (slotWasNew || wasHidden) return true;
    if (entity.selectable?.selected === true) return true;
    if (this.hasFreshVerticalMatrixNeed(entity)) return true;
    const stride = MASS_INSTANCE_MATRIX_STRIDE[tier] ?? 1;
    return shouldRunOnStride(this.frame, stride, entity.id);
  }

  private hasFreshVerticalMatrixNeed(entity: Entity): boolean {
    const unit = entity.unit;
    if (!unit) return false;
    if (Math.abs(unit.velocityZ ?? 0) > MASS_INSTANCE_VERTICAL_VELOCITY_EPSILON) {
      return true;
    }
    const lastZ = this.lastMatrixZ.get(entity.id);
    return (
      lastZ !== undefined &&
      Math.abs(entity.transform.z - lastZ) > MASS_INSTANCE_VERTICAL_TRANSFORM_EPSILON
    );
  }

  private shouldRunFullPass(
    lod: Lod3DState,
    entitySetVersion: number,
    collectRichUnits: boolean,
  ): boolean {
    const size = normalizeLodCellSize(lod.gfx.objectLodCellSize);
    const view = lod.view;
    const cameraCellX = landCellIndexForSize(view.cameraX, size);
    const cameraCellY = landCellIndexForSize(view.cameraZ, size);
    if (
      entitySetVersion !== this.lastFullPassEntitySetVersion ||
      lod.key !== this.lastFullPassLodKey ||
      size !== this.lastFullPassCellSize ||
      cameraCellX !== this.lastFullPassCameraCellX ||
      cameraCellY !== this.lastFullPassCameraCellY
    ) {
      this.lastFullPassEntitySetVersion = entitySetVersion;
      this.lastFullPassLodKey = lod.key;
      this.lastFullPassCellSize = size;
      this.lastFullPassCameraCellX = cameraCellX;
      this.lastFullPassCameraCellY = cameraCellY;
      return true;
    }
    if (!collectRichUnits) return false;
    return (
      this.lastFullPassFrame < 0 ||
      this.frame - this.lastFullPassFrame >= UNIT_INSTANCED_FULL_REFRESH_INTERVAL_FRAMES
    );
  }

  private addRichUnit(entity: Entity, objectTier: RenderObjectLodTier): void {
    if (!this.richIds.has(entity.id)) {
      this.richIds.add(entity.id);
      this.richUnitIndex.set(entity.id, this.richUnits.length);
      this.richUnits.push(entity);
    }
    this.richObjectTiers.set(entity.id, objectTier);
  }

  private removeRichUnit(id: EntityId): void {
    if (!this.richIds.delete(id)) return;
    this.richObjectTiers.delete(id);
    const idx = this.richUnitIndex.get(id);
    this.richUnitIndex.delete(id);
    if (idx === undefined) return;
    const lastIdx = this.richUnits.length - 1;
    const last = this.richUnits[lastIdx];
    if (idx !== lastIdx && last) {
      this.richUnits[idx] = last;
      this.richUnitIndex.set(last.id, idx);
    }
    this.richUnits.pop();
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
