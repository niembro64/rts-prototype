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
import { CanvasSpritePool, type CanvasSpriteSlot } from './CanvasSpritePool';
import { DynamicLineBuffer3D } from './DynamicLineBuffer3D';

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
  /** Square size for build / repair markers, in world units. */
  rectWorldSize: 18,
  /** Flag sprite size in world units. */
  flagWorldSize: 14,
};

type FlagState = {
  /** Last hex color we drew so we skip canvas work between frames. */
  lastColor: number;
};

type FlagSlot = CanvasSpriteSlot<FlagState>;

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

export class Waypoint3D {
  private parent: THREE.Group;
  private mapWidth: number;
  private mapHeight: number;
  private getEntity?: (id: number) => Entity | undefined;

  // Line buffer (path segments + rect outlines).
  private lineBuffer = new DynamicLineBuffer3D(STYLE.initialLineCap);
  private lineMesh: THREE.LineSegments;

  // Point buffer (dot markers).
  private dotGeom: THREE.BufferGeometry;
  private dotPositions: Float32Array;
  private dotColors: Float32Array;
  private dotMesh: THREE.Points;
  private dotCap: number;

  // Pooled flag sprites.
  private flagPool: CanvasSpritePool<FlagState, [number]>;
  private hadVisible = false;

  constructor(
    parent: THREE.Group,
    mapWidth: number,
    mapHeight: number,
    getEntity?: (id: number) => Entity | undefined,
  ) {
    this.parent = parent;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.getEntity = getEntity;
    this.flagPool = new CanvasSpritePool<FlagState, [number]>({
      parent,
      canvasWidth: 32,
      canvasHeight: 32,
      debugName: 'Waypoint3D',
      makeState: () => ({ lastColor: -1 }),
      configureSprite: configureFlagSprite,
      repaint: repaintFlag,
    });

    // Lines.
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: false,
      depthTest: true,
    });
    this.lineMesh = new THREE.LineSegments(this.lineBuffer.geometry, lineMat);
    this.lineMesh.frustumCulled = false;
    this.lineMesh.renderOrder = 5;
    parent.add(this.lineMesh);

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

  /** Push one straight 3D line segment endpoint pair into the buffer
   *  with a single per-vertex color (alpha pre-multiplied). */
  private pushSegment(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number, g: number, b: number,
  ): void {
    this.lineBuffer.pushSegment(ax, az, ay, bx, bz, by, r, g, b);
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
    const r = c.r * alpha;
    const g = c.g * alpha;
    const b = c.b * alpha;
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
      this.pushSegment(prevX, prevY, prevZ, nx, ny, nz, r, g, b);
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
    const r = c.r * STYLE.lineAlpha;
    const g = c.g * STYLE.lineAlpha;
    const b = c.b * STYLE.lineAlpha;
    const h = STYLE.rectWorldSize / 2;
    const z = this.resolveY(x, y, zHint);
    // Four corners traversed counterclockwise.
    const cx0 = x - h, cy0 = y - h;
    const cx1 = x + h, cy1 = y - h;
    const cx2 = x + h, cy2 = y + h;
    const cx3 = x - h, cy3 = y + h;
    this.pushSegment(cx0, cy0, z, cx1, cy1, z, r, g, b);
    this.pushSegment(cx1, cy1, z, cx2, cy2, z, r, g, b);
    this.pushSegment(cx2, cy2, z, cx3, cy3, z, r, g, b);
    this.pushSegment(cx3, cy3, z, cx0, cy0, z, r, g, b);
  }

  private pushDot(
    state: { dotCount: number },
    x: number, y: number, color: number, zHint?: number,
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
    state.dotCount++;
  }

  private actionDisplayPoint(a: UnitAction): { x: number; y: number; z?: number } {
    if (a.type === 'attack' && a.targetId !== undefined && this.getEntity) {
      const target = this.getEntity(a.targetId);
      if (target?.building) {
        return getEntityTargetPoint(target);
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

  // ── update ───────────────────────────────────────────────────────

  update(
    selectedUnits: readonly Entity[],
    selectedBuildings: readonly Entity[],
  ): void {
    if (selectedUnits.length === 0 && selectedBuildings.length === 0) {
      if (this.hadVisible) {
        this.lineBuffer.resetDrawRange();
        this.dotGeom.setDrawRange(0, 0);
        this.flagPool.hideAll();
        this.hadVisible = false;
      }
      return;
    }

    const state = { dotCount: 0 };
    this.lineBuffer.resetDrawRange();
    let flagCount = 0;

    // Per-unit action chains. Action `z` (when present) is the
    // click-derived altitude carried through from CursorGround.pickSim
    // — used directly so a waypoint dot on a hilltop sits ON the
    // hilltop, not at a terrain re-sample that may differ.
    //
    // SIMPLE mode keeps the LINES tracing the unit's actual route
    // (so the visualization is geometrically honest — lines stay on
    // dry land instead of cutting straight across water) but draws
    // dots / rect markers ONLY at the user-issued endpoints. The
    // result: less visual clutter than DETAILED, but the line still
    // matches what the unit walks. The earlier SIMPLE behaviour
    // skipped lines for path-expansion actions too, which produced
    // a single chord from the unit straight to its final waypoint —
    // that chord could cross water while the unit walked around it,
    // which read as "the planner suggested a path through water"
    // even though the unit's actual route was correct.
    const simple = getWaypointDetail() === 'simple';
    for (const u of selectedUnits) {
      const actions = u.unit?.actions;
      if (!actions || actions.length === 0) continue;
      let prevX = u.transform.x;
      let prevY = u.transform.y;
      let prevZ: number | undefined = u.transform.z;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const p = this.actionDisplayPoint(a);
        const color = ACTION_COLORS[a.type] ?? COLORS.units.turret.barrel.colorHex;
        // Always draw the connecting line — this traces the unit's
        // physical route, regardless of mode.
        this.pushTerrainLine(prevX, prevY, p.x, p.y, color, STYLE.lineAlpha, prevZ, p.z);
        // Endpoint markers (dots / rect outlines) get suppressed in
        // SIMPLE mode for path-expansion intermediates so only
        // user-issued endpoints carry a visible marker.
        if (!simple || !a.isPathExpansion) {
          if (a.type === 'build' || a.type === 'repair') {
            this.pushRectOutline(p.x, p.y, color, p.z);
          } else {
            this.pushDot(state, p.x, p.y, color, p.z);
          }
        }
        prevX = p.x;
        prevY = p.y;
        prevZ = p.z;
      }
      // Patrol return — link last patrol waypoint back to the first
      // patrol waypoint with a dimmer line. In SIMPLE mode pick the
      // last NON-expansion patrol action so the loop-back stays on
      // user-clicked endpoints.
      if (u.unit!.patrolStartIndex !== null && actions.length > 0) {
        let lastIdx = actions.length - 1;
        if (simple) {
          while (lastIdx >= 0 && actions[lastIdx].isPathExpansion) lastIdx--;
        }
        const last = lastIdx >= 0 ? actions[lastIdx] : null;
        const first = actions[u.unit!.patrolStartIndex];
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
    const lineSeg = this.lineBuffer.finishFrame();
    this.dotGeom.setDrawRange(0, state.dotCount);
    (this.dotGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.dotGeom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.flagPool.hideUnused(flagCount);
    this.hadVisible = lineSeg > 0 || state.dotCount > 0 || flagCount > 0;
  }

  destroy(): void {
    this.parent.remove(this.lineMesh);
    this.parent.remove(this.dotMesh);
    this.lineBuffer.dispose();
    this.dotGeom.dispose();
    (this.lineMesh.material as THREE.Material).dispose();
    (this.dotMesh.material as THREE.Material).dispose();
    this.flagPool.destroy();
  }
}
