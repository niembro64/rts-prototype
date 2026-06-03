// ShieldRenderer3D — 3D visualization for shield turrets.
//
// A shield turret uses the `complexSingleEmitter` barrel type and carries
// a `ShieldConfig` (shot.type === 'shield') configured with a barrier surface.
// It animates per-tick via `turret.shield.range` (0 → 1 progress).
//
// One shield look: a translucent force surface that fades in with
// `turret.shield.range`.

import * as THREE from 'three';
import type { Entity, EntityId, Turret, Unit } from '../sim/types';
import { getChassisLiftY } from '../math/BodyDimensions';
import { getUnitBlueprint } from '../sim/blueprints';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { GraphicsConfig } from '@/types/graphics';
import { writeHexToRgb01Array } from './colorUtils';
import {
  createShieldSurfaceMaterial,
  resolveShieldSurfaceColor,
} from './ShieldReflectorVisual3D';

// Opacity multiplier on top of barrier.alpha so the bubble reads more
// solid in 3D than the 2D translucent fill.
const FIELD_OPACITY_BOOST = 2.0;
const FIELD_SHAPE_SPHERE = 0;
const FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER = 1;
const INFINITE_CYLINDER_VISUAL_HEIGHT = 4096;

function isShieldTurret(t: Turret): boolean {
  return (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
}

type FieldMesh = {
  // Per-field cache. The bubble visual is written into the shared
  // `sphereInstancedMesh` slot in the per-frame loop — every active
  // field consumes one instance slot, so the entire shield layer
  // renders in one draw call regardless of field count.
  mountOffsetX: number;
  mountOffsetY: number;
  mountZ: number;
  mountLiftY: number;
  localX: number;
  localY: number;
  localZ: number;
};

type FieldKey = number | string;
const FIELD_KEY_TURRET_STRIDE = 1024;

function shieldKey(unitEntityId: number, turretIndex: number): FieldKey {
  if (
    turretIndex >= 0 &&
    turretIndex < FIELD_KEY_TURRET_STRIDE &&
    Number.isSafeInteger(unitEntityId)
  ) {
    return unitEntityId * FIELD_KEY_TURRET_STRIDE + turretIndex;
  }
  return `${unitEntityId}-${turretIndex}`;
}

/** Cap on shared field instances. Every active shield consumes
 *  one slot for its translucent surface. 512 is well above any
 *  realistic concurrent count. */
const SPHERE_INSTANCED_CAP = 512;
const SHIELD_PACKET_INITIAL_CAP = SPHERE_INSTANCED_CAP;

export class ShieldRenderPacket3D {
  hostIds: Float64Array = new Float64Array(SHIELD_PACKET_INITIAL_CAP);
  turretIndices: Uint16Array = new Uint16Array(SHIELD_PACKET_INITIAL_CAP);
  x: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  y: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  z: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  rotation: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  bodyCenterHeight: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  mountLiftY: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  localX: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  localY: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  localZ: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  progress: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  outerRange: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  originOffsetZ: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  barrierAlpha: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  color: Uint32Array = new Uint32Array(SHIELD_PACKET_INITIAL_CAP);
  shape: Uint8Array = new Uint8Array(SHIELD_PACKET_INITIAL_CAP);
  private readonly mountLiftCache = new Map<string, { radius: number; liftY: number }>();
  count = 0;

  reset(): void {
    this.count = 0;
  }

  pushUnit(unitEntity: Entity, scope: ViewportFootprint): void {
    const unit = unitEntity.unit;
    const combat = unitEntity.combat;
    if (!unit || !combat) return;
    const unitMountLiftY = this.resolveMountLiftY(unit);
    const fieldColor = resolveShieldSurfaceColor(unitEntity);
    const turrets = combat.turrets;
    for (let ti = 0; ti < turrets.length; ti++) {
      const turret = turrets[ti];
      if (!isShieldTurret(turret)) continue;
      const shot = turret.config.shot;
      if (!shot || shot.type !== 'shield' || !shot.barrier) continue;
      const barrier = shot.barrier;
      if (!scope.inScope(unitEntity.transform.x, unitEntity.transform.y, Math.max(300, barrier.outerRange))) continue;
      const cursor = this.count;
      this.ensureCapacity(cursor + 1);
      this.hostIds[cursor] = unitEntity.id;
      this.turretIndices[cursor] = ti;
      this.x[cursor] = unitEntity.transform.x;
      this.y[cursor] = unitEntity.transform.y;
      this.z[cursor] = unitEntity.transform.z;
      this.rotation[cursor] = unitEntity.transform.rotation;
      this.bodyCenterHeight[cursor] = unit.bodyCenterHeight;
      this.mountLiftY[cursor] = unitMountLiftY;
      this.localX[cursor] = turret.mount.x;
      this.localY[cursor] = turret.mount.z - unitMountLiftY;
      this.localZ[cursor] = turret.mount.y;
      this.progress[cursor] = turret.shield?.range ?? 0;
      this.outerRange[cursor] = barrier.outerRange;
      this.originOffsetZ[cursor] = barrier.originOffsetZ;
      this.barrierAlpha[cursor] = barrier.alpha;
      this.color[cursor] = fieldColor;
      this.shape[cursor] = barrier.shape === 'infiniteVerticalCylinder'
        ? FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER
        : FIELD_SHAPE_SPHERE;
      this.count = cursor + 1;
    }
  }

  private ensureCapacity(required: number): void {
    if (required <= this.hostIds.length) return;
    let nextCapacity = this.hostIds.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.hostIds = growFloat64(this.hostIds, nextCapacity);
    this.turretIndices = growUint16(this.turretIndices, nextCapacity);
    this.x = growFloat32(this.x, nextCapacity);
    this.y = growFloat32(this.y, nextCapacity);
    this.z = growFloat32(this.z, nextCapacity);
    this.rotation = growFloat32(this.rotation, nextCapacity);
    this.bodyCenterHeight = growFloat32(this.bodyCenterHeight, nextCapacity);
    this.mountLiftY = growFloat32(this.mountLiftY, nextCapacity);
    this.localX = growFloat32(this.localX, nextCapacity);
    this.localY = growFloat32(this.localY, nextCapacity);
    this.localZ = growFloat32(this.localZ, nextCapacity);
    this.progress = growFloat32(this.progress, nextCapacity);
    this.outerRange = growFloat32(this.outerRange, nextCapacity);
    this.originOffsetZ = growFloat32(this.originOffsetZ, nextCapacity);
    this.barrierAlpha = growFloat32(this.barrierAlpha, nextCapacity);
    this.color = growUint32(this.color, nextCapacity);
    this.shape = growUint8(this.shape, nextCapacity);
  }

  private resolveMountLiftY(unit: Unit): number {
    const unitBlueprintId = unit.unitBlueprintId;
    const radius = unit.radius.visual;
    const cached = this.mountLiftCache.get(unitBlueprintId);
    if (cached !== undefined && cached.radius === radius) return cached.liftY;
    let unitBlueprint;
    try { unitBlueprint = getUnitBlueprint(unitBlueprintId); }
    catch { /* keep fallback */ }
    const liftY = getChassisLiftY(unitBlueprint, radius);
    this.mountLiftCache.set(unitBlueprintId, { radius, liftY });
    return liftY;
  }
}

function growFloat32(source: Float32Array, nextCapacity: number): Float32Array {
  const next = new Float32Array(nextCapacity);
  next.set(source);
  return next;
}

function growFloat64(source: Float64Array, nextCapacity: number): Float64Array {
  const next = new Float64Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint16(source: Uint16Array, nextCapacity: number): Uint16Array {
  const next = new Uint16Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint32(source: Uint32Array, nextCapacity: number): Uint32Array {
  const next = new Uint32Array(nextCapacity);
  next.set(source);
  return next;
}

function growUint8(source: Uint8Array, nextCapacity: number): Uint8Array {
  const next = new Uint8Array(nextCapacity);
  next.set(source);
  return next;
}

export class ShieldRenderer3D {
  private root: THREE.Group;
  // Unit sphere reused for the bubble write into the shared
  // sphereInstancedMesh below.
  private sphereGeom = new THREE.SphereGeometry(1, 20, 14);
  private cylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
  private fields = new Map<FieldKey, FieldMesh>();

  /** Shared InstancedMesh covering every bubble sphere across every
   *  active shield on the map. Slots are allocated TRANSIENT per
   *  frame: walk active fields, write [0, count). count is set to the
   *  live prefix at end-of-frame so off-screen / inactive fields cost
   *  zero GPU time. The whole shield layer is one draw call. */
  private sphereInstancedMesh: THREE.InstancedMesh;
  private sphereInstancedMat: THREE.ShaderMaterial;
  private sphereAlphaArr = new Float32Array(SPHERE_INSTANCED_CAP);
  private sphereColorArr = new Float32Array(SPHERE_INSTANCED_CAP * 3);
  private sphereAlphaAttr: THREE.InstancedBufferAttribute;
  private sphereColorAttr: THREE.InstancedBufferAttribute;
  private cylinderInstancedMesh: THREE.InstancedMesh;
  private cylinderInstancedMat: THREE.ShaderMaterial;
  private cylinderAlphaArr = new Float32Array(SPHERE_INSTANCED_CAP);
  private cylinderColorArr = new Float32Array(SPHERE_INSTANCED_CAP * 3);
  private cylinderAlphaAttr: THREE.InstancedBufferAttribute;
  private cylinderColorAttr: THREE.InstancedBufferAttribute;
  /** Per-frame transient slot cursor — reset in beginFrame, advanced
   *  per surface in _processUnit, used as the count at end-of-frame. */
  private _sphereCursor = 0;
  private _cylinderCursor = 0;
  /** Scratch matrices for the bubble instance write. Same pattern as
   *  the chassis pools — compose `T(worldPos) · S(scale)` per slot,
   *  no per-frame allocations. */
  private _sphereScratchMat = new THREE.Matrix4();
  private _sphereScratchPos = new THREE.Vector3();
  private _sphereScratchScale = new THREE.Vector3();
  private _sphereLocalPos = new THREE.Vector3();
  private _sphereParentQuat = new THREE.Quaternion();
  private _sphereYawQuat = new THREE.Quaternion();
  private static readonly _SPHERE_UP = new THREE.Vector3(0, 1, 0);
  private static readonly _IDENTITY_QUAT = new THREE.Quaternion();
  /** Reused across frames to track which fields are still active this
   *  frame; everything not in here gets pruned in endFrame. */
  private _seenFieldKeys = new Set<FieldKey>();
  /** Look up the unit's yaw subgroup. Used to compose the field's
   *  world position from the unit's parent-chain (group → realYawGroup
   *  → liftGroup) so the bubble follows chassis tilt + yaw exactly.
   *  Returns undefined when the unit's mesh hasn't been built yet
   *  (off-scope at scene start) or was torn down during a rebuild;
   *  in that case we fall back to the unit's transform. */
  private getYawGroup: (eid: EntityId) => THREE.Group | undefined;

  constructor(
    parentWorld: THREE.Group,
    _scope: ViewportFootprint,
    getYawGroup: (eid: EntityId) => THREE.Group | undefined,
  ) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.getYawGroup = getYawGroup;

    // Build the shared bubble InstancedMesh. Same construction
    // pattern as SmokeTrail3D / Explosion3D / SprayRenderer3D.
    this.sphereAlphaAttr = new THREE.InstancedBufferAttribute(this.sphereAlphaArr, 1);
    this.sphereAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.sphereColorAttr = new THREE.InstancedBufferAttribute(this.sphereColorArr, 3);
    this.sphereColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.sphereGeom.setAttribute('aAlpha', this.sphereAlphaAttr);
    this.sphereGeom.setAttribute('aColor', this.sphereColorAttr);
    this.cylinderAlphaAttr = new THREE.InstancedBufferAttribute(this.cylinderAlphaArr, 1);
    this.cylinderAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.cylinderColorAttr = new THREE.InstancedBufferAttribute(this.cylinderColorArr, 3);
    this.cylinderColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.cylinderGeom.setAttribute('aAlpha', this.cylinderAlphaAttr);
    this.cylinderGeom.setAttribute('aColor', this.cylinderColorAttr);

    // Materials Are Independent Of Shape: same material as the flat-panel
    // shield surface, just carried by field geometry here.
    this.sphereInstancedMat = createShieldSurfaceMaterial();
    this.cylinderInstancedMat = createShieldSurfaceMaterial();

    this.sphereInstancedMesh = new THREE.InstancedMesh(
      this.sphereGeom,
      this.sphereInstancedMat,
      SPHERE_INSTANCED_CAP,
    );
    this.sphereInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.sphereInstancedMesh.count = 0;
    // Source-geom bounding sphere is at origin (radius 1); instances
    // live anywhere on the map.
    this.sphereInstancedMesh.frustumCulled = false;
    // Slightly higher render-order than the per-particle effects so
    // the bubble's translucency composites on top of smoke particles
    // passing through it.
    this.sphereInstancedMesh.renderOrder = 7;
    this.root.add(this.sphereInstancedMesh);

    this.cylinderInstancedMesh = new THREE.InstancedMesh(
      this.cylinderGeom,
      this.cylinderInstancedMat,
      SPHERE_INSTANCED_CAP,
    );
    this.cylinderInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cylinderInstancedMesh.count = 0;
    this.cylinderInstancedMesh.frustumCulled = false;
    this.cylinderInstancedMesh.renderOrder = 7;
    this.root.add(this.cylinderInstancedMesh);
  }

  private acquire(key: FieldKey): FieldMesh {
    const existing = this.fields.get(key);
    if (existing) return existing;
    const field: FieldMesh = {
      mountOffsetX: NaN,
      mountOffsetY: NaN,
      mountZ: NaN,
      mountLiftY: NaN,
      localX: 0,
      localY: 0,
      localZ: 0,
    };
    this.fields.set(key, field);
    return field;
  }

  private updateMountCache(
    field: FieldMesh,
    mountLiftY: number,
    localX: number,
    localY: number,
    localZ: number,
  ): void {
    if (
      field.mountOffsetX === localX &&
      field.mountOffsetY === localZ &&
      field.mountZ === localY + mountLiftY &&
      field.mountLiftY === mountLiftY
    ) {
      return;
    }

    field.mountOffsetX = localX;
    field.mountOffsetY = localZ;
    field.mountZ = localY + mountLiftY;
    field.mountLiftY = mountLiftY;
    field.localX = localX;
    field.localY = localY;
    field.localZ = localZ;
  }

  /** Begin a fused per-frame iteration. Caller follows with a series
   *  of perUnit calls and finishes with endFrame. The `graphicsConfig`
   *  argument is currently unused, but the parameter is preserved
   *  so existing callers don't need to change shape. */
  beginFrame(_graphicsConfig: GraphicsConfig = getGraphicsConfig()): void {
    this._seenFieldKeys.clear();
    this._sphereCursor = 0;
    this._cylinderCursor = 0;
  }

  processPacket(packet: ShieldRenderPacket3D): void {
    for (let row = 0; row < packet.count; row++) {
      this._processRow(packet, row);
    }
  }

  /** End a fused-iteration frame: flush the InstancedMesh count + dirty
   *  ranges, then tear down per-field state for fields that didn't get
   *  visited (unit despawned, shield disabled, off-scope). */
  endFrame(): void {
    this.sphereInstancedMesh.count = this._sphereCursor;
    if (this._sphereCursor > 0) {
      this.sphereInstancedMesh.instanceMatrix.clearUpdateRanges();
      this.sphereInstancedMesh.instanceMatrix.addUpdateRange(0, this._sphereCursor * 16);
      this.sphereInstancedMesh.instanceMatrix.needsUpdate = true;
      this.sphereAlphaAttr.clearUpdateRanges();
      this.sphereAlphaAttr.addUpdateRange(0, this._sphereCursor);
      this.sphereAlphaAttr.needsUpdate = true;
      this.sphereColorAttr.clearUpdateRanges();
      this.sphereColorAttr.addUpdateRange(0, this._sphereCursor * 3);
      this.sphereColorAttr.needsUpdate = true;
    }
    this.cylinderInstancedMesh.count = this._cylinderCursor;
    if (this._cylinderCursor > 0) {
      this.cylinderInstancedMesh.instanceMatrix.clearUpdateRanges();
      this.cylinderInstancedMesh.instanceMatrix.addUpdateRange(0, this._cylinderCursor * 16);
      this.cylinderInstancedMesh.instanceMatrix.needsUpdate = true;
      this.cylinderAlphaAttr.clearUpdateRanges();
      this.cylinderAlphaAttr.addUpdateRange(0, this._cylinderCursor);
      this.cylinderAlphaAttr.needsUpdate = true;
      this.cylinderColorAttr.clearUpdateRanges();
      this.cylinderColorAttr.addUpdateRange(0, this._cylinderCursor * 3);
      this.cylinderColorAttr.needsUpdate = true;
    }
    const seen = this._seenFieldKeys;
    for (const [key] of this.fields) {
      if (seen.has(key)) continue;
      this.fields.delete(key);
    }
  }

  /** Legacy all-in-one entry — calls beginFrame / processPacket /
   *  endFrame internally so existing callers don't have to thread the
   *  fused lifecycle. */
  update(packet: ShieldRenderPacket3D): void {
    this.beginFrame();
    this.processPacket(packet);
    this.endFrame();
  }

  /** Internal packet-row body. Writes the active field surface instance. */
  private _processRow(packet: ShieldRenderPacket3D, row: number): void {
    const seen = this._seenFieldKeys;

    const hostId = packet.hostIds[row] as EntityId;
    const turretIndex = packet.turretIndices[row];
    const key = shieldKey(hostId, turretIndex);
    seen.add(key);
    const field = this.acquire(key);
    this.updateMountCache(
      field,
      packet.mountLiftY[row],
      packet.localX[row],
      packet.localY[row],
      packet.localZ[row],
    );

    const progress = packet.progress[row];
    if (progress <= 0) return;
    const outer = packet.outerRange[row];
    if (outer <= 0) return;
    const fadeIn = Math.min(progress * 3, 1);
    const localX = field.localX;
    const localY = field.localY;
    const localZ = field.localZ;

    // The bubble is written in absolute world coords below, so it
    // doesn't need a parent. yawGroup is only consulted to read the
    // unit's parent-chain pose for accurate world-position composition
    // (chassis tilt + yaw); when it's missing we fall back to the
    // packet's transform row.
    const liftGroupNode = this.getYawGroup(hostId); // getYawGroup returns liftGroup
    const realYawGroup = liftGroupNode?.parent;
    const groupOuter = realYawGroup?.parent;
    if (liftGroupNode && realYawGroup && groupOuter) {
      this._sphereYawQuat.setFromAxisAngle(
        ShieldRenderer3D._SPHERE_UP,
        realYawGroup.rotation.y,
      );
      this._sphereParentQuat
        .copy(groupOuter.quaternion)
        .multiply(this._sphereYawQuat);
      this._sphereLocalPos.set(localX, liftGroupNode.position.y + localY, localZ);
      this._sphereLocalPos.applyQuaternion(this._sphereParentQuat);
      this._sphereScratchPos
        .copy(groupOuter.position)
        .add(this._sphereLocalPos);
    } else {
      // No liftGroup — use the fallback unit transform from the packet.
      // Rebuild the same base-Y convention Render3DEntities uses:
      // group.y = sim altitude − bodyCenterHeight, then add the
      // cached blueprint chassis lift and this turret's chassis-
      // local mount Y. Slope tilt lives only on the unit mesh chain;
      // yaw and vertical body lift still stay coherent.
      const yaw = packet.rotation[row];
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const rx = cosYaw * localX - sinYaw * localZ;
      const rz = sinYaw * localX + cosYaw * localZ;
      this._sphereScratchPos.set(
        packet.x[row] + rx,
        packet.z[row] - packet.bodyCenterHeight[row] + field.mountLiftY + localY,
        packet.y[row] + rz,
      );
    }

    const fieldCenterY = this._sphereScratchPos.y - packet.originOffsetZ[row];
    this._sphereScratchPos.y = fieldCenterY;
    const alpha = packet.barrierAlpha[row] * fadeIn * FIELD_OPACITY_BOOST;
    if (packet.shape[row] === FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER) {
      if (this._cylinderCursor < SPHERE_INSTANCED_CAP) {
        this._sphereScratchScale.set(
          outer,
          Math.max(INFINITE_CYLINDER_VISUAL_HEIGHT, outer * 10),
          outer,
        );
        this._sphereScratchMat.compose(
          this._sphereScratchPos,
          ShieldRenderer3D._IDENTITY_QUAT,
          this._sphereScratchScale,
        );
        this.cylinderInstancedMesh.setMatrixAt(this._cylinderCursor, this._sphereScratchMat);
        this.cylinderAlphaArr[this._cylinderCursor] = alpha;
        writeHexToRgb01Array(packet.color[row], this.cylinderColorArr, this._cylinderCursor * 3);
        this._cylinderCursor++;
      }
    } else if (this._sphereCursor < SPHERE_INSTANCED_CAP) {
      this._sphereScratchScale.set(outer, outer, outer);
      this._sphereScratchMat.compose(
        this._sphereScratchPos,
        ShieldRenderer3D._IDENTITY_QUAT,
        this._sphereScratchScale,
      );
      this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
      this.sphereAlphaArr[this._sphereCursor] = alpha;
      writeHexToRgb01Array(packet.color[row], this.sphereColorArr, this._sphereCursor * 3);
      this._sphereCursor++;
    }
  }

  destroy(): void {
    this.fields.clear();
    this.root.remove(this.sphereInstancedMesh);
    this.root.remove(this.cylinderInstancedMesh);
    this.sphereInstancedMesh.dispose();
    this.cylinderInstancedMesh.dispose();
    this.sphereInstancedMat.dispose();
    this.cylinderInstancedMat.dispose();
    this.sphereGeom.dispose();
    this.cylinderGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
