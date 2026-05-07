// GroundPrint3D — wheel ruts, tread tracks, and footstep stamps drawn
// onto the ground as fading quads. Same merged-buffer + swap-and-pop
// pattern as BurnMark3D, but sized for ~50× more emitters: one trail
// per wheel/tread side per moving unit, plus one stamp per planted
// foot — vs BurnMark3D's handful of active beams in heavy combat.
//
// The renderer dispatches on each unit's locomotion mesh type:
//   - 'wheels' → 1 trail per tire (4 contacts/unit), miter-joined.
//   - 'treads' → 1 trail per side  (2 contacts/unit), miter-joined.
//   - 'legs'   → discrete stamps emitted on foot lift-off / re-plant.
//
// Color stays constant across a print's lifetime — these are physical
// impressions, not exotherms. Only alpha fades. The shared "MARKS: ALL"
// toggle (getGroundMarks) gates this renderer alongside BurnMark3D.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { getGraphicsConfig, getGroundMarks } from '@/clientBarConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import type { Locomotion3DMesh } from './Locomotion3D';
import type { LegInstance } from './LegRig3D';

// ── Y layout ──
// Sit slightly above the tile floor so the merged geometry always
// wins the depth test against tiles. BurnMark3D uses MARK_Y = 2.5; we
// pick 2.4 so ground prints render *under* burn marks where they
// overlap (a beam scorching the same square a tank just rolled over
// should read as scorch on top of rut).
const MARK_Y = 2.4;

// ── Color ──
// Dark soil compaction. Routed through THREE.Color so the hex (sRGB)
// is converted into linear-RGB for vertex-color writes (matches the
// renderer's working space when ColorManagement is on).
const PRINT_HEX = 0x1a1308;
const PRINT_LIN = new THREE.Color(PRINT_HEX);

// ── Lifetime ──
// Slow rational-exp alpha decay. Tau is longer than burn marks (which
// favor a quick thermal pop) — ruts are physical impressions and
// should hang around a few seconds before fading into the dirt.
const PRINT_FADE_TAU = 1500;
const INV_PRINT_FADE_TAU = 1 / PRINT_FADE_TAU;
const PRINT_INITIAL_ALPHA = 0.7;

// Hard buffer cap — sized to keep the geometry in one draw call at
// the most generous LOD tier. Memory: ~12k × 4 verts × 28 bytes ≈
// 1.3 MB GPU, trivial. Active count is throttled per-tier by the
// LOD-driven cap below; this is just the never-allocate-more ceiling.
const MAX_PRINTS = 12000;

// Miter limit — same PostScript default as BurnMark3D.
const MITER_LIMIT = 3;

// Minimum world distance² between successive trail samples for a new
// quad. Keeps slow / stationary contacts from spamming zero-length
// marks. Larger than BurnMark3D's 4 because tread/wheel contacts move
// every frame even when the unit is barely creeping.
const TRAIL_MIN_SEGMENT_DIST_SQ = 9;

// Minimum world distance² for a leg footprint vs. the previous stamp
// for that same foot. Prevents a foot that re-plants in basically the
// same spot (creep-walking, tiny stride) from stamping every cycle.
const STAMP_MIN_DIST_SQ = 16;

/** LOD-driven cap on active prints. Tiers mirror BurnMark3D's shape
 *  but the absolute counts are higher because the volume is too. */
function getGroundPrintCap(): number {
  const cutoff = getGraphicsConfig().groundPrintAlphaCutoff;
  if (cutoff >= 1) return 0;       // disabled at min tier
  if (cutoff >= 0.5) return 1500;
  if (cutoff >= 0.25) return 4000;
  if (cutoff >= 0.1) return 7500;
  return 12000;
}

// ── Per-trail bookkeeping ──
// Trails (wheels/treads) are miter-joined; we remember the previous
// emitted mark for each (entity, contactIndex) so a new sample can
// rewrite the predecessor's end vertices to share an edge. Stamps
// (legs) just remember the last stamp position to debounce.

type TrailKey = string;

type TrailState = {
  lastEndX: number;
  lastEndY: number;
  lastDirX: number;
  lastDirY: number;
  prevMark: Mark | null;
};

