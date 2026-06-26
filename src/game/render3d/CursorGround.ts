// CursorGround — single canonical screen-ray service for terrain picks.
// Camera anchors call `pickWorld` with an explicit terrain mode; command
// inputs call `pickSim`. Both paths resolve through the same first-surface
// raycast so a click on a mountain top cannot skip through to terrain behind
// the mountain.
//
// Three coord ↔ sim coord mapping (the project-wide convention):
//   sim.x  = three.x
//   sim.y  = three.z
//   sim.z  = three.y     (altitude / height)
//
// The terrain is not monotonic along an oblique camera ray. A ray can enter a
// mountain, leave it over a valley, then hit later terrain behind it. The
// resolver therefore never binary-searches a camera→world-floor interval
// directly. It asks the authoritative terrain mesh for sorted intersections
// first, then falls back to a forward scan that brackets the FIRST clearance
// sign change before refining it.

import * as THREE from 'three';
import {
  getTerrainMeshHeight,
  TILE_FLOOR_Y,
  WATER_LEVEL,
} from '../sim/Terrain';
import type { CameraAnchorTerrain } from '../../types/camera';

const TERRAIN_RAY_FALLBACK_STEP = 20;
const TERRAIN_RAY_FALLBACK_MAX_STEPS = 8192;

export type SimGroundPoint = {
  x: number;
  y: number;
  z: number;
};

export class CursorGround {
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLElement;
  private mapWidth: number;
  private mapHeight: number;
  private terrainMesh?: THREE.Object3D;

