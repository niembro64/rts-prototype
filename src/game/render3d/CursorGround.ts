// CursorGround — single canonical "where is the cursor on the actual
// 3D ground?" service. One raycaster, one terrain mesh, two lenses:
// `pickWorld` returns three.js coords (used by OrbitCamera for zoom +
// pan anchoring), `pickSim` returns sim coords (used by Input3DManager
// for every command point — waypoints, attack-moves, build clicks,
// dgun targets, factory rallies, etc.).
//
// The point is to make it impossible to accidentally use a y=0 plane
// projection anywhere in the input pipeline. If you need the world
// point under the cursor — for ANY purpose — go through this.
//
// Three coord ↔ sim coord mapping (the project-wide convention):
//   sim.x  = three.x
//   sim.y  = three.z
//   sim.z  = three.y     (altitude / height)

import * as THREE from 'three';

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

  /** Cursor → world point on the rendered terrain mesh, in THREE.JS
   *  coords. Returns null on miss (cursor over sky, past the map
   *  edge, terrain mesh not built yet). The returned Vector3 is a
   *  SHARED scratch — read it immediately or copy if you need to
   *  retain. */
  pickWorld(clientX: number, clientY: number): THREE.Vector3 | null {
    const mesh = this.getTerrainMesh();
    if (!mesh) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.ndc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(mesh, false);
    if (hits.length === 0) return null;
    this.worldHit.copy(hits[0].point);
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
