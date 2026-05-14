// 3D physics engine — full rewrite of PhysicsEngine.ts with the third
// dimension as a first-class citizen, not an afterthought. No 2.5D
// tricks; the sim lives in genuine 3D and this engine owns the truth
// of where every body is and how it moves.
//
// Convention: (x, y) is the horizontal ground plane, z is altitude
// (positive = up). Gravity accelerates -z. The ground is an implicit
// infinite plane at z=0. That convention lets the 2D top-down client
// keep reading (x, y) untouched while the 3D client maps (sim.x,
// sim.z, sim.y) → Three.js (x, y, z). The third dimension costs the
// 2D renderer literally zero changes.
//
// Body shapes:
//   sphere — units. Radius + center. Rolls-free movement on the
//            horizontal plane. Gravity always pulls down; terrain
//            only pushes back when the unit's authored locomotion
//            ground point penetrates the terrain surface.
//   cuboid — buildings. Axis-aligned 3D box, always static for now
//            (rotating buildings aren't a thing in this game). Units
//            push off the cuboid's surface instead of clipping through.
//
// Collision dimension by pair type:
//   unit ↔ ground    — soft spring along the terrain normal, measured
//                      from the unit's locomotion ground point.
//   unit ↔ building  — full 3D (sphere vs cuboid) so tall buildings
//                      are blockers and short ones can be jumped over
//                      by units whose ground point is above terrain.
//   unit ↔ unit      — full 3D sphere-vs-sphere push. Two units at
//                      the same altitude behave exactly like 2D
//                      horizontal jostle; two at different altitudes
//                      separate along the combined 3D contact normal,
//                      so an elevated unit directly above a ground
//                      unit doesn't slam it sideways for no reason.
//   projectile hits  — full 3D; handled OUTSIDE this engine by
//                      DamageSystem / ProjectileCollisionHandler.
//
// The engine runs a standard explicit-Euler integrator at the
// simulation's fixed tick rate. Integration order per step:
//
//   1. Apply accumulated external forces + gravity → velocity
//   2. Terrain spring adds normal force when the locomotion ground
//      point is below terrain height
//   3. Air drag damps velocity equally on x/y/z
//   4. Ground friction damps velocity tangent to the terrain only
//      while the locomotion ground point is at/below terrain height
//   5. Integrate position from velocity
//   6. Resolve sphere-cuboid (unit-vs-building) contacts
//   7. Resolve sphere-sphere (unit-vs-unit) contacts, iterated
//   8. Clear per-step force accumulator
//
// Contact resolution is position-level (push bodies apart) + velocity
// reflection with restitution. No constraint solver, no sleeping —
// for an RTS with a few hundred units this is enough and keeps the
// code small enough to audit at a glance.

import { UNIT_MASS_MULTIPLIER, GRAVITY } from '../../config';
import { getUnitAirFrictionDamp } from '../sim/unitAirFriction';
import {
  getUnitGroundFrictionDamp,
  isUnitGroundPenetrationInContact,
  UNIT_GROUND_CONTACT_EPSILON,
} from '../sim/unitGroundPhysics';
import { advanceUnitMotionPhysicsMutable } from '../sim/unitMotionIntegration';
import {
  getSimWasm,
  STEP_UNIT_MOTIONS_BATCH_STRIDE,
} from '../sim-wasm/init';
import type { EntityId } from '../sim/types';

// Reusable Float64Array scratch for the batched WASM integrate
// kernel. Grown on demand; never shrunk so we don't churn
// allocations across ticks. Single module-scope buffer is safe
// because integrate() is never called re-entrantly within one
// JS turn (server ticks at 60 Hz on a setInterval — each tick
// is a separate microtask).
let _integrateBatchBuf: Float64Array = new Float64Array(0);
// Parallel array of the Body3D references at each slot in
// _integrateBatchBuf — used to read results back into the same
// body objects after the WASM call. Sized to match the buf.
let _integrateBatchBodies: Body3D[] = [];

