// GroundPrint3D — wheel ruts, tread tracks, and footstep stamps drawn
// onto the ground as fading quads draped over the terrain (each vertex's
// Y is sampled from the surface under its own x/z). Leg stamps use a
// small shader mask so their underlying quads read as circular ground
// prints.
//
// Rewrite goals (vs. the original frame-skip design):
//
// 1. NO GAPS. Trails are continuous. We sample every
//    contact every frame and emit a new quad as soon as the contact
//    has moved by `spacing` world units since the last emit. The new
//    quad spans `lastEmit → current` exactly, so segments butt
//    edge-to-edge no matter how fast the unit is moving or how few
//    quads-per-second we end up emitting.
//
// 2. NO MISSED FOOTPRINTS. Leg stamps are emitted on the planted-
//    unplanted → planted transition, so every
//    plant cycle stamps exactly once. No frame-skip can drop a
//    plant — we read every frame and look for the edge.
//
// 3. NO CULL. Marks die only when their lifetime expires.
//
// 4. SPACING + LIFETIME are driven by one density knob:
//      - emit spacing  (fewer marks per unit distance, but always continuous)
//      - per-mark lifetime (natural active-count throttle without an explicit cap)
//
// 5. SOFT CAP. There's a hard buffer ceiling (HARD_CAP) for GPU
//    pre-allocation. When it's hit (only at extreme load), we evict
//    the oldest batch of marks to free slots. No emit ever gets
//    dropped on the floor — the cost of overflow is old marks dying
//    early, not a missing rut.
//
// 6. MULTIPLY, DON'T PAINT. Marks darken the lit ground the way
//    compacted soil does, so the terrain's sun shadow survives under
//    the treads; the fade is evaluated on the GPU from each mark's
//    birth time, so a long lifetime costs no per-frame colour rewrite.
//
// 7. EVERY RUNG, EVERY GROUND UNIT. Contact points come from the unit's
//    blueprint layout (GroundPrintLayout3D) placed by its pose, not from
//    the locomotion rig — a proxy-rung unit has no rig, and a rig only
//    ever existed for three of the six ground locomotion types. Real
//    planted feet are still preferred when a rig with legs is drawn, so
//    a footprint sits exactly under the foot up close; without one the
//    layout's stride reproduces the gait's cadence from distance moved.
//
// Per-frame work is bounded: O(units × contacts) for sampling, plus
// O(active marks) for the retirement sweep. Both scale linearly and
// allocate nothing in steady state.

import * as THREE from 'three';
import type { Entity, EntityId } from '../sim/types';
import { IndexedEntityIdSet } from '../network/IndexedEntityIdCollections';
import { COLORS } from '@/colorsConfig';
import { getLocomotionMarks } from '@/clientBarConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { Locomotion3DMesh } from './Locomotion3D';
import {
  resolveGroundPrintLayout,
  type GroundPrintLayout,
  type GroundPrintStampContact,
} from './GroundPrintLayout3D';
import {
  isLocomotionGrounded,
  locomotionTerrainModeForSupportHeight,
  type LocomotionTerrainMode,
} from './LocomotionTerrainSampler';
import { getUnitGroundZ } from '../sim/unitGeometry';
import { disposeMesh } from './threeUtils';
import {
  computeMiteredQuad,
  copyQuadSlot,
  createQuadIndexBuffer,
  writeDrapedQuadEndXZ,
  writeDrapedQuadXZ,
  writeQuadRgba,
  type RibbonQuadCorners,
} from './RibbonTrailBuffer3D';
import {
  createDirtySlotSpan,
  markDirtySlot,
  clearDirtySlotSpan,
  uploadDirtySlotSpan,
} from './instancedBufferUpdate';
import { clamp01 } from '../math';
import { growTypedArrays, nextGeometricCapacity } from '../memory/typedArrayGrowth';

// ── World Y layout ──
// Sit slightly above the terrain surface, sampled per vertex so the
// quads drape over slopes; under burn marks' lift (2.5) so a scorch
// on top of a rut reads correctly.
const MARK_LIFT = 2.4;

// ── Color ──
// Dark soil compaction. Routed through THREE.Color so the hex (sRGB)
// converts to linear-RGB for vertex-color writes. Marks MULTIPLY the
// lit ground rather than painting over it: a print is compacted soil,
// which is darker for the same reason the ground beside it is darker
// in shade, so it must keep the sun shadow that already resolved on
// the terrain under it. Alpha-painting a flat soil colour lightened
// shadowed ground toward the print colour, and every overlapping
// wheel/tread trail under a vehicle pulled it further, until no shadow
// survived beneath the treads. A multiplier keeps the shadow/lit ratio
// under any number of stacked layers.
const PRINT_HEX = COLORS.world.groundPrint.colorHex;
const PRINT_LIN = new THREE.Color(PRINT_HEX);

// ── Lifetime ──
// Each mark carries its own birth time and lifetime; the fade runs in
// the fragment shader against a clock uniform, so a long lifetime costs
// no per-frame colour rewrite. Full strength is held for
// PRINT_HOLD_FRACTION of the life, then the mark eases out. The base
// lifetime scales with density-derived multiplier below.
const PRINT_BASE_LIFETIME_MS = COLORS.world.groundPrint.lifetimeMs;
const PRINT_HOLD_FRACTION = COLORS.world.groundPrint.holdFraction;
const PRINT_INITIAL_ALPHA = COLORS.world.groundPrint.initialAlpha;

