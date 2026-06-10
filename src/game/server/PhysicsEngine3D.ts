// 3D authoritative physics orchestration. Body state lives in the
// WASM-side BodyPool; this TypeScript class owns allocation, terrain
// sampling, static broadphase handles, and engine-side bookkeeping while
// Rust/WASM owns dynamic-body integration and contact kernels.
//
// Convention: (x, y) is the horizontal ground plane, z is altitude
// (positive = up). Gravity accelerates -z. The 3D client maps
// (sim.x, sim.z, sim.y) → Three.js (x, y, z).
//
// Body shapes:
//   sphere — units. Radius + center. Rolls-free movement on the
//            horizontal plane. Gravity always pulls down; terrain
//            only pushes back when the unit's authored locomotion
//            ground point penetrates the terrain surface.
//   cuboid — buildings. Axis-aligned 3D box, always static for now.
//            Units push off the cuboid's surface instead of clipping
//            through.
//
// Collision dimension by pair type:
//   unit ↔ ground    — soft spring along the terrain normal, measured
//                      from the unit's locomotion ground point.
//   unit ↔ building  — full 3D (sphere vs cuboid) so tall buildings
//                      are blockers and short ones can be cleared by
//                      units whose ground point is above terrain.
//   unit ↔ unit      — full 3D sphere-vs-sphere push. Two units at
//                      the same altitude behave exactly like 2D
//                      horizontal jostle; two at different altitudes
//                      separate along the combined 3D contact normal,
//                      so an elevated unit directly above a ground
//                      unit doesn't slam it sideways for no reason.
//   projectile hits  — full 3D; handled OUTSIDE this engine by
//                      DamageSystem / ProjectileCollisionHandler.
//
// Step order per tick:
//
//   1. Add map-edge boundary spring/damping acceleration.
//   2. WASM integrates sphere bodies from accumulated acceleration,
//      gravity, terrain spring contact, air drag, ground friction, and
//      fixed dt; it also emits sleep transitions.
//   3. WASM resolves sphere-cuboid and sphere-sphere contacts.
//   4. Clear per-step acceleration accumulators.
//
// Current dynamic bodies are spheres (units). Cuboids are static
// buildings. Adding a new dynamic shape requires adding it to the WASM
// integration/contact path first; there is no TypeScript fallback
// integrator.

import {
  BODY_SLEEP_TICKS,
  UNIT_MASS_MULTIPLIER,
  UNIT_WORLD_BOUNDARY_SPRING_ACCEL_PER_WORLD_UNIT,
  UNIT_WORLD_BOUNDARY_SPRING_DAMPING_RATIO,
} from '../../config';
import { getUnitAirFrictionDamp } from '../sim/unitAirFriction';
import {
  getUnitGroundFrictionDamp,
  UNIT_GROUND_CONTACT_EPSILON,
} from '../sim/unitGroundPhysics';
import {
  SUPPORT_SURFACE_CONTACT_EPSILON,
  SUPPORT_SURFACE_FOOTPRINT_EPSILON,
  copyWorldSupportSurface,
  createWorldSupportSurface,
  writeBuildingSupportSurface,
  writeUnitSupportSurface,
  type WorldSupportSurface,
} from '../sim/supportSurface';
import {
  getSimWasm,
  BODY_FLAG_SLEEPING,
  BODY_FLAG_IS_STATIC,
  BODY_FLAG_UPWARD_CONTACT,
  BODY_FLAG_SHAPE_CUBOID,
  BODY_FLAG_OCCUPIED,
  type BodyPoolViews,
} from '../sim-wasm/init';
import type { BuildingSupportSurface, EntityId, UnitSupportSurface } from '../sim/types';

type SurfaceNormal = { nx: number; ny: number; nz: number };
export type SupportSurfaceContact = WorldSupportSurface;
type StaticSupportSurfaceContact = WorldSupportSurface & {
  staticBody: Body3D;
};
type DynamicSupportSurfaceContact = WorldSupportSurface & {
  dynamicBody: Body3D;
};
type ApplyForceOptions = { canLaunchFromGround: boolean };

const DEFAULT_APPLY_FORCE_OPTIONS: ApplyForceOptions = {
  canLaunchFromGround: false,
};

