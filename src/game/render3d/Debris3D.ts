// Debris3D — part-based "material explosion" renderer for unit deaths.
//
// Every atomic part of the unit (each tread slab, each wheel, each leg
// segment, each turret head, each barrel, each chassis edge) emits exactly
// one debris piece whose shape, size, and spawn origin match the real part
// as rendered by Render3DEntities / Locomotion3D / BodyShape3D. Pieces are
// strong-spin at spawn and decay via separate angular and linear drag so
// the tumble visibly slows to a stop while the color fades toward the map
// background.
//
// The `deathExplosionStyle` LOD only narrows the final list lightly — at
// 'puff' we take every other piece, at 'scatter' three quarters, at
// 'shatter'/'detonate'/'obliterate' we emit all pieces. Every LOD still
// sees pieces from each kind of source (treads, legs, turret, body, etc.)
// because the selection strides through the template list rather than
// truncating the tail.

import * as THREE from 'three';
import type { SimDeathContext } from '@/types/combat';
import { getGraphicsConfig } from '@/clientBarConfig';
import { MAP_BG_COLOR, GRAVITY, MIRROR_BASE_Y, MIRROR_EXTRA_HEIGHT } from '../../config';
import { getUnitBlueprint } from '../sim/blueprints';
import { getTurretBlueprint } from '../sim/blueprints/turrets';
import { getShotBlueprint } from '../sim/blueprints/shots';
import { leftSideConfigsForStyle } from './Locomotion3D';
import { getBodyEdgeTemplates } from './BodyShape3D';
import { getBodyTopY, getSegmentMidYAt } from '../math/BodyDimensions';
import { turretHeadRadiusFromBodyRadius } from '../math';

type DebrisStyle = 'puff' | 'scatter' | 'shatter' | 'detonate' | 'obliterate';

/** Stride through the template list — every Nth piece is emitted. '1' means
 *  emit every piece, '2' every other, etc. All pieces are visually
 *  equivalent so a stride still yields a representative mix. */
const STYLE_STRIDE: Record<DebrisStyle, number> = {
  puff: 2,
  scatter: 1,
  shatter: 1,
  detonate: 1,
  obliterate: 1,
};

// Must match the values in Render3DEntities for sizes to line up with the
// source parts. Head sphere radius and per-turret column height come
// from getTurretHeadRadius (per-turret bodyRadius wins, falling back to
// the unit-scale default). TURRET_HEIGHT survives only as the legacy
// orbit-cone safety clamp on auto-derived `tipOrbit` — same value the
// renderer uses, so the two stay locked.
const TURRET_HEIGHT = 16;
const BARREL_MIN_THICKNESS = 2;

// Must match Locomotion3D. Hip Y is per-leg now (mid-height of the
// body segment the leg attaches to), resolved via getSegmentMidYAt.
const TREAD_HEIGHT = 10;
const TREAD_Y = TREAD_HEIGHT / 2;
const FOOT_Y = 1;

// Global cap on simultaneous pieces across the scene — generous since most
// units only produce ~30-60 pieces now. Old pieces are evicted oldest-first.
const GLOBAL_MAX_PIECES = 800;

// Physics. Linear drag mirrors the 2D DebrisSystem (~0.99/frame at 60Hz).
// Angular drag is lower so spin decays noticeably faster than travel — the
// "start fast, slow to a stop" behavior the user asked for.
// Gravity is imported from config.ts — single value shared with everything
// that falls (physics engine, projectile arc, client prediction).
const LINEAR_DRAG = 0.985;
const ANGULAR_DRAG = 0.955;

const BASE_LIFETIME_MS = 1700;
const LIFETIME_JITTER_MS = 800;

// Launch speeds (world units / s).
const RANDOM_SPEED_MIN = 70;
const RANDOM_SPEED_RANGE = 160;
const HIT_BIAS_MIN = 40;
const HIT_BIAS_RANGE = 140;
const UP_VELOCITY_MIN = 80;
const UP_VELOCITY_RANGE = 200;
// Initial angular velocity magnitude on each axis — chosen so big slabs
// whip visibly without spinning absurdly fast.
const ANGULAR_INIT = 22;

