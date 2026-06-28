import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { Entity, EntityId, Turret } from '../sim/types';
import type { EntityMesh } from './EntityMesh3D';
import type { TurretMesh } from './TurretMesh3D';
import {
  entityInstanceColorHex,
  entityInstanceColorKey,
  entityHeadOnlyTurretHeadColorHex,
  entityTurretAccentColorHex,
} from './EntityInstanceColor3D';
import {
  createShieldSurfaceMaterial,
  SHIELD_SURFACE_OPACITY,
  resolveShieldSurfaceColor,
} from './ShieldReflectorVisual3D';
import { writeHexToRgb01Array } from './colorUtils';
import { patchInstancedFadeMaterial } from './EntityFade3D';
import { disposeMesh } from './threeUtils';
import {
  BEAM_EMITTER_BALL_GEOM,
  BEAM_INNER_VISUAL_CONFIG,
  BEAM_LAYER_INNER_SCALE,
  BEAM_OUTER_VISUAL_CONFIG,
  BEAM_WAVE_RENDER_ORDER,
  beamWaveFlowPhase,
  beamWaveFlowRepeats,
  createBeamEmitterInstancedMaterial,
} from './BeamWaveVisual3D';
import { createPrimitiveSphereGeometry } from './PrimitiveGeometryQuality3D';

const SMOOTH_CHASSIS_CAP = 16384;
const POLY_CHASSIS_CAP = 4096;
const TURRET_HEAD_CAP = 16384;
const BARREL_CAP = 32768;
const CONE_BARREL_CAP = 4096;
const SHIELD_PANEL_CAP = 1024;
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
const UNIT_DETAIL_RENDER_ORDER = 4;
// Unit pools fade via per-instance alpha in EntityFade3D, matching the leg
// pools so the whole unit materializes and vanishes as one opacity channel.

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

function hasDirtySpan(span: DirtySpan): boolean {
  return span.maxSlot >= span.minSlot;
}

function uploadDirtySpan(
  attr: THREE.InstancedBufferAttribute,
  span: DirtySpan,
  itemSize: number,
): void {
  if (!hasDirtySpan(span)) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(
    span.minSlot * itemSize,
    (span.maxSlot - span.minSlot + 1) * itemSize,
  );
  attr.needsUpdate = true;
  clearDirtySpan(span);
}

function setInstancedCount(mesh: THREE.InstancedMesh, count: number): void {
  if (mesh.count !== count) mesh.count = count;
}

function writeInstanceMatrix(
  mesh: THREE.InstancedMesh,
  slot: number,
  matrix: THREE.Matrix4,
  dirty: DirtySpan,
): void {
  const out = mesh.instanceMatrix.array;
  const src = matrix.elements;
  const offset = slot * 16;
  const s0 = Math.fround(src[0]);
  const s1 = Math.fround(src[1]);
  const s2 = Math.fround(src[2]);
  const s3 = Math.fround(src[3]);
  const s4 = Math.fround(src[4]);
  const s5 = Math.fround(src[5]);
  const s6 = Math.fround(src[6]);
  const s7 = Math.fround(src[7]);
  const s8 = Math.fround(src[8]);
  const s9 = Math.fround(src[9]);
  const s10 = Math.fround(src[10]);
  const s11 = Math.fround(src[11]);
  const s12 = Math.fround(src[12]);
  const s13 = Math.fround(src[13]);
  const s14 = Math.fround(src[14]);
  const s15 = Math.fround(src[15]);
  if (
    out[offset] === s0 &&
    out[offset + 1] === s1 &&
    out[offset + 2] === s2 &&
    out[offset + 3] === s3 &&
    out[offset + 4] === s4 &&
    out[offset + 5] === s5 &&
    out[offset + 6] === s6 &&
    out[offset + 7] === s7 &&
    out[offset + 8] === s8 &&
    out[offset + 9] === s9 &&
    out[offset + 10] === s10 &&
    out[offset + 11] === s11 &&
    out[offset + 12] === s12 &&
    out[offset + 13] === s13 &&
    out[offset + 14] === s14 &&
    out[offset + 15] === s15
  ) {
    return;
  }
  out[offset] = s0;
  out[offset + 1] = s1;
  out[offset + 2] = s2;
  out[offset + 3] = s3;
  out[offset + 4] = s4;
  out[offset + 5] = s5;
  out[offset + 6] = s6;
  out[offset + 7] = s7;
  out[offset + 8] = s8;
  out[offset + 9] = s9;
  out[offset + 10] = s10;
  out[offset + 11] = s11;
  out[offset + 12] = s12;
  out[offset + 13] = s13;
  out[offset + 14] = s14;
  out[offset + 15] = s15;
  markDirtySlot(dirty, slot);
}

function writeInstanceMatrixArray(
  mesh: THREE.InstancedMesh,
  slot: number,
  matrix: ArrayLike<number>,
  srcOffset: number,
  dirty: DirtySpan,
): void {
  const out = mesh.instanceMatrix.array;
  const offset = slot * 16;
  const s0 = matrix[srcOffset];
  const s1 = matrix[srcOffset + 1];
  const s2 = matrix[srcOffset + 2];
  const s3 = matrix[srcOffset + 3];
  const s4 = matrix[srcOffset + 4];
  const s5 = matrix[srcOffset + 5];
  const s6 = matrix[srcOffset + 6];
  const s7 = matrix[srcOffset + 7];
  const s8 = matrix[srcOffset + 8];
  const s9 = matrix[srcOffset + 9];
  const s10 = matrix[srcOffset + 10];
  const s11 = matrix[srcOffset + 11];
  const s12 = matrix[srcOffset + 12];
  const s13 = matrix[srcOffset + 13];
  const s14 = matrix[srcOffset + 14];
  const s15 = matrix[srcOffset + 15];
  if (
    out[offset] === s0 &&
    out[offset + 1] === s1 &&
    out[offset + 2] === s2 &&
    out[offset + 3] === s3 &&
    out[offset + 4] === s4 &&
    out[offset + 5] === s5 &&
    out[offset + 6] === s6 &&
    out[offset + 7] === s7 &&
    out[offset + 8] === s8 &&
    out[offset + 9] === s9 &&
    out[offset + 10] === s10 &&
    out[offset + 11] === s11 &&
    out[offset + 12] === s12 &&
    out[offset + 13] === s13 &&
    out[offset + 14] === s14 &&
    out[offset + 15] === s15
  ) {
    return;
  }
  out[offset] = s0;
  out[offset + 1] = s1;
  out[offset + 2] = s2;
  out[offset + 3] = s3;
  out[offset + 4] = s4;
  out[offset + 5] = s5;
  out[offset + 6] = s6;
  out[offset + 7] = s7;
  out[offset + 8] = s8;
  out[offset + 9] = s9;
  out[offset + 10] = s10;
  out[offset + 11] = s11;
  out[offset + 12] = s12;
  out[offset + 13] = s13;
  out[offset + 14] = s14;
  out[offset + 15] = s15;
  markDirtySlot(dirty, slot);
}

function readInstanceMatrix(
  mesh: THREE.InstancedMesh,
  slot: number,
  target: THREE.Matrix4,
): void {
  target.fromArray(mesh.instanceMatrix.array, slot * 16);
}

