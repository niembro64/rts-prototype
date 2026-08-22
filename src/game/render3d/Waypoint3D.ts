// Waypoint3D — command-queue visuals as native Three.js geometry.
//
// Replaces the SVG WaypointOverlay. All marks live in the 3D scene
// at terrain elevation, so the depth buffer takes care of "the
// waypoint is behind a hill" automatically — no per-vertex
// occlusion test, no SVG layer.
//
// Hierarchy:
//   - One THREE.LineSegments holding every path line + every
//     rectangle outline. Per-vertex RGB colors, alpha pre-multiplied
//     into the color (the scene clears to a dark color so the
//     "darker = more transparent" approximation reads correctly).
//     Lines are subdivided in world coords to follow the terrain
//     curve so a long path over hills doesn't dip through them.
//   - One THREE.Points for movement / patrol / fight dots. Per-
//     vertex colors, fixed pixel size (sizeAttenuation = false).
//   - A small sprite pool for factory-rally flags — each flag
//     gets a cheap canvas-rendered triangle on a pole, recolored
//     only when the team color actually changes.

import * as THREE from 'three';
import type { Entity, UnitAction } from '../sim/types';
import { COLORS } from '@/colorsConfig';
import { ACTION_COLORS, WAYPOINT_COLORS } from '../uiLabels';
import { getTerrainBedHeight } from '../sim/Terrain';
import { LAND_CELL_SIZE, WAYPOINT_GROUND_LIFT } from '../../config';
import { getWaypointDetail } from '../../clientBarConfig';
import {
  getBuildingVisualCenterZ,
  getEntityTargetPoint,
} from '../sim/buildingAnchors';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { hexToRgb01, writeHexToRgb01Array } from './colorUtils';
import {
  CanvasSpritePool,
  type CanvasSpritePoolTelemetry,
  type CanvasSpriteSlot,
} from './CanvasSpritePool';
import type { OverlayLineSystem } from './OverlayLineSystem';
import type { GroundLineBatch3D } from './GroundLineBatch3D';

const WAYPOINT_FLAG_MAX_RETAINED_SPRITES = 64;
const WAYPOINT_FLAG_SHRINK_COOLDOWN_FRAMES = 120;
const WAYPOINT_LABEL_MAX_RETAINED_SPRITES = 128;
const WAYPOINT_LABEL_SHRINK_COOLDOWN_FRAMES = 120;

const STYLE = {
  /** Vertical lift above the terrain so lines / dots / flags clear
   *  terrain overlays while still getting
   *  depth-occluded by intervening hills. */
  worldLift: WAYPOINT_GROUND_LIFT,
  /** Maximum world-unit length of one line sub-segment. Long lines
   *  are subdivided so they hug the terrain instead of cutting
   *  through it as a straight chord. */
  subStep: 30,
  /** Initial buffer capacity for line segments. Grows in-place
   *  if a frame ever needs more. */
  initialLineCap: 1024,
  /** Initial buffer capacity for dot vertices. */
  initialDotCap: 256,
  /** Pixel size for dots (sizeAttenuation = false → constant). */
  dotPixelSize: 8,
  /** Alpha multiplier for normal action / waypoint lines. */
  lineAlpha: 0.6,
  /** Alpha multiplier for the patrol-return arc (the loop-back). */
  patrolReturnAlpha: 0.3,
  /** Maximum world-unit spacing between samples along a DETAILED-SMOOTH
   *  curve. Finer than subStep so the bend itself, not just the terrain,
   *  sets the tessellation. */
  smoothSampleStep: 10,
  /** Square size for build / repair markers, in world units. */
  rectWorldSize: 18,
  /** Flag sprite size in world units. */
  flagWorldSize: 14,
  /** Queue-order label sprite size in world units. */
  labelWorldSize: 12,
};

type FlagState = {
  /** Last hex color we drew so we skip canvas work between frames. */
  lastColor: number;
};

type FlagSlot = CanvasSpriteSlot<FlagState>;

type LabelState = {
  lastColor: number;
  lastText: string;
};

type LabelSlot = CanvasSpriteSlot<LabelState>;

type ActionDisplayPoint = {
  x: number;
  y: number;
  /** The live target's 3D anchor height (transform.z for units, visual
   *  top for buildings), so entity-targeted legs can stem up off the
   *  ground route to where the target actually is. */
  z?: number;
  target?: Entity;
};

