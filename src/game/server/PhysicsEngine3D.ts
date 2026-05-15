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
  UNIT_GROUND_CONTACT_EPSILON,
} from '../sim/unitGroundPhysics';
import {
  getSimWasm,
  BODY_FLAG_SLEEPING,
  BODY_FLAG_IS_STATIC,
  BODY_FLAG_UPWARD_CONTACT,
  BODY_FLAG_SHAPE_CUBOID,
  BODY_FLAG_OCCUPIED,
  type BodyPoolViews,
} from '../sim-wasm/init';
import type { EntityId } from '../sim/types';

// Phase 3d-2 scratch buffers. Body state lives in the WASM-side
// BodyPool, so per-tick marshalling shrinks to: a Uint32Array of
// active slot ids + per-body pre-sampled ground state (terrain
// stays JS-side until Phase 8) + a Uint32Array sized to the active
// count for sleep / wake transitions written out by the kernel.
// All grown on demand; never shrunk to avoid per-tick allocation
// churn. Single module-scope set is safe because step() is never
// called re-entrantly within one JS turn.
let _integrateAwakeSlots: Uint32Array = new Uint32Array(0);
let _integrateGroundZ: Float64Array = new Float64Array(0);
let _integrateGroundNormals: Float64Array = new Float64Array(0);
let _integrateSleepTransitions: Uint32Array = new Uint32Array(0);

let _sphereSphereSlots: Uint32Array = new Uint32Array(0);
let _sphereSphereWakeTransitions: Uint32Array = new Uint32Array(0);

// Phase 3f sphere-vs-cuboid scratch. The static broadphase itself
// lives in WASM (per-engine via engineStatics handle). JS only
// needs to marshal the per-tick dyn slot list, the parallel ignore-
// pair lookup, and the wake-transition output buffer.
let _sphereCuboidDynSlots: Uint32Array = new Uint32Array(0);
let _sphereCuboidIgnoredStatics: Uint32Array = new Uint32Array(0);
let _sphereCuboidWakeTransitions: Uint32Array = new Uint32Array(0);
// Sentinel "no ignore" value passed to the kernel (matches Rust
// u32::MAX). Real slot ids are 0..POOL_CAPACITY-1 so 0xFFFFFFFF
// can never collide with a real slot.
const NO_IGNORE_SLOT = 0xFFFFFFFF;

// Module-scope cached pool views — bound once when PhysicsEngine3D
// is first constructed (which awaits initSimWasm via GameServer.create).
// Body3D field accessors read/write these typed arrays directly; no
// per-call function dispatch on the hot path.
let _poolViews: BodyPoolViews | undefined;

function bindBody3DPool(views: BodyPoolViews): void {
  _poolViews = views;
}

function pv(): BodyPoolViews {
  if (_poolViews === undefined) {
    throw new Error(
      'Body3D pool not bound — initSimWasm() must resolve before any Body3D is constructed',
    );
  }
  return _poolViews;
}

/** A body participating in the 3D physics simulation. One shape type
 *  per body ('sphere' or 'cuboid'); spheres are always dynamic, cuboids
 *  are always static in the current scope.
 *
 *  Phase 3d: numeric body fields (position, velocity, acceleration,
 *  geometry, sleep state) live in the WASM-side BodyPool linear-memory
 *  arrays — see rts-sim-wasm/src/lib.rs `struct BodyPool`. The Body3D
 *  class is a thin handle: it stores its slot index plus a few cold
 *  JS-side fields (label, entityId, etc.) that don't benefit from
 *  living in WASM. Hot field access goes through the cached typed-
 *  array views in `pv()` — direct typed-array index reads, fully
 *  inline-cacheable in the JIT.
 *
 *  External callers should never `new Body3D(...)` directly — use
 *  PhysicsEngine3D.createUnitBody / .createBuildingBody. */
export class Body3D {
  readonly slot: number;
  readonly shape: 'sphere' | 'cuboid';
  /** Pre-multiplier mass × UNIT_MASS_MULTIPLIER for dynamic bodies;
   *  0 for static bodies. Kept JS-side because it's set once at
   *  construction and only read for diagnostics/serialization. */
  readonly mass: number;
  readonly isStatic: boolean;
  /** Debug / log tag — entity type or id for tracing. */
  label: string;
  /** Owning sim entity id for dynamic unit bodies. */
  entityId?: EntityId;

