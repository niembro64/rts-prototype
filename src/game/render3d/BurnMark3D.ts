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
import { isLineShot } from '../sim/types';
import { getGraphicsConfig, getBurnMarks } from '@/clientBarConfig';
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
const GLOW_Y = 3.0;

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
const INV_COLOR_TAU = 1 / BURN_COLOR_TAU;         // hot → cool fade
const INV_COOL_TAU = 1 / BURN_COOL_TAU;           // alpha fade

// Hard buffer size — sized for the maximum `burnMarkAlphaCutoff` tier
// (0.01 → 5000 marks) so we never need to reallocate. Memory: ~280 KB
// for positions + colors, trivial.
const MAX_MARKS = 5000;

// Miter limit: at sharp turns, the miter joint extends far from the
// actual corner. Clamp to 3× halfWidth (PostScript default) so a tight
// zig-zag doesn't produce a spike to infinity.
const MITER_LIMIT = 3;

// Minimum squared distance between prev and current endpoint for a new
// mark — avoids stacking zero-length quads for stationary beams.
const MIN_SEGMENT_DIST_SQ = 4;

/** LOD-driven cap on active marks — same tiers as 2D `getBurnMarkCap`. */
function getBurnMarkCap(): number {
  const cutoff = getGraphicsConfig().burnMarkAlphaCutoff;
  if (cutoff >= 1) return 300;
  if (cutoff >= 0.5) return 800;
  if (cutoff >= 0.3) return 2000;
  if (cutoff >= 0.1) return 3500;
  return 5000;
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
  /** Static white hit-core sphere at the beam terminus. */
  glow?: THREE.Mesh;
  /** MAX-only white orbital sparks around the hit point. Active only
   *  when gfx.beamGlow is true; recycled to the pool otherwise. */
  flareSparks?: THREE.Mesh[];
};

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

  // Active marks, packed — `marks[mark.slot] === mark` invariant.
  private marks: Mark[] = [];

  // ── Hit glow sphere (lives separate from the trail mesh) ──
  private glowGeom = new THREE.SphereGeometry(1, 16, 12);
  private glowMat: THREE.MeshBasicMaterial;
  private glowPool: THREE.Mesh[] = [];

  // ── MAX-LOD orbital flare sparks (rotate around the hit point) ──
  // All-white to match the "hit indicator is entirely white" rule —
  // team identity comes from the shooter, not from the hit visual.
  // Small sphere; cheaper tessellation than the core glow since each
  // spark is much smaller on screen.
  private sparkGeom = new THREE.SphereGeometry(1, 8, 6);
  private sparkMat: THREE.MeshBasicMaterial;
  // Flat pool of spark meshes. Pulled from on allocate, pushed back on
  // beam retire / MAX disable.
  private sparkPool: THREE.Mesh[] = [];
  /** Number of orbiting sparks per MAX-LOD hit (matches 2D's
   *  'detailed' tier count; 'complex' uses 6 but that feels busy in 3D). */
  private readonly FLARE_SPARK_COUNT = 4;

  // Per-beam state, keyed by `${sourceEntityId}:${turretIndex}`.
  private beams = new Map<string, BeamState>();
  private _seenBeamKeys = new Set<string>();

  private _frameCounter = 0;
  private _time = 0;

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);

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

    // Hit-glow sphere is pure white — matches the 2D ProjectileRenderer's
    // white hit core (`0xffffff` @ alpha 0.5). Slightly higher alpha here
    // since the 3D sphere is volumetric and benefits from a brighter read
    // against the ground plane.
    this.glowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    // Orbital sparks are the same pure white as the core — the whole
    // hit indicator stays team-agnostic.
    this.sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
  }

  update(projectiles: readonly Entity[], dtMs: number): void {
    this._time += dtMs;

    // Snapshot the graphics config once per frame — the hot path below
    // reads burnMarkFramesSkip / burnMarkAlphaCutoff / beamGlow so
    // re-querying it per beam would multiply the config lookup cost.
    const gfx = getGraphicsConfig();

    // The MARKS: BURN toggle gates *only* the scorched-earth trail, not
    // the live beam hit indicators or the MAX-flare sparks — those are a
    // separate "this is where the beam is hitting" visual that should
    // always show for active beams. When the toggle is off we wipe any
    // existing trail geometry and skip sampling, but keep the per-beam
    // update below (glow + sparks) running.
    const marksEnabled = getBurnMarks();
    if (!marksEnabled && this.marks.length > 0) {
      this.clearMarksOnly();
    }

    // Sample at every (framesSkip + 1)th frame.
    const framesSkip = gfx.burnMarkFramesSkip ?? 0;
    const sampleNow = marksEnabled && this._frameCounter === 0;
    if (marksEnabled) {
      this._frameCounter = (this._frameCounter + 1) % (framesSkip + 1);
    } else {
      this._frameCounter = 0;
    }

    this._seenBeamKeys.clear();
    for (const e of projectiles) {
      const proj = e.projectile;
      if (!proj) continue;
      if (proj.projectileType !== 'beam' && proj.projectileType !== 'laser') continue;

      const turretIndex = proj.config.turretIndex ?? 0;
      const key = `${proj.sourceEntityId}:${turretIndex}`;
      this._seenBeamKeys.add(key);

      const ex = proj.endX ?? e.transform.x;
      const ez = proj.endY ?? e.transform.y;
      const shot = proj.config.shot;
      const beamWidth = isLineShot(shot) ? shot.width * 2 : 4;

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

      // Live hit-core sphere at the current endpoint. Static size — the
      // 2D hit indicator doesn't pulse, so neither does this one.
      if (!state.glow) {
        let glow = this.glowPool.pop();
        if (!glow) {
          glow = new THREE.Mesh(this.glowGeom, this.glowMat);
          glow.renderOrder = 11;
          this.root.add(glow);
        } else {
          glow.visible = true;
        }
        state.glow = glow;
      }
      const coreR = Math.max(beamWidth * 3, 6);
      state.glow.position.set(ex, GLOW_Y, ez);
      state.glow.scale.setScalar(coreR);

      // MAX-only flare — 4 team-colored sparks orbiting the hit point,
      // same idea as the 2D ProjectileRenderer's 'detailed' orbital
      // sparks. Rotates slowly so the hit reads as "active" without any
      // pulse on the core itself.
      if (gfx.beamGlow) {
        this.ensureFlareSparks(state);
        const baseAngle = this._time * 0.003;
        const orbit = coreR * 1.8;
        const sparkR = Math.max(beamWidth * 0.8, 1.5);
        const sparks = state.flareSparks!;
        const step = (Math.PI * 2) / sparks.length;
        for (let i = 0; i < sparks.length; i++) {
          const angle = baseAngle + i * step;
          const sx = ex + Math.cos(angle) * orbit;
          const sz = ez + Math.sin(angle) * orbit;
          const spark = sparks[i];
          spark.position.set(sx, GLOW_Y, sz);
          spark.scale.setScalar(sparkR);
        }
      } else if (state.flareSparks) {
        // LOD dropped below MAX — recycle the sparks.
        this.releaseFlareSparks(state);
      }
    }

    // Retire beams that went away this frame — return their glow +
    // orbital sparks to the pools.
    for (const [key, state] of this.beams) {
      if (!this._seenBeamKeys.has(key)) {
        if (state.glow) {
          state.glow.visible = false;
          this.glowPool.push(state.glow);
        }
        if (state.flareSparks) this.releaseFlareSparks(state);
        this.beams.delete(key);
      }
    }

    // ── Age + prune marks — skipped entirely when the trail is disabled. ──
    if (!marksEnabled) return;
    const cutoff = gfx.burnMarkAlphaCutoff;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mark = this.marks[i];
      mark.age += dtMs;
      const xCool = mark.age * INV_COOL_TAU;
      const alpha =
        1 / (1 + xCool + 0.48 * xCool * xCool + 0.235 * xCool * xCool * xCool);
      if (alpha < cutoff) {
        this.removeMarkAt(i);
        continue;
      }
      // Color: hot → cool over BURN_COLOR_TAU (same rational-exp curve 2D uses).
      const xHot = mark.age * INV_COLOR_TAU;
      const hotDecay =
        1 / (1 + xHot + 0.48 * xHot * xHot + 0.235 * xHot * xHot * xHot);
      const coolBlend = 1 - hotDecay;
      const r = HOT_LIN.r * hotDecay + COOL_LIN.r * coolBlend;
      const g = HOT_LIN.g * hotDecay + COOL_LIN.g * coolBlend;
      const b = HOT_LIN.b * hotDecay + COOL_LIN.b * coolBlend;
      this.writeQuadColor(i, r, g, b, alpha);
    }

    if (this.marks.length > 0) this.colAttr.needsUpdate = true;
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
    if (this.marks.length >= getBurnMarkCap() || this.marks.length >= MAX_MARKS) {
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

    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
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
    this.posAttr.needsUpdate = true;
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
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
    }
    this.marks.pop();
    this.geometry.setDrawRange(0, this.marks.length * 6);
  }

  /** Lazily create the FLARE_SPARK_COUNT orbital sparks for a beam,
   *  pulling from the flat pool when available. All sparks share the
   *  single white `sparkMat` — the hit indicator is intentionally team-
   *  agnostic (like the 2D ProjectileRenderer's white hit-core). */
  private ensureFlareSparks(state: BeamState): void {
    if (state.flareSparks) return;
    const sparks: THREE.Mesh[] = [];
    for (let i = 0; i < this.FLARE_SPARK_COUNT; i++) {
      let mesh = this.sparkPool.pop();
      if (!mesh) {
        mesh = new THREE.Mesh(this.sparkGeom, this.sparkMat);
        mesh.renderOrder = 11;
        this.root.add(mesh);
      } else {
        mesh.visible = true;
      }
      sparks.push(mesh);
    }
    state.flareSparks = sparks;
  }

  /** Release this beam's sparks back to the shared pool. */
  private releaseFlareSparks(state: BeamState): void {
    if (!state.flareSparks) return;
    for (const s of state.flareSparks) {
      s.visible = false;
      this.sparkPool.push(s);
    }
    state.flareSparks = undefined;
  }

  /** Wipe only the scorched-trail geometry — leaves beam state, glows,
   *  and orbital sparks alive so the user can keep seeing the hit
   *  indicator while the toggle is off. */
  private clearMarksOnly(): void {
    for (const m of this.marks) m.removed = true;
    this.marks.length = 0;
    this.geometry.setDrawRange(0, 0);
    // Per-beam mark chain pointer is no longer valid; null it so the
    // next sample starts a fresh square cap if the toggle flips back on.
    for (const state of this.beams.values()) state.prevMark = null;
  }

  destroy(): void {
    for (const glow of this.glowPool) this.root.remove(glow);
    for (const spark of this.sparkPool) this.root.remove(spark);
    for (const state of this.beams.values()) {
      if (state.glow) this.root.remove(state.glow);
      if (state.flareSparks) for (const s of state.flareSparks) this.root.remove(s);
    }
    this.marks.length = 0;
    this.glowPool.length = 0;
    this.sparkPool.length = 0;
    this.beams.clear();
    this.geometry.dispose();
    this.glowGeom.dispose();
    this.sparkGeom.dispose();
    this.mat.dispose();
    this.glowMat.dispose();
    this.sparkMat.dispose();
    this.root.parent?.remove(this.root);
  }
}
