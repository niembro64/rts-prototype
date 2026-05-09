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
// Material-explosion LOD is controlled by three explicit PLAYER CLIENT
// config fields:
//   materialExplosionStyle             => visual richness / source thinning
//   materialExplosionPieceBudget       => max pieces emitted per unit death
//   materialExplosionPhysicsFramesSkip => debris physics update cadence
//
// Even at low budgets we keep a representative spread from the template list
// rather than truncating the tail, so body, tread, leg, turret, and barrel
// sources all still get a chance to appear.

import * as THREE from 'three';
import type { GraphicsConfig } from '@/types/graphics';
import type { SimDeathContext } from '@/types/combat';
import { getGraphicsConfig } from '@/clientBarConfig';
import { MAP_BG_COLOR, GRAVITY } from '../../config';
import { FALLBACK_UNIT_BODY_SHAPE } from '../sim/blueprints';
import { getMirrorPanelCenter } from '../sim/mirrorPanelCache';
import { SHINY_GRAY_METAL_MATERIAL } from './BuildingVisualPalette';
import { hexToRgb01 } from './colorUtils';
import { disposeMesh } from './threeUtils';
import { getBodyTopY } from '../math/BodyDimensions';
import {
  type DebrisColorRole,
  type DebrisStaticFragment,
  type DebrisTurretMount,
  getDebrisUnitProfile,
} from './UnitDebrisProfile3D';

type DebrisStyle = 'puff' | 'scatter' | 'shatter' | 'detonate' | 'obliterate';

/** Stride through the template list — every Nth piece is emitted. '1' means
 *  emit every piece, '2' every other, etc. All pieces are visually
 *  equivalent so a stride still yields a representative mix. */
const STYLE_STRIDE: Record<DebrisStyle, number> = {
  puff: 4,
  scatter: 3,
  shatter: 2,
  detonate: 1,
  obliterate: 1,
};

// Global cap on simultaneous pieces across the scene — generous since most
// units only produce ~30-60 pieces now. Old pieces are evicted oldest-first.
const GLOBAL_MAX_PIECES = 800;
const MAX_PIECES_EMITTED_PER_FRAME = 180;

// Scratch container for getMirrorPanelCenter — debris emission is the
// only per-piece consumer in this file, called inside a death pulse.
const _panelCenter = { x: 0, y: 0, z: 0 };

/** Rotate a barrel-local offset (dx, dy, dz) by chassis-relative yaw +
 *  pitch. Sim convention: +X forward, +Y left, +Z up. Yaw rotates
 *  around +Z, pitch lifts +X toward +Z. Returns the rotated offset
 *  in the chassis frame (still pre-body-yaw). */
function rotateBarrelOffset(
  dx: number, dy: number, dz: number,
  chassisYaw: number, pitch: number,
): { x: number; y: number; z: number } {
  const cP = Math.cos(pitch);
  const sP = Math.sin(pitch);
  // Pitch (lifts +X toward +Z, leaves +Y untouched).
  const px = dx * cP - dz * sP;
  const py = dy;
  const pz = dx * sP + dz * cP;
  const cY = Math.cos(chassisYaw);
  const sY = Math.sin(chassisYaw);
  // Yaw (rotation around +Z, sweeps +X toward +Y).
  return {
    x: px * cY - py * sY,
    y: px * sY + py * cY,
    z: pz,
  };
}

// Physics. Linear drag mirrors the 2D DebrisSystem (~0.99/frame at 60Hz).
// Angular drag is lower so spin decays noticeably faster than travel — the
// "start fast, slow to a stop" behavior the user asked for.
// Gravity is imported from config.ts — single value shared with everything
// that falls (physics engine, projectile arc, client prediction).
const LINEAR_DRAG = 0.985;
const ANGULAR_DRAG = 0.955;
const MAX_PHYSICS_STEP_MS = 80;

const BASE_LIFETIME_MS = 1700;
const LIFETIME_JITTER_MS = 800;
const GROUND_BOUNCE_CLEARANCE = 0.5;

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
const { r: BG_R, g: BG_G, b: BG_B } = hexToRgb01(MAP_BG_COLOR);

// Non-team colors for generic parts (tread gray, wheel gray, barrel white,
// leg gray). Close to the values used by Locomotion3D's shared materials.
const TREAD_COLOR = 0x1a1d22;
const WHEEL_COLOR = 0x2a2f36;
const LEG_COLOR = 0x2a2f36;
const BARREL_COLOR = 0xffffff;
const MIRROR_PANEL_DEBRIS_COLOR = SHINY_GRAY_METAL_MATERIAL.color;

