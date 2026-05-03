// ForceFieldRenderer3D — 3D visualization for force-field turrets.
//
// A force-field turret uses the `complexSingleEmitter` barrel type and carries
// a `ForceShot` (shot.type === 'force') configured with push/pull zone ranges.
// It animates per-tick via `turret.forceField.range` (0 → 1 progress).
//
// Rendering tiers (driven by gfx.forceFieldStyle, mirroring the 2D
// ForceFieldEffect contract):
//   minimal — translucent bubble + emitter only.
//   simple  — bubble + emitter + radial particle motes (HI LOD).
//   enhanced — bubble + emitter + particles + electric arcs (MAX LOD).
//
// Particle motes are small bright spheres distributed across the bubble's
// 3D surface that drift radially through the field's depth. Electric arcs
// are short jagged BufferGeometry polylines inside the bubble that
// re-randomize every arcFlickerMs to produce a crackling read.

import * as THREE from 'three';
import type { Entity, EntityId, Turret } from '../sim/types';
import { getBodyMountTopY } from './BodyShape3D';
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

const EMITTER_COLOR_A = 0xf0f0f0;  // idle: white
const EMITTER_COLOR_B = 0x3366ff;  // active: blue
const EMITTER_BASE_RADIUS = 4;
const EMITTER_MAX_RADIUS = 10;

// Per-LOD particle counts. The 3D field has 4π·r² worth of surface area
// vs the 2D ring's 2π·r perimeter, so we emit a bit more than the 2D
// `particleCount` baseline to keep visual density comparable.
const PARTICLE_COUNT_SIMPLE = 28;
const PARTICLE_COUNT_ENHANCED = 56;
const PARTICLE_RADIUS = 1.4;   // world units per mote

// MAX-only particle TRAILS — comet-style ghost segments behind each
// main mote, mirroring the 2D enhanced look (FORCE_FIELD_VISUAL.
// trailSegments = 3, trailFalloff = 0.45 per step). Each trail spans
// trailFrac of the radial band behind its parent mote.
const TRAIL_SEGMENTS = 3;
const TRAIL_FRAC_PER_STEP = 0.045;   // of (outer − inner)
const TRAIL_OPACITY_FALLOFF = 0.5;   // multiplier per successive trail
const TRAIL_SCALE_FALLOFF = 0.75;    // shrink factor per successive trail

// Opacity multiplier on top of push.alpha so the field reads more
// solid in 3D than the 2D translucent fill — applied uniformly to the
// bubble, particles, and arcs. Doubling from 1.0 to 2.0 makes the
// effect twice as opaque visually.
const FIELD_OPACITY_BOOST = 2.0;

// Per-LOD arc counts (enhanced only).
const ARC_COUNT_ENHANCED = 4;

function isForceFieldTurret(t: Turret): boolean {
  return (t.config.barrel as { type?: string } | undefined)?.type === 'complexSingleEmitter';
}