/** One vertex of a unit's threaded route polyline. `color` is the color of
 *  the leg ARRIVING at this point, so each drawn span inherits the color of
 *  its destination — same convention the straight-line draw always used.
 *  `major` marks the authored nodes — the unit's own position and every
 *  command point the player placed — as opposed to the MINOR sub-points the
 *  pathfinder threaded between them. Smoothing rounds only the minor ones. */
type RoutePoint = {
  x: number;
  y: number;
  color: number;
  major: boolean;
};

function configureFlagSprite(slot: FlagSlot): void {
  slot.sprite.scale.set(STYLE.flagWorldSize, STYLE.flagWorldSize, 1);
}

function repaintFlag(slot: FlagSlot, color: number): boolean {
  if (slot.state.lastColor === color) return false;
  slot.state.lastColor = color;
  const css = `#${color.toString(16).padStart(6, '0')}`;
  const ctx = slot.ctx;
  ctx.clearRect(0, 0, 32, 32);
  // Vertical pole on the left, triangle flag pointing right.
  ctx.fillStyle = COLORS.effects.waypoint.flagPole.cssColor;
  ctx.fillRect(7, 4, 2, 24);
  ctx.fillStyle = css;
  ctx.beginPath();
  ctx.moveTo(9, 4);
  ctx.lineTo(26, 11);
  ctx.lineTo(9, 18);
  ctx.closePath();
  ctx.fill();
  return true;
}

function configureLabelSprite(slot: LabelSlot): void {
  slot.sprite.scale.set(STYLE.labelWorldSize, STYLE.labelWorldSize, 1);
}

