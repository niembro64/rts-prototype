import * as THREE from 'three';
import { SHELL_PALE_HEX } from '@/shellConfig';
import type { Entity, EntityId } from '../sim/types';
import type { EntityMesh } from './EntityMesh3D';
import {
  entityInstanceColorKey,
  isConstructionShell,
  setEntityInstanceColor,
} from './EntityInstanceColor3D';
import {
  createMirrorReflectorPanelMaterial,
  MIRROR_REFLECTOR_PANEL_COLOR,
  resolveMirrorReflectorPanelColor,
} from './MirrorReflectorVisual3D';
import { disposeMesh } from './threeUtils';

const SMOOTH_CHASSIS_CAP = 16384;
const POLY_CHASSIS_CAP = 4096;
const TURRET_HEAD_CAP = 16384;
const BARREL_CAP = 32768;
const MIRROR_PANEL_CAP = 1024;
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

type PolyChassisPool = {
  mesh: THREE.InstancedMesh;
  slots: Map<EntityId, number>;
  colorKeys: Map<EntityId, number>;
  colorDirty: boolean;
  freeSlots: number[];
  nextSlot: number;
};

type UnitDetailInstanceRendererOptions = {
  world: THREE.Group;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  barrelMat: THREE.Material;
  mirrorGeom: THREE.BoxGeometry;
};

export class UnitDetailInstanceRenderer3D {
  private readonly world: THREE.Group;
  private readonly smoothChassisGeom = new THREE.SphereGeometry(1, 24, 16);
  private readonly smoothChassis: THREE.InstancedMesh;
  private readonly smoothChassisSlots = new Map<EntityId, number[]>();
  private readonly smoothChassisColorKey = new Map<EntityId, number>();
  private smoothChassisColorDirty = false;
  private readonly smoothChassisFreeSlots: number[] = [];
  private smoothChassisNextSlot = 0;

  private readonly polyChassis = new Map<string, PolyChassisPool>();

  private readonly turretHeadInstanced: THREE.InstancedMesh;
  private readonly turretHeadColorKey = new Map<number, number>();
  private turretHeadColorDirty = false;
  private readonly turretHeadFreeSlots: number[] = [];
  private turretHeadNextSlot = 0;

  private readonly barrelInstanced: THREE.InstancedMesh;
  private readonly barrelColorKey = new Map<number, number>();
  private readonly barrelFreeSlots: number[] = [];
  private barrelNextSlot = 0;

  private readonly mirrorPanelInstanced: THREE.InstancedMesh;
  private readonly mirrorPanelColorKey = new Map<number, number>();
  private mirrorPanelColorDirty = false;
  private readonly mirrorPanelFreeSlots: number[] = [];
  private mirrorPanelNextSlot = 0;

  private readonly scratchColor = new THREE.Color();

  constructor(options: UnitDetailInstanceRendererOptions) {
    this.world = options.world;

    this.smoothChassis = this.createPool(
      this.smoothChassisGeom,
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      SMOOTH_CHASSIS_CAP,
      0xffffff,
    );

    this.turretHeadInstanced = this.createPool(
      options.turretHeadGeom.clone(),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      TURRET_HEAD_CAP,
      0xffffff,
    );

    this.barrelInstanced = this.createPool(
      options.barrelGeom.clone(),
      options.barrelMat.clone(),
      BARREL_CAP,
      0xffffff,
    );

    this.mirrorPanelInstanced = this.createPool(
      options.mirrorGeom.clone(),
      createMirrorReflectorPanelMaterial(),
      MIRROR_PANEL_CAP,
      MIRROR_REFLECTOR_PANEL_COLOR,
    );
    this.mirrorPanelInstanced.renderOrder = 7;
  }

  allocSmoothChassisSlots(count: number): number[] | null {
    if (count <= 0) return [];
    const out: number[] = [];
    for (let k = 0; k < count; k++) {
      let slot: number;
      if (this.smoothChassisFreeSlots.length > 0) {
        slot = this.smoothChassisFreeSlots.pop()!;
      } else if (this.smoothChassisNextSlot < SMOOTH_CHASSIS_CAP) {
        slot = this.smoothChassisNextSlot++;
      } else {
        for (const s of out) this.smoothChassisFreeSlots.push(s);
        return null;
      }
      out.push(slot);
    }
    return out;
  }

  registerSmoothChassisSlots(entityId: EntityId, slots: number[]): void {
    this.smoothChassisSlots.set(entityId, slots);
  }