type StampState = {
  lastX: number;
  lastY: number;
  /** True once we've emitted at least one stamp for this foot. The
   *  first plant always stamps regardless of distance. */
  initialized: boolean;
};

type Mark = {
  slot: number;
  age: number;
  removed: boolean;
};

export class GroundPrint3D {
  private root: THREE.Group;

  // Merged geometry — same swap-and-pop layout as BurnMark3D.
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private indices: Uint32Array;
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private posDirty = false;
  private colDirty = false;

  private marks: Mark[] = [];

  /** Trails: keyed `${kind}:${entityId}:${contactIndex}` so wheels
   *  and tread sides on the same unit don't collide. */
  private trails = new Map<TrailKey, TrailState>();
  private _seenTrailKeys = new Set<TrailKey>();

  /** Stamps: per-leg "last printed" debounce, keyed identically. */
  private stamps = new Map<TrailKey, StampState>();
  private _seenStampKeys = new Set<TrailKey>();

  private _frameCounter = 0;
  private scope: ViewportFootprint | null = null;

  constructor(parentWorld: THREE.Group, scope?: ViewportFootprint) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope ?? null;

    this.positions = new Float32Array(MAX_PRINTS * 4 * 3);
    this.colors = new Float32Array(MAX_PRINTS * 4 * 4);
    this.indices = new Uint32Array(MAX_PRINTS * 6);
    for (let i = 0; i < MAX_PRINTS; i++) {
      const vBase = i * 4;
      const iBase = i * 6;
      this.indices[iBase] = vBase;
      this.indices[iBase + 1] = vBase + 1;
      this.indices[iBase + 2] = vBase + 2;
      this.indices[iBase + 3] = vBase;
      this.indices[iBase + 4] = vBase + 2;
      this.indices[iBase + 5] = vBase + 3;
    }

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      // Slightly weaker offset than burn marks so scorches render on
      // top when the two systems overlap the same patch of dirt.
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.mat);
    this.mesh.renderOrder = 9; // < BurnMark3D (10), > terrain.
    // Per-frame position writes don't update the bounding sphere, so
    // an auto-computed (origin, 0) sphere would frustum-cull the mesh
    // any time the camera looks elsewhere. Disable the per-mesh cull
    // — prints can cover the whole map.
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
  }

  /** Per-frame entry point. `units` should already be filtered to the
   *  set of entities with a tracked locomotion mesh; `getMesh`
   *  resolves the renderer's per-unit mesh record so we don't have to
   *  duplicate Render3DEntities's bookkeeping. */
  update(
    units: readonly Entity[],
    getMesh: (e: Entity) => Locomotion3DMesh,
    dtMs: number,
  ): void {
    if (units.length === 0 && this.marks.length === 0 && this.trails.size === 0 && this.stamps.size === 0) {
      return;
    }

    const gfx = getGraphicsConfig();

    const enabled = getGroundMarks();
    if (!enabled) {
      if (this.marks.length > 0) this.clearMarksOnly();
      if (this.trails.size > 0) this.trails.clear();
      if (this.stamps.size > 0) this.stamps.clear();
      this._frameCounter = 0;
      return;
    }

    const cap = getGroundPrintCap();
    if (cap === 0) {
      // LOD MIN tier explicitly disables prints regardless of toggle.
      if (this.marks.length > 0) this.clearMarksOnly();
      this._frameCounter = 0;
      return;
    }

    // Sample stride — same shape as burnMarkFramesSkip.
    const framesSkip = gfx.groundPrintFramesSkip ?? 0;
    const sampleNow = this._frameCounter === 0;
    this._frameCounter = (this._frameCounter + 1) % (framesSkip + 1);

    this._seenTrailKeys.clear();
    this._seenStampKeys.clear();

    for (const e of units) {
      const loc = getMesh(e);
      if (!loc) continue;

      // Off-scope units skip the full sample pass. Width = 200 padding
      // matches BurnMark3D's beam scope check — generous so a unit
      // moving fast doesn't drop prints mid-traverse.
      if (this.scope && !this.scope.inScope(e.transform.x, e.transform.y, 200)) {
        continue;
      }

      switch (loc.type) {
        case 'wheels': {
          for (let i = 0; i < loc.wheelContacts.length; i++) {
            const c = loc.wheelContacts[i];
            if (!c.initialized) continue;
            const key = `wheel:${e.id}:${i}`;
            this._seenTrailKeys.add(key);
            if (sampleNow) {
              this.sampleTrail(key, c.worldX, c.worldZ, loc.printWidth, cap);
            } else {
              this.touchTrail(key, c.worldX, c.worldZ);
            }
          }
          break;
        }
        case 'treads': {
          for (let i = 0; i < loc.treadContacts.length; i++) {
            const c = loc.treadContacts[i];
            if (!c.initialized) continue;
            const key = `tread:${e.id}:${i}`;
            this._seenTrailKeys.add(key);
            if (sampleNow) {
              this.sampleTrail(key, c.worldX, c.worldZ, loc.printWidth, cap);
            } else {
              this.touchTrail(key, c.worldX, c.worldZ);
            }
          }
          break;
        }
        case 'legs': {
          // Legs stamp on plant — a foot is "planted" while
          // !isSliding. We keep a per-leg cursor and emit at most
          // one stamp per plant cycle (the distance gate also skips
          // micro-replants where the foot lands ~where it lifted).
          for (let i = 0; i < loc.legs.length; i++) {
            const leg = loc.legs[i];
            if (!leg.initialized) continue;
            // Mark the key as seen even mid-slide so end-of-frame
            // cleanup preserves this foot's last-stamp position
            // across the lift cycle. Otherwise a foot that lands
            // ~where it took off would re-stamp on every plant.
            const key = `leg:${e.id}:${i}`;
            this._seenStampKeys.add(key);
            if (leg.isSliding) continue;
            this.sampleStamp(key, leg, e.transform.rotation, cap);
          }
          break;
        }
      }
    }

    // Retire trails / stamps for units that disappeared this frame.
    for (const k of this.trails.keys()) {
      if (!this._seenTrailKeys.has(k)) this.trails.delete(k);
    }
    for (const k of this.stamps.keys()) {
      if (!this._seenStampKeys.has(k)) this.stamps.delete(k);
    }

    // ── Age + prune ──
    const cutoff = gfx.groundPrintAlphaCutoff;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mark = this.marks[i];
      mark.age += dtMs;
      const x = mark.age * INV_PRINT_FADE_TAU;
      // Same rational-exp shape as BurnMark3D — gently concave fade.
      const alpha =
        PRINT_INITIAL_ALPHA / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
      if (alpha < cutoff) {
        this.removeMarkAt(i);
        continue;
      }
      this.writeQuadColor(i, PRINT_LIN.r, PRINT_LIN.g, PRINT_LIN.b, alpha);
      this.colDirty = true;
    }

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
    } else {
      this.posDirty = false;
      this.colDirty = false;
    }
  }

  /** A "touch" without sampling: keep the trail's lastEnd / direction
   *  current on a skipped frame so the next sampled frame's miter
   *  computation reflects the true motion since the last quad. */
  private touchTrail(key: TrailKey, ex: number, ez: number): void {
    const state = this.trails.get(key);
    if (!state) return;
    state.lastEndX = ex;
    state.lastEndY = ez;
  }

  /** Append (or first-create) a trail sample. */
  private sampleTrail(
    key: TrailKey,
    ex: number, ez: number,
    width: number,
    cap: number,
  ): void {
    let state = this.trails.get(key);
    if (!state) {
      this.trails.set(key, {
        lastEndX: ex,
        lastEndY: ez,
        lastDirX: 0,
        lastDirY: 0,
        prevMark: null,
      });
      return;
    }
    const dx = ex - state.lastEndX;
    const dz = ez - state.lastEndY;
    const distSq = dx * dx + dz * dz;
    if (distSq <= TRAIL_MIN_SEGMENT_DIST_SQ) return;
    if (this.marks.length >= cap || this.marks.length >= MAX_PRINTS) {
      state.lastEndX = ex;
      state.lastEndY = ez;
      return;
    }
    const invLen = 1 / Math.sqrt(distSq);
    const dirX = dx * invLen;
    const dirZ = dz * invLen;
    this.appendMiteredTrailMark(state, ex, ez, dirX, dirZ, width);
  }

  /** Append a single stamp for a planted foot. Debounced by distance
   *  from the last stamp on this same foot. */
  private sampleStamp(
    key: TrailKey,
    leg: LegInstance,
    bodyRotation: number,
    cap: number,
  ): void {
    const fx = leg.worldX;
    const fz = leg.worldZ;
    let state = this.stamps.get(key);
    if (!state) {
      state = { lastX: fx, lastY: fz, initialized: false };
      this.stamps.set(key, state);
    } else if (state.initialized) {
      const dx = fx - state.lastX;
      const dz = fz - state.lastY;
      if (dx * dx + dz * dz < STAMP_MIN_DIST_SQ) return;
    }
    if (this.marks.length >= cap || this.marks.length >= MAX_PRINTS) return;

    // Stamp aligned with body forward direction at the moment of plant.
    // That makes a row of footprints read like a walking gait rather
    // than a randomly-rotated speckle.
    const cosR = Math.cos(bodyRotation);
    const sinR = Math.sin(bodyRotation);
    const halfL = leg.footPadRadius * 1.4;
    const halfW = leg.footPadRadius * 1.0;
    // Forward axis (cosR, sinR), right-hand perpendicular (-sinR, cosR).
    const fxL = cosR * halfL;
    const fzL = sinR * halfL;
    const rxW = -sinR * halfW;
    const rzW = cosR * halfW;
    const sLx = fx - fxL - rxW;
    const sLz = fz - fzL - rzW;
    const sRx = fx - fxL + rxW;
    const sRz = fz - fzL + rzW;
    const eRx = fx + fxL + rxW;
    const eRz = fz + fzL + rzW;
    const eLx = fx + fxL - rxW;
    const eLz = fz + fzL - rzW;

    const slot = this.marks.length;
    const mark: Mark = { slot, age: 0, removed: false };
    this.marks.push(mark);
    this.writeQuad(slot, sLx, sLz, sRx, sRz, eRx, eRz, eLx, eLz);
    this.writeQuadColor(slot, PRINT_LIN.r, PRINT_LIN.g, PRINT_LIN.b, PRINT_INITIAL_ALPHA);
    this.posDirty = true;
    this.colDirty = true;
    this.geometry.setDrawRange(0, this.marks.length * 6);

    state.lastX = fx;
    state.lastY = fz;
    state.initialized = true;
  }

  /** Mitered-trail append: same algorithm as BurnMark3D.appendMark.
   *  The new quad spans state.lastEnd → (endX, endY); when a previous
   *  live mark exists, both quads share the bisector edge so the
   *  trail is gap- and overlap-free. */
  private appendMiteredTrailMark(
    state: TrailState,
    endX: number, endY: number,
    dirX: number, dirZ: number,
    width: number,
  ): void {
    const halfW = width * 0.5;
    const perpRX = -dirZ;
    const perpRZ = dirX;

    const startCx = state.lastEndX;
    const startCz = state.lastEndY;

    const prev = state.prevMark;
    const haveLivePrev = prev !== null && !prev.removed;
    let sLx: number, sLz: number, sRx: number, sRz: number;

    if (haveLivePrev) {
      const sumX = state.lastDirX + dirX;
      const sumZ = state.lastDirY + dirZ;
      const sumLen = Math.sqrt(sumX * sumX + sumZ * sumZ);
      if (sumLen > 1e-4) {
        let miter = (halfW * 2) / sumLen;
        if (miter > halfW * MITER_LIMIT) miter = halfW * MITER_LIMIT;
        const bX = sumX / sumLen;
        const bZ = sumZ / sumLen;
        const perpBX = -bZ;
        const perpBZ = bX;
        sLx = startCx - perpBX * miter;
        sLz = startCz - perpBZ * miter;
        sRx = startCx + perpBX * miter;
        sRz = startCz + perpBZ * miter;
      } else {
        sLx = startCx - perpRX * halfW;
        sLz = startCz - perpRZ * halfW;
        sRx = startCx + perpRX * halfW;
        sRz = startCz + perpRZ * halfW;
      }
    } else {
      sLx = startCx - perpRX * halfW;
      sLz = startCz - perpRZ * halfW;
      sRx = startCx + perpRX * halfW;
      sRz = startCz + perpRZ * halfW;
    }

    const eLx = endX - perpRX * halfW;
    const eLz = endY - perpRZ * halfW;
    const eRx = endX + perpRX * halfW;
    const eRz = endY + perpRZ * halfW;

    if (haveLivePrev) {
      this.writeQuadEnd(prev!.slot, sRx, sRz, sLx, sLz);
    }

    const slot = this.marks.length;
    const mark: Mark = { slot, age: 0, removed: false };
    this.marks.push(mark);
    this.writeQuad(slot, sLx, sLz, sRx, sRz, eRx, eRz, eLx, eLz);
    this.writeQuadColor(slot, PRINT_LIN.r, PRINT_LIN.g, PRINT_LIN.b, PRINT_INITIAL_ALPHA);

    this.posDirty = true;
    this.colDirty = true;
    this.geometry.setDrawRange(0, this.marks.length * 6);

    state.lastEndX = endX;
    state.lastEndY = endY;
    state.lastDirX = dirX;
    state.lastDirY = dirZ;
    state.prevMark = mark;
  }

  // ── Buffer writers (identical layout to BurnMark3D) ──

  private writeQuad(
    slot: number,
    sLx: number, sLz: number,
    sRx: number, sRz: number,
    eRx: number, eRz: number,
    eLx: number, eLz: number,
  ): void {
    const p = this.positions;
    const b = slot * 12;
    p[b     ] = sLx; p[b +  1] = MARK_Y; p[b +  2] = sLz;
    p[b +  3] = sRx; p[b +  4] = MARK_Y; p[b +  5] = sRz;
    p[b +  6] = eRx; p[b +  7] = MARK_Y; p[b +  8] = eRz;
    p[b +  9] = eLx; p[b + 10] = MARK_Y; p[b + 11] = eLz;
  }

  private writeQuadEnd(
    slot: number,
    eRx: number, eRz: number,
    eLx: number, eLz: number,
  ): void {
    const p = this.positions;
    const b = slot * 12;
    p[b +  6] = eRx; p[b +  7] = MARK_Y; p[b +  8] = eRz;
    p[b +  9] = eLx; p[b + 10] = MARK_Y; p[b + 11] = eLz;
    this.posDirty = true;
  }

  private writeQuadColor(
    slot: number, r: number, g: number, b: number, a: number,
  ): void {
    const c = this.colors;
    const base = slot * 16;
    for (let i = 0; i < 4; i++) {
      const o = base + i * 4;
      c[o] = r; c[o + 1] = g; c[o + 2] = b; c[o + 3] = a;
    }
  }

  private removeMarkAt(i: number): void {
    const last = this.marks.length - 1;
    this.marks[i].removed = true;
    if (i !== last) {
      const moved = this.marks[last];
      const posBase = this.positions;
      const colBase = this.colors;
      const pSrc = last * 12;
      const pDst = i * 12;
      for (let k = 0; k < 12; k++) posBase[pDst + k] = posBase[pSrc + k];
      const cSrc = last * 16;
      const cDst = i * 16;
      for (let k = 0; k < 16; k++) colBase[cDst + k] = colBase[cSrc + k];
      moved.slot = i;
      this.marks[i] = moved;
      this.posDirty = true;
      this.colDirty = true;
    }
    this.marks.pop();
    this.geometry.setDrawRange(0, this.marks.length * 6);
  }

  private clearMarksOnly(): void {
    for (const m of this.marks) m.removed = true;
    this.marks.length = 0;
    this.geometry.setDrawRange(0, 0);
    for (const state of this.trails.values()) state.prevMark = null;
    this.posDirty = false;
    this.colDirty = false;
  }

  destroy(): void {
    this.marks.length = 0;
    this.trails.clear();
    this.stamps.clear();
    this.geometry.dispose();
    this.mat.dispose();
    this.root.parent?.remove(this.root);
  }
}
