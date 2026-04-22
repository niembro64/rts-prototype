// BurnMark3D — ground scorches along laser / beam paths, plus a pulsing glow
// at each live beam's termination point.
//
// Every frame we sample all live beam/laser projectiles' `endX/Y` and compare
// to the previous endpoint recorded for the same beam (keyed by source +
// turret). If the endpoint has moved, we drop a stretched quad on the ground
// spanning the segment from the previous to the current endpoint — that's the
// burn mark. Marks fade from hot orange to dark residue over a few seconds
// and are evicted oldest-first once a global cap is hit.
//
// Separately, we keep one "hit glow" mesh per live beam: a small flat disk
// on the ground at the current endpoint that pulses while the beam is active
// and disappears the frame the beam stops firing. This matches the 2D
// renderer's laser-end flash.
//
// Triggered passively from update() — no SimEvents required. The scene passes
// in the current projectile list each frame.

import * as THREE from 'three';
import type { Entity } from '../sim/types';
import { isLineShot } from '../sim/types';
import { getGraphicsConfig } from '@/clientBarConfig';

// Burn marks sit a hair above the tile floor (y=0) so they render over the
// capture-tile grid without z-fighting. Must be below SHOT_HEIGHT so beam
// cylinders still draw above them.
// Burn marks sit comfortably above the tile layer. The capture-tile floor
// (y=0) uses a negative polygonOffset to bias its fragments toward the
// camera, so a small lift isn't enough — lift high enough that depth
// precision at far zoom can't matter, and additionally apply a polygonOffset
// on the mark material so marks always win the depth test against tiles.
const MARK_Y = 2.5;
// Hit-glow sphere sits on the ground plane; we lift slightly so the lower
// hemisphere doesn't clip through the tile layer at grazing camera angles.
const GLOW_Y = 3.0;

// Color curve for a mark's lifetime.
const MARK_HOT = new THREE.Color(0xffaa33);   // fresh burn
const MARK_COOL = new THREE.Color(0x1a0e06);  // cooled residue
const MARK_HOT_MS = 250;                       // hold hot color briefly
const MARK_COOL_MS = 3500;                     // finish cooling by this time
const MARK_FADE_START_MS = 2500;               // alpha fade starts here
const MARK_LIFETIME_MS = 5500;                 // fully transparent by this age

// Max live scorch marks across the whole scene. When exceeded we evict the
// oldest entries. Chosen high enough to trace a 10-second beam sweep at
// reasonable cell density without running the GPU out of quads.
const GLOBAL_MAX_MARKS = 400;

// Minimum squared distance between previous and current endpoint required to
// drop a new segment. Prevents a stationary laser from stacking thousands of
// zero-length quads on the same spot.
const MIN_SEGMENT_DIST_SQ = 4;

// Sample every frame by default, but lower LODs (burnMarkFramesSkip > 0) drop
// every N+1th sample so the trail is sparser on slow systems.
type BeamState = { prevX: number; prevY: number; glow?: THREE.Mesh };

type Mark = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  age: number;
};

export class BurnMark3D {
  private root: THREE.Group;
  // A unit plane on the ground; scaled to (segmentLength × beamWidth) per mark.
  private planeGeom = new THREE.PlaneGeometry(1, 1);

  // Hit-glow spheres — a small volumetric ball at the beam's endpoint reads
  // as a 3D impact from any camera angle (unlike a flat disk, which
  // disappears when viewed edge-on).
  private glowGeom = new THREE.SphereGeometry(1, 16, 12);
  // Shared material for all glow spheres — each glow just tweaks position/scale.
  private glowMat: THREE.MeshBasicMaterial;