  allocPolyChassisSlot(
    bodyShapeKey: string,
    geom: THREE.BufferGeometry,
    entityId: EntityId,
  ): number | null {
    const pool = this.getOrCreatePolyPool(bodyShapeKey, geom);
    let slot: number;
    if (pool.freeSlots.length > 0) {
      slot = pool.freeSlots.pop()!;
    } else if (pool.nextSlot < POLY_CHASSIS_CAP) {
      slot = pool.nextSlot++;
    } else {
      return null;
    }
    pool.slots.set(entityId, slot);
    return slot;
  }

  allocTurretHeadSlot(): number | null {
    if (this.turretHeadFreeSlots.length > 0) return this.turretHeadFreeSlots.pop()!;
    if (this.turretHeadNextSlot >= TURRET_HEAD_CAP) return null;
    return this.turretHeadNextSlot++;
  }

  allocBarrelSlots(count: number): number[] | null {
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      const slot = this.allocBarrelSlot();
      if (slot === null) {
        for (const allocated of slots) this.freeBarrelSlot(allocated);
        return null;
      }
      slots.push(slot);
    }
    return slots;
  }

  allocMirrorPanelSlots(count: number): number[] | null {
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      const slot = this.allocMirrorPanelSlot();
      if (slot === null) {
        for (const allocated of slots) this.freeMirrorPanelSlot(allocated);
        return null;
      }
      slots.push(slot);
    }
    return slots;
  }

  freeMeshSlots(entityId: EntityId, mesh: EntityMesh): void {
    if (mesh.smoothChassisSlots) this.freeSmoothChassisSlotsForEntity(entityId);
    if (mesh.polyChassisSlot !== undefined) {
      this.freePolyChassisSlotForEntity(mesh.bodyShapeKey, entityId);
    }
    for (const turret of mesh.turrets) {
      if (turret.headSlot !== undefined) this.freeTurretHeadSlot(turret.headSlot);
      if (turret.barrelSlots) {
        for (const slot of turret.barrelSlots) this.freeBarrelSlot(slot);
      }
    }
    if (mesh.mirrors?.panelSlots) {
      for (const slot of mesh.mirrors.panelSlots) this.freeMirrorPanelSlot(slot);
    }
  }

  releaseAllSlots(): void {
    this.releaseAllSmoothChassisSlots();
    this.releaseAllPolyChassisSlots();
    this.releaseAllTurretHeadSlots();
    this.releaseAllBarrelSlots();
    this.releaseAllMirrorPanelSlots();
  }

  syncShellColors(entity: Entity, mesh: EntityMesh): void {
    const colorKey = entityInstanceColorKey(entity);

    if (
      mesh.smoothChassisSlots &&
      this.smoothChassisColorKey.get(entity.id) !== colorKey
    ) {
      for (const slot of mesh.smoothChassisSlots) {
        setEntityInstanceColor(this.smoothChassis, slot, entity, this.scratchColor);
      }
      this.smoothChassisColorKey.set(entity.id, colorKey);
      this.smoothChassisColorDirty = true;
    }

    if (mesh.polyChassisSlot !== undefined && mesh.bodyShapeKey) {
      const pool = this.polyChassis.get(mesh.bodyShapeKey);
      if (pool && pool.colorKeys.get(entity.id) !== colorKey) {
        setEntityInstanceColor(pool.mesh, mesh.polyChassisSlot, entity, this.scratchColor);
        pool.colorKeys.set(entity.id, colorKey);
        pool.mesh.instanceColor!.needsUpdate = true;
      }
    }

    for (const turret of mesh.turrets) {
      if (
        turret.headSlot !== undefined &&
        this.turretHeadColorKey.get(turret.headSlot) !== colorKey
      ) {
        setEntityInstanceColor(this.turretHeadInstanced, turret.headSlot, entity, this.scratchColor);
        this.turretHeadColorKey.set(turret.headSlot, colorKey);
        this.turretHeadInstanced.instanceColor!.needsUpdate = true;
      }
      if (turret.barrelSlots) {
        const barrelColorKey = isConstructionShell(entity) ? SHELL_PALE_HEX : 0xffffff;
        for (const slot of turret.barrelSlots) {
          if (this.barrelColorKey.get(slot) === barrelColorKey) continue;
          this.scratchColor.set(barrelColorKey);
          this.barrelInstanced.setColorAt(slot, this.scratchColor);
          this.barrelColorKey.set(slot, barrelColorKey);
          this.barrelInstanced.instanceColor!.needsUpdate = true;
        }
      }
    }

    if (mesh.mirrors?.panelSlots) {
      const mirrorColorKey = resolveMirrorReflectorPanelColor(entity);
      this.scratchColor.set(mirrorColorKey);
      for (const slot of mesh.mirrors.panelSlots) {
        if (this.mirrorPanelColorKey.get(slot) === mirrorColorKey) continue;
        this.mirrorPanelInstanced.setColorAt(slot, this.scratchColor);
        this.mirrorPanelColorKey.set(slot, mirrorColorKey);
        this.mirrorPanelInstanced.instanceColor!.needsUpdate = true;
      }
    }
  }

  hideChassisSlots(mesh: EntityMesh): void {
    if (mesh.smoothChassisSlots) {
      for (const slot of mesh.smoothChassisSlots) {
        this.smoothChassis.setMatrixAt(slot, ZERO_MATRIX);
      }
    } else if (mesh.polyChassisSlot !== undefined) {
      const pool = this.polyChassis.get(mesh.bodyShapeKey);
      if (pool) pool.mesh.setMatrixAt(mesh.polyChassisSlot, ZERO_MATRIX);
    }
  }

  prepareSmoothChassisColor(entity: Entity): boolean {
    const colorKey = entityInstanceColorKey(entity);
    const writeColor = this.smoothChassisColorKey.get(entity.id) !== colorKey;
    if (writeColor) {
      this.smoothChassisColorKey.set(entity.id, colorKey);
      this.smoothChassisColorDirty = true;
    }
    return writeColor;
  }

  writeSmoothChassisMatrix(
    slot: number,
    matrix: THREE.Matrix4,
    entity: Entity,
    writeColor: boolean,
  ): void {
    this.smoothChassis.setMatrixAt(slot, matrix);
    if (writeColor) setEntityInstanceColor(this.smoothChassis, slot, entity, this.scratchColor);
  }

  writePolyChassisMatrix(
    entity: Entity,
    bodyShapeKey: string,
    slot: number,
    matrix: THREE.Matrix4,
  ): void {
    const pool = this.polyChassis.get(bodyShapeKey);
    if (!pool) return;
    const colorKey = entityInstanceColorKey(entity);
    const writeColor = pool.colorKeys.get(entity.id) !== colorKey;
    if (writeColor) {
      pool.colorKeys.set(entity.id, colorKey);
      pool.colorDirty = true;
    }
    pool.mesh.setMatrixAt(slot, matrix);
    if (writeColor) setEntityInstanceColor(pool.mesh, slot, entity, this.scratchColor);
  }

  writeTurretHeadMatrix(slot: number, matrix: THREE.Matrix4, entity: Entity): void {
    this.turretHeadInstanced.setMatrixAt(slot, matrix);
    const colorKey = entityInstanceColorKey(entity);
    if (this.turretHeadColorKey.get(slot) !== colorKey) {
      setEntityInstanceColor(this.turretHeadInstanced, slot, entity, this.scratchColor);
      this.turretHeadColorKey.set(slot, colorKey);
      this.turretHeadColorDirty = true;
    }
  }

  writeBarrelMatrix(slot: number, matrix: THREE.Matrix4): void {
    this.barrelInstanced.setMatrixAt(slot, matrix);
  }

  writeMirrorPanelMatrix(slot: number, matrix: THREE.Matrix4, entity: Entity): void {
    this.mirrorPanelInstanced.setMatrixAt(slot, matrix);
    const mirrorColorKey = resolveMirrorReflectorPanelColor(entity);
    if (this.mirrorPanelColorKey.get(slot) !== mirrorColorKey) {
      this.scratchColor.set(mirrorColorKey);
      this.mirrorPanelInstanced.setColorAt(slot, this.scratchColor);
      this.mirrorPanelColorKey.set(slot, mirrorColorKey);
      this.mirrorPanelColorDirty = true;
    }
  }

  flush(mirrorsEnabled: boolean): void {
    this.smoothChassisNextSlot = this.trimFreeTail(
      this.smoothChassisFreeSlots,
      this.smoothChassisNextSlot,
    );
    for (const pool of this.polyChassis.values()) {
      pool.nextSlot = this.trimFreeTail(pool.freeSlots, pool.nextSlot);
    }
    this.turretHeadNextSlot = this.trimFreeTail(
      this.turretHeadFreeSlots,
      this.turretHeadNextSlot,
    );
    this.barrelNextSlot = this.trimFreeTail(this.barrelFreeSlots, this.barrelNextSlot);
    this.mirrorPanelNextSlot = this.trimFreeTail(
      this.mirrorPanelFreeSlots,
      this.mirrorPanelNextSlot,
    );

    this.smoothChassis.count = this.smoothChassisNextSlot;
    if (this.smoothChassisSlots.size > 0) {
      this.smoothChassis.instanceMatrix.needsUpdate = true;
      if (this.smoothChassisColorDirty && this.smoothChassis.instanceColor) {
        this.smoothChassis.instanceColor.needsUpdate = true;
      }
    }
    this.smoothChassisColorDirty = false;

    for (const pool of this.polyChassis.values()) {
      pool.mesh.count = pool.nextSlot;
      if (pool.slots.size === 0) continue;
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (pool.colorDirty && pool.mesh.instanceColor) {
        pool.mesh.instanceColor.needsUpdate = true;
        pool.colorDirty = false;
      }
    }

    this.turretHeadInstanced.count = this.turretHeadNextSlot;
    if (this.turretHeadNextSlot > 0) {
      this.turretHeadInstanced.instanceMatrix.needsUpdate = true;
      if (this.turretHeadColorDirty && this.turretHeadInstanced.instanceColor) {
        this.turretHeadInstanced.instanceColor.needsUpdate = true;
      }
    }
    this.turretHeadColorDirty = false;

    this.barrelInstanced.count = this.barrelNextSlot;
    if (this.barrelNextSlot > 0) this.barrelInstanced.instanceMatrix.needsUpdate = true;

    this.mirrorPanelInstanced.count = mirrorsEnabled ? this.mirrorPanelNextSlot : 0;
    if (this.mirrorPanelNextSlot > 0) {
      this.mirrorPanelInstanced.instanceMatrix.needsUpdate = true;
      if (this.mirrorPanelColorDirty && this.mirrorPanelInstanced.instanceColor) {
        this.mirrorPanelInstanced.instanceColor.needsUpdate = true;
      }
    }
    this.mirrorPanelColorDirty = false;
  }

  destroy(): void {
    this.releaseAllSlots();
    for (const pool of this.polyChassis.values()) {
      disposeMesh(pool.mesh);
    }
    this.polyChassis.clear();

    disposeMesh(this.smoothChassis);

    for (const mesh of [
      this.turretHeadInstanced,
      this.barrelInstanced,
      this.mirrorPanelInstanced,
    ]) {
      disposeMesh(mesh);
    }
  }

  private createPool(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    initialColor: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, this.scratchColor.set(initialColor));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    for (let i = 0; i < capacity; i++) {
      mesh.setMatrixAt(i, ZERO_MATRIX);
    }
    mesh.count = 0;
    mesh.instanceMatrix.needsUpdate = true;
    this.world.add(mesh);
    return mesh;
  }

  private getOrCreatePolyPool(
    bodyShapeKey: string,
    geom: THREE.BufferGeometry,
  ): PolyChassisPool {
    let pool = this.polyChassis.get(bodyShapeKey);
    if (pool) return pool;
    const mesh = this.createPool(
      geom.clone(),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      POLY_CHASSIS_CAP,
      0xffffff,
    );
    pool = {
      mesh,
      slots: new Map<EntityId, number>(),
      colorKeys: new Map<EntityId, number>(),
      colorDirty: false,
      freeSlots: [],
      nextSlot: 0,
    };
    this.polyChassis.set(bodyShapeKey, pool);
    return pool;
  }

  private freeSmoothChassisSlotsForEntity(entityId: EntityId): void {
    const slots = this.smoothChassisSlots.get(entityId);
    if (!slots) return;
    for (const slot of slots) {
      this.smoothChassis.setMatrixAt(slot, ZERO_MATRIX);
      this.smoothChassisFreeSlots.push(slot);
    }
    this.smoothChassisSlots.delete(entityId);
    this.smoothChassisColorKey.delete(entityId);
    this.smoothChassis.instanceMatrix.needsUpdate = true;
  }

  private freePolyChassisSlotForEntity(bodyShapeKey: string, entityId: EntityId): void {
    const pool = this.polyChassis.get(bodyShapeKey);
    if (!pool) return;
    const slot = pool.slots.get(entityId);
    if (slot === undefined) return;
    pool.mesh.setMatrixAt(slot, ZERO_MATRIX);
    pool.freeSlots.push(slot);
    pool.slots.delete(entityId);
    pool.colorKeys.delete(entityId);
    pool.mesh.instanceMatrix.needsUpdate = true;
  }

  private freeTurretHeadSlot(slot: number): void {
    this.turretHeadInstanced.setMatrixAt(slot, ZERO_MATRIX);
    this.turretHeadFreeSlots.push(slot);
    this.turretHeadColorKey.delete(slot);
    this.turretHeadInstanced.instanceMatrix.needsUpdate = true;
  }

  private allocBarrelSlot(): number | null {
    if (this.barrelFreeSlots.length > 0) return this.barrelFreeSlots.pop()!;
    if (this.barrelNextSlot >= BARREL_CAP) return null;
    return this.barrelNextSlot++;
  }

  private freeBarrelSlot(slot: number): void {
    this.barrelInstanced.setMatrixAt(slot, ZERO_MATRIX);
    this.barrelFreeSlots.push(slot);
    this.barrelColorKey.delete(slot);
    this.barrelInstanced.instanceMatrix.needsUpdate = true;
  }

  private allocMirrorPanelSlot(): number | null {
    if (this.mirrorPanelFreeSlots.length > 0) return this.mirrorPanelFreeSlots.pop()!;
    if (this.mirrorPanelNextSlot >= MIRROR_PANEL_CAP) return null;
    return this.mirrorPanelNextSlot++;
  }

  private freeMirrorPanelSlot(slot: number): void {
    this.mirrorPanelInstanced.setMatrixAt(slot, ZERO_MATRIX);
    this.mirrorPanelFreeSlots.push(slot);
    this.mirrorPanelColorKey.delete(slot);
    this.mirrorPanelInstanced.instanceMatrix.needsUpdate = true;
  }

  private releaseAllSmoothChassisSlots(): void {
    for (const slots of this.smoothChassisSlots.values()) {
      for (const slot of slots) {
        this.smoothChassis.setMatrixAt(slot, ZERO_MATRIX);
      }
    }
    this.smoothChassisSlots.clear();
    this.smoothChassisColorKey.clear();
    this.smoothChassisColorDirty = false;
    this.smoothChassisFreeSlots.length = 0;
    this.smoothChassisNextSlot = 0;
    this.smoothChassis.count = 0;
    this.smoothChassis.instanceMatrix.needsUpdate = true;
  }

  private releaseAllPolyChassisSlots(): void {
    for (const pool of this.polyChassis.values()) {
      for (const slot of pool.slots.values()) {
        pool.mesh.setMatrixAt(slot, ZERO_MATRIX);
      }
      pool.slots.clear();
      pool.colorKeys.clear();
      pool.colorDirty = false;
      pool.freeSlots.length = 0;
      pool.nextSlot = 0;
      pool.mesh.count = 0;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private releaseAllTurretHeadSlots(): void {
    for (let slot = 0; slot < this.turretHeadNextSlot; slot++) {
      this.turretHeadInstanced.setMatrixAt(slot, ZERO_MATRIX);
    }
    this.turretHeadColorKey.clear();
    this.turretHeadFreeSlots.length = 0;
    this.turretHeadNextSlot = 0;
    this.turretHeadColorDirty = false;
    this.turretHeadInstanced.count = 0;
    this.turretHeadInstanced.instanceMatrix.needsUpdate = true;
  }

  private releaseAllBarrelSlots(): void {
    for (let slot = 0; slot < this.barrelNextSlot; slot++) {
      this.barrelInstanced.setMatrixAt(slot, ZERO_MATRIX);
    }
    this.barrelColorKey.clear();
    this.barrelFreeSlots.length = 0;
    this.barrelNextSlot = 0;
    this.barrelInstanced.count = 0;
    this.barrelInstanced.instanceMatrix.needsUpdate = true;
  }

  private releaseAllMirrorPanelSlots(): void {
    for (let slot = 0; slot < this.mirrorPanelNextSlot; slot++) {
      this.mirrorPanelInstanced.setMatrixAt(slot, ZERO_MATRIX);
    }
    this.mirrorPanelColorKey.clear();
    this.mirrorPanelFreeSlots.length = 0;
    this.mirrorPanelNextSlot = 0;
    this.mirrorPanelColorDirty = false;
    this.mirrorPanelInstanced.count = 0;
    this.mirrorPanelInstanced.instanceMatrix.needsUpdate = true;
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
