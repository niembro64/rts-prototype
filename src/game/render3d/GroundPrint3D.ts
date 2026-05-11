// GroundPrint3D — wheel ruts, tread tracks, and footstep stamps drawn
// onto the ground as fading quads. Leg stamps use a small shader mask
// so their underlying quads read as circular ground prints.
//
// Rewrite goals (vs. the original frame-skip design):
//
// 1. NO GAPS. Trails are continuous at every LOD. We sample every
//    contact every frame and emit a new quad as soon as the contact
//    has moved by `spacing` world units since the last emit. The new
//    quad spans `lastEmit → current` exactly, so segments butt
//    edge-to-edge no matter how fast the unit is moving or how few
//    quads-per-second we end up emitting.
//
// 2. NO MISSED FOOTPRINTS. Leg stamps are emitted on the planted-
//    after-sliding transition (`wasSliding && !isSliding`), so every
//    plant cycle stamps exactly once. No frame-skip can drop a
//    plant — we read every frame and look for the edge.
//
// 3. NO LOD CULL. Marks die only when their lifetime expires. A tier
//    flip never deletes in-flight marks; it just slows the rate of
//    new emission and shortens the lifetime applied to *future*
//    marks. The visible result is a graceful collective fade-out
//    instead of the old hard cut. EMA-smoothed density (~300 ms tau)
//    smooths the transition even further.
//
// 4. SPACING + LIFETIME = LOD. One density knob (groundPrintDensity)
//    per LOD tier drives both:
//      - emit spacing  (tight at MAX, wide at MIN — fewer marks per
//        unit distance, but always continuous)
//      - per-mark lifetime (longer at MAX, shorter at MIN — natural
//        active-count throttle without an explicit cap)
//
// 5. SOFT CAP. There's a hard buffer ceiling (HARD_CAP) for GPU
//    pre-allocation. When it's hit (only at extreme load), we evict
//    the oldest-aged mark to free a slot. No emit ever gets dropped
//    on the floor — the cost of overflow is one mark dying a frame
//    early, not a missing rut.
//
// Per-frame work is bounded: O(units × contacts) for sampling, plus
// O(active marks) for the age sweep. Both scale linearly and
// allocate nothing in steady state.

import * as THREE from 'three';
import type { Entity, EntityId } from '../sim/types';
import { getGraphicsConfig, getGroundMarks } from '@/clientBarConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { Locomotion3DMesh } from './Locomotion3D';
import type { LegInstance } from './LegRig3D';
import { isLocomotionGrounded } from './LocomotionTerrainSampler';
import { disposeMesh } from './threeUtils';
import {
  computeMiteredQuad,
  copyQuadSlot,
  createQuadIndexBuffer,
  writeFlatQuadEndXZ,
  writeFlatQuadXZ,
  writeQuadRgba,
  type RibbonQuadCorners,
} from './RibbonTrailBuffer3D';

// ── World Y layout ──
// Sit slightly above the tile floor; under burn marks (Y=2.5) so a
// scorch on top of a rut reads correctly.
const MARK_Y = 2.4;

// ── Color ──
// Dark soil compaction. Routed through THREE.Color so the hex (sRGB)
// converts to linear-RGB for vertex-color writes.
const PRINT_HEX = 0x1a1308;
const PRINT_LIN = new THREE.Color(PRINT_HEX);

// ── Lifetime ──
// Linear alpha decay from PRINT_INITIAL_ALPHA at age 0 → 0 at age
// PRINT_BASE_LIFETIME_MS × density-derived multiplier. Tweak the
// base to change how long marks linger at MAX LOD; the multiplier
// shortens it at lower tiers.
const PRINT_BASE_LIFETIME_MS = 1000;
const PRINT_INITIAL_ALPHA = 0.2;

const STAMP_CIRCLE_RADIUS_MULT = 1.35;

// At density = 0 lifetime is shrunk to this fraction of the base.
// MIN tier therefore drains the buffer about 2.5× faster than MAX.
const LIFETIME_MULT_AT_MIN = 0.4;