// Shared fade target — pieces lerp toward this color so they read as
// "burning out into the terrain" rather than disappearing into black.
const BG_R = ((MAP_BG_COLOR >> 16) & 0xff) / 255;
const BG_G = ((MAP_BG_COLOR >> 8) & 0xff) / 255;
const BG_B = (MAP_BG_COLOR & 0xff) / 255;

// Non-team colors for generic parts (tread gray, wheel gray, barrel white,
// leg gray). Close to the values used by Locomotion3D's shared materials.
const TREAD_COLOR = 0x1a1d22;
const WHEEL_COLOR = 0x2a2f36;
const LEG_COLOR = 0x2a2f36;
const BARREL_COLOR = 0xffffff;

/** A piece template. Boxes describe (position + yaw + size); cylinders
 *  describe (endpoint A, endpoint B, thickness) — the cylinder spans A→B
 *  with its axis aligned to the delta, matching how Locomotion3D places
 *  leg + barrel cylinders. All positions are in unit-local coords at spawn;
 *  the unit's rotation is baked in at emit time. */
type DebrisTemplate =
  | {
      shape: 'box';
      x: number; y: number; z: number;
      yaw: number;
      sx: number; sy: number; sz: number;
      color: number;
    }
  | {
      shape: 'cyl';
      /** Endpoint A in unit-local coords. */
      ax: number; ay: number; az: number;
      /** Endpoint B in unit-local coords. */
      bx: number; by: number; bz: number;
      /** Radius scale — the cylinder diameter = 2·thickness after scale. */
      thickness: number;
      color: number;
    }
  | {
      shape: 'sphere';
      /** Sphere center in unit-local coords. */
      x: number; y: number; z: number;
      /** Sphere radius. */
      radius: number;
      color: number;
    };

