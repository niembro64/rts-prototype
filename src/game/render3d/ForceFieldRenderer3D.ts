// ForceFieldRenderer3D — 3D visualization for force-field turrets.
//
// A force-field turret uses the `complexSingleEmitter` barrel type and carries
// a `ForceShot` (shot.type === 'force') configured with a barrier sphere.
// It animates per-tick via `turret.forceField.range` (0 → 1 progress).
//
// One look at every LOD tier: a translucent team-color bubble plus a
// small pulsing emitter sphere on the host turret. Per-LOD variation
// would just blink the visuals on/off as the camera moves — the
// minimal / simple / normal / enhanced tiers all render the same.

import * as THREE from 'three';
import type { Entity, EntityId, Turret } from '../sim/types';
import { getPlayerPrimaryColor } from '../sim/types';
import { getChassisLiftY } from '../math/BodyDimensions';
import { getUnitBlueprint } from '../sim/blueprints';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';
import { getGraphicsConfig } from '@/clientBarConfig';
import { FORCE_FIELD_VISUAL } from '../../config';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { GraphicsConfig } from '@/types/graphics';
import { hexToRgb01, writeHexToRgb01Array } from './colorUtils';

/** How far the force-field emitter sphere is embedded into the body
 *  part it's mounted on. Expressed as a chassis-local Y offset added
 *  to the part's top:
 *
 *    insetY = -INSET_BELOW_DOME_FRAC × emitter_max_radius
 *
 *  At 0 the emitter sphere center sits exactly at the dome's top
 *  (bottom hemisphere embedded in the body, top hemisphere above).
 *  Positive values would lift the emitter; negative values sink it
 *  further. We use 0 — half-embedded — which reads as a turret
 *  emitter "sunk into the head" without disappearing entirely. */
const INSET_DEPTH_BELOW_DOME = 0;

const EMITTER_BASE_RADIUS = 4;
const EMITTER_MAX_RADIUS = 10;

// Opacity multiplier on top of barrier.alpha so the bubble reads more
// solid in 3D than the 2D translucent fill.
const FIELD_OPACITY_BOOST = 2.0;