  private constructor(args: {
    slot: number;
    shape: 'sphere' | 'cuboid';
    mass: number;
    isStatic: boolean;
    label: string;
    entityId?: EntityId;
  }) {
    this.slot = args.slot;
    this.shape = args.shape;
    this.mass = args.mass;
    this.isStatic = args.isStatic;
    this.label = args.label;
    this.entityId = args.entityId;
  }

  /** Factory: allocates a pool slot, populates the numeric fields
   *  via pool views, and returns a Body3D handle. Used internally
   *  by PhysicsEngine3D — external callers should go through
   *  createUnitBody / createBuildingBody on the engine. */
  static allocate(args: {
    shape: 'sphere' | 'cuboid';
    isStatic: boolean;
    mass: number;
    label: string;
    entityId?: EntityId;
    x: number;
    y: number;
    z: number;
    radius?: number;
    halfX?: number;
    halfY?: number;
    halfZ?: number;
    groundOffset?: number;
    restitution: number;
  }): Body3D {
    const views = pv();
    const slot = views.allocSlot();
    const body = new Body3D({
      slot,
      shape: args.shape,
      mass: args.mass,
      isStatic: args.isStatic,
      label: args.label,
      entityId: args.entityId,
    });
    // pool_alloc_slot zeros all fields and sets BODY_FLAG_OCCUPIED;
    // we only need to write the non-zero defaults explicitly.
    views.posX[slot] = args.x;
    views.posY[slot] = args.y;
    views.posZ[slot] = args.z;
    views.radius[slot] = args.radius ?? 0;
    views.halfX[slot] = args.halfX ?? 0;
    views.halfY[slot] = args.halfY ?? 0;
    views.halfZ[slot] = args.halfZ ?? 0;
    views.invMass[slot] = args.mass > 0 ? 1 / args.mass : 0;
    views.restitution[slot] = args.restitution;
    views.groundOffset[slot] = args.groundOffset ?? 0;
    let flags = BODY_FLAG_OCCUPIED;
    if (args.isStatic) flags |= BODY_FLAG_IS_STATIC;
    if (args.shape === 'cuboid') flags |= BODY_FLAG_SHAPE_CUBOID;
    views.flags[slot] = flags;
    return body;
  }

  /** Release this body's pool slot. Called by PhysicsEngine3D.removeBody. */
  free(): void {
    pv().freeSlot(this.slot);
  }

  // ──── Pool-backed numeric field accessors ──────────────────────
  // Each is a single typed-array index op — JIT-inline-cacheable,
  // ~3-5 ns per access in V8 (versus ~2 ns for a direct field on
  // a plain object — the gap is dwarfed by the per-tick physics
  // work and is recouped by avoiding all per-tick marshalling).

  get x(): number { return pv().posX[this.slot]; }
  set x(v: number) { pv().posX[this.slot] = v; }
  get y(): number { return pv().posY[this.slot]; }
  set y(v: number) { pv().posY[this.slot] = v; }
  get z(): number { return pv().posZ[this.slot]; }
  set z(v: number) { pv().posZ[this.slot] = v; }
  get vx(): number { return pv().velX[this.slot]; }
  set vx(v: number) { pv().velX[this.slot] = v; }
  get vy(): number { return pv().velY[this.slot]; }
  set vy(v: number) { pv().velY[this.slot] = v; }
  get vz(): number { return pv().velZ[this.slot]; }
  set vz(v: number) { pv().velZ[this.slot] = v; }
  get ax(): number { return pv().accelX[this.slot]; }
  set ax(v: number) { pv().accelX[this.slot] = v; }
  get ay(): number { return pv().accelY[this.slot]; }
  set ay(v: number) { pv().accelY[this.slot] = v; }
  get az(): number { return pv().accelZ[this.slot]; }
  set az(v: number) { pv().accelZ[this.slot] = v; }
  get groundLaunchAx(): number { return pv().launchX[this.slot]; }
  set groundLaunchAx(v: number) { pv().launchX[this.slot] = v; }
  get groundLaunchAy(): number { return pv().launchY[this.slot]; }
  set groundLaunchAy(v: number) { pv().launchY[this.slot] = v; }
  get groundLaunchAz(): number { return pv().launchZ[this.slot]; }
  set groundLaunchAz(v: number) { pv().launchZ[this.slot] = v; }

