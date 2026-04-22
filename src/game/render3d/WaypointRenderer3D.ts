// WaypointRenderer3D — draws the command queue (unit action queue + factory
// rally waypoints) for selected entities in the 3D view.
//
// One LineSegments mesh carries every line; each line segment uses vertex
// colors matching the 2D ACTION_COLORS / WAYPOINT_COLORS palette. Small
// sphere meshes mark each waypoint target. Rebuilt from scratch each frame
// (cheap for the small number of selected units in an RTS).

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { ACTION_COLORS, WAYPOINT_COLORS } from '../render/types';

const WAYPOINT_Y = 6;          // line/dot height above ground
const DOT_RADIUS = 14;         // world units (visible at RTS zoom)
const LINE_ALPHA = 0.55;
const DOT_ALPHA = 0.85;

// Max vertex buffer size — enough for ~1k line segments. Oversized buffers
// just stay unused; we rebuild the draw range each frame.
const MAX_SEGMENTS = 2048;

export class WaypointRenderer3D {
  private root: THREE.Group;
  private lines: THREE.LineSegments;
  private linePositions: Float32Array;
  private lineColors: Float32Array;

  private dotGeom = new THREE.SphereGeometry(1, 10, 8);
  private dotPool: THREE.Mesh[] = [];
  private dotMatCache = new Map<number, THREE.MeshBasicMaterial>();

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);

    this.linePositions = new Float32Array(MAX_SEGMENTS * 2 * 3);
    this.lineColors = new Float32Array(MAX_SEGMENTS * 2 * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage),
    );
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: LINE_ALPHA,
      depthTest: false,
    });
    this.lines = new THREE.LineSegments(geom, mat);
    this.lines.renderOrder = 9;
    this.root.add(this.lines);
  }

  private getDotMat(color: number): THREE.MeshBasicMaterial {
    let m = this.dotMatCache.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: DOT_ALPHA,
        depthTest: false,
      });
      this.dotMatCache.set(color, m);
    }
    return m;
  }

  /** Release all active dot meshes back to the pool, hidden. */
  private recycleDots(): void {
    for (const m of this.dotPool) m.visible = false;
  }

  private pushDot(used: number, x: number, y: number, color: number): number {
    let dot = this.dotPool[used];
    if (!dot) {
      dot = new THREE.Mesh(this.dotGeom, this.getDotMat(color));
      dot.renderOrder = 10;
      this.root.add(dot);
      this.dotPool.push(dot);
    } else {
      dot.material = this.getDotMat(color);
    }
    dot.visible = true;
    dot.position.set(x, WAYPOINT_Y, y);
    dot.scale.setScalar(DOT_RADIUS);
    return used + 1;
  }

  update(selectedUnits: readonly Entity[], selectedBuildings: readonly Entity[]): void {
    this.recycleDots();
    let segIdx = 0;
    let dotIdx = 0;

    const pos = this.linePositions;
    const col = this.lineColors;

    const pushSegment = (
      x1: number, y1: number, x2: number, y2: number,
      color: number, alpha: number = 1,
    ): void => {
      if (segIdx >= MAX_SEGMENTS) return;
      const base = segIdx * 6;
      pos[base + 0] = x1; pos[base + 1] = WAYPOINT_Y; pos[base + 2] = y1;
      pos[base + 3] = x2; pos[base + 4] = WAYPOINT_Y; pos[base + 5] = y2;
      const r = ((color >> 16) & 0xff) / 255;
      const g = ((color >> 8) & 0xff) / 255;
      const b = (color & 0xff) / 255;
      const cBase = segIdx * 6;
      col[cBase + 0] = r * alpha; col[cBase + 1] = g * alpha; col[cBase + 2] = b * alpha;
      col[cBase + 3] = r * alpha; col[cBase + 4] = g * alpha; col[cBase + 5] = b * alpha;
      segIdx++;
    };

    // Unit action queues
    for (const u of selectedUnits) {
      const actions = u.unit?.actions;
      if (!actions || actions.length === 0) continue;
      let prevX = u.transform.x;
      let prevY = u.transform.y;
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        const color = ACTION_COLORS[a.type] ?? 0xffffff;
        pushSegment(prevX, prevY, a.x, a.y, color);
        dotIdx = this.pushDot(dotIdx, a.x, a.y, color);
        prevX = a.x;
        prevY = a.y;
      }
      // Patrol return line
      if (u.unit!.patrolStartIndex !== null && actions.length > 0) {
        const last = actions[actions.length - 1];
        const first = actions[u.unit!.patrolStartIndex];
        if (last.type === 'patrol' && first) {
          pushSegment(last.x, last.y, first.x, first.y, ACTION_COLORS['patrol'], 0.45);
        }
      }
    }

    // Factory rally-point waypoints
    for (const b of selectedBuildings) {
      const wps = b.factory?.waypoints;
      if (!wps || wps.length === 0) continue;
      let prevX = b.transform.x;
      let prevY = b.transform.y;
      for (let i = 0; i < wps.length; i++) {
        const w = wps[i];
        const color = WAYPOINT_COLORS[w.type] ?? 0xffffff;
        pushSegment(prevX, prevY, w.x, w.y, color);
        dotIdx = this.pushDot(dotIdx, w.x, w.y, color);
        prevX = w.x;
        prevY = w.y;
      }
      // Patrol return line for factory rally
      const last = wps[wps.length - 1];
      if (last.type === 'patrol') {
        const firstPatrolIdx = wps.findIndex((w) => w.type === 'patrol');
        if (firstPatrolIdx >= 0) {
          const first = wps[firstPatrolIdx];
          pushSegment(last.x, last.y, first.x, first.y, WAYPOINT_COLORS['patrol'], 0.45);
        }
      }
    }

    // Flush buffers
    const geom = this.lines.geometry;
    (geom.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    geom.setDrawRange(0, segIdx * 2);
  }

  destroy(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    for (const dot of this.dotPool) this.root.remove(dot);
    for (const m of this.dotMatCache.values()) m.dispose();
    this.dotMatCache.clear();
    this.dotGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
