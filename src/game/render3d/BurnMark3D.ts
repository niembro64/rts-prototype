// BurnMark3D — ground scorches along laser / beam paths, plus a pulsing
// glow sphere at each live beam's termination point.
//
// Every mark is a 4-vertex quad on the ground plane. When a beam's
// endpoint moves, we append a new quad AND update the previous quad's
// end vertices to the bisector of the two segments — so consecutive
// marks share an edge with no overlap or gap. The first/last quads of a
// trail keep a square cap perpendicular to their segment direction.
//
// All marks live in a single merged BufferGeometry with a vertex-colors
// material, so the entire trail — hundreds of segments — renders in one
// draw call. Slots are managed with swap-and-pop on expiry (O(1)) so
// removing an aged mark doesn't leave gaps.
//
// Colors + LOD (tau, cutoff, sample rate) are pulled from the shared
// config so this stays in lockstep with the 2D BurnMarkSystem.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { getGraphicsConfig, getGroundMarks } from '@/clientBarConfig';
import type { ViewportFootprint } from '../ViewportFootprint';
import {
  BURN_COLOR_HOT,
  BURN_COLOR_TAU,
  BURN_COOL_TAU,
} from '../../config';

// ── World Y layout ──
// Burn marks sit a couple units above the tile layer (y=0). The tile floor
// uses a negative polygonOffset to bias its fragments toward the camera,
// so we apply an even stronger offset to the burn-mark material so marks
// always draw over tiles regardless of depth precision at far zoom.
const MARK_Y = 2.5;

// ── Color curve — matches 2D BurnMarkSystem exactly ──
// Source the color components via THREE.Color so the hex (sRGB) is
// converted to the renderer's working linear space. Writing raw
// `hex/255` bytes as vertex-color floats is WRONG when
// ColorManagement.enabled = true (Three r152+): the renderer re-encodes
// linear → sRGB on output, and raw-sRGB-as-linear comes out visibly
// darker than the 2D counterpart that fillStyle()'s the same hex.
const COOL_COLOR = 0x221100;                      // dark brown residue
const HOT_LIN = new THREE.Color(BURN_COLOR_HOT);  // linear-RGB of 0x882200
const COOL_LIN = new THREE.Color(COOL_COLOR);     // linear-RGB of 0x221100

// Hard buffer size — never need to reallocate. Memory: ~280 KB for
// positions + colors, trivial. The active-count cap below sits inside
// this ceiling and scales with LOD density.
const MAX_MARKS = 5000;

// Constant alpha floor below which a mark is invisible enough to
// reclaim its slot. Decoupled from the LOD tier on purpose: a tier
// flip used to bump this threshold and instantly cull a chunk of
// rendered marks (the "abrupt deletion" the user reported). Now the
// floor is fixed; marks die only when they fade to it via natural
// rational-exp decay.
const BURN_MARK_FADE_FLOOR = 0.01;

// EMA tau (ms) used to smooth the LOD-resolved density so a tier
// flip glides over half a second of frames instead of stepping on
// the very next one.
const DENSITY_EMA_TAU_MS = 300;

// Mapping from density (0..1) to derived throttles. The density
// is EMA-smoothed inside the renderer and these formulas turn it
// into the three concrete knobs (cap, frame-skip, lifetime mult)
// that drive emission, eviction, and fade.
const MAX_BURN_FRAMES_SKIP = 5;     // density=0 → skip 5 of every 6 frames
const BURN_LIFETIME_MULT_AT_ZERO = 0.5; // shortest visible lifetime

// Miter limit: at sharp turns, the miter joint extends far from the
// actual corner. Clamp to 3× halfWidth (PostScript default) so a tight
// zig-zag doesn't produce a spike to infinity.
const MITER_LIMIT = 3;

// Minimum squared distance between prev and current endpoint for a new
// mark — avoids stacking zero-length quads for stationary beams.
const MIN_SEGMENT_DIST_SQ = 4;

