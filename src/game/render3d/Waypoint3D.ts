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
import { getSurfaceHeight } from '../sim/Terrain';
import { LAND_CELL_SIZE, WAYPOINT_GROUND_LIFT } from '../../config';
import { getWaypointDetail } from '../../clientBarConfig';
import { getEntityTargetPoint } from '../sim/buildingAnchors';
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
  /** Brightness multiplier for DETAILED-mode pathfinding intermediate dots.
   *  Dimmer than the numbered command waypoints so the planner's route nodes
   *  read as subordinate route hints rather than user-issued orders. */
  pathIntermediateAlpha: 0.4,
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
    this.lineWidthPx = overlayLines.style('waypoint').widthPx;
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
    this.dotMesh.renderOrder = 5;
    parent.add(this.dotMesh);
  }

  // ── helpers ──────────────────────────────────────────────────────

  /** Resolve the rendered y for a waypoint XY. Prefers `hint` when
   *  provided — that's the action's stored z, which carries either
   *  the user's click altitude (from CursorGround.pickSim) or the
   *  pathfinder's terrain sample at a JPS-introduced intermediate.
   *  Falls back to a fresh terrain sample only when the action lacks
   *  z (synthetic / legacy data with no click origin). The added
   *  worldLift stays identical to the original "surfaceZ" semantics
   *  so tuning carries over verbatim. */
  private resolveY(x: number, y: number, hint?: number): number {
    return (hint ?? getSurfaceHeight(x, y, this.mapWidth, this.mapHeight, LAND_CELL_SIZE))
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
   *  through hills. Endpoints (`az`, `bz`) optionally pin the line
   *  start / end to the action's stored altitude — when the click
   *  landed on a hilltop, the line's final point sits exactly on the
   *  hilltop instead of a half-cell-rounded terrain re-sample. The
   *  intermediate steps still terrain-sample so the line traces the
   *  ground between waypoints (the unit walks the ground). */
  private pushTerrainLine(
    ax: number, ay: number, bx: number, by: number,
    color: number, alpha: number,
    az?: number, bz?: number,
  ): void {
    const c = hexToRgb01(color);
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(length / STYLE.subStep));
    let prevX = ax;
    let prevY = ay;
    let prevZ = this.resolveY(prevX, prevY, az);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = ax + dx * t;
      const ny = ay + dy * t;
      // Last step pins to the b-endpoint's altitude (when provided)
      // so a click on a hilltop's final dot meets the line cleanly.
      const nz = i === steps ? this.resolveY(nx, ny, bz) : this.resolveY(nx, ny);
      this.pushSegment(prevX, prevY, prevZ, nx, ny, nz, c.r, c.g, c.b, alpha);
      prevX = nx; prevY = ny; prevZ = nz;
    }
  }

  /** Push a hollow square outline centered on (x, y) at terrain
   *  elevation — used for build / repair commands. Edges go into
   *  the same line buffer as path lines. */
  private pushRectOutline(
    x: number, y: number, color: number, zHint?: number,
  ): void {
    const c = hexToRgb01(color);
    const a = STYLE.lineAlpha;
    const h = STYLE.rectWorldSize / 2;
    const z = this.resolveY(x, y, zHint);
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
    x: number, y: number, color: number, zHint?: number, alpha = 1,
  ): void {
    if (state.dotCount + 1 > this.dotCap) {
      this.growDotCap(state.dotCount + 1);
    }
    const o = state.dotCount * 3;
    const z = this.resolveY(x, y, zHint);
    this.dotPositions[o + 0] = x;
    this.dotPositions[o + 1] = z;
    this.dotPositions[o + 2] = y;
    writeHexToRgb01Array(color, this.dotColors, o);
    // The dot mesh is opaque over a dark clear, so pre-multiplying the color
    // by alpha reads as transparency (same trick the line buffer uses).
    if (alpha !== 1) {
      this.dotColors[o + 0] *= alpha;
      this.dotColors[o + 1] *= alpha;
      this.dotColors[o + 2] *= alpha;
    }
    state.dotCount++;
  }

  private actionDisplayPoint(a: UnitAction): { x: number; y: number; z?: number } {
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
          return getEntityTargetPoint(target);
        }
      }
    }
    return { x: a.x, y: a.y, z: a.z };
  }

  /** Pool slot for a flag sprite. Lazily creates a small canvas
   *  on first use; recolors only when the team color changes. */
  private acquireFlag(i: number, color: number, x: number, y: number, zHint?: number): void {
    const slot = this.flagPool.acquire(i);
    this.flagPool.repaintIfChanged(slot, color);
    const z = this.resolveY(x, y, zHint);
    // Centerline of the sprite raised by half its height so the pole
    // base meets the terrain rather than hovering above it.
    slot.sprite.position.set(x, z + STYLE.flagWorldSize / 2, y);
  }

  private acquireLabel(i: number, text: string, color: number, x: number, y: number, zHint?: number): void {
    const slot = this.labelPool.acquire(i);
    this.labelPool.repaintIfChanged(slot, text, color);
    const z = this.resolveY(x, y, zHint);
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

    // Per-unit action chains. Action `z` (when present) is the
    // click-derived altitude carried through from CursorGround.pickSim
    // — used directly so a waypoint dot on a hilltop sits ON the
    // hilltop, not at a terrain re-sample that may differ.
    //
    // `actions` is durable intent; `activePath` is the disposable resolved
    // plan for actions[0]. SIMPLE connects authored waypoints conventionally.
    // DETAILED draws only the exact remaining activePath, including its real
    // snapped/partial endpoint, and leaves future unplanned command markers
    // unconnected. It must never synthesize a segment to the requested goal.
    const detailed = getWaypointDetail() === 'detailed';
    for (const u of selectedUnits) {
      const unit = u.unit;
      const actions = unit?.actions;
      if (!unit || !actions || actions.length === 0) continue;
      let prevX = u.transform.x;
      let prevY = u.transform.y;
      let prevZ: number | undefined = u.transform.z;
      const previewPoints = detailed ? unit.activePath?.points : undefined;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const p = this.actionDisplayPoint(a);
        const color = ACTION_COLORS[a.type] ?? COLORS.units.turret.barrel.colorHex;
        // Active leg in DETAILED mode: thread the exact authoritative smoothed
        // plan, marking each resolved point with a subordinate dot.
        if (detailed && i === 0 && previewPoints !== undefined && previewPoints.length > 0) {
          for (let k = 0; k < previewPoints.length; k++) {
            const pt = previewPoints[k];
            this.pushTerrainLine(prevX, prevY, pt.x, pt.y, color, STYLE.lineAlpha, prevZ, pt.z);
            this.pushDot(state, pt.x, pt.y, color, pt.z, STYLE.pathIntermediateAlpha);
            prevX = pt.x;
            prevY = pt.y;
            prevZ = pt.z;
          }
        }
        if (!detailed) {
          this.pushTerrainLine(prevX, prevY, p.x, p.y, color, STYLE.lineAlpha, prevZ, p.z);
        }
        // User waypoint marker + queue-order label.
        if (a.type === 'build' || a.type === 'repair') {
          this.pushRectOutline(p.x, p.y, color, p.z);
        } else {
          this.pushDot(state, p.x, p.y, color, p.z);
        }
        this.acquireLabel(labelCount++, String(i + 1), color, p.x, p.y, p.z);
        prevX = p.x;
        prevY = p.y;
        prevZ = p.z;
      }
      // Patrol return — link the last patrol waypoint back to the first
      // with a dimmer line.
      if (!detailed && unit.patrolStartIndex !== null && actions.length > 0) {
        const last = actions[actions.length - 1];
        const first = actions[unit.patrolStartIndex];
        if (last && last.type === 'patrol' && first) {
          this.pushTerrainLine(
            last.x, last.y, first.x, first.y,
            ACTION_COLORS['patrol'], STYLE.patrolReturnAlpha,
            last.z, first.z,
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
      const startZ: number | undefined = b.transform.z;
      const route = factory.defaultWaypoints;

      if (route !== null && route.length > 0) {
        let prevX = startX;
        let prevY = startY;
        let prevZ: number | undefined = startZ;
        let firstPatrolIdx = -1;
        let lastPatrolIdx = -1;
        for (let i = 0; i < route.length; i++) {
          const wp = route[i];
          const color = WAYPOINT_COLORS[wp.type as keyof typeof WAYPOINT_COLORS]
            ?? COLORS.units.turret.barrel.colorHex;
          const wz = wp.z ?? undefined;
          this.pushTerrainLine(prevX, prevY, wp.x, wp.y, color, STYLE.lineAlpha, prevZ, wz);
          this.pushDot(state, wp.x, wp.y, color, wz);
          if (wp.type === 'patrol') {
            if (firstPatrolIdx < 0) firstPatrolIdx = i;
            lastPatrolIdx = i;
          }
          prevX = wp.x;
          prevY = wp.y;
          prevZ = wz;
        }
        // Flag marks the rally (route[0]) — the first leg units head to.
        const flag = route[0];
        const flagColor = WAYPOINT_COLORS[flag.type as keyof typeof WAYPOINT_COLORS]
          ?? COLORS.units.turret.barrel.colorHex;
        this.acquireFlag(flagCount++, flagColor, flag.x, flag.y, flag.z ?? undefined);
        // Patrol loop-back: dim line from the last patrol leg to the first.
        if (firstPatrolIdx >= 0 && lastPatrolIdx > firstPatrolIdx) {
          const lastWp = route[lastPatrolIdx];
          const firstWp = route[firstPatrolIdx];
          this.pushTerrainLine(
            lastWp.x, lastWp.y, firstWp.x, firstWp.y,
            WAYPOINT_COLORS['patrol'], STYLE.patrolReturnAlpha,
            lastWp.z ?? undefined, firstWp.z ?? undefined,
          );
        }
        continue;
      }

      const color = WAYPOINT_COLORS[factory.rallyType as keyof typeof WAYPOINT_COLORS]
        ?? COLORS.units.turret.barrel.colorHex;
      const z = factory.rallyZ ?? undefined;
      this.pushTerrainLine(startX, startY, factory.rallyX, factory.rallyY, color, STYLE.lineAlpha, startZ, z);
      this.pushDot(state, factory.rallyX, factory.rallyY, color, z);
      this.acquireFlag(flagCount++, color, factory.rallyX, factory.rallyY, z);
      // Single-point patrol loops back to the factory.
      if (factory.rallyType === 'patrol') {
        this.pushTerrainLine(
          factory.rallyX, factory.rallyY, startX, startY,
          WAYPOINT_COLORS['patrol'], STYLE.patrolReturnAlpha,
          z, startZ,
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