// ── Spacing (distance-based emit) ──
// At density = 1 we emit a new quad every SPACING_AT_MAX wu of
// motion (tight ribbons). At density = 0 the spacing relaxes to
// SPACING_AT_MIN — fewer quads per unit distance but each quad spans
// more, so the trail stays continuous.
const SPACING_AT_MAX = 4;
const SPACING_AT_MIN = 24;

// ── Stamp dedupe ──
// A leg sometimes "re-plants" within ~a wu of where it took off
// (creep-walking, micro-corrections). Skip the stamp if the new
// plant is within this distance of the previous stamp for the
// SAME foot. Small enough that real strides always pass.
const STAMP_MIN_DIST_SQ = 4;

// ── Buffer ceiling ──
// Hard cap on the GPU-side merged geometry. Active count rarely
// approaches this — at MAX LOD the spacing × lifetime product
// converges to a few thousand marks even in heavy combat. The cap
// only kicks in at pathological loads (100+ mobile units all
// sprinting at MAX), at which point we evict oldest-on-emit.
const HARD_CAP = 16000;

// Miter limit — clamp the bisector offset to 3× halfWidth so a
// near-180° turn doesn't produce an infinite spike.
const MITER_LIMIT = 3;

// EMA tau (ms) for smoothing the LOD-resolved density. ~300 ms
// matches BurnMark3D so the two mark systems glide together when
// the user changes graphics tier mid-frame.
const DENSITY_EMA_TAU_MS = 300;

// Below this smoothed density we skip the emit pass entirely — no
// new marks until the smoothed value climbs back above. The age
// sweep continues regardless so existing marks fade naturally and
// the buffer drains. Without this floor, density = 0 (MIN tier)
// would still emit at SPACING_AT_MIN intervals.
const EMIT_DENSITY_FLOOR = 0.02;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function makeGroundPrintMaterial(): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `
attribute vec2 markUv;
attribute float markShape;
varying vec2 vMarkUv;
varying float vMarkShape;
#include <common>
`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
#include <begin_vertex>
vMarkUv = markUv;
vMarkShape = markShape;
`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `
varying vec2 vMarkUv;
varying float vMarkShape;
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

type TrailKey = string;

function unitIdFromTrailKey(key: TrailKey): EntityId | undefined {
  const firstColon = key.indexOf(':');
  if (firstColon < 0) return undefined;
  const secondColon = key.indexOf(':', firstColon + 1);
  if (secondColon < 0) return undefined;
  const id = Number(key.slice(firstColon + 1, secondColon));
  return Number.isFinite(id) ? id as EntityId : undefined;
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
};

// ── Per-stamp bookkeeping ──
// Track the previous-frame slide state so we can detect the
// sliding → planted transition (foot just landed). Plus the last
// stamp position for the rare micro-replant dedupe.

type StampState = {
  wasSliding: boolean;
  lastX: number;
  lastY: number;
  hasInitial: boolean;
};