// How close the beam endpoint's altitude must be to the ground at that
// (x,y) for the endpoint to count as a ground hit. Beams ending mid-air
// (on a flying unit, on a building side, at the range circle in the
// sky, on a mirror reflector above ground) shouldn't leave scorches on
// the dirt below. A few units of slack covers the beam's own half-width
// and floating-point slop on a sim-authoritative ground hit (which sets
// endpoint.z = getGroundZ(x, y) exactly).
const GROUND_HIT_Z_TOLERANCE = 4;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

type BeamState = {
  lastEndX: number;
  lastEndY: number;
  lastDirX: number;
  lastDirY: number;
  /** Reference to the most recently appended mark for this beam, so the
   *  next sample can miter-join onto it. Null if the beam has no marks
   *  yet (first sample) or if the prev mark was culled by aging. */
  prevMark: Mark | null;
};

type BeamStateKey = number | string;
const BEAM_KEY_TURRET_STRIDE = 1024;

function beamStateKey(sourceEntityId: number, turretIndex: number): BeamStateKey {
  if (
    turretIndex >= 0 &&
    turretIndex < BEAM_KEY_TURRET_STRIDE &&
    Number.isSafeInteger(sourceEntityId)
  ) {
    return sourceEntityId * BEAM_KEY_TURRET_STRIDE + turretIndex;
  }
  return `${sourceEntityId}:${turretIndex}`;
}

type Mark = {
  /** Index into the big buffer (`marks[slot] === this`). Kept explicit so
   *  appending a miter-joined mark can rewrite this mark's end vertices
   *  even after swap-and-pop has moved it. */
  slot: number;
  age: number;
  dirX: number;
  dirY: number;
  /** Cleared when the mark is culled so BeamState.prevMark can tell. */
  removed: boolean;
};

export class BurnMark3D {
  private root: THREE.Group;

  // ── Merged trail geometry ──
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;  // MAX_MARKS × 4 × 3
  private colors: Float32Array;     // MAX_MARKS × 4 × 4 (RGBA)
  private indices: Uint32Array;     // MAX_MARKS × 6 (prebuilt)
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private posDirty = false;
  private colDirty = false;

  // Active marks, packed — `marks[mark.slot] === mark` invariant.
  private marks: Mark[] = [];

  // Per-beam state, keyed by `${sourceEntityId}:${turretIndex}`.
  private beams = new Map<BeamStateKey, BeamState>();
  private _seenBeamKeys = new Set<BeamStateKey>();

  private _frameCounter = 0;
  /** EMA-smoothed copy of the LOD-resolved density. Stays around -1
   *  until the first update so the first frame snaps to the
   *  resolved value rather than easing in from 0. */
  private _smoothedDensity = -1;
  /** Active-count cap derived from `_smoothedDensity` once per
   *  update() call. Cached on the instance so appendMark (called
   *  many times per frame from the beam loop) doesn't have to
   *  recompute from density each time. */
  private _currentCap = 0;

  /** RENDER: WIN/PAD/ALL visibility scope — beams with their endpoint
   *  outside the scope rect skip sampling. */
  private scope: ViewportFootprint | null = null;

  /** Sim-authoritative ground height sampler — used to gate marks so
   *  beams that end in mid-air don't paint phantom scorches on the
   *  dirt below their endpoint. Returns 0 when not provided (legacy
   *  callers / flat maps). */
  private getGroundZ: (x: number, y: number) => number;

  constructor(
    parentWorld: THREE.Group,
    scope?: ViewportFootprint,
    getGroundZ?: (x: number, y: number) => number,
  ) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.scope = scope ?? null;
    this.getGroundZ = getGroundZ ?? (() => 0);