  private marks: Mark[] = [];
  private markPool: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] = [];

  // Keyed by `${sourceEntityId}:${turretIndex}`. Entries are dropped the frame
  // their beam goes away (no projectile with that key this frame).
  private beams = new Map<string, BeamState>();
  private _seenBeamKeys = new Set<string>();

  // Frame skip counter — when `burnMarkFramesSkip` is 1 we only sample every
  // other frame, 2 = every third, etc. Zero = every frame.
  private _frameCounter = 0;

  // Glow mesh pool (one disk per live beam; reused as beams come and go).
  private glowPool: THREE.Mesh[] = [];

  // Time-of-day counter for pulsing glow (shared across all live glows).
  private _time = 0;

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
    this.glowMat = new THREE.MeshBasicMaterial({
      color: 0xffcc66,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
  }

  /**
   * Sample live beam projectiles and age existing marks. Called from the
   * scene's per-frame update. `projectiles` is the full list; we filter to
   * beam/laser types.
   */
  update(projectiles: readonly Entity[], dtMs: number): void {
    this._time += dtMs;

    const framesSkip = getGraphicsConfig().burnMarkFramesSkip ?? 0;
    const sampleBurn = this._frameCounter === 0;
    this._frameCounter = (this._frameCounter + 1) % (framesSkip + 1);

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
      const shotCfg = proj.config.shot;
      const beamWidth = isLineShot(shotCfg) ? shotCfg.width : 2;

      // Drop a burn segment between prev endpoint and current, IF we've
      // already seen this beam at least once and the endpoint actually moved.
      let state = this.beams.get(key);
      if (state && sampleBurn) {
        const dx = ex - state.prevX;
        const dy = ez - state.prevY;
        if (dx * dx + dy * dy > MIN_SEGMENT_DIST_SQ) {
          this.addMark(state.prevX, state.prevY, ex, ez, beamWidth);
        }
      }
      if (!state) {
        state = { prevX: ex, prevY: ez };
        this.beams.set(key, state);
      } else if (sampleBurn) {
        state.prevX = ex;
        state.prevY = ez;
      }

      // Live hit glow at the endpoint — pulses while the beam is active.
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
      const pulse = 1 + Math.sin(this._time * 0.025) * 0.15;
      const r = Math.max(beamWidth * 3, 6) * pulse;
      state.glow.position.set(ex, GLOW_Y, ez);
      state.glow.scale.setScalar(r);
    }

    // Drop state + release glow for beams that no longer exist.
    for (const [key, state] of this.beams) {
      if (!this._seenBeamKeys.has(key)) {
        if (state.glow) {
          state.glow.visible = false;
          this.glowPool.push(state.glow);
        }
        this.beams.delete(key);
      }
    }

    // Age + fade existing marks.
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const m = this.marks[i];
      m.age += dtMs;
      if (m.age >= MARK_LIFETIME_MS) {
        m.mesh.visible = false;
        this.markPool.push({ mesh: m.mesh, material: m.material });
        this.marks.splice(i, 1);
        continue;
      }
      // Color: hot for MARK_HOT_MS, then interpolate toward cool over
      // (MARK_COOL_MS - MARK_HOT_MS).
      if (m.age < MARK_HOT_MS) {
        m.material.color.copy(MARK_HOT);
      } else if (m.age < MARK_COOL_MS) {
        const t = (m.age - MARK_HOT_MS) / (MARK_COOL_MS - MARK_HOT_MS);
        m.material.color.copy(MARK_HOT).lerp(MARK_COOL, t);
      } else {
        m.material.color.copy(MARK_COOL);
      }
      // Alpha: full until MARK_FADE_START_MS, then linearly to zero.
      if (m.age < MARK_FADE_START_MS) {
        m.material.opacity = 0.85;
      } else {
        const t = (m.age - MARK_FADE_START_MS) / (MARK_LIFETIME_MS - MARK_FADE_START_MS);
        m.material.opacity = Math.max(0, 0.85 * (1 - t));
      }
    }
  }

  private addMark(
    ax: number, az: number, bx: number, bz: number, beamWidth: number,
  ): void {
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (length < 1e-3) return;

    const pooled = this.markPool.pop();
    let mesh: THREE.Mesh;
    let material: THREE.MeshBasicMaterial;
    if (pooled) {
      mesh = pooled.mesh;
      material = pooled.material;
      material.color.copy(MARK_HOT);
      material.opacity = 0.85;
      mesh.visible = true;
    } else {
      material = new THREE.MeshBasicMaterial({
        color: MARK_HOT,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: THREE.DoubleSide,
        // Bias marks toward the camera in depth space so they always win
        // against the capture-tile floor (which also uses polygonOffset).
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      mesh = new THREE.Mesh(this.planeGeom, material);
      mesh.renderOrder = 10;
      this.root.add(mesh);
    }

    // PlaneGeometry default faces +Z; rotate -π/2 around X so it lies on the
    // XZ ground plane facing +Y. Then rotate around Y to align the plane's
    // X axis (length) with the segment direction.
    mesh.rotation.set(-Math.PI / 2, 0, 0);
    const angle = Math.atan2(dz, dx);
    mesh.rotation.z = -angle;
    mesh.position.set((ax + bx) / 2, MARK_Y, (az + bz) / 2);
    // scale.x = segment length, scale.y = beam width · 2 (so the mark reads
    // a little wider than the beam, matching the 2D BurnMarkSystem's `width * 2`).
    mesh.scale.set(length, Math.max(beamWidth * 2, 2), 1);

    this.marks.push({ mesh, material, age: 0 });

    while (this.marks.length > GLOBAL_MAX_MARKS) {
      const dropped = this.marks.shift();
      if (dropped) {
        dropped.mesh.visible = false;
        this.markPool.push({ mesh: dropped.mesh, material: dropped.material });
      }
    }
  }

  destroy(): void {
    for (const m of this.marks) {
      m.material.dispose();
      this.root.remove(m.mesh);
    }
    for (const { mesh, material } of this.markPool) {
      material.dispose();
      this.root.remove(mesh);
    }
    for (const glow of this.glowPool) this.root.remove(glow);
    for (const state of this.beams.values()) {
      if (state.glow) this.root.remove(state.glow);
    }
    this.marks.length = 0;
    this.markPool.length = 0;
    this.glowPool.length = 0;
    this.beams.clear();
    this.planeGeom.dispose();
    this.glowGeom.dispose();
    this.glowMat.dispose();
    this.root.parent?.remove(this.root);
  }
}