const STAMP_CIRCLE_RADIUS_MULT = 1.35;

// At density = 0 lifetime is shrunk to this fraction of the base.
// This drains the buffer about 2.5x faster than full density.
const LIFETIME_MULT_AT_ZERO_DENSITY = 0.4;

// ── Spacing (distance-based emit) ──
// At density = 1 we emit a new quad every SPACING_AT_FULL_DENSITY wu of
// motion (tight ribbons). At density = 0 the spacing relaxes to
// SPACING_AT_ZERO_DENSITY — fewer quads per unit distance but each quad spans
// more, so the trail stays continuous.
const SPACING_AT_FULL_DENSITY = 4;
const SPACING_AT_ZERO_DENSITY = 24;

// ── Stamp dedupe ──
// A leg sometimes "re-plants" within ~a wu of where it took off
// (creep-walking, micro-corrections). Skip the stamp if the new
// plant is within this distance of the previous stamp for the
// SAME foot. Small enough that real strides always pass.
const STAMP_MIN_DIST_SQ = 4;

// ── Buffer ceiling ──
// Hard cap on the GPU-side merged geometry. With a 30 s lifetime a
// large mobile army fills this in heavy traffic, at which point the
// oldest EVICTION_BATCH_FRACTION of the marks are retired in one sweep
// so the following emits allocate O(1) instead of scanning the whole
// buffer per quad.
const HARD_CAP = 32000;
const EVICTION_BATCH_FRACTION = 0.05;
const UNIT_PACKET_INITIAL_CAP = 4096;

// Miter limit — clamp the bisector offset to 3× halfWidth so a
// near-180° turn doesn't produce an infinite spike.
const MITER_LIMIT = 3;

// EMA tau (ms) for smoothing density. ~300 ms matches BurnMark3D so
// the two mark systems glide together.
const DENSITY_EMA_TAU_MS = 300;

// Below this smoothed density we skip the emit pass entirely — no
// new marks until the smoothed value climbs back above. The age
// sweep continues regardless so existing marks fade naturally and
// the buffer drains. Without this floor, density = 0 would still
// emit at SPACING_AT_ZERO_DENSITY intervals.
const EMIT_DENSITY_FLOOR = 0.02;
const CONTACT_KEY_INDEX_STRIDE = 1 << 16;
const CONTACT_KEY_UNIT_STRIDE = CONTACT_KEY_INDEX_STRIDE * 4;
const CONTACT_TYPE_TRAIL = 0;
const CONTACT_TYPE_LEG = 2;

export class GroundPrintRenderPacket3D {
  ids = new Float64Array(UNIT_PACKET_INITIAL_CAP);
  x = new Float32Array(UNIT_PACKET_INITIAL_CAP);
  y = new Float32Array(UNIT_PACKET_INITIAL_CAP);
  /** Sim heading, radians. Places the layout's contacts around the body. */
  yaw = new Float32Array(UNIT_PACKET_INITIAL_CAP);
  grounded = new Uint8Array(UNIT_PACKET_INITIAL_CAP);
  /** 1 when marks must be draped over submerged terrain instead of water. */
  terrainBed = new Uint8Array(UNIT_PACKET_INITIAL_CAP);
  count = 0;

  reset(): void {
    this.count = 0;
  }

  pushUnit(
    entity: Entity,
    getMesh: (entityId: EntityId) => Locomotion3DMesh,
    mapWidth: number,
    mapHeight: number,
  ): void {
    const unit = entity.unit;
    if (!unit) return;
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    const loc = getMesh(entity.id);
    const grounded = loc?.type === 'crawler'
      ? loc.visualGrounded
      : isLocomotionGrounded(entity, mapWidth, mapHeight);
    this.ids[cursor] = entity.id;
    this.x[cursor] = entity.transform.x;
    this.y[cursor] = entity.transform.y;
    this.yaw[cursor] = entity.transform.rotation;
    this.grounded[cursor] = grounded ? 1 : 0;
    this.terrainBed[cursor] = locomotionTerrainModeForSupportHeight(
      getUnitGroundZ(entity),
    ) === 'terrainBed' ? 1 : 0;
    this.count = cursor + 1;
  }

  pushRow(
    entityId: EntityId,
    x: number,
    y: number,
    yaw: number,
    grounded: boolean,
    supportHeight: number,
  ): void {
    const cursor = this.count;
    this.ensureCapacity(cursor + 1);
    this.ids[cursor] = entityId;
    this.x[cursor] = x;
    this.y[cursor] = y;
    this.yaw[cursor] = yaw;
    this.grounded[cursor] = grounded ? 1 : 0;
    this.terrainBed[cursor] = locomotionTerrainModeForSupportHeight(
      supportHeight,
    ) === 'terrainBed' ? 1 : 0;
    this.count = cursor + 1;
  }

