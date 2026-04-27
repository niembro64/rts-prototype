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
import type { Entity } from '../sim/types';
import { ACTION_COLORS, WAYPOINT_COLORS } from '../uiLabels';
import { getSurfaceHeight } from '../sim/Terrain';
import { SPATIAL_GRID_CELL_SIZE } from '../../config';

const STYLE = {
  /** Vertical lift above the terrain so lines / dots / flags float
   *  just clear of the ground (avoids z-fighting with the surface
   *  while still getting depth-occluded by intervening hills). */
  worldLift: 5,
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

type FlagSlot = {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  /** Last hex color we drew so we skip canvas work between frames. */
  lastColor: number;
};

export class Waypoint3D {
  private parent: THREE.Group;
  private mapWidth: number;
  private mapHeight: number;

  // Line buffer (path segments + rect outlines).
  private lineGeom: THREE.BufferGeometry;
  private linePositions: Float32Array;
  private lineColors: Float32Array;
  private lineMesh: THREE.LineSegments;
  private lineCap: number;

  // Point buffer (dot markers).
  private dotGeom: THREE.BufferGeometry;
  private dotPositions: Float32Array;
  private dotColors: Float32Array;
  private dotMesh: THREE.Points;
  private dotCap: number;

  // Pooled flag sprites.
  private flagPool: FlagSlot[] = [];

  constructor(parent: THREE.Group, mapWidth: number, mapHeight: number) {
    this.parent = parent;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;

    // Lines.
    this.lineCap = STYLE.initialLineCap;
    this.linePositions = new Float32Array(this.lineCap * 2 * 3);
    this.lineColors = new Float32Array(this.lineCap * 2 * 3);
    this.lineGeom = new THREE.BufferGeometry();
    this.lineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lineGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: false,
      depthTest: true,
    });
    this.lineMesh = new THREE.LineSegments(this.lineGeom, lineMat);
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

  private surfaceZ(x: number, y: number): number {
    return getSurfaceHeight(x, y, this.mapWidth, this.mapHeight, SPATIAL_GRID_CELL_SIZE) + STYLE.worldLift;
  }

  private growLineCap(needed: number): void {
    let cap = this.lineCap;
    while (cap < needed) cap *= 2;
    if (cap === this.lineCap) return;
    this.lineCap = cap;
    this.linePositions = new Float32Array(cap * 2 * 3);
    this.lineColors = new Float32Array(cap * 2 * 3);
    this.lineGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.lineGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
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
    state: { lineSeg: number },
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number, g: number, b: number,
  ): void {
    if (state.lineSeg + 1 > this.lineCap) {
      this.growLineCap(state.lineSeg + 1);
    }
    const o = state.lineSeg * 6;
    this.linePositions[o + 0] = ax; this.linePositions[o + 1] = az; this.linePositions[o + 2] = ay;
    this.linePositions[o + 3] = bx; this.linePositions[o + 4] = bz; this.linePositions[o + 5] = by;
    this.lineColors[o + 0] = r; this.lineColors[o + 1] = g; this.lineColors[o + 2] = b;
    this.lineColors[o + 3] = r; this.lineColors[o + 4] = g; this.lineColors[o + 5] = b;
    state.lineSeg++;
  }

  /** Push a long line A→B as several short sub-segments that follow
   *  the terrain so the line hugs the ground instead of cutting
   *  through hills. */
  private pushTerrainLine(
    state: { lineSeg: number },
    ax: number, ay: number, bx: number, by: number,
    color: number, alpha: number,
  ): void {
    const r = (((color >> 16) & 0xff) / 255) * alpha;
    const g = (((color >> 8) & 0xff) / 255) * alpha;
    const b = ((color & 0xff) / 255) * alpha;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(length / STYLE.subStep));
    let prevX = ax;
    let prevY = ay;
    let prevZ = this.surfaceZ(prevX, prevY);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const nx = ax + dx * t;
      const ny = ay + dy * t;
      const nz = this.surfaceZ(nx, ny);
      this.pushSegment(state, prevX, prevY, prevZ, nx, ny, nz, r, g, b);
      prevX = nx; prevY = ny; prevZ = nz;
    }
  }

  /** Push a hollow square outline centered on (x, y) at terrain
   *  elevation — used for build / repair commands. Edges go into
   *  the same line buffer as path lines. */
  private pushRectOutline(
    state: { lineSeg: number },
    x: number, y: number, color: number,
  ): void {
    const r = (((color >> 16) & 0xff) / 255) * STYLE.lineAlpha;
    const g = (((color >> 8) & 0xff) / 255) * STYLE.lineAlpha;
    const b = ((color & 0xff) / 255) * STYLE.lineAlpha;
    const h = STYLE.rectWorldSize / 2;
    const z = this.surfaceZ(x, y);
    // Four corners traversed counterclockwise.
    const cx0 = x - h, cy0 = y - h;
    const cx1 = x + h, cy1 = y - h;
    const cx2 = x + h, cy2 = y + h;
    const cx3 = x - h, cy3 = y + h;
    this.pushSegment(state, cx0, cy0, z, cx1, cy1, z, r, g, b);
    this.pushSegment(state, cx1, cy1, z, cx2, cy2, z, r, g, b);
    this.pushSegment(state, cx2, cy2, z, cx3, cy3, z, r, g, b);
    this.pushSegment(state, cx3, cy3, z, cx0, cy0, z, r, g, b);
  }

  private pushDot(
    state: { dotCount: number },
    x: number, y: number, color: number,
  ): void {
    if (state.dotCount + 1 > this.dotCap) {
      this.growDotCap(state.dotCount + 1);
    }
    const o = state.dotCount * 3;
    const z = this.surfaceZ(x, y);
    this.dotPositions[o + 0] = x;
    this.dotPositions[o + 1] = z;
    this.dotPositions[o + 2] = y;
    this.dotColors[o + 0] = ((color >> 16) & 0xff) / 255;
    this.dotColors[o + 1] = ((color >> 8) & 0xff) / 255;
    this.dotColors[o + 2] = (color & 0xff) / 255;
    state.dotCount++;
  }

  /** Pool slot for a flag sprite. Lazily creates a small canvas
   *  on first use; recolors only when the team color changes. */
  private acquireFlag(i: number, color: number, x: number, y: number): void {
    let slot = this.flagPool[i];
    if (!slot) {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Waypoint3D: 2d canvas context unavailable');
      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(STYLE.flagWorldSize, STYLE.flagWorldSize, 1);
      this.parent.add(sprite);
      slot = { sprite, canvas, ctx, texture, material, lastColor: -1 };
      this.flagPool.push(slot);
    }
    if (slot.lastColor !== color) {
      slot.lastColor = color;
      const css = `#${color.toString(16).padStart(6, '0')}`;
      const ctx = slot.ctx;
      ctx.clearRect(0, 0, 32, 32);
      // Vertical pole on the left, triangle flag pointing right.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(7, 4, 2, 24);
      ctx.fillStyle = css;
      ctx.beginPath();
      ctx.moveTo(9, 4);
      ctx.lineTo(26, 11);
      ctx.lineTo(9, 18);
      ctx.closePath();
      ctx.fill();
      slot.texture.needsUpdate = true;
    }
    slot.sprite.visible = true;
    const z = this.surfaceZ(x, y);
    // Centerline of the sprite raised by half its height so the pole
    // base meets the terrain rather than hovering above it.
    slot.sprite.position.set(x, z + STYLE.flagWorldSize / 2, y);
  }

  // ── update ───────────────────────────────────────────────────────

  update(
    selectedUnits: readonly Entity[],
    selectedBuildings: readonly Entity[],
  ): void {
    const state = { lineSeg: 0, dotCount: 0 };
    let flagCount = 0;

    // Per-unit action chains.
    for (const u of selectedUnits) {
      const actions = u.unit?.actions;
      if (!actions || actions.length === 0) continue;
      let prevX = u.transform.x;
      let prevY = u.transform.y;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const color = ACTION_COLORS[a.type] ?? 0xffffff;
        this.pushTerrainLine(state, prevX, prevY, a.x, a.y, color, STYLE.lineAlpha);
        if (a.type === 'build' || a.type === 'repair') {
          this.pushRectOutline(state, a.x, a.y, color);
        } else {
          this.pushDot(state, a.x, a.y, color);
        }
        prevX = a.x;
        prevY = a.y;
      }
      // Patrol return — link last patrol waypoint back to the first
      // patrol waypoint with a dimmer line.
      if (u.unit!.patrolStartIndex !== null && actions.length > 0) {
        const last = actions[actions.length - 1];
        const first = actions[u.unit!.patrolStartIndex];
        if (last.type === 'patrol' && first) {
          this.pushTerrainLine(
            state,
            last.x, last.y, first.x, first.y,
            ACTION_COLORS['patrol'], STYLE.patrolReturnAlpha,
          );
        }
      }
    }

    // Per-factory rally chains (with a flag at the final waypoint).
    for (const b of selectedBuildings) {
      const wps = b.factory?.waypoints;
      if (!wps || wps.length === 0) continue;
      let prevX = b.transform.x;
      let prevY = b.transform.y;
      for (let i = 0; i < wps.length; i++) {
        const w = wps[i];
        const color = WAYPOINT_COLORS[w.type] ?? 0xffffff;
        this.pushTerrainLine(state, prevX, prevY, w.x, w.y, color, STYLE.lineAlpha);
        this.pushDot(state, w.x, w.y, color);
        if (i === wps.length - 1) {
          this.acquireFlag(flagCount++, color, w.x, w.y);
        }
        prevX = w.x;
        prevY = w.y;
      }
      // Factory patrol return arc.
      if (wps.length > 0) {
        const last = wps[wps.length - 1];
        if (last.type === 'patrol') {
          const firstIdx = wps.findIndex((w) => w.type === 'patrol');
          if (firstIdx >= 0) {
            const first = wps[firstIdx];
            this.pushTerrainLine(
              state,
              last.x, last.y, first.x, first.y,
              WAYPOINT_COLORS['patrol'], STYLE.patrolReturnAlpha,
            );
          }
        }
      }
    }

    // Push GPU buffer updates and trim the visible counts to what
    // we filled this frame. Hidden flags stay in the pool ready
    // for the next frame.
    this.lineGeom.setDrawRange(0, state.lineSeg * 2);
    (this.lineGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.lineGeom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.dotGeom.setDrawRange(0, state.dotCount);
    (this.dotGeom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.dotGeom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    for (let i = flagCount; i < this.flagPool.length; i++) {
      this.flagPool[i].sprite.visible = false;
    }
  }

  destroy(): void {
    this.parent.remove(this.lineMesh);
    this.parent.remove(this.dotMesh);
    this.lineGeom.dispose();
    this.dotGeom.dispose();
    (this.lineMesh.material as THREE.Material).dispose();
    (this.dotMesh.material as THREE.Material).dispose();
    for (const flag of this.flagPool) {
      this.parent.remove(flag.sprite);
      flag.texture.dispose();
      flag.material.dispose();
    }
    this.flagPool.length = 0;
  }
}
