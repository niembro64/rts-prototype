// CursorGround — single canonical "where is the cursor on the actual
// 3D ground?" service. One raycaster, one terrain mesh, two lenses:
// `pickWorld` returns three.js coords (used by OrbitCamera for zoom +
// pan anchoring), `pickSim` returns sim coords (used by Input3DManager
// for every command point — waypoints, attack-moves, build clicks,
// dgun targets, factory rallies, etc.).
//
// Three coord ↔ sim coord mapping (the project-wide convention):
//   sim.x  = three.x
//   sim.y  = three.z
//   sim.z  = three.y     (altitude / height)
//
// SUBMERGED-HIT FALLBACK. The terrain mesh is a heightmap that dips
// DOWN to TILE_FLOOR_Y in lake basins. The water plane is a separate
// translucent mesh layered on top at WATER_LEVEL — it does NOT
// participate in the raycast. So for a typical RTS camera pitch
// (~50°), a click on what visually appears to be the FAR shore of a
// lake casts a ray that enters the basin from above and hits the
// near-side SUBMERGED basin slope FIRST (it's closer to the camera
// than the far shore). The terrain hit's three.y is below
// WATER_LEVEL — literally underground. If we returned that point,
// move commands resolve to a goal cell INSIDE the lake, the
// pathfinder snaps it to the nearest open cell (often the unit's
// own side of the lake), and the unit walks a tiny distance instead
// of crossing.
//
// Fix: when the terrain hit is submerged, fall back to a flat-ground
// plane projection at three.y = 0 (= sim.z = 0, the world's
// "building zero"). The plane projection gives the horizontal
// (x, z) where the cursor's ray would land if no terrain dipped
// below it — i.e. the actual horizontal target the user pointed at.
// Far-shore clicks resolve to far-shore coordinates; clicks ON water
// resolve to a horizontal point at the visible water surface (the
// flat-plane at y=0 is close enough to the water plane at
// WATER_LEVEL=-480 for command purposes; the pathfinder doesn't
// care about altitude).

import * as THREE from 'three';
import { WATER_LEVEL } from '../sim/Terrain';

export type SimGroundPoint = {
  x: number;
  y: number;
  z: number;
};

export class CursorGround {
  private camera: THREE.PerspectiveCamera;
  private canvas: HTMLElement;
  private getTerrainMesh: () => THREE.Mesh | null;

  // Reusable scratch — never allocate per-call on hot input paths.
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private worldHit = new THREE.Vector3();
  private simHit: SimGroundPoint = { x: 0, y: 0, z: 0 };

  constructor(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLElement,
    getTerrainMesh: () => THREE.Mesh | null,
  ) {
    this.camera = camera;
    this.canvas = canvas;
    this.getTerrainMesh = getTerrainMesh;
  }

  /** Cursor → world point under the cursor, in THREE.JS coords.
   *
   *  Tries the terrain raycast first; if that hits SUBMERGED
   *  terrain (three.y < WATER_LEVEL — see file header for the
   *  reason this is wrong for click commands), falls back to a
   *  flat ground-plane intersection at three.y = 0. The
   *  fallback is also used when the raycast misses entirely
   *  (cursor over sky / past the map edge / terrain mesh not
   *  yet built) — anything where a command should still be
   *  issuable based on horizontal cursor position.
   *
   *  Returns null only when the cursor's ray is parallel to or
   *  below the ground plane (degenerate camera pose).
   *
   *  The returned Vector3 is a SHARED scratch — read it
   *  immediately or copy if you need to retain. */
  pickWorld(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);

    // First try the terrain mesh raycast. Use the hit only if it's
    // ABOVE water level — otherwise the user clicked "through" a
    // lake and the hit is on the near-side basin floor, which is
    // not what they were pointing at.
    const mesh = this.getTerrainMesh();
    if (mesh) {
      const hits = this.raycaster.intersectObject(mesh, false);
      if (hits.length > 0 && hits[0].point.y >= WATER_LEVEL) {
        this.worldHit.copy(hits[0].point);
        return this.worldHit;
      }
    }

    // Fall back to flat ground-plane (three.y = 0) projection.
    // This is what the user's cursor was actually pointing at on
    // the playable surface, regardless of any basin dipping below.
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

  /** Cursor → world point on the rendered terrain mesh, in SIM
   *  coords (sim.x = three.x, sim.y = three.z, sim.z = three.y).
   *  This is THE function every command builder should call — it
   *  guarantees the (x, y) you write into a Move / Build / DGun /
   *  WaypointTarget / FactoryWaypoint / RallyPoint command is the
   *  point on the actual 3D ground surface the user clicked, not a
   *  y=0 plane projection. The z component carries the terrain
   *  altitude at that XY for renderers / handlers that need it.
   *  Returns null on miss; callers should treat that as "command
   *  cannot be issued from this cursor position". */
  pickSim(clientX: number, clientY: number): SimGroundPoint | null {
    const w = this.pickWorld(clientX, clientY);
    if (!w) return null;
    this.simHit.x = w.x;
    this.simHit.y = w.z;
    this.simHit.z = w.y;
    return this.simHit;
  }
}