  // Geometry — set at construction, read often, never written after.
  get radius(): number { return pv().radius[this.slot]; }
  get halfX(): number { return pv().halfX[this.slot]; }
  get halfY(): number { return pv().halfY[this.slot]; }
  get halfZ(): number { return pv().halfZ[this.slot]; }
  get invMass(): number { return pv().invMass[this.slot]; }
  get restitution(): number { return pv().restitution[this.slot]; }
  get groundOffset(): number { return pv().groundOffset[this.slot]; }

  get sleepTicks(): number { return pv().sleepTicks[this.slot]; }
  set sleepTicks(v: number) { pv().sleepTicks[this.slot] = v; }

  // Boolean flags packed into the flags byte.
  get sleeping(): boolean {
    return (pv().flags[this.slot] & BODY_FLAG_SLEEPING) !== 0;
  }
  set sleeping(v: boolean) {
    const f = pv().flags;
    if (v) f[this.slot] |= BODY_FLAG_SLEEPING;
    else f[this.slot] &= ~BODY_FLAG_SLEEPING;
  }
  get upwardSurfaceContact(): boolean {
    return (pv().flags[this.slot] & BODY_FLAG_UPWARD_CONTACT) !== 0;
  }
  set upwardSurfaceContact(v: boolean) {
    const f = pv().flags;
    if (v) f[this.slot] |= BODY_FLAG_UPWARD_CONTACT;
    else f[this.slot] &= ~BODY_FLAG_UPWARD_CONTACT;
  }
}

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
// SLEEP_TICKS still consumed by the JS-side `sleepBody` (initial
// counter value when JS triggers a manual sleep). The TS-side
// thresholds (SPEED_SQ, ACCEL_SQ, GROUND_PENETRATION_EPS) used
// to gate the integrate-time sleep transition now live in the
// Rust kernel — see rts-sim-wasm/src/lib.rs `pool_step_integrate`.
const SLEEP_TICKS = 12;

export class PhysicsEngine3D {
  private bodies: Body3D[] = [];
  private dynamicBodies: Body3D[] = [];
  private staticBodies: Body3D[] = [];
  // Slot-id → Body3D lookup. Indexed by the pool slot, so the
  // sleep-/wake-transition outputs from pool kernels (which carry
  // slot ids, not Body3D references) can resolve back to the JS
  // Body3D for engine-side bookkeeping (awake count, accumulator
  // clear, ignore-pair purge). Sparse — undefined entries are slots
  // not owned by this engine instance.
  private bodyBySlot: (Body3D | undefined)[] = [];
  private awakeDynamicBodyCount = 0;
  private stepSyncEntityIds: EntityId[] = [];
  private stepSyncEntityIdSet = new Set<EntityId>();
  private mapWidth: number;
  private mapHeight: number;

