// Debris3D — "material explosion" renderer for the 3D view.
//
// When a unit dies, spawn a cluster of small colored boxes that fly outward
// with velocity + angular velocity, arc downward under gravity, and fade from
// the unit's team color toward the map background over ~1–2 seconds. Each
// piece is a small extruded box shaded with the unit's primary team color;
// the effect reads as a chunky hull coming apart.
//
// LOD via deathExplosionStyle:
//   puff       — ~6 pieces, short arc, fastest fade
//   scatter    — ~14 pieces
//   shatter    — ~28 pieces
//   detonate   — ~50 pieces
//   obliterate — ~80 pieces
//
// The system is a pool + fixed cap per LOD. When the cap is hit the oldest
// pieces are evicted first so a burst of simultaneous deaths doesn't run away.
//
// Triggered via `spawn()` from the scene's SimEvent dispatcher (type='death').

import * as THREE from 'three';
import type { SimDeathContext } from '@/types/combat';
import { getGraphicsConfig } from '@/clientBarConfig';
import { MAP_BG_COLOR } from '../../config';

type DebrisStyle = 'puff' | 'scatter' | 'shatter' | 'detonate' | 'obliterate';

const STYLE_COUNT: Record<DebrisStyle, number> = {
  puff: 6,
  scatter: 14,
  shatter: 28,
  detonate: 50,
  obliterate: 80,
};

// Hard cap on simultaneous pieces across the whole scene; prevents a mass
// explosion from blowing past the frame budget. Matches the 2D DEBRIS_CAPS
// obliterate ceiling.
const GLOBAL_MAX_PIECES = 300;

// Physics. Chosen so a 200 u/s launch rises ~0.3 s then falls back to ground
// in ~0.6 s total — tight enough that debris clears before the next death.
const GRAVITY = 900;       // world units / s²
const DRAG = 0.985;        // per-60Hz-equivalent velocity multiplier
const BASE_LIFETIME_MS = 1400;
const LIFETIME_JITTER_MS = 600;

// Launch speeds (world units / s). Ported roughly from DEBRIS_CONFIG in 2D.
const RANDOM_SPEED_MIN = 80;
const RANDOM_SPEED_RANGE = 180;
const HIT_BIAS_MIN = 60;
const HIT_BIAS_RANGE = 160;
const UP_VELOCITY_MIN = 60;
const UP_VELOCITY_RANGE = 220;
const ANGULAR_MAX = 12;    // rad / s on each axis

// Piece size range. Absolute (world units) rather than unit-relative so tiny
// units still shed chunks that read as "chunks" not specks.
const PIECE_SIZE_MIN = 1.5;
const PIECE_SIZE_RANGE = 2.5;

// Pre-extract the background RGB so fade color lerps avoid per-frame shifts.
const BG_R = ((MAP_BG_COLOR >> 16) & 0xff) / 255;
const BG_G = ((MAP_BG_COLOR >> 8) & 0xff) / 255;
const BG_B = (MAP_BG_COLOR & 0xff) / 255;

type Piece = {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  vx: number;
  vy: number;
  vz: number;
  avx: number;
  avy: number;
  avz: number;
  age: number;
  lifetime: number;
  baseR: number;
  baseG: number;
  baseB: number;
};

export class Debris3D {
  private root: THREE.Group;
  private boxGeom = new THREE.BoxGeometry(1, 1, 1);

