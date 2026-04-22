// Debris3D — part-based "material explosion" renderer for unit deaths.
//
// When a unit dies, we look up the unit blueprint, figure out which pieces
// its body was made of (tread slabs, wheels, leg segments, turret heads,
// barrels, chassis edges) and spawn one debris mesh per piece that
// approximates the source's shape, size, and color. Each piece gets a strong
// random spin plus outward launch velocity biased by the hit direction, and
// both spin and velocity decay via the same drag multiplier — so spins start
// fast and slow to a stop while the color fades toward the map background.
//
// The LOD axis (`deathExplosionStyle`) scales the piece count: lower tiers
// emit a fraction of the full template list, higher tiers emit all pieces
// plus extra body-chunk fragments.
//
// Triggered via `spawn()` from the scene's SimEvent dispatcher (type='death').

import * as THREE from 'three';
import type { SimDeathContext } from '@/types/combat';
import { getGraphicsConfig } from '@/clientBarConfig';
import { MAP_BG_COLOR } from '../../config';
import { getUnitBlueprint } from '../sim/blueprints';
import { getTurretBlueprint } from '../sim/blueprints/turrets';
import { leftSideConfigsForStyle } from './Locomotion3D';

type DebrisStyle = 'puff' | 'scatter' | 'shatter' | 'detonate' | 'obliterate';

/** Fraction of the blueprint's full piece list that each LOD emits. Lower
 *  tiers skip most non-body pieces (fewer leg segments, fewer body edges)
 *  while higher tiers emit everything plus extra "generic chunk" fragments
 *  so bigger explosions still feel proportional on high LODs. */
const STYLE_FRACTION: Record<DebrisStyle, number> = {
  puff: 0.25,
  scatter: 0.5,
  shatter: 0.75,
  detonate: 1.0,
  obliterate: 1.0,
};

/** Extra generic chunks added on top of the blueprint pieces, per LOD. */
const STYLE_EXTRA_CHUNKS: Record<DebrisStyle, number> = {
  puff: 0,
  scatter: 4,
  shatter: 10,
  detonate: 20,
  obliterate: 35,
};

// Global cap on simultaneous pieces across the whole scene. Higher than
// before since each death now emits many more shaped fragments.
const GLOBAL_MAX_PIECES = 600;

// Physics. Linear drag mirrors the 2D DebrisSystem (0.99/frame at 60Hz).
// Angular drag is lower so spin decays noticeably faster than travel —
// this produces the "start fast, slow to a stop as they fade" behavior.
const GRAVITY = 900;
const LINEAR_DRAG = 0.985;
const ANGULAR_DRAG = 0.955;

const BASE_LIFETIME_MS = 1700;
const LIFETIME_JITTER_MS = 800;

// Launch speeds.
const RANDOM_SPEED_MIN = 70;
const RANDOM_SPEED_RANGE = 180;
const HIT_BIAS_MIN = 50;
const HIT_BIAS_RANGE = 160;
const UP_VELOCITY_MIN = 80;
const UP_VELOCITY_RANGE = 200;
// Initial angular velocity — strong, so pieces whip on emit. Three axes so
// the tumble reads from any camera angle.
const ANGULAR_INIT = 25;

// Shared fade target so pieces read as "burning out" into the world instead
// of disappearing into black.
const BG_R = ((MAP_BG_COLOR >> 16) & 0xff) / 255;
const BG_G = ((MAP_BG_COLOR >> 8) & 0xff) / 255;
const BG_B = (MAP_BG_COLOR & 0xff) / 255;

// Non-team colors for generic parts (match the 2D colorType palette).
const TREAD_COLOR = 0x3a3e45;
const WHEEL_COLOR = 0x404952;
const LEG_COLOR = 0x3f464f;
const BARREL_COLOR = 0xdcdce0;

type DebrisShape = 'box' | 'cylinder';

/** One piece's launch specification. Geometry is always a unit cube or unit
 *  cylinder; `sx/sy/sz` give final world dimensions. Position is unit-local
 *  (rotated into world space by the unit's heading at spawn). */