function isForceFieldTurret(t: Turret): boolean {
  return (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
}

type FieldMesh = {
  // Per-field cache. The emitter + bubble visuals are written into the
  // shared `sphereInstancedMesh` slots in the per-frame loop — every
  // active field consumes exactly two instance slots, so the entire
  // force-field layer renders in one draw call regardless of field
  // count. The mount* fields cache the chassis-local mount computation
  // so we only re-derive it when the unit blueprint or mount changes.
  mountUnitType: string | null;
  mountRadius: number;
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

function forceFieldKey(unitId: number, turretIndex: number): FieldKey {
  if (
    turretIndex >= 0 &&
    turretIndex < FIELD_KEY_TURRET_STRIDE &&
    Number.isSafeInteger(unitId)
  ) {
    return unitId * FIELD_KEY_TURRET_STRIDE + turretIndex;
  }
  return `${unitId}-${turretIndex}`;
}

function resolveForceFieldColor(playerId: number | undefined): number {
  return FORCE_FIELD_VISUAL.colorMode === 'player'
    ? getPlayerPrimaryColor(playerId)
    : FORCE_FIELD_VISUAL.fallbackColor;
}

// Shader for the sphereInstanced pool — same shape as
// SmokeTrail3D / Explosion3D / SprayRenderer3D. Per-instance `aAlpha`
// + `aColor` ride on InstancedBufferAttributes; the fragment is just
// `vec4(vColor, vAlpha)`. Both emitter and bubble use this shader: the
// emitter writes alpha=1 with a pulsing team color, the bubble writes
// the same force-field color with the fade-in alpha.
const FIELD_SPHERE_VS = `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`;

const FIELD_SPHERE_FS = `
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha);
}
`;

/** Cap on shared sphere instances. Every active force field consumes
 *  exactly two slots — one for the small pulsing emitter and one for
 *  the translucent bubble. 512 fits ~256 simultaneous fields, well
 *  above any realistic concurrent count. */
const SPHERE_INSTANCED_CAP = 512;

export class ForceFieldRenderer3D {
  private root: THREE.Group;
  // Unit sphere reused for both the bubble and the emitter (both write
  // into the shared sphereInstancedMesh below).
  private sphereGeom = new THREE.SphereGeometry(1, 20, 14);
  private fields = new Map<FieldKey, FieldMesh>();

  /** Shared InstancedMesh covering every emitter + bubble sphere
   *  across every active force field on the map. Slots are allocated
   *  TRANSIENT per frame: walk active fields, write [0, count). count
   *  is set to the live prefix at end-of-frame so off-screen / inactive
   *  fields cost zero GPU time. The whole force-field layer is one
   *  draw call. */
  private sphereInstancedMesh: THREE.InstancedMesh;
  private sphereInstancedMat: THREE.ShaderMaterial;
  private sphereAlphaArr = new Float32Array(SPHERE_INSTANCED_CAP);
  private sphereColorArr = new Float32Array(SPHERE_INSTANCED_CAP * 3);
  private sphereAlphaAttr: THREE.InstancedBufferAttribute;
  private sphereColorAttr: THREE.InstancedBufferAttribute;
  /** Per-frame transient slot cursor — reset in beginFrame, advanced
   *  per emitter + per bubble in _processUnit, used as the count at
   *  end-of-frame. */
  private _sphereCursor = 0;
  /** Scratch matrices for the emitter+bubble instance write. Same
   *  pattern as the chassis pools — compose `T(worldPos) · S(scale)`
   *  per slot, no per-frame allocations. */
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
  /** RENDER: WIN/PAD/ALL visibility scope — off-screen force fields
   *  skip their per-frame animation work. */
  private scope: ViewportFootprint;
  /** Look up the unit's yaw subgroup. Used to compose the field's
   *  world position from the unit's parent-chain (group → realYawGroup
   *  → liftGroup) so the bubble follows chassis tilt + yaw exactly.
   *  Returns undefined when the unit's mesh hasn't been built yet
   *  (off-scope at scene start) or was torn down (LOD flip mid-frame);
   *  in that case we fall back to the unit's transform. */
  private getYawGroup: (eid: EntityId) => THREE.Group | undefined;

  constructor(
    parentWorld: THREE.Group,
    scope: ViewportFootprint,
    getYawGroup: (eid: EntityId) => THREE.Group | undefined,
  ) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope;
    this.getYawGroup = getYawGroup;

    // Build the shared emitter+bubble InstancedMesh. Same construction
    // pattern as SmokeTrail3D / Explosion3D / SprayRenderer3D.
    this.sphereAlphaAttr = new THREE.InstancedBufferAttribute(this.sphereAlphaArr, 1);
    this.sphereAlphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.sphereColorAttr = new THREE.InstancedBufferAttribute(this.sphereColorArr, 3);
    this.sphereColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.sphereGeom.setAttribute('aAlpha', this.sphereAlphaAttr);
    this.sphereGeom.setAttribute('aColor', this.sphereColorAttr);

    this.sphereInstancedMat = new THREE.ShaderMaterial({
      vertexShader: FIELD_SPHERE_VS,
      fragmentShader: FIELD_SPHERE_FS,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,  // bubble visible from inside too
    });

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
  }

  private acquire(key: FieldKey): FieldMesh {
    const existing = this.fields.get(key);
    if (existing) return existing;
    const field: FieldMesh = {
      mountUnitType: null,
      mountRadius: -1,
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

  private updateMountCache(field: FieldMesh, unit: Entity, turret: Turret): void {
    const unitData = unit.unit!;
    const unitRadius = unitData.radius.body;
    const offsetX = turret.mount.x;
    const offsetY = turret.mount.y;
    const mountZ = turret.mount.z;
    const unitType = unitData.unitType;
    let bp;
    try { bp = getUnitBlueprint(unitType); }
    catch { /* keep fallback */ }
    const mountLiftY = getChassisLiftY(bp, unitRadius);
    if (
      field.mountUnitType === unitType &&
      field.mountRadius === unitRadius &&
      field.mountOffsetX === offsetX &&
      field.mountOffsetY === offsetY &&
      field.mountZ === mountZ &&
      field.mountLiftY === mountLiftY
    ) {
      return;
    }

    field.mountUnitType = unitType;
    field.mountRadius = unitRadius;
    field.mountOffsetX = offsetX;
    field.mountOffsetY = offsetY;
    field.mountZ = mountZ;
    field.mountLiftY = mountLiftY;
    field.localX = offsetX;
    field.localY = mountZ - mountLiftY + INSET_DEPTH_BELOW_DOME;
    field.localZ = offsetY;
  }

  // Per-frame state computed in beginFrame(), read in perUnit(),
  // cleaned up in endFrame().
  private _frameNowSec = 0;

  /** Begin a fused per-frame iteration. Caller follows with a series
   *  of perUnit calls and finishes with endFrame. The `graphicsConfig`
   *  argument is currently unused — the bubble + emitter visuals
   *  ignore tier (they read the same at every LOD) — but the parameter
   *  is preserved so existing callers don't need to change shape. */
  beginFrame(_graphicsConfig: GraphicsConfig = getGraphicsConfig()): void {
    this._seenFieldKeys.clear();
    this._sphereCursor = 0;
    this._frameNowSec = performance.now() / 1000;
  }

  /** Process one unit. The fill is gameplay-relevant info (a force
   *  field is a barrier the player needs to see), so we render at
   *  every camera-sphere band — no LOD-driven blink-on/off. */
  perUnit(unit: Entity): void {
    if (!unit.combat || !unit.unit) return;
    // Force-field bubbles can be large (up to ~barrier.outerRange
    // units across), so pad generously so a turret just off-screen
    // with its bubble reaching in still updates.
    if (!this.scope.inScope(unit.transform.x, unit.transform.y, 300)) return;
    this._processUnit(unit);
  }

  /** End a fused-iteration frame: flush the InstancedMesh count + dirty
   *  ranges, then tear down per-field state for fields that didn't get
   *  visited (unit despawned, force-field disabled, off-scope). */
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
    const seen = this._seenFieldKeys;
    for (const [key] of this.fields) {
      if (seen.has(key)) continue;
      this.fields.delete(key);
    }
  }

  /** Legacy all-in-one entry — calls beginFrame / per-unit / endFrame
   *  internally so existing callers don't have to migrate. */
  update(units: readonly Entity[]): void {
    this.beginFrame();
    for (const unit of units) this.perUnit(unit);
    this.endFrame();
  }

  /** Internal per-unit body. Reads frame state set by beginFrame(). */
  private _processUnit(unit: Entity): void {
    const seen = this._seenFieldKeys;
    const nowSec = this._frameNowSec;

    // Sanity guard — perUnit already filtered, but check again so
    // _processUnit is safe to call directly.
    if (!unit.combat || !unit.unit) return;
    if (!this.scope.inScope(unit.transform.x, unit.transform.y, 300)) return;

    // The bubble + emitter are written in absolute world coords below,
    // so they don't need a parent. yawGroup is only consulted to read
    // the unit's parent-chain pose for accurate world-position
    // composition (chassis tilt + yaw); when it's missing we fall
    // back to the unit's transform.
    const yawGroup = this.getYawGroup(unit.id);

    const turrets = unit.combat.turrets;
    for (let ti = 0; ti < turrets.length; ti++) {
      const turret = turrets[ti];
      if (!isForceFieldTurret(turret)) continue;
      const progress = turret.forceField?.range ?? 0;

      const shot = turret.config.shot;
      if (!shot || shot.type !== 'force' || !shot.barrier) continue;
      const fieldColor = resolveForceFieldColor(unit.ownership?.playerId);

      const key = forceFieldKey(unit.id, ti);
      seen.add(key);
      const field = this.acquire(key);
      this.updateMountCache(field, unit, turret);

      // Chassis-local mount position. turret.mount is already in world
      // units, baked from the unit blueprint's 3D mount at unit-creation
      // time. yawGroup has scale 1, so these chassis-local coords write
      // straight into the world-position composition below.
      const localX = field.localX;
      const localY = field.localY;
      const localZ = field.localZ;

      // Central pulsing emitter sphere: lerp idle color → field color
      // on the transition-time sin wave. Stays visible while idle so
      // force-field turrets read as physical parts of the unit; the
      // bubble below is gated by active progress.
      const freq = (Math.PI * 2) / (shot.transitionTime / 1000);
      const pulse = Math.sin(nowSec * freq) * 0.5 + 0.5;
      const idleRgb = hexToRgb01(FORCE_FIELD_VISUAL.emitterIdleColor);
      const fieldRgb = hexToRgb01(fieldColor);
      const er = idleRgb.r + (fieldRgb.r - idleRgb.r) * pulse;
      const eg = idleRgb.g + (fieldRgb.g - idleRgb.g) * pulse;
      const eb = idleRgb.b + (fieldRgb.b - idleRgb.b) * pulse;
      const emitterVisualProgress = Math.max(progress, 0.3);
      const emitterRadius = EMITTER_BASE_RADIUS
        + (EMITTER_MAX_RADIUS - EMITTER_BASE_RADIUS) * emitterVisualProgress;

      // Compose the field's WORLD position from the unit's parent
      // chain — group → realYawGroup → liftGroup. The InstancedMesh
      // slots live in the renderer's world group (not parented to
      // the unit), so we reproduce what the scenegraph would do for
      // a child of liftGroup at chassis-local (localX, localY, localZ).
      const liftGroupNode = yawGroup; // getYawGroup returns liftGroup
      const realYawGroup = liftGroupNode?.parent;
      const groupOuter = realYawGroup?.parent;
      let havePosition = false;
      if (liftGroupNode && realYawGroup && groupOuter) {
        this._sphereYawQuat.setFromAxisAngle(
          ForceFieldRenderer3D._SPHERE_UP,
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
        havePosition = true;
      } else {
        // No liftGroup — unit isn't rendered at rich tier this frame.
        // Rebuild the same base-Y convention Render3DEntities uses:
        // group.y = sim altitude − bodyCenterHeight, then add the
        // cached blueprint chassis lift and this turret's chassis-
        // local mount Y. Slope tilt lives only on the rich mesh chain;
        // yaw and vertical body lift still stay coherent.
        const yaw = unit.transform.rotation;
        const cosYaw = Math.cos(yaw);
        const sinYaw = Math.sin(yaw);
        const rx = cosYaw * localX - sinYaw * localZ;
        const rz = sinYaw * localX + cosYaw * localZ;
        const bodyCenterHeight = getUnitBodyCenterHeight(unit.unit);
        this._sphereScratchPos.set(
          unit.transform.x + rx,
          unit.transform.z - bodyCenterHeight + field.mountLiftY + localY,
          unit.transform.y + rz,
        );
        havePosition = true;
      }

      // Emitter slot (small pulsing sphere, always drawn).
      if (havePosition && this._sphereCursor < SPHERE_INSTANCED_CAP) {
        this._sphereScratchScale.set(emitterRadius, emitterRadius, emitterRadius);
        this._sphereScratchMat.compose(
          this._sphereScratchPos,
          ForceFieldRenderer3D._IDENTITY_QUAT,
          this._sphereScratchScale,
        );
        this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
        this.sphereAlphaArr[this._sphereCursor] = 0.9;
        this.sphereColorArr[this._sphereCursor * 3]     = er;
        this.sphereColorArr[this._sphereCursor * 3 + 1] = eg;
        this.sphereColorArr[this._sphereCursor * 3 + 2] = eb;
        this._sphereCursor++;
      }

      if (progress <= 0) continue;

      // Bubble — translucent team-color sphere with fade-in alpha.
      // The emitter remains mounted at the turret origin; the actual
      // field sphere can be configured lower in world-space so the
      // shield wraps the host body instead of centering on the turret.
      const barrier = shot.barrier;
      const outer = barrier.outerRange;
      if (outer <= 0) continue;
      const fadeIn = Math.min(progress * 3, 1);

      if (havePosition && this._sphereCursor < SPHERE_INSTANCED_CAP) {
        const fieldCenterY = this._sphereScratchPos.y - barrier.originOffsetZ;
        this._sphereScratchScale.set(outer, outer, outer);
        this._sphereScratchPos.y = fieldCenterY;
        this._sphereScratchMat.compose(
          this._sphereScratchPos,
          ForceFieldRenderer3D._IDENTITY_QUAT,
          this._sphereScratchScale,
        );
        this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
        this.sphereAlphaArr[this._sphereCursor] = barrier.alpha * fadeIn * FIELD_OPACITY_BOOST;
        writeHexToRgb01Array(fieldColor, this.sphereColorArr, this._sphereCursor * 3);
        this._sphereCursor++;
      }
    }
  }

  destroy(): void {
    this.fields.clear();
    this.root.remove(this.sphereInstancedMesh);
    this.sphereInstancedMesh.dispose();
    this.sphereInstancedMat.dispose();
    this.sphereGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