// ── Lambert + per-instance alpha/color shader patch ─────────────
// We keep MeshLambertMaterial (so debris shades under scene ambient
// + sun lighting the same way live unit meshes do — matches the
// source-part colors), but onBeforeCompile-inject per-instance
// `aAlpha` / `aColor` attributes and override the shader's
// `diffuseColor` to use them. The same `vec4(vColor, vAlpha)`
// fragment contract the rest of the unified-particles family
// (SmokeTrail3D, Explosion3D, SprayRenderer3D) uses, but routed
// through the Lambert lighting stack instead of a flat shader.
function makeInstancedLambertMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff, // ignored — `vColor` overrides via the patch below
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        [
          'attribute float aAlpha;',
          'attribute vec3 aColor;',
          'varying float vAlpha;',
          'varying vec3 vColor;',
          '#include <common>',
        ].join('\n'),
      )
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'vAlpha = aAlpha;',
          'vColor = aColor;',
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          'varying float vAlpha;',
          'varying vec3 vColor;',
          '#include <common>',
        ].join('\n'),
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec4 diffuseColor = vec4( vColor, vAlpha );',
      );
  };
  return mat;
}

/** One InstancedMesh pool — holds either box, cylinder, or sphere
 *  debris pieces. Per-instance position/rotation/scale ride on
 *  instanceMatrix; per-instance alpha + color ride on aAlpha / aColor
 *  InstancedBufferAttributes read by the Lambert+patch material above.
 *  Slot allocation is stable per piece (allocated on emit, freed on
 *  death) — matches the chassis pool pattern, with `count = nextSlot`
 *  per frame to bound the GPU's draw work to the high-water mark. */