  // Active pieces, oldest-first (we push to tail, evict from head when over cap).
  private pieces: Piece[] = [];
  // Mesh pool reused across deaths to avoid per-piece material allocations.
  private pool: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] = [];

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
  }

  /**
   * Spawn a death's worth of debris at (x, z). The context comes straight from
   * SimEvent.deathContext; we read the unit's color, radius, rotation, and the
   * vectors describing the hit (unitVel, hitDir, projectileVel) so pieces arc
   * away from the attacker rather than just scattering uniformly.
   */
  spawn(x: number, z: number, ctx: SimDeathContext): void {
    const style = (getGraphicsConfig().deathExplosionStyle ?? 'scatter') as DebrisStyle;
    const count = STYLE_COUNT[style];
    if (count <= 0) return;

    // Color — unit's team color as the starting state, we lerp toward the map
    // background so pieces visually "burn out" rather than just fading to
    // black (which reads as "disappear into the ground").
    const color = ctx.color ?? 0xcccccc;
    const baseR = ((color >> 16) & 0xff) / 255;
    const baseG = ((color >> 8) & 0xff) / 255;
    const baseB = (color & 0xff) / 255;

    // Hit-direction bias. hitDir is already normalized-ish in the sim; treat
    // its length as the directional weight so unclear hits still get some
    // outward push.
    const hx = ctx.hitDir?.x ?? 0;
    const hy = ctx.hitDir?.y ?? 0;
    const hLen = Math.hypot(hx, hy);
    const biasX = hLen > 1e-5 ? hx / hLen : 0;
    // Sim Y is world Z, so the horizontal hit-bias along Z matches.
    const biasZ = hLen > 1e-5 ? hy / hLen : 0;

    // Size of the debris pieces scales with the unit's visual radius, so a
    // commander coughs up bigger chunks than a scout.
    const unitR = Math.max(ctx.radius ?? 10, 6);
    const sizeBase = Math.max(1, unitR * 0.12);

    for (let i = 0; i < count; i++) {
      const pooled = this.pool.pop();
      let mesh: THREE.Mesh;
      let material: THREE.MeshBasicMaterial;
      if (pooled) {
        mesh = pooled.mesh;
        material = pooled.material;
        material.color.setRGB(baseR, baseG, baseB);
        material.opacity = 1;
        mesh.visible = true;
      } else {
        material = new THREE.MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: 1,
          depthWrite: false,
        });
        mesh = new THREE.Mesh(this.boxGeom, material);
        mesh.renderOrder = 13;
        this.root.add(mesh);
      }

      // Random outward direction in the horizontal plane (with slight radial
      // spread) — upward component is separate so pieces always rise first.
      const angle = Math.random() * Math.PI * 2;
      const outSpeed = RANDOM_SPEED_MIN + Math.random() * RANDOM_SPEED_RANGE;
      const hitSpeed = HIT_BIAS_MIN + Math.random() * HIT_BIAS_RANGE;
      const up = UP_VELOCITY_MIN + Math.random() * UP_VELOCITY_RANGE;

      const vx =
        Math.cos(angle) * outSpeed
        + biasX * hitSpeed
        + (ctx.unitVel?.x ?? 0) * 0.3;
      const vz =
        Math.sin(angle) * outSpeed
        + biasZ * hitSpeed
        + (ctx.unitVel?.y ?? 0) * 0.3;
      const vy = up;

      // Random size and rotation per piece so the cluster doesn't read as
      // identical copies. Starting rotation is also random.
      const size = (PIECE_SIZE_MIN + Math.random() * PIECE_SIZE_RANGE) * sizeBase;
      mesh.scale.setScalar(size);
      mesh.position.set(x, 4 + Math.random() * unitR * 0.4, z);
      mesh.rotation.set(
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
      );

      this.pieces.push({
        mesh, material,
        vx, vy, vz,
        avx: (Math.random() - 0.5) * ANGULAR_MAX,
        avy: (Math.random() - 0.5) * ANGULAR_MAX,
        avz: (Math.random() - 0.5) * ANGULAR_MAX,
        age: 0,
        lifetime: BASE_LIFETIME_MS + Math.random() * LIFETIME_JITTER_MS,
        baseR, baseG, baseB,
      });
    }

    // Evict oldest pieces if we blew past the global cap.
    while (this.pieces.length > GLOBAL_MAX_PIECES) {
      const dropped = this.pieces.shift();
      if (dropped) {
        dropped.mesh.visible = false;
        this.pool.push({ mesh: dropped.mesh, material: dropped.material });
      }
    }
  }

  update(dtMs: number): void {
    const dtSec = dtMs / 1000;
    // Convert per-frame drag (tuned for 60Hz) into a time-aware multiplier so
    // low-fps systems don't see pieces float forever.
    const dragPow = Math.pow(DRAG, dtSec * 60);

    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dtMs;

      // Integrate velocity with gravity + drag.
      p.vy -= GRAVITY * dtSec;
      p.vx *= dragPow;
      p.vy *= dragPow;
      p.vz *= dragPow;
      p.mesh.position.x += p.vx * dtSec;
      p.mesh.position.y += p.vy * dtSec;
      p.mesh.position.z += p.vz * dtSec;

      // Bounce once off the ground with heavy damping, then settle.
      if (p.mesh.position.y < 0.5) {
        p.mesh.position.y = 0.5;
        if (p.vy < 0) {
          p.vy = -p.vy * 0.25;
          p.vx *= 0.6;
          p.vz *= 0.6;
        }
      }

      p.mesh.rotation.x += p.avx * dtSec;
      p.mesh.rotation.y += p.avy * dtSec;
      p.mesh.rotation.z += p.avz * dtSec;

      const t = p.age / p.lifetime;
      if (t >= 1) {
        p.mesh.visible = false;
        this.pool.push({ mesh: p.mesh, material: p.material });
        this.pieces.splice(i, 1);
        continue;
      }

      // Lerp color from team color toward map background so pieces burn out
      // visibly, then fade alpha over the last 40% of lifetime.
      const cLerp = Math.min(1, t * 1.4);
      const r = p.baseR + (BG_R - p.baseR) * cLerp;
      const g = p.baseG + (BG_G - p.baseG) * cLerp;
      const b = p.baseB + (BG_B - p.baseB) * cLerp;
      p.material.color.setRGB(r, g, b);
      p.material.opacity = t < 0.6 ? 1 : Math.max(0, (1 - t) / 0.4);
    }
  }

  destroy(): void {
    for (const p of this.pieces) {
      p.material.dispose();
      this.root.remove(p.mesh);
    }
    for (const { mesh, material } of this.pool) {
      material.dispose();
      this.root.remove(mesh);
    }
    this.pieces.length = 0;
    this.pool.length = 0;
    this.boxGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}