  // Reusable scratch — never allocate per-call on hot input paths.
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private worldHit = new THREE.Vector3();
  private simHit: SimGroundPoint = { x: 0, y: 0, z: 0 };
  private terrainHits: THREE.Intersection[] = [];

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLElement,
    mapWidth: number,
    mapHeight: number,
    terrainMesh?: THREE.Object3D,
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.terrainMesh = terrainMesh;
  }

  /** Release the retained terrain mesh reference on scene teardown so a
   *  rematch (which reuses the same GL context without app.destroy) does
   *  not keep the previous match's terrain graph alive through this
   *  per-scene picking service. */
  dispose(): void {
    this.terrainMesh = undefined;
    this.terrainHits.length = 0;
  }

  /** Cursor → camera anchor point in THREE.JS coords.
   *
   *  The caller supplies the terrain axis explicitly:
   *  - plane-2d: project against the flat y=0 building plane.
   *  - terrain-3d: return the raw rendered terrain hit.
   *  - terrain-3d-water: return the rendered terrain hit clamped up
   *    to WATER_LEVEL.
   *
   *  The returned Vector3 is a SHARED scratch — read it immediately
   *  or copy if you need to retain. */
  pickWorld(
    clientX: number,
    clientY: number,
    terrainMode: CameraAnchorTerrain,
  ): THREE.Vector3 | null {
    if (!this.setRayFromClient(clientX, clientY)) return null;
    return this.pickWorldFromCurrentRay(terrainMode);
  }

  private setRayFromClient(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return true;
  }

  private pickPlaneRay(): THREE.Vector3 | null {
    const ray = this.raycaster.ray;
    if (Math.abs(ray.direction.y) < 1e-6) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t < 0) return null;
    this.worldHit.set(
      ray.origin.x + t * ray.direction.x,
      0,
      ray.origin.z + t * ray.direction.z,
    );
    return this.worldHit;
  }

  private pickWorldFromCurrentRay(terrainMode: CameraAnchorTerrain): THREE.Vector3 | null {
    if (terrainMode === 'plane-2d') return this.pickPlaneRay();

    const terrainHit = this.pickFirstTerrainSurfaceRay();
    if (!terrainHit) return null;
    if (terrainMode === 'terrain-3d-water' && terrainHit.y < WATER_LEVEL) {
      terrainHit.y = WATER_LEVEL;
    }
    return terrainHit;
  }

  private pickFirstTerrainSurfaceRay(): THREE.Vector3 | null {
    if (this.terrainMesh) {
      this.terrainHits.length = 0;
      this.raycaster.intersectObject(this.terrainMesh, false, this.terrainHits);
      const hit = this.terrainHits[0];
      if (hit) {
        this.worldHit.copy(hit.point);
        return this.worldHit;
      }
    }
    return this.pickFirstTerrainSurfaceBySampling();
  }

  private pickFirstTerrainSurfaceBySampling(): THREE.Vector3 | null {
    const ray = this.raycaster.ray;
    if (ray.direction.y >= -1e-6) return null;

    const heightAt = (t: number): number => getTerrainMeshHeight(
      ray.origin.x + t * ray.direction.x,
      ray.origin.z + t * ray.direction.z,
      this.mapWidth,
      this.mapHeight,
    );
    if (ray.origin.y - heightAt(0) <= 0) return null;

    const maxT = (TILE_FLOOR_Y - ray.origin.y) / ray.direction.y;
    if (!Number.isFinite(maxT) || maxT <= 0) return null;

    const horizontalRate = Math.hypot(ray.direction.x, ray.direction.z);
    const verticalRate = Math.abs(ray.direction.y);
    const horizontalStep = horizontalRate > 1e-6
      ? TERRAIN_RAY_FALLBACK_STEP / horizontalRate
      : Infinity;
    const verticalStep = verticalRate > 1e-6
      ? TERRAIN_RAY_FALLBACK_STEP / verticalRate
      : Infinity;
    const desiredStep = Math.min(horizontalStep, verticalStep);
    const step = Number.isFinite(desiredStep) && desiredStep > 0
      ? Math.max(desiredStep, maxT / TERRAIN_RAY_FALLBACK_MAX_STEPS)
      : maxT / TERRAIN_RAY_FALLBACK_MAX_STEPS;

    let hitLo = 0;
    let hitHi = 0;
    let found = false;
    for (let t = Math.min(step, maxT); t <= maxT + 1e-6; t += step) {
      const clampedT = Math.min(t, maxT);
      const clearance = ray.origin.y + clampedT * ray.direction.y - heightAt(clampedT);
      if (clearance <= 0) {
        hitLo = Math.max(0, clampedT - step);
        hitHi = clampedT;
        found = true;
        break;
      }
    }
    if (!found) return null;

    let hiClearance = ray.origin.y + hitHi * ray.direction.y - heightAt(hitHi);
    for (let i = 0; i < 12; i++) {
      const mid = (hitLo + hitHi) * 0.5;
      const clearance = ray.origin.y + mid * ray.direction.y - heightAt(mid);
      if (clearance > 0) {
        hitLo = mid;
      } else {
        hitHi = mid;
        hiClearance = clearance;
      }
    }

    const t = hiClearance <= 0 ? hitHi : hitLo;
    const x = ray.origin.x + t * ray.direction.x;
    const z = ray.origin.z + t * ray.direction.z;
    this.worldHit.set(
      x,
      getTerrainMeshHeight(x, z, this.mapWidth, this.mapHeight),
      z,
    );
    return this.worldHit;
  }

  /** Cursor → command target point in SIM coords
   *  (sim.x = three.x, sim.y = three.z, sim.z = three.y).
   *  Commands use the same first rendered terrain hit as camera
   *  anchors, then clamp submerged terrain up to the visible water
   *  surface for the returned altitude.
   *  The z component carries the chosen altitude for renderers /
   *  handlers that need it.
   *  Returns null on miss; callers should treat that as "command
   *  cannot be issued from this cursor position". */
  pickSim(clientX: number, clientY: number): SimGroundPoint | null {
    if (!this.setRayFromClient(clientX, clientY)) return null;
    const w = this.pickWorldFromCurrentRay('terrain-3d-water');
    if (!w) return null;
    this.simHit.x = w.x;
    this.simHit.y = w.z;
    this.simHit.z = w.y;
    return this.simHit;
  }
}