function repaintLabel(slot: LabelSlot, text: string, color: number): boolean {
  if (slot.state.lastText === text && slot.state.lastColor === color) return false;
  slot.state.lastText = text;
  slot.state.lastColor = color;
  const ctx = slot.ctx;
  ctx.clearRect(0, 0, 32, 32);
  ctx.fillStyle = 'rgba(7, 10, 14, 0.74)';
  ctx.beginPath();
  ctx.arc(16, 16, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.stroke();
  ctx.fillStyle = COLORS.ui.selectionPanel.surface.text;
  ctx.font = text.length > 1 ? 'bold 13px monospace' : 'bold 15px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 16, 16);
  return true;
}

export class Waypoint3D {
  private parent: THREE.Group;
  private mapWidth: number;
  private mapHeight: number;
  private getEntity?: (id: number) => Entity | undefined;

  // Line buffer (path segments + rect outlines) — screen-space 3D ribbons.
  private lineBatch: GroundLineBatch3D;
  private readonly lineWidthPx: number;
  /** Waypoints draw before transparent water so terrain-level paths remain
   * visible through it while terrain depth still hides them behind hills. */
  private readonly renderOrder: number;

  // Point buffer (dot markers).
  private dotGeom: THREE.BufferGeometry;
  private dotPositions: Float32Array;
  private dotColors: Float32Array;
  private dotMesh: THREE.Points;
  private dotCap: number;

  // Pooled flag sprites.
  private flagPool: CanvasSpritePool<FlagState, [number]>;
  private labelPool: CanvasSpritePool<LabelState, [string, number]>;
  private hadVisible = false;

  constructor(
    parent: THREE.Group,
    mapWidth: number,
    mapHeight: number,
    overlayLines: OverlayLineSystem,
    getEntity?: (id: number) => Entity | undefined,
  ) {
    this.parent = parent;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.getEntity = getEntity;
    const waypointStyle = overlayLines.style('waypoint');
    this.lineWidthPx = waypointStyle.widthPx;
    this.renderOrder = waypointStyle.renderOrder;
    this.lineBatch = overlayLines.createBatch('waypoint', STYLE.initialLineCap);
    parent.add(this.lineBatch.mesh);
    this.flagPool = new CanvasSpritePool<FlagState, [number]>({
      parent,
      canvasWidth: 32,
      canvasHeight: 32,
      debugName: 'Waypoint3D',
      maxRetainedSlots: WAYPOINT_FLAG_MAX_RETAINED_SPRITES,
      emptyRetainedSlots: 0,
      shrinkCooldownFrames: WAYPOINT_FLAG_SHRINK_COOLDOWN_FRAMES,
      shrinkBatchSize: 16,
      renderOrder: this.renderOrder,
      makeState: () => ({ lastColor: -1 }),
      configureSprite: configureFlagSprite,
      repaint: repaintFlag,
    });
    this.labelPool = new CanvasSpritePool<LabelState, [string, number]>({
      parent,
      canvasWidth: 32,
      canvasHeight: 32,
      debugName: 'WaypointLabels3D',
      maxRetainedSlots: WAYPOINT_LABEL_MAX_RETAINED_SPRITES,
      emptyRetainedSlots: 0,
      shrinkCooldownFrames: WAYPOINT_LABEL_SHRINK_COOLDOWN_FRAMES,
      shrinkBatchSize: 24,
      renderOrder: this.renderOrder,
      makeState: () => ({ lastColor: -1, lastText: '' }),
      configureSprite: configureLabelSprite,
      repaint: repaintLabel,
      material: { depthTest: true },
    });

    // Dots.
    this.dotCap = STYLE.initialDotCap;
    this.dotPositions = new Float32Array(this.dotCap * 3);
    this.dotColors = new Float32Array(this.dotCap * 3);
    this.dotGeom = new THREE.BufferGeometry();
    this.dotGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.dotPositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.dotGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.dotColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    // Same as the line geom above: dots default to (0,0,0) black, and
    // PointsMaterial here has sizeAttenuation:false, so without an
    // initial empty draw range every uninitialized dot stacks into a
    // single constant-screen-pixel black square at the origin.
    this.dotGeom.setDrawRange(0, 0);
    const dotMat = new THREE.PointsMaterial({
      vertexColors: true,
      size: STYLE.dotPixelSize,
      sizeAttenuation: false,
      transparent: false,
      depthTest: true,
    });
    this.dotMesh = new THREE.Points(this.dotGeom, dotMat);
    this.dotMesh.frustumCulled = false;
    this.dotMesh.renderOrder = this.renderOrder;
    parent.add(this.dotMesh);
  }

  // ── helpers ──────────────────────────────────────────────────────

  /** Resolve every waypoint visual against terrain, never the water plane
   * or a stored legacy click altitude. */
  private resolveY(x: number, y: number): number {
    return getTerrainBedHeight(x, y, this.mapWidth, this.mapHeight, LAND_CELL_SIZE)
      + STYLE.worldLift;
  }

  private growDotCap(needed: number): void {
    let cap = this.dotCap;
    while (cap < needed) cap *= 2;
    if (cap === this.dotCap) return;
    this.dotCap = cap;
    this.dotPositions = new Float32Array(cap * 3);
    this.dotColors = new Float32Array(cap * 3);
    this.dotGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.dotPositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.dotGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.dotColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
  }

  /** Push one straight 3D line segment endpoint pair into the buffer as a
   *  constant-width screen-space ribbon (sim x/y → world x/z, height → world y). */
  private pushSegment(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number, g: number, b: number, a: number,
  ): void {
    this.lineBatch.pushSegment(ax, az, ay, bx, bz, by, r, g, b, a, this.lineWidthPx);
  }

  /** Push a long line A→B as several short sub-segments that follow
   *  the terrain so the line hugs the ground instead of cutting
   *  through hills. Every sample uses the terrain bed, including beneath
   *  water, so a line cannot rise onto the water plane. */
  private pushTerrainLine(
    ax: number, ay: number, bx: number, by: number,
    color: number, alpha: number,
  ): void {
    const c = hexToRgb01(color);
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(length / STYLE.subStep));
    let prevX = ax;
    let prevY = ay;
    let prevZ = this.resolveY(prevX, prevY);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = ax + dx * t;
      const ny = ay + dy * t;
      const nz = this.resolveY(nx, ny);
      this.pushSegment(prevX, prevY, prevZ, nx, ny, nz, c.r, c.g, c.b, alpha);
      prevX = nx; prevY = ny; prevZ = nz;
    }
  }

  /** Draw a threaded route polyline. Sharp mode connects consecutive points
   *  with straight terrain-hugging lines. Smooth mode bends through every
   *  interior MINOR point with a cubic Hermite whose unit tangent is normal
   *  to the corner's angle bisector — i.e. the normalized sum of the incoming
   *  and outgoing segment directions — so the curve passes exactly through
   *  each point at exactly that angle, never cutting the corner. MAJOR points
   *  (the unit and the player's own command points) instead keep the one-
   *  sided direction of each adjacent span, so the curve arrives and leaves
   *  along the straight leg and the authored corner stays as sharp as it is
   *  in SHARP mode — a leg with major ends and no pathfinder sub-points is
   *  drawn dead straight. Endpoints keep their single segment's direction;
   *  tangent magnitude is the span's chord length (Catmull-Rom-style) so
   *  bend radius scales with leg length. */
  private pushRoute(route: readonly RoutePoint[], smooth: boolean): void {
    const n = route.length;
    if (n < 2) return;
    if (!smooth) {
      for (let i = 1; i < n; i++) {
        const a = route[i - 1];
        const b = route[i];
        this.pushTerrainLine(a.x, a.y, b.x, b.y, b.color, STYLE.lineAlpha);
      }
      return;
    }
    // Unit direction of each span; zero-length spans keep (0,0) and are
    // absorbed by the fallbacks below.
    const sdx = new Float64Array(n - 1);
    const sdy = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dx = route[i + 1].x - route[i].x;
      const dy = route[i + 1].y - route[i].y;
      const l = Math.hypot(dx, dy);
      if (l > 1e-6) {
        sdx[i] = dx / l;
        sdy[i] = dy / l;
      }
    }
    // Per-point unit tangents, split into the one used arriving at the point
    // (the m1 of the span before it) and the one used leaving it (the m0 of
    // the span after it). They differ only at MAJOR points, which is what
    // keeps authored corners sharp. Degenerate corners (exact reversals,
    // duplicate points) fall back to whichever adjacent direction exists.
    const inx = new Float64Array(n);
    const iny = new Float64Array(n);
    const outx = new Float64Array(n);
    const outy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const hasPrev = i > 0 && (sdx[i - 1] !== 0 || sdy[i - 1] !== 0);
      const hasNext = i < n - 1 && (sdx[i] !== 0 || sdy[i] !== 0);
      // Bisector tangent — the smooth one.
      let bx = 0;
      let by = 0;
      if (hasPrev) {
        bx += sdx[i - 1];
        by += sdy[i - 1];
      }
      if (hasNext) {
        bx += sdx[i];
        by += sdy[i];
      }
      const l = Math.hypot(bx, by);
      if (l > 1e-6) {
        bx /= l;
        by /= l;
      } else if (hasNext) {
        bx = sdx[i];
        by = sdy[i];
      } else if (hasPrev) {
        bx = sdx[i - 1];
        by = sdy[i - 1];
      } else {
        bx = 0;
        by = 0;
      }
      if (route[i].major) {
        inx[i] = hasPrev ? sdx[i - 1] : bx;
        iny[i] = hasPrev ? sdy[i - 1] : by;
        outx[i] = hasNext ? sdx[i] : bx;
        outy[i] = hasNext ? sdy[i] : by;
      } else {
        inx[i] = bx;
        iny[i] = by;
        outx[i] = bx;
        outy[i] = by;
      }
    }
    for (let i = 1; i < n; i++) {
      const a = route[i - 1];
      const b = route[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      // Major-to-major span: both tangents are this span's own direction, so
      // the Hermite degenerates to the straight chord. Draw it as one line
      // and skip the curve tessellation entirely.
      if (a.major && b.major) {
        this.pushTerrainLine(a.x, a.y, b.x, b.y, b.color, STYLE.lineAlpha);
        continue;
      }
      const steps = Math.max(1, Math.ceil(len / STYLE.smoothSampleStep));
      const m0x = outx[i - 1] * len;
      const m0y = outy[i - 1] * len;
      const m1x = inx[i] * len;
      const m1y = iny[i] * len;
      let px = a.x;
      let py = a.y;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2 * t3 - 3 * t2 + 1;
        const h10 = t3 - 2 * t2 + t;
        const h01 = -2 * t3 + 3 * t2;
        const h11 = t3 - t2;
        const cx = h00 * a.x + h10 * m0x + h01 * b.x + h11 * m1x;
        const cy = h00 * a.y + h10 * m0y + h01 * b.y + h11 * m1y;
        this.pushTerrainLine(px, py, cx, cy, b.color, STYLE.lineAlpha);
        px = cx;
        py = cy;
      }
    }
  }

  /** Join a unit or build target's 3D center to the raised ground route at
   *  the same x/y. These stems make ownership and build endpoints explicit
   *  without letting the terrain-following route cut through either model. */
  private pushGroundStem(
    x: number,
    y: number,
    centerZ: number,
    color: number,
    alpha: number,
  ): void {
    const groundZ = this.resolveY(x, y);
    if (!Number.isFinite(centerZ) || Math.abs(centerZ - groundZ) < 1e-6) return;
    const c = hexToRgb01(color);
    this.pushSegment(
      x,
      y,
      centerZ,
      x,
      y,
      groundZ,
      c.r,
      c.g,
      c.b,
      alpha,
    );
  }

  /** Push a hollow square outline centered on (x, y) at terrain
   *  elevation — used for build / repair commands. Edges go into
   *  the same line buffer as path lines. */
  private pushRectOutline(x: number, y: number, color: number): void {
    const c = hexToRgb01(color);
    const a = STYLE.lineAlpha;
    const h = STYLE.rectWorldSize / 2;
    const z = this.resolveY(x, y);
    // Four corners traversed counterclockwise.
    const cx0 = x - h, cy0 = y - h;
    const cx1 = x + h, cy1 = y - h;
    const cx2 = x + h, cy2 = y + h;
    const cx3 = x - h, cy3 = y + h;
    this.pushSegment(cx0, cy0, z, cx1, cy1, z, c.r, c.g, c.b, a);
    this.pushSegment(cx1, cy1, z, cx2, cy2, z, c.r, c.g, c.b, a);
    this.pushSegment(cx2, cy2, z, cx3, cy3, z, c.r, c.g, c.b, a);
    this.pushSegment(cx3, cy3, z, cx0, cy0, z, c.r, c.g, c.b, a);
  }

  private pushDot(
    state: { dotCount: number },
    x: number, y: number, color: number,
  ): void {
    if (state.dotCount + 1 > this.dotCap) {
      this.growDotCap(state.dotCount + 1);
    }
    const o = state.dotCount * 3;
    const z = this.resolveY(x, y);
    this.dotPositions[o + 0] = x;
    this.dotPositions[o + 1] = z;
    this.dotPositions[o + 2] = y;
    writeHexToRgb01Array(color, this.dotColors, o);
    state.dotCount++;
  }

  private actionDisplayPoint(a: UnitAction): ActionDisplayPoint {
    // Entity-targeting orders (attack / guard / repair / reclaim / capture /
    // resurrect / build) draw to the target's LIVE position so a queued line
    // follows a moving target (e.g. guarding or attacking a moving unit),
    // not the stale point captured when the order was issued. Falls back to
    // the stored point for ground orders or a vanished target.
    if (this.getEntity) {
      const targetId = a.type === 'build' ? a.buildingId : a.targetId;
      if (targetId !== undefined && targetId !== null) {
        const target = this.getEntity(targetId);
        if (target !== undefined) {
          const point = getEntityTargetPoint(target);
          return { x: point.x, y: point.y, z: point.z, target };
        }
      }
    }
    return { x: a.x, y: a.y };
  }

  /** Pool slot for a flag sprite. Lazily creates a small canvas
   *  on first use; recolors only when the team color changes. */
  private acquireFlag(i: number, color: number, x: number, y: number): void {
    const slot = this.flagPool.acquire(i);
    this.flagPool.repaintIfChanged(slot, color);
    const z = this.resolveY(x, y);
    // Centerline of the sprite raised by half its height so the pole
    // base meets the terrain rather than hovering above it.
    slot.sprite.position.set(x, z + STYLE.flagWorldSize / 2, y);
  }

  private acquireLabel(i: number, text: string, color: number, x: number, y: number): void {
    const slot = this.labelPool.acquire(i);
    this.labelPool.repaintIfChanged(slot, text, color);
    const z = this.resolveY(x, y);
    slot.sprite.position.set(x, z + STYLE.labelWorldSize, y);
  }

  // ── update ───────────────────────────────────────────────────────

  update(
    selectedUnits: readonly Entity[],
    selectedBuildings: readonly Entity[],
  ): void {
    if (selectedUnits.length === 0 && selectedBuildings.length === 0) {
      if (this.hadVisible) {
        this.lineBatch.begin();
        this.lineBatch.finishFrame();
        this.dotGeom.setDrawRange(0, 0);
        this.flagPool.hideAll();
        this.labelPool.hideAll();
        this.hadVisible = false;
      }
      return;
    }

    const state = { dotCount: 0 };
    this.lineBatch.begin();
    let flagCount = 0;
    let labelCount = 0;

    // Per-unit action chains. Waypoint visuals always resample their
    // terrain-bed elevation, including under water.
    //
    // `actions` is durable intent; `activePath` is the disposable resolved
    // plan for actions[0]. All modes connect the complete authored queue.
    // The DETAILED modes replace the active leg's straight connection with
    // the exact remaining activePath when one exists; later, not-yet-planned
    // legs keep their direct authored connections. SIMPLE never reads
    // activePath. DETAILED-SHARP draws the threaded route as straight spans;
    // DETAILED-SMOOTH bends the same route through the pathfinder's MINOR
    // sub-points only — the unit and the player's own command points stay
    // sharp corners in both DETAILED modes — see pushRoute.
    const mode = getWaypointDetail();
    const detailed = mode !== 'simple';
    const smooth = mode === 'detailed-smooth';
    for (const u of selectedUnits) {
      const unit = u.unit;
      const actions = unit?.actions;
      if (!unit || !actions || actions.length === 0) continue;
      const previewPoints = detailed ? unit.activePath?.points : undefined;
      const firstActionColor =
        ACTION_COLORS[actions[0].type] ?? COLORS.units.turret.barrel.colorHex;
      this.pushGroundStem(
        u.transform.x,
        u.transform.y,
        u.transform.z,
        firstActionColor,
        STYLE.lineAlpha,
      );
      const route: RoutePoint[] = [
        { x: u.transform.x, y: u.transform.y, color: firstActionColor, major: true },
      ];
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const p = this.actionDisplayPoint(a);
        const color = ACTION_COLORS[a.type] ?? COLORS.units.turret.barrel.colorHex;
        // Active leg in the DETAILED modes: thread the exact authoritative
        // resolved plan. Only the authored waypoint itself gets a marker —
        // the route points thread through as lines alone.
        if (detailed && i === 0 && previewPoints !== undefined && previewPoints.length > 0) {
          for (let k = 0; k < previewPoints.length; k++) {
            const pt = previewPoints[k];
            route.push({ x: pt.x, y: pt.y, color, major: false });
          }
        }
        // SIMPLE always threads the direct authored leg. The DETAILED modes
        // do the same for future legs and as a fallback when no active plan
        // exists. If a snapped/partial active path ends before the requested
        // first waypoint, retain a direct tail so the visible queue stays
        // exhaustive without pretending that tail came from the pathfinder.
        const tail = route[route.length - 1];
        if (
          !detailed ||
          i > 0 ||
          previewPoints === undefined ||
          previewPoints.length === 0 ||
          Math.abs(tail.x - p.x) > 1e-6 ||
          Math.abs(tail.y - p.y) > 1e-6
        ) {
          route.push({ x: p.x, y: p.y, color, major: true });
        } else {
          // The plan's last sub-point IS this authored waypoint — promote it
          // rather than duplicating it, so smoothing leaves the corner sharp.
          tail.major = true;
        }
        if (
          p.target?.building &&
          (a.type === 'build' || isBuildInProgress(p.target.buildable))
        ) {
          this.pushGroundStem(
            p.x,
            p.y,
            getBuildingVisualCenterZ(p.target),
            color,
            STYLE.lineAlpha,
          );
        } else if (p.target !== undefined && p.z !== undefined) {
          // Any other LIVE entity target (guard, attack, repair, ...):
          // join the ground route endpoint up to the target's actual 3D
          // position, so guarding or attacking a flyer doesn't terminate
          // at the dirt below it. pushGroundStem already no-ops when the
          // target sits at ground level.
          this.pushGroundStem(p.x, p.y, p.z, color, STYLE.lineAlpha);
        }
        // User waypoint marker + queue-order label.
        if (a.type === 'build' || a.type === 'repair') {
          this.pushRectOutline(p.x, p.y, color);
        } else {
          this.pushDot(state, p.x, p.y, color);
        }
        this.acquireLabel(labelCount++, String(i + 1), color, p.x, p.y);
      }
      this.pushRoute(route, smooth);
      // Patrol return — link the last patrol waypoint back to the first
      // with a dimmer line.
      if (unit.patrolStartIndex !== null && actions.length > 0) {
        const last = actions[actions.length - 1];
        const first = actions[unit.patrolStartIndex];
        if (last && last.type === 'patrol' && first) {
          this.pushTerrainLine(
            last.x, last.y, first.x, first.y,
            ACTION_COLORS['patrol'], STYLE.patrolReturnAlpha,
          );
        }
      }
    }

    // Per-factory static rally. When the factory carries a multi-leg
    // default route (demo fabricators: a `fight` leg then a `patrol`
    // loop), draw every leg + the patrol loop-back so players can see
    // where produced units actually go — not just the first leg. Falls
    // back to the single rally point for player-set rallies.
    for (const b of selectedBuildings) {
      const factory = b.factory;
      if (!factory) continue;
      const startX = b.transform.x;
      const startY = b.transform.y;
      const route = factory.defaultWaypoints;

      if (route !== null && route.length > 0) {
        let prevX = startX;
        let prevY = startY;
        let firstPatrolIdx = -1;
        let lastPatrolIdx = -1;
        const firstColor =
          WAYPOINT_COLORS[route[0].type as keyof typeof WAYPOINT_COLORS]
          ?? COLORS.units.turret.barrel.colorHex;
        this.pushGroundStem(
          startX,
          startY,
          getBuildingVisualCenterZ(b),
          firstColor,
          STYLE.lineAlpha,
        );
        for (let i = 0; i < route.length; i++) {
          const wp = route[i];
          const color = WAYPOINT_COLORS[wp.type as keyof typeof WAYPOINT_COLORS]
            ?? COLORS.units.turret.barrel.colorHex;
          this.pushTerrainLine(prevX, prevY, wp.x, wp.y, color, STYLE.lineAlpha);
          this.pushDot(state, wp.x, wp.y, color);
          if (wp.type === 'patrol') {
            if (firstPatrolIdx < 0) firstPatrolIdx = i;
            lastPatrolIdx = i;
          }
          prevX = wp.x;
          prevY = wp.y;
        }
        // Flag marks the rally (route[0]) — the first leg units head to.
        const flag = route[0];
        const flagColor = WAYPOINT_COLORS[flag.type as keyof typeof WAYPOINT_COLORS]
          ?? COLORS.units.turret.barrel.colorHex;
        this.acquireFlag(flagCount++, flagColor, flag.x, flag.y);
        // Patrol loop-back: dim line from the last patrol leg to the first.
        if (firstPatrolIdx >= 0 && lastPatrolIdx > firstPatrolIdx) {
          const lastWp = route[lastPatrolIdx];
          const firstWp = route[firstPatrolIdx];
          this.pushTerrainLine(
            lastWp.x, lastWp.y, firstWp.x, firstWp.y,
            WAYPOINT_COLORS['patrol'], STYLE.patrolReturnAlpha,
          );
        }
        continue;
      }

      const color = WAYPOINT_COLORS[factory.rallyType as keyof typeof WAYPOINT_COLORS]
        ?? COLORS.units.turret.barrel.colorHex;
      this.pushGroundStem(
        startX,
        startY,
        getBuildingVisualCenterZ(b),
        color,
        STYLE.lineAlpha,
      );
      this.pushTerrainLine(startX, startY, factory.rallyX, factory.rallyY, color, STYLE.lineAlpha);
      this.pushDot(state, factory.rallyX, factory.rallyY, color);
      this.acquireFlag(flagCount++, color, factory.rallyX, factory.rallyY);
      // Single-point patrol loops back to the factory.
      if (factory.rallyType === 'patrol') {
        this.pushTerrainLine(
          factory.rallyX, factory.rallyY, startX, startY,
          WAYPOINT_COLORS['patrol'], STYLE.patrolReturnAlpha,
        );
      }
    }

    // Push GPU buffer updates and trim the visible counts to what
    // we filled this frame. Hidden flags stay in the pool ready
    // for the next frame.
    const lineSeg = this.lineBatch.finishFrame();
    this.dotGeom.setDrawRange(0, state.dotCount);
    (this.dotGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.dotGeom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.flagPool.hideUnused(flagCount);
    this.labelPool.hideUnused(labelCount);
    this.hadVisible = lineSeg > 0 || state.dotCount > 0 || flagCount > 0 || labelCount > 0;
  }

  destroy(): void {
    this.parent.remove(this.lineBatch.mesh);
    this.parent.remove(this.dotMesh);
    this.lineBatch.dispose();
    this.dotGeom.dispose();
    (this.dotMesh.material as THREE.Material).dispose();
    this.flagPool.destroy();
    this.labelPool.destroy();
  }

  getSpritePoolTelemetry(): CanvasSpritePoolTelemetry {
    return this.flagPool.getTelemetry();
  }
}