type DebrisTemplate = {
  shape: DebrisShape;
  /** Unit-local launch position. For a piece that was at (ox, oz) on the
   *  chassis at spawn, the world position is derived from the unit's pose. */
  ox: number;
  oy: number;  // world Y offset above ground (for HIP/barrel elevation)
  oz: number;
  /** Local-space initial yaw of the piece, added to the unit's heading. */
  yaw: number;
  /** Final world dimensions of the piece (scale applied to unit geom). */
  sx: number;
  sy: number;
  sz: number;
  color: number;
};

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
  private cylGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);

  private pieces: Piece[] = [];
  // One pool per geometry kind so we don't accidentally re-use a cylinder
  // mesh for a box piece (the geometry reference would be wrong).
  private boxPool: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] = [];
  private cylPool: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial }[] = [];

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
  }

  /**
   * Spawn a unit-specific debris cluster at (x, z). Reads `ctx.unitType` to
   * pull the blueprint, then generates a template list covering every visible
   * source (tread slabs, wheels, leg segments, turrets, barrels, body edges)
   * and emits one piece per template.
   */
  spawn(x: number, z: number, ctx: SimDeathContext): void {
    const style = (getGraphicsConfig().deathExplosionStyle ?? 'scatter') as DebrisStyle;
    const fraction = STYLE_FRACTION[style];
    const extraChunks = STYLE_EXTRA_CHUNKS[style];
    if (fraction <= 0 && extraChunks <= 0) return;

    const r = Math.max(ctx.radius ?? 10, 6);
    const color = ctx.color ?? 0xcccccc;
    const rotation = ctx.rotation ?? 0;

    const templates = this.buildTemplates(ctx, r, color);
    // Keep an even stride through the templates so low LODs still hit each
    // "kind" of piece (treads + head + barrel + body) rather than only the
    // front half of the list.
    const stride = fraction >= 1 ? 1 : Math.max(1, Math.round(1 / fraction));

    // Hit-direction bias (sim XY maps to world XZ).
    const hx = ctx.hitDir?.x ?? 0;
    const hz = ctx.hitDir?.y ?? 0;
    const hLen = Math.hypot(hx, hz);
    const biasX = hLen > 1e-5 ? hx / hLen : 0;
    const biasZ = hLen > 1e-5 ? hz / hLen : 0;

    // Unit velocity at death — pieces inherit a fraction so an exploding
    // charging tank still reads as moving when it comes apart.
    const uvx = ctx.unitVel?.x ?? 0;
    const uvz = ctx.unitVel?.y ?? 0;

    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);

    for (let i = 0; i < templates.length; i += stride) {
      this.emitPiece(templates[i], x, z, cosR, sinR, rotation, biasX, biasZ, uvx, uvz, r);
    }

    // Extra generic chunks: small team-colored boxes scattered around the
    // unit, so higher LODs feel "meatier" without needing more blueprint
    // data. Colored with the primary team color.
    for (let i = 0; i < extraChunks; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * r * 0.7;
      const chunk: DebrisTemplate = {
        shape: 'box',
        ox: Math.cos(angle) * dist,
        oy: 4 + Math.random() * r * 0.4,
        oz: Math.sin(angle) * dist,
        yaw: Math.random() * Math.PI * 2,
        sx: 1.5 + Math.random() * 2.5,
        sy: 1.5 + Math.random() * 2.5,
        sz: 1.5 + Math.random() * 2.5,
        color,
      };
      this.emitPiece(chunk, x, z, cosR, sinR, rotation, biasX, biasZ, uvx, uvz, r);
    }

    // Evict oldest pieces if we blew past the global cap.
    while (this.pieces.length > GLOBAL_MAX_PIECES) {
      const dropped = this.pieces.shift();
      if (dropped) this.releaseToPool(dropped);
    }
  }

  /**
   * Build the blueprint-derived piece list. Sources in order:
   *   - treads / wheels / legs (locomotion)
   *   - turret heads + barrels (one per TurretMount)
   *   - chassis body edges (hexagon ring around the center)
   * Returned in a deterministic order so stride-based LOD thinning still
   * covers every source category.
   */
  private buildTemplates(
    ctx: SimDeathContext,
    r: number,
    primary: number,
  ): DebrisTemplate[] {
    const out: DebrisTemplate[] = [];
    if (!ctx.unitType) return this.genericChunkTemplates(r, primary, 8);

    let bp;
    try {
      bp = getUnitBlueprint(ctx.unitType);
    } catch {
      return this.genericChunkTemplates(r, primary, 8);
    }

    // --- Locomotion pieces ---
    const loc = bp.locomotion;
    if (loc?.type === 'treads') {
      const cfg = loc.config;
      const length = r * cfg.treadLength;
      const width = r * cfg.treadWidth;
      const offset = r * cfg.treadOffset;
      for (const side of [-1, 1]) {
        out.push({
          shape: 'box',
          ox: 0, oy: 5, oz: side * offset,
          yaw: 0,
          sx: length, sy: 8, sz: width,
          color: TREAD_COLOR,
        });
        // Break tread into two halves so the debris feels more shattered.
        out.push({
          shape: 'box',
          ox: length * 0.25, oy: 5, oz: side * offset,
          yaw: 0,
          sx: length * 0.5, sy: 6, sz: width * 0.9,
          color: TREAD_COLOR,
        });
      }
    } else if (loc?.type === 'wheels') {
      const cfg = loc.config;
      const fx = r * cfg.wheelDistX;
      const fz = r * cfg.wheelDistY;
      const wheelR = Math.max(2, r * cfg.wheelRadius);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          out.push({
            shape: 'cylinder',
            ox: sx * fx, oy: wheelR, oz: sz * fz,
            yaw: Math.PI / 2,
            // Unit cylinder axis is Y; rotate π/2 around Z-ish to lay flat-ish.
            // We approximate wheel as a short thick disc: diameter = wheelR*2
            // and axial thickness = width*0.6.
            sx: wheelR * 2, sy: wheelR * 0.6, sz: wheelR * 2,
            color: WHEEL_COLOR,
          });
        }
      }
    } else if (loc?.type === 'legs') {
      // Full per-style leg list mirrored for both sides. Each leg emits its
      // upper + lower segment as separate cylinders so the debris has the
      // limb-falling-apart feel of the 2D version.
      const left = leftSideConfigsForStyle(loc.style, r);
      const right = left.map((c) => ({
        ...c,
        attachOffsetY: -c.attachOffsetY,
        snapTargetAngle: -c.snapTargetAngle,
      }));
      const all = [...left, ...right];
      const upperThick = Math.max(1, loc.config.upperThickness) * 0.6;
      const lowerThick = Math.max(1, loc.config.lowerThickness) * 0.6;
      const HIP_Y_LOCAL = 14;
      for (const lc of all) {
        const hipX = lc.attachOffsetX;
        const hipZ = lc.attachOffsetY;
        const restDist =
          (lc.upperLegLength + lc.lowerLegLength) * lc.snapDistanceMultiplier;
        const footA = lc.snapTargetAngle;
        const footX = hipX + Math.cos(footA) * restDist;
        const footZ = hipZ + Math.sin(footA) * restDist;
        // Approximate knee at midpoint of hip-foot, lifted up by a third of
        // the upper leg length (matches the 2D vertical-bend visual roughly).
        const kneeX = (hipX + footX) / 2;
        const kneeZ = (hipZ + footZ) / 2;
        const kneeY = HIP_Y_LOCAL + lc.upperLegLength * 0.1;
        // Upper segment — cylinder between hip and knee
        pushCylinderSegment(out, hipX, HIP_Y_LOCAL, hipZ, kneeX, kneeY, kneeZ, upperThick, LEG_COLOR);
        // Lower segment — cylinder between knee and foot
        pushCylinderSegment(out, kneeX, kneeY, kneeZ, footX, 1, footZ, lowerThick, LEG_COLOR);
      }
    }

    // --- Turret heads + barrels ---
    for (const mount of bp.turrets) {
      let tb;
      try { tb = getTurretBlueprint(mount.turretId); } catch { continue; }
      const tox = mount.offsetX;
      const toz = mount.offsetY;
      // Turret head — small stubby cylinder in team's secondary color. We
      // use a darkened version of the primary so client-side color resolution
      // is deterministic (no need for the PlayerId here).
      const dark = darkenColor(primary);
      const headR = r * 0.35;
      out.push({
        shape: 'cylinder',
        ox: tox, oy: 26, oz: toz,
        yaw: 0,
        sx: headR * 2, sy: 10, sz: headR * 2,
        color: dark,
      });
      // Barrels
      const bs = tb.barrel;
      if (!bs) continue;
      if (bs.type === 'simpleSingleBarrel') {
        const len = r * bs.barrelLength;
        const thick = Math.max(1.5, bs.barrelThickness ?? 2);
        out.push({
          shape: 'cylinder',
          ox: tox + len / 2, oy: 30, oz: toz,
          yaw: Math.PI / 2,   // rotate cylinder axis (+Y) toward +X
          sx: thick, sy: len, sz: thick,
          color: BARREL_COLOR,
        });
      } else if (bs.type === 'simpleMultiBarrel' || bs.type === 'coneMultiBarrel') {
        const len = r * bs.barrelLength;
        const thick = Math.max(1.2, bs.barrelThickness ?? 1.5);
        const n = bs.barrelCount;
        const orbit = bs.type === 'simpleMultiBarrel'
          ? bs.orbitRadius * r
          : bs.baseOrbit * r;
        for (let i = 0; i < n; i++) {
          const a = (i + 0.5) / n * Math.PI * 2;
          const oy = Math.cos(a) * Math.min(orbit, 8);
          const oz = Math.sin(a) * Math.min(orbit, 8);
          out.push({
            shape: 'cylinder',
            ox: tox + len / 2,
            oy: 30 + oy,
            oz: toz + oz,
            yaw: Math.PI / 2,
            sx: thick, sy: len, sz: thick,
            color: BARREL_COLOR,
          });
        }
      }
    }

    // --- Chassis body edges ---
    // 8-sided ring of small box pieces around the unit, colored with the
    // primary team color. Stands in for the 2D `addPolygonEdges` helper.
    const sides = 8;
    const polyR = r * 0.7;
    const edgeLen = polyR * 2 * Math.sin(Math.PI / sides);
    for (let i = 0; i < sides; i++) {
      const a = (i + 0.5) / sides * Math.PI * 2;
      out.push({
        shape: 'box',
        ox: Math.cos(a) * polyR,
        oy: 10,
        oz: Math.sin(a) * polyR,
        yaw: a + Math.PI / 2,   // tangent to ring
        sx: edgeLen,
        sy: 4,
        sz: 2.5,
        color: primary,
      });
    }

    return out;
  }

  /** Fallback when the unit blueprint can't be resolved — emit a small
   *  cluster of generic team-colored chunks so something still reads. */
  private genericChunkTemplates(r: number, color: number, count: number): DebrisTemplate[] {
    const out: DebrisTemplate[] = [];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * r * 0.6;
      out.push({
        shape: 'box',
        ox: Math.cos(angle) * dist,
        oy: 4 + Math.random() * r * 0.4,
        oz: Math.sin(angle) * dist,
        yaw: Math.random() * Math.PI * 2,
        sx: 2 + Math.random() * 3,
        sy: 2 + Math.random() * 3,
        sz: 2 + Math.random() * 3,
        color,
      });
    }
    return out;
  }

  private emitPiece(
    t: DebrisTemplate,
    unitX: number,
    unitZ: number,
    cosR: number,
    sinR: number,
    unitRot: number,
    biasX: number,
    biasZ: number,
    uvx: number,
    uvz: number,
    r: number,
  ): void {
    // Acquire mesh from the right pool (or build a new one).
    let mesh: THREE.Mesh;
    let material: THREE.MeshBasicMaterial;
    const pool = t.shape === 'box' ? this.boxPool : this.cylPool;
    const geom = t.shape === 'box' ? this.boxGeom : this.cylGeom;
    const pooled = pool.pop();
    if (pooled) {
      mesh = pooled.mesh;
      material = pooled.material;
      material.color.setHex(t.color);
      material.opacity = 1;
      mesh.visible = true;
    } else {
      material = new THREE.MeshBasicMaterial({
        color: t.color,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      mesh = new THREE.Mesh(geom, material);
      mesh.renderOrder = 13;
      this.root.add(mesh);
    }
    mesh.scale.set(t.sx, t.sy, t.sz);

    // Unit-local → world position: rotate (ox, oz) by unit heading, add unit
    // center (x, z). Y is already world-absolute.
    const wx = unitX + cosR * t.ox - sinR * t.oz;
    const wz = unitZ + sinR * t.ox + cosR * t.oz;
    mesh.position.set(wx, t.oy, wz);

    // Start rotation: unit heading + template yaw around Y, plus a bit of
    // random roll/pitch so the piece doesn't look perfectly upright at t=0.
    mesh.rotation.set(
      (Math.random() - 0.5) * 0.4,
      unitRot + t.yaw,
      (Math.random() - 0.5) * 0.4,
    );

    // Outward radial velocity from the unit center. For pieces close to the
    // center (body edges), use the template's local offset direction. For
    // off-center pieces (treads, wheels), the radial direction naturally
    // points away from the unit.
    const offLen = Math.hypot(t.ox, t.oz);
    let outX = 1, outZ = 0;
    if (offLen > 1e-3) {
      // Rotate the unit-local outward vector into world space.
      const lx = t.ox / offLen;
      const lz = t.oz / offLen;
      outX = cosR * lx - sinR * lz;
      outZ = sinR * lx + cosR * lz;
    } else {
      const a = Math.random() * Math.PI * 2;
      outX = Math.cos(a);
      outZ = Math.sin(a);
    }

    const outSpeed = RANDOM_SPEED_MIN + Math.random() * RANDOM_SPEED_RANGE;
    const hitSpeed = HIT_BIAS_MIN + Math.random() * HIT_BIAS_RANGE;
    const up = UP_VELOCITY_MIN + Math.random() * UP_VELOCITY_RANGE;

    const vx = outX * outSpeed + biasX * hitSpeed + uvx * 0.3;
    const vz = outZ * outSpeed + biasZ * hitSpeed + uvz * 0.3;
    const vy = up;

    // Strong initial spin on all three axes so the piece reads as tumbling
    // from the moment it spawns. Magnitude scales mildly with piece size so
    // tiny body-edge chunks don't whip visibly faster than big tread slabs.
    const spinScale = Math.max(0.4, Math.min(1.2, 12 / Math.max(t.sx, t.sy, t.sz, 1)));

    const baseR = ((t.color >> 16) & 0xff) / 255;
    const baseG = ((t.color >> 8) & 0xff) / 255;
    const baseB = (t.color & 0xff) / 255;

    this.pieces.push({
      mesh, material,
      vx, vy, vz,
      avx: (Math.random() - 0.5) * ANGULAR_INIT * 2 * spinScale,
      avy: (Math.random() - 0.5) * ANGULAR_INIT * 2 * spinScale,
      avz: (Math.random() - 0.5) * ANGULAR_INIT * 2 * spinScale,
      age: 0,
      lifetime: BASE_LIFETIME_MS + Math.random() * LIFETIME_JITTER_MS,
      baseR, baseG, baseB,
    });
    // Piece size is arbitrary but avoid compiler complaining about `r`.
    void r;
  }

  update(dtMs: number): void {
    const dtSec = dtMs / 1000;
    // Convert per-60Hz drag factors into time-aware multipliers. Linear +
    // angular use different exponents so spin decays visibly faster than
    // travel — the "slow to a stop as they fade" behavior.
    const linDrag = Math.pow(LINEAR_DRAG, dtSec * 60);
    const angDrag = Math.pow(ANGULAR_DRAG, dtSec * 60);

    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dtMs;

      p.vy -= GRAVITY * dtSec;
      p.vx *= linDrag;
      p.vy *= linDrag;
      p.vz *= linDrag;
      p.mesh.position.x += p.vx * dtSec;
      p.mesh.position.y += p.vy * dtSec;
      p.mesh.position.z += p.vz * dtSec;

      // Ground bounce — once, heavy damping, then settle.
      if (p.mesh.position.y < 0.5) {
        p.mesh.position.y = 0.5;
        if (p.vy < 0) {
          p.vy = -p.vy * 0.25;
          p.vx *= 0.55;
          p.vz *= 0.55;
          // Extra angular bleed on ground contact so pieces don't skate.
          p.avx *= 0.5;
          p.avy *= 0.5;
          p.avz *= 0.5;
        }
      }

      p.mesh.rotation.x += p.avx * dtSec;
      p.mesh.rotation.y += p.avy * dtSec;
      p.mesh.rotation.z += p.avz * dtSec;
      p.avx *= angDrag;
      p.avy *= angDrag;
      p.avz *= angDrag;

      const t = p.age / p.lifetime;
      if (t >= 1) {
        this.releaseToPool(p);
        this.pieces.splice(i, 1);
        continue;
      }

      // Color + opacity fade. Lerp toward map background, then start fading
      // alpha in the final 40% so pieces burn out smoothly.
      const cLerp = Math.min(1, t * 1.4);
      p.material.color.setRGB(
        p.baseR + (BG_R - p.baseR) * cLerp,
        p.baseG + (BG_G - p.baseG) * cLerp,
        p.baseB + (BG_B - p.baseB) * cLerp,
      );
      p.material.opacity = t < 0.6 ? 1 : Math.max(0, (1 - t) / 0.4);
    }
  }

  private releaseToPool(p: Piece): void {
    p.mesh.visible = false;
    // Heuristic: meshes with the box geometry go to the box pool, others go
    // to cyl pool. Geometry is shared so we can compare by reference.
    if (p.mesh.geometry === this.boxGeom) {
      this.boxPool.push({ mesh: p.mesh, material: p.material });
    } else {
      this.cylPool.push({ mesh: p.mesh, material: p.material });
    }
  }

  destroy(): void {
    for (const p of this.pieces) {
      p.material.dispose();
      this.root.remove(p.mesh);
    }
    for (const { mesh, material } of this.boxPool) {
      material.dispose();
      this.root.remove(mesh);
    }
    for (const { mesh, material } of this.cylPool) {
      material.dispose();
      this.root.remove(mesh);
    }
    this.pieces.length = 0;
    this.boxPool.length = 0;
    this.cylPool.length = 0;
    this.boxGeom.dispose();
    this.cylGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}

// --- Local helpers ---

/** Push one cylinder template that spans (ax..bx) in unit-local space. The
 *  cylinder is placed at the midpoint and oriented along the (a→b) vector. */
function pushCylinderSegment(
  out: DebrisTemplate[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  thickness: number,
  color: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-3) return;
  // Yaw so the cylinder's +Y axis rotates toward the segment in the XZ
  // plane. We don't attempt pitch — legs lie nearly flat, so flat yaw
  // approximation reads fine and avoids extra per-template data. Then scale
  // sy = length, sx/sz = thickness.
  const yaw = Math.atan2(dz, dx) - Math.PI / 2;
  out.push({
    shape: 'cylinder',
    ox: (ax + bx) / 2,
    oy: (ay + by) / 2,
    oz: (az + bz) / 2,
    yaw,
    sx: thickness,
    sy: length,
    sz: thickness,
    color,
  });
}

/** Darken a 0xRRGGBB color by roughly 50% for turret-head secondary shading,
 *  matching the 2D DebrisSystem `colorType: 'dark'` path. */
function darkenColor(c: number): number {
  const r = ((c >> 16) & 0xff) >> 1;
  const g = ((c >> 8) & 0xff) >> 1;
  const b = (c & 0xff) >> 1;
  return (r << 16) | (g << 8) | b;
}