// Phase 3d-2 scratch buffers. Body state lives in the WASM-side
// BodyPool, so per-tick marshalling shrinks to: a Uint32Array of
// active slot ids + batched ground sample output + a Uint32Array
// sized to the active count for sleep / wake transitions written
// out by the kernel.
// All grown on demand; never shrunk to avoid per-tick allocation
// churn. Single module-scope set is safe because step() is never
// called re-entrantly within one JS turn.
let _integrateAwakeSlots: Uint32Array = new Uint32Array(0);
let _integrateGroundZ: Float64Array = new Float64Array(0);
let _integrateGroundNormals: Float64Array = new Float64Array(0);
let _integrateSleepTransitions: Uint32Array = new Uint32Array(0);
let _integrateStepSyncEntityIds: Int32Array = new Int32Array(0);
let _finalStepSyncEntityIds: Int32Array = new Int32Array(0);
let _collectAwakeEntityIds: Int32Array = new Int32Array(0);
const _physicsStepStats: Uint32Array = new Uint32Array(3);

let _sphereSphereWakeTransitions: Uint32Array = new Uint32Array(0);

// Phase 3f sphere-vs-cuboid scratch. The static broadphase itself
// lives in WASM (per-engine via engineStatics handle). JS only
// needs to marshal the per-tick dyn slot list, the parallel ignore-
// pair lookup, and the wake-transition output buffer.
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