    this.positions = new Float32Array(MAX_MARKS * 4 * 3);
    this.colors = new Float32Array(MAX_MARKS * 4 * 4);
    this.indices = new Uint32Array(MAX_MARKS * 6);
    // Pre-build the index buffer — two triangles per quad (0-1-2, 0-2-3)
    // gives a CCW-wound quad given the (startL, startR, endR, endL) vertex
    // order used throughout.
    for (let i = 0; i < MAX_MARKS; i++) {
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

    // Single material for the whole trail — per-vertex colors encode each
    // mark's age-based shade and alpha. DoubleSide so marks read from a
    // camera under the ground, polygonOffset so they always win the
    // depth test against the capture-tile grid below.
    this.mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.mat);
    this.mesh.renderOrder = 10;
    // The geometry starts with all-zero positions, so its auto-computed
    // bounding sphere is (origin, radius=0) — Three.js frustum-culls it
    // the moment the camera looks anywhere other than world origin.
    // We never auto-recompute on position updates, so just disable the
    // per-mesh culling: burn marks cover the whole map anyway.
    this.mesh.frustumCulled = false;
    this.root.add(this.mesh);
  }

  update(projectiles: readonly Entity[], dtMs: number): void {
    if (projectiles.length === 0 && this.marks.length === 0 && this.beams.size === 0) return;

    // Snapshot the graphics config once per frame.
    const gfx = getGraphicsConfig();

    // The unified MARKS: ALL toggle gates the scorched-earth trail
    // (this renderer) along with wheel/tread/foot prints (GroundPrint3D).
    // When off we wipe any existing trail geometry and skip sampling.
    // Live beam hit indicators / MAX-flare sparks are handled by
    // BeamRenderer3D and are not affected by this toggle.
    const marksEnabled = getGroundMarks();
    if (!marksEnabled) {
      if (this.marks.length > 0) this.clearMarksOnly();
      if (this.beams.size > 0) this.beams.clear();
      this._frameCounter = 0;
      this._smoothedDensity = -1;
      return;
    }

    // ── Density resolution (one knob, three throttles) ──
    // 1) Read the LOD-resolved target density.
    // 2) EMA-smooth it so a tier flip glides instead of stepping —
    //    this is the core fix for "marks vanish abruptly" at
    //    MAX→HIGH. Cap, frame-skip, and lifetime all derive from
    //    the smoothed value.
    const targetDensity = clamp01(gfx.burnMarkDensity ?? 1);
    if (this._smoothedDensity < 0) {
      this._smoothedDensity = targetDensity;
    } else {
      const ema = 1 - Math.exp(-Math.max(0, dtMs) / DENSITY_EMA_TAU_MS);
      this._smoothedDensity += (targetDensity - this._smoothedDensity) * ema;
    }
    const density = this._smoothedDensity;
    const activeCap = Math.min(MAX_MARKS, Math.round(MAX_MARKS * density));
    this._currentCap = activeCap;
    const framesSkip = Math.max(0, Math.round(MAX_BURN_FRAMES_SKIP * (1 - density)));
    const lifeMult =
      BURN_LIFETIME_MULT_AT_ZERO +
      (1 - BURN_LIFETIME_MULT_AT_ZERO) * density;
    const invColorTau = 1 / Math.max(1, BURN_COLOR_TAU * lifeMult);
    const invCoolTau = 1 / Math.max(1, BURN_COOL_TAU * lifeMult);

    // Sample at every (framesSkip + 1)th frame.
    const sampleNow = this._frameCounter === 0;
    this._frameCounter = (this._frameCounter + 1) % (framesSkip + 1);

    this._seenBeamKeys.clear();
    for (const e of projectiles) {
      const proj = e.projectile;
      if (!proj) continue;
      const isDGunTrail = e.dgunProjectile?.isDGun === true && proj.projectileType === 'projectile';
      if (!isDGunTrail && proj.projectileType !== 'beam' && proj.projectileType !== 'laser') continue;

      const turretIndex = proj.config.turretIndex ?? 0;
      const key = isDGunTrail ? `dgun:${e.id}` : beamStateKey(proj.sourceEntityId, turretIndex);
      this._seenBeamKeys.add(key);

      const lastPoint = proj.points && proj.points.length >= 2
        ? proj.points[proj.points.length - 1]
        : undefined;
      const ex = isDGunTrail ? e.transform.x : (lastPoint?.x ?? e.transform.x);
      const ez = isDGunTrail ? e.transform.y : (lastPoint?.y ?? e.transform.y);
      // Scope gate — skip the beam entirely when the endpoint is off-
      // scope. We use generous padding (200) since the endpoint can
      // drift quickly and a strict rect would drop marks mid-sweep.
      if (this.scope && !this.scope.inScope(ex, ez, 200)) continue;
      // Ground-hit gate — beams that terminate on a flying/standing
      // unit, on the side of a building, on an aerial mirror, or at the
      // range circle while still climbing should not scorch the ground.
      // dgun trails ride the terrain, so always sample those. When a
      // beam fails the gate we still keep its key alive (so the beam
      // entry isn't retired-and-recreated each frame) but break the
      // trail: reset prevMark to null and snap lastEnd to the current
      // endpoint so the *next* ground-hit sample starts a fresh square
      // cap instead of stretching a quad through the air gap.
      if (!isDGunTrail) {
        const endZ = lastPoint?.z ?? 0;
        const groundZ = this.getGroundZ(ex, ez);
        if (endZ - groundZ > GROUND_HIT_Z_TOLERANCE) {
          const existing = this.beams.get(key);
          if (existing) {
            existing.prevMark = null;
            existing.lastEndX = ex;
            existing.lastEndY = ez;
            existing.lastDirX = 0;
            existing.lastDirY = 0;
          }
          continue;
        }
      }
      const beamWidth = isDGunTrail
        ? proj.config.shotProfile.visual.burnMarkWidth
        : proj.config.shotProfile.visual.burnMarkWidth || 4;

      let state = this.beams.get(key);
      if (!state) {
        state = {
          lastEndX: ex,
          lastEndY: ez,
          lastDirX: 0,
          lastDirY: 0,
          prevMark: null,
        };
        this.beams.set(key, state);
      } else if (sampleNow) {
        const dx = ex - state.lastEndX;
        const dz = ez - state.lastEndY;
        if (dx * dx + dz * dz > MIN_SEGMENT_DIST_SQ) {
          const invLen = 1 / Math.sqrt(dx * dx + dz * dz);
          const dirX = dx * invLen;
          const dirZ = dz * invLen;
          this.appendMark(state, ex, ez, dirX, dirZ, beamWidth);
        }
      }

    }

    // Retire beams that went away this frame.
    for (const [key] of this.beams) {
      if (!this._seenBeamKeys.has(key)) {
        this.beams.delete(key);
      }
    }

    // ── Age + prune marks ──
    // Deletion threshold is the constant fade floor, NOT the LOD
    // tier. So a tier flip (e.g. MAX→HIGH) doesn't suddenly cull
    // every mark in a wide alpha band — marks always fade out
    // along the same per-mark curve and only get reclaimed once
    // they're effectively invisible.
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mark = this.marks[i];
      mark.age += dtMs;
      const xCool = mark.age * invCoolTau;
      const alpha =
        1 / (1 + xCool + 0.48 * xCool * xCool + 0.235 * xCool * xCool * xCool);
      if (alpha < BURN_MARK_FADE_FLOOR) {
        this.removeMarkAt(i);
        continue;
      }
      // Color: hot → cool over BURN_COLOR_TAU * lifeMult.
      const xHot = mark.age * invColorTau;
      const hotDecay =
        1 / (1 + xHot + 0.48 * xHot * xHot + 0.235 * xHot * xHot * xHot);
      const coolBlend = 1 - hotDecay;
      const r = HOT_LIN.r * hotDecay + COOL_LIN.r * coolBlend;
      const g = HOT_LIN.g * hotDecay + COOL_LIN.g * coolBlend;
      const b = HOT_LIN.b * hotDecay + COOL_LIN.b * coolBlend;
      this.writeQuadColor(i, r, g, b, alpha);
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

  /** Append one mitered quad to the trail. `appendX/Y` is the NEW endpoint;
   *  the quad spans state.lastEndX/Y → appendX/Y with width beamWidth.
   *  Updates the previous mark's end vertices (if live) so the two quads
   *  share an edge with no overlap. */
  private appendMark(
    state: BeamState,
    endX: number, endY: number,
    dirX: number, dirZ: number,
    width: number,
  ): void {
    // LOD-driven cap — if full, just drop this sample. Aging will free
    // slots soon enough.
    if (this.marks.length >= this._currentCap || this.marks.length >= MAX_MARKS) {
      state.lastEndX = endX;
      state.lastEndY = endY;
      state.lastDirX = dirX;
      state.lastDirY = dirZ;
      return;
    }

    const halfW = width * 0.5;
    // Right-hand perpendicular of the NEW segment direction (XZ plane).
    const perpRX = -dirZ;
    const perpRZ = dirX;

    const startCx = state.lastEndX;
    const startCz = state.lastEndY;

    // ── Start vertices: miter onto previous mark if there is one alive ──
    const prev = state.prevMark;
    const haveLivePrev = prev !== null && !prev.removed;
    let sLx: number, sLz: number, sRx: number, sRz: number;

    if (haveLivePrev) {
      // Bisector of (prevDir + newDir). Its length = 2·cos(θ/2) where θ is
      // the turn angle. The miter offset along the bisector's
      // perpendicular is halfW * 2 / |sum|.
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
        // Degenerate (180° turn) — fall back to square cap.
        sLx = startCx - perpRX * halfW;
        sLz = startCz - perpRZ * halfW;
        sRx = startCx + perpRX * halfW;
        sRz = startCz + perpRZ * halfW;
      }
    } else {
      // Square start cap — no live predecessor.
      sLx = startCx - perpRX * halfW;
      sLz = startCz - perpRZ * halfW;
      sRx = startCx + perpRX * halfW;
      sRz = startCz + perpRZ * halfW;
    }

    // ── End vertices: square cap. Rewritten later when a successor joins. ──
    const eLx = endX - perpRX * halfW;
    const eLz = endY - perpRZ * halfW;
    const eRx = endX + perpRX * halfW;
    const eRz = endY + perpRZ * halfW;

    // Rewrite predecessor's end vertices to match the shared miter edge.
    if (haveLivePrev) {
      this.writeQuadEnd(prev!.slot, sRx, sRz, sLx, sLz);
    }

    // Allocate the new slot and write its vertex data.
    const slot = this.marks.length;
    const mark: Mark = {
      slot,
      age: 0,
      dirX,
      dirY: dirZ,
      removed: false,
    };
    this.marks.push(mark);
    this.writeQuad(slot, sLx, sLz, sRx, sRz, eRx, eRz, eLx, eLz);
    // Fresh marks render at hot color + full alpha — age sweep will take
    // over from the next frame. Writing once here avoids a 1-frame flicker.
    this.writeQuadColor(slot, HOT_LIN.r, HOT_LIN.g, HOT_LIN.b, 1);

    this.posDirty = true;
    this.colDirty = true;
    this.geometry.setDrawRange(0, this.marks.length * 6);

    state.lastEndX = endX;
    state.lastEndY = endY;
    state.lastDirX = dirX;
    state.lastDirY = dirZ;
    state.prevMark = mark;
  }

  // ── Buffer writers ──
  // Quad vertex order: 0=startL, 1=startR, 2=endR, 3=endL (matches the
  // index buffer: tris [0,1,2] and [0,2,3] form a CCW quad).

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

  /** Rewrite just the end-side two vertices of a quad. Used when a new
   *  mark joins this one — the shared edge becomes the bisector. */
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

  /** Remove the mark at slot index `i`. Swap the last active mark into
   *  slot `i` (copying its buffer data) and pop — O(1). */
  private removeMarkAt(i: number): void {
    const last = this.marks.length - 1;
    this.marks[i].removed = true;
    if (i !== last) {
      const moved = this.marks[last];
      // Copy position + color data from `last` into `i`.
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

  /** Wipe only the scorched-trail geometry. The next sample starts a
   *  fresh square cap if the toggle flips back on. */
  private clearMarksOnly(): void {
    for (const m of this.marks) m.removed = true;
    this.marks.length = 0;
    this.geometry.setDrawRange(0, 0);
    for (const state of this.beams.values()) state.prevMark = null;
    this.posDirty = false;
    this.colDirty = false;
  }

  destroy(): void {
    this.marks.length = 0;
    this.beams.clear();
    this.geometry.dispose();
    this.mat.dispose();
    this.root.parent?.remove(this.root);
  }
}