function writeInstanceColorHex(
  mesh: THREE.InstancedMesh,
  slot: number,
  colorHex: number,
  dirty: DirtySpan,
): void {
  const attr = mesh.instanceColor;
  if (attr === null) return;
  writeHexToRgb01Array(colorHex, attr.array as Float32Array, slot * 3);
  markDirtySlot(dirty, slot);
}

// Per-instance materialization fade. Every live unit pool carries a
// per-instance `aFade` scalar in [0,1] (0 = transparent, 1 = opaque),
// fed into the shared alpha patch from EntityFade3D so units and
// buildings fade through the identical look. Written per-entity
// via writeEntityFade and uploaded once per frame in flush().
type FadeState = {
  arr: Float32Array;
  attr: THREE.InstancedBufferAttribute;
  dirty: DirtySpan;
};

// Per-instance wave-flow params for the legacy cone-barrel pools.
// tipTaper turns the unit-cylinder cone geometry into a frustum.
type EmitterFlowAttr = {
  arr: Float32Array;
  attr: THREE.InstancedBufferAttribute;
  dirty: DirtySpan;
};

function addEmitterFlowAttr(mesh: THREE.InstancedMesh, capacity: number): EmitterFlowAttr {
  const arr = new Float32Array(capacity * 3);
  const attr = new THREE.InstancedBufferAttribute(arr, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  (mesh.geometry as THREE.BufferGeometry).setAttribute('aFlow3', attr);
  return { arr, attr, dirty: createDirtySpan() };
}

// Scratch for derived emitter-layer matrices (inner cone, ball layers).
const _emitterMatrixScratch = new Float32Array(16);

type PolyChassisPool = {
  mesh: THREE.InstancedMesh;
  slots: Map<EntityId, number>;
  colorKeys: Map<EntityId, number>;
  matrixDirty: DirtySpan;
  colorDirty: DirtySpan;
  freeSlots: number[];
  nextSlot: number;
};

type UnitDetailInstanceRendererOptions = {
  world: THREE.Group;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  coneBarrelGeom: THREE.CylinderGeometry;
  barrelMat: THREE.Material;
  mirrorGeom: THREE.BoxGeometry;
};

export type DyingUnitPartDelta = {
  dx: number;
  dy: number;
  dz: number;
  drx: number;
  dry: number;
  drz: number;
};

export class UnitDetailInstanceRenderer3D {
  private readonly world: THREE.Group;
  private readonly smoothChassisGeom = createPrimitiveSphereGeometry('unitBody', 'close');
  private readonly smoothChassis: THREE.InstancedMesh;
  private readonly smoothChassisSlots = new Map<EntityId, number[]>();
  private readonly smoothChassisColorKey = new Map<EntityId, number>();
  private readonly smoothChassisMatrixDirty = createDirtySpan();
  private readonly smoothChassisColorDirty = createDirtySpan();
  private readonly smoothChassisFreeSlots: number[] = [];
  private smoothChassisNextSlot = 0;

  private readonly polyChassis = new Map<string, PolyChassisPool>();

  private readonly turretHeadInstanced: THREE.InstancedMesh;
  private readonly turretHeadColorKey = new Map<number, number>();
  private readonly turretHeadMatrixDirty = createDirtySpan();
  private readonly turretHeadColorDirty = createDirtySpan();
  private readonly turretHeadFreeSlots: number[] = [];
  private turretHeadNextSlot = 0;

  private readonly barrelInstanced: THREE.InstancedMesh;
  private readonly barrelColorKey = new Map<number, number>();
  private readonly barrelMatrixDirty = createDirtySpan();
  private readonly barrelColorDirty = createDirtySpan();
  private readonly barrelFreeSlots: number[] = [];
  private barrelNextSlot = 0;

  // Parallel pool for legacy cone barrels. The same slot
  // index allocator + per-frame writer pattern as the cylinder pool above,
  // but rendered in the beam's continuously-animated wave material.
  // Three mirror pools share the cone pool's slot indices and derive
  // their matrices from the outer cone's per frame.
  private readonly coneBarrelInstanced: THREE.InstancedMesh;
  private readonly coneBarrelMatrixDirty = createDirtySpan();
  private readonly coneBarrelFreeSlots: number[] = [];
  private coneBarrelNextSlot = 0;
  private readonly coneBarrelInnerInstanced: THREE.InstancedMesh;
  private readonly coneBarrelInnerMatrixDirty = createDirtySpan();
  private readonly emitterBallInstanced: THREE.InstancedMesh;
  private readonly emitterBallMatrixDirty = createDirtySpan();
  private readonly emitterBallInnerInstanced: THREE.InstancedMesh;
  private readonly emitterBallInnerMatrixDirty = createDirtySpan();
  /** Per-cone-slot start-ball world radius (0 = no ball). Registered at
   *  mesh build via registerConeBarrelEmitter; the per-frame writer uses
   *  it to derive the ball matrices from the barrel matrix. */
  private readonly coneEmitterBallRadius = new Float32Array(CONE_BARREL_CAP);
  private readonly coneBarrelFlow: EmitterFlowAttr;
  private readonly coneBarrelInnerFlow: EmitterFlowAttr;
  private readonly emitterBallFlow: EmitterFlowAttr;
  private readonly emitterBallInnerFlow: EmitterFlowAttr;

  // Materials Are Independent Of Shape: the flat panels render through the
  // same shield surface material as the sphere bubble, so they feed the
  // same per-instance aColor + aAlpha attributes rather than a uniform-opacity
  // material + built-in instanceColor.
  private readonly shieldPanelInstanced: THREE.InstancedMesh;
  private readonly shieldPanelColorKey = new Map<number, number>();
  private readonly shieldPanelMatrixDirty = createDirtySpan();
  private readonly shieldPanelColorDirty = createDirtySpan();
  private readonly shieldPanelAlphaDirty = createDirtySpan();
  private readonly shieldPanelFreeSlots: number[] = [];
  private shieldPanelNextSlot = 0;
  private readonly shieldPanelAlphaArr = new Float32Array(SHIELD_PANEL_CAP);
  private readonly shieldPanelColorArr = new Float32Array(SHIELD_PANEL_CAP * 3);
  private readonly shieldPanelAlphaAttr = new THREE.InstancedBufferAttribute(
    this.shieldPanelAlphaArr,
    1,
  );
  private readonly shieldPanelColorAttr = new THREE.InstancedBufferAttribute(
    this.shieldPanelColorArr,
    3,
  );

  private readonly scatterMat = new THREE.Matrix4();
  private readonly scatterPos = new THREE.Vector3();
  private readonly scatterQuat = new THREE.Quaternion();
  private readonly scatterScale = new THREE.Vector3();
  private readonly scatterRot = new THREE.Quaternion();
  private readonly scatterEuler = new THREE.Euler();

  // Per-instance materialization fade, keyed by pool mesh. Populated for
  // every pool created through createPool (smooth/poly chassis, turret
  // head, barrel, cone barrel). Written per-entity via writeEntityFade
  // and uploaded once per frame in flush().
  private readonly fadeState = new Map<THREE.InstancedMesh, FadeState>();

  constructor(options: UnitDetailInstanceRendererOptions) {
    this.world = options.world;

    this.smoothChassis = this.createPool(
      this.smoothChassisGeom,
      new THREE.MeshLambertMaterial({ color: COLORS.units.turret.barrel.colorHex }),
      SMOOTH_CHASSIS_CAP,
    );

    this.turretHeadInstanced = this.createPool(
      options.turretHeadGeom.clone(),
      new THREE.MeshLambertMaterial({ color: COLORS.units.turret.barrel.colorHex }),
      TURRET_HEAD_CAP,
    );

    this.barrelInstanced = this.createPool(
      options.barrelGeom.clone(),
      options.barrelMat.clone(),
      BARREL_CAP,
    );

    // Legacy cone-barrel pools render in the beam wave material
    // (self-faded ShaderMaterials — createPool still wires their aFade
    // attribute and fade bookkeeping).
    this.coneBarrelInstanced = this.createPool(
      options.coneBarrelGeom.clone(),
      createBeamEmitterInstancedMaterial('outer'),
      CONE_BARREL_CAP,
    );
    this.coneBarrelInstanced.renderOrder = BEAM_WAVE_RENDER_ORDER.outer;
    this.coneBarrelFlow = addEmitterFlowAttr(this.coneBarrelInstanced, CONE_BARREL_CAP);
    this.coneBarrelInnerInstanced = this.createPool(
      options.coneBarrelGeom.clone(),
      createBeamEmitterInstancedMaterial('inner'),
      CONE_BARREL_CAP,
    );
    this.coneBarrelInnerInstanced.renderOrder = BEAM_WAVE_RENDER_ORDER.inner;
    this.coneBarrelInnerFlow = addEmitterFlowAttr(this.coneBarrelInnerInstanced, CONE_BARREL_CAP);
    this.emitterBallInstanced = this.createPool(
      BEAM_EMITTER_BALL_GEOM.clone(),
      createBeamEmitterInstancedMaterial('outer'),
      CONE_BARREL_CAP,
    );
    this.emitterBallInstanced.renderOrder = BEAM_WAVE_RENDER_ORDER.outer;
    this.emitterBallFlow = addEmitterFlowAttr(this.emitterBallInstanced, CONE_BARREL_CAP);
    this.emitterBallInnerInstanced = this.createPool(
      BEAM_EMITTER_BALL_GEOM.clone(),
      createBeamEmitterInstancedMaterial('inner'),
      CONE_BARREL_CAP,
    );
    this.emitterBallInnerInstanced.renderOrder = BEAM_WAVE_RENDER_ORDER.inner;
    this.emitterBallInnerFlow = addEmitterFlowAttr(this.emitterBallInnerInstanced, CONE_BARREL_CAP);

    // Force-field panels: same instanced-attribute contract as the sphere
    // bubble (aColor + aAlpha + shared ShaderMaterial), so the two shapes are
    // one material. Built directly rather than through createPool because that
    // helper wires the built-in instanceColor the shared shader doesn't read.
    const mirrorGeom = options.mirrorGeom.clone();
    this.shieldPanelAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.shieldPanelColorAttr.setUsage(THREE.DynamicDrawUsage);
    mirrorGeom.setAttribute('aAlpha', this.shieldPanelAlphaAttr);
    mirrorGeom.setAttribute('aColor', this.shieldPanelColorAttr);
    this.shieldPanelInstanced = new THREE.InstancedMesh(
      mirrorGeom,
      createShieldSurfaceMaterial(),
      SHIELD_PANEL_CAP,
    );
    this.shieldPanelInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shieldPanelInstanced.frustumCulled = false;
    this.shieldPanelInstanced.count = 0;
    this.shieldPanelInstanced.renderOrder = 7;
    this.world.add(this.shieldPanelInstanced);
  }

  /** Write the shield surface color + alpha for one panel slot. Both
   *  panel write paths funnel through here; the colorKey cache skips the
   *  attribute write when nothing changed. Alpha is the constant surface
   *  opacity (the panel's fade is carried by its pose, not per-instance). */
  private writeShieldPanelInstanceColor(slot: number, colorKey: number): void {
    if (this.shieldPanelColorKey.get(slot) === colorKey) return;
    writeHexToRgb01Array(colorKey, this.shieldPanelColorArr, slot * 3);
    if (this.shieldPanelAlphaArr[slot] !== SHIELD_SURFACE_OPACITY) {
      this.shieldPanelAlphaArr[slot] = SHIELD_SURFACE_OPACITY;
      markDirtySlot(this.shieldPanelAlphaDirty, slot);
    }
    this.shieldPanelColorKey.set(slot, colorKey);
    markDirtySlot(this.shieldPanelColorDirty, slot);
  }

  private writeShieldPanelFade(slot: number, fade: number): void {
    const alpha = SHIELD_SURFACE_OPACITY * fade;
    if (this.shieldPanelAlphaArr[slot] === alpha) return;
    this.shieldPanelAlphaArr[slot] = alpha;
    markDirtySlot(this.shieldPanelAlphaDirty, slot);
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
      writeInstanceMatrix(
        this.smoothChassis,
        slot,
        ZERO_MATRIX,
        this.smoothChassisMatrixDirty,
      );
      this.writeFade(this.smoothChassis, slot, 1);
      writeInstanceColorHex(
        this.smoothChassis,
        slot,
        COLORS.units.turret.barrel.colorHex,
        this.smoothChassisColorDirty,
      );
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
    writeInstanceMatrix(pool.mesh, slot, ZERO_MATRIX, pool.matrixDirty);
    this.writeFade(pool.mesh, slot, 1);
    writeInstanceColorHex(
      pool.mesh,
      slot,
      COLORS.units.turret.barrel.colorHex,
      pool.colorDirty,
    );
    return slot;
  }

  allocTurretHeadSlot(): number | null {
    let slot: number;
    if (this.turretHeadFreeSlots.length > 0) {
      slot = this.turretHeadFreeSlots.pop()!;
    } else if (this.turretHeadNextSlot < TURRET_HEAD_CAP) {
      slot = this.turretHeadNextSlot++;
    } else {
      return null;
    }
    writeInstanceMatrix(
      this.turretHeadInstanced,
      slot,
      ZERO_MATRIX,
      this.turretHeadMatrixDirty,
    );
    this.writeFade(this.turretHeadInstanced, slot, 1);
    writeInstanceColorHex(
      this.turretHeadInstanced,
      slot,
      COLORS.units.turret.barrel.colorHex,
      this.turretHeadColorDirty,
    );
    return slot;
  }

  allocBarrelSlots(count: number, useCone: boolean = false): number[] | null {
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      const slot = useCone ? this.allocConeBarrelSlot() : this.allocBarrelSlot();
      if (slot === null) {
        for (const allocated of slots) {
          if (useCone) this.freeConeBarrelSlot(allocated);
          else this.freeBarrelSlot(allocated);
        }
        return null;
      }
      slots.push(slot);
    }
    return slots;
  }

  allocShieldPanelSlots(count: number): number[] | null {
    const slots: number[] = [];
    for (let i = 0; i < count; i++) {
      const slot = this.allocShieldPanelSlot();
      if (slot === null) {
        for (const allocated of slots) this.freeShieldPanelSlot(allocated);
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
        if (turret.barrelUsesCone) {
          for (const slot of turret.barrelSlots) this.freeConeBarrelSlot(slot);
        } else {
          for (const slot of turret.barrelSlots) this.freeBarrelSlot(slot);
        }
      }
    }
    if (mesh.mirrors?.panelSlots) {
      for (const slot of mesh.mirrors.panelSlots) this.freeShieldPanelSlot(slot);
    }
  }

  releaseAllSlots(): void {
    this.releaseAllSmoothChassisSlots();
    this.releaseAllPolyChassisSlots();
    this.releaseAllTurretHeadSlots();
    this.releaseAllBarrelSlots();
    this.releaseAllConeBarrelSlots();
    this.releaseAllShieldPanelSlots();
  }

  syncEntityColors(entity: Entity, mesh: EntityMesh, turrets: readonly Turret[] = []): void {
    const colorKey = entityInstanceColorKey(entity);

    if (
      mesh.smoothChassisSlots &&
      this.smoothChassisColorKey.get(entity.id) !== colorKey
    ) {
      for (const slot of mesh.smoothChassisSlots) {
        writeInstanceColorHex(
          this.smoothChassis,
          slot,
          entityInstanceColorHex(entity),
          this.smoothChassisColorDirty,
        );
      }
      this.smoothChassisColorKey.set(entity.id, colorKey);
    }

    if (mesh.polyChassisSlot !== undefined && mesh.bodyShapeKey) {
      const pool = this.polyChassis.get(mesh.bodyShapeKey);
      if (pool && pool.colorKeys.get(entity.id) !== colorKey) {
        writeInstanceColorHex(
          pool.mesh,
          mesh.polyChassisSlot,
          entityInstanceColorHex(entity),
          pool.colorDirty,
        );
        pool.colorKeys.set(entity.id, colorKey);
      }
    }

    const turretHeadHex = entityInstanceColorHex(entity);
    const turretAccentHex = entityTurretAccentColorHex(entity);
    for (let i = 0; i < mesh.turrets.length; i++) {
      const turret = mesh.turrets[i];
      const headColorKey = turret.headOnly && turret.barrelFollowsBeam !== true
        ? entityHeadOnlyTurretHeadColorHex(entity, turrets[i]?.state)
        : turretHeadHex;
      if (
        turret.headSlot !== undefined &&
        turret.shieldEmitterCore !== true &&
        this.turretHeadColorKey.get(turret.headSlot) !== headColorKey
      ) {
        writeInstanceColorHex(
          this.turretHeadInstanced,
          turret.headSlot,
          headColorKey,
          this.turretHeadColorDirty,
        );
        this.turretHeadColorKey.set(turret.headSlot, headColorKey);
      }
      // Beam-emitter cones take their color from the beam wave material,
      // not the entity accent — nothing to sync for cone slots.
      if (turret.barrelSlots && turret.barrelUsesCone !== true) {
        const barrelColorKey = turretAccentHex;
        for (const slot of turret.barrelSlots) {
          if (this.barrelColorKey.get(slot) === barrelColorKey) continue;
          writeInstanceColorHex(this.barrelInstanced, slot, barrelColorKey, this.barrelColorDirty);
          this.barrelColorKey.set(slot, barrelColorKey);
        }
      }
    }

    if (mesh.mirrors?.panelSlots) {
      const mirrorColorKey = resolveShieldSurfaceColor(entity);
      for (const slot of mesh.mirrors.panelSlots) {
        this.writeShieldPanelInstanceColor(slot, mirrorColorKey);
      }
    }
  }

  clearChassisSlots(mesh: EntityMesh): void {
    if (mesh.smoothChassisSlots) {
      for (const slot of mesh.smoothChassisSlots) {
        writeInstanceMatrix(
          this.smoothChassis,
          slot,
          ZERO_MATRIX,
          this.smoothChassisMatrixDirty,
        );
      }
    } else if (mesh.polyChassisSlot !== undefined) {
      const pool = this.polyChassis.get(mesh.bodyShapeKey);
      if (pool) {
        writeInstanceMatrix(
          pool.mesh,
          mesh.polyChassisSlot,
          ZERO_MATRIX,
          pool.matrixDirty,
        );
      }
    }
  }

  prepareSmoothChassisColor(entity: Entity): boolean {
    const colorKey = entityInstanceColorKey(entity);
    const writeColor = this.smoothChassisColorKey.get(entity.id) !== colorKey;
    if (writeColor) {
      this.smoothChassisColorKey.set(entity.id, colorKey);
    }
    return writeColor;
  }

  writeSmoothChassisMatrix(
    slot: number,
    matrix: THREE.Matrix4,
    entity: Entity,
    writeColor: boolean,
  ): void {
    writeInstanceMatrix(this.smoothChassis, slot, matrix, this.smoothChassisMatrixDirty);
    if (writeColor) {
      writeInstanceColorHex(
        this.smoothChassis,
        slot,
        entityInstanceColorHex(entity),
        this.smoothChassisColorDirty,
      );
    }
  }

  writeSmoothChassisMatrixArray(
    slot: number,
    matrix: ArrayLike<number>,
    offset: number,
    entity: Entity,
    writeColor: boolean,
  ): void {
    writeInstanceMatrixArray(this.smoothChassis, slot, matrix, offset, this.smoothChassisMatrixDirty);
    if (writeColor) {
      writeInstanceColorHex(
        this.smoothChassis,
        slot,
        entityInstanceColorHex(entity),
        this.smoothChassisColorDirty,
      );
    }
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
    }
    writeInstanceMatrix(pool.mesh, slot, matrix, pool.matrixDirty);
    if (writeColor) {
      writeInstanceColorHex(
        pool.mesh,
        slot,
        entityInstanceColorHex(entity),
        pool.colorDirty,
      );
    }
  }

  writePolyChassisMatrixArray(
    entity: Entity,
    bodyShapeKey: string,
    slot: number,
    matrix: ArrayLike<number>,
    offset: number,
  ): void {
    const pool = this.polyChassis.get(bodyShapeKey);
    if (!pool) return;
    const colorKey = entityInstanceColorKey(entity);
    const writeColor = pool.colorKeys.get(entity.id) !== colorKey;
    if (writeColor) {
      pool.colorKeys.set(entity.id, colorKey);
    }
    writeInstanceMatrixArray(pool.mesh, slot, matrix, offset, pool.matrixDirty);
    if (writeColor) {
      writeInstanceColorHex(
        pool.mesh,
        slot,
        entityInstanceColorHex(entity),
        pool.colorDirty,
      );
    }
  }

  writeTurretHeadMatrix(
    slot: number,
    matrix: THREE.Matrix4,
    entity: Entity,
    /** Hex override for dynamic turret heads.
     *  When undefined the normal entity color is used. */
    colorOverride?: number,
  ): void {
    writeInstanceMatrix(
      this.turretHeadInstanced,
      slot,
      matrix,
      this.turretHeadMatrixDirty,
    );
    const colorHex = colorOverride ?? entityInstanceColorHex(entity);
    if (this.turretHeadColorKey.get(slot) !== colorHex) {
      writeInstanceColorHex(
        this.turretHeadInstanced,
        slot,
        colorHex,
        this.turretHeadColorDirty,
      );
      this.turretHeadColorKey.set(slot, colorHex);
    }
  }

  writeTurretHeadMatrixArray(
    slot: number,
    matrix: ArrayLike<number>,
    offset: number,
    entity: Entity,
    /** Hex override for dynamic turret heads.
     *  When undefined the normal entity color is used. */
    colorOverride?: number,
  ): void {
    writeInstanceMatrixArray(
      this.turretHeadInstanced,
      slot,
      matrix,
      offset,
      this.turretHeadMatrixDirty,
    );
    const colorHex = colorOverride ?? entityInstanceColorHex(entity);
    if (this.turretHeadColorKey.get(slot) !== colorHex) {
      writeInstanceColorHex(
        this.turretHeadInstanced,
        slot,
        colorHex,
        this.turretHeadColorDirty,
      );
      this.turretHeadColorKey.set(slot, colorHex);
    }
  }

  writeBarrelMatrix(slot: number, matrix: THREE.Matrix4, useCone: boolean = false): void {
    if (useCone) {
      this.writeConeEmitterMatrices(slot, matrix.elements, 0);
    } else {
      writeInstanceMatrix(this.barrelInstanced, slot, matrix, this.barrelMatrixDirty);
    }
  }

  writeBarrelMatrixArray(
    slot: number,
    matrix: ArrayLike<number>,
    offset: number,
    useCone: boolean = false,
  ): void {
    if (useCone) {
      this.writeConeEmitterMatrices(slot, matrix, offset);
    } else {
      writeInstanceMatrixArray(
        this.barrelInstanced,
        slot,
        matrix,
        offset,
        this.barrelMatrixDirty,
      );
    }
  }

  /** Write a legacy cone slot: the outer cone matrix lands as-is, and the
   *  mirror layers derive from it. Per-instance wave-flow params keep the
   *  bands at the beam's world-unit period. */
  private writeConeEmitterMatrices(
    slot: number,
    m: ArrayLike<number>,
    offset: number,
  ): void {
    writeInstanceMatrixArray(
      this.coneBarrelInstanced,
      slot,
      m,
      offset,
      this.coneBarrelMatrixDirty,
    );

    const m0 = m[offset], m1 = m[offset + 1], m2 = m[offset + 2];
    const m4 = m[offset + 4], m5 = m[offset + 5], m6 = m[offset + 6];
    const m8 = m[offset + 8], m9 = m[offset + 9], m10 = m[offset + 10];
    const m12 = m[offset + 12], m13 = m[offset + 13], m14 = m[offset + 14];
    const radial = Math.hypot(m0, m1, m2);
    const length = Math.hypot(m4, m5, m6);
    const s = BEAM_LAYER_INNER_SCALE;
    const e = _emitterMatrixScratch;

    // Inner cone: same axis column + translation, radial columns narrowed.
    e[0] = m0 * s; e[1] = m1 * s; e[2] = m2 * s; e[3] = 0;
    e[4] = m4; e[5] = m5; e[6] = m6; e[7] = 0;
    e[8] = m8 * s; e[9] = m9 * s; e[10] = m10 * s; e[11] = 0;
    e[12] = m12; e[13] = m13; e[14] = m14; e[15] = 1;
    writeInstanceMatrixArray(
      this.coneBarrelInnerInstanced,
      slot,
      e,
      0,
      this.coneBarrelInnerMatrixDirty,
    );

    const ballRadius = this.coneEmitterBallRadius[slot];
    // Chopped-cone taper. The inner layer narrows by the same factor, so
    // one taper ratio serves both pools.
    const coneTipTaper = ballRadius > 0 && radial > 1e-6 ? ballRadius / radial : 0;
    this.writeEmitterFlow(
      this.coneBarrelFlow,
      slot,
      beamWaveFlowRepeats(length, BEAM_OUTER_VISUAL_CONFIG.waveSpacing),
      0,
      coneTipTaper,
    );
    this.writeEmitterFlow(
      this.coneBarrelInnerFlow,
      slot,
      beamWaveFlowRepeats(length, BEAM_INNER_VISUAL_CONFIG.waveSpacing),
      1,
      coneTipTaper,
    );

    if (ballRadius <= 0 || radial < 1e-6 || length < 1e-6) return;

    // Ball layers: cone rotation, uniform diameter scale, centered on the
    // cone tip (= translation + half the +Y axis column). The ball
    // geometry has radius 0.5, so a uniform scale of the diameter yields
    // a ball of `ballRadius`.
    const tipX = m12 + 0.5 * m4;
    const tipY = m13 + 0.5 * m5;
    const tipZ = m14 + 0.5 * m6;
    const d = ballRadius * 2;
    const kx = d / radial;
    const ky = d / length;
    e[0] = m0 * kx; e[1] = m1 * kx; e[2] = m2 * kx; e[3] = 0;
    e[4] = m4 * ky; e[5] = m5 * ky; e[6] = m6 * ky; e[7] = 0;
    e[8] = m8 * kx; e[9] = m9 * kx; e[10] = m10 * kx; e[11] = 0;
    e[12] = tipX; e[13] = tipY; e[14] = tipZ; e[15] = 1;
    writeInstanceMatrixArray(
      this.emitterBallInstanced,
      slot,
      e,
      0,
      this.emitterBallMatrixDirty,
    );
    for (let i = 0; i < 12; i++) e[i] *= s;
    writeInstanceMatrixArray(
      this.emitterBallInnerInstanced,
      slot,
      e,
      0,
      this.emitterBallInnerMatrixDirty,
    );

    this.writeEmitterFlow(
      this.emitterBallFlow,
      slot,
      beamWaveFlowRepeats(d, BEAM_OUTER_VISUAL_CONFIG.waveSpacing),
      2,
    );
    this.writeEmitterFlow(
      this.emitterBallInnerFlow,
      slot,
      beamWaveFlowRepeats(d * s, BEAM_INNER_VISUAL_CONFIG.waveSpacing),
      3,
    );
  }

  private writeEmitterFlow(
    flow: EmitterFlowAttr,
    slot: number,
    repeats: number,
    phaseSalt: number,
    tipTaper: number = 1,
  ): void {
    const phase = beamWaveFlowPhase(slot, phaseSalt);
    const base = slot * 3;
    if (
      flow.arr[base] === repeats &&
      flow.arr[base + 1] === phase &&
      flow.arr[base + 2] === tipTaper
    ) {
      return;
    }
    flow.arr[base] = repeats;
    flow.arr[base + 1] = phase;
    flow.arr[base + 2] = tipTaper;
    markDirtySlot(flow.dirty, slot);
  }

  clearTurretSlots(turret: Pick<TurretMesh, 'headSlot' | 'barrelSlots' | 'barrelUsesCone'>): void {
    if (turret.headSlot !== undefined) {
      writeInstanceMatrix(
        this.turretHeadInstanced,
        turret.headSlot,
        ZERO_MATRIX,
        this.turretHeadMatrixDirty,
      );
    }
    if (turret.barrelSlots) {
      for (const slot of turret.barrelSlots) {
        if (turret.barrelUsesCone) {
          this.zeroConeEmitterSlot(slot);
        } else {
          writeInstanceMatrix(this.barrelInstanced, slot, ZERO_MATRIX, this.barrelMatrixDirty);
        }
      }
    }
  }

  writeShieldPanelMatrix(slot: number, matrix: THREE.Matrix4, entity: Entity): void {
    writeInstanceMatrix(
      this.shieldPanelInstanced,
      slot,
      matrix,
      this.shieldPanelMatrixDirty,
    );
    this.writeShieldPanelInstanceColor(slot, resolveShieldSurfaceColor(entity));
  }

  writeShieldPanelMatrixArray(
    slot: number,
    matrix: ArrayLike<number>,
    offset: number,
    entity: Entity,
  ): void {
    writeInstanceMatrixArray(
      this.shieldPanelInstanced,
      slot,
      matrix,
      offset,
      this.shieldPanelMatrixDirty,
    );
    this.writeShieldPanelInstanceColor(slot, resolveShieldSurfaceColor(entity));
  }

  clearShieldPanelSlots(slots: readonly number[]): void {
    for (const slot of slots) {
      writeInstanceMatrix(
        this.shieldPanelInstanced,
        slot,
        ZERO_MATRIX,
        this.shieldPanelMatrixDirty,
      );
    }
  }

  flush(turretShieldPanelsEnabled: boolean): void {
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
    this.coneBarrelNextSlot = this.trimFreeTail(
      this.coneBarrelFreeSlots,
      this.coneBarrelNextSlot,
    );
    this.shieldPanelNextSlot = this.trimFreeTail(
      this.shieldPanelFreeSlots,
      this.shieldPanelNextSlot,
    );

    setInstancedCount(this.smoothChassis, this.smoothChassisNextSlot);
    uploadDirtySpan(this.smoothChassis.instanceMatrix, this.smoothChassisMatrixDirty, 16);
    if (this.smoothChassis.instanceColor) {
      uploadDirtySpan(this.smoothChassis.instanceColor, this.smoothChassisColorDirty, 3);
    }

    for (const pool of this.polyChassis.values()) {
      setInstancedCount(pool.mesh, pool.nextSlot);
      uploadDirtySpan(pool.mesh.instanceMatrix, pool.matrixDirty, 16);
      if (pool.mesh.instanceColor) {
        uploadDirtySpan(pool.mesh.instanceColor, pool.colorDirty, 3);
      }
    }

    setInstancedCount(this.turretHeadInstanced, this.turretHeadNextSlot);
    uploadDirtySpan(this.turretHeadInstanced.instanceMatrix, this.turretHeadMatrixDirty, 16);
    if (this.turretHeadInstanced.instanceColor) {
      uploadDirtySpan(this.turretHeadInstanced.instanceColor, this.turretHeadColorDirty, 3);
    }

    setInstancedCount(this.barrelInstanced, this.barrelNextSlot);
    uploadDirtySpan(this.barrelInstanced.instanceMatrix, this.barrelMatrixDirty, 16);
    if (this.barrelInstanced.instanceColor) {
      uploadDirtySpan(this.barrelInstanced.instanceColor, this.barrelColorDirty, 3);
    }

    // Beam-emitter pools share the cone slot allocator, so every mirror
    // pool draws the same instance count.
    setInstancedCount(this.coneBarrelInstanced, this.coneBarrelNextSlot);
    setInstancedCount(this.coneBarrelInnerInstanced, this.coneBarrelNextSlot);
    setInstancedCount(this.emitterBallInstanced, this.coneBarrelNextSlot);
    setInstancedCount(this.emitterBallInnerInstanced, this.coneBarrelNextSlot);
    uploadDirtySpan(this.coneBarrelInstanced.instanceMatrix, this.coneBarrelMatrixDirty, 16);
    uploadDirtySpan(
      this.coneBarrelInnerInstanced.instanceMatrix,
      this.coneBarrelInnerMatrixDirty,
      16,
    );
    uploadDirtySpan(this.emitterBallInstanced.instanceMatrix, this.emitterBallMatrixDirty, 16);
    uploadDirtySpan(
      this.emitterBallInnerInstanced.instanceMatrix,
      this.emitterBallInnerMatrixDirty,
      16,
    );
    uploadDirtySpan(this.coneBarrelFlow.attr, this.coneBarrelFlow.dirty, 3);
    uploadDirtySpan(this.coneBarrelInnerFlow.attr, this.coneBarrelInnerFlow.dirty, 3);
    uploadDirtySpan(this.emitterBallFlow.attr, this.emitterBallFlow.dirty, 3);
    uploadDirtySpan(this.emitterBallInnerFlow.attr, this.emitterBallInnerFlow.dirty, 3);

    setInstancedCount(
      this.shieldPanelInstanced,
      turretShieldPanelsEnabled ? this.shieldPanelNextSlot : 0,
    );
    uploadDirtySpan(this.shieldPanelInstanced.instanceMatrix, this.shieldPanelMatrixDirty, 16);
    uploadDirtySpan(this.shieldPanelColorAttr, this.shieldPanelColorDirty, 3);
    uploadDirtySpan(this.shieldPanelAlphaAttr, this.shieldPanelAlphaDirty, 1);

    // Upload any per-instance materialization fade changes.
    for (const st of this.fadeState.values()) {
      uploadDirtySpan(st.attr, st.dirty, 1);
    }
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
      this.coneBarrelInstanced,
      this.coneBarrelInnerInstanced,
      this.emitterBallInstanced,
      this.emitterBallInnerInstanced,
      this.shieldPanelInstanced,
    ]) {
      disposeMesh(mesh);
    }
    this.fadeState.clear();
  }

  private createPool(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
  ): THREE.InstancedMesh {
    // Per-instance materialization fade. Slots are reset to opaque when
    // allocated so we do not initialize the full capacity up front.
    const fadeArr = new Float32Array(capacity);
    const fadeAttr = new THREE.InstancedBufferAttribute(fadeArr, 1);
    fadeAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aFade', fadeAttr);
    patchInstancedFadeMaterial(material);

    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = colorAttr;
    mesh.renderOrder = UNIT_DETAIL_RENDER_ORDER;
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.fadeState.set(mesh, { arr: fadeArr, attr: fadeAttr, dirty: createDirtySpan() });
    this.world.add(mesh);
    return mesh;
  }

  /** Write one slot's materialization fade (0=transparent, 1=opaque).
   *  No-ops when the value is unchanged so steady-state finished units
   *  (fade locked at 1) pay only a comparison. */
  private writeFade(mesh: THREE.InstancedMesh, slot: number, fade: number): void {
    const st = this.fadeState.get(mesh);
    if (st === undefined || st.arr[slot] === fade) return;
    st.arr[slot] = fade;
    markDirtySlot(st.dirty, slot);
  }

  /** Write the materialization fade for every instanced slot an entity
   *  owns — chassis (body) at `bodyFade`, each turret's head + barrels at
   *  the matching `turretFades` entry (falling back to `bodyFade`). Pass
   *  `turretFades = null` to fade the whole entity uniformly (death-out).
   *  Routed through the same per-entity seam as syncEntityColors so no
   *  pose writer needs to know about fade. */
  writeEntityFade(
    mesh: EntityMesh,
    bodyFade: number,
    turretFades: readonly number[] | null,
  ): void {
    if (mesh.smoothChassisSlots) {
      for (const slot of mesh.smoothChassisSlots) this.writeFade(this.smoothChassis, slot, bodyFade);
    }
    if (mesh.polyChassisSlot !== undefined && mesh.bodyShapeKey) {
      const pool = this.polyChassis.get(mesh.bodyShapeKey);
      if (pool) this.writeFade(pool.mesh, mesh.polyChassisSlot, bodyFade);
    }
    for (let i = 0; i < mesh.turrets.length; i++) {
      const turret = mesh.turrets[i];
      const fade = turretFades ? (turretFades[i] ?? bodyFade) : bodyFade;
      if (turret.headSlot !== undefined) {
        this.writeFade(this.turretHeadInstanced, turret.headSlot, fade);
      }
      if (turret.barrelSlots) {
        for (const slot of turret.barrelSlots) {
          if (turret.barrelUsesCone) {
            this.writeFade(this.coneBarrelInstanced, slot, fade);
            this.writeFade(this.coneBarrelInnerInstanced, slot, fade);
            this.writeFade(this.emitterBallInstanced, slot, fade);
            this.writeFade(this.emitterBallInnerInstanced, slot, fade);
          } else {
            this.writeFade(this.barrelInstanced, slot, fade);
          }
        }
      }
    }
    if (mesh.mirrors?.panelSlots) {
      for (const slot of mesh.mirrors.panelSlots) {
        this.writeShieldPanelFade(slot, bodyFade);
      }
    }
  }

  applyDyingUnitScatter(
    mesh: EntityMesh,
    bodyDelta: DyingUnitPartDelta,
    turretDeltas: readonly DyingUnitPartDelta[],
  ): void {
    if (mesh.smoothChassisSlots) {
      for (const slot of mesh.smoothChassisSlots) {
        this.applyInstancedDelta(
          this.smoothChassis,
          slot,
          bodyDelta,
          this.smoothChassisMatrixDirty,
        );
      }
    }
    if (mesh.polyChassisSlot !== undefined && mesh.bodyShapeKey) {
      const pool = this.polyChassis.get(mesh.bodyShapeKey);
      if (pool) {
        this.applyInstancedDelta(
          pool.mesh,
          mesh.polyChassisSlot,
          bodyDelta,
          pool.matrixDirty,
        );
      }
    }
    for (let i = 0; i < mesh.turrets.length; i++) {
      const turret = mesh.turrets[i];
      const delta = turretDeltas[i] ?? bodyDelta;
      if (turret.headSlot !== undefined) {
        this.applyInstancedDelta(
          this.turretHeadInstanced,
          turret.headSlot,
          delta,
          this.turretHeadMatrixDirty,
        );
      }
      if (turret.barrelSlots) {
        for (const slot of turret.barrelSlots) {
          if (turret.barrelUsesCone) {
            // Scatter every emitter-rig layer with the same delta — the
            // pieces drifting apart slightly during death-out is the
            // scatter effect working as intended.
            this.applyInstancedDelta(this.coneBarrelInstanced, slot, delta, this.coneBarrelMatrixDirty);
            this.applyInstancedDelta(
              this.coneBarrelInnerInstanced, slot, delta, this.coneBarrelInnerMatrixDirty,
            );
            this.applyInstancedDelta(this.emitterBallInstanced, slot, delta, this.emitterBallMatrixDirty);
            this.applyInstancedDelta(
              this.emitterBallInnerInstanced, slot, delta, this.emitterBallInnerMatrixDirty,
            );
          } else {
            this.applyInstancedDelta(this.barrelInstanced, slot, delta, this.barrelMatrixDirty);
          }
        }
      }
    }
    if (mesh.mirrors?.panelSlots) {
      for (const slot of mesh.mirrors.panelSlots) {
        this.applyInstancedDelta(
          this.shieldPanelInstanced,
          slot,
          bodyDelta,
          this.shieldPanelMatrixDirty,
        );
      }
    }
  }

  private applyInstancedDelta(
    instanced: THREE.InstancedMesh,
    slot: number,
    delta: DyingUnitPartDelta,
    dirty: DirtySpan,
  ): void {
    readInstanceMatrix(instanced, slot, this.scatterMat);
    this.scatterMat.decompose(this.scatterPos, this.scatterQuat, this.scatterScale);
    this.scatterPos.x += delta.dx;
    this.scatterPos.y += delta.dy;
    this.scatterPos.z += delta.dz;
    this.scatterEuler.set(delta.drx, delta.dry, delta.drz, 'XYZ');
    this.scatterRot.setFromEuler(this.scatterEuler);
    this.scatterQuat.premultiply(this.scatterRot);
    this.scatterMat.compose(this.scatterPos, this.scatterQuat, this.scatterScale);
    writeInstanceMatrix(instanced, slot, this.scatterMat, dirty);
  }

  private getOrCreatePolyPool(
    bodyShapeKey: string,
    geom: THREE.BufferGeometry,
  ): PolyChassisPool {
    let pool = this.polyChassis.get(bodyShapeKey);
    if (pool) return pool;
    const mesh = this.createPool(
      geom.clone(),
      new THREE.MeshLambertMaterial({ color: COLORS.units.turret.barrel.colorHex }),
      POLY_CHASSIS_CAP,
    );
    pool = {
      mesh,
      slots: new Map<EntityId, number>(),
      colorKeys: new Map<EntityId, number>(),
      matrixDirty: createDirtySpan(),
      colorDirty: createDirtySpan(),
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
      writeInstanceMatrix(
        this.smoothChassis,
        slot,
        ZERO_MATRIX,
        this.smoothChassisMatrixDirty,
      );
      this.smoothChassisFreeSlots.push(slot);
    }
    this.smoothChassisSlots.delete(entityId);
    this.smoothChassisColorKey.delete(entityId);
  }

  private freePolyChassisSlotForEntity(bodyShapeKey: string, entityId: EntityId): void {
    const pool = this.polyChassis.get(bodyShapeKey);
    if (!pool) return;
    const slot = pool.slots.get(entityId);
    if (slot === undefined) return;
    writeInstanceMatrix(pool.mesh, slot, ZERO_MATRIX, pool.matrixDirty);
    pool.freeSlots.push(slot);
    pool.slots.delete(entityId);
    pool.colorKeys.delete(entityId);
  }

  private freeTurretHeadSlot(slot: number): void {
    writeInstanceMatrix(
      this.turretHeadInstanced,
      slot,
      ZERO_MATRIX,
      this.turretHeadMatrixDirty,
    );
    this.turretHeadFreeSlots.push(slot);
    this.turretHeadColorKey.delete(slot);
  }

  private allocBarrelSlot(): number | null {
    let slot: number;
    if (this.barrelFreeSlots.length > 0) {
      slot = this.barrelFreeSlots.pop()!;
    } else if (this.barrelNextSlot < BARREL_CAP) {
      slot = this.barrelNextSlot++;
    } else {
      return null;
    }
    writeInstanceMatrix(this.barrelInstanced, slot, ZERO_MATRIX, this.barrelMatrixDirty);
    this.writeFade(this.barrelInstanced, slot, 1);
    writeInstanceColorHex(
      this.barrelInstanced,
      slot,
      COLORS.units.turret.barrel.colorHex,
      this.barrelColorDirty,
    );
    return slot;
  }

  private freeBarrelSlot(slot: number): void {
    writeInstanceMatrix(this.barrelInstanced, slot, ZERO_MATRIX, this.barrelMatrixDirty);
    this.barrelFreeSlots.push(slot);
    this.barrelColorKey.delete(slot);
  }

  private allocConeBarrelSlot(): number | null {
    let slot: number;
    if (this.coneBarrelFreeSlots.length > 0) {
      slot = this.coneBarrelFreeSlots.pop()!;
    } else if (this.coneBarrelNextSlot < CONE_BARREL_CAP) {
      slot = this.coneBarrelNextSlot++;
    } else {
      return null;
    }
    this.coneEmitterBallRadius[slot] = 0;
    this.zeroConeEmitterSlot(slot);
    this.writeFade(this.coneBarrelInstanced, slot, 1);
    this.writeFade(this.coneBarrelInnerInstanced, slot, 1);
    this.writeFade(this.emitterBallInstanced, slot, 1);
    this.writeFade(this.emitterBallInnerInstanced, slot, 1);
    return slot;
  }

  private freeConeBarrelSlot(slot: number): void {
    this.coneEmitterBallRadius[slot] = 0;
    this.zeroConeEmitterSlot(slot);
    this.coneBarrelFreeSlots.push(slot);
  }

  /** Zero the cone slot's matrix in the outer pool and every mirror pool. */
  private zeroConeEmitterSlot(slot: number): void {
    writeInstanceMatrix(this.coneBarrelInstanced, slot, ZERO_MATRIX, this.coneBarrelMatrixDirty);
    writeInstanceMatrix(
      this.coneBarrelInnerInstanced,
      slot,
      ZERO_MATRIX,
      this.coneBarrelInnerMatrixDirty,
    );
    writeInstanceMatrix(this.emitterBallInstanced, slot, ZERO_MATRIX, this.emitterBallMatrixDirty);
    writeInstanceMatrix(
      this.emitterBallInnerInstanced,
      slot,
      ZERO_MATRIX,
      this.emitterBallInnerMatrixDirty,
    );
  }

  /** Record the cap radius for a legacy cone slot. Called by the mesh
   *  builder right after slot allocation. */
  registerConeBarrelEmitter(slot: number, ballRadius: number): void {
    this.coneEmitterBallRadius[slot] = ballRadius;
  }

  private allocShieldPanelSlot(): number | null {
    let slot: number;
    if (this.shieldPanelFreeSlots.length > 0) {
      slot = this.shieldPanelFreeSlots.pop()!;
    } else if (this.shieldPanelNextSlot < SHIELD_PANEL_CAP) {
      slot = this.shieldPanelNextSlot++;
    } else {
      return null;
    }
    writeInstanceMatrix(
      this.shieldPanelInstanced,
      slot,
      ZERO_MATRIX,
      this.shieldPanelMatrixDirty,
    );
    return slot;
  }

  private freeShieldPanelSlot(slot: number): void {
    writeInstanceMatrix(
      this.shieldPanelInstanced,
      slot,
      ZERO_MATRIX,
      this.shieldPanelMatrixDirty,
    );
    this.shieldPanelFreeSlots.push(slot);
    this.shieldPanelColorKey.delete(slot);
  }

  private releaseAllSmoothChassisSlots(): void {
    for (const slots of this.smoothChassisSlots.values()) {
      for (const slot of slots) {
        writeInstanceMatrix(
          this.smoothChassis,
          slot,
          ZERO_MATRIX,
          this.smoothChassisMatrixDirty,
        );
      }
    }
    this.smoothChassisSlots.clear();
    this.smoothChassisColorKey.clear();
    clearDirtySpan(this.smoothChassisMatrixDirty);
    clearDirtySpan(this.smoothChassisColorDirty);
    this.clearFadeDirty(this.smoothChassis);
    this.smoothChassisFreeSlots.length = 0;
    this.smoothChassisNextSlot = 0;
    this.smoothChassis.count = 0;
  }

  private releaseAllPolyChassisSlots(): void {
    for (const pool of this.polyChassis.values()) {
      for (const slot of pool.slots.values()) {
        writeInstanceMatrix(pool.mesh, slot, ZERO_MATRIX, pool.matrixDirty);
      }
      pool.slots.clear();
      pool.colorKeys.clear();
      clearDirtySpan(pool.matrixDirty);
      clearDirtySpan(pool.colorDirty);
      this.clearFadeDirty(pool.mesh);
      pool.freeSlots.length = 0;
      pool.nextSlot = 0;
      pool.mesh.count = 0;
    }
  }

  private releaseAllTurretHeadSlots(): void {
    for (let slot = 0; slot < this.turretHeadNextSlot; slot++) {
      writeInstanceMatrix(
        this.turretHeadInstanced,
        slot,
        ZERO_MATRIX,
        this.turretHeadMatrixDirty,
      );
    }
    this.turretHeadColorKey.clear();
    this.turretHeadFreeSlots.length = 0;
    this.turretHeadNextSlot = 0;
    clearDirtySpan(this.turretHeadMatrixDirty);
    clearDirtySpan(this.turretHeadColorDirty);
    this.clearFadeDirty(this.turretHeadInstanced);
    this.turretHeadInstanced.count = 0;
  }

  private releaseAllBarrelSlots(): void {
    for (let slot = 0; slot < this.barrelNextSlot; slot++) {
      writeInstanceMatrix(this.barrelInstanced, slot, ZERO_MATRIX, this.barrelMatrixDirty);
    }
    this.barrelColorKey.clear();
    this.barrelFreeSlots.length = 0;
    this.barrelNextSlot = 0;
    clearDirtySpan(this.barrelMatrixDirty);
    clearDirtySpan(this.barrelColorDirty);
    this.clearFadeDirty(this.barrelInstanced);
    this.barrelInstanced.count = 0;
  }

  private releaseAllConeBarrelSlots(): void {
    for (let slot = 0; slot < this.coneBarrelNextSlot; slot++) {
      this.zeroConeEmitterSlot(slot);
    }
    this.coneEmitterBallRadius.fill(0);
    this.coneBarrelFreeSlots.length = 0;
    this.coneBarrelNextSlot = 0;
    clearDirtySpan(this.coneBarrelMatrixDirty);
    clearDirtySpan(this.coneBarrelInnerMatrixDirty);
    clearDirtySpan(this.emitterBallMatrixDirty);
    clearDirtySpan(this.emitterBallInnerMatrixDirty);
    clearDirtySpan(this.coneBarrelFlow.dirty);
    clearDirtySpan(this.coneBarrelInnerFlow.dirty);
    clearDirtySpan(this.emitterBallFlow.dirty);
    clearDirtySpan(this.emitterBallInnerFlow.dirty);
    this.clearFadeDirty(this.coneBarrelInstanced);
    this.clearFadeDirty(this.coneBarrelInnerInstanced);
    this.clearFadeDirty(this.emitterBallInstanced);
    this.clearFadeDirty(this.emitterBallInnerInstanced);
    this.coneBarrelInstanced.count = 0;
    this.coneBarrelInnerInstanced.count = 0;
    this.emitterBallInstanced.count = 0;
    this.emitterBallInnerInstanced.count = 0;
  }

  private releaseAllShieldPanelSlots(): void {
    for (let slot = 0; slot < this.shieldPanelNextSlot; slot++) {
      writeInstanceMatrix(
        this.shieldPanelInstanced,
        slot,
        ZERO_MATRIX,
        this.shieldPanelMatrixDirty,
      );
    }
    this.shieldPanelColorKey.clear();
    this.shieldPanelFreeSlots.length = 0;
    this.shieldPanelNextSlot = 0;
    clearDirtySpan(this.shieldPanelMatrixDirty);
    clearDirtySpan(this.shieldPanelColorDirty);
    clearDirtySpan(this.shieldPanelAlphaDirty);
    this.shieldPanelInstanced.count = 0;
  }

  private clearFadeDirty(mesh: THREE.InstancedMesh): void {
    const st = this.fadeState.get(mesh);
    if (st) clearDirtySpan(st.dirty);
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