class InstancedDebrisPool {
  readonly geom: THREE.BufferGeometry;
  readonly mat: THREE.MeshLambertMaterial;
  readonly mesh: THREE.InstancedMesh;
  private alphaArr: Float32Array;
  private colorArr: Float32Array;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private colorAttr: THREE.InstancedBufferAttribute;
  freeSlots: number[] = [];
  nextSlot = 0;
  private dirtyMinSlot = Number.POSITIVE_INFINITY;
  private dirtyMaxSlot = -1;
  readonly cap: number;
  // Scratch — reused across the per-frame write loop, no allocations.
  private scratchMat = new THREE.Matrix4();
  private scratchPos = new THREE.Vector3();
  private scratchEuler = new THREE.Euler();
  private scratchQuat = new THREE.Quaternion();
  private scratchScale = new THREE.Vector3();
  private static readonly _ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(parent: THREE.Group, geom: THREE.BufferGeometry, cap: number) {
    this.geom = geom;
    this.cap = cap;
    this.alphaArr = new Float32Array(cap);
    this.colorArr = new Float32Array(cap * 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(this.alphaArr, 1);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colorArr, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aAlpha', this.alphaAttr);
    geom.setAttribute('aColor', this.colorAttr);
    this.mat = makeInstancedLambertMaterial();
    this.mesh = new THREE.InstancedMesh(geom, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    // Frustum culling on InstancedMesh uses the source geometry's
    // bounding sphere — instances live anywhere on the map, so
    // disable cull. Same caveat as the chassis + particle pools.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    parent.add(this.mesh);
  }

  alloc(): number | null {
    if (this.freeSlots.length > 0) return this.freeSlots.pop()!;
    if (this.nextSlot < this.cap) return this.nextSlot++;
    return null;
  }

  free(slot: number): void {
    if (slot < 0) return;
    this.mesh.setMatrixAt(slot, InstancedDebrisPool._ZERO_MATRIX);
    this.alphaArr[slot] = 0;
    this.freeSlots.push(slot);
    this.markDirty(slot);
  }

  private markDirty(slot: number): void {
    if (slot < this.dirtyMinSlot) this.dirtyMinSlot = slot;
    if (slot > this.dirtyMaxSlot) this.dirtyMaxSlot = slot;
  }

  /** Write a piece's full state to its slot — matrix from
   *  `T(pos) · R(EulerXYZ(rx,ry,rz)) · S(sx,sy,sz)`, plus the time-
   *  faded color + alpha. Called every frame the piece is alive. */
  write(
    slot: number,
    px: number, py: number, pz: number,
    rx: number, ry: number, rz: number,
    sx: number, sy: number, sz: number,
    r: number, g: number, b: number,
    alpha: number,
  ): void {
    this.scratchPos.set(px, py, pz);
    this.scratchEuler.set(rx, ry, rz, 'XYZ');
    this.scratchQuat.setFromEuler(this.scratchEuler);
    this.scratchScale.set(sx, sy, sz);
    this.scratchMat.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
    this.mesh.setMatrixAt(slot, this.scratchMat);
    this.alphaArr[slot] = alpha;
    this.colorArr[slot * 3]     = r;
    this.colorArr[slot * 3 + 1] = g;
    this.colorArr[slot * 3 + 2] = b;
    this.markDirty(slot);
  }

  flush(): void {
    this.mesh.count = this.nextSlot;
    if (this.dirtyMaxSlot >= this.dirtyMinSlot) {
      const start = this.dirtyMinSlot;
      const count = this.dirtyMaxSlot - this.dirtyMinSlot + 1;
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(start * 16, count * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alphaAttr.clearUpdateRanges();
      this.alphaAttr.addUpdateRange(start, count);
      this.alphaAttr.needsUpdate = true;
      this.colorAttr.clearUpdateRanges();
      this.colorAttr.addUpdateRange(start * 3, count * 3);
      this.colorAttr.needsUpdate = true;
      this.dirtyMinSlot = Number.POSITIVE_INFINITY;
      this.dirtyMaxSlot = -1;
    }
  }

  destroy(): void {
    disposeMesh(this.mesh);
  }
}

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

/** All piece state held as flat numbers. Per frame we step physics
 *  + Euler rotation + age, then write the slot's instance matrix +
 *  alpha + color. No Mesh / Material allocation per piece — the
 *  pool's shared InstancedMesh handles it. */
type Piece = {
  shape: 'box' | 'cyl' | 'sphere';
  /** Slot index in `boxPool` / `cylPool` / `spherePool` (depending on
   *  `shape`). Stable for the piece's lifetime — released on death. */
  slot: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  groundY: number;
  /** Rotation as Euler XYZ — initialized from the per-shape base
   *  orientation (cylinder alignment from setFromUnitVectors → Euler;
   *  boxes get a small random pitch/roll plus the template yaw;
   *  spheres get full random Euler). Per frame the angular velocity
   *  increments these; matrix compose converts back to Quaternion
   *  via setFromEuler. */
  rx: number; ry: number; rz: number;
  avx: number; avy: number; avz: number;
  /** Per-axis scale baked from the template at emit time (constant
   *  for the piece's lifetime). For box: (sx, sy, sz). For cylinder:
   *  (thickness, length, thickness). For sphere: (radius, radius,
   *  radius). */
  sx: number; sy: number; sz: number;
  age: number;
  lifetime: number;
  accumMs: number;
  frameStride: number;
  baseR: number; baseG: number; baseB: number;
};

export class Debris3D {
  private root: THREE.Group;
  private groundHeightAt: (worldX: number, worldZ: number) => number;
  // Three InstancedMesh pools — one per shape. Each holds up to
  // GLOBAL_MAX_PIECES so a worst-case all-of-one-shape spawn fits.
  private boxPool: InstancedDebrisPool;
  private cylPool: InstancedDebrisPool;
  private spherePool: InstancedDebrisPool;

  /** Active pieces in INSERTION ORDER — front of array is oldest.
   *  Global-cap eviction drops a front slice; per-frame death
   *  (age >= lifetime) splices from anywhere. */
  private pieces: Piece[] = [];
  private piecesEmittedThisFrame = 0;
  private physicsFrameIndex = 0;
  private poolFlushPending = false;

  // Scratch vectors reused per emit — avoids per-piece allocation.
  private _up = new THREE.Vector3(0, 1, 0);
  private _dir = new THREE.Vector3();
  /** Scratch Quaternion + Euler for cylinder alignment — convert the
   *  setFromUnitVectors quaternion to Euler XYZ to seed `rx, ry, rz`
   *  on emit, so subsequent angular-velocity updates accumulate from
   *  the correct base orientation. Same conversion mesh.rotation
   *  did implicitly in the per-Mesh path. */
  private _emitQuat = new THREE.Quaternion();
  private _emitEuler = new THREE.Euler();

  beginFrame(): void {
    this.piecesEmittedThisFrame = 0;
  }

  constructor(
    parentWorld: THREE.Group,
    groundHeightAt: (worldX: number, worldZ: number) => number = () => 0,
  ) {
    this.root = new THREE.Group();
    this.groundHeightAt = groundHeightAt;
    parentWorld.add(this.root);
    // Allocate pool buffers up front. Each pool's geometry is owned
    // by the pool and disposed in destroy().
    this.boxPool = new InstancedDebrisPool(
      this.root, new THREE.BoxGeometry(1, 1, 1), GLOBAL_MAX_PIECES,
    );
    this.cylPool = new InstancedDebrisPool(
      this.root, new THREE.CylinderGeometry(1, 1, 1, 10), GLOBAL_MAX_PIECES,
    );
    this.spherePool = new InstancedDebrisPool(
      this.root, new THREE.SphereGeometry(1, 10, 8), GLOBAL_MAX_PIECES,
    );
  }

  /** Pick the right pool for a piece's shape. */
  private poolFor(shape: 'box' | 'cyl' | 'sphere'): InstancedDebrisPool {
    return shape === 'box' ? this.boxPool
      : shape === 'cyl' ? this.cylPool
      : this.spherePool;
  }

  /** Spawn a full debris cluster for a dying unit at a full 3D sim pos.
   *  (simX, simY) is the horizontal footprint, simZ is the unit's sim
   *  center altitude at death. Debris templates are local to the
   *  rendered body/base, so the vertical origin must be the same base
   *  Y used by Render3DEntities: transform.z - pushRadius. New death
   *  contexts carry that as `baseZ`; older contexts fall back to the
   *  previous radius-derived estimate. */
  spawn(
    simX: number,
    simY: number,
    simZ: number,
    ctx: SimDeathContext,
    graphicsOverride?: GraphicsConfig,
  ): void {
    const gfx = graphicsOverride ?? getGraphicsConfig();
    const style = (gfx.materialExplosionStyle ?? gfx.deathExplosionStyle ?? 'scatter') as DebrisStyle;
    const stride = Math.max(1, STYLE_STRIDE[style] ?? 1);
    const pieceBudget = Math.max(0, Math.floor(gfx.materialExplosionPieceBudget ?? GLOBAL_MAX_PIECES));
    const physicsFrameStride =
      Math.max(0, Math.floor(gfx.materialExplosionPhysicsFramesSkip ?? 0)) + 1;
    if (pieceBudget <= 0) return;

    const r = Math.max(ctx.visualRadius ?? ctx.radius ?? 10, 6);
    const primary = ctx.color ?? 0xcccccc;
    const rotation = ctx.rotation ?? 0;
    // Vertical lift of the piece's local-y. Prefer the exact rendered
    // base altitude from the death context; fall back to push radius,
    // then visual radius, for older snapshots / synthesized events.
    const groundZ = ctx.baseZ ?? (simZ - (ctx.pushRadius ?? r));

    const templates = this.buildTemplates(ctx, r, primary);
    const candidateCount = Math.ceil(templates.length / stride);
    const remainingFrameBudget = Math.max(
      0,
      MAX_PIECES_EMITTED_PER_FRAME - this.piecesEmittedThisFrame,
    );
    const emitCount = Math.min(pieceBudget, candidateCount, remainingFrameBudget);
    if (emitCount <= 0) return;
    this.piecesEmittedThisFrame += emitCount;

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

    for (let emitIdx = 0; emitIdx < emitCount; emitIdx++) {
      const templateIdx = this.templateIndexForBudget(emitIdx, emitCount, candidateCount, stride);
      this.emitPiece(
        templates[templateIdx],
        simX,
        simY,
        groundZ,
        cosR,
        sinR,
        rotation,
        biasX,
        biasZ,
        uvx,
        uvz,
        physicsFrameStride,
      );
    }

    // Evict oldest pieces if we blew past the global cap. Batch the
    // array compaction so mass-death frames do not pay one O(n) shift
    // per dropped piece.
    const overflow = this.pieces.length - GLOBAL_MAX_PIECES;
    if (overflow > 0) {
      for (let i = 0; i < overflow; i++) {
        const dropped = this.pieces[i];
        if (dropped) {
          this.poolFor(dropped.shape).free(dropped.slot);
          this.poolFlushPending = true;
        }
      }
      this.pieces.splice(0, overflow);
    }
  }

  private templateIndexForBudget(
    emitIdx: number,
    emitCount: number,
    candidateCount: number,
    stride: number,
  ): number {
    if (emitCount >= candidateCount) return emitIdx * stride;
    const candidateIdx = Math.min(
      candidateCount - 1,
      Math.floor(((emitIdx + 0.5) * candidateCount) / emitCount),
    );
    return candidateIdx * stride;
  }

  /**
   * Build the full list of one-piece-per-atomic-part templates from the
   * unit's pre-derived debris profile + death context. The profile
   * (UnitDebrisProfile3D) owns all blueprint reading; this method only
   * applies the live death-event poses (body yaw, per-turret yaw +
   * pitch) and resolves color roles to concrete RGB values.
   */
  private buildTemplates(
    ctx: SimDeathContext,
    r: number,
    primary: number,
  ): DebrisTemplate[] {
    if (!ctx.unitType) return this.fallbackTemplates(r, primary);

    const profile = getDebrisUnitProfile(ctx.unitType, r);
    if (!profile) return this.fallbackTemplates(r, primary);

    const out: DebrisTemplate[] = [];
    const resolveColor = (role: DebrisColorRole): number => {
      switch (role) {
        case 'primary': return primary;
        case 'tread': return TREAD_COLOR;
        case 'wheel': return WHEEL_COLOR;
        case 'leg': return LEG_COLOR;
        case 'barrel': return BARREL_COLOR;
        case 'mirrorPanel': return MIRROR_PANEL_DEBRIS_COLOR;
      }
    };

    // --- Locomotion + body edges (pose-independent fragments) ---
    // Body yaw is applied at debris spawn time, so these go out as-is
    // in chassis-local coords.
    for (const f of profile.staticFragments) {
      this.emitStaticFragment(out, f, resolveColor(f.color));
    }

    // --- Turret heads + barrels + mirror panels ---
    // Each barrel / panel is in chassis-local coords assuming the
    // turret was aimed straight ahead. Apply the live (chassisYaw,
    // pitch) per turret so cylinders land at the world pose their
    // live mesh had. World yaw on the sim side is `t.rotation`;
    // chassis-local = world − body yaw. Sim convention: +X forward,
    // +Y left, +Z up.
    const bodyYaw = ctx.rotation ?? 0;
    for (let ti = 0; ti < profile.turretMounts.length; ti++) {
      const mount = profile.turretMounts[ti];
      if (!mount) continue;
      const pose = ctx.turretPoses?.[ti];
      const chassisYaw = pose ? pose.rotation - bodyYaw : 0;
      const pitch = pose ? pose.pitch : 0;
      this.emitTurretMount(out, mount, chassisYaw, pitch, primary);
    }

    return out;
  }

  /** Push one chassis-local fragment to the template list. */
  private emitStaticFragment(
    out: DebrisTemplate[],
    f: DebrisStaticFragment,
    color: number,
  ): void {
    if (f.kind === 'box') {
      out.push({
        shape: 'box',
        x: f.x, y: f.y, z: f.z,
        yaw: f.yaw,
        sx: f.sx, sy: f.sy, sz: f.sz,
        color,
      });
    } else {
      out.push({
        shape: 'cyl',
        ax: f.ax, ay: f.ay, az: f.az,
        bx: f.bx, by: f.by, bz: f.bz,
        thickness: f.thickness,
        color,
      });
    }
  }

  /** Emit one turret mount's debris pieces (head + barrels + mirror
   *  panels), rotated by the live chassis-relative yaw + pitch. */
  private emitTurretMount(
    out: DebrisTemplate[],
    mount: DebrisTurretMount,
    chassisYaw: number,
    pitch: number,
    primary: number,
  ): void {
    const tox = mount.mountX;
    const toz = mount.mountZ;
    const shotHeight = mount.shotHeight;

    if (!mount.isMirrorHost) {
      // Turret head — SPHERE centered at the mount. Pose-independent
      // (the sphere is rotationally symmetric).
      out.push({
        shape: 'sphere',
        x: tox,
        y: shotHeight,
        z: toz,
        radius: mount.headRadius,
        color: primary,
      });

      // Barrels — one cylinder per physical barrel. Each is built as a
      // chassis-aligned segment from (baseDx, baseDy, baseDz) to
      // (tipDx, tipDy, tipDz) in local-to-mount sim coords (dx along
      // default firing axis, dy lateral, dz vertical orbit). Rotated
      // by (chassisYaw, pitch) so the cylinder lands at the world
      // pose its live mesh had.
      const bp = mount.barrelProfile;
      if (bp) {
        const emitBarrel = (
          baseDx: number, baseDy: number, baseDz: number,
          tipDx: number, tipDy: number, tipDz: number,
          thick: number,
        ): void => {
          const a = rotateBarrelOffset(baseDx, baseDy, baseDz, chassisYaw, pitch);
          const b = rotateBarrelOffset(tipDx, tipDy, tipDz, chassisYaw, pitch);
          out.push({
            shape: 'cyl',
            ax: tox + a.x, ay: shotHeight + a.z, az: toz + a.y,
            bx: tox + b.x, by: shotHeight + b.z, bz: toz + b.y,
            thickness: thick,
            color: BARREL_COLOR,
          });
        };

        if (bp.type === 'simpleSingleBarrel') {
          emitBarrel(0, 0, 0, bp.length, 0, 0, bp.thickness);
        } else if (bp.type === 'simpleMultiBarrel') {
          // Parallel cluster of cylinders — base orbit = tip orbit.
          // `oy` is along three.js Y (vertical = sim Z), `oz` is along
          // three.js Z (lateral = sim Y). Map both accordingly so the
          // rotated debris cylinders trace the same orbit the live
          // render did.
          const n = bp.barrelCount;
          const orbit = bp.orbit;
          for (let i = 0; i < n; i++) {
            const a = ((i + 0.5) / n) * Math.PI * 2;
            const orbVert = Math.cos(a) * orbit; // sim Z
            const orbLat = Math.sin(a) * orbit;  // sim Y
            emitBarrel(
              0, orbLat, orbVert,
              bp.length, orbLat, orbVert,
              bp.thickness,
            );
          }
        } else if (bp.type === 'coneMultiBarrel') {
          // Cone cluster — base at baseOrbit, tip splays out at
          // tipOrbit. Each barrel cylinder therefore tilts outward.
          const n = bp.barrelCount;
          for (let i = 0; i < n; i++) {
            const a = ((i + 0.5) / n) * Math.PI * 2;
            const cosA = Math.cos(a);
            const sinA = Math.sin(a);
            emitBarrel(
              0, sinA * bp.baseOrbit, cosA * bp.baseOrbit,
              bp.length,
              sinA * bp.tipOrbit,
              cosA * bp.tipOrbit,
              bp.thickness,
            );
          }
        }
      }
    }

    // Mirror panels — emit one slab per panel + two broad extruded
    // arms + the cylindrical grabbers they attach to.
    const mp = mount.mirrorPanels;
    if (mp) {
      const armLength = mp.armLength;
      const panelCenterY = mp.panelCenterY;
      const cY = Math.cos(chassisYaw);
      const sY = Math.sin(chassisYaw);
      // Canonical arm-extension formula (mirror pitch is 0 here — debris
      // has no live mirror pose to read). Sim coords come back as
      // (sim x, sim y, sim z); three.js takes (sim x, sim z, sim y).
      getMirrorPanelCenter(0, 0, panelCenterY, armLength, chassisYaw, 0, _panelCenter);
      for (let pi = 0; pi < mp.panelCount; pi++) {
        // Panel — at arm's end, perpendicular to the arm.
        out.push({
          shape: 'box',
          x: _panelCenter.x,
          y: _panelCenter.z,
          z: _panelCenter.y,
          yaw: -Math.PI / 2 + chassisYaw,
          sx: mp.side,
          sy: mp.side,
          sz: 1,
          color: MIRROR_PANEL_DEBRIS_COLOR,
        });
        // Broad side arms + vertical grabbers — same dimensions as
        // MirrorMesh3D. Arms run from the turret pivot to each side
        // grabber's midpoint; grabbers remain cylindrical.
        for (const sign of [-1, 1] as const) {
          const localZ = mp.frameZ * sign;
          const railLength = Math.hypot(armLength, localZ);
          const cx = armLength / 2;
          const cz = localZ / 2;
          const grabberX = armLength * cY - localZ * sY;
          const grabberZ = armLength * sY + localZ * cY;
          out.push({
            shape: 'box',
            x: cx * cY - cz * sY,
            y: panelCenterY,
            z: cx * sY + cz * cY,
            yaw: chassisYaw + Math.atan2(localZ, armLength),
            sx: railLength,
            sy: mp.frameSegmentLength,
            sz: mp.supportDiameter,
            color: primary,
          });
          out.push({
            shape: 'cyl',
            ax: grabberX,
            ay: panelCenterY - mp.frameSegmentLength / 2,
            az: grabberZ,
            bx: grabberX,
            by: panelCenterY + mp.frameSegmentLength / 2,
            bz: grabberZ,
            thickness: mp.supportRadius,
            color: primary,
          });
        }
      }
    }
  }

  /** Fallback when the unit blueprint can't be resolved — a small handful
   *  of primary-colored slabs approximating a generic chassis. */
  private fallbackTemplates(r: number, primary: number): DebrisTemplate[] {
    const out: DebrisTemplate[] = [];
    const sides = 8;
    const poly = r * 0.7;
    const edgeLen = 2 * poly * Math.sin(Math.PI / sides);
    const fallbackH = getBodyTopY(FALLBACK_UNIT_BODY_SHAPE, r);
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
    physicsFrameStride: number,
  ): void {
    // --- Allocate slot in the right pool ---
    const pool = this.poolFor(t.shape);
    const slot = pool.alloc();
    if (slot === null) return; // pool full — drop this piece silently

    // --- Position + orientation, scale ---
    // Unit-local (lx, ly, lz) → world = (unitX + rot(lx,lz), ly + groundLift, unitZ + rot(lx,lz))
    // Also compute the outward direction from the unit center (in world XZ)
    // so launch velocity points away from the center, not outward from the
    // piece's own origin.
    let px = 0, py = 0, pz = 0;
    let rx = 0, ry = 0, rz = 0;
    let sx = 1, sy = 1, sz = 1;
    let localX = 0, localZ = 0;
    let maxDim = 1;

    if (t.shape === 'box') {
      // Position: rotate local (x, z) by Ry(−unitRot) — same transform the
      // chassis group applies (its rotation.y is −transform.rotation).
      px = unitX + cosR * t.x - sinR * t.z;
      py = t.y + groundLift;
      pz = unitZ + sinR * t.x + cosR * t.z;
      localX = t.x;
      localZ = t.z;
      sx = t.sx; sy = t.sy; sz = t.sz;
      // Yaw: group rotates by −unitRot around Y, children add their local
      // yaw on top, so world yaw = t.yaw − unitRot. A bit of random roll +
      // pitch gives each piece a unique tumble seed.
      rx = (Math.random() - 0.5) * 0.4;
      ry = t.yaw - unitRot;
      rz = (Math.random() - 0.5) * 0.4;
      maxDim = Math.max(t.sx, t.sy, t.sz);
    } else if (t.shape === 'sphere') {
      // Sphere: rotation-symmetric, only position + uniform scale matter.
      // Add a random spin so each chunk tumbles uniquely.
      px = unitX + cosR * t.x - sinR * t.z;
      py = t.y + groundLift;
      pz = unitZ + sinR * t.x + cosR * t.z;
      localX = t.x;
      localZ = t.z;
      sx = sy = sz = t.radius;
      rx = Math.random() * Math.PI;
      ry = Math.random() * Math.PI;
      rz = Math.random() * Math.PI;
      maxDim = t.radius * 2;
    } else { // 'cyl'
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
      px = (awx + bwx) / 2;
      py = (awy + bwy) / 2;
      pz = (awz + bwz) / 2;
      // Local outward direction from center of unit for velocity — use
      // midpoint of (ax,az)/(bx,bz).
      localX = (t.ax + t.bx) / 2;
      localZ = (t.az + t.bz) / 2;
      // Scale X/Z by thickness (radius), Y by length — the unit cylinder's
      // default axis is +Y so we then rotate it to the segment direction.
      sx = t.thickness; sy = length; sz = t.thickness;
      // Convert the alignment quaternion (setFromUnitVectors of +Y to
      // segment direction) to Euler XYZ so subsequent angular-velocity
      // updates accumulate from the correct base orientation. Same
      // sync the per-Mesh path did implicitly via mesh.rotation reads.
      this._dir.set(dx / length, dy / length, dz / length);
      this._emitQuat.setFromUnitVectors(this._up, this._dir);
      this._emitEuler.setFromQuaternion(this._emitQuat, 'XYZ');
      rx = this._emitEuler.x;
      ry = this._emitEuler.y;
      rz = this._emitEuler.z;
      maxDim = Math.max(t.thickness * 2, length);
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
    const spinScale = Math.max(0.3, Math.min(1.2, 14 / Math.max(maxDim, 1)));

    const { r: baseR, g: baseG, b: baseB } = hexToRgb01(t.color);
    const groundY = this.groundHeightAt(px, pz) + GROUND_BOUNCE_CLEARANCE;

    const piece: Piece = {
      shape: t.shape,
      slot,
      px, py, pz,
      vx, vy, vz,
      groundY,
      rx, ry, rz,
      avx: (Math.random() - 0.5) * ANGULAR_INIT * 2 * spinScale,
      avy: (Math.random() - 0.5) * ANGULAR_INIT * 2 * spinScale,
      avz: (Math.random() - 0.5) * ANGULAR_INIT * 2 * spinScale,
      sx, sy, sz,
      age: 0,
      lifetime: BASE_LIFETIME_MS + Math.random() * LIFETIME_JITTER_MS,
      accumMs: 0,
      frameStride: physicsFrameStride,
      baseR, baseG, baseB,
    };
    this.pieces.push(piece);
    // Write initial state to the slot so the piece is visible from
    // frame 0 (the per-frame update loop will keep it fresh).
    pool.write(slot, px, py, pz, rx, ry, rz, sx, sy, sz, baseR, baseG, baseB, 1);
    this.poolFlushPending = true;
  }

  update(dtMs: number): void {
    if (this.pieces.length === 0) {
      if (this.poolFlushPending) this.flushPools();
      return;
    }
    this.physicsFrameIndex = (this.physicsFrameIndex + 1) & 0x3fffffff;

    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.accumMs += dtMs;
      const frameStride = Math.max(1, p.frameStride | 0);
      if (frameStride > 1 && (this.physicsFrameIndex + p.slot) % frameStride !== 0) {
        continue;
      }

      let remainingMs = p.accumMs;
      p.accumMs = 0;

      while (remainingMs > 0 && p.age < p.lifetime) {
        const stepMs = Math.min(remainingMs, MAX_PHYSICS_STEP_MS);
        remainingMs -= stepMs;
        const dtSec = stepMs / 1000;
        // Time-aware drag factors derived from the per-60Hz multipliers.
        const linDrag = Math.pow(LINEAR_DRAG, dtSec * 60);
        const angDrag = Math.pow(ANGULAR_DRAG, dtSec * 60);
        p.age += stepMs;

        // Linear physics — gravity + drag + integrate position.
        p.vy -= GRAVITY * dtSec;
        p.vx *= linDrag;
        p.vy *= linDrag;
        p.vz *= linDrag;
        p.px += p.vx * dtSec;
        p.py += p.vy * dtSec;
        p.pz += p.vz * dtSec;

        // Ground bounce with heavy damping. The bounce floor follows
        // the rendered terrain under the piece rather than the world-
        // zero plane, so raised terrain does not snap debris down.
        if (p.py < p.groundY) {
          p.py = p.groundY;
          if (p.vy < 0) {
            p.vy = -p.vy * 0.25;
            p.vx *= 0.55;
            p.vz *= 0.55;
            p.avx *= 0.5;
            p.avy *= 0.5;
            p.avz *= 0.5;
          }
        }

        // Tumble — Euler XYZ accumulates angular velocity, drag decays.
        p.rx += p.avx * dtSec;
        p.ry += p.avy * dtSec;
        p.rz += p.avz * dtSec;
        p.avx *= angDrag;
        p.avy *= angDrag;
        p.avz *= angDrag;
      }

      const t = p.age / p.lifetime;
      if (t >= 1) {
        this.poolFor(p.shape).free(p.slot);
        this.poolFlushPending = true;
        this.pieces.splice(i, 1);
        continue;
      }

      // Color fade toward map background; opacity taper in the last 40%.
      const cLerp = Math.min(1, t * 1.4);
      const r = p.baseR + (BG_R - p.baseR) * cLerp;
      const g = p.baseG + (BG_G - p.baseG) * cLerp;
      const b = p.baseB + (BG_B - p.baseB) * cLerp;
      const alpha = t < 0.6 ? 1 : Math.max(0, (1 - t) / 0.4);

      this.poolFor(p.shape).write(
        p.slot,
        p.px, p.py, p.pz,
        p.rx, p.ry, p.rz,
        p.sx, p.sy, p.sz,
        r, g, b, alpha,
      );
      this.poolFlushPending = true;
    }

    // Flush all three pools — push instance buffer updates + tighten
    // count to nextSlot so the GPU only runs the vertex shader on
    // active slots.
    this.flushPools();
  }

  private flushPools(): void {
    this.boxPool.flush();
    this.cylPool.flush();
    this.spherePool.flush();
    this.poolFlushPending = false;
  }

  destroy(): void {
    this.pieces.length = 0;
    this.boxPool.destroy();
    this.cylPool.destroy();
    this.spherePool.destroy();
    this.root.parent?.remove(this.root);
  }
}

// (Reverse-lookup helper removed: every part now emits the unit's
// primary color, matching Render3DEntities' unified-hue scheme.)
