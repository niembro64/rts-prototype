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
import { growTypedArray } from '../memory/typedArrayGrowth';
import { getChassisLiftY } from '../math/BodyDimensions';
import { getTransformCosSin } from '../math';
import { getUnitBlueprint } from '../sim/blueprints';
import { SHIELD_SURFACE_RENDER_MODE } from '../sim/blueprints/shields';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { GraphicsConfig } from '@/types/graphics';
import {
  createShieldSurfaceMaterial,
  resolveShieldSurfaceColor,
  resolveShieldSurfaceColorForOwner,
} from './ShieldReflectorVisual3D';
import {
  createPrimitiveSphereGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import {
  detailLevelForViewPosition,
  geometryTierForDetail,
} from './EntityDetailLevel3D';
import type { RenderViewState3D } from './RenderFrameState3D';
import type { ClientRenderEntityStateViews } from './ClientRenderEntityStateSlab';
import { CLIENT_RENDER_ENTITY_KIND_UNIT } from './ClientRenderEntityStateSlab';
import {
  CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD,
  type ClientRenderTurretHostRows,
} from './ClientRenderTurretStateSlab';
import { SHIELD_FIELD_SHAPE_SPHERE } from './ShieldFieldShape3D';
import {
  clearDirtySlotSpan as clearDirtySpan,
  createDirtySlotSpan as createDirtySpan,
  markDirtySlot,
  setInstancedMeshCount as setInstancedCount,
  type DirtySlotSpan as DirtySpan,
  uploadDirtySlotSpan as uploadDirtySpan,
  writeInstancedMatrix as writeMatrixAt,
} from './instancedBufferUpdate';
import { applyExposureToRawShader } from './RenderLighting3D';
import { setShieldSphereVisualRotation3D } from './ShieldSphereVisualRotation3D';
import type { HostRenderPoseStore3D } from './HostRenderPoseStore3D';

// barrier.alpha (from shieldMaterials.json visual.alpha) is the rendered
// surface alpha directly — no renderer-side boost, so the authored knob
// and the on-screen result agree and both shield shapes match.
const IMPLICIT_FIELD_CAP = 96;

const IMPLICIT_SHIELD_SURFACE_VS = `
varying vec2 vNdc;

void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const IMPLICIT_SHIELD_SURFACE_FS = `
precision highp float;
precision highp int;

#define FIELD_CAP ${IMPLICIT_FIELD_CAP}

uniform int uFieldCount;
uniform vec4 uFieldData[FIELD_CAP];
uniform vec4 uFieldStyle[FIELD_CAP];
uniform mat4 uInvProjectionMatrix;
uniform mat4 uCameraWorldMatrix;
uniform mat4 uViewProjectionMatrix;
uniform vec3 uCameraPosition;
uniform float uCameraFar;

varying vec2 vNdc;

bool intersectSphere(
  vec3 ro,
  vec3 rd,
  vec4 field,
  out float hitT
) {
  vec3 rel = ro - field.xyz;
  float radius = abs(field.w);
  float b = 2.0 * dot(rel, rd);
  float c = dot(rel, rel) - radius * radius;
  float disc = b * b - 4.0 * c;
  if (disc < 0.0) return false;

  float sqrtDisc = sqrt(disc);
  float t0 = (-b - sqrtDisc) * 0.5;
  float t1 = (-b + sqrtDisc) * 0.5;
  float firstT = min(t0, t1);
  float secondT = max(t0, t1);

  if (firstT > 0.0) {
    hitT = firstT;
    return true;
  }
  if (secondT > 0.0) {
    hitT = secondT;
    return true;
  }
  return false;
}

void main() {
  vec4 farView = uInvProjectionMatrix * vec4(vNdc, 1.0, 1.0);
  farView /= farView.w;
  vec3 farWorld = (uCameraWorldMatrix * vec4(farView.xyz, 1.0)).xyz;
  vec3 rayDir = normalize(farWorld - uCameraPosition);

  float bestT = uCameraFar;
  vec3 bestColor = vec3(0.0);
  float bestAlpha = 0.0;

  for (int i = 0; i < FIELD_CAP; i++) {
    if (i >= uFieldCount) break;
    float t = 0.0;
    bool hit = intersectSphere(uCameraPosition, rayDir, uFieldData[i], t);
    if (!hit) continue;
    if (t >= bestT) continue;
    bestT = t;
    bestColor = uFieldStyle[i].rgb;
    bestAlpha = uFieldStyle[i].a;
  }

  if (bestAlpha <= 0.0) discard;

  vec3 hit = uCameraPosition + rayDir * bestT;
  vec4 clip = uViewProjectionMatrix * vec4(hit, 1.0);
  float ndcDepth = clip.z / clip.w;
  float depth = ndcDepth * 0.5 + 0.5;
  if (depth < 0.0 || depth > 1.0) discard;

  gl_FragDepthEXT = depth;
  gl_FragColor = vec4(bestColor, bestAlpha);
}
`;

function isShieldTurret(t: Turret): boolean {
  return t.presentation.barrel?.type === 'complexSingleEmitter';
}

type FieldMesh = {
  // Per-field cache. The bubble visual is written into the shared
  // `sphereInstancedMesh` slot in the per-frame loop — every active
  // field consumes one instance slot, so the entire shield layer
  // renders in one draw call regardless of field count.
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
  localX: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  localY: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  localZ: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  targetX: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  targetY: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  targetZ: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  /** Sim-space mount origin of the barrier, resolved from the host's
   *  authoritative transform exactly as `updateShieldState` resolves the
   *  gameplay barrier centre. This is the field's own anchor: it does not
   *  depend on the host's chassis having been drawn this frame, so a field
   *  whose host is a strategic glyph (or is off-viewport while its barrier
   *  overlaps it) still knows where it lives. */
  originX: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  originY: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  originZ: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
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

  pushUnit(
    unitEntity: Entity,
    scope: ViewportFootprint,
  ): void {
    const unit = unitEntity.unit;
    const combat = unitEntity.combat;
    if (!unit || !combat) return;
    const unitMountLiftY = this.resolveMountLiftY(unit);
    const fieldColor = resolveShieldSurfaceColor(unitEntity);
    const turrets = combat.turrets;
    const { cos, sin } = getTransformCosSin(unitEntity.transform);
    for (let ti = 0; ti < turrets.length; ti++) {
      const turret = turrets[ti];
      if (!isShieldTurret(turret)) continue;
      const shot = turret.config.shot;
      if (!shot || shot.type !== 'shield' || !shot.barrier) continue;
      const barrier = shot.barrier;
      const originX = unitEntity.transform.x + turret.mount.x * cos - turret.mount.y * sin;
      const originY = unitEntity.transform.y + turret.mount.x * sin + turret.mount.y * cos;
      const originZ = unitEntity.transform.z - unit.supportPointOffsetZ + turret.mount.z;
      if (!scope.inScope(unitEntity.transform.x, unitEntity.transform.y, Math.max(300, barrier.outerRange))) continue;
      this.pushRow({
        hostId: unitEntity.id,
        turretIndex: ti,
        x: unitEntity.transform.x,
        y: unitEntity.transform.y,
        z: unitEntity.transform.z,
        localX: turret.mount.x,
        localY: turret.mount.z - unitMountLiftY,
        localZ: turret.mount.y,
        targetX: unitEntity.transform.x,
        targetY: unitEntity.transform.y,
        targetZ: unitEntity.transform.z,
        originX,
        originY,
        originZ,
        progress: turret.shield?.range ?? 0,
        outerRange: barrier.outerRange,
        originOffsetZ: barrier.originOffsetZ,
        barrierAlpha: barrier.alpha,
        color: fieldColor,
        shape: SHIELD_FIELD_SHAPE_SPHERE,
      });
    }
  }

  pushUnitState(
    unitEntity: Entity,
    state: ClientRenderEntityStateViews,
    slot: number,
    scope: ViewportFootprint,
  ): void {
    const unit = unitEntity.unit;
    const combat = unitEntity.combat;
    if (!unit || !combat || state.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT) return;
    const unitMountLiftY = this.resolveMountLiftY(unit);
    const fieldColor = resolveShieldSurfaceColor(unitEntity);
    const turrets = combat.turrets;
    const hostX = state.x[slot];
    const hostY = state.y[slot];
    const hostZ = state.z[slot];
    const hostRotation = state.rotation[slot];
    const supportPointOffsetZ = state.supportPointOffsetZ[slot];
    const cos = Math.cos(hostRotation);
    const sin = Math.sin(hostRotation);
    for (let ti = 0; ti < turrets.length; ti++) {
      const turret = turrets[ti];
      if (!isShieldTurret(turret)) continue;
      const shot = turret.config.shot;
      if (!shot || shot.type !== 'shield' || !shot.barrier) continue;
      const barrier = shot.barrier;
      const originX = hostX + turret.mount.x * cos - turret.mount.y * sin;
      const originY = hostY + turret.mount.x * sin + turret.mount.y * cos;
      const originZ = hostZ - supportPointOffsetZ + turret.mount.z;
      if (!scope.inScope(hostX, hostY, Math.max(300, barrier.outerRange))) continue;
      this.pushRow({
        hostId: state.entityIds[slot],
        turretIndex: ti,
        x: hostX,
        y: hostY,
        z: hostZ,
        localX: turret.mount.x,
        localY: turret.mount.z - unitMountLiftY,
        localZ: turret.mount.y,
        targetX: hostX,
        targetY: hostY,
        targetZ: hostZ,
        originX,
        originY,
        originZ,
        progress: turret.shield?.range ?? 0,
        outerRange: barrier.outerRange,
        originOffsetZ: barrier.originOffsetZ,
        barrierAlpha: barrier.alpha,
        color: fieldColor,
        shape: SHIELD_FIELD_SHAPE_SPHERE,
      });
    }
  }

  pushUnitTurretState(
    state: ClientRenderEntityStateViews,
    slot: number,
    turretRows: ClientRenderTurretHostRows | undefined,
    scope: ViewportFootprint,
  ): void {
    if (
      turretRows === undefined ||
      state.kind[slot] !== CLIENT_RENDER_ENTITY_KIND_UNIT
    ) {
      return;
    }
    const turretViews = turretRows.views;
    const hostX = state.x[slot];
    const hostY = state.y[slot];
    const hostZ = state.z[slot];
    const hostRotation = state.rotation[slot];
    const supportPointOffsetZ = state.supportPointOffsetZ[slot];
    const ownerId = state.ownerIds[slot];
    const fieldColor = resolveShieldSurfaceColorForOwner(ownerId > 0 ? ownerId : undefined);
    const cos = Math.cos(hostRotation);
    const sin = Math.sin(hostRotation);

    for (let ti = 0; ti < turretRows.count; ti++) {
      const row = turretRows.start + ti;
      if ((turretViews.flags[row] & CLIENT_RENDER_TURRET_FLAG_SHIELD_FIELD) === 0) continue;
      const outerRange = turretViews.barrierOuterRange[row];
      if (!scope.inScope(hostX, hostY, Math.max(300, outerRange))) continue;

      const mountX = turretViews.mountX[row];
      const mountY = turretViews.mountY[row];
      const originX = hostX + mountX * cos - mountY * sin;
      const originY = hostY + mountX * sin + mountY * cos;
      const originZ = hostZ - supportPointOffsetZ + turretViews.mountZ[row];

      this.pushRow({
        hostId: state.entityIds[slot],
        turretIndex: ti,
        x: hostX,
        y: hostY,
        z: hostZ,
        localX: mountX,
        localY: turretViews.mountZ[row] - turretViews.mountLiftY[row],
        localZ: mountY,
        targetX: hostX,
        targetY: hostY,
        targetZ: hostZ,
        originX,
        originY,
        originZ,
        progress: turretViews.shieldRange[row],
        outerRange,
        originOffsetZ: turretViews.barrierOriginOffsetZ[row],
        barrierAlpha: turretViews.barrierAlpha[row],
        color: fieldColor,
        shape: turretViews.barrierShape[row],
      });
    }
  }

  pushRow(options: {
    hostId: number;
    turretIndex: number;
    x: number;
    y: number;
    z: number;
    localX: number;
    localY: number;
    localZ: number;
    targetX: number;
    targetY: number;
    targetZ: number;
    originX: number;
    originY: number;
    originZ: number;
    progress: number;
    outerRange: number;
    originOffsetZ: number;
    barrierAlpha: number;
    color: number;
    shape: number;
  }): void {
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    this.hostIds[cursor] = options.hostId;
    this.turretIndices[cursor] = options.turretIndex;
    this.x[cursor] = options.x;
    this.y[cursor] = options.y;
    this.z[cursor] = options.z;
    this.localX[cursor] = options.localX;
    this.localY[cursor] = options.localY;
    this.localZ[cursor] = options.localZ;
    this.targetX[cursor] = options.targetX;
    this.targetY[cursor] = options.targetY;
    this.targetZ[cursor] = options.targetZ;
    this.originX[cursor] = options.originX;
    this.originY[cursor] = options.originY;
    this.originZ[cursor] = options.originZ;
    this.progress[cursor] = options.progress;
    this.outerRange[cursor] = options.outerRange;
    this.originOffsetZ[cursor] = options.originOffsetZ;
    this.barrierAlpha[cursor] = options.barrierAlpha;
    this.color[cursor] = options.color;
    this.shape[cursor] = options.shape;
    this.count = cursor + 1;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.hostIds.length) return;
    let nextCapacity = this.hostIds.length;
    while (nextCapacity < required) nextCapacity *= 2;
    this.hostIds = growTypedArray(this.hostIds, nextCapacity);
    this.turretIndices = growTypedArray(this.turretIndices, nextCapacity);
    this.x = growTypedArray(this.x, nextCapacity);
    this.y = growTypedArray(this.y, nextCapacity);
    this.z = growTypedArray(this.z, nextCapacity);
    this.localX = growTypedArray(this.localX, nextCapacity);
    this.localY = growTypedArray(this.localY, nextCapacity);
    this.localZ = growTypedArray(this.localZ, nextCapacity);
    this.targetX = growTypedArray(this.targetX, nextCapacity);
    this.targetY = growTypedArray(this.targetY, nextCapacity);
    this.targetZ = growTypedArray(this.targetZ, nextCapacity);
    this.originX = growTypedArray(this.originX, nextCapacity);
    this.originY = growTypedArray(this.originY, nextCapacity);
    this.originZ = growTypedArray(this.originZ, nextCapacity);
    this.progress = growTypedArray(this.progress, nextCapacity);
    this.outerRange = growTypedArray(this.outerRange, nextCapacity);
    this.originOffsetZ = growTypedArray(this.originOffsetZ, nextCapacity);
    this.barrierAlpha = growTypedArray(this.barrierAlpha, nextCapacity);
    this.color = growTypedArray(this.color, nextCapacity);
    this.shape = growTypedArray(this.shape, nextCapacity);
  }

  private resolveMountLiftY(unit: Unit): number {
    const unitBlueprintId = unit.unitBlueprintId;
    const radius = unit.radius.other;
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

function createVector4ScratchArray(length: number): THREE.Vector4[] {
  const vectors = new Array<THREE.Vector4>(length);
  for (let i = 0; i < length; i++) vectors[i] = new THREE.Vector4();
  return vectors;
}

function writeAlphaAt(
  arr: Float32Array,
  slot: number,
  alpha: number,
  dirty: DirtySpan,
): void {
  const next = Math.fround(alpha);
  if (arr[slot] === next) return;
  arr[slot] = next;
  markDirtySlot(dirty, slot);
}

function writeHexColorAt(
  hex: number,
  arr: Float32Array,
  slot: number,
  dirty: DirtySpan,
): void {
  const offset = slot * 3;
  const r = Math.fround(((hex >> 16) & 0xff) / 255);
  const g = Math.fround(((hex >> 8) & 0xff) / 255);
  const b = Math.fround((hex & 0xff) / 255);
  if (arr[offset] === r && arr[offset + 1] === g && arr[offset + 2] === b) {
    return;
  }
  arr[offset] = r;
  arr[offset + 1] = g;
  arr[offset + 2] = b;
  markDirtySlot(dirty, slot);
}

type ShieldSurfacePool = {
  geometry: THREE.BufferGeometry;
  mesh: THREE.InstancedMesh;
  material: THREE.ShaderMaterial;
  alpha: Float32Array;
  color: Float32Array;
  alphaAttr: THREE.InstancedBufferAttribute;
  colorAttr: THREE.InstancedBufferAttribute;
  matrixDirty: DirtySpan;
  alphaDirty: DirtySpan;
  colorDirty: DirtySpan;
  cursor: number;
};

function createShieldSurfacePool(
  root: THREE.Group,
  geometry: THREE.BufferGeometry,
): ShieldSurfacePool {
  const alpha = new Float32Array(SPHERE_INSTANCED_CAP);
  const color = new Float32Array(SPHERE_INSTANCED_CAP * 3);
  const alphaAttr = new THREE.InstancedBufferAttribute(alpha, 1);
  const colorAttr = new THREE.InstancedBufferAttribute(color, 3);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setAttribute('aColor', colorAttr);
  const material = createShieldSurfaceMaterial();
  const mesh = new THREE.InstancedMesh(geometry, material, SPHERE_INSTANCED_CAP);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  root.add(mesh);
  return {
    geometry,
    mesh,
    material,
    alpha,
    color,
    alphaAttr,
    colorAttr,
    matrixDirty: createDirtySpan(),
    alphaDirty: createDirtySpan(),
    colorDirty: createDirtySpan(),
    cursor: 0,
  };
}

function flushShieldSurfacePool(pool: ShieldSurfacePool): void {
  setInstancedCount(pool.mesh, pool.cursor);
  if (pool.cursor <= 0) return;
  uploadDirtySpan(pool.mesh.instanceMatrix, pool.matrixDirty, 16);
  uploadDirtySpan(pool.alphaAttr, pool.alphaDirty, 1);
  uploadDirtySpan(pool.colorAttr, pool.colorDirty, 3);
}

function clearShieldSurfacePool(pool: ShieldSurfacePool): void {
  pool.cursor = 0;
  setInstancedCount(pool.mesh, 0);
  clearDirtySpan(pool.matrixDirty);
  clearDirtySpan(pool.alphaDirty);
  clearDirtySpan(pool.colorDirty);
}

const SHIELD_GEOMETRY_TIERS: readonly PrimitiveGeometryTier[] = [
  'close', 'mid', 'far',
];

export class ShieldRenderer3D {
  private root: THREE.Group;
  private implicitFieldGeom = new THREE.PlaneGeometry(2, 2);
  private fields = new Map<FieldKey, FieldMesh>();
  private readonly spherePools = new Map<PrimitiveGeometryTier, ShieldSurfacePool>();
  private implicitFieldMesh: THREE.Mesh;
  private implicitFieldMat: THREE.ShaderMaterial;
  private implicitFieldData: THREE.Vector4[] = createVector4ScratchArray(IMPLICIT_FIELD_CAP);
  private implicitFieldStyle: THREE.Vector4[] = createVector4ScratchArray(IMPLICIT_FIELD_CAP);
  private implicitFieldInvProjection = new THREE.Matrix4();
  private implicitFieldCameraWorld = new THREE.Matrix4();
  private implicitFieldViewProjection = new THREE.Matrix4();
  private implicitFieldCameraPosition = new THREE.Vector3();
  /** Per-frame transient slot cursor — reset in beginFrame, advanced
   *  per surface in _processUnit, used as the count at end-of-frame. */
  private _implicitFieldCursor = 0;
  private currentView: RenderViewState3D | undefined;
  private drawStateClear = true;
  /** Scratch matrices for the bubble instance write. Same pattern as
   *  the chassis pools — compose `T(worldPos) · S(scale)` per slot,
   *  no per-frame allocations. */
  private _sphereScratchMat = new THREE.Matrix4();
  private _sphereScratchPos = new THREE.Vector3();
  private _sphereScratchScale = new THREE.Vector3();
  private _sphereSpinEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  private _sphereSpinQuat = new THREE.Quaternion();
  /** Reused across frames to track which fields are still active this
   *  frame; everything not in here gets pruned in endFrame. */
  private _seenFieldKeys = new Set<FieldKey>();
  /** The rendered root pose every host was drawn from this frame. The field
   *  is a mounted attachment like any turret, so it composes its origin
   *  through the same pose the turret carrying it used — see
   *  HostRenderPoseStore3D. */
  private hostRenderPoses: HostRenderPoseStore3D;
  private camera: THREE.PerspectiveCamera;

  constructor(
    parentWorld: THREE.Group,
    _scope: ViewportFootprint,
    camera: THREE.PerspectiveCamera,
    hostRenderPoses: HostRenderPoseStore3D,
  ) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.camera = camera;
    this.hostRenderPoses = hostRenderPoses;

    // One immutable instance pool per geometry tier. Field pose/color writes
    // are identical across pools; only the selected primitive changes.
    for (const tier of SHIELD_GEOMETRY_TIERS) {
      this.spherePools.set(
        tier,
        createShieldSurfacePool(
          this.root,
          createPrimitiveSphereGeometry('shield', tier),
        ),
      );
    }
    this.implicitFieldMat = this.createImplicitFieldMaterial();

    this.implicitFieldMesh = new THREE.Mesh(
      this.implicitFieldGeom,
      this.implicitFieldMat,
    );
    this.implicitFieldMesh.frustumCulled = false;
    this.implicitFieldMesh.renderOrder = 7;
    this.implicitFieldMesh.visible = false;
    this.root.add(this.implicitFieldMesh);
  }

  private createImplicitFieldMaterial(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      vertexShader: IMPLICIT_SHIELD_SURFACE_VS,
      fragmentShader: IMPLICIT_SHIELD_SURFACE_FS,
      uniforms: {
        uFieldCount: { value: 0 },
        uFieldData: { value: this.implicitFieldData },
        uFieldStyle: { value: this.implicitFieldStyle },
        uInvProjectionMatrix: { value: this.implicitFieldInvProjection },
        uCameraWorldMatrix: { value: this.implicitFieldCameraWorld },
        uViewProjectionMatrix: { value: this.implicitFieldViewProjection },
        uCameraPosition: { value: this.implicitFieldCameraPosition },
        uCameraFar: { value: this.camera.far },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
    });
    // Raw shader: it writes gl_FragColor itself, so it never tone-maps
    // and is invisible to exposure without this.
    applyExposureToRawShader(material);
    return material;
  }

  private acquire(key: FieldKey): FieldMesh {
    const existing = this.fields.get(key);
    if (existing) return existing;
    const field: FieldMesh = {
      localX: 0,
      localY: 0,
      localZ: 0,
    };
    this.fields.set(key, field);
    return field;
  }

  private updateMountCache(
    field: FieldMesh,
    localX: number,
    localY: number,
    localZ: number,
  ): void {
    if (
      field.localX === localX &&
      field.localY === localY &&
      field.localZ === localZ
    ) {
      return;
    }
    field.localX = localX;
    field.localY = localY;
    field.localZ = localZ;
  }

  /** Begin a fused per-frame iteration. Caller follows with a series
   *  of perUnit calls and finishes with endFrame. The `graphicsConfig`
   *  argument is currently unused, but the parameter is preserved
   *  so existing callers don't need to change shape. */
  beginFrame(
    _graphicsConfig: GraphicsConfig = getGraphicsConfig(),
    view?: RenderViewState3D,
    presentationTimeMs: number = performance.now(),
  ): void {
    this._seenFieldKeys.clear();
    this.currentView = view;
    for (const pool of this.spherePools.values()) pool.cursor = 0;
    this._implicitFieldCursor = 0;
    // One quaternion per frame, shared by every sphere instance. This keeps
    // the three-axis motion effectively free even with many active shields.
    setShieldSphereVisualRotation3D(
      presentationTimeMs,
      this._sphereSpinEuler,
      this._sphereSpinQuat,
    );
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
    let sphereCursor = 0;
    for (const pool of this.spherePools.values()) sphereCursor += pool.cursor;
    const implicitFieldCursor = this._implicitFieldCursor;
    const nextDrawStateClear =
      sphereCursor === 0 &&
      implicitFieldCursor === 0 &&
      this.fields.size === 0;

    if (nextDrawStateClear && this.drawStateClear) return;

    for (const pool of this.spherePools.values()) flushShieldSurfacePool(pool);
    this.updateImplicitFieldUniforms();
    const seen = this._seenFieldKeys;
    for (const [key] of this.fields) {
      if (seen.has(key)) continue;
      this.fields.delete(key);
    }
    this.drawStateClear =
      sphereCursor === 0 &&
      implicitFieldCursor === 0 &&
      this.fields.size === 0;
  }

  clear(): void {
    this._seenFieldKeys.clear();
    this.currentView = undefined;
    this._implicitFieldCursor = 0;
    if (this.drawStateClear) return;
    for (const pool of this.spherePools.values()) clearShieldSurfacePool(pool);
    if (this.implicitFieldMesh.visible) this.implicitFieldMesh.visible = false;
    if (this.implicitFieldMat.uniforms.uFieldCount.value !== 0) {
      this.implicitFieldMat.uniforms.uFieldCount.value = 0;
    }
    this.fields.clear();
    this.drawStateClear = true;
  }

  /** Legacy all-in-one entry — calls beginFrame / processPacket /
   *  endFrame internally so existing callers don't have to thread the
   *  fused lifecycle. */
  update(packet: ShieldRenderPacket3D, view?: RenderViewState3D): void {
    this.beginFrame(undefined, view);
    this.processPacket(packet);
    this.endFrame();
  }

  private updateImplicitFieldUniforms(): void {
    const count = this._implicitFieldCursor;
    this.implicitFieldMesh.visible = count > 0;
    this.implicitFieldMat.uniforms.uFieldCount.value = count;
    if (count <= 0) return;

    this.implicitFieldInvProjection.copy(this.camera.projectionMatrixInverse);
    this.implicitFieldCameraWorld.copy(this.camera.matrixWorld);
    this.implicitFieldViewProjection.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    this.implicitFieldCameraPosition.setFromMatrixPosition(this.camera.matrixWorld);
    this.implicitFieldMat.uniforms.uCameraFar.value = this.camera.far;
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
      packet.localX[row],
      packet.localY[row],
      packet.localZ[row],
    );

    const progress = packet.progress[row];
    if (progress <= 0) return;
    const outer = packet.outerRange[row];
    if (outer <= 0) return;
    const geometryTier = this.currentView === undefined
      ? 'close'
      : geometryTierForDetail(detailLevelForViewPosition(
        this.currentView,
        packet.x[row],
        packet.y[row],
        packet.z[row],
        outer,
      ));
    const fadeIn = Math.min(progress * 3, 1);
    const localX = field.localX;
    const localY = field.localY;
    const localZ = field.localZ;

    // The bubble is written in absolute world coords, but it is a mounted
    // attachment: while its host's chassis is drawn, its origin is the
    // turret's mount composed through the one rendered root pose that
    // chassis was drawn from, so chassis tilt, body orientation and
    // presentation bank all carry (see budget_design_philosophy.html,
    // "One rendered root pose owns every attachment").
    //
    // A host with no pose this frame drew no chassis — it is a strategic
    // glyph at the removal rung, mid mesh-rebuild, or outside the render
    // scope while its barrier still overlaps the viewport. The FIELD is
    // none of those things: it is world-scale gameplay geometry that owns
    // its own coverage rung (selected from `outer` above), so it falls back
    // to the mount origin the packet resolved from the host's authoritative
    // transform. That is the same origin `updateShieldState` gives the
    // gameplay barrier, not the stale Three.js group read that once
    // detached bubbles from their turrets: it only forgoes chassis tilt and
    // presentation bank, which are sub-pixel on a host too small to draw.
    if (!this.hostRenderPoses.composeAttachment(
      hostId,
      localX,
      localY,
      localZ,
      this._sphereScratchPos,
    )) {
      this._sphereScratchPos.set(
        packet.originX[row],
        packet.originZ[row],
        packet.originY[row],
      );
    }

    const fieldCenterY = this._sphereScratchPos.y - packet.originOffsetZ[row];
    this._sphereScratchPos.y = fieldCenterY;
    const alpha = packet.barrierAlpha[row] * fadeIn;
    if (SHIELD_SURFACE_RENDER_MODE === 'screen-space-analytic-shader') {
      if (this._implicitFieldCursor < IMPLICIT_FIELD_CAP) {
        const cursor = this._implicitFieldCursor;
        this.implicitFieldData[cursor].set(
          this._sphereScratchPos.x,
          this._sphereScratchPos.y,
          this._sphereScratchPos.z,
          outer,
        );
        writeHexAlphaToVector4(packet.color[row], alpha, this.implicitFieldStyle[cursor]);
        this._implicitFieldCursor++;
        return;
      }
      // Uniform capacity is an optimization ceiling, never a visibility
      // ceiling. Overflow fields continue below into their physical geometry
      // path (already tiered down to Low at distance) instead of disappearing.
    }

    const spherePool = this.spherePools.get(geometryTier)!;
    if (spherePool.cursor < SPHERE_INSTANCED_CAP) {
      this._sphereScratchScale.set(outer, outer, outer);
      this._sphereScratchMat.compose(
        this._sphereScratchPos,
        this._sphereSpinQuat,
        this._sphereScratchScale,
      );
      const cursor = spherePool.cursor;
      writeMatrixAt(
        spherePool.mesh,
        cursor,
        this._sphereScratchMat,
        spherePool.matrixDirty,
      );
      writeAlphaAt(spherePool.alpha, cursor, alpha, spherePool.alphaDirty);
      writeHexColorAt(
        packet.color[row],
        spherePool.color,
        cursor,
        spherePool.colorDirty,
      );
      spherePool.cursor++;
    }
  }

  destroy(): void {
    this.fields.clear();
    for (const pool of this.spherePools.values()) {
      this.root.remove(pool.mesh);
      pool.mesh.dispose();
      pool.material.dispose();
      pool.geometry.dispose();
    }
    this.spherePools.clear();
    this.root.remove(this.implicitFieldMesh);
    this.implicitFieldMesh.geometry.dispose();
    this.implicitFieldMat.dispose();
    this.root.parent?.remove(this.root);
  }
}

function writeHexAlphaToVector4(hex: number, alpha: number, out: THREE.Vector4): void {
  out.set(
    ((hex >> 16) & 0xff) / 255,
    ((hex >> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
    alpha,
  );
}