// Pack a (cx, cy, cz) integer cell coordinate into a single numeric
// key. Each axis is 16-bit biased; the packed value is a 48-bit
// non-negative safe integer (well under JS's 2^53 ceiling). Mirrors
// the encoding the sim-side SpatialGrid uses so the two indices are
// readable side by side.
const CONTACT_CELL_BIAS = 32768;
const CONTACT_CELL_MASK = 0xFFFF;
const CONTACT_CX_MULT = 0x100000000;  // 2^32
const CONTACT_CY_MULT = 0x10000;      // 2^16
function packContactCellKey(cx: number, cy: number, cz: number): number {
  const cxB = (cx + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK;
  const cyB = (cy + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK;
  const czB = (cz + CONTACT_CELL_BIAS) & CONTACT_CELL_MASK;
  return cxB * CONTACT_CX_MULT + cyB * CONTACT_CY_MULT + czB;
}

/** A body participating in the 3D physics simulation. One shape type
 *  per body ('sphere' or 'cuboid'); spheres are always dynamic, cuboids
 *  are always static in the current scope. */
export type Body3D = {
  /** World position in sim units. (x,y)=ground plane, z=altitude. */
  x: number;
  y: number;
  z: number;
  /** Linear velocity. */
  vx: number;
  vy: number;
  vz: number;
  shape: 'sphere' | 'cuboid';
  /** Sphere radius (shape='sphere' only). 0 for cuboids. */
  radius: number;
  /** Authored body-center height above the locomotion ground point.
   *  The ground spring compares `z - groundOffset` against terrain
   *  height; `radius` remains the unit-vs-unit/building push volume. */
  groundOffset: number;
  /** Cuboid half-extents (shape='cuboid' only). */
  halfX: number;
  halfY: number;
  halfZ: number;
  mass: number;
  invMass: number;
  /** Bounciness on contact (0..1). 0 = inelastic, 1 = full bounce. */
  restitution: number;
  isStatic: boolean;
  /** Per-step accumulated acceleration. Cleared after each physics step. */
  ax: number;
  ay: number;
  az: number;
  /** Per-step acceleration from forces that are allowed to launch a
   *  penetrating ground point upward. Passive terrain contact does
   *  not set this; jump actuation does. */
  groundLaunchAx: number;
  groundLaunchAy: number;
  groundLaunchAz: number;
  /** True when the previous collision pass found this sphere resting
   *  against a non-terrain surface with an upward support normal.
   *  Force systems read this on the next tick to allow jumps from
   *  units/buildings without treating vertical walls as floors. */
  upwardSurfaceContact: boolean;
  /** Idle-body sleep state. Sleeping spheres skip integration and
   *  static/ground contact work until a force or collision wakes them. */
  sleeping: boolean;
  sleepTicks: number;
  /** Debug / log tag — entity type or id for tracing. */
  label: string;
  /** Owning sim entity id for dynamic unit bodies. */
  entityId?: EntityId;
  /** Internal broad-phase query stamp. Avoids duplicate narrow-phase
   *  checks when a large static cuboid spans several queried cells. */
  _staticQueryStamp?: number;
};

// Gravity is imported from src/config.ts as the single source of
// truth (see `export const GRAVITY`). Every falling thing — units
// under this engine, projectiles integrated in projectileSystem,
// debris in Debris3D, explosion sparks in Explosion3D, client
// dead-reckoning — uses the same value so visually consistent fall
// rates are free.

// Max velocity-correction iterations per step for overlapping spheres.
// Pile-ups beyond this cap will have some residual overlap but no
// explosive separation — acceptable for an RTS where units jostle.
const SPHERE_ITERATIONS = 4;
const SPHERE_ITERATIONS_MID_COUNT = 2500;
const SPHERE_ITERATIONS_HIGH_COUNT = 6000;

// Broad-phase cell size for sphere-sphere contact checks. Bodies are
// bucketed by CENTER (one cell each), then queried across enough
// neighboring cells to cover the largest active push-radius pair.
// Current large units have push radii around 65wu, so 160wu keeps the
// common query to the immediate 3x3x3 neighborhood while the dynamic
// range below still handles future oversized bodies correctly.
const CONTACT_CELL_SIZE = 160;
const SLEEP_SPEED_SQ = 0.25;
const SLEEP_ACCEL_SQ = 1e-6;
const SLEEP_TICKS = 12;
const SLEEP_GROUND_PENETRATION_EPS = 0.1;

export class PhysicsEngine3D {
  private bodies: Body3D[] = [];
  private dynamicBodies: Body3D[] = [];
  private staticBodies: Body3D[] = [];
  private awakeDynamicBodyCount = 0;
  private stepSyncEntityIds: EntityId[] = [];
  private stepSyncEntityIdSet = new Set<EntityId>();
  private mapWidth: number;
  private mapHeight: number;

  // Broad-phase scratch state: cellKey → array of indices into
  // `dynamicBodies`. Map and bucket arrays persist across calls and
  // are cleared on each broad-phase rebuild — avoids per-step Map
  // allocation churn.
  private contactCells = new Map<number, number[]>();
  private contactCellPool: number[][] = [];
  private contactNeighborRange = 1;

  // Static cuboid broad-phase: buildings do not move, so index them
  // once on creation into every CONTACT_CELL_SIZE cell overlapped by
  // their AABB. Unit-vs-building collision then only checks cells
  // touched by the unit sphere instead of every building in the game.
  private staticCells = new Map<number, Body3D[]>();
  private staticQueryStamp = 0;

  // Ignore a specific static body for a specific dynamic body. Same
  // purpose as the 2D engine: a newly spawned unit shouldn't immediately
  // collide with its own factory as it exits.
  private ignoreStatic: Map<Body3D, Body3D> = new Map();

  /** Callback that returns the ground elevation under any (x, y).
   *  Defaults to a flat z=0 plane; the simulator overrides it with
   *  `world.getGroundZ` so units settle on top of the local terrain
   *  cube tile (and projectiles striking the ground detonate at the
   *  correct elevation). Pure function — same input always yields
   *  the same output, so the client can run the same lookup. */
  private getGroundZ: (x: number, y: number) => number = () => 0;

  /** Surface normal at (x, y). Used by the ground spring and tangent
   *  friction so terrain response pushes out of the actual surface
   *  rather than world-up. Defaults to flat-up (0, 0, 1). */
  private getGroundNormal: (x: number, y: number) => { nx: number; ny: number; nz: number } = () => ({ nx: 0, ny: 0, nz: 1 });

  constructor(mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  /** Wire in the terrain heightmap so spring/friction contact uses
   *  the same triangle surface as rendering and client prediction. */
  setGroundLookup(
    getZ: (x: number, y: number) => number,
    getNormal: (x: number, y: number) => { nx: number; ny: number; nz: number },
  ): void {
    this.getGroundZ = getZ;
    this.getGroundNormal = getNormal;
  }

  /** Dynamic sphere body (units). By default spawns at (x, y) with the
   *  authored body-center height above terrain; callers that already
   *  have an entity transform can pass its z so visual and physics
   *  initialization stay identical. */
  createUnitBody(
    x: number,
    y: number,
    physicsRadius: number,
    bodyCenterHeight: number,
    mass: number,
    label: string,
    entityId?: EntityId,
    initialZ?: number,
  ): Body3D {
    const physicsMass = mass * UNIT_MASS_MULTIPLIER;
    const z = Number.isFinite(initialZ)
      ? initialZ!
      : this.getGroundZ(x, y) + bodyCenterHeight;
    const body: Body3D = {
      x,
      y,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      shape: 'sphere',
      radius: physicsRadius,
      groundOffset: bodyCenterHeight,
      halfX: 0,
      halfY: 0,
      halfZ: 0,
      mass: physicsMass,
      invMass: 1 / physicsMass,
      restitution: 0.2,
      isStatic: false,
      ax: 0,
      ay: 0,
      az: 0,
      groundLaunchAx: 0,
      groundLaunchAy: 0,
      groundLaunchAz: 0,
      upwardSurfaceContact: false,
      sleeping: false,
      sleepTicks: 0,
      label,
      entityId,
    };
    this.addBody(body);
    return body;
  }

  /** Static cuboid body (buildings). `width` and `height` are the
   *  building's 2D footprint on the ground plane; `depth` is the
   *  vertical extent (how tall the building stands). `baseZ` is the
   *  local terrain elevation under the footprint (cube tile top in
   *  the central ripple disc, 0 elsewhere). Center sits at
   *  (x, y, baseZ + depth/2) so the base rests on the local ground. */
  createBuildingBody(
    x: number,
    y: number,
    width: number,
    height: number,
    depth: number,
    baseZ: number,
    label: string,
  ): Body3D {
    const body: Body3D = {
      x,
      y,
      z: baseZ + depth / 2,
      vx: 0,
      vy: 0,
      vz: 0,
      shape: 'cuboid',
      radius: 0,
      groundOffset: 0,
      halfX: width / 2,
      halfY: height / 2,
      halfZ: depth / 2,
      mass: 0,
      invMass: 0,
      restitution: 0.1,
      isStatic: true,
      ax: 0,
      ay: 0,
      az: 0,
      groundLaunchAx: 0,
      groundLaunchAy: 0,
      groundLaunchAz: 0,
      upwardSurfaceContact: false,
      sleeping: false,
      sleepTicks: 0,
      label,
    };
    this.addBody(body);
    return body;
  }

  private addBody(body: Body3D): void {
    this.bodies.push(body);
    if (body.isStatic) {
      this.staticBodies.push(body);
      this.addStaticToBroadphase(body);
    } else {
      this.dynamicBodies.push(body);
      if (!body.sleeping) this.awakeDynamicBodyCount++;
    }
  }

  removeBody(body: Body3D): void {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
    const j = this.dynamicBodies.indexOf(body);
    if (j >= 0) {
      this.dynamicBodies.splice(j, 1);
      if (!body.sleeping) this.awakeDynamicBodyCount = Math.max(0, this.awakeDynamicBodyCount - 1);
    }
    const k = this.staticBodies.indexOf(body);
    if (k >= 0) {
      this.staticBodies.splice(k, 1);
      this.removeStaticFromBroadphase(body);
    }
    // Purge any ignore-pairs referencing this body.
    for (const [dyn, stat] of this.ignoreStatic) {
      if (dyn === body || stat === body) this.ignoreStatic.delete(dyn);
    }
  }

  /** Apply a 3D force to a dynamic body. Accumulates until the next
   *  step() call, then integrates as F/m → Δv. Forces marked
   *  `canLaunchFromGround` contributes its own outward velocity above
   *  the passive ground-rebound cap; terrain support and ordinary
   *  friction cannot. */
  applyForce(
    body: Body3D,
    fx: number,
    fy: number,
    fz: number,
    options?: { canLaunchFromGround?: boolean },
  ): void {
    if (body.isStatic) return;
    if ((fx * fx + fy * fy + fz * fz) > 0) {
      this.wakeBody(body);
    }
    const ax = fx * body.invMass;
    const ay = fy * body.invMass;
    const az = fz * body.invMass;
    body.ax += ax;
    body.ay += ay;
    body.az += az;
    if (options?.canLaunchFromGround) {
      body.groundLaunchAx += ax;
      body.groundLaunchAy += ay;
      body.groundLaunchAz += az;
    }
  }

  /** Apply an instantaneous velocity impulse to a dynamic body.
   *  The unified integrator decides ground response from the body's
   *  ground-point penetration on the next step. */
  launchBody(body: Body3D, dvx: number, dvy: number, dvz: number): void {
    if (body.isStatic) return;
    body.vx += dvx;
    body.vy += dvy;
    body.vz += dvz;
    this.wakeBody(body);
  }

  collectAwakeEntityIds(out: EntityId[]): void {
    if (this.awakeDynamicBodyCount <= 0) return;
    for (let i = 0; i < this.dynamicBodies.length; i++) {
      const body = this.dynamicBodies[i];
      if (body.sleeping || body.entityId === undefined) continue;
      out.push(body.entityId);
    }
  }

  hasUpwardSurfaceContact(body: Body3D): boolean {
    return body.upwardSurfaceContact === true;
  }

  collectLastStepEntityIds(out: EntityId[]): void {
    for (let i = 0; i < this.stepSyncEntityIds.length; i++) {
      out.push(this.stepSyncEntityIds[i]);
    }
  }

  /** Mark that `dynamicBody` should not collide with `staticBody`.
   *  Used for units spawning inside their factory. */
  setIgnoreStatic(dynamicBody: Body3D, staticBody: Body3D): void {
    this.ignoreStatic.set(dynamicBody, staticBody);
  }

  private wakeBody(body: Body3D): void {
    if (body.sleeping) {
      body.sleeping = false;
      this.awakeDynamicBodyCount++;
    }
    body.sleepTicks = 0;
  }

  private sleepBody(body: Body3D): void {
    if (!body.sleeping) {
      body.sleeping = true;
      this.awakeDynamicBodyCount = Math.max(0, this.awakeDynamicBodyCount - 1);
    }
    body.sleepTicks = SLEEP_TICKS;
    body.ax = 0;
    body.ay = 0;
    body.az = 0;
    body.groundLaunchAx = 0;
    body.groundLaunchAy = 0;
    body.groundLaunchAz = 0;
  }

  private addStepSyncEntity(body: Body3D): void {
    const id = body.entityId;
    if (id === undefined || this.stepSyncEntityIdSet.has(id)) return;
    this.stepSyncEntityIdSet.add(id);
    this.stepSyncEntityIds.push(id);
  }

  private isStepTouchedBody(body: Body3D): boolean {
    const id = body.entityId;
    return id !== undefined && this.stepSyncEntityIdSet.has(id);
  }

  private shouldProcessBodyThisStep(body: Body3D): boolean {
    return !body.sleeping || this.isStepTouchedBody(body);
  }

  private collectAwakeStepSyncEntities(): void {
    for (let i = 0; i < this.dynamicBodies.length; i++) {
      const body = this.dynamicBodies[i];
      if (body.sleeping) continue;
      this.addStepSyncEntity(body);
    }
  }

  private cellCoordXy(v: number): number {
    return Math.floor(v / CONTACT_CELL_SIZE);
  }

  private cellCoordZ(v: number): number {
    return Math.floor((v + CONTACT_CELL_SIZE / 2) / CONTACT_CELL_SIZE);
  }

  private addStaticToBroadphase(body: Body3D): void {
    if (body.shape !== 'cuboid') return;
    const minCx = this.cellCoordXy(body.x - body.halfX);
    const maxCx = this.cellCoordXy(body.x + body.halfX);
    const minCy = this.cellCoordXy(body.y - body.halfY);
    const maxCy = this.cellCoordXy(body.y + body.halfY);
    const minCz = this.cellCoordZ(body.z - body.halfZ);
    const maxCz = this.cellCoordZ(body.z + body.halfZ);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const key = packContactCellKey(cx, cy, cz);
          let bucket = this.staticCells.get(key);
          if (!bucket) {
            bucket = [];
            this.staticCells.set(key, bucket);
          }
          bucket.push(body);
        }
      }
    }
  }

  private removeStaticFromBroadphase(body: Body3D): void {
    if (body.shape !== 'cuboid') return;
    const minCx = this.cellCoordXy(body.x - body.halfX);
    const maxCx = this.cellCoordXy(body.x + body.halfX);
    const minCy = this.cellCoordXy(body.y - body.halfY);
    const maxCy = this.cellCoordXy(body.y + body.halfY);
    const minCz = this.cellCoordZ(body.z - body.halfZ);
    const maxCz = this.cellCoordZ(body.z + body.halfZ);

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          const key = packContactCellKey(cx, cy, cz);
          const bucket = this.staticCells.get(key);
          if (!bucket) continue;
          const i = bucket.indexOf(body);
          if (i >= 0) bucket.splice(i, 1);
          if (bucket.length === 0) this.staticCells.delete(key);
        }
      }
    }
  }

  step(dtSec: number): void {
    this.stepSyncEntityIds.length = 0;
    this.stepSyncEntityIdSet.clear();
    if (this.awakeDynamicBodyCount <= 0) return;
    this.collectAwakeStepSyncEntities();
    this.clearDynamicSurfaceContacts();
    this.integrate(dtSec);
    // Bodies touched this step still need final contact/clamp cleanup
    // even if integration just put the last awake body to sleep.
    this.resolveSphereCuboidContacts();
    this.rebuildContactCells();
    const sphereIterations = this.getSphereIterationBudget();
    for (let i = 0; i < sphereIterations; i++) {
      this.resolveSphereSphereContacts();
    }
    this.clampToMapBounds();
    this.collectAwakeStepSyncEntities();
    // Clear per-step force accumulator.
    for (const body of this.dynamicBodies) {
      body.ax = 0;
      body.ay = 0;
      body.az = 0;
      body.groundLaunchAx = 0;
      body.groundLaunchAy = 0;
      body.groundLaunchAz = 0;
    }
  }

  private getSphereIterationBudget(): number {
    const count = this.dynamicBodies.length;
    if (count >= SPHERE_ITERATIONS_HIGH_COUNT) return 1;
    if (count >= SPHERE_ITERATIONS_MID_COUNT) return 2;
    return SPHERE_ITERATIONS;
  }

  private clearDynamicSurfaceContacts(): void {
    for (let i = 0; i < this.dynamicBodies.length; i++) {
      this.dynamicBodies[i].upwardSurfaceContact = false;
    }
  }

  private recordUpwardSurfaceContact(body: Body3D, normalZ: number): void {
    if (normalZ > 0.35) body.upwardSurfaceContact = true;
  }

  /** Explicit-Euler integration with a soft terrain contact model.
   *  Every dynamic unit follows the same path:
   *
   *   1. Start with authored/external acceleration plus gravity.
   *   2. Compute the locomotion ground point: body center minus
   *      `groundOffset`.
   *   3. If that point is below terrain height, add a spring-damper
   *      acceleration along the terrain normal.
   *   4. Integrate velocity, apply isotropic air drag, then apply
   *      ground friction only to terrain-tangent velocity during
   *      contact.
   *   5. Integrate position.
   *
   *  There is no separate "airborne" branch and no ground snap in the
   *  normal path. "On ground" is just the shared ground-penetration
   *  contact predicate used by locomotion, jump actuation, suspension,
   *  and client prediction.
   *
   *  Phase 3a (Rust/WASM port): once `sim-wasm` has loaded, the whole
   *  per-tick body loop runs in ONE WASM call via
   *  `stepUnitMotionsBatch`. JS pre-samples ground state per body,
   *  packs into a Float64Array, calls into Rust once, reads results
   *  back. Eliminates the N per-body marshal cost that Phase 2 still
   *  paid (one call per body per tick). Bootstrap window before the
   *  WASM module resolves falls back to the per-body path below,
   *  which itself uses Phase 2's per-body WASM call when available
   *  and TS otherwise — every branch is numerically identical. */
  private integrate(dtSec: number): void {
    const airDamp = getUnitAirFrictionDamp(dtSec);
    const groundDamp = getUnitGroundFrictionDamp(dtSec);
    const sim = getSimWasm();
    if (sim !== undefined) {
      this.integrateBatchedWasm(dtSec, airDamp, groundDamp, sim);
      return;
    }
    this.integratePerBodyFallback(dtSec, airDamp, groundDamp);
  }

  /** Phase 3a batched WASM path. Sphere bodies get packed into the
   *  scratch buffer and integrated in one Rust call; non-sphere
   *  dynamic bodies (none exist today but the code path remains
   *  defensive) run free-Euler inline. Sleep transitions are
   *  signalled via the buffer's sleeping_flag slot and applied to
   *  the matching Body3D JS object after the call. */
  private integrateBatchedWasm(
    dtSec: number,
    airDamp: number,
    groundDamp: number,
    sim: NonNullable<ReturnType<typeof getSimWasm>>,
  ): void {
    const stride = STEP_UNIT_MOTIONS_BATCH_STRIDE;
    const maxCount = this.dynamicBodies.length;
    const requiredLen = maxCount * stride;
    if (_integrateBatchBuf.length < requiredLen) {
      _integrateBatchBuf = new Float64Array(requiredLen);
    }
    if (_integrateBatchBodies.length < maxCount) {
      _integrateBatchBodies = new Array(maxCount);
    }
    const buf = _integrateBatchBuf;
    let count = 0;
    for (let i = 0; i < this.dynamicBodies.length; i++) {
      const b = this.dynamicBodies[i];
      if (b.sleeping) continue;
      if (b.shape !== 'sphere') {
        // Free-Euler for non-sphere dynamics — matches the original
        // PhysicsEngine3D.ts non-sphere branch exactly.
        const ax = b.ax;
        const ay = b.ay;
        const az = b.az - GRAVITY;
        b.vx += ax * dtSec;
        b.vy += ay * dtSec;
        b.vz += az * dtSec;
        b.vx *= airDamp;
        b.vy *= airDamp;
        b.vz *= airDamp;
        b.x += b.vx * dtSec;
        b.y += b.vy * dtSec;
        b.z += b.vz * dtSec;
        continue;
      }
      // Pre-sample ground state JS-side. Normal sample is gated on
      // penetration so airborne bodies skip the expensive gradient
      // lookup (same optimization as Phase 2's per-body path).
      const groundZ = this.getGroundZ(b.x, b.y);
      const penetration = groundZ - (b.z - b.groundOffset);
      let nx = 0;
      let ny = 0;
      let nz = 1;
      if (penetration >= -UNIT_GROUND_CONTACT_EPSILON) {
        const n = this.getGroundNormal(b.x, b.y);
        nx = n.nx;
        ny = n.ny;
        nz = n.nz;
      }
      const base = count * stride;
      buf[base + 0] = b.x;
      buf[base + 1] = b.y;
      buf[base + 2] = b.z;
      buf[base + 3] = b.vx;
      buf[base + 4] = b.vy;
      buf[base + 5] = b.vz;
      buf[base + 6] = b.ax;
      buf[base + 7] = b.ay;
      buf[base + 8] = b.az;
      buf[base + 9] = b.groundLaunchAx;
      buf[base + 10] = b.groundLaunchAy;
      buf[base + 11] = b.groundLaunchAz;
      buf[base + 12] = b.groundOffset;
      buf[base + 13] = groundZ;
      buf[base + 14] = nx;
      buf[base + 15] = ny;
      buf[base + 16] = nz;
      buf[base + 17] = 0;
      buf[base + 18] = b.sleepTicks;
      _integrateBatchBodies[count] = b;
      count++;
    }
    if (count === 0) return;
    sim.stepUnitMotionsBatch(buf, count, dtSec, airDamp, groundDamp);
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const b = _integrateBatchBodies[i];
      b.x = buf[base + 0];
      b.y = buf[base + 1];
      b.z = buf[base + 2];
      b.vx = buf[base + 3];
      b.vy = buf[base + 4];
      b.vz = buf[base + 5];
      b.sleepTicks = buf[base + 18];
      if (buf[base + 17] === 1) {
        // Rust kernel snapped position + zeroed velocity in the
        // buffer; sleepBody() handles the awake-count decrement +
        // accumulator clear that the JS sleepBody() always did.
        this.sleepBody(b);
      }
      // Release the Body3D reference so it can be GC'd if the
      // body is removed before the next tick.
      _integrateBatchBodies[i] = undefined as unknown as Body3D;
    }
  }

  /** Bootstrap-window fallback. Used before initSimWasm() resolves
   *  (a handful of frames at startup) and during dev when a
   *  developer swaps WASM out for debugging. Kept bit-identical to
   *  the WASM batch path so motion never shifts across the swap. */
  private integratePerBodyFallback(
    dtSec: number,
    airDamp: number,
    groundDamp: number,
  ): void {
    for (const b of this.dynamicBodies) {
      if (b.sleeping) continue;
      const authoredAccelSq = b.ax * b.ax + b.ay * b.ay + b.az * b.az;
      const ax = b.ax;
      const ay = b.ay;
      const az = b.az - GRAVITY;

      if (b.shape !== 'sphere') {
        b.vx += ax * dtSec;
        b.vy += ay * dtSec;
        b.vz += az * dtSec;
        b.vx *= airDamp;
        b.vy *= airDamp;
        b.vz *= airDamp;
        b.x += b.vx * dtSec;
        b.y += b.vy * dtSec;
        b.z += b.vz * dtSec;
        continue;
      }

      advanceUnitMotionPhysicsMutable(
        b,
        dtSec,
        b.groundOffset,
        ax,
        ay,
        az,
        airDamp,
        groundDamp,
        b.groundLaunchAx,
        b.groundLaunchAy,
        b.groundLaunchAz,
        this.getGroundZ,
        this.getGroundNormal,
      );

      const speedSq = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
      if (
        authoredAccelSq <= SLEEP_ACCEL_SQ &&
        speedSq <= SLEEP_SPEED_SQ
      ) {
        const nextGroundZ = this.getGroundZ(b.x, b.y);
        const nextPenetration = nextGroundZ - (b.z - b.groundOffset);
        if (
          isUnitGroundPenetrationInContact(nextPenetration) &&
          nextPenetration <= SLEEP_GROUND_PENETRATION_EPS
        ) {
          b.sleepTicks++;
          if (b.sleepTicks >= SLEEP_TICKS) {
            b.z = nextGroundZ + b.groundOffset;
            b.vx = 0;
            b.vy = 0;
            b.vz = 0;
            this.sleepBody(b);
          }
        } else {
          b.sleepTicks = 0;
        }
      } else {
        b.sleepTicks = 0;
      }
    }
  }

  /** Sphere-vs-cuboid contact: find the closest point on the cuboid
   *  to the sphere center, push apart if overlapping, reflect velocity
   *  along the contact normal. Static cuboid doesn't move. */
  private resolveSphereCuboidContacts(): void {
    for (const dyn of this.dynamicBodies) {
      if (!this.shouldProcessBodyThisStep(dyn)) continue;
      if (dyn.shape !== 'sphere') continue;
      const stamp = ++this.staticQueryStamp;
      const ignored = this.ignoreStatic.get(dyn);
      const minCx = this.cellCoordXy(dyn.x - dyn.radius);
      const maxCx = this.cellCoordXy(dyn.x + dyn.radius);
      const minCy = this.cellCoordXy(dyn.y - dyn.radius);
      const maxCy = this.cellCoordXy(dyn.y + dyn.radius);
      const minCz = this.cellCoordZ(dyn.z - dyn.radius);
      const maxCz = this.cellCoordZ(dyn.z + dyn.radius);

      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          for (let cx = minCx; cx <= maxCx; cx++) {
            const bucket = this.staticCells.get(packContactCellKey(cx, cy, cz));
            if (!bucket) continue;
            for (let bi = 0; bi < bucket.length; bi++) {
              const st = bucket[bi];
              if (st._staticQueryStamp === stamp) continue;
              st._staticQueryStamp = stamp;
              if (st === ignored) continue;
              this.resolveSphereCuboidPair(dyn, st);
            }
          }
        }
      }
    }
  }

  private resolveSphereCuboidPair(dyn: Body3D, st: Body3D): void {
    // Closest point on AABB (aligned cuboid) to sphere center.
    const dx = dyn.x - st.x;
    const dy = dyn.y - st.y;
    const dz = dyn.z - st.z;
    const cx = Math.max(-st.halfX, Math.min(dx, st.halfX));
    const cy = Math.max(-st.halfY, Math.min(dy, st.halfY));
    const cz = Math.max(-st.halfZ, Math.min(dz, st.halfZ));
    const sepX = dx - cx;
    const sepY = dy - cy;
    const sepZ = dz - cz;
    const distSq = sepX * sepX + sepY * sepY + sepZ * sepZ;
    if (distSq >= dyn.radius * dyn.radius) return;
    const dist = Math.sqrt(distSq);
    // Degenerate case: sphere center inside the box. Push out along
    // the shortest face normal.
    let nx: number;
    let ny: number;
    let nz: number;
    let penetration: number;
    if (dist < 1e-6) {
      const overX = st.halfX - Math.abs(dx);
      const overY = st.halfY - Math.abs(dy);
      const overZ = st.halfZ - Math.abs(dz);
      if (overX <= overY && overX <= overZ) {
        nx = Math.sign(dx) || 1;
        ny = 0;
        nz = 0;
        penetration = overX + dyn.radius;
      } else if (overY <= overZ) {
        nx = 0;
        ny = Math.sign(dy) || 1;
        nz = 0;
        penetration = overY + dyn.radius;
      } else {
        nx = 0;
        ny = 0;
        nz = Math.sign(dz) || 1;
        penetration = overZ + dyn.radius;
      }
    } else {
      nx = sepX / dist;
      ny = sepY / dist;
      nz = sepZ / dist;
      penetration = dyn.radius - dist;
    }
    dyn.x += nx * penetration;
    dyn.y += ny * penetration;
    dyn.z += nz * penetration;
    if (dyn.sleeping) this.wakeBody(dyn);
    this.recordUpwardSurfaceContact(dyn, nz);
    // Velocity reflection along the contact normal if moving into it.
    const vDotN = dyn.vx * nx + dyn.vy * ny + dyn.vz * nz;
    if (vDotN < 0) {
      const j = (1 + dyn.restitution) * vDotN;
      dyn.vx -= j * nx;
      dyn.vy -= j * ny;
      dyn.vz -= j * nz;
    }
  }

  /** Bucket every dynamic sphere into a single broad-phase cube keyed
   *  by its center. Reused across the SPHERE_ITERATIONS sub-steps via
   *  a single rebuild per call to resolveSphereSphereContacts; small
   *  positional drift from the iterations is well below CONTACT_CELL_SIZE
   *  so the buckets stay valid for all 4 sub-passes.
   *
   *  Cell key matches the sim-side SpatialGrid encoding: 16-bit cx +
   *  16-bit cy + 16-bit cz packed into a 48-bit safe integer via
   *  multiplication. The Z axis is biased by half a cell so z=0 sits
   *  at the CENTER of the bottom cube — ground units cluster
   *  predictably instead of straddling a cube edge. */
  private rebuildContactCells(): void {
    // Recycle existing bucket arrays to avoid per-step allocations.
    for (const bucket of this.contactCells.values()) {
      bucket.length = 0;
      this.contactCellPool.push(bucket);
    }
    this.contactCells.clear();
    const cs = CONTACT_CELL_SIZE;
    const halfCs = cs / 2;
    let maxRadius = 0;
    for (let i = 0; i < this.dynamicBodies.length; i++) {
      const a = this.dynamicBodies[i];
      if (a.shape !== 'sphere') continue;
      if (a.radius > maxRadius) maxRadius = a.radius;
      const cx = Math.floor(a.x / cs);
      const cy = Math.floor(a.y / cs);
      const cz = Math.floor((a.z + halfCs) / cs);
      const key = packContactCellKey(cx, cy, cz);
      let bucket = this.contactCells.get(key);
      if (!bucket) {
        bucket = this.contactCellPool.pop() ?? [];
        this.contactCells.set(key, bucket);
      }
      bucket.push(i);
    }
    this.contactNeighborRange = Math.max(1, Math.ceil((maxRadius * 2) / cs));
  }

  /** Sphere-sphere push: full 3D. Two units at the same altitude push
   *  each other horizontally exactly as the old 2D path did — because
   *  dz is zero, the contact normal lies entirely in the XY plane —
   *  but an elevated unit hovering directly above a ground unit now
   *  separates along +z / −z instead of the old behavior where their
   *  sphere overlap resolved through the horizontal axis and randomly
   *  shoved them sideways. Iterated SPHERE_ITERATIONS times per step
   *  so crowded pile-ups settle reasonably.
   *
   *  Pair generation: a spatial-hash broad-phase keyed by sphere
   *  center. Each body lives in its primary cell; pair tests run
   *  across the neighbor range required by the largest active push
   *  radius. Pairs are de-duplicated by index ordering (j > i), so the
   *  work stays near O(N) for the normal radius mix instead of the
   *  O(N²) every-pair scan we had before.
   *
   *  Projectile/laser vs unit collisions are ALSO 3D but handled
   *  outside this engine — see ProjectileCollisionHandler + DamageSystem. */
  private resolveSphereSphereContacts(): void {
    const cs = CONTACT_CELL_SIZE;
    const halfCs = cs / 2;
    const bodies = this.dynamicBodies;
    const range = this.contactNeighborRange;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (a.shape !== 'sphere') continue;
      // Sleeping bodies must STILL iterate the broad phase here even
      // though they don't integrate motion. Pair dedup uses j > i; if
      // a sleeping body at low index sat out, an awake neighbor at
      // higher index would test j > iAwake (no candidates) and the
      // sleeping body's outer pass would have been skipped — so the
      // pair would never test. Result: a daddy that spawns into the
      // exact slot of a sleeping daddy never separates, and once both
      // sleep with overlap, step()'s early-return locks the state
      // forever. Letting sleeping bodies iterate is cheap (one extra
      // 3×3×3 cell walk per sleeping body, only when something else
      // was active at the start of this step) and the contact path
      // itself wakes both via wakeBody() so the resolve still does
      // real work.
      const acx = Math.floor(a.x / cs);
      const acy = Math.floor(a.y / cs);
      const acz = Math.floor((a.z + halfCs) / cs);
      // Usually a 3x3x3 neighborhood. The range expands when any
      // active unit's push radius is large enough that two overlapping
      // centers can sit more than one cell apart.
      for (let dz = -range; dz <= range; dz++) {
        for (let dy = -range; dy <= range; dy++) {
          for (let dx = -range; dx <= range; dx++) {
            const key = packContactCellKey(acx + dx, acy + dy, acz + dz);
            const bucket = this.contactCells.get(key);
            if (!bucket) continue;
            for (let bi = 0; bi < bucket.length; bi++) {
              const j = bucket[bi];
              // Resolve each pair once: only when b's index is strictly
              // greater than a's. Bodies sharing multiple buckets (none
              // do here since we bucket by center) would otherwise be
              // counted multiple times.
              if (j <= i) continue;
              const b = bodies[j];
              // (b.shape === 'sphere' is implied — only spheres are bucketed.)
              const ddx = b.x - a.x;
              const ddy = b.y - a.y;
              const ddz = b.z - a.z;
              const rSum = a.radius + b.radius;
              const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
              if (distSq >= rSum * rSum) continue;
              this.wakeBody(a);
              this.wakeBody(b);
              let dist: number;
              let nx: number;
              let ny: number;
              let nz: number;
              if (distSq < 1e-12) {
                const seed = ((((a.entityId ?? i) * 73856093) ^ ((b.entityId ?? j) * 19349663)) >>> 0);
                const angle = (seed / 0x100000000) * Math.PI * 2;
                dist = 1e-6;
                nx = Math.cos(angle);
                ny = Math.sin(angle);
                nz = 0;
              } else {
                dist = Math.sqrt(distSq);
                const invDist = 1 / dist;
                nx = ddx * invDist;
                ny = ddy * invDist;
                nz = ddz * invDist;
              }
              const penetration = rSum - dist;
              // Same denominator (a.invMass + b.invMass) was being divided
              // into 3 times below — fold to one inverse and multiply.
              const invMassSum = 1 / (a.invMass + b.invMass);
              const wA = a.invMass * invMassSum;
              const wB = b.invMass * invMassSum;
              a.x -= nx * penetration * wA;
              a.y -= ny * penetration * wA;
              a.z -= nz * penetration * wA;
              b.x += nx * penetration * wB;
              b.y += ny * penetration * wB;
              b.z += nz * penetration * wB;
              if (nz > 0.35) {
                this.recordUpwardSurfaceContact(b, nz);
              } else if (nz < -0.35) {
                this.recordUpwardSurfaceContact(a, -nz);
              }
              // Relative velocity along the 3D contact normal.
              const rvx = b.vx - a.vx;
              const rvy = b.vy - a.vy;
              const rvz = b.vz - a.vz;
              const vDotN = rvx * nx + rvy * ny + rvz * nz;
              if (vDotN >= 0) continue;
              const e = Math.min(a.restitution, b.restitution);
              const jMag = -(1 + e) * vDotN * invMassSum;
              const ix = jMag * nx;
              const iy = jMag * ny;
              const iz = jMag * nz;
              a.vx -= ix * a.invMass;
              a.vy -= iy * a.invMass;
              a.vz -= iz * a.invMass;
              b.vx += ix * b.invMass;
              b.vy += iy * b.invMass;
              b.vz += iz * b.invMass;
            }
          }
        }
      }
    }
  }

  /** Hard-clamp horizontal position to the map AABB so units can't
   *  fly off the world. Vertical bounds are bounded below by the
   *  ground plane and above implicitly by gravity. */
  private clampToMapBounds(): void {
    for (const b of this.dynamicBodies) {
      if (!this.shouldProcessBodyThisStep(b)) continue;
      if (b.shape !== 'sphere') continue;
      if (b.x < b.radius) { b.x = b.radius; if (b.vx < 0) b.vx = 0; }
      else if (b.x > this.mapWidth - b.radius) {
        b.x = this.mapWidth - b.radius;
        if (b.vx > 0) b.vx = 0;
      }
      if (b.y < b.radius) { b.y = b.radius; if (b.vy < 0) b.vy = 0; }
      else if (b.y > this.mapHeight - b.radius) {
        b.y = this.mapHeight - b.radius;
        if (b.vy > 0) b.vy = 0;
      }
    }
  }
}
