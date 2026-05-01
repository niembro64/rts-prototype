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
//            horizontal plane, constrained vertically by gravity and
//            the ground plane.
//   cuboid — buildings. Axis-aligned 3D box, always static for now
//            (rotating buildings aren't a thing in this game). Units
//            push off the cuboid's surface instead of clipping through.
//
// Collision dimension by pair type:
//   unit ↔ ground    — z axis only (sphere vs z=0 plane).
//   unit ↔ building  — full 3D (sphere vs cuboid) so tall buildings
//                      are blockers and short ones can be jumped over
//                      by airborne units.
//   unit ↔ unit      — full 3D sphere-vs-sphere push. Two units at
//                      the same altitude behave exactly like 2D
//                      horizontal jostle; two at different altitudes
//                      separate along the combined 3D contact normal,
//                      so an airborne unit directly above a ground
//                      unit doesn't slam it sideways for no reason.
//   projectile hits  — full 3D; handled OUTSIDE this engine by
//                      DamageSystem / ProjectileCollisionHandler.
//
// The engine runs a standard explicit-Euler integrator at the
// simulation's fixed tick rate. Integration order per step:
//
//   1. Apply accumulated external forces + gravity → velocity
//   2. Air friction (per-body `frictionAir`) damps velocity toward zero
//   3. Integrate position from velocity
//   4. Resolve sphere-plane (ground) contacts
//   5. Resolve sphere-cuboid (unit-vs-building) contacts
//   6. Resolve sphere-sphere (unit-vs-unit) contacts, iterated
//   7. Clear per-step force accumulator
//
// Contact resolution is position-level (push bodies apart) + velocity
// reflection with restitution. No constraint solver, no sleeping —
// for an RTS with a few hundred units this is enough and keeps the
// code small enough to audit at a glance.

import { UNIT_MASS_MULTIPLIER, GRAVITY } from '../../config';
import type { EntityId } from '../sim/types';

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
  /** Cuboid half-extents (shape='cuboid' only). */
  halfX: number;
  halfY: number;
  halfZ: number;
  mass: number;
  invMass: number;
  /** Per-body linear damping. 1.0 = halt instantly, 0 = never slow. */
  frictionAir: number;
  /** Bounciness on contact (0..1). 0 = inelastic, 1 = full bounce. */
  restitution: number;
  isStatic: boolean;
  /** Per-step accumulated acceleration. Cleared after each physics step. */
  ax: number;
  ay: number;
  az: number;
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

// Floor used by resolveGroundContacts as a safety net when something
// (sphere-sphere push, sphere-cuboid push, map clamp) leaves a unit
// below the surface — we snap up. Per-tick driving on slopes is
// handled inside `integrate` via a hard surface-stick model that
// keeps every grounded unit at z = surface every tick, so this
// resolver no longer needs a tolerance band; it's a backstop.
const GROUND_PENETRATION_EPS = 1e-3;

// Broad-phase cell size for sphere-sphere contact checks. Two bodies
// in the same cell or any of the 8 neighbors are pair-tested; pairs
// further apart can't overlap as long as `radiusA + radiusB ≤
// CONTACT_CELL_SIZE`. 100 wu comfortably covers the largest unit
// pairings (heaviest commanders ≈ 30 wu radius). Bodies bucket by
// CENTER (one cell each), and we de-dupe pairs by index ordering, so
// the pair count is O(units × neighbors) ≈ O(N) rather than O(N²).
const CONTACT_CELL_SIZE = 100;
const SLEEP_SPEED_SQ = 0.25;
const SLEEP_ACCEL_SQ = 1e-6;
const SLEEP_TICKS = 12;

export class PhysicsEngine3D {
  private bodies: Body3D[] = [];
  private dynamicBodies: Body3D[] = [];
  private staticBodies: Body3D[] = [];
  private awakeDynamicBodyCount = 0;
  private mapWidth: number;
  private mapHeight: number;

  // Broad-phase scratch state: cellKey → array of indices into
  // `dynamicBodies`. Map and bucket arrays persist across calls and
  // are cleared on each broad-phase rebuild — avoids per-step Map
  // allocation churn.
  private contactCells = new Map<number, number[]>();
  private contactCellPool: number[][] = [];

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

  /** Surface tangent normal at (x, y). Used by the ground-contact
   *  resolver to project a grounded body's velocity onto the slope
   *  tangent plane every tick — keeps units glued to the surface as
   *  they climb / descend instead of bobbing or launching off slope
   *  transitions. Defaults to flat-up (0, 0, 1) so unwired engines
   *  stay correct on flat ground. */
  private getGroundNormal: (x: number, y: number) => { nx: number; ny: number; nz: number } = () => ({ nx: 0, ny: 0, nz: 1 });