type Mark = {
  slot: number;
  age: number;
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
  private indices: Uint32Array;
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private uvAttr: THREE.BufferAttribute;
  private shapeAttr: THREE.BufferAttribute;
  private posDirty = false;
  private colDirty = false;
  private uvDirty = false;
  private shapeDirty = false;

  private marks: Mark[] = [];
  private trails = new Map<TrailKey, TrailState>();
  private _seenTrailKeys = new Set<TrailKey>();
  private stamps = new Map<TrailKey, StampState>();
  private _seenStampKeys = new Set<TrailKey>();
  private _activeUnitIds = new Set<EntityId>();
  private _groundedUnitIds = new Set<EntityId>();

  /** EMA-smoothed copy of the LOD-resolved density. -1 = "not
   *  initialized yet" so the first update snaps to the resolved
   *  value rather than easing in from 0. */
  private _smoothedDensity = -1;

  private scope: ViewportFootprint | null = null;

  constructor(parentWorld: THREE.Group, scope?: ViewportFootprint) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope ?? null;

    this.positions = new Float32Array(HARD_CAP * 4 * 3);
    this.colors = new Float32Array(HARD_CAP * 4 * 4);
    this.markUvs = new Float32Array(HARD_CAP * 4 * 2);
    this.markShapes = new Float32Array(HARD_CAP * 4);
    this.indices = createQuadIndexBuffer(HARD_CAP);

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.uvAttr = new THREE.BufferAttribute(this.markUvs, 2).setUsage(THREE.DynamicDrawUsage);
    this.shapeAttr = new THREE.BufferAttribute(this.markShapes, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setAttribute('markUv', this.uvAttr);
    this.geometry.setAttribute('markShape', this.shapeAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.mat = makeGroundPrintMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.mat);
    this.mesh.renderOrder = 9;
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
  }

  /** Per-frame entry point. */
  update(
    units: readonly Entity[],
    getMesh: (e: Entity) => Locomotion3DMesh,
    dtMs: number,
    mapWidth: number,
    mapHeight: number,
  ): void {
    // Toggle: if marks are off, drain everything and idle.
    if (!getGroundMarks()) {
      if (this.marks.length > 0) this.clearMarksOnly();
      this.trails.clear();
      this.stamps.clear();
      this._smoothedDensity = -1;
      return;
    }

    if (
      units.length === 0 &&
      this.marks.length === 0 &&
      this.trails.size === 0 &&
      this.stamps.size === 0
    ) {
      return;
    }

    // ── Density EMA ──
    // The LOD-resolved target glides over ~300 ms toward whatever
    // value the active tier provides. Tier flips never step.
    const gfx = getGraphicsConfig();
    const target = clamp01(gfx.groundPrintDensity ?? 1);
    if (this._smoothedDensity < 0) {
      this._smoothedDensity = target;
    } else {
      const a = 1 - Math.exp(-Math.max(0, dtMs) / DENSITY_EMA_TAU_MS);
      this._smoothedDensity += (target - this._smoothedDensity) * a;
    }
    const density = this._smoothedDensity;

    // Lifetime applies to every tier — even when emit is gated off
    // below, in-flight marks must keep aging.
    const lifeMult =
      LIFETIME_MULT_AT_MIN + (1 - LIFETIME_MULT_AT_MIN) * density;
    const effLifetimeMs = Math.max(1, PRINT_BASE_LIFETIME_MS * lifeMult);
    const invLifetime = 1 / effLifetimeMs;

    // ── Age sweep ──
    // Run BEFORE emits so dead marks free their slots first; new
    // emits this frame can immediately reuse them without waiting
    // for the next frame's overflow eviction.
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      m.age += dtMs;
      const lifeFrac = m.age * invLifetime;
      if (lifeFrac >= 1) {
        this.removeMarkAt(i);
        continue;
      }
      const alpha = PRINT_INITIAL_ALPHA * (1 - lifeFrac);
      writeQuadRgba(this.colors, i, PRINT_LIN.r, PRINT_LIN.g, PRINT_LIN.b, alpha);
      this.colDirty = true;
    }

    this.refreshGroundedUnits(units, mapWidth, mapHeight);

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
      SPACING_AT_MAX + (1 - density) * (SPACING_AT_MIN - SPACING_AT_MAX);
    const spacingSq = spacing * spacing;

    // ── Sample every contact every frame ──
    this._seenTrailKeys.clear();
    this._seenStampKeys.clear();

    for (const e of units) {
      if (!this._groundedUnitIds.has(e.id)) continue;
      const loc = getMesh(e);
      if (!loc) continue;
      // Off-scope units: skip sampling entirely. Their trail/stamp
      // state will be retired at end-of-frame; if they re-enter
      // scope later the trail starts fresh from a square cap, which
      // is the right thing to do (we have no idea where they were
      // while off-screen).
      if (this.scope && !this.scope.inScope(e.transform.x, e.transform.y, 200)) continue;

      switch (loc.type) {
        case 'wheels': {
          for (let i = 0; i < loc.wheelContacts.length; i++) {
            const c = loc.wheelContacts[i];
            if (!c.initialized) continue;
            const key = `wheel:${e.id}:${i}`;
            this._seenTrailKeys.add(key);
            this.sampleTrail(key, c.worldX, c.worldZ, loc.printWidth, spacingSq);
          }
          break;
        }
        case 'treads': {
          for (let i = 0; i < loc.treadContacts.length; i++) {
            const c = loc.treadContacts[i];
            if (!c.initialized) continue;
            const key = `tread:${e.id}:${i}`;
            this._seenTrailKeys.add(key);
            this.sampleTrail(key, c.worldX, c.worldZ, loc.printWidth, spacingSq);
          }
          break;
        }
        case 'legs': {
          for (let i = 0; i < loc.legs.length; i++) {
            const leg = loc.legs[i];
            if (!leg.initialized) continue;
            const key = `leg:${e.id}:${i}`;
            this._seenStampKeys.add(key);
            this.sampleStamp(key, leg);
          }
          break;
        }
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
    units: readonly Entity[],
    mapWidth: number,
    mapHeight: number,
  ): void {
    this._activeUnitIds.clear();
    this._groundedUnitIds.clear();

    for (const e of units) {
      this._activeUnitIds.add(e.id);
      if (isLocomotionGrounded(e, mapWidth, mapHeight)) {
        this._groundedUnitIds.add(e.id);
      }
    }

    this.retireUnavailableContactState(this.trails);
    this.retireUnavailableContactState(this.stamps);
  }

  private retireUnavailableContactState<T>(states: Map<TrailKey, T>): void {
    for (const key of states.keys()) {
      const unitId = unitIdFromTrailKey(key);
      if (
        unitId === undefined ||
        !this._activeUnitIds.has(unitId) ||
        !this._groundedUnitIds.has(unitId)
      ) {
        states.delete(key);
      }
    }
  }

  // ── Trail sampling (wheels, tread sides) ──
  // Always invoked, every frame, every contact. The distance check
  // gates emission; nothing else does. So as long as the contact
  // moves, the trail keeps getting longer with quads butting
  // edge-to-edge — gap-free regardless of LOD.

  private sampleTrail(
    key: TrailKey,
    cx: number, cz: number,
    width: number,
    spacingSq: number,
  ): void {
    let state = this.trails.get(key);
    if (!state) {
      state = {
        lastEmitX: cx,
        lastEmitY: cz,
        lastDirX: 0,
        lastDirY: 0,
        primed: true,
        prevMark: null,
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
    this.appendMiteredTrail(state, cx, cz, dirX, dirZ, width);
  }

  // ── Stamp sampling (legs) ──
  // Detect the slide → planted transition. Every plant cycle yields
  // exactly one stamp; misses are only possible if a plant happens
  // closer than STAMP_MIN_DIST to the previous stamp (rare; the
  // body has effectively not moved between cycles).

  private sampleStamp(
    key: TrailKey,
    leg: LegInstance,
  ): void {
    let state = this.stamps.get(key);
    if (!state) {
      // First sighting. If the foot is already planted, treat that
      // as the initial plant and stamp it.
      state = {
        wasSliding: leg.isSliding,
        lastX: leg.worldX,
        lastY: leg.worldZ,
        hasInitial: false,
      };
      this.stamps.set(key, state);
      if (!leg.isSliding) {
        this.emitStamp(state, leg);
      }
      return;
    }
    const justLanded = state.wasSliding && !leg.isSliding;
    state.wasSliding = leg.isSliding;
    if (!justLanded) return;
    if (state.hasInitial) {
      const dx = leg.worldX - state.lastX;
      const dz = leg.worldZ - state.lastY;
      if (dx * dx + dz * dz < STAMP_MIN_DIST_SQ) return;
    }
    this.emitStamp(state, leg);
  }

  private emitStamp(
    state: StampState,
    leg: LegInstance,
  ): void {
    const fx = leg.worldX;
    const fz = leg.worldZ;
    const radius = leg.footPadRadius * STAMP_CIRCLE_RADIUS_MULT;
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
    writeFlatQuadXZ(this.positions, mark.slot, MARK_Y, corners);
    this.writeCircleMask(mark.slot);
    writeQuadRgba(this.colors, mark.slot, PRINT_LIN.r, PRINT_LIN.g, PRINT_LIN.b, PRINT_INITIAL_ALPHA);
    this.posDirty = true;
    this.colDirty = true;

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
      writeFlatQuadEndXZ(
        this.positions,
        prev!.slot,
        MARK_Y,
        corners.sRx,
        corners.sRz,
        corners.sLx,
        corners.sLz,
      );
    }
    writeFlatQuadXZ(this.positions, newMark.slot, MARK_Y, corners);
    this.writeQuadMask(newMark.slot);
    writeQuadRgba(this.colors, newMark.slot, PRINT_LIN.r, PRINT_LIN.g, PRINT_LIN.b, PRINT_INITIAL_ALPHA);
    this.posDirty = true;
    this.colDirty = true;

    state.lastEmitX = endX;
    state.lastEmitY = endY;
    state.lastDirX = dirX;
    state.lastDirY = dirZ;
    state.prevMark = newMark;
  }

  /** Allocate a new Mark, evicting the oldest existing mark first
   *  if the buffer is full. Returns the freshly-pushed Mark with
   *  `slot` already set. Never drops the request. */
  private allocateMark(): Mark {
    if (this.marks.length >= HARD_CAP) {
      // Linear scan for the highest-age mark — the oldest. The
      // existing array order is shuffled by swap-pop deletions, so
      // marks[0] isn't guaranteed oldest; we have to look. This is
      // O(n) but only runs when at the cap, which in practice is
      // rare (max-LOD heavy combat only).
      let oldestIdx = 0;
      let oldestAge = -1;
      for (let i = 0; i < this.marks.length; i++) {
        if (this.marks[i].age > oldestAge) {
          oldestAge = this.marks[i].age;
          oldestIdx = i;
        }
      }
      this.removeMarkAt(oldestIdx);
    }
    const slot = this.marks.length;
    const mark: Mark = { slot, age: 0, removed: false };
    this.marks.push(mark);
    this.geometry.setDrawRange(0, this.marks.length * 6);
    return mark;
  }

  private writeQuadMask(slot: number): void {
    const uv = this.markUvs;
    const shape = this.markShapes;
    const uvBase = slot * 8;
    const shapeBase = slot * 4;
    for (let i = 0; i < 8; i++) uv[uvBase + i] = 0;
    for (let i = 0; i < 4; i++) shape[shapeBase + i] = 0;
    this.uvDirty = true;
    this.shapeDirty = true;
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
    this.uvDirty = true;
    this.shapeDirty = true;
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
      moved.slot = i;
      this.marks[i] = moved;
      this.posDirty = true;
      this.colDirty = true;
      this.uvDirty = true;
      this.shapeDirty = true;
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
    this.posDirty = false;
    this.colDirty = false;
  }

  private flushBuffers(): void {
    if (this.marks.length > 0) {
      if (this.posDirty) {
        this.posAttr.clearUpdateRanges();
        this.posAttr.addUpdateRange(0, this.marks.length * 12);
        this.posAttr.needsUpdate = true;
        this.posDirty = false;
      }
      if (this.colDirty) {
        this.colAttr.clearUpdateRanges();
        this.colAttr.addUpdateRange(0, this.marks.length * 16);
        this.colAttr.needsUpdate = true;
        this.colDirty = false;
      }
      if (this.uvDirty) {
        this.uvAttr.clearUpdateRanges();
        this.uvAttr.addUpdateRange(0, this.marks.length * 8);
        this.uvAttr.needsUpdate = true;
        this.uvDirty = false;
      }
      if (this.shapeDirty) {
        this.shapeAttr.clearUpdateRanges();
        this.shapeAttr.addUpdateRange(0, this.marks.length * 4);
        this.shapeAttr.needsUpdate = true;
        this.shapeDirty = false;
      }
    } else {
      this.posDirty = false;
      this.colDirty = false;
      this.uvDirty = false;
      this.shapeDirty = false;
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
