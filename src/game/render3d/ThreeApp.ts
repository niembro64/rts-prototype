// ThreeApp — Three.js application wrapper (parallel to PixiApp, for the 3D PoC).
//
// Sets up a scene, renderer, camera, lights, and a ground plane. Owns the
// render loop and delegates per-frame work to a callback.

import * as THREE from 'three';
import { OrbitCamera } from './OrbitCamera';

export class ThreeApp {
  public renderer: THREE.WebGLRenderer;
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public orbit: OrbitCamera;
  /** Container holding all game entities (units, buildings, projectiles). */
  public world: THREE.Group;

  private _updateCallback: ((time: number, delta: number) => void) | null = null;
  private _lastTime = 0;
  private _running = false;
  private _rafId = 0;
  private _resizeObserver: ResizeObserver;

  constructor(
    parent: HTMLElement,
    width: number,
    height: number,
    mapWidth: number,
    mapHeight: number,
    backgroundColor: string,
  ) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(backgroundColor);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = false;
    parent.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 1, 50000);

    this.orbit = new OrbitCamera(this.camera, this.renderer.domElement, {
      minDistance: 100,
      maxDistance: 12000,
    });
    // Center on map, pulled in for a useful RTS default view
    this.orbit.setTarget(mapWidth / 2, 0, mapHeight / 2);
    this.orbit.distance = Math.max(mapWidth, mapHeight) * 0.35;
    this.orbit.pitch = Math.PI * 0.28;
    this.orbit.apply();

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(mapWidth * 0.5, 3000, mapHeight * 0.2);
    sun.target.position.set(mapWidth * 0.5, 0, mapHeight * 0.5);
    this.scene.add(sun);
    this.scene.add(sun.target);

    // Ground plane
    const groundGeom = new THREE.PlaneGeometry(mapWidth, mapHeight);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x2a3140 });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(mapWidth / 2, 0, mapHeight / 2);
    this.scene.add(ground);

    // Grid helper for orientation
    const grid = new THREE.GridHelper(
      Math.max(mapWidth, mapHeight),
      Math.round(Math.max(mapWidth, mapHeight) / 500),
      0x444a55,
      0x363b45,
    );
    grid.position.set(mapWidth / 2, 0.5, mapHeight / 2);
    this.scene.add(grid);

    // Map boundary outline
    const boundsGeom = new THREE.BufferGeometry();
    const boundsVerts = new Float32Array([
      0, 1, 0,  mapWidth, 1, 0,
      mapWidth, 1, 0,  mapWidth, 1, mapHeight,
      mapWidth, 1, mapHeight,  0, 1, mapHeight,
      0, 1, mapHeight,  0, 1, 0,
    ]);
    boundsGeom.setAttribute('position', new THREE.BufferAttribute(boundsVerts, 3));
    const boundsMat = new THREE.LineBasicMaterial({ color: 0x5a6270 });
    const bounds = new THREE.LineSegments(boundsGeom, boundsMat);
    this.scene.add(bounds);

    // World group for entities
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this._resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width: w, height: h } = entry.contentRect;
        if (w > 0 && h > 0) {
          this.renderer.setSize(w, h);
          this.camera.aspect = w / h;
          this.camera.updateProjectionMatrix();
        }
      }
    });
    this._resizeObserver.observe(parent);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  onUpdate(callback: (time: number, delta: number) => void): void {
    this._updateCallback = callback;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._lastTime = performance.now();
    const tick = (now: number) => {
      if (!this._running) return;
      const delta = now - this._lastTime;
      this._lastTime = now;
      if (this._updateCallback) this._updateCallback(now, delta);
      this.renderer.render(this.scene, this.camera);
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this._running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  destroy(): void {
    this.stop();
    this.orbit.destroy();
    this._resizeObserver.disconnect();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
  }
}