  // Static cuboid broadphase lives in the WASM-side EngineStatics
  // (Phase 3f). Each engine instance gets its own handle so the
  // foreground game and the background battle don't share static
  // cells. Set in the constructor.
  private staticsHandle: number = 0;

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
    // Body3D fields live in the WASM-side SoA pool (Phase 3d) — bind
    // the pool views once now so every Body3D allocated by this
    // engine reads/writes the same canonical state. GameServer.create
    // awaits initSimWasm() before constructing PhysicsEngine3D, so
    // the pool is guaranteed ready by this point.
    const sim = getSimWasm();
    if (sim === undefined) {
      throw new Error(
        'PhysicsEngine3D: sim-wasm pool not initialised. Construct PhysicsEngine3D only after `await initSimWasm()`.',
      );
    }
    bindBody3DPool(sim.pool);
    // Phase 3f: allocate this engine's static-cuboid broadphase
    // handle. Foreground game + LobbyManager background battle each
    // call new PhysicsEngine3D and so each get their own handle.
    this.staticsHandle = sim.engineStaticsCreate();
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
    const body = Body3D.allocate({
      shape: 'sphere',
      isStatic: false,
      mass: physicsMass,
      label,
      entityId,
      x,
      y,
      z,
      radius: physicsRadius,
      groundOffset: bodyCenterHeight,
      restitution: 0.2,
    });
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
    const body = Body3D.allocate({
      shape: 'cuboid',
      isStatic: true,
      mass: 0,
      label,
      x,
      y,
      z: baseZ + depth / 2,
      halfX: width / 2,
      halfY: height / 2,
      halfZ: depth / 2,
      restitution: 0.1,
    });
    this.addBody(body);
    return body;
  }

  private addBody(body: Body3D): void {
    this.bodies.push(body);
    this.bodyBySlot[body.slot] = body;
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
    this.bodyBySlot[body.slot] = undefined;
    // Release the BodyPool slot so future bodies can reuse it.
    body.free();
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

  private addStaticToBroadphase(body: Body3D): void {
    if (body.shape !== 'cuboid') return;
    getSimWasm()!.engineStaticsAdd(this.staticsHandle, body.slot, CONTACT_CELL_SIZE);
  }

  private removeStaticFromBroadphase(body: Body3D): void {
    if (body.shape !== 'cuboid') return;
    getSimWasm()!.engineStaticsRemove(this.staticsHandle, body.slot, CONTACT_CELL_SIZE);
  }

  step(dtSec: number): void {
    // Refresh BodyPool typed-array views in case the WASM linear
    // memory grew since the last step. Vec growths (sphere-sphere
    // resolver's HashMap, static broadphase per-cell Vecs, etc.)
    // can trigger memory.grow(), which detaches every existing
    // typed-array view JS holds — and writing through a detached
    // view crashes the renderer. Cheap to refresh (~22 typed-array
    // constructions) and idempotent when nothing actually grew.
    getSimWasm()!.pool.refreshViews();
    this.stepSyncEntityIds.length = 0;
    this.stepSyncEntityIdSet.clear();
    if (this.awakeDynamicBodyCount <= 0) return;
    this.collectAwakeStepSyncEntities();
    this.clearDynamicSurfaceContacts();
    this.integrate(dtSec);
    // Bodies touched this step still need final contact/clamp cleanup
    // even if integration just put the last awake body to sleep.
    this.resolveSphereCuboidContacts();
    const sphereIterations = this.getSphereIterationBudget();
    this.resolveSphereSphereContacts(sphereIterations);
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
   *  Phase 3d-2: state lives in the BodyPool, integration runs in
   *  one Rust/WASM call (`pool_step_integrate`) reading body fields
   *  by slot index. Per-tick boundary traffic is just the awake-
   *  slot list + pre-sampled ground state + a sleep-transition
   *  output buffer; no per-body Body3D field marshal.
   *
   *  Non-sphere dynamic bodies (none exist today but the path is
   *  defensive) still run free-Euler inline JS-side. */
  private integrate(dtSec: number): void {
    const airDamp = getUnitAirFrictionDamp(dtSec);
    const groundDamp = getUnitGroundFrictionDamp(dtSec);
    // Pool readiness was enforced in the constructor, so getSimWasm
    // is guaranteed defined here. Cast through `!` to keep the
    // call sites tight without re-checking.
    const sim = getSimWasm()!;
    const maxCount = this.dynamicBodies.length;
    if (_integrateAwakeSlots.length < maxCount) {
      _integrateAwakeSlots = new Uint32Array(maxCount);
      _integrateGroundZ = new Float64Array(maxCount);
      _integrateGroundNormals = new Float64Array(maxCount * 3);
      _integrateSleepTransitions = new Uint32Array(maxCount);
    }
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
      _integrateAwakeSlots[count] = b.slot;
      _integrateGroundZ[count] = groundZ;
      _integrateGroundNormals[count * 3] = nx;
      _integrateGroundNormals[count * 3 + 1] = ny;
      _integrateGroundNormals[count * 3 + 2] = nz;
      count++;
    }
    if (count === 0) return;
    // Slice the typed arrays down to `count` so the kernel's
    // debug_assert on length matches; the underlying buffer is
    // shared so this is zero-copy.
    const slotsView = _integrateAwakeSlots.subarray(0, count);
    const groundZView = _integrateGroundZ.subarray(0, count);
    const groundNormalsView = _integrateGroundNormals.subarray(0, count * 3);
    const transitionsView = _integrateSleepTransitions.subarray(0, count);
    const transitionCount = sim.poolStepIntegrate(
      slotsView,
      groundZView,
      groundNormalsView,
      transitionsView,
      dtSec,
      airDamp,
      groundDamp,
    );
    for (let i = 0; i < transitionCount; i++) {
      const slot = transitionsView[i];
      const b = this.bodyBySlot[slot];
      if (b !== undefined) {
        // sleepBody() handles the awake-count decrement + the eager
        // accumulator clear (resolvers may otherwise see stale
        // ax/ay/az on a body that re-wakes from collision the same
        // step). The Rust kernel already snapped position + zeroed
        // velocity in the pool, so b.x/y/z and v[xyz] are already
        // at the snapped/rest values.
        this.sleepBody(b);
      }
    }
  }

  /** Phase 3f sphere-vs-cuboid contact resolver. The static
   *  broadphase lives in the WASM-side EngineStatics; one Rust call
   *  walks every dyn sphere's overlapping cells, dedups via the
   *  per-static visit-stamp counter, and runs the resolver in
   *  place. JS only marshals the dyn slot list, the parallel
   *  ignored-static-slot lookup, and a wake-transition output. */
  private resolveSphereCuboidContacts(): void {
    const sim = getSimWasm()!;
    const bodies = this.dynamicBodies;
    const maxCount = bodies.length;
    if (maxCount === 0) return;
    if (_sphereCuboidDynSlots.length < maxCount) {
      _sphereCuboidDynSlots = new Uint32Array(maxCount);
      _sphereCuboidIgnoredStatics = new Uint32Array(maxCount);
      _sphereCuboidWakeTransitions = new Uint32Array(maxCount);
    }
    let n = 0;
    for (let i = 0; i < maxCount; i++) {
      const dyn = bodies[i];
      if (!this.shouldProcessBodyThisStep(dyn)) continue;
      if (dyn.shape !== 'sphere') continue;
      _sphereCuboidDynSlots[n] = dyn.slot;
      const ignored = this.ignoreStatic.get(dyn);
      _sphereCuboidIgnoredStatics[n] = ignored !== undefined ? ignored.slot : NO_IGNORE_SLOT;
      n++;
    }
    if (n === 0) return;
    const dynSlotsView = _sphereCuboidDynSlots.subarray(0, n);
    const ignoredView = _sphereCuboidIgnoredStatics.subarray(0, n);
    const wakeView = _sphereCuboidWakeTransitions.subarray(0, n);
    const wakeCount = sim.poolResolveSphereCuboidFull(
      this.staticsHandle,
      dynSlotsView,
      ignoredView,
      CONTACT_CELL_SIZE,
      wakeView,
    );
    for (let i = 0; i < wakeCount; i++) {
      const slot = wakeView[i];
      const b = this.bodyBySlot[slot];
      if (b !== undefined) {
        // wakeBody() is idempotent; safe even if the same dyn slot
        // appears multiple times (kernel emits one entry per dyn
        // that hit any cuboid; future duplicate-suppression upstream
        // doesn't change behavior here).
        this.wakeBody(b);
      }
    }
  }

  /** Phase 3d-2 pool-backed sphere-sphere resolver. The Rust kernel
   *  reads body state by slot index and writes positions /
   *  velocities / upward-contact flag bit directly into the pool;
   *  JS only marshals the slot list and a wake-transition output
   *  buffer. */
  private resolveSphereSphereContacts(iterations: number): void {
    const sim = getSimWasm()!;
    const bodies = this.dynamicBodies;
    const maxCount = bodies.length;
    if (maxCount === 0 || iterations <= 0) return;
    if (_sphereSphereSlots.length < maxCount) {
      _sphereSphereSlots = new Uint32Array(maxCount);
      _sphereSphereWakeTransitions = new Uint32Array(maxCount);
    }
    let n = 0;
    for (let i = 0; i < maxCount; i++) {
      const b = bodies[i];
      if (b.shape !== 'sphere') continue;
      // Sleeping bodies still iterate the broadphase here — see the
      // long comment in resolveSphereSphereContactsTsIteration around
      // line 800 for why (a body spawning into a sleeping body's slot
      // must still get pushed apart).
      _sphereSphereSlots[n] = b.slot;
      n++;
    }
    if (n === 0) return;
    const slotsView = _sphereSphereSlots.subarray(0, n);
    const wakeView = _sphereSphereWakeTransitions.subarray(0, n);
    const wakeCount = sim.poolResolveSphereSphere(
      slotsView,
      iterations,
      CONTACT_CELL_SIZE,
      wakeView,
    );
    for (let i = 0; i < wakeCount; i++) {
      const slot = wakeView[i];
      const b = this.bodyBySlot[slot];
      if (b !== undefined) {
        // wakeBody is idempotent on already-awake bodies — matches
        // the TS path's unconditional wake on pair resolution. The
        // upward-contact flag is already set on the pool's flags
        // byte by the Rust kernel; reading via b.upwardSurfaceContact
        // (the getter on Body3D) returns the freshly-set value.
        this.wakeBody(b);
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