  constructor(mapWidth: number, mapHeight: number) {
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
  }

  /** Wire in the terrain heightmap so the ground contact resolver
   *  lifts units to the top face of their cube tile (and projects
   *  their velocity onto the slope tangent plane). Call once after
   *  constructing the engine. */
  setGroundLookup(
    getZ: (x: number, y: number) => number,
    getNormal: (x: number, y: number) => { nx: number; ny: number; nz: number },
  ): void {
    this.getGroundZ = getZ;
    this.getGroundNormal = getNormal;
  }

  /** Dynamic sphere body (units). Spawns at (x, y) on the ground,
   *  z starts at radius so it sits tangent to the ground plane. */
  createUnitBody(
    x: number,
    y: number,
    physicsRadius: number,
    mass: number,
    label: string,
    entityId?: EntityId,
  ): Body3D {
    const physicsMass = mass * UNIT_MASS_MULTIPLIER;
    const body: Body3D = {
      x,
      y,
      z: physicsRadius,
      vx: 0,
      vy: 0,
      vz: 0,
      shape: 'sphere',
      radius: physicsRadius,
      halfX: 0,
      halfY: 0,
      halfZ: 0,
      mass: physicsMass,
      invMass: 1 / physicsMass,
      frictionAir: 0.15,
      restitution: 0.2,
      isStatic: false,
      ax: 0,
      ay: 0,
      az: 0,
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
      halfX: width / 2,
      halfY: height / 2,
      halfZ: depth / 2,
      mass: 0,
      invMass: 0,
      frictionAir: 0,
      restitution: 0.1,
      isStatic: true,
      ax: 0,
      ay: 0,
      az: 0,
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
   *  step() call, then integrates as F/m → Δv. */
  applyForce(body: Body3D, fx: number, fy: number, fz: number): void {
    if (body.isStatic) return;
    if ((fx * fx + fy * fy + fz * fz) > 0) {
      this.wakeBody(body);
    }
    body.ax += fx * body.invMass;
    body.ay += fy * body.invMass;
    body.az += fz * body.invMass;
  }

  collectAwakeEntityIds(out: EntityId[]): void {
    if (this.awakeDynamicBodyCount <= 0) return;
    for (let i = 0; i < this.dynamicBodies.length; i++) {
      const body = this.dynamicBodies[i];
      if (body.sleeping || body.entityId === undefined) continue;
      out.push(body.entityId);
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
    if (this.awakeDynamicBodyCount <= 0) return;
    this.integrate(dtSec);
    if (this.awakeDynamicBodyCount <= 0) return;
    this.resolveGroundContacts();
    this.resolveSphereCuboidContacts();
    this.rebuildContactCells();
    const sphereIterations = this.getSphereIterationBudget();
    for (let i = 0; i < sphereIterations; i++) {
      this.resolveSphereSphereContacts();
    }
    this.clampToMapBounds();
    // Clear per-step force accumulator.
    for (const body of this.dynamicBodies) {
      body.ax = 0;
      body.ay = 0;
      body.az = 0;
    }
  }

  private getSphereIterationBudget(): number {
    const count = this.dynamicBodies.length;
    if (count >= SPHERE_ITERATIONS_HIGH_COUNT) return 1;
    if (count >= SPHERE_ITERATIONS_MID_COUNT) return 2;
    return SPHERE_ITERATIONS;
  }

  /** Explicit-Euler integration with HARD surface-stick for spheres.
   *
   *  Each unit is treated as a vehicle constrained to the ground —
   *  its position is always exactly on the surface and its velocity
   *  is always exactly tangent to it. There's no tolerance band and
   *  no airborne flag for ground units; the only failure mode is a
   *  near-vertical local surface (n.z → 0), which we guard against
   *  by zeroing vz instead of dividing.
   *
   *  Per sphere per tick:
   *   1. Project existing velocity onto the local tangent at the
   *      CURRENT position. Cleans up any drift that built up from
   *      the previous tick's tangent recompute landing on a
   *      slightly different slope angle.
   *   2. Project accel (gravity + thrust + external) onto the same
   *      tangent plane. Gravity's downhill component stays;
   *      perpendicular is absorbed by the implicit normal force.
   *      Same for thrust's slope-aligned component.
   *   3. Velocity += accel · dt.
   *   4. Damp the horizontal velocity components (ground drag).
   *   5. HORIZONTAL position update only: x += vx·dt, y += vy·dt.
   *      Don't touch z yet — the tangent is only valid at the OLD
   *      position, so straight-line tangent integration through z
   *      drifts off curved surfaces (this was the "flies off the
   *      crest of a hill" bug).
   *   6. Snap z to the new surface: z = ground(x_new, y_new) +
   *      radius. The unit ALWAYS sits on the ground, regardless of
   *      slope curvature or speed.
   *   7. Recompute vz from the slope-tangent constraint at the new
   *      position: v · n_new = 0 → vz = −(vx·n.x + vy·n.y) / n.z.
   *      Velocity is now tangent to the new surface, ready for the
   *      next tick's projection.
   *
   *  Steep slopes are stable: even a 70° slope (n.z ≈ 0.34, sin ≈
   *  0.94) just produces a vz roughly 2.8× the horizontal speed,
   *  which is then snapped to the surface and re-tangent-aligned
   *  on the next tick. Cresting a hill is stable too: step 6's
   *  snap absorbs the curvature drift.
   *
   *  Knockback / explosions: this strict-glue model can't launch a
   *  unit into the air via an instantaneous velocity or force
   *  impulse — the projection in step 1/2 kills any normal-direction
   *  component. That matches the RTS-where-everything-stays-on-the-
   *  ground design intent; when aircraft come online they'll need
   *  their own non-grounded integration pipeline. */
  /** Cached `Math.pow(1 - frictionAir, dtSec * 60)` keyed by frictionAir.
   *  Cleared and rekeyed each integrate() call by the current dtSec.
   *  In practice every dynamic body is a sphere with frictionAir = 0.15,
   *  so the inner loop hits this map exactly once per tick instead of
   *  paying ~50ns of Math.pow per body per tick. */
  private _dampCache = new Map<number, number>();
  private _dampCacheDtSec = 0;

  private getDampForFriction(frictionAir: number, dtSec: number): number {
    let damp = this._dampCache.get(frictionAir);
    if (damp === undefined) {
      damp = Math.pow(1 - frictionAir, dtSec * 60);
      this._dampCache.set(frictionAir, damp);
    }
    return damp;
  }

  private integrate(dtSec: number): void {
    if (dtSec !== this._dampCacheDtSec) {
      this._dampCache.clear();
      this._dampCacheDtSec = dtSec;
    }
    for (const b of this.dynamicBodies) {
      if (b.sleeping) continue;
      let ax = b.ax;
      let ay = b.ay;
      let az = b.az - GRAVITY;

      if (b.shape !== 'sphere') {
        // Static cuboids never get here (isStatic skips), but for
        // completeness any non-sphere dynamic body uses standard
        // 3D Euler. No surface stick.
        b.vx += ax * dtSec;
        b.vy += ay * dtSec;
        b.vz += az * dtSec;
        const damp = this.getDampForFriction(b.frictionAir, dtSec);
        b.vx *= damp;
        b.vy *= damp;
        b.x += b.vx * dtSec;
        b.y += b.vy * dtSec;
        b.z += b.vz * dtSec;
        continue;
      }

      // Sphere = unit. Hard ground stick.
      // (1) project velocity onto tangent at current position.
      const n0 = this.getGroundNormal(b.x, b.y);
      const vDotN0 = b.vx * n0.nx + b.vy * n0.ny + b.vz * n0.nz;
      b.vx -= vDotN0 * n0.nx;
      b.vy -= vDotN0 * n0.ny;
      b.vz -= vDotN0 * n0.nz;
      // (2) project accel onto tangent.
      const aDotN0 = ax * n0.nx + ay * n0.ny + az * n0.nz;
      ax -= aDotN0 * n0.nx;
      ay -= aDotN0 * n0.ny;
      az -= aDotN0 * n0.nz;
      // (3) velocity update.
      b.vx += ax * dtSec;
      b.vy += ay * dtSec;
      b.vz += az * dtSec;
      // (4) horizontal drag.
      const damp = this.getDampForFriction(b.frictionAir, dtSec);
      b.vx *= damp;
      b.vy *= damp;
      // (5) horizontal position update only — z is owned by step 6.
      b.x += b.vx * dtSec;
      b.y += b.vy * dtSec;
      // (6) snap z to surface at the new (x, y). This is the line
      //     that prevents flight on hill crests / steep climbs:
      //     curvature drift gets absorbed every tick instead of
      //     accumulating until the unit is "airborne" by tolerance.
      b.z = this.getGroundZ(b.x, b.y) + b.radius;
      // (7) recompute vz from the slope constraint at the new
      //     position so velocity is tangent to wherever we just
      //     landed. Near-vertical surfaces (n.z ≈ 0) would divide
      //     by zero; clamp vz to 0 there. Horizontal speed is
      //     preserved; vz becomes whatever the new slope demands.
      const n1 = this.getGroundNormal(b.x, b.y);
      if (Math.abs(n1.nz) > 1e-3) {
        b.vz = -(b.vx * n1.nx + b.vy * n1.ny) / n1.nz;
      } else {
        b.vz = 0;
      }

      const accelSq = b.ax * b.ax + b.ay * b.ay + b.az * b.az;
      const speedSq = b.vx * b.vx + b.vy * b.vy;
      if (accelSq <= SLEEP_ACCEL_SQ && speedSq <= SLEEP_SPEED_SQ) {
        b.sleepTicks++;
        if (b.sleepTicks >= SLEEP_TICKS) {
          b.vx = 0;
          b.vy = 0;
          b.vz = 0;
          this.sleepBody(b);
        }
      } else {
        b.sleepTicks = 0;
      }
    }
  }

  /** Ground-penetration backstop. The integrator already keeps
   *  every grounded sphere exactly on the surface (z = ground +
   *  radius) every tick, so this resolver is only here to catch
   *  cases where one of the LATER step phases pushes a unit below
   *  ground — sphere-sphere push, sphere-cuboid push, or the map-
   *  bounds clamp. If a unit ends up below the surface we lift it
   *  back up and zero out any inward-normal velocity component so
   *  the next integrate doesn't fight the surface. */
  private resolveGroundContacts(): void {
    for (const b of this.dynamicBodies) {
      if (b.sleeping) continue;
      if (b.shape !== 'sphere') continue;
      const groundZ = this.getGroundZ(b.x, b.y);
      const restingZ = groundZ + b.radius;
      if (b.z >= restingZ - GROUND_PENETRATION_EPS) continue;
      // Penetrated — lift up and re-tangent the velocity so it
      // doesn't keep pushing through the surface next tick.
      b.z = restingZ;
      const n = this.getGroundNormal(b.x, b.y);
      const vDotN = b.vx * n.nx + b.vy * n.ny + b.vz * n.nz;
      if (vDotN < 0) {
        b.vx -= vDotN * n.nx;
        b.vy -= vDotN * n.ny;
        b.vz -= vDotN * n.nz;
      }
    }
  }

  /** Sphere-vs-cuboid contact: find the closest point on the cuboid
   *  to the sphere center, push apart if overlapping, reflect velocity
   *  along the contact normal. Static cuboid doesn't move. */
  private resolveSphereCuboidContacts(): void {
    for (const dyn of this.dynamicBodies) {
      if (dyn.sleeping) continue;
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
    for (let i = 0; i < this.dynamicBodies.length; i++) {
      const a = this.dynamicBodies[i];
      if (a.shape !== 'sphere') continue;
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
  }

  /** Sphere-sphere push: full 3D. Two units at the same altitude push
   *  each other horizontally exactly as the old 2D path did — because
   *  dz is zero, the contact normal lies entirely in the XY plane —
   *  but an airborne unit hovering directly above a ground unit now
   *  separates along +z / −z instead of the old behavior where their
   *  sphere overlap resolved through the horizontal axis and randomly
   *  shoved them sideways. Iterated SPHERE_ITERATIONS times per step
   *  so crowded pile-ups settle reasonably.
   *
   *  Pair generation: a spatial-hash broad-phase keyed by sphere
   *  center. Each body lives in its primary cell; pair tests run only
   *  within that cell + the 8 neighbors. Pairs are de-duplicated by
   *  index ordering (j > i), so the work is O(N) instead of the
   *  O(N²) every-pair scan we had before — the difference shows up
   *  immediately at a few hundred units.
   *
   *  Projectile/laser vs unit collisions are ALSO 3D but handled
   *  outside this engine — see ProjectileCollisionHandler + DamageSystem. */
  private resolveSphereSphereContacts(): void {
    const cs = CONTACT_CELL_SIZE;
    const halfCs = cs / 2;
    const bodies = this.dynamicBodies;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (a.sleeping) continue;
      if (a.shape !== 'sphere') continue;
      const acx = Math.floor(a.x / cs);
      const acy = Math.floor(a.y / cs);
      const acz = Math.floor((a.z + halfCs) / cs);
      // 3×3×3 neighborhood (self + 26 neighbors). Two bodies that
      // overlap must have centers within rA + rB ≤ CONTACT_CELL_SIZE
      // of each other, so they share a cube or sit in an adjacent
      // cube along any axis (including +/- z for stacked airborne
      // units above ground units).
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
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
            const dist = Math.sqrt(distSq) || 1e-6;
            const invDist = 1 / dist;
            const nx = ddx * invDist;
            const ny = ddy * invDist;
            const nz = ddz * invDist;
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
      if (b.sleeping) continue;
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