function refreshAndBindBody3DPool(views: BodyPoolViews): void {
  views.refreshViews();
  bindBody3DPool(views);
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
   *  0 for static bodies. Kept JS-side for diagnostics/serialization and
   *  kept in lockstep with the pool `invMass`. Mutable because a host's
   *  effective mass changes at runtime when it gains/loses pieces
   *  (turrets, locomotion) — see PhysicsEngine3D.setBodyEffectiveMass. */
  mass: number;
  readonly isStatic: boolean;
  /** Debug / log tag — entity type or id for tracing. */
  label: string;
  /** Owning sim entity id for bodies that mirror an entity. */
  entityId: EntityId | undefined;
  /** Optional authored support proxy for static cuboids. These JS-side
   *  fields intentionally do not change the WASM collision shape. */
  supportTopZ: number | null = null;
  supportHalfX: number = 0;
  supportHalfY: number = 0;
  unitSupportTopOffsetZ: number | null = null;
  unitSupportRadius: number = 0;

  private constructor(args: {
    slot: number;
    shape: 'sphere' | 'cuboid';
    mass: number;
    isStatic: boolean;
    label: string;
    entityId: EntityId | undefined;
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
    entityId: EntityId | undefined;
    x: number;
    y: number;
    z: number;
    radius: number | undefined;
    halfX: number | undefined;
    halfY: number | undefined;
    halfZ: number | undefined;
    groundOffset: number | undefined;
    restitution: number;
    groundFrictionScale?: number;
    surfaceNormal: SurfaceNormal | null;
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
    views.groundFrictionScale[slot] = args.groundFrictionScale ?? 1;
    views.groundOffset[slot] = args.groundOffset ?? 0;
    views.entityId[slot] = args.entityId ?? -1;
    if (args.surfaceNormal !== null) {
      views.surfaceNormalX[slot] = args.surfaceNormal.nx;
      views.surfaceNormalY[slot] = args.surfaceNormal.ny;
      views.surfaceNormalZ[slot] = args.surfaceNormal.nz;
    }
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
  get surfaceNormalX(): number { return pv().surfaceNormalX[this.slot]; }
  set surfaceNormalX(v: number) { pv().surfaceNormalX[this.slot] = v; }
  get surfaceNormalY(): number { return pv().surfaceNormalY[this.slot]; }
  set surfaceNormalY(v: number) { pv().surfaceNormalY[this.slot] = v; }
  get surfaceNormalZ(): number { return pv().surfaceNormalZ[this.slot]; }
  set surfaceNormalZ(v: number) { pv().surfaceNormalZ[this.slot] = v; }

  createSurfaceNormalView(): SurfaceNormal {
    const slot = this.slot;
    return {
      get nx(): number { return pv().surfaceNormalX[slot]; },
      set nx(v: number) { pv().surfaceNormalX[slot] = v; },
      get ny(): number { return pv().surfaceNormalY[slot]; },
      set ny(v: number) { pv().surfaceNormalY[slot] = v; },
      get nz(): number { return pv().surfaceNormalZ[slot]; },
      set nz(v: number) { pv().surfaceNormalZ[slot] = v; },
    };
  }

  // Geometry — set at construction, read often, never written after.
  get radius(): number { return pv().radius[this.slot]; }
  get halfX(): number { return pv().halfX[this.slot]; }
  get halfY(): number { return pv().halfY[this.slot]; }
  get halfZ(): number { return pv().halfZ[this.slot]; }
  get invMass(): number { return pv().invMass[this.slot]; }
  get restitution(): number { return pv().restitution[this.slot]; }
  get groundOffset(): number { return pv().groundOffset[this.slot]; }
  /** Per-body ground-friction multiplier (1 = normal traction,
   *  0 = frictionless). Settable so a body's traction can change at
   *  runtime if a future feature needs it. */
  get groundFrictionScale(): number { return pv().groundFrictionScale[this.slot]; }
  set groundFrictionScale(v: number) { pv().groundFrictionScale[this.slot] = v; }

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
const WORLD_BOUNDARY_DAMPING_ACCEL_PER_SPEED =
  UNIT_WORLD_BOUNDARY_SPRING_ACCEL_PER_WORLD_UNIT > 0
    ? 2
      * Math.sqrt(UNIT_WORLD_BOUNDARY_SPRING_ACCEL_PER_WORLD_UNIT)
      * Math.max(0, UNIT_WORLD_BOUNDARY_SPRING_DAMPING_RATIO)
    : 0;
// BODY_SLEEP_TICKS is still consumed by the JS-side `sleepBody`
// (initial counter value when JS triggers a manual sleep). The
// TS-side thresholds (SPEED_SQ, ACCEL_SQ, GROUND_PENETRATION_EPS)
// used to gate the integrate-time sleep transition now live in the
// Rust kernel — see rts-sim-wasm/src/lib.rs `pool_step_integrate`.

export class PhysicsEngine3D {
  private bodies: Body3D[] = [];
  private dynamicBodies: Body3D[] = [];
  private staticBodies: Body3D[] = [];
  private dynamicBodySlots: Uint32Array = new Uint32Array(0);
  private dynamicBodySlotsDirty = true;
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
  private disposed = false;

  // Ignore a specific static body for a specific dynamic body. Same
  // purpose as the 2D engine: a newly spawned unit shouldn't immediately
  // collide with a building it starts inside. The pair is temporary and
  // clears once the sphere exits the ignored cuboid's expanded bounds.
  private ignoreStatic: Map<Body3D, Body3D> = new Map();
  // Dynamic slot -> static slot for the cuboid currently acting as a
  // terrain-like top support. That cuboid is skipped by the sphere-cuboid
  // resolver for this step so the unit rests by `groundOffset`, not by its
  // collision radius.
  private stepSupportIgnoredStaticSlots = new Map<number, number>();

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
    // Phase 3f: allocate this engine's static-cuboid broadphase
    // handle. Foreground game + LobbyManager background battle each
    // call new PhysicsEngine3D and so each get their own handle.
    // Creating the handle can grow WASM memory, which detaches the
    // BodyPool typed-array views. Refresh before binding so bodies
    // spawned immediately after construction keep their authored
    // positions instead of writing through stale views.
    this.staticsHandle = sim.engineStaticsCreate();
    refreshAndBindBody3DPool(sim.pool);
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
    supportSurface: UnitSupportSurface,
    mass: number,
    label: string,
    entityId: EntityId | undefined = undefined,
    initialZ: number | undefined = undefined,
    surfaceNormal: SurfaceNormal | null = null,
    groundFrictionScale: number = 1,
  ): Body3D {
    refreshAndBindBody3DPool(getSimWasm()!.pool);
    const physicsMass = mass * UNIT_MASS_MULTIPLIER;
    const z = initialZ !== undefined && Number.isFinite(initialZ)
      ? initialZ
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
      halfX: undefined,
      halfY: undefined,
      halfZ: undefined,
      groundOffset: bodyCenterHeight,
      restitution: 0.2,
      groundFrictionScale,
      surfaceNormal,
    });
    if (supportSurface.kind === 'discTop') {
      body.unitSupportTopOffsetZ = supportSurface.topZ;
      body.unitSupportRadius = supportSurface.radius;
    }
    this.addBody(body);
    return body;
  }

  /** Update a dynamic body's mass after it gains or loses weight at
   *  runtime — a unit losing a turret or its locomotion drops its
   *  effective mass, so the chassis accelerates, recoils, and gets
   *  knocked around more (F = M·A with a smaller M). `preMultiplierMass`
   *  is the same pre-UNIT_MASS_MULTIPLIER mass createUnitBody takes; the
   *  pool `invMass` and the JS-side `mass` are kept in lockstep. Static
   *  bodies (buildings/towers) have no dynamic mass and are left
   *  untouched. */
  setBodyEffectiveMass(body: Body3D, preMultiplierMass: number): void {
    if (body.isStatic) return;
    const physicsMass = preMultiplierMass * UNIT_MASS_MULTIPLIER;
    body.mass = physicsMass;
    pv().invMass[body.slot] = physicsMass > 0 ? 1 / physicsMass : 0;
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
    supportSurface: BuildingSupportSurface,
    label: string,
    entityId: EntityId | undefined = undefined,
  ): Body3D {
    refreshAndBindBody3DPool(getSimWasm()!.pool);
    const body = Body3D.allocate({
      shape: 'cuboid',
      isStatic: true,
      mass: 0,
      label,
      x,
      y,
      z: baseZ + depth / 2,
      radius: undefined,
      halfX: width / 2,
      halfY: height / 2,
      halfZ: depth / 2,
      groundOffset: undefined,
      restitution: 0.1,
      surfaceNormal: null,
      entityId,
    });
    if (supportSurface.kind === 'boxTop') {
      body.supportTopZ = baseZ + supportSurface.topZ;
      body.supportHalfX = supportSurface.width / 2;
      body.supportHalfY = supportSurface.height / 2;
    }
    this.addBody(body);
    return body;
  }

  private addBody(body: Body3D): void {
    if (!body.isStatic && body.shape !== 'sphere') {
      throw new Error(
        `PhysicsEngine3D dynamic body ${body.label} uses unsupported shape ${body.shape}; add the shape to the WASM integrator before spawning it`,
      );
    }
    this.bodies.push(body);
    this.bodyBySlot[body.slot] = body;
    if (body.isStatic) {
      this.staticBodies.push(body);
      this.addStaticToBroadphase(body);
    } else {
      this.dynamicBodies.push(body);
      this.dynamicBodySlotsDirty = true;
      if (!body.sleeping) this.awakeDynamicBodyCount++;
    }
  }

  removeBody(body: Body3D): void {
    const i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
    const j = this.dynamicBodies.indexOf(body);
    if (j >= 0) {
      this.dynamicBodies.splice(j, 1);
      this.dynamicBodySlotsDirty = true;
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
    options: ApplyForceOptions = DEFAULT_APPLY_FORCE_OPTIONS,
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
    if (options.canLaunchFromGround) {
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
    const slots = this.getDynamicBodySlotsView();
    const count = slots.length;
    if (count === 0) return;
    if (_collectAwakeEntityIds.length < count) {
      _collectAwakeEntityIds = new Int32Array(count);
    }
    const sim = getSimWasm()!;
    const idsView = _collectAwakeEntityIds.subarray(0, count);
    const entityCount = sim.poolCollectAwakeEntityIds(slots, idsView);
    for (let i = 0; i < entityCount; i++) {
      out.push(idsView[i]);
    }
  }

  private getDynamicBodySlotsView(): Uint32Array {
    const count = this.dynamicBodies.length;
    if (this.dynamicBodySlots.length < count) {
      this.dynamicBodySlots = new Uint32Array(count);
      this.dynamicBodySlotsDirty = true;
    }
    if (this.dynamicBodySlotsDirty) {
      for (let i = 0; i < count; i++) {
        this.dynamicBodySlots[i] = this.dynamicBodies[i].slot;
      }
      this.dynamicBodySlotsDirty = false;
    }
    return this.dynamicBodySlots.subarray(0, count);
  }

  hasUpwardSurfaceContact(body: Body3D): boolean {
    return body.upwardSurfaceContact === true;
  }

  sampleSupportSurface(
    body: Body3D,
    terrainSurface: WorldSupportSurface,
    out: WorldSupportSurface = createWorldSupportSurface(),
  ): WorldSupportSurface {
    const support = this.findSupportSurface(body, terrainSurface.groundZ);
    if (support !== null) {
      return copyWorldSupportSurface(support, out);
    }

    return copyWorldSupportSurface(terrainSurface, out);
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

  /** Clear a specific temporary static-body ignore. If `staticBody` is
   *  omitted, any ignore for the dynamic body is removed. */
  clearIgnoreStatic(dynamicBody: Body3D, staticBody: Body3D | undefined = undefined): void {
    if (staticBody === undefined || this.ignoreStatic.get(dynamicBody) === staticBody) {
      this.ignoreStatic.delete(dynamicBody);
    }
  }

  private clearExitedStaticIgnores(): void {
    if (this.ignoreStatic.size === 0) return;

    for (const [dynamicBody, staticBody] of this.ignoreStatic) {
      if (this.hasExitedIgnoredStatic(dynamicBody, staticBody)) {
        this.ignoreStatic.delete(dynamicBody);
      }
    }
  }

  private clearExitedStaticIgnoreForBody(dynamicBody: Body3D): void {
    const staticBody = this.ignoreStatic.get(dynamicBody);
    if (staticBody === undefined) return;
    if (this.hasExitedIgnoredStatic(dynamicBody, staticBody)) {
      this.ignoreStatic.delete(dynamicBody);
    }
  }

  private hasExitedIgnoredStatic(dynamicBody: Body3D, staticBody: Body3D): boolean {
    if (dynamicBody.shape !== 'sphere' || staticBody.shape !== 'cuboid') return true;

    const clearance = dynamicBody.radius + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
    return Math.abs(dynamicBody.x - staticBody.x) > staticBody.halfX + clearance
      || Math.abs(dynamicBody.y - staticBody.y) > staticBody.halfY + clearance
      || Math.abs(dynamicBody.z - staticBody.z) > staticBody.halfZ + clearance;
  }

  recordWasmForceWake(body: Body3D): void {
    this.wakeBody(body);
  }

  wakeBody(body: Body3D): void {
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
    body.sleepTicks = BODY_SLEEP_TICKS;
    body.ax = 0;
    body.ay = 0;
    body.az = 0;
    body.groundLaunchAx = 0;
    body.groundLaunchAy = 0;
    body.groundLaunchAz = 0;
  }

  private addStepSyncEntityId(id: EntityId): void {
    if (this.stepSyncEntityIdSet.has(id)) return;
    this.stepSyncEntityIdSet.add(id);
    this.stepSyncEntityIds.push(id);
  }

  private addStaticToBroadphase(body: Body3D): void {
    if (body.shape !== 'cuboid') return;
    const sim = getSimWasm()!;
    sim.engineStaticsAdd(this.staticsHandle, body.slot, CONTACT_CELL_SIZE);
    refreshAndBindBody3DPool(sim.pool);
  }

  private removeStaticFromBroadphase(body: Body3D): void {
    if (body.shape !== 'cuboid') return;
    const sim = getSimWasm()!;
    sim.engineStaticsRemove(this.staticsHandle, body.slot, CONTACT_CELL_SIZE);
    refreshAndBindBody3DPool(sim.pool);
  }

  /** Release WASM-side resources owned by this engine. Call once at
   *  teardown — GameServer.stop does this. After dispose, no other
   *  method on this instance is safe to call. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const sim = getSimWasm();
    if (sim === undefined) return;

    refreshAndBindBody3DPool(sim.pool);
    while (this.bodies.length > 0) {
      this.removeBody(this.bodies[this.bodies.length - 1]);
    }
    this.dynamicBodies.length = 0;
    this.staticBodies.length = 0;
    this.dynamicBodySlotsDirty = true;
    this.bodyBySlot.length = 0;
    this.ignoreStatic.clear();
    this.awakeDynamicBodyCount = 0;
    this.stepSyncEntityIds.length = 0;
    this.stepSyncEntityIdSet.clear();

    sim.engineStaticsDestroy(this.staticsHandle);
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
    this.stepSupportIgnoredStaticSlots.clear();
    if (this.awakeDynamicBodyCount <= 0) return;
    const dynamicSlots = this.getDynamicBodySlotsView();
    const maxCount = dynamicSlots.length;
    if (maxCount === 0) return;
    this.ensureIntegrationScratch(maxCount);
    const integrateCount = this.prepareIntegrationStep(dynamicSlots);
    if (integrateCount === 0) return;
    this.integrate(dtSec, integrateCount);
    // Bodies touched this step still need final contact cleanup even
    // if integration just put the last awake body to sleep.
    const stepSlots = _integrateAwakeSlots.subarray(0, integrateCount);
    this.resolveSphereCuboidContacts(stepSlots);
    const sphereIterations = this.getSphereIterationBudget();
    this.resolveSphereSphereContacts(sphereIterations, dynamicSlots);
    this.collectFinalStepSyncEntitiesAndClearForces(dynamicSlots);
  }

  private ensureIntegrationScratch(maxCount: number): void {
    if (_integrateAwakeSlots.length < maxCount) {
      _integrateAwakeSlots = new Uint32Array(maxCount);
      _integrateGroundZ = new Float64Array(maxCount);
      _integrateGroundNormals = new Float64Array(maxCount * 3);
      _integrateSleepTransitions = new Uint32Array(maxCount);
      _integrateStepSyncEntityIds = new Int32Array(maxCount);
      _finalStepSyncEntityIds = new Int32Array(maxCount);
    }
  }

  private prepareIntegrationStep(dynamicSlots: Uint32Array): number {
    const count = dynamicSlots.length;
    const sim = getSimWasm()!;
    const awakeView = _integrateAwakeSlots.subarray(0, count);
    const syncView = _integrateStepSyncEntityIds.subarray(0, count);
    sim.poolPrepareDynamicStep(
      dynamicSlots,
      awakeView,
      syncView,
      _physicsStepStats,
      this.mapWidth,
      this.mapHeight,
      UNIT_WORLD_BOUNDARY_SPRING_ACCEL_PER_WORLD_UNIT,
      WORLD_BOUNDARY_DAMPING_ACCEL_PER_SPEED,
    );
    this.awakeDynamicBodyCount += _physicsStepStats[1];
    const syncCount = _physicsStepStats[2];
    for (let i = 0; i < syncCount; i++) {
      this.addStepSyncEntityId(syncView[i]);
    }
    return _physicsStepStats[0];
  }

  private collectFinalStepSyncEntitiesAndClearForces(dynamicSlots: Uint32Array): void {
    const count = dynamicSlots.length;
    if (count === 0) return;
    const sim = getSimWasm()!;
    const syncView = _finalStepSyncEntityIds.subarray(0, count);
    const syncCount = sim.poolFinalizeDynamicStep(dynamicSlots, syncView);
    for (let i = 0; i < syncCount; i++) {
      this.addStepSyncEntityId(syncView[i]);
    }
  }

  private getSphereIterationBudget(): number {
    const count = this.dynamicBodies.length;
    if (count >= SPHERE_ITERATIONS_HIGH_COUNT) return 1;
    if (count >= SPHERE_ITERATIONS_MID_COUNT) return 2;
    return SPHERE_ITERATIONS;
  }

  private sampleIntegrationGroundFallback(count: number): void {
    for (let i = 0; i < count; i++) {
      const slot = _integrateAwakeSlots[i];
      const b = this.bodyBySlot[slot];
      if (b === undefined) {
        throw new Error(`PhysicsEngine3D missing body for slot ${slot}`);
      }
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
      _integrateGroundZ[i] = groundZ;
      _integrateGroundNormals[i * 3] = nx;
      _integrateGroundNormals[i * 3 + 1] = ny;
      _integrateGroundNormals[i * 3 + 2] = nz;
    }
  }

  private sampleIntegrationSupportSurfaces(count: number): void {
    for (let i = 0; i < count; i++) {
      const slot = _integrateAwakeSlots[i];
      const b = this.bodyBySlot[slot];
      if (b === undefined) continue;

      const support = this.findSupportSurface(b, _integrateGroundZ[i]);
      if (support === null) continue;

      _integrateGroundZ[i] = support.groundZ;
      _integrateGroundNormals[i * 3] = support.normalX;
      _integrateGroundNormals[i * 3 + 1] = support.normalY;
      _integrateGroundNormals[i * 3 + 2] = support.normalZ;
    }
  }

  private refreshStepSupportIgnoredStaticSlots(count: number): void {
    this.stepSupportIgnoredStaticSlots.clear();
    for (let i = 0; i < count; i++) {
      const slot = _integrateAwakeSlots[i];
      const b = this.bodyBySlot[slot];
      if (b === undefined) continue;
      const support = this.findStaticSupportSurface(b, this.getGroundZ(b.x, b.y));
      if (support !== null) {
        this.stepSupportIgnoredStaticSlots.set(b.slot, support.staticBody.slot);
      }
    }
  }

  private findStaticSupportSurface(
    body: Body3D,
    terrainGroundZ: number,
  ): StaticSupportSurfaceContact | null {
    if (body.isStatic || body.shape !== 'sphere') return null;

    this.clearExitedStaticIgnoreForBody(body);
    const ignoredStatic = this.ignoreStatic.get(body);
    const groundPointZ = body.z - body.groundOffset;
    let best: StaticSupportSurfaceContact | null = null;

    for (let i = 0; i < this.staticBodies.length; i++) {
      const st = this.staticBodies[i];
      if (st === ignoredStatic || st.shape !== 'cuboid') continue;
      if (st.supportTopZ === null) continue;

      const topZ = st.supportTopZ;
      if (topZ < terrainGroundZ - SUPPORT_SURFACE_CONTACT_EPSILON) continue;
      if (body.z < topZ - SUPPORT_SURFACE_CONTACT_EPSILON) continue;
      if (groundPointZ < topZ - SUPPORT_SURFACE_CONTACT_EPSILON) continue;

      const dx = body.x - st.x;
      const dy = body.y - st.y;
      if (Math.abs(dx) > st.supportHalfX + SUPPORT_SURFACE_FOOTPRINT_EPSILON) continue;
      if (Math.abs(dy) > st.supportHalfY + SUPPORT_SURFACE_FOOTPRINT_EPSILON) continue;

      if (best === null || topZ > best.groundZ) {
        const candidate = createWorldSupportSurface() as StaticSupportSurfaceContact;
        candidate.staticBody = st;
        best = writeBuildingSupportSurface(
          candidate,
          topZ,
          st.entityId ?? null,
          st.entityId ?? st.slot,
        ) as StaticSupportSurfaceContact;
        best.staticBody = st;
      }
    }

    return best;
  }

  private findDynamicSupportSurface(
    body: Body3D,
    terrainGroundZ: number,
  ): DynamicSupportSurfaceContact | null {
    if (body.isStatic || body.shape !== 'sphere') return null;

    const groundPointZ = body.z - body.groundOffset;
    const sphereBottomZ = body.z - body.radius;
    let best: DynamicSupportSurfaceContact | null = null;

    for (let i = 0; i < this.dynamicBodies.length; i++) {
      const supportBody = this.dynamicBodies[i];
      if (supportBody === body || supportBody.shape !== 'sphere') continue;
      const supportTopOffsetZ = supportBody.unitSupportTopOffsetZ;
      if (supportTopOffsetZ === null) continue;

      const topZ = supportBody.z - supportBody.groundOffset + supportTopOffsetZ;
      if (topZ < terrainGroundZ - SUPPORT_SURFACE_CONTACT_EPSILON) continue;
      if (body.z < topZ - SUPPORT_SURFACE_CONTACT_EPSILON) continue;

      const dx = body.x - supportBody.x;
      const dy = body.y - supportBody.y;
      const radius = supportBody.unitSupportRadius + SUPPORT_SURFACE_FOOTPRINT_EPSILON;
      if (dx * dx + dy * dy > radius * radius) continue;

      const groundPointNearTop = groundPointZ <= topZ + SUPPORT_SURFACE_CONTACT_EPSILON;
      const sphereBottomNearTop = sphereBottomZ <= topZ + SUPPORT_SURFACE_CONTACT_EPSILON;
      if (!groundPointNearTop && !sphereBottomNearTop) continue;

      if (best === null || topZ > best.groundZ) {
        const candidate = createWorldSupportSurface() as DynamicSupportSurfaceContact;
        candidate.dynamicBody = supportBody;
        best = writeUnitSupportSurface(
          candidate,
          topZ,
          supportBody.entityId ?? null,
          supportBody.entityId ?? supportBody.slot,
          { x: supportBody.vx, y: supportBody.vy, z: supportBody.vz },
        ) as DynamicSupportSurfaceContact;
        best.dynamicBody = supportBody;
      }
    }

    return best;
  }

  private findSupportSurface(
    body: Body3D,
    terrainGroundZ: number,
  ): WorldSupportSurface | null {
    const staticSupport = this.findStaticSupportSurface(body, terrainGroundZ);
    const dynamicSupport = this.findDynamicSupportSurface(body, terrainGroundZ);
    if (staticSupport === null) return dynamicSupport;
    if (dynamicSupport === null) return staticSupport;
    return dynamicSupport.groundZ > staticSupport.groundZ ? dynamicSupport : staticSupport;
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
   *  slot list + one batched terrain sample call + a sleep-
   *  transition output buffer; no per-body Body3D field marshal
   *  and no per-body terrain boundary crossing.
   *
   *  Dynamic bodies are required to be spheres; addBody() throws for any
   *  unsupported dynamic shape so integration cannot silently split back
   *  into a TypeScript fallback path. */
  private integrate(dtSec: number, count: number): void {
    const airDamp = getUnitAirFrictionDamp(dtSec);
    const groundDamp = getUnitGroundFrictionDamp(dtSec);
    // Pool readiness was enforced in the constructor, so getSimWasm
    // is guaranteed defined here. Cast through `!` to keep the
    // call sites tight without re-checking.
    const sim = getSimWasm()!;
    // Slice the typed arrays down to `count` so the kernel's
    // debug_assert on length matches; the underlying buffer is
    // shared so this is zero-copy.
    const slotsView = _integrateAwakeSlots.subarray(0, count);
    const groundZView = _integrateGroundZ.subarray(0, count);
    const groundNormalsView = _integrateGroundNormals.subarray(0, count * 3);
    const transitionsView = _integrateSleepTransitions.subarray(0, count);
    const groundSampled =
      sim.terrainSampleGroundForSlots(
        slotsView,
        groundZView,
        groundNormalsView,
      ) !== 0;
    if (!groundSampled) {
      this.sampleIntegrationGroundFallback(count);
    }
    this.sampleIntegrationSupportSurfaces(count);
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
    this.refreshStepSupportIgnoredStaticSlots(count);
  }

  /** Phase 3f sphere-vs-cuboid contact resolver. The static
   *  broadphase lives in the WASM-side EngineStatics; one Rust call
   *  walks every dyn sphere's overlapping cells, dedups via the
   *  per-static visit-stamp counter, and runs the resolver in
   *  place. JS only marshals the dyn slot list, the parallel
   *  ignored-static-slot lookup, and a wake-transition output. */
  private resolveSphereCuboidContacts(stepSlots: Uint32Array): void {
    const sim = getSimWasm()!;
    const maxCount = stepSlots.length;
    if (maxCount === 0) return;
    this.clearExitedStaticIgnores();
    if (_sphereCuboidIgnoredStatics.length < maxCount) {
      _sphereCuboidIgnoredStatics = new Uint32Array(maxCount);
      _sphereCuboidWakeTransitions = new Uint32Array(maxCount);
    }
    if (this.ignoreStatic.size === 0) {
      if (this.stepSupportIgnoredStaticSlots.size === 0) {
        _sphereCuboidIgnoredStatics.fill(NO_IGNORE_SLOT, 0, maxCount);
      } else {
        for (let i = 0; i < maxCount; i++) {
          _sphereCuboidIgnoredStatics[i] =
            this.stepSupportIgnoredStaticSlots.get(stepSlots[i]) ?? NO_IGNORE_SLOT;
        }
      }
    } else {
      for (let i = 0; i < maxCount; i++) {
        const dyn = this.bodyBySlot[stepSlots[i]];
        const ignored = dyn === undefined ? undefined : this.ignoreStatic.get(dyn);
        _sphereCuboidIgnoredStatics[i] = ignored !== undefined
          ? ignored.slot
          : this.stepSupportIgnoredStaticSlots.get(stepSlots[i]) ?? NO_IGNORE_SLOT;
      }
    }
    const ignoredView = _sphereCuboidIgnoredStatics.subarray(0, maxCount);
    const wakeView = _sphereCuboidWakeTransitions.subarray(0, maxCount);
    const wakeCount = sim.poolResolveSphereCuboidFull(
      this.staticsHandle,
      stepSlots,
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
  private resolveSphereSphereContacts(iterations: number, dynamicSlots: Uint32Array): void {
    const sim = getSimWasm()!;
    const maxCount = dynamicSlots.length;
    if (maxCount === 0 || iterations <= 0) return;
    if (_sphereSphereWakeTransitions.length < maxCount) {
      _sphereSphereWakeTransitions = new Uint32Array(maxCount);
    }
    const wakeView = _sphereSphereWakeTransitions.subarray(0, maxCount);
    const wakeCount = sim.poolResolveSphereSphere(
      dynamicSlots,
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

}
