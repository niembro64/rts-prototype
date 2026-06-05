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
import { getTransformCosSin } from '../math';
import { getUnitBlueprint } from '../sim/blueprints';
import { SHIELD_SURFACE_RENDER_MODE } from '../sim/blueprints/shields';
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
const FIELD_SHAPE_AIMED_CYLINDER = 2;
const FINITE_CYLINDER_INFINITY_VISUAL_MIN_HALF_HEIGHT = 12000;
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

bool intersectInfiniteVerticalCylinder(
  vec3 ro,
  vec3 rd,
  vec4 field,
  out float hitT
) {
  vec2 center = field.xz;
  float radius = abs(field.w);
  vec2 rel = ro.xz - center;
  vec2 dir = rd.xz;
  float a = dot(dir, dir);
  if (a <= 1e-9) return false;

  float b = 2.0 * dot(rel, dir);
  float c = dot(rel, rel) - radius * radius;
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return false;

  float sqrtDisc = sqrt(disc);
  float invDenom = 1.0 / (2.0 * a);
  float t0 = (-b - sqrtDisc) * invDenom;
  float t1 = (-b + sqrtDisc) * invDenom;
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
    bool hit = false;
    if (uFieldData[i].w > 0.0) {
      hit = intersectSphere(uCameraPosition, rayDir, uFieldData[i], t);
    } else {
      hit = intersectInfiniteVerticalCylinder(uCameraPosition, rayDir, uFieldData[i], t);
    }
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
  targetX: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  targetY: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
  targetZ: Float32Array = new Float32Array(SHIELD_PACKET_INITIAL_CAP);
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
    for (let ti = 0; ti < turrets.length; ti++) {
      const turret = turrets[ti];
      if (!isShieldTurret(turret)) continue;
      const shot = turret.config.shot;
      if (!shot || shot.type !== 'shield' || !shot.barrier) continue;
      const barrier = shot.barrier;
      let targetX = unitEntity.transform.x;
      let targetY = unitEntity.transform.y;
      let targetZ = unitEntity.transform.z;
      if (barrier.shape === 'aimedCylinder') {
        const { cos, sin } = getTransformCosSin(unitEntity.transform);
        const originX = unitEntity.transform.x + turret.mount.x * cos - turret.mount.y * sin;
        const originY = unitEntity.transform.y + turret.mount.x * sin + turret.mount.y * cos;
        const originZ = unitEntity.transform.z - unit.bodyCenterHeight + turret.mount.z;
        const pitchSin = Math.sin(turret.pitch);
        const pitchCos = Math.cos(turret.pitch);
        targetX = originX + Math.cos(turret.rotation) * pitchCos * turret.config.range;
        targetY = originY + Math.sin(turret.rotation) * pitchCos * turret.config.range;
        targetZ = originZ + pitchSin * turret.config.range;
      }
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
      this.targetX[cursor] = targetX;
      this.targetY[cursor] = targetY;
      this.targetZ[cursor] = targetZ;
      this.progress[cursor] = turret.shield?.range ?? 0;
      this.outerRange[cursor] = barrier.outerRange;
      this.originOffsetZ[cursor] = barrier.originOffsetZ;
      this.barrierAlpha[cursor] = barrier.alpha;
      this.color[cursor] = fieldColor;
      this.shape[cursor] = barrier.shape === 'infiniteVerticalCylinder'
        ? FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER
        : barrier.shape === 'aimedCylinder'
          ? FIELD_SHAPE_AIMED_CYLINDER
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
    this.targetX = growFloat32(this.targetX, nextCapacity);
    this.targetY = growFloat32(this.targetY, nextCapacity);
    this.targetZ = growFloat32(this.targetZ, nextCapacity);
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
  private finiteCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
  private implicitFieldGeom = new THREE.PlaneGeometry(2, 2);
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
  private finiteCylinderInstancedMesh: THREE.InstancedMesh;
  private finiteCylinderInstancedMat: THREE.ShaderMaterial;
  private finiteCylinderAlphaArr = new Float32Array(SPHERE_INSTANCED_CAP);
  private finiteCylinderColorArr = new Float32Array(SPHERE_INSTANCED_CAP * 3);
  private finiteCylinderAlphaAttr: THREE.InstancedBufferAttribute;
  private finiteCylinderColorAttr: THREE.InstancedBufferAttribute;
  private implicitFieldMesh: THREE.Mesh;
  private implicitFieldMat: THREE.ShaderMaterial;
  private implicitFieldData: THREE.Vector4[] = Array.from(
    { length: IMPLICIT_FIELD_CAP },
    () => new THREE.Vector4(),
  );
  private implicitFieldStyle: THREE.Vector4[] = Array.from(
    { length: IMPLICIT_FIELD_CAP },
    () => new THREE.Vector4(),
  );
  private implicitFieldInvProjection = new THREE.Matrix4();
  private implicitFieldCameraWorld = new THREE.Matrix4();
  private implicitFieldViewProjection = new THREE.Matrix4();
  private implicitFieldCameraPosition = new THREE.Vector3();
  /** Per-frame transient slot cursor — reset in beginFrame, advanced
   *  per surface in _processUnit, used as the count at end-of-frame. */
  private _sphereCursor = 0;
  private _finiteCylinderCursor = 0;
  private _implicitFieldCursor = 0;
  /** Scratch matrices for the bubble instance write. Same pattern as
   *  the chassis pools — compose `T(worldPos) · S(scale)` per slot,
   *  no per-frame allocations. */
  private _sphereScratchMat = new THREE.Matrix4();
  private _sphereScratchPos = new THREE.Vector3();
  private _sphereScratchScale = new THREE.Vector3();
  private _sphereLocalPos = new THREE.Vector3();
  private _cylinderTargetPos = new THREE.Vector3();
  private _cylinderMidPos = new THREE.Vector3();
  private _cylinderDir = new THREE.Vector3();
  private _cylinderQuat = new THREE.Quaternion();
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
  private camera: THREE.PerspectiveCamera;

  constructor(
    parentWorld: THREE.Group,
    _scope: ViewportFootprint,
    camera: THREE.PerspectiveCamera,
    getYawGroup: (eid: EntityId) => THREE.Group | undefined,
  ) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.camera = camera;
    this.getYawGroup = getYawGroup;

    // Build the shared bubble InstancedMesh. Same construction
    // pattern as SmokeTrail3D / Explosion3D / SprayRenderer3D.
    this.sphereAlphaAttr = new THREE.InstancedBufferAttribute(this.sphereAlphaArr, 1);
    this.sphereAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.sphereColorAttr = new THREE.InstancedBufferAttribute(this.sphereColorArr, 3);
    this.sphereColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.sphereGeom.setAttribute('aAlpha', this.sphereAlphaAttr);
    this.sphereGeom.setAttribute('aColor', this.sphereColorAttr);
    this.finiteCylinderAlphaAttr = new THREE.InstancedBufferAttribute(this.finiteCylinderAlphaArr, 1);
    this.finiteCylinderAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.finiteCylinderColorAttr = new THREE.InstancedBufferAttribute(this.finiteCylinderColorArr, 3);
    this.finiteCylinderColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.finiteCylinderGeom.setAttribute('aAlpha', this.finiteCylinderAlphaAttr);
    this.finiteCylinderGeom.setAttribute('aColor', this.finiteCylinderColorAttr);

    // Materials Are Independent Of Shape: same material as the flat-panel
    // shield surface, just carried by field geometry here.
    this.sphereInstancedMat = createShieldSurfaceMaterial();
    this.finiteCylinderInstancedMat = createShieldSurfaceMaterial();
    this.implicitFieldMat = this.createImplicitFieldMaterial();

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

    this.finiteCylinderInstancedMesh = new THREE.InstancedMesh(
      this.finiteCylinderGeom,
      this.finiteCylinderInstancedMat,
      SPHERE_INSTANCED_CAP,
    );
    this.finiteCylinderInstancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.finiteCylinderInstancedMesh.count = 0;
    this.finiteCylinderInstancedMesh.frustumCulled = false;
    this.finiteCylinderInstancedMesh.renderOrder = 7;
    this.root.add(this.finiteCylinderInstancedMesh);

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
    return new THREE.ShaderMaterial({
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
    this._finiteCylinderCursor = 0;
    this._implicitFieldCursor = 0;
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
    this.finiteCylinderInstancedMesh.count = this._finiteCylinderCursor;
    if (this._finiteCylinderCursor > 0) {
      this.finiteCylinderInstancedMesh.instanceMatrix.clearUpdateRanges();
      this.finiteCylinderInstancedMesh.instanceMatrix.addUpdateRange(0, this._finiteCylinderCursor * 16);
      this.finiteCylinderInstancedMesh.instanceMatrix.needsUpdate = true;
      this.finiteCylinderAlphaAttr.clearUpdateRanges();
      this.finiteCylinderAlphaAttr.addUpdateRange(0, this._finiteCylinderCursor);
      this.finiteCylinderAlphaAttr.needsUpdate = true;
      this.finiteCylinderColorAttr.clearUpdateRanges();
      this.finiteCylinderColorAttr.addUpdateRange(0, this._finiteCylinderCursor * 3);
      this.finiteCylinderColorAttr.needsUpdate = true;
    }
    this.updateImplicitFieldUniforms();
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

  private finiteCylinderInfinityVisualHeight(outer: number): number {
    // Same strategy as BeamRenderer3D's open-ended beam visual: finite
    // geometry is stretched past the visible world. The gameplay shield
    // stays mathematically infinite in the sim; this only prevents the
    // fallback mesh from visibly ending in the sky or below the world.
    const cameraFar = Number.isFinite(this.camera.far) && this.camera.far > 0
      ? this.camera.far
      : FINITE_CYLINDER_INFINITY_VISUAL_MIN_HALF_HEIGHT;
    const halfHeight = Math.max(
      FINITE_CYLINDER_INFINITY_VISUAL_MIN_HALF_HEIGHT,
      cameraFar,
      outer * 10,
    );
    return halfHeight * 2;
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
    const shape = packet.shape[row];
    if (
      SHIELD_SURFACE_RENDER_MODE === 'screen-space-analytic-shader' &&
      shape !== FIELD_SHAPE_AIMED_CYLINDER
    ) {
      if (this._implicitFieldCursor < IMPLICIT_FIELD_CAP) {
        const cursor = this._implicitFieldCursor;
        this.implicitFieldData[cursor].set(
          this._sphereScratchPos.x,
          this._sphereScratchPos.y,
          this._sphereScratchPos.z,
          shape === FIELD_SHAPE_SPHERE ? outer : -outer,
        );
        writeHexAlphaToVector4(packet.color[row], alpha, this.implicitFieldStyle[cursor]);
        this._implicitFieldCursor++;
      }
      return;
    }

    if (shape === FIELD_SHAPE_AIMED_CYLINDER) {
      if (this._finiteCylinderCursor < SPHERE_INSTANCED_CAP) {
        this._cylinderTargetPos.set(
          packet.targetX[row],
          packet.targetZ[row],
          packet.targetY[row],
        );
        this._cylinderDir
          .copy(this._cylinderTargetPos)
          .sub(this._sphereScratchPos);
        const axisLength = this._cylinderDir.length();
        if (axisLength <= 1e-3) return;
        this._cylinderDir.multiplyScalar(1 / axisLength);
        this._cylinderMidPos.copy(this._sphereScratchPos);
        this._cylinderQuat.setFromUnitVectors(
          ShieldRenderer3D._SPHERE_UP,
          this._cylinderDir,
        );
        this._sphereScratchScale.set(
          outer,
          this.finiteCylinderInfinityVisualHeight(outer),
          outer,
        );
        this._sphereScratchMat.compose(
          this._cylinderMidPos,
          this._cylinderQuat,
          this._sphereScratchScale,
        );
        this.finiteCylinderInstancedMesh.setMatrixAt(
          this._finiteCylinderCursor,
          this._sphereScratchMat,
        );
        this.finiteCylinderAlphaArr[this._finiteCylinderCursor] = alpha;
        writeHexToRgb01Array(
          packet.color[row],
          this.finiteCylinderColorArr,
          this._finiteCylinderCursor * 3,
        );
        this._finiteCylinderCursor++;
      }
      return;
    }

    if (shape === FIELD_SHAPE_INFINITE_VERTICAL_CYLINDER) {
      if (this._finiteCylinderCursor < SPHERE_INSTANCED_CAP) {
        this._sphereScratchScale.set(
          outer,
          this.finiteCylinderInfinityVisualHeight(outer),
          outer,
        );
        this._sphereScratchMat.compose(
          this._sphereScratchPos,
          ShieldRenderer3D._IDENTITY_QUAT,
          this._sphereScratchScale,
        );
        this.finiteCylinderInstancedMesh.setMatrixAt(
          this._finiteCylinderCursor,
          this._sphereScratchMat,
        );
        this.finiteCylinderAlphaArr[this._finiteCylinderCursor] = alpha;
        writeHexToRgb01Array(
          packet.color[row],
          this.finiteCylinderColorArr,
          this._finiteCylinderCursor * 3,
        );
        this._finiteCylinderCursor++;
      }
      return;
    }

    if (this._sphereCursor < SPHERE_INSTANCED_CAP) {
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
    this.root.remove(this.finiteCylinderInstancedMesh);
    this.root.remove(this.implicitFieldMesh);
    this.sphereInstancedMesh.dispose();
    this.finiteCylinderInstancedMesh.dispose();
    this.implicitFieldMesh.geometry.dispose();
    this.sphereInstancedMat.dispose();
    this.finiteCylinderInstancedMat.dispose();
    this.implicitFieldMat.dispose();
    this.sphereGeom.dispose();
    this.finiteCylinderGeom.dispose();
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
