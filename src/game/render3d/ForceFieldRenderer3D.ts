// ForceFieldRenderer3D — 3D visualization for force-field turrets.
//
// A force-field turret uses the `complexSingleEmitter` barrel type and carries
// a `ForceShot` (shot.type === 'force') configured with a barrier sphere.
// It animates per-tick via `turret.forceField.range` (0 → 1 progress).
//
// Rendering tiers (driven by gfx.forceFieldStyle):
//   minimal / simple / normal — translucent bubble + pulsing emitter only.
//   enhanced (MAX LOD) — adds two perpendicular slow-rotating orbital
//   rings just inside the bubble, like a gyroscope. The rings give the
//   field a sense of internal structure / mechanical stabilization
//   without the visual noise of the old radial particle motes and
//   crackling arcs (those were removed — the bubble alone reads better
//   at every tier and the rings stay calm at MAX).

import * as THREE from 'three';
import type { Entity, EntityId, Turret } from '../sim/types';
import { getPlayerPrimaryColor } from '../sim/types';
import { getChassisLiftY } from '../math/BodyDimensions';
import { getUnitBlueprint } from '../sim/blueprints';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';
import { getGraphicsConfig, getGraphicsConfigFor } from '@/clientBarConfig';
import { FORCE_FIELD_VISUAL } from '../../config';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { GraphicsConfig } from '@/types/graphics';
import type { Lod3DState } from './Lod3D';
import { objectLodToGraphicsTier, type RenderObjectLodTier } from './RenderObjectLod';
import { RenderLodGrid } from './RenderLodGrid';

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

// Opacity multiplier on top of barrier.alpha so the field reads more
// solid in 3D than the 2D translucent fill. Applied to the bubble and
// the MAX-tier rings.
const FIELD_OPACITY_BOOST = 2.0;

// MAX-tier orbital rings — cosmetic ornament that signals "this field
// is actively running" without adding any moving particles or random
// flicker. Two rings, perpendicular planes, slowly rotating at
// different rates. Tube radius is a fraction of the ring's orbit
// radius so the rings stay visually thin at every bubble size.
const RING_RADIUS_FRAC = 0.92;     // ring orbit radius = outer × this
const RING_TUBE_FRAC = 0.018;      // tube radius = orbit radius × this
const RING_ALPHA_MULT = 0.85;      // multiplied with barrier.alpha × FIELD_OPACITY_BOOST
const RING_ROT_RATE_A = 0.45;      // rad/s, ring 1
const RING_ROT_RATE_B = 0.30;      // rad/s, ring 2 (different so the two never lock)