  terrainModeAt(row: number): LocomotionTerrainMode {
    return this.terrainBed[row] !== 0 ? 'terrainBed' : 'visibleSurface';
  }

  private ensureCapacity(required: number): void {
    if (required <= this.ids.length) return;
    const nextCapacity = nextGeometricCapacity(this.ids.length, required);
    [this.ids, this.x, this.y, this.yaw, this.grounded, this.terrainBed] = growTypedArrays([
      this.ids,
      this.x,
      this.y,
      this.yaw,
      this.grounded,
      this.terrainBed,
    ] as const, nextCapacity);
  }
}

type GroundPrintMaterial = THREE.MeshBasicMaterial & {
  groundPrintUniforms: { uNowSec: { value: number } };
};

function makeGroundPrintMaterial(): GroundPrintMaterial {
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    // Multiply: framebuffer *= mix(1, tint, alpha). three's MultiplyBlending
    // is defined ONLY for premultiplied sources (r184: it logs an error and
    // keeps the previous blend func otherwise, which drew every print as an
    // opaque near-white quad): with premultipliedAlpha the blend is
    // dst * src.rgb + dst * (1 - src.a) = dst * (tint * a + 1 - a), so alpha
    // is how far the ground darkens toward the soil tint — the old alpha-
    // paint strength for a single layer — while the terrain's own shading,
    // sun shadow included, scales through untouched.
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,
    // A multiplier is not a colour; tone mapping would bend it.
    toneMapped: false,
  }) as GroundPrintMaterial;
  mat.groundPrintUniforms = { uNowSec: { value: 0 } };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uNowSec = mat.groundPrintUniforms.uNowSec;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `
attribute vec2 markUv;
attribute float markShape;
attribute vec2 markLife;
varying vec2 vMarkUv;
varying float vMarkShape;
varying vec2 vMarkLife;
#include <common>
`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
#include <begin_vertex>
vMarkUv = markUv;
vMarkShape = markShape;
vMarkLife = markLife;
`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `
uniform float uNowSec;
varying vec2 vMarkUv;
varying float vMarkShape;
varying vec2 vMarkLife;
#include <common>
`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `
#include <clipping_planes_fragment>
if (vMarkShape > 0.5) {
  float circleMask = 1.0 - smoothstep(0.9, 1.0, dot(vMarkUv, vMarkUv));
  if (circleMask <= 0.001) discard;
  diffuseColor.a *= circleMask;
}
{
  // markLife = (birth seconds, lifetime seconds). Hold, then ease out.
  float lifeFrac = (uNowSec - vMarkLife.x) / max(vMarkLife.y, 1e-3);
  float fade = 1.0 - smoothstep(${PRINT_HOLD_FRACTION.toFixed(4)}, 1.0, lifeFrac);
  if (fade <= 0.001) discard;
  diffuseColor.a *= fade;
}
`,
    );
  };
  return mat;
}

// ── Per-trail bookkeeping ──
// One TrailState per (unit, contact): the contact's last-emit
// position (also the start of the next quad), its motion direction
// at that emit (for miter-joining the next), and a pointer to the
// most recent live Mark so we can rewrite its end vertices when a
// successor joins.

type TrailKey = number;

function unitEntityIdFromTrailKey(key: TrailKey): EntityId | undefined {
  const id = Math.floor(key / CONTACT_KEY_UNIT_STRIDE);
  return Number.isFinite(id) ? id as EntityId : undefined;
}

function contactTrailKey(
  unitId: EntityId,
  contactType: number,
  contactIndex: number,
): TrailKey {
  return (
    unitId * CONTACT_KEY_UNIT_STRIDE +
    contactType * CONTACT_KEY_INDEX_STRIDE +
    contactIndex
  );
}

type TrailState = {
  lastEmitX: number;
  lastEmitY: number;
  lastDirX: number;
  lastDirY: number;
  /** First time we saw this contact we record the position but
   *  don't have a direction yet — emits don't begin until the
   *  contact has moved by `spacing` from this point. */
  primed: boolean;
  prevMark: Mark | null;
  terrainMode: LocomotionTerrainMode;
};

// ── Per-stamp bookkeeping ──
// Track whether the foot was unplanted so we can detect the
// free/stepping → planted transition (foot just landed). Plus the last
// stamp position for the rare micro-replant dedupe.

type StampState = {
  wasUnplanted: boolean;
  lastX: number;
  lastY: number;
  hasInitial: boolean;
  terrainMode: LocomotionTerrainMode;
};

type Mark = {
  slot: number;
  /** Mark clock (ms) at emit; the GPU fade and CPU retirement both key on it. */
  bornMs: number;
  lifetimeMs: number;
  /** Set true when the mark is removed; trails reading prevMark
   *  notice this and fall back to a square cap for the next quad. */
  removed: boolean;
};

export class GroundPrint3D {
  private root: THREE.Group;

  // Merged geometry — same swap-and-pop layout as BurnMark3D.
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private markUvs: Float32Array;
  private markShapes: Float32Array;
  private markLives: Float32Array;
  private indices: Uint32Array;
  private mesh: THREE.Mesh;
  private mat: GroundPrintMaterial;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private uvAttr: THREE.BufferAttribute;
  private shapeAttr: THREE.BufferAttribute;
  private lifeAttr: THREE.BufferAttribute;
  private readonly posDirty = createDirtySlotSpan();
  private readonly colDirty = createDirtySlotSpan();
  private readonly uvDirty = createDirtySlotSpan();
  private readonly shapeDirty = createDirtySlotSpan();
  private readonly lifeDirty = createDirtySlotSpan();

  private marks: Mark[] = [];
  /** Mark clock: effect time accumulated from update dt, so marks age
   *  only while effects run (a paused presentation freezes them). */
  private nowMs = 0;
  /** Lifetime handed to marks emitted this update (density-scaled). */
  private emitLifetimeMs = PRINT_BASE_LIFETIME_MS;
  private evictionScratch = new Float64Array(0);
  /** Per-unit contact layout, resolved once from the blueprint and dropped
   *  when the unit leaves the packet. */
  private layouts = new Map<EntityId, GroundPrintLayout | null>();
  private trails = new Map<TrailKey, TrailState>();
  private _seenTrailKeys = new Set<TrailKey>();
  private stamps = new Map<TrailKey, StampState>();
  private _seenStampKeys = new Set<TrailKey>();
  private _activeUnitIds = new IndexedEntityIdSet();
  private _groundedUnitIds = new IndexedEntityIdSet();

  /** EMA-smoothed copy of mark density. -1 = "not
   *  initialized yet" so the first update snaps to the resolved
   *  value rather than easing in from 0. */
  private _smoothedDensity = -1;

  private scope: ViewportFootprint | null = null;

  /** Ground height sampler under a contact's world (x, z). Submerged
   *  contacts select the terrain bed rather than the visible water plane. */
  private getGroundY: (
    x: number,
    z: number,
    terrainMode: LocomotionTerrainMode,
  ) => number;
  /** Stable per-mode callbacks keep the quad writer allocation-free. */
  private markVisibleSurfaceY: (x: number, z: number) => number;
  private markTerrainBedY: (x: number, z: number) => number;

  constructor(
    parentWorld: THREE.Group,
    scope?: ViewportFootprint,
    getGroundY?: (
      x: number,
      z: number,
      terrainMode: LocomotionTerrainMode,
    ) => number,
  ) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope ?? null;
    this.getGroundY = getGroundY ?? (() => 0);
    this.markVisibleSurfaceY = (x, z) =>
      this.getGroundY(x, z, 'visibleSurface') + MARK_LIFT;
    this.markTerrainBedY = (x, z) =>
      this.getGroundY(x, z, 'terrainBed') + MARK_LIFT;

    this.positions = new Float32Array(HARD_CAP * 4 * 3);
    this.colors = new Float32Array(HARD_CAP * 4 * 4);
    this.markUvs = new Float32Array(HARD_CAP * 4 * 2);
    this.markShapes = new Float32Array(HARD_CAP * 4);
    this.markLives = new Float32Array(HARD_CAP * 4 * 2);
    this.indices = createQuadIndexBuffer(HARD_CAP);

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.uvAttr = new THREE.BufferAttribute(this.markUvs, 2).setUsage(THREE.DynamicDrawUsage);
    this.shapeAttr = new THREE.BufferAttribute(this.markShapes, 1).setUsage(THREE.DynamicDrawUsage);
    this.lifeAttr = new THREE.BufferAttribute(this.markLives, 2).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setAttribute('markUv', this.uvAttr);
    this.geometry.setAttribute('markShape', this.shapeAttr);
    this.geometry.setAttribute('markLife', this.lifeAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.mat = makeGroundPrintMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.mat);
    this.mesh.renderOrder = 9;
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
  }

  /** Per-frame entry point. `getMesh` is only consulted for a rig's real
   *  planted feet; `getEntity` resolves the blueprint layout; `density01`
   *  is the render budget's already-scaled groundPrintDensity. */
  update(
    packet: GroundPrintRenderPacket3D,
    getMesh: (entityId: EntityId) => Locomotion3DMesh,
    getEntity: (entityId: EntityId) => Entity | undefined,
    dtMs: number,
    density01: number,
  ): void {
    // Toggle: if marks are off, drain everything and idle.
    if (!getLocomotionMarks()) {
      if (this.marks.length > 0) this.clearMarksOnly();
      this.trails.clear();
      this.stamps.clear();
      this.layouts.clear();
      this._smoothedDensity = -1;
      return;
    }

    if (
      packet.count === 0 &&
      this.marks.length === 0 &&
      this.trails.size === 0 &&
      this.stamps.size === 0
    ) {
      return;
    }

    // ── Density EMA ──
    // Density glides over ~300 ms instead of stepping. The caller hands
    // over the render budget's scaled value, so a heavy scene thins its
    // marks instead of reading the static maximum forever.
    const target = clamp01(Number.isFinite(density01) ? density01 : 1);
    if (this._smoothedDensity < 0) {
      this._smoothedDensity = target;
    } else {
      const a = 1 - Math.exp(-Math.max(0, dtMs) / DENSITY_EMA_TAU_MS);
      this._smoothedDensity += (target - this._smoothedDensity) * a;
    }
    const density = this._smoothedDensity;

    // The density multiplier sets the lifetime of marks emitted THIS
    // update; marks already on the ground keep the lifetime they were
    // born with, so a density change never pops existing prints.
    const lifeMult =
      LIFETIME_MULT_AT_ZERO_DENSITY + (1 - LIFETIME_MULT_AT_ZERO_DENSITY) * density;
    this.emitLifetimeMs = Math.max(1, PRINT_BASE_LIFETIME_MS * lifeMult);

    // ── Clock + retirement sweep ──
    // Aging happens even when emit is gated off below. The shader owns
    // the fade; the CPU only frees slots whose fade has finished. Run
    // BEFORE emits so freed slots are reusable this frame.
    this.nowMs += Math.max(0, dtMs);
    this.mat.groundPrintUniforms.uNowSec.value = this.nowMs * 0.001;
    const now = this.nowMs;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      if (now - m.bornMs >= m.lifetimeMs) this.removeMarkAt(i);
    }

    this.refreshGroundedUnits(packet);

    // Below the floor, skip the emit pass — keep the smoothed
    // density alive so the next frame can pick up smoothly. Ground
    // contact loss is already retired above; grounded contacts keep
    // their last emit point for a clean continuation if density
    // rises again.
    if (density < EMIT_DENSITY_FLOOR) {
      this.flushBuffers();
      return;
    }

    // Spacing for this frame. Squared form for the cheap distance
    // compare in sampleTrail.
    const spacing =
      SPACING_AT_FULL_DENSITY + (1 - density) * (SPACING_AT_ZERO_DENSITY - SPACING_AT_FULL_DENSITY);
    const spacingSq = spacing * spacing;

    // ── Sample every contact every frame ──
    this._seenTrailKeys.clear();
    this._seenStampKeys.clear();

    for (let row = 0; row < packet.count; row++) {
      const unitId = packet.ids[row] as EntityId;
      if (!this._groundedUnitIds.has(unitId)) continue;
      // Off-scope units: skip sampling entirely. Their trail/stamp
      // state will be retired at end-of-frame; if they re-enter
      // scope later the trail starts fresh from a square cap, which
      // is the right thing to do (we have no idea where they were
      // while off-screen).
      if (this.scope && !this.scope.inScope(packet.x[row], packet.y[row], 200)) continue;
      const layout = this.layoutFor(unitId, getEntity);
      if (layout === null) continue;
      const terrainMode = packet.terrainModeAt(row);
      const bx = packet.x[row];
      const by = packet.y[row];
      // Chassis-local (X forward, Z lateral) into sim XY by the body's
      // heading — the same rotation the rig's yaw quaternion applies
      // (render_pose.rs: yaw = -rotation about world up).
      const yaw = packet.yaw[row];
      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);

      const trails = layout.trails;
      for (let i = 0; i < trails.length; i++) {
        const contact = trails[i];
        const key = contactTrailKey(unitId, CONTACT_TYPE_TRAIL, i);
        this._seenTrailKeys.add(key);
        this.sampleTrail(
          key,
          bx + contact.localX * cosYaw - contact.localZ * sinYaw,
          by + contact.localX * sinYaw + contact.localZ * cosYaw,
          contact.width,
          spacingSq,
          terrainMode,
        );
      }

      const stamps = layout.stamps;
      if (stamps.length === 0) continue;
      // A drawn rig with legs knows exactly where each foot is planted;
      // use that so the print sits under the foot. Otherwise the layout's
      // rest foothold and stride stand in — same keys, so a unit crossing
      // a detail rung mid-walk continues its own track.
      const loc = getMesh(unitId);
      for (let i = 0; i < stamps.length; i++) {
        const contact = stamps[i];
        const key = contactTrailKey(unitId, CONTACT_TYPE_LEG, i);
        this._seenStampKeys.add(key);
        if (loc?.type === 'crawler') {
          const leg = loc.legs[i];
          if (leg !== undefined && leg.initialized) {
            this.sampleStamp(
              key, leg.contactState === 'planted', leg.worldX, leg.worldZ, leg.footRadius, terrainMode,
            );
            continue;
          }
        } else if (loc?.type === 'bot') {
          const leg = loc.legs[i];
          if (leg !== undefined && leg.footTracked) {
            this.sampleStamp(
              key, leg.footPlanted, leg.footWorldX, leg.footWorldZ, contact.footRadius, terrainMode,
            );
            continue;
          }
        }
        this.sampleSyntheticStamp(
          key,
          contact,
          bx + contact.localX * cosYaw - contact.localZ * sinYaw,
          by + contact.localX * sinYaw + contact.localZ * cosYaw,
          cosYaw,
          sinYaw,
          terrainMode,
        );
      }
    }

    // Retire trails / stamps for contacts we didn't see this frame.
    for (const k of this.trails.keys()) {
      if (!this._seenTrailKeys.has(k)) this.trails.delete(k);
    }
    for (const k of this.stamps.keys()) {
      if (!this._seenStampKeys.has(k)) this.stamps.delete(k);
    }

    this.flushBuffers();
  }

  private refreshGroundedUnits(
    packet: GroundPrintRenderPacket3D,
  ): void {
    this._activeUnitIds.clear();
    this._groundedUnitIds.clear();

    for (let row = 0; row < packet.count; row++) {
      const unitId = packet.ids[row] as EntityId;
      this._activeUnitIds.add(unitId);
      if (packet.grounded[row] !== 0) {
        this._groundedUnitIds.add(unitId);
      }
    }

    this.retireUnavailableContactState(this.trails);
    this.retireUnavailableContactState(this.stamps);
    for (const unitId of this.layouts.keys()) {
      if (!this._activeUnitIds.has(unitId)) this.layouts.delete(unitId);
    }
  }

  private layoutFor(
    unitId: EntityId,
    getEntity: (entityId: EntityId) => Entity | undefined,
  ): GroundPrintLayout | null {
    const cached = this.layouts.get(unitId);
    if (cached !== undefined) return cached;
    const entity = getEntity(unitId);
    const layout = entity === undefined ? null : resolveGroundPrintLayout(entity);
    this.layouts.set(unitId, layout);
    return layout;
  }

  private retireUnavailableContactState<T>(states: Map<TrailKey, T>): void {
    for (const key of states.keys()) {
      const unitEntityId = unitEntityIdFromTrailKey(key);
      if (
        unitEntityId === undefined ||
        !this._activeUnitIds.has(unitEntityId) ||
        !this._groundedUnitIds.has(unitEntityId)
      ) {
        states.delete(key);
      }
    }
  }

  // ── Trail sampling (wheels, tread sides) ──
  // Always invoked, every frame, every contact. The distance check
  // gates emission; nothing else does. So as long as the contact
  // moves, the trail keeps getting longer with quads butting
  // edge-to-edge — gap-free regardless of density.

  private sampleTrail(
    key: TrailKey,
    cx: number, cz: number,
    width: number,
    spacingSq: number,
    terrainMode: LocomotionTerrainMode,
  ): void {
    let state = this.trails.get(key);
    if (!state || state.terrainMode !== terrainMode) {
      state = {
        lastEmitX: cx,
        lastEmitY: cz,
        lastDirX: 0,
        lastDirY: 0,
        primed: true,
        prevMark: null,
        terrainMode,
      };
      this.trails.set(key, state);
      return;
    }
    const dx = cx - state.lastEmitX;
    const dz = cz - state.lastEmitY;
    const distSq = dx * dx + dz * dz;
    if (distSq < spacingSq) return;
    const invLen = 1 / Math.sqrt(distSq);
    const dirX = dx * invLen;
    const dirZ = dz * invLen;
    this.appendMiteredTrail(state, cx, cz, dirX, dirZ, width, terrainMode);
  }

  // ── Stamp sampling (a rig's real feet) ──
  // Detect the stepping/free → planted transition. Every plant cycle yields
  // exactly one stamp; misses are only possible if a plant happens
  // closer than STAMP_MIN_DIST to the previous stamp (rare; the
  // body has effectively not moved between cycles).

  private sampleStamp(
    key: TrailKey,
    planted: boolean,
    footX: number,
    footZ: number,
    footRadius: number,
    terrainMode: LocomotionTerrainMode,
  ): void {
    let state = this.stamps.get(key);
    if (!state || state.terrainMode !== terrainMode) {
      // First sighting. If the foot is already planted, treat that
      // as the initial plant and stamp it.
      state = {
        wasUnplanted: !planted,
        lastX: footX,
        lastY: footZ,
        hasInitial: false,
        terrainMode,
      };
      this.stamps.set(key, state);
      if (planted) this.emitStamp(state, footX, footZ, footRadius, terrainMode);
      return;
    }
    const unplanted = !planted;
    const justLanded = state.wasUnplanted && !unplanted;
    state.wasUnplanted = unplanted;
    if (!justLanded) return;
    if (state.hasInitial) {
      const dx = footX - state.lastX;
      const dz = footZ - state.lastY;
      if (dx * dx + dz * dz < STAMP_MIN_DIST_SQ) return;
    }
    this.emitStamp(state, footX, footZ, footRadius, terrainMode);
  }

  // ── Stamp sampling (no rig: the layout's stride) ──
  // The foothold's home rides the body; a foot plants every `stride` of
  // ground the home covers, and phase-1 feet start half a stride behind so
  // diagonal pairs alternate. Distance is measured from the LAST stamp,
  // so a unit dropping to the proxy rung mid-walk keeps its own cadence
  // from wherever its real foot last planted.

  private sampleSyntheticStamp(
    key: TrailKey,
    contact: GroundPrintStampContact,
    homeX: number,
    homeY: number,
    headingX: number,
    headingY: number,
    terrainMode: LocomotionTerrainMode,
  ): void {
    let state = this.stamps.get(key);
    if (!state || state.terrainMode !== terrainMode) {
      state = {
        wasUnplanted: false,
        lastX: homeX,
        lastY: homeY,
        hasInitial: false,
        terrainMode,
      };
      this.stamps.set(key, state);
      if (contact.phase01 === 0) {
        this.emitStamp(state, homeX, homeY, contact.footRadius, terrainMode);
      } else {
        // Pretend the last plant was half a stride back along the heading.
        const back = contact.stride * 0.5;
        state.lastX = homeX - headingX * back;
        state.lastY = homeY - headingY * back;
        state.hasInitial = true;
      }
      return;
    }
    const dx = homeX - state.lastX;
    const dy = homeY - state.lastY;
    if (dx * dx + dy * dy < contact.stride * contact.stride) return;
    this.emitStamp(state, homeX, homeY, contact.footRadius, terrainMode);
  }

  private emitStamp(
    state: StampState,
    fx: number,
    fz: number,
    footRadius: number,
    terrainMode: LocomotionTerrainMode,
  ): void {
    const endpointRadius = Math.max(1.1, footRadius);
    const radius = endpointRadius * STAMP_CIRCLE_RADIUS_MULT;
    const sLx = fx - radius;
    const sLz = fz - radius;
    const sRx = fx + radius;
    const sRz = fz - radius;
    const eRx = fx + radius;
    const eRz = fz + radius;
    const eLx = fx - radius;
    const eLz = fz + radius;

    const mark = this.allocateMark();
    const corners: RibbonQuadCorners = { sLx, sLz, sRx, sRz, eRx, eRz, eLx, eLz };
    writeDrapedQuadXZ(
      this.positions,
      mark.slot,
      this.markYForTerrainMode(terrainMode),
      corners,
    );
    markDirtySlot(this.posDirty, mark.slot);
    this.writeCircleMask(mark.slot);
    this.writeMarkTint(mark);

    state.lastX = fx;
    state.lastY = fz;
    state.hasInitial = true;
  }

  // ── Trail miter append ──
  // Always allocate the new mark FIRST so any overflow eviction
  // settles before we touch geometry. Then check whether the
  // predecessor is still alive (eviction may have killed it). If
  // alive: bisector miter; if not: square cap.

  private appendMiteredTrail(
    state: TrailState,
    endX: number, endY: number,
    dirX: number, dirZ: number,
    width: number,
    terrainMode: LocomotionTerrainMode,
  ): void {
    // Capture lastDir before allocateMark; allocateMark won't
    // touch state, but we read these before any branching anyway.
    const lastDirX = state.lastDirX;
    const lastDirY = state.lastDirY;
    const prev = state.prevMark;

    // Allocate first — may evict ANY existing mark including `prev`.
    const newMark = this.allocateMark();

    const haveLivePrev = prev !== null && !prev.removed;
    const corners = computeMiteredQuad(
      state.lastEmitX,
      state.lastEmitY,
      endX,
      endY,
      dirX,
      dirZ,
      lastDirX,
      lastDirY,
      width * 0.5,
      MITER_LIMIT,
      haveLivePrev,
    );

    if (haveLivePrev) {
      writeDrapedQuadEndXZ(
        this.positions,
        prev!.slot,
        this.markYForTerrainMode(terrainMode),
        corners.sRx,
        corners.sRz,
        corners.sLx,
        corners.sLz,
      );
      markDirtySlot(this.posDirty, prev!.slot);
    }
    writeDrapedQuadXZ(
      this.positions,
      newMark.slot,
      this.markYForTerrainMode(terrainMode),
      corners,
    );
    markDirtySlot(this.posDirty, newMark.slot);
    this.writeQuadMask(newMark.slot);
    this.writeMarkTint(newMark);

    state.lastEmitX = endX;
    state.lastEmitY = endY;
    state.lastDirX = dirX;
    state.lastDirY = dirZ;
    state.prevMark = newMark;
  }

  private markYForTerrainMode(
    terrainMode: LocomotionTerrainMode,
  ): (x: number, z: number) => number {
    return terrainMode === 'terrainBed'
      ? this.markTerrainBedY
      : this.markVisibleSurfaceY;
  }

  /** Allocate a new Mark, evicting the oldest existing mark first
   *  if the buffer is full. Returns the freshly-pushed Mark with
   *  `slot` already set. Never drops the request. */
  private allocateMark(): Mark {
    if (this.marks.length >= HARD_CAP) this.evictOldestBatch();
    const slot = this.marks.length;
    const mark: Mark = {
      slot,
      bornMs: this.nowMs,
      lifetimeMs: this.emitLifetimeMs,
      removed: false,
    };
    this.marks.push(mark);
    this.geometry.setDrawRange(0, this.marks.length * 6);
    return mark;
  }

  /** At the cap, retire the oldest EVICTION_BATCH_FRACTION of the marks
   *  in one pass. Swap-pop shuffles array order, so "oldest" needs a
   *  look at every birth time; sorting a copy once per batch replaces
   *  the old per-allocation full scan (which went quadratic the moment
   *  a long lifetime kept the buffer pinned at the cap). */
  private evictOldestBatch(): void {
    const count = this.marks.length;
    if (count === 0) return;
    if (this.evictionScratch.length < count) {
      this.evictionScratch = new Float64Array(count);
    }
    const births = this.evictionScratch.subarray(0, count);
    for (let i = 0; i < count; i++) births[i] = this.marks[i].bornMs;
    births.sort();
    const batch = Math.max(1, Math.floor(count * EVICTION_BATCH_FRACTION));
    const threshold = births[batch - 1];
    let removed = 0;
    for (let i = this.marks.length - 1; i >= 0 && removed < batch; i--) {
      if (this.marks[i].bornMs <= threshold) {
        this.removeMarkAt(i);
        removed++;
      }
    }
  }

  private writeMarkTint(mark: Mark): void {
    writeQuadRgba(
      this.colors, mark.slot, PRINT_LIN.r, PRINT_LIN.g, PRINT_LIN.b, PRINT_INITIAL_ALPHA,
    );
    markDirtySlot(this.colDirty, mark.slot);
    const lives = this.markLives;
    const base = mark.slot * 8;
    const bornSec = mark.bornMs * 0.001;
    const lifeSec = mark.lifetimeMs * 0.001;
    for (let i = 0; i < 4; i++) {
      lives[base + i * 2] = bornSec;
      lives[base + i * 2 + 1] = lifeSec;
    }
    markDirtySlot(this.lifeDirty, mark.slot);
  }

  private writeQuadMask(slot: number): void {
    const uv = this.markUvs;
    const shape = this.markShapes;
    const uvBase = slot * 8;
    const shapeBase = slot * 4;
    for (let i = 0; i < 8; i++) uv[uvBase + i] = 0;
    for (let i = 0; i < 4; i++) shape[shapeBase + i] = 0;
    markDirtySlot(this.uvDirty, slot);
    markDirtySlot(this.shapeDirty, slot);
  }

  private writeCircleMask(slot: number): void {
    const uv = this.markUvs;
    const shape = this.markShapes;
    const uvBase = slot * 8;
    uv[uvBase     ] = -1; uv[uvBase + 1] = -1;
    uv[uvBase + 2] =  1; uv[uvBase + 3] = -1;
    uv[uvBase + 4] =  1; uv[uvBase + 5] =  1;
    uv[uvBase + 6] = -1; uv[uvBase + 7] =  1;
    const shapeBase = slot * 4;
    for (let i = 0; i < 4; i++) shape[shapeBase + i] = 1;
    markDirtySlot(this.uvDirty, slot);
    markDirtySlot(this.shapeDirty, slot);
  }

  /** Swap-pop deletion: copy the last mark's data into slot `i`,
   *  pop the array, and update the moved mark's `slot` field. The
   *  removed mark's `removed` flag is set so any TrailState still
   *  holding a reference can detect the loss. O(1) deletion. */
  private removeMarkAt(i: number): void {
    const last = this.marks.length - 1;
    this.marks[i].removed = true;
    if (i !== last) {
      const moved = this.marks[last];
      copyQuadSlot(this.positions, 12, last, i);
      copyQuadSlot(this.colors, 16, last, i);
      copyQuadSlot(this.markUvs, 8, last, i);
      copyQuadSlot(this.markShapes, 4, last, i);
      copyQuadSlot(this.markLives, 8, last, i);
      moved.slot = i;
      this.marks[i] = moved;
      markDirtySlot(this.posDirty, i);
      markDirtySlot(this.colDirty, i);
      markDirtySlot(this.uvDirty, i);
      markDirtySlot(this.shapeDirty, i);
      markDirtySlot(this.lifeDirty, i);
    }
    this.marks.pop();
    this.geometry.setDrawRange(0, this.marks.length * 6);
  }

  /** Wipe the geometry but keep the trail/stamp Maps intact. The
   *  toggle path uses this; mid-update gating skips emit instead.
   *  TrailStates' prevMark refs go stale but the `removed` flag
   *  + clearing prevMark below makes the next emit start fresh. */
  private clearMarksOnly(): void {
    for (const m of this.marks) m.removed = true;
    this.marks.length = 0;
    this.geometry.setDrawRange(0, 0);
    for (const state of this.trails.values()) state.prevMark = null;
    clearDirtySlotSpan(this.posDirty);
    clearDirtySlotSpan(this.colDirty);
    clearDirtySlotSpan(this.uvDirty);
    clearDirtySlotSpan(this.shapeDirty);
    clearDirtySlotSpan(this.lifeDirty);
  }

  private flushBuffers(): void {
    if (this.marks.length > 0) {
      uploadDirtySlotSpan(this.posAttr, this.posDirty, 12, this.marks.length);
      uploadDirtySlotSpan(this.colAttr, this.colDirty, 16, this.marks.length);
      uploadDirtySlotSpan(this.uvAttr, this.uvDirty, 8, this.marks.length);
      uploadDirtySlotSpan(this.shapeAttr, this.shapeDirty, 4, this.marks.length);
      uploadDirtySlotSpan(this.lifeAttr, this.lifeDirty, 8, this.marks.length);
    } else {
      clearDirtySlotSpan(this.posDirty);
      clearDirtySlotSpan(this.colDirty);
      clearDirtySlotSpan(this.uvDirty);
      clearDirtySlotSpan(this.shapeDirty);
      clearDirtySlotSpan(this.lifeDirty);
    }
  }

  destroy(): void {
    this.marks.length = 0;
    this.trails.clear();
    this.stamps.clear();
    disposeMesh(this.mesh);
    this.root.parent?.remove(this.root);
  }
}