type FieldMesh = {
  // Emitter + zone are NEVER rendered — they're invisible per-field
  // data anchors that:
  //   (1) the particles / trails / arcs lazy-alloc path uses to find
  //       the field's host parent (`field.emitter.parent ?? this.root`),
  //       so newly-created motes attach to the right yawGroup;
  //   (2) keep the parent-identity check in _processUnit cheap
  //       (`field.emitter.parent !== yawGroup` triggers a reparent
  //       when LOD rebuilds give the unit a new yawGroup).
  // The actual emitter + zone visuals come from the shared
  // `sphereInstancedMesh` — per-frame we write transient slots for
  // each active field, so what's drawn is one InstancedMesh draw call
  // for every emitter+zone in the scene instead of two Meshes per
  // field. Visible flag stays false on these — they exist purely to
  // host the particle / trail / arc children.
  emitter: THREE.Mesh;
  emitterMat: THREE.MeshBasicMaterial;
  zone: THREE.Mesh;
  zoneMat: THREE.MeshBasicMaterial;
  // Particle motes. Allocated lazily up to PARTICLE_COUNT_ENHANCED. Per
  // frame we show only the LOD-appropriate prefix.
  particles: THREE.Mesh[];
  particleMat: THREE.MeshBasicMaterial;
  // MAX-only ghost trails behind each particle. Allocated lazily;
  // index = particleIdx × TRAIL_SEGMENTS + trailIdx. Each trail uses
  // its own material because the opacity decays per trail step.
  trailMeshes: THREE.Mesh[];
  trailMats: THREE.MeshBasicMaterial[];
  // Electric arc geometry, allocated only on first 'enhanced' frame.
  arcGeom?: THREE.BufferGeometry;
  arcMat?: THREE.LineBasicMaterial;
  arcLines?: THREE.LineSegments;
  arcLastFlickerMs: number;
  mountUnitType: string | null;
  mountRadius: number;
  mountOffsetX: number;
  mountOffsetY: number;
  mountLiftY: number;
  mountHeadCenterHeightFrac: number;
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

/** Deterministic 0..1 hash used by the particle layout + arc jitter so each
 *  field has stable angular slots without per-frame allocation. Same shape
 *  the 2D effect uses, with an additional seed mixed in. */
function fieldHash(n: number, seed: number): number {
  let h = (n | 0) * 2654435761 + (seed | 0) * 1597334677;
  h = ((h >>> 16) ^ h) * 45679;
  return ((h >>> 16) ^ h) / 4294967296 + 0.5;
}

// Shader for the sphereInstanced pool — same shape as
// SmokeTrail3D / Explosion3D / SprayRenderer3D. Per-instance `aAlpha`
// + `aColor` ride on InstancedBufferAttributes; the fragment is just
// `vec4(vColor, vAlpha)`. Both emitter and zone use this shader: the
// emitter writes alpha=1 with a pulsing white→blue color, the zone
// writes its push.color with the fade-in alpha.
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

/** Cap on shared sphere instances. Each active force field can
 *  consume up to:
 *    - 1 emitter slot (always)
 *    - 1 zone slot (always)
 *    - particleCount (28 / 56) particle slots at HI / MAX LOD
 *    - particleCount × TRAIL_SEGMENTS trail slots at MAX LOD
 *  → up to 1 + 1 + 56 + 168 = 226 slots per field at MAX. Cap of
 *  16384 fits ~72 simultaneous MAX-tier fields, well above any
 *  realistic concurrent count (typical scenes have at most a few
 *  dozen active force fields). HI tier needs 1+1+28 = 30 slots /
 *  field → 540 fields fit. */
const SPHERE_INSTANCED_CAP = 16384;

export class ForceFieldRenderer3D {
  private root: THREE.Group;
  // Unit sphere reused for the bubble, the emitter, and the particle motes.
  private sphereGeom = new THREE.SphereGeometry(1, 20, 14);
  private particleSphereGeom = new THREE.SphereGeometry(1, 6, 4);
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
  private _sphereParticlePos = new THREE.Vector3();
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
    // doc). Allocate cheap MeshBasicMaterials with visible=false so
    // they cost zero rasterized pixels but keep the parent-tracking
    // path in particles / trails / arcs working unchanged.
    const emitterMat = new THREE.MeshBasicMaterial({ visible: false });
    const emitter = new THREE.Mesh(this.sphereGeom, emitterMat);
    emitter.visible = false;
    this.root.add(emitter);
    const zoneMat = new THREE.MeshBasicMaterial({ visible: false });
    const zone = new THREE.Mesh(this.sphereGeom, zoneMat);
    zone.visible = false;
    this.root.add(zone);
    // Bright particle material, additive so motes pop over the bubble.
    // Particles + trails + arcs are still per-Mesh; only emitter +
    // zone visuals moved to the shared InstancedMesh path.
    const particleMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const field: FieldMesh = {
      emitter, emitterMat,
      zone, zoneMat,
      particles: [],
      particleMat,
      trailMeshes: [],
      trailMats: [],
      arcLastFlickerMs: 0,
      mountUnitType: null,
      mountRadius: -1,
      mountOffsetX: NaN,
      mountOffsetY: NaN,
      mountLiftY: NaN,
      mountHeadCenterHeightFrac: NaN,
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
    const offsetX = turret.offset.x;
    const offsetY = turret.offset.y;
    const unitType = unitData.unitType;
    let bp;
    try { bp = getUnitBlueprint(unitType); }
    catch { /* keep fallback */ }
    const mountLiftY = getChassisLiftY(bp, unitRadius);
    const turretIndex = unit.turrets?.indexOf(turret) ?? -1;
    const mountHeadCenterHeightFrac = bp?.turrets[turretIndex]?.headCenterHeightFrac ?? NaN;
    if (
      field.mountUnitType === unitType &&
      field.mountRadius === unitRadius &&
      field.mountOffsetX === offsetX &&
      field.mountOffsetY === offsetY &&
      field.mountLiftY === mountLiftY &&
      Object.is(field.mountHeadCenterHeightFrac, mountHeadCenterHeightFrac)
    ) {
      return;
    }

    const mountTopY = (
      bp?.hideChassis === true &&
      Number.isFinite(mountHeadCenterHeightFrac) &&
      unitData.bodyCenterHeight !== undefined
    )
      ? unitData.bodyCenterHeight - mountLiftY
      : Number.isFinite(mountHeadCenterHeightFrac)
      ? mountHeadCenterHeightFrac * unitRadius
      : getBodyMountTopY(
          bp?.bodyShape ?? {
            kind: 'composite',
            parts: [
              { kind: 'circle', offsetForward: -1.1, radiusFrac: 1.15, yFrac: 1.15 },
              { kind: 'circle', offsetForward: 0.3, radiusFrac: 0.55, yFrac: 0.55 },
            ],
          },
          unitRadius,
          offsetX, offsetY,
        );
    field.mountUnitType = unitType;
    field.mountRadius = unitRadius;
    field.mountOffsetX = offsetX;
    field.mountOffsetY = offsetY;
    field.mountLiftY = mountLiftY;
    field.mountHeadCenterHeightFrac = mountHeadCenterHeightFrac;
    field.localX = offsetX;
    field.localY = mountTopY + INSET_DEPTH_BELOW_DOME;
    field.localZ = offsetY;
  }

  // Particles + trails are no longer per-Mesh — they write into the
  // shared `sphereInstancedMesh` slots in the per-frame loop. The
  // previous ensureParticles / ensureTrails lazy allocators have
  // been removed; FieldMesh.particles / trailMeshes / trailMats stay
  // on the type for one-time cleanup of any pre-instancing-commit
  // leftovers (see the cleanup loop in _processUnit).

  /** Reparent every mesh in a FieldMesh from its current parent (the
   *  renderer's `root` group on first frame, or the previous host's
   *  yawGroup after a LOD-flip rebuild) onto `target` (the current
   *  host's yawGroup). Particles and trails are lazily allocated, so
   *  this iterates the live arrays — newly-allocated meshes inside
   *  ensureParticles / ensureTrails parent to `field.emitter.parent`
   *  (which by then equals `target`), so they land in the right
   *  group from birth. */
  private reparentFieldTo(field: FieldMesh, target: THREE.Group): void {
    const move = (m: THREE.Object3D | undefined): void => {
      if (!m) return;
      if (m.parent === target) return;
      m.parent?.remove(m);
      target.add(m);
    };
    move(field.emitter);
    move(field.zone);
    for (const p of field.particles) move(p);
    for (const tr of field.trailMeshes) move(tr);
    move(field.arcLines);
  }

  /** Lazily allocate the arc LineSegments mesh + supporting buffers. */
  private ensureArcs(field: FieldMesh): void {
    if (field.arcLines) return;
    const v = FORCE_FIELD_VISUAL;
    // 2 endpoints per segment × arcSegments segments × ARC_COUNT vertices,
    // 3 floats each.
    const totalVerts = ARC_COUNT_ENHANCED * v.arcSegments * 2;
    const positions = new Float32Array(totalVerts * 3);
    const arcGeom = new THREE.BufferGeometry();
    arcGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    const arcMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: v.arcOpacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const arcLines = new THREE.LineSegments(arcGeom, arcMat);
    arcLines.renderOrder = 10;
    arcLines.frustumCulled = false;
    // Same parent rule as ensureParticles / ensureTrails — land in the
    // host yawGroup if the field is already attached, otherwise the
    // renderer's root (will be moved on first reparent).
    (field.emitter.parent ?? this.root).add(arcLines);
    field.arcGeom = arcGeom;
    field.arcMat = arcMat;
    field.arcLines = arcLines;
  }

  // Per-frame state computed in beginFrame(), read in perUnit(),
  // cleaned up in endFrame(). The fused-iteration entry points let
  // RtsScene3D walk units once and dispatch into multiple per-unit
  // renderers, instead of each renderer doing its own iteration.
  private _frameNowMs = 0;
  private _frameNowSec = 0;
  private _frameStyle: import('@/types/graphics').FireExplosionStyle | 'minimal' | 'simple' | 'enhanced' = 'minimal';
  private _frameWantParticles = false;
  private _frameWantArcs = false;
  private _frameParticleCount = 0;

  /** Begin a fused per-frame iteration. Caller follows with a series
   *  of perUnit calls and finishes with endFrame. Recomputes LOD-
   *  derived counts once per frame so the inner loop is tight. */
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
    this._frameStyle = gfx.forceFieldStyle as never;
    const style = this._frameStyle as string;
    this._frameWantParticles = style === 'simple' || style === 'enhanced';
    this._frameWantArcs = style === 'enhanced';
    this._frameParticleCount = style === 'enhanced' ? PARTICLE_COUNT_ENHANCED
      : style === 'simple' ? PARTICLE_COUNT_SIMPLE
      : 0;
  }

  /** Process one unit. Same body the previous monolithic update()
   *  ran inside its for-of loop — extracted so RtsScene3D can dispatch
   *  here from a single fused unit walk. */
  perUnit(unit: Entity): void {
    if (!unit.turrets || !unit.unit) return;
    // Force-field bubbles can be large (up to ~push.outerRange
    // units across), so pad generously so a turret just off-screen
    // with its bubble reaching in still updates.
    if (!this.scope.inScope(unit.transform.x, unit.transform.y, 300)) return;
    // Force fields render at every camera-sphere band, including the
    // farthest 'marker' tier. The fill is gameplay-relevant
    // information (it tells the player there's a push field there),
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
    // advanced per emitter+zone write in _processUnit, so off-scope /
    // inactive fields cost zero GPU time.
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
      for (const p of field.particles) p.parent?.remove(p);
      for (const tr of field.trailMeshes) tr.parent?.remove(tr);
      field.arcLines?.parent?.remove(field.arcLines);
      field.emitterMat.dispose();
      field.zoneMat.dispose();
      field.particleMat.dispose();
      for (const tm of field.trailMats) tm.dispose();
      if (field.arcGeom) field.arcGeom.dispose();
      if (field.arcMat) field.arcMat.dispose();
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
   *  update(). Reads frame state set by beginFrame(); the only thing
   *  changed from the original is that the outer for/scope/seen-clear
   *  was lifted up into the begin/perUnit/endFrame trio. */
  private _processUnit(unit: Entity, objectTier?: RenderObjectLodTier): void {
    const seen = this._seenFieldKeys;
    const nowMs = this._frameNowMs;
    const nowSec = this._frameNowSec;
    const resolvedTier = objectTier ?? this.resolveUnitObjectLod(unit);
    // Intentionally render at marker tier too — see perUnit() comment.
    const effectiveGraphicsTier = objectLodToGraphicsTier(resolvedTier, this.frameGfx.tier);
    const fieldGfx = this.lodActive ? getGraphicsConfigFor(effectiveGraphicsTier) : this.frameGfx;
    const style = (this.lodActive ? fieldGfx.forceFieldStyle : this._frameStyle) as string;
    const wantParticles = this.lodActive
      ? style === 'simple' || style === 'enhanced'
      : this._frameWantParticles;
    const wantArcs = this.lodActive
      ? style === 'enhanced'
      : this._frameWantArcs;
    const particleCount = this.lodActive
      ? style === 'enhanced' ? PARTICLE_COUNT_ENHANCED
        : style === 'simple' ? PARTICLE_COUNT_SIMPLE
        : 0
      : this._frameParticleCount;

    // Sanity guard — perUnit already filtered, but check again so
    // _processUnit is safe to call directly. Any of these mean
    // "nothing to do for this unit" (bail without writing).
    if (!unit.turrets || !unit.unit) return;
    if (!this.scope.inScope(unit.transform.x, unit.transform.y, 300)) return;
    // Force-field meshes attach to the unit's yaw subgroup like a
    // regular turret root — the scenegraph chain (group → yawGroup →
    // field meshes) handles position + tilt + yaw automatically. If
    // the unit's mesh hasn't been built yet (off-scope at scene
    // start) or was torn down (LOD flip mid-frame), skip; we'll
    // re-acquire when it's back.
    // yawGroup is the unit's mesh hierarchy node; it only exists for
    // units rendered at the rich tier. Lower tiers (mass / impostor /
    // marker) draw the unit as an instanced sphere with no scenegraph
    // node — but force-field bubbles are gameplay info we want visible
    // regardless of camera distance. The bubble (sphereInstancedMesh
    // slots) doesn't actually need a parent; it's written in absolute
    // world coords. So we proceed even without yawGroup, falling back
    // to the unit's transform for the world position. The persistent
    // particle / trail / arc meshes are gated separately on yawGroup
    // below — they need a parent and only run at simple/enhanced
    // styles anyway.
    const yawGroup = this.getYawGroup(unit.id);

      for (let ti = 0; ti < unit.turrets.length; ti++) {
        const turret = unit.turrets[ti];
        if (!isForceFieldTurret(turret)) continue;
        const progress = turret.forceField?.range ?? 0;
        if (progress <= 0) continue;

        const shot = turret.config.shot;
        if (shot.type !== 'force' || !shot.push) continue;

        const key = forceFieldKey(unit.id, ti);
        seen.add(key);
        const field = this.acquire(key);
        this.updateMountCache(field, unit, turret);

        // Chassis-local mount position. Force-field emitter sphere
        // is positioned to sit ON the body part the chassisMount
        // points at, INSET into it — emitter center at the dome's
        // top so the bottom hemisphere is embedded in the body and
        // the top hemisphere reads as a glowing dome jutting out.
        // (A regular turret head adds +headRadius to lift the
        // sphere clear of the dome; force fields skip that lift on
        // purpose — the "head" of a force-field unit IS the emitter,
        // not a stack of turret + dome.)
        //
        // `getBodyMountTopY(renderer, radius, offsetX, offsetZ)`
        // finds the body part nearest the mount and returns ITS top
        // y in world units — for the widow (arachnid composite) the
        // force-field mount at chassisMount (0.3, 0) lands on the
        // prosoma (front sphere, top y ≈ 1.1·radius), not the
        // taller abdomen. For the daddy (forceField renderer, single
        // circle body) it returns the global topY since there's
        // only one part. Both units get the "inset emitter on top of
        // the body" look from one formula.
        //
        // turret.offset is already in world units (chassisMount.{x,y}
        // × radius, baked at unit-creation time). yawGroup has scale
        // 1, so its local space is in world units relative to the
        // chassis-bottom origin — these chassis-local coords write
        // straight into emitter / zone / particle / arc positions
        // and the scenegraph chain places them in world.
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

        // Central pulsing emitter sphere: lerp white → blue, radius scales with progress.
        const freq = (Math.PI * 2) / (shot.transitionTime / 1000);
        const pulse = (Math.sin(nowSec * freq) * 0.5 + 0.5) * progress;
        const er =
          ((EMITTER_COLOR_A >> 16) & 0xff)
          + (((EMITTER_COLOR_B >> 16) & 0xff) - ((EMITTER_COLOR_A >> 16) & 0xff)) * pulse;
        const eg =
          ((EMITTER_COLOR_A >> 8) & 0xff)
          + (((EMITTER_COLOR_B >> 8) & 0xff) - ((EMITTER_COLOR_A >> 8) & 0xff)) * pulse;
        const eb =
          (EMITTER_COLOR_A & 0xff)
          + ((EMITTER_COLOR_B & 0xff) - (EMITTER_COLOR_A & 0xff)) * pulse;
        const emitterRadius = EMITTER_BASE_RADIUS
          + (EMITTER_MAX_RADIUS - EMITTER_BASE_RADIUS) * progress;

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

          // Write the emitter slot now — opaque white→blue pulse.
          // (Zone slot is written below after we've read shot.push.)
          if (this._sphereCursor < SPHERE_INSTANCED_CAP) {
            this._sphereScratchScale.set(emitterRadius, emitterRadius, emitterRadius);
            this._sphereScratchMat.compose(
              this._sphereScratchPos,
              ForceFieldRenderer3D._IDENTITY_QUAT,
              this._sphereScratchScale,
            );
            this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
            this.sphereAlphaArr[this._sphereCursor] = 0.9; // emitter base opacity
            this.sphereColorArr[this._sphereCursor * 3]     = er / 255;
            this.sphereColorArr[this._sphereCursor * 3 + 1] = eg / 255;
            this.sphereColorArr[this._sphereCursor * 3 + 2] = eb / 255;
            this._sphereCursor++;
          }
        }

        // Spherical force-field zone — scale = outerRange (= push-zone radius
        // in sim units). Alpha fades in over the first third of progress.
        const push = shot.push;
        const outer = push.outerRange;
        const inner = push.innerRange;
        // Chassis-local field center; particles + arcs orbit relative
        // to this. Same coords for emitter / zone / motes / arcs so
        // they all live in the same yawGroup-local frame and the
        // scenegraph chain transforms them together.
        const cx = localX;
        const cy = localY;
        const cz = localZ;
        if (outer <= 0) {
          field.zone.visible = false;
          for (const p of field.particles) p.visible = false;
          if (field.arcLines) field.arcLines.visible = false;
          continue;
        }
        const fadeIn = Math.min(progress * 3, 1);

        // Write the zone slot — translucent push.color sphere with
        // fade-in alpha. Reuses the world position computed for the
        // emitter slot above (`_sphereScratchPos`) since emitter and
        // zone are concentric. Skip if we couldn't compose the world
        // position (off-scope unit / missing parent chain).
        if (havePosition && this.sphereInstancedMesh && this._sphereCursor < SPHERE_INSTANCED_CAP) {
          this._sphereScratchScale.set(outer, outer, outer);
          this._sphereScratchMat.compose(
            this._sphereScratchPos,
            ForceFieldRenderer3D._IDENTITY_QUAT,
            this._sphereScratchScale,
          );
          this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
          this.sphereAlphaArr[this._sphereCursor] = push.alpha * fadeIn * FIELD_OPACITY_BOOST;
          this.sphereColorArr[this._sphereCursor * 3]     = ((push.color >> 16) & 0xff) / 255;
          this.sphereColorArr[this._sphereCursor * 3 + 1] = ((push.color >>  8) & 0xff) / 255;
          this.sphereColorArr[this._sphereCursor * 3 + 2] = ( push.color        & 0xff) / 255;
          this._sphereCursor++;
        }

        // ── Particle motes (HI / MAX LOD) ──
        // Each particle has a stable angular slot on the bubble's surface
        // (random-but-deterministic theta/phi via fieldHash) and a phase
        // that scrolls a radial fraction over time. Inner→outer travel
        // (matches 2D's `pushOutward = false` default — particles head
        // toward the bubble's interior). Particles + trails write into
        // the same shared sphereInstancedMesh as emitter+zone — one
        // shared draw call per frame regardless of LOD.
        if (
          wantParticles
          && particleCount > 0
          && havePosition
          && this.sphereInstancedMesh
        ) {
          const v = FORCE_FIELD_VISUAL;
          const seed = (unit.id * 31 + ti) | 0;
          const speed = v.particleSpeed * (style === 'enhanced' ? 1.5 : 1);
          const radialBand = Math.max(outer - inner, 1);
          // Per-particle alpha + color (constant across particles in
          // the same field this frame; per-particle radial offset
          // changes only the matrix).
          const particleAlpha = push.alpha * 4 * fadeIn * FIELD_OPACITY_BOOST;
          const pColorR = ((push.color >> 16) & 0xff) / 255;
          const pColorG = ((push.color >>  8) & 0xff) / 255;
          const pColorB = ( push.color        & 0xff) / 255;

          for (let pi = 0; pi < particleCount; pi++) {
            if (this._sphereCursor >= SPHERE_INSTANCED_CAP) break;
            // Even-ish distribution on a 2-sphere: theta ∈ [0, 2π),
            // phi via acos(2u − 1) so we don't pole-cluster.
            const theta = fieldHash(pi * 9181, seed) * Math.PI * 2;
            const phi = Math.acos(2 * fieldHash(pi * 5953 + 1, seed) - 1);
            const offset = fieldHash(pi * 2143 + 2, seed);
            const cycle = (nowSec * speed * 0.5 + offset) % 1;
            const rxy = Math.sin(phi);
            const dirX = Math.cos(theta) * rxy;
            const dirY = Math.cos(phi);
            const dirZ = Math.sin(theta) * rxy;
            const radius = inner + radialBand * cycle;

            // World position = field-center-world + R(parentQuat) ·
            // (dirX*r, dirY*r, dirZ*r). The radial offsets are
            // unit-local (so the particle cloud rotates with the
            // unit's yaw / tilt, matching the previous per-Mesh
            // path which was parented to liftGroup).
            this._sphereLocalPos.set(dirX * radius, dirY * radius, dirZ * radius);
            this._sphereLocalPos.applyQuaternion(this._sphereParentQuat);
            this._sphereParticlePos.set(
              this._sphereScratchPos.x + this._sphereLocalPos.x,
              this._sphereScratchPos.y + this._sphereLocalPos.y,
              this._sphereScratchPos.z + this._sphereLocalPos.z,
            );
            this._sphereScratchScale.set(PARTICLE_RADIUS, PARTICLE_RADIUS, PARTICLE_RADIUS);
            this._sphereScratchMat.compose(
              this._sphereParticlePos,
              ForceFieldRenderer3D._IDENTITY_QUAT,
              this._sphereScratchScale,
            );
            this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
            this.sphereAlphaArr[this._sphereCursor] = particleAlpha;
            this.sphereColorArr[this._sphereCursor * 3]     = pColorR;
            this.sphereColorArr[this._sphereCursor * 3 + 1] = pColorG;
            this.sphereColorArr[this._sphereCursor * 3 + 2] = pColorB;
            this._sphereCursor++;

            // Place each ghost trail behind the mote at progressively
            // earlier cycle fractions. Same shared instance pool —
            // trail i for particle pi just takes the next cursor slot.
            // MAX-LOD only (`wantArcs` doubles as "draw trails" since
            // arcs and trails are both enhanced-tier features).
            if (wantArcs) {
              for (let trailIdx = 1; trailIdx <= TRAIL_SEGMENTS; trailIdx++) {
                if (this._sphereCursor >= SPHERE_INSTANCED_CAP) break;
                const trailFrac = ((cycle - TRAIL_FRAC_PER_STEP * trailIdx) + 1) % 1;
                const trailRadius = inner + radialBand * trailFrac;
                this._sphereLocalPos.set(
                  dirX * trailRadius,
                  dirY * trailRadius,
                  dirZ * trailRadius,
                );
                this._sphereLocalPos.applyQuaternion(this._sphereParentQuat);
                this._sphereParticlePos.set(
                  this._sphereScratchPos.x + this._sphereLocalPos.x,
                  this._sphereScratchPos.y + this._sphereLocalPos.y,
                  this._sphereScratchPos.z + this._sphereLocalPos.z,
                );
                const trailScale = PARTICLE_RADIUS * Math.pow(TRAIL_SCALE_FALLOFF, trailIdx);
                this._sphereScratchScale.set(trailScale, trailScale, trailScale);
                this._sphereScratchMat.compose(
                  this._sphereParticlePos,
                  ForceFieldRenderer3D._IDENTITY_QUAT,
                  this._sphereScratchScale,
                );
                this.sphereInstancedMesh.setMatrixAt(this._sphereCursor, this._sphereScratchMat);
                this.sphereAlphaArr[this._sphereCursor] =
                  particleAlpha * Math.pow(TRAIL_OPACITY_FALLOFF, trailIdx);
                this.sphereColorArr[this._sphereCursor * 3]     = pColorR;
                this.sphereColorArr[this._sphereCursor * 3 + 1] = pColorG;
                this.sphereColorArr[this._sphereCursor * 3 + 2] = pColorB;
                this._sphereCursor++;
              }
            }
          }
        }
        // Hide any per-Mesh particle / trail leftover from a previous
        // tier (the InstancedMesh handles all visible particles now;
        // any pre-existing per-Mesh particles are dead and just
        // clutter the scenegraph). The legacy ensure paths are no
        // longer called, but the particles[] / trailMeshes[] arrays
        // could still hold meshes from before this commit landed —
        // this loop is a one-time cleanup that becomes a no-op once
        // the field is rebuilt.
        if (field.particles.length > 0) {
          for (const p of field.particles) {
            p.parent?.remove(p);
            (p.material as THREE.Material).dispose();
          }
          field.particles.length = 0;
        }
        if (field.trailMeshes.length > 0) {
          for (let i = 0; i < field.trailMeshes.length; i++) {
            const tr = field.trailMeshes[i];
            tr.parent?.remove(tr);
            field.trailMats[i]?.dispose();
          }
          field.trailMeshes.length = 0;
          field.trailMats.length = 0;
        }

        // ── Electric arcs (MAX LOD only) ──
        // Short jagged polylines inside the bubble that re-randomize every
        // arcFlickerMs. Each arc is a chain of arcSegments line-segments
        // (LineSegments expects 2 verts per segment, so we emit pairs of
        // [endPrev, endCur] for s ∈ [1, segments]).
        if (wantArcs) {
          this.ensureArcs(field);
          const arcLines = field.arcLines!;
          const arcGeom = field.arcGeom!;
          const arcMat = field.arcMat!;
          arcLines.visible = true;
          arcMat.color.set(push.color);
          arcMat.opacity = FORCE_FIELD_VISUAL.arcOpacity * fadeIn * FIELD_OPACITY_BOOST;
          const v = FORCE_FIELD_VISUAL;
          const flickerSeed = Math.floor(nowMs / v.arcFlickerMs);
          const positions = arcGeom.attributes.position.array as Float32Array;
          const arcBand = Math.max(outer - inner, 1);
          const fieldSeed = (unit.id * 31 + ti + flickerSeed * 137) | 0;

          let writeIdx = 0;
          for (let arc = 0; arc < ARC_COUNT_ENHANCED; arc++) {
            const arcSeed = fieldSeed + arc * 1009;
            // Pick a random axis for the arc (3D direction) and a length
            // along the radial band. Each segment offsets the running
            // endpoint by jitter perpendicular to the axis.
            const axisTheta = fieldHash(arcSeed, 7) * Math.PI * 2;
            const axisPhi = Math.acos(2 * fieldHash(arcSeed, 11) - 1);
            const axRxy = Math.sin(axisPhi);
            const axX = Math.cos(axisTheta) * axRxy;
            const axY = Math.cos(axisPhi);
            const axZ = Math.sin(axisTheta) * axRxy;
            const r0 = inner + arcBand * fieldHash(arcSeed, 17);
            const r1 = inner + arcBand * fieldHash(arcSeed, 23);
            const rStart = Math.min(r0, r1);
            const rEnd   = Math.max(r0, r1);
            const startX = cx + axX * rStart;
            const startY = cy + axY * rStart;
            const startZ = cz + axZ * rStart;
            const endX   = cx + axX * rEnd;
            const endY   = cy + axY * rEnd;
            const endZ   = cz + axZ * rEnd;

            let prevX = startX, prevY = startY, prevZ = startZ;
            for (let s = 1; s <= v.arcSegments; s++) {
              const t = s / v.arcSegments;
              const baseX = startX + (endX - startX) * t;
              const baseY = startY + (endY - startY) * t;
              const baseZ = startZ + (endZ - startZ) * t;
              // Bell-shaped jitter: 0 at endpoints, max in the middle.
              const bell = Math.sin(t * Math.PI);
              const j1 = (fieldHash(arcSeed, 100 + s) - 0.5) * 2 * v.arcJitter * bell;
              const j2 = (fieldHash(arcSeed, 200 + s) - 0.5) * 2 * v.arcJitter * bell;
              // Two perpendicular axes to the arc: pick world up cross axis,
              // then axis cross that, normalized. Cheap-but-stable basis.
              let perp1X = -axZ, perp1Y = 0, perp1Z = axX;
              const perp1Len = Math.hypot(perp1X, perp1Y, perp1Z) || 1;
              perp1X /= perp1Len; perp1Z /= perp1Len;
              const perp2X = axY * perp1Z - axZ * perp1Y;
              const perp2Y = axZ * perp1X - axX * perp1Z;
              const perp2Z = axX * perp1Y - axY * perp1X;
              const px = baseX + perp1X * j1 + perp2X * j2;
              const py = baseY + perp1Y * j1 + perp2Y * j2;
              const pz = baseZ + perp1Z * j1 + perp2Z * j2;

              positions[writeIdx++] = prevX; positions[writeIdx++] = prevY; positions[writeIdx++] = prevZ;
              positions[writeIdx++] = px;    positions[writeIdx++] = py;    positions[writeIdx++] = pz;
              prevX = px; prevY = py; prevZ = pz;
            }
          }
          // Zero-fill any unused trailing buffer space (defensive — count
          // is fixed so this is a no-op in steady state).
          for (let i = writeIdx; i < positions.length; i++) positions[i] = 0;
          arcGeom.attributes.position.needsUpdate = true;
          field.arcLastFlickerMs = nowMs;
        } else if (field.arcLines) {
          field.arcLines.visible = false;
        }
      }
  }

  destroy(): void {
    for (const field of this.fields.values()) {
      field.emitter.parent?.remove(field.emitter);
      field.zone.parent?.remove(field.zone);
      for (const p of field.particles) p.parent?.remove(p);
      for (const tr of field.trailMeshes) tr.parent?.remove(tr);
      field.arcLines?.parent?.remove(field.arcLines);
      field.emitterMat.dispose();
      field.zoneMat.dispose();
      field.particleMat.dispose();
      for (const tm of field.trailMats) tm.dispose();
      if (field.arcGeom) field.arcGeom.dispose();
      if (field.arcMat) field.arcMat.dispose();
    }
    this.fields.clear();
    // Tear down the shared emitter+zone InstancedMesh.
    this.root.remove(this.sphereInstancedMesh);
    this.sphereInstancedMesh.dispose();
    this.sphereInstancedMat.dispose();
    this.sphereGeom.dispose();
    this.particleSphereGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