function isForceFieldTurret(t: Turret): boolean {
  return (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
}

type FieldMesh = {
  // Emitter + zone are NEVER rendered — they're invisible per-field
  // data anchors that:
  //   (1) the MAX-tier ring lazy-alloc path uses to find the field's
  //       host parent (`field.emitter.parent ?? this.root`) so newly-
  //       created rings attach to the right yawGroup;
  //   (2) keep the parent-identity check in _processUnit cheap
  //       (`field.emitter.parent !== yawGroup` triggers a reparent
  //       when LOD rebuilds give the unit a new yawGroup).
  // The actual emitter + zone visuals come from the shared
  // `sphereInstancedMesh` — per-frame we write transient slots for
  // each active field, so what's drawn is one InstancedMesh draw call
  // for every emitter+zone in the scene instead of two Meshes per field.
  emitter: THREE.Mesh;
  emitterMat: THREE.MeshBasicMaterial;
  zone: THREE.Mesh;
  zoneMat: THREE.MeshBasicMaterial;
  // MAX-tier orbital rings. Lazy-allocated to two THREE.Mesh on first
  // 'enhanced' frame; both share the renderer-owned ringGeom / ringMat
  // (cheaper than per-field materials since every ring renders in the
  // same field color the bubble already uses — the InstancedMesh slot
  // for the bubble drives that color, the ring's MeshBasicMaterial just
  // tracks it).
  ringA?: THREE.Mesh;
  ringB?: THREE.Mesh;
  ringMat?: THREE.MeshBasicMaterial;
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

function resolveForceFieldColor(playerId: number | undefined, fallbackColor: number): number {
  return FORCE_FIELD_VISUAL.colorMode === 'player'
    ? getPlayerPrimaryColor(playerId)
    : fallbackColor;
}

// Shader for the sphereInstanced pool — same shape as
// SmokeTrail3D / Explosion3D / SprayRenderer3D. Per-instance `aAlpha`
// + `aColor` ride on InstancedBufferAttributes; the fragment is just
// `vec4(vColor, vAlpha)`. Both emitter and zone use this shader: the
// emitter writes alpha=1 with a pulsing team color, the zone writes
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
 *  above any realistic concurrent count (typical scenes have at most
 *  a few dozen active force fields). */
const SPHERE_INSTANCED_CAP = 512;

export class ForceFieldRenderer3D {
  private root: THREE.Group;
  // Unit sphere reused for the bubble and the emitter (both write
  // into the shared sphereInstancedMesh below).
  private sphereGeom = new THREE.SphereGeometry(1, 20, 14);
  // Unit-radius torus for MAX-tier orbital rings. Tube radius is set
  // to RING_TUBE_FRAC so the ring scale we apply per frame controls the
  // overall ring orbit radius; the tube stays proportional.
  private ringGeom = new THREE.TorusGeometry(1, RING_TUBE_FRAC, 8, 64);
  private fields = new Map<FieldKey, FieldMesh>();

  /** Shared InstancedMesh covering every emitter + zone sphere across
   *  every active force field on the map. Slots are allocated TRANSIENT
   *  per frame: walk active fields, write [0, count). count is set
   *  to the live prefix at end-of-frame so off-screen / inactive fields
   *  cost zero GPU time.
   *
   *  Particles, trails, and arcs (LOD-only) are not instanced here —
   *  they stay per-Mesh on FieldMesh, allocated lazily on first
   *  enhanced/simple-LOD render. The win for the always-rendered
   *  emitter+zone alone is meaningful on its own (every active force
   *  field is 2 draws today; this collapses them all to 1). */
  private sphereInstancedMesh: THREE.InstancedMesh;
  private sphereInstancedMat: THREE.ShaderMaterial;
  private sphereAlphaArr = new Float32Array(SPHERE_INSTANCED_CAP);
  private sphereColorArr = new Float32Array(SPHERE_INSTANCED_CAP * 3);
  private sphereAlphaAttr: THREE.InstancedBufferAttribute;
  private sphereColorAttr: THREE.InstancedBufferAttribute;
  /** Per-frame transient slot cursor — reset in beginFrame, advanced
   *  per emitter + per zone in _processUnit, used as the count at
   *  end-of-frame. */
  private _sphereCursor = 0;
  /** Scratch matrices for the emitter+zone instance write. Same
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
  /** Reused across `update()` calls to track which fields are still
   *  active this frame (everything not in here gets pruned). Allocating
   *  a fresh Set per frame is wasted GC pressure — clear-and-reuse. */
  private _seenFieldKeys = new Set<FieldKey>();
  /** RENDER: WIN/PAD/ALL visibility scope — off-screen force fields
   *  skip their per-frame animation work. */
  private scope: ViewportFootprint;
  private ownedLodGrid = new RenderLodGrid();
  private frameLodGrid = this.ownedLodGrid;
  private lodActive = false;
  private frameGfx: GraphicsConfig = getGraphicsConfig();
  /** Look up the unit's yaw subgroup. Force-field meshes attach to
   *  this group like a regular turret root — the scenegraph chain
   *  (group → yawGroup → field meshes) handles position, tilt, and
   *  yaw automatically, so the field stays glued to its host through
   *  every kind of motion the unit can do. Returns undefined when
   *  the unit's mesh hasn't been built yet (off-scope at scene
   *  start) or was torn down (LOD flip mid-frame); we skip the field
   *  for that frame and re-acquire when the mesh is back. */
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

    // Build the shared emitter+zone InstancedMesh. Same construction
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
      side: THREE.DoubleSide,  // zone bubble visible from inside too
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
    // the zone bubble's translucency composites on top of smoke
    // particles passing through it.
    this.sphereInstancedMesh.renderOrder = 7;
    this.root.add(this.sphereInstancedMesh);
  }

  private acquire(key: FieldKey): FieldMesh {
    const existing = this.fields.get(key);
    if (existing) return existing;
    // Emitter + zone are invisible parent-anchor Meshes (see FieldMesh
    // doc). They cost zero rasterized pixels but keep the parent-
    // tracking path that the MAX-tier ring lazy-alloc reads working.
    const emitterMat = new THREE.MeshBasicMaterial({ visible: false });
    const emitter = new THREE.Mesh(this.sphereGeom, emitterMat);
    emitter.visible = false;
    this.root.add(emitter);
    const zoneMat = new THREE.MeshBasicMaterial({ visible: false });
    const zone = new THREE.Mesh(this.sphereGeom, zoneMat);
    zone.visible = false;
    this.root.add(zone);

    const field: FieldMesh = {
      emitter, emitterMat,
      zone, zoneMat,
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
    const unitRadius = unitData.bodyRadius;
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

  /** Reparent every mesh in a FieldMesh from its current parent (the
   *  renderer's `root` group on first frame, or the previous host's
   *  yawGroup after a LOD-flip rebuild) onto `target` (the current
   *  host's yawGroup). MAX-tier rings are lazy-allocated so they may
   *  not exist yet — newly-allocated rings inside ensureRings parent
   *  to `field.emitter.parent` (which by then equals `target`), so they
   *  land in the right group from birth. */
  private reparentFieldTo(field: FieldMesh, target: THREE.Group): void {
    const move = (m: THREE.Object3D | undefined): void => {
      if (!m) return;
      if (m.parent === target) return;
      m.parent?.remove(m);
      target.add(m);
    };
    move(field.emitter);
    move(field.zone);
    move(field.ringA);
    move(field.ringB);
  }

  /** Lazily allocate the two MAX-tier orbital ring meshes. They share
   *  a per-field MeshBasicMaterial so a single .color set per frame
   *  drives both rings. */
  private ensureRings(field: FieldMesh): void {
    if (field.ringA && field.ringB && field.ringMat) return;
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const ringA = new THREE.Mesh(this.ringGeom, ringMat);
    const ringB = new THREE.Mesh(this.ringGeom, ringMat);
    ringA.frustumCulled = false;
    ringB.frustumCulled = false;
    ringA.renderOrder = 8;
    ringB.renderOrder = 8;
    const parent = field.emitter.parent ?? this.root;
    parent.add(ringA);
    parent.add(ringB);
    field.ringA = ringA;
    field.ringB = ringB;
    field.ringMat = ringMat;
  }

  // Per-frame state computed in beginFrame(), read in perUnit(),
  // cleaned up in endFrame(). The fused-iteration entry points let
  // RtsScene3D walk units once and dispatch into multiple per-unit
  // renderers, instead of each renderer doing its own iteration.
  private _frameNowMs = 0;
  private _frameNowSec = 0;
  private _frameWantRings = false;

  /** Begin a fused per-frame iteration. Caller follows with a series
   *  of perUnit calls and finishes with endFrame. */
  beginFrame(
    graphicsConfig: GraphicsConfig = getGraphicsConfig(),
    lod?: Lod3DState,
    sharedLodGrid?: RenderLodGrid,
  ): void {
    this._seenFieldKeys.clear();
    this._sphereCursor = 0;
    this._frameNowMs = performance.now();
    this._frameNowSec = this._frameNowMs / 1000;
    const gfx = graphicsConfig;
    this.frameGfx = gfx;
    this.lodActive = lod !== undefined;
    this.frameLodGrid = sharedLodGrid ?? this.ownedLodGrid;
    if (lod) {
      if (!sharedLodGrid) this.frameLodGrid.beginFrame(lod.view, gfx);
    }
    // Only the MAX-tier 'enhanced' style draws the orbital rings. The
    // bubble + emitter render at every tier through the
    // sphereInstancedMesh slots written in _processUnit.
    this._frameWantRings = gfx.forceFieldStyle === 'enhanced';
  }

  /** Process one unit. Same body the previous monolithic update()
   *  ran inside its for-of loop — extracted so RtsScene3D can dispatch
   *  here from a single fused unit walk. */
  perUnit(unit: Entity): void {
    if (!unit.turrets || !unit.unit) return;
    // Force-field bubbles can be large (up to ~barrier.outerRange
    // units across), so pad generously so a turret just off-screen
    // with its bubble reaching in still updates.
    if (!this.scope.inScope(unit.transform.x, unit.transform.y, 300)) return;
    // Force fields render at every camera-sphere band, including the
    // farthest 'marker' tier. The fill is gameplay-relevant
    // information (it tells the player there's a force-field barrier there),
    // not just decoration — bailing at marker made distant fields
    // pop in and out as the camera moved. The graphics-tier mapping
    // below clamps style to 'minimal' (faint fill only) at marker
    // distance, so the cost stays low.
    const objectTier = this.resolveUnitObjectLod(unit);
    this._processUnit(unit, objectTier);
  }

  private resolveUnitObjectLod(unit: Entity): RenderObjectLodTier {
    if (!this.lodActive) return 'rich';
    return this.frameLodGrid.resolve(
      unit.transform.x,
      unit.transform.z,
      unit.transform.y,
    );
  }

  /** End a fused-iteration frame: tear down fields that didn't get
   *  visited (unit despawned, force-field disabled, or off-scope).
   *  Was the second half of the original update(); same logic. */
  endFrame(): void {
    // Flush the sphereInstancedMesh — count rides on the cursor we
    // advanced per emitter+zone write in _processUnit, so off-scope
    // fields cost zero GPU time. Idle force-field turrets still draw
    // their small emitter sphere.
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
    // Tear down per-field state for fields that didn't get visited
    // this frame (unit despawned, force-field disabled, off-scope).
    const seen = this._seenFieldKeys;
    for (const [key, field] of this.fields) {
      if (seen.has(key)) continue;
      field.emitter.parent?.remove(field.emitter);
      field.zone.parent?.remove(field.zone);
      field.ringA?.parent?.remove(field.ringA);
      field.ringB?.parent?.remove(field.ringB);
      field.emitterMat.dispose();
      field.zoneMat.dispose();
      field.ringMat?.dispose();
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

  /** Internal per-unit body, extracted from the previous monolithic
   *  update(). Reads frame state set by beginFrame(). */
  private _processUnit(unit: Entity, objectTier?: RenderObjectLodTier): void {
    const seen = this._seenFieldKeys;
    const nowSec = this._frameNowSec;
    const resolvedTier = objectTier ?? this.resolveUnitObjectLod(unit);
    // Intentionally render at marker tier too — see perUnit() comment.
    const effectiveGraphicsTier = objectLodToGraphicsTier(resolvedTier, this.frameGfx.tier);
    const fieldGfx = this.lodActive ? getGraphicsConfigFor(effectiveGraphicsTier) : this.frameGfx;
    const wantRings = this.lodActive
      ? fieldGfx.forceFieldStyle === 'enhanced'
      : this._frameWantRings;

    // Sanity guard — perUnit already filtered, but check again so
    // _processUnit is safe to call directly. Any of these mean
    // "nothing to do for this unit" (bail without writing).
    if (!unit.turrets || !unit.unit) return;
    if (!this.scope.inScope(unit.transform.x, unit.transform.y, 300)) return;
    // Force-field meshes attach to the unit's yaw subgroup like a
    // regular turret root — the scenegraph chain (group → yawGroup →
    // field meshes) handles position + tilt + yaw automatically. If
    // the unit's mesh hasn't been built yet (off-scope at scene
    // start) or was torn down (LOD flip mid-frame), the bubble +
    // emitter still draw via the absolute-world InstancedMesh path
    // below; only the MAX-tier rings (per-Mesh, parent-anchored) are
    // gated on yawGroup.
    const yawGroup = this.getYawGroup(unit.id);

      for (let ti = 0; ti < unit.turrets.length; ti++) {
        const turret = unit.turrets[ti];
        if (!isForceFieldTurret(turret)) continue;
        const progress = turret.forceField?.range ?? 0;

        const shot = turret.config.shot;
        if (shot.type !== 'force' || !shot.barrier) continue;
        const fieldColor = resolveForceFieldColor(
          unit.ownership?.playerId,
          shot.barrier.color ?? FORCE_FIELD_VISUAL.fallbackColor,
        );

        const key = forceFieldKey(unit.id, ti);
        seen.add(key);
        const field = this.acquire(key);
        this.updateMountCache(field, unit, turret);

        // Chassis-local mount position. Force-field emitters are their
        // visible turret body, and their pivot comes directly from the
        // unit blueprint's authored 3D turret mount.
        //
        // turret.mount is already in world units, baked from the unit
        // blueprint's 3D mount at unit-creation time. yawGroup has scale
        // 1, so these chassis-local coords write straight into emitter /
        // zone / particle / arc positions and the scenegraph chain
        // places them in world.
        const localX = field.localX;
        const localY = field.localY;
        const localZ = field.localZ;

        // Reparent every field mesh to the unit's yawGroup if not
        // already there — handles first-frame attachment AND LOD
        // rebuilds (which create a new yawGroup and would leave the
        // field stranded on the old one). Cheap when steady state:
        // one identity check per mesh per frame. Emitter + zone are
        // invisible data anchors used here as the parent-tracking
        // pivot for particles / trails / arcs (they all live under
        // `field.emitter.parent` so the lazy-alloc path attaches new
        // motes to the right yawGroup); the actual emitter+zone
        // visuals come from sphereInstancedMesh below.
        if (yawGroup && field.emitter.parent !== yawGroup) {
          this.reparentFieldTo(field, yawGroup);
        }

        // Central pulsing emitter sphere: lerp idle color -> field color. It stays
        // visible while idle so force-field turrets read as physical
        // parts of the unit; the larger translucent field shell below
        // is still gated by active progress.
        const freq = (Math.PI * 2) / (shot.transitionTime / 1000);
        const pulse = Math.sin(nowSec * freq) * 0.5 + 0.5;
        const idleColor = FORCE_FIELD_VISUAL.emitterIdleColor;
        const er =
          ((idleColor >> 16) & 0xff)
          + (((fieldColor >> 16) & 0xff) - ((idleColor >> 16) & 0xff)) * pulse;
        const eg =
          ((idleColor >> 8) & 0xff)
          + (((fieldColor >> 8) & 0xff) - ((idleColor >> 8) & 0xff)) * pulse;
        const eb =
          (idleColor & 0xff)
          + ((fieldColor & 0xff) - (idleColor & 0xff)) * pulse;
        const emitterVisualProgress = Math.max(progress, 0.3);
        const emitterRadius = EMITTER_BASE_RADIUS
          + (EMITTER_MAX_RADIUS - EMITTER_BASE_RADIUS) * emitterVisualProgress;

        // Compose the field's WORLD position from the unit's parent
        // chain — group → realYawGroup → liftGroup. The InstancedMesh
        // slots live in the renderer's world group (not parented to
        // the unit), so we reproduce what the scenegraph would do for
        // a child of liftGroup at chassis-local (localX, localY,
        // localZ). Same algebra the chassis / head / mirror writers
        // use: `worldPos = groupPos + R(tilt · Ry(yaw)) · (localX,
        // lift + localY, localZ)`.
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
          // group.y = sim altitude - bodyCenterHeight, then add the cached
          // blueprint chassis lift and this turret's chassis-local mount
          // Y. Terrain slope tilt lives only on the rich mesh chain, but
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
          this._sphereYawQuat.setFromAxisAngle(ForceFieldRenderer3D._SPHERE_UP, yaw);
          this._sphereParentQuat.copy(this._sphereYawQuat);
          havePosition = true;

        }

        if (havePosition && this._sphereCursor < SPHERE_INSTANCED_CAP) {
          this._sphereScratchScale.set(emitterRadius, emitterRadius, emitterRadius);
          this._sphereScratchMat.compose(
            this._sphereScratchPos,
            ForceFieldRenderer3D._IDENTITY_QUAT,
            this._sphereScratchScale,
          );
          this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
          this.sphereAlphaArr[this._sphereCursor] = 0.9;
          this.sphereColorArr[this._sphereCursor * 3]     = er / 255;
          this.sphereColorArr[this._sphereCursor * 3 + 1] = eg / 255;
          this.sphereColorArr[this._sphereCursor * 3 + 2] = eb / 255;
          this._sphereCursor++;
        }

        if (progress <= 0) {
          field.zone.visible = false;
          if (field.ringA) field.ringA.visible = false;
          if (field.ringB) field.ringB.visible = false;
          continue;
        }

        // Spherical force-field barrier — scale = outerRange in sim
        // units. Alpha fades in over the first third of progress.
        const barrier = shot.barrier;
        const outer = barrier.outerRange;
        if (outer <= 0) {
          field.zone.visible = false;
          if (field.ringA) field.ringA.visible = false;
          if (field.ringB) field.ringB.visible = false;
          continue;
        }
        const fadeIn = Math.min(progress * 3, 1);

        // Write the zone slot — translucent team-color sphere with
        // fade-in alpha. Reuses the world position computed for the
        // emitter slot above (`_sphereScratchPos`) since emitter and
        // zone are concentric. Skip if we couldn't compose the world
        // position (off-scope unit / missing parent chain).
        if (havePosition && this._sphereCursor < SPHERE_INSTANCED_CAP) {
          this._sphereScratchScale.set(outer, outer, outer);
          this._sphereScratchMat.compose(
            this._sphereScratchPos,
            ForceFieldRenderer3D._IDENTITY_QUAT,
            this._sphereScratchScale,
          );
          this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
          this.sphereAlphaArr[this._sphereCursor] = barrier.alpha * fadeIn * FIELD_OPACITY_BOOST;
          this.sphereColorArr[this._sphereCursor * 3]     = ((fieldColor >> 16) & 0xff) / 255;
          this.sphereColorArr[this._sphereCursor * 3 + 1] = ((fieldColor >>  8) & 0xff) / 255;
          this.sphereColorArr[this._sphereCursor * 3 + 2] = ( fieldColor        & 0xff) / 255;
          this._sphereCursor++;
        }

        // ── MAX-tier orbital rings ──
        // Two thin torus rings centered on the bubble, in perpendicular
        // planes, slowly rotating at different rates. Renders in the
        // unit's yawGroup so chassis tilt + yaw carry through; gated on
        // having a yawGroup so we don't spawn rings on lower-tier units
        // that lack a scenegraph node.
        if (wantRings && yawGroup) {
          this.ensureRings(field);
          const ringA = field.ringA!;
          const ringB = field.ringB!;
          const ringMat = field.ringMat!;
          ringA.visible = true;
          ringB.visible = true;
          ringMat.color.set(fieldColor);
          ringMat.opacity = barrier.alpha * fadeIn * FIELD_OPACITY_BOOST * RING_ALPHA_MULT;

          const ringRadius = outer * RING_RADIUS_FRAC;
          ringA.position.set(localX, localY, localZ);
          ringB.position.set(localX, localY, localZ);
          ringA.scale.set(ringRadius, ringRadius, ringRadius);
          ringB.scale.set(ringRadius, ringRadius, ringRadius);
          // Ring A: torus default plane is XY (axis along +Z). Rotate
          // around the chassis-local up axis (X in three.js sim convention
          // for our parent chain — same convention every other unit-local
          // mesh uses) so it precesses smoothly.
          ringA.rotation.set(0, nowSec * RING_ROT_RATE_A, 0);
          // Ring B: tilt 90° on X so it's in the perpendicular plane,
          // then rotate around its own normal (now Y) at a different rate
          // so the two rings never lock visually.
          ringB.rotation.set(Math.PI / 2, nowSec * RING_ROT_RATE_B, 0);
        } else {
          if (field.ringA) field.ringA.visible = false;
          if (field.ringB) field.ringB.visible = false;
        }
      }
  }

  destroy(): void {
    for (const field of this.fields.values()) {
      field.emitter.parent?.remove(field.emitter);
      field.zone.parent?.remove(field.zone);
      field.ringA?.parent?.remove(field.ringA);
      field.ringB?.parent?.remove(field.ringB);
      field.emitterMat.dispose();
      field.zoneMat.dispose();
      field.ringMat?.dispose();
    }
    this.fields.clear();
    // Tear down the shared emitter+zone InstancedMesh + ring geometry.
    this.root.remove(this.sphereInstancedMesh);
    this.sphereInstancedMesh.dispose();
    this.sphereInstancedMat.dispose();
    this.sphereGeom.dispose();
    this.ringGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