type Piece = {
  mesh: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
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
  // Shared geometries — box is unit cube, cylinder is unit radius/height,
  // sphere is unit radius (used for turret heads, which Render3DEntities
  // also draws as a sphere).
  private boxGeom = new THREE.BoxGeometry(1, 1, 1);
  private cylGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  private sphereGeom = new THREE.SphereGeometry(1, 10, 8);

  private pieces: Piece[] = [];
  private boxPool: { mesh: THREE.Mesh; material: THREE.MeshLambertMaterial }[] = [];
  private cylPool: { mesh: THREE.Mesh; material: THREE.MeshLambertMaterial }[] = [];
  private spherePool: { mesh: THREE.Mesh; material: THREE.MeshLambertMaterial }[] = [];

  // Scratch vectors reused per emit — avoids per-piece allocation.
  private _up = new THREE.Vector3(0, 1, 0);
  private _dir = new THREE.Vector3();

  constructor(parentWorld: THREE.Group) {
    this.root = new THREE.Group();
    parentWorld.add(this.root);
  }

  /** Spawn a full debris cluster for a dying unit at a full 3D sim pos.
   *  (simX, simY) is the horizontal footprint, simZ is the unit's sim
   *  altitude at death. Debris piece template y coords are local-to-
   *  ground; emitPiece adds (simZ − unit radius) so an airborne unit
   *  dying at z=100 has its debris spawn up there instead of at the
   *  ground. A ground-resting unit's math reduces to the old path
   *  because simZ − radius = 0. */
  spawn(simX: number, simY: number, simZ: number, ctx: SimDeathContext): void {
    const style = (getGraphicsConfig().deathExplosionStyle ?? 'scatter') as DebrisStyle;
    const stride = STYLE_STRIDE[style];

    const r = Math.max(ctx.radius ?? 10, 6);
    const primary = ctx.color ?? 0xcccccc;
    const rotation = ctx.rotation ?? 0;
    // Vertical lift of the piece's local-y so aerial deaths shed
    // debris at altitude rather than at ground level.
    const groundZ = simZ - r;

    const templates = this.buildTemplates(ctx, r, primary);

    // Hit bias (sim XY → world XZ) — biases all pieces away from the
    // attacker. Small magnitude so it reads as a nudge rather than a shove.
    const hx = ctx.hitDir?.x ?? 0;
    const hz = ctx.hitDir?.y ?? 0;
    const hLen = Math.hypot(hx, hz);
    const biasX = hLen > 1e-5 ? hx / hLen : 0;
    const biasZ = hLen > 1e-5 ? hz / hLen : 0;

    // Pieces inherit a fraction of the unit's velocity at death.
    const uvx = ctx.unitVel?.x ?? 0;
    const uvz = ctx.unitVel?.y ?? 0;

    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);

    for (let i = 0; i < templates.length; i += stride) {
      this.emitPiece(templates[i], simX, simY, groundZ, cosR, sinR, rotation, biasX, biasZ, uvx, uvz);
    }

    // Evict oldest pieces if we blew past the global cap.
    while (this.pieces.length > GLOBAL_MAX_PIECES) {
      const dropped = this.pieces.shift();
      if (dropped) this.releaseToPool(dropped);
    }
  }

  /**
   * Build the full list of one-piece-per-atomic-part templates from the unit
   * blueprint + death context. Each source category (treads / wheels / legs /
   * turrets / body edges) contributes pieces in turn so the template order
   * interleaves sources evenly — helpful for stride-based LOD thinning.
   */
  private buildTemplates(
    ctx: SimDeathContext,
    r: number,
    primary: number,
  ): DebrisTemplate[] {
    const out: DebrisTemplate[] = [];
    if (!ctx.unitType) return this.fallbackTemplates(r, primary);

    let bp;
    try {
      bp = getUnitBlueprint(ctx.unitType);
    } catch {
      return this.fallbackTemplates(r, primary);
    }

    // --- Locomotion parts ---
    const loc = bp.locomotion;
    if (loc?.type === 'treads') {
      // Each side's full tread slab — same size the 3D locomotion draws.
      const cfg = loc.config;
      const length = r * cfg.treadLength;
      const width = r * cfg.treadWidth;
      const offset = r * cfg.treadOffset;
      for (const side of [-1, 1]) {
        out.push({
          shape: 'box',
          x: 0, y: TREAD_Y, z: side * offset,
          yaw: 0,
          sx: length, sy: TREAD_HEIGHT, sz: width,
          color: TREAD_COLOR,
        });
      }
    } else if (loc?.type === 'wheels') {
      // Four corner wheels as short tire cylinders (matches the live
      // renderer's buildWheels — axle along the unit's lateral axis,
      // radius = r·wheelRadius, width = r·treadWidth).
      const cfg = loc.config;
      const wheelR = Math.max(1, r * cfg.wheelRadius);
      const tireWidth = Math.max(0.5, r * cfg.treadWidth);
      const fx = r * cfg.wheelDistX;
      const fz = r * cfg.wheelDistY;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          out.push({
            shape: 'cyl',
            ax: sx * fx, ay: wheelR, az: sz * fz - tireWidth / 2,
            bx: sx * fx, by: wheelR, bz: sz * fz + tireWidth / 2,
            thickness: wheelR,
            color: WHEEL_COLOR,
          });
        }
      }
    } else if (loc?.type === 'legs') {
      // One cylinder per upper segment + one per lower segment, placed at
      // their rest-pose hip/knee/foot positions — same math Locomotion3D
      // uses to initialize legs.
      const left = leftSideConfigsForStyle(loc.style, r);
      const right = left.map((c) => ({
        ...c,
        attachOffsetY: -c.attachOffsetY,
        snapTargetAngle: -c.snapTargetAngle,
      }));
      const all = [...left, ...right];
      const upperThick = Math.max(1, loc.config.upperThickness) * 0.6;
      const lowerThick = Math.max(1, loc.config.lowerThickness) * 0.6;
      const legRendererId = bp.renderer ?? 'arachnid';
      for (const lc of all) {
        const hipX = lc.attachOffsetX;
        const hipZ = lc.attachOffsetY;
        // Hip Y matches Locomotion3D: mid-height of whichever body
        // segment this leg attaches to.
        const hipY = getSegmentMidYAt(legRendererId, r, hipX);
        const restDist =
          (lc.upperLegLength + lc.lowerLegLength) * lc.snapDistanceMultiplier;
        const footA = lc.snapTargetAngle;
        const footX = hipX + Math.cos(footA) * restDist;
        const footZ = hipZ + Math.sin(footA) * restDist;
        // Approximate knee at the midpoint of hip↔foot, lifted up — matches
        // the visible "knee bends upward" pose from Locomotion3D.
        const kneeX = (hipX + footX) / 2;
        const kneeZ = (hipZ + footZ) / 2;
        const kneeY = hipY + lc.upperLegLength * 0.15;
        out.push({
          shape: 'cyl',
          ax: hipX, ay: hipY, az: hipZ,
          bx: kneeX, by: kneeY, bz: kneeZ,
          thickness: upperThick,
          color: LEG_COLOR,
        });
        out.push({
          shape: 'cyl',
          ax: kneeX, ay: kneeY, az: kneeZ,
          bx: footX, by: FOOT_Y, bz: footZ,
          thickness: lowerThick,
          color: LEG_COLOR,
        });
      }
    }

    // --- Turret heads + barrels ---
    // One piece per mounted turret head, plus one piece per barrel in each
    // turret's barrel config. Turret-local Y sits on top of the unit's
    // per-renderer body (tall-bodied units => turret debris spawns higher).
    // The turret head and mirror panels use the same `primary` color as
    // the chassis — Render3DEntities now does the same so unit body and
    // turret read as one solid color at one saturation. (lookupSecondary-
    // Color is unused here now but kept around in case someone wants a
    // contrasting tint later.)
    const rendererId = bp.renderer ?? 'arachnid';
    const bodyTopY = getBodyTopY(rendererId, r);
    for (const mount of bp.turrets) {
      let tb;
      try { tb = getTurretBlueprint(mount.turretId); } catch { continue; }
      const tox = mount.offsetX;
      const toz = mount.offsetY;

      // Per-turret head radius. Each turret column is 2·headRadius tall:
      // sphere bottom touches chassis top, sphere top is the highest point
      // of the turret. Barrels pivot through the sphere center. Mirror
      // panels (when present) replace the sphere visually but use the
      // same vertical span. Per-turret bodyRadius takes precedence over
      // the auto-derived default — matches Render3DEntities.buildTurretMesh.
      const headR = turretHeadRadiusFromBodyRadius(r, tb.bodyRadius);
      const shotHeight = bodyTopY + headR;

      // Skip the head + barrels for the mirror-host turret — its visible
      // body IS the mirror panels, not a separate cylinder. Render3DEntities
      // does the same skip via `isMirrorHost` in buildTurretMesh.
      const isMirrorHost = (tb.mirrorPanels?.length ?? 0) > 0;
      if (!isMirrorHost) {
        // Turret head — SPHERE of radius `headR`, centered at headR above
        // the unit body so the sphere bottom touches chassis top. Mirrors
        // Render3DEntities' head placement.
        out.push({
          shape: 'sphere',
          x: tox,
          y: bodyTopY + headR,
          z: toz,
          radius: headR,
          color: primary,
        });

        // Barrels — one cylinder per physical barrel. Diameter mirrors
        // Render3DEntities' barrel cylinder: for line shots (beam/laser)
        // the diameter is shot.width; otherwise barrelThickness. Falls
        // through to BARREL_MIN_THICKNESS only when neither is set.
        const bs = tb.barrel;
        if (!bs) continue;
        let shotWidth: number | undefined;
        if (tb.projectileId) {
          try {
            const sb = getShotBlueprint(tb.projectileId);
            if (sb.type === 'beam' || sb.type === 'laser') {
              shotWidth = sb.width;
            }
          } catch { /* unknown shot id — fall through to barrelThickness */ }
        }
        if (bs.type === 'simpleSingleBarrel') {
          const len = r * bs.barrelLength;
          if (len < 1) continue;
          const diameter = (shotWidth ?? bs.barrelThickness ?? BARREL_MIN_THICKNESS);
          const thick = Math.max(diameter, BARREL_MIN_THICKNESS) / 2;
          out.push({
            shape: 'cyl',
            ax: tox, ay: shotHeight, az: toz,
            bx: tox + len, by: shotHeight, bz: toz,
            thickness: thick,
            color: BARREL_COLOR,
          });
        } else if (bs.type === 'simpleMultiBarrel') {
          // Parallel cluster of cylinders — base orbit = tip orbit.
          const len = r * bs.barrelLength;
          if (len < 1) continue;
          const diameter = bs.barrelThickness ?? BARREL_MIN_THICKNESS;
          const thick = Math.max(diameter, BARREL_MIN_THICKNESS) / 2;
          const n = bs.barrelCount;
          const orbit = bs.orbitRadius * r;
          for (let i = 0; i < n; i++) {
            const a = ((i + 0.5) / n) * Math.PI * 2;
            const oy = Math.cos(a) * orbit;
            const oz = Math.sin(a) * orbit;
            out.push({
              shape: 'cyl',
              ax: tox,       ay: shotHeight + oy, az: toz + oz,
              bx: tox + len, by: shotHeight + oy, bz: toz + oz,
              thickness: thick,
              color: BARREL_COLOR,
            });
          }
        } else if (bs.type === 'coneMultiBarrel') {
          // Cone cluster — base sits at baseOrbit, tip splays out at
          // tipOrbit (or, when unset, derived from spread.angle exactly
          // the way Render3DEntities does it). Each barrel cylinder
          // therefore tilts outward.
          const len = r * bs.barrelLength;
          if (len < 1) continue;
          const diameter = bs.barrelThickness ?? BARREL_MIN_THICKNESS;
          const thick = Math.max(diameter, BARREL_MIN_THICKNESS) / 2;
          const n = bs.barrelCount;
          const baseOrbitR = bs.baseOrbit * r;
          const tipOrbitR = bs.tipOrbit !== undefined
            ? bs.tipOrbit * r
            : Math.min(
                baseOrbitR + len * Math.tan(((tb.spread?.angle ?? Math.PI / 5)) / 2),
                TURRET_HEIGHT * 0.9,
              );
          for (let i = 0; i < n; i++) {
            const a = ((i + 0.5) / n) * Math.PI * 2;
            const cosA = Math.cos(a);
            const sinA = Math.sin(a);
            out.push({
              shape: 'cyl',
              ax: tox,       ay: shotHeight + cosA * baseOrbitR, az: toz + sinA * baseOrbitR,
              bx: tox + len, by: shotHeight + cosA * tipOrbitR,  bz: toz + sinA * tipOrbitR,
              thickness: thick,
              color: BARREL_COLOR,
            });
          }
        }
      }

      // Mirror panels — emit one slab per panel matching what
      // Render3DEntities draws: a square plane (edge = vertical span)
      // centered at chassis-local (mount + panel.offset), running from
      // MIRROR_BASE_Y to bodyTop + 2·headR + MIRROR_EXTRA_HEIGHT, yawed
      // by -(panel.angle + π/2) to align the edge with the rendered
      // mesh. A small Z thickness is applied to the debris box ONLY
      // (the live mesh is a flat plane); shattering paper-thin slivers
      // would be invisible mid-tumble, so debris pieces get a token
      // 1-wu thickness for visibility.
      if (tb.mirrorPanels && tb.mirrorPanels.length > 0) {
        const panelTop = bodyTopY + 2 * headR + MIRROR_EXTRA_HEIGHT;
        const mirrorH = Math.max(panelTop - MIRROR_BASE_Y, 1);
        const panelCenterY = MIRROR_BASE_Y + mirrorH / 2;
        const side = mirrorH;
        for (const panel of tb.mirrorPanels) {
          out.push({
            shape: 'box',
            x: tox + panel.offsetX,
            y: panelCenterY,
            z: toz + panel.offsetY,
            yaw: -(panel.angle + Math.PI / 2),
            sx: side,
            sy: side,
            sz: 1,
            color: primary,
          });
        }
      }
    }

    // --- Chassis body edges ---
    // Read the per-renderer body shape (scout=diamond, tank=pentagon,
    // arachnid=two spheroids, etc.) and emit one tall slab per polygon
    // edge at the true edge position. Each template's `height` mirrors
    // the body segment it came from, so debris slab heights match the
    // live unit silhouette (composite bodies shed tall abdomen debris
    // and short head debris).
    const edges = getBodyEdgeTemplates(rendererId, r);
    for (const e of edges) {
      out.push({
        shape: 'box',
        x: e.x, y: e.height / 2, z: e.z,
        yaw: e.yaw,
        sx: e.length, sy: e.height, sz: e.thickness,
        color: primary,
      });
    }

    return out;
  }

  /** Fallback when the unit blueprint can't be resolved — a small handful
   *  of primary-colored slabs approximating a generic chassis. */
  private fallbackTemplates(r: number, primary: number): DebrisTemplate[] {
    const out: DebrisTemplate[] = [];
    const sides = 8;
    const poly = r * 0.7;
    const edgeLen = 2 * poly * Math.sin(Math.PI / sides);
    // Fallback chassis height: arachnid-ish big sphere top.
    const fallbackH = getBodyTopY('arachnid', r);
    for (let i = 0; i < sides; i++) {
      const a = ((i + 0.5) / sides) * Math.PI * 2;
      out.push({
        shape: 'box',
        x: Math.cos(a) * poly, y: fallbackH / 2, z: Math.sin(a) * poly,
        yaw: a + Math.PI / 2,
        sx: edgeLen, sy: fallbackH, sz: Math.max(2, r * 0.08),
        color: primary,
      });
    }
    return out;
  }

  private emitPiece(
    t: DebrisTemplate,
    unitX: number,
    unitZ: number,
    /** The unit's ground-footprint altitude (simZ − radius). Added to
     *  every piece's local y so airborne-kill debris spawns at
     *  altitude. 0 for a ground-resting unit. */
    groundLift: number,
    cosR: number,
    sinR: number,
    unitRot: number,
    biasX: number,
    biasZ: number,
    uvx: number,
    uvz: number,
  ): void {
    // --- Acquire the right mesh from the right pool ---
    const pool = t.shape === 'box' ? this.boxPool
      : t.shape === 'cyl' ? this.cylPool
      : this.spherePool;
    const geom = t.shape === 'box' ? this.boxGeom
      : t.shape === 'cyl' ? this.cylGeom
      : this.sphereGeom;
    let mesh: THREE.Mesh;
    let material: THREE.MeshLambertMaterial;
    const pooled = pool.pop();
    if (pooled) {
      mesh = pooled.mesh;
      material = pooled.material;
      material.color.setHex(t.color);
      material.opacity = 1;
      mesh.visible = true;
    } else {
      // Lambert (not Basic) so debris shades under the scene's ambient +
      // sun lighting the same way the live chassis/turret/tread meshes
      // do — matches the colors of the parts they were generated from.
      material = new THREE.MeshLambertMaterial({
        color: t.color,
        transparent: true,
        opacity: 1,
        depthWrite: false,
      });
      mesh = new THREE.Mesh(geom, material);
      mesh.renderOrder = 13;
      this.root.add(mesh);
    }

    // --- Position + orientation in world space ---
    // Unit-local (lx, ly, lz) → world = (unitX + rot(lx,lz), ly, unitZ + rot(lx,lz))
    let wcx: number, wcy: number, wcz: number;
    // Also compute the outward direction from the unit center (in world XZ)
    // so launch velocity points away from the center, not outward from the
    // piece's own origin.
    let localX = 0, localZ = 0;

    if (t.shape === 'box') {
      // Position: rotate local (x, z) by Ry(−unitRot) — same transform the
      // chassis group applies (its rotation.y is −transform.rotation).
      wcx = unitX + cosR * t.x - sinR * t.z;
      wcy = t.y + groundLift;
      wcz = unitZ + sinR * t.x + cosR * t.z;
      localX = t.x;
      localZ = t.z;
      mesh.scale.set(t.sx, t.sy, t.sz);
      mesh.position.set(wcx, wcy, wcz);
      mesh.quaternion.identity();
      // Yaw: group rotates by −unitRot around Y, children add their local
      // yaw on top, so world yaw = t.yaw − unitRot. A bit of random roll +
      // pitch gives each piece a unique tumble seed.
      mesh.rotation.set(
        (Math.random() - 0.5) * 0.4,
        t.yaw - unitRot,
        (Math.random() - 0.5) * 0.4,
      );
    } else if (t.shape === 'sphere') {
      // Sphere: rotation-symmetric, only position + uniform scale matter.
      // Add a random spin so each chunk tumbles uniquely.
      wcx = unitX + cosR * t.x - sinR * t.z;
      wcy = t.y + groundLift;
      wcz = unitZ + sinR * t.x + cosR * t.z;
      localX = t.x;
      localZ = t.z;
      mesh.scale.setScalar(t.radius);
      mesh.position.set(wcx, wcy, wcz);
      mesh.quaternion.identity();
      mesh.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI,
      );
    } else if (t.shape === 'cyl') {
      // Cylinder: transform both endpoints into world space, then place at
      // midpoint with length = |b-a| and axis aligned to (b-a). Same math as
      // Locomotion3D's setCylinderBetween.
      const awx = unitX + cosR * t.ax - sinR * t.az;
      const awy = t.ay + groundLift;
      const awz = unitZ + sinR * t.ax + cosR * t.az;
      const bwx = unitX + cosR * t.bx - sinR * t.bz;
      const bwy = t.by + groundLift;
      const bwz = unitZ + sinR * t.bx + cosR * t.bz;
      const dx = bwx - awx;
      const dy = bwy - awy;
      const dz = bwz - awz;
      const length = Math.max(1e-3, Math.hypot(dx, dy, dz));
      wcx = (awx + bwx) / 2;
      wcy = (awy + bwy) / 2;
      wcz = (awz + bwz) / 2;
      // Local outward direction from center of unit for velocity — use
      // midpoint of (ax,az)/(bx,bz).
      localX = (t.ax + t.bx) / 2;
      localZ = (t.az + t.bz) / 2;
      // Scale X/Z by thickness (radius), Y by length — the unit cylinder's
      // default axis is +Y so we then rotate it to the segment direction.
      mesh.scale.set(t.thickness, length, t.thickness);
      mesh.position.set(wcx, wcy, wcz);
      this._dir.set(dx / length, dy / length, dz / length);
      mesh.quaternion.setFromUnitVectors(this._up, this._dir);
    }

    // --- Launch velocity ---
    // Outward from the unit center in world XZ. For pieces at the center
    // (offset ≈ 0), pick a random direction so we don't get NaN.
    const localLen = Math.hypot(localX, localZ);
    let outX: number, outZ: number;
    if (localLen > 1e-3) {
      const lx = localX / localLen;
      const lz = localZ / localLen;
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

    // --- Initial spin ---
    // Scale angular velocity down for very big pieces (full tread slabs)
    // so they don't whip too fast. Clamped so tiny chunks still spin fast.
    const maxDim =
      t.shape === 'box'
        ? Math.max(t.sx, t.sy, t.sz)
        : t.shape === 'sphere'
          ? t.radius * 2
          : Math.max(t.thickness * 2, Math.hypot(t.bx - t.ax, t.by - t.ay, t.bz - t.az));
    const spinScale = Math.max(0.3, Math.min(1.2, 14 / Math.max(maxDim, 1)));

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
  }

  update(dtMs: number): void {
    const dtSec = dtMs / 1000;
    // Time-aware drag factors derived from the per-60Hz multipliers.
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

      // Ground bounce with heavy damping.
      if (p.mesh.position.y < 0.5) {
        p.mesh.position.y = 0.5;
        if (p.vy < 0) {
          p.vy = -p.vy * 0.25;
          p.vx *= 0.55;
          p.vz *= 0.55;
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

      // Color fade toward map background; opacity taper in the last 40%.
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
    // Geometry is shared by reference so we can identify pool by geom ptr.
    if (p.mesh.geometry === this.boxGeom) {
      this.boxPool.push({ mesh: p.mesh, material: p.material });
    } else if (p.mesh.geometry === this.sphereGeom) {
      this.spherePool.push({ mesh: p.mesh, material: p.material });
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
    for (const { mesh, material } of this.spherePool) {
      material.dispose();
      this.root.remove(mesh);
    }
    this.pieces.length = 0;
    this.boxPool.length = 0;
    this.cylPool.length = 0;
    this.spherePool.length = 0;
    this.boxGeom.dispose();
    this.cylGeom.dispose();
    this.sphereGeom.dispose();
    this.root.parent?.remove(this.root);
  }
}

// (Reverse-lookup helper removed: every part now emits the unit's
// primary color, matching Render3DEntities' unified-hue scheme.)
