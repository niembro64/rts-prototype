// rts-sim-wasm init — singleton loader.
//
// This module is the ONLY place either the server tick or the
// client prediction stepper should obtain the WASM handle from.
// Both await `initSimWasm()`; concurrent awaiters share one fetch
// + compile via the module-scope Promise cache below.
//
// The WASM artifacts under `./pkg/` are produced by
// `npm run build:wasm` (which calls `wasm-pack build --release
// --target web --out-dir ../src/game/sim-wasm/pkg` from the
// `rts-sim-wasm/` crate at the repo root). They are gitignored —
// `npm run build` runs the wasm build first; `npm run dev`
// reuses whatever pkg/ already contains, so run `build:wasm`
// once after a fresh clone and re-run after any Rust edit.

import __wbg_init, {
  version,
  step_unit_motion,
  pool_init,
  pool_capacity,
  pool_alloc_slot,
  pool_free_slot,
  pool_step_integrate,
  pool_resolve_sphere_sphere,
  engine_statics_create,
  engine_statics_destroy,
  engine_statics_add,
  engine_statics_remove,
  pool_resolve_sphere_cuboid_full,
  quat_hover_orientation_step_batch,
  projectile_pool_init,
  projectile_pool_capacity,
  projectile_pool_pos_x_ptr,
  projectile_pool_pos_y_ptr,
  projectile_pool_pos_z_ptr,
  projectile_pool_vel_x_ptr,
  projectile_pool_vel_y_ptr,
  projectile_pool_vel_z_ptr,
  projectile_pool_time_alive_ptr,
  projectile_pool_has_gravity_ptr,
  pool_step_packed_projectiles_batch,
  solve_kinematic_intercept,
  apply_homing_steering,
  integrate_damped_rotation,
  terrain_install_mesh,
  terrain_clear,
  terrain_is_installed,
  terrain_get_surface_height,
  terrain_get_surface_normal,
  terrain_has_line_of_sight,
  spatial_init,
  spatial_clear,
  spatial_alloc_slot,
  spatial_free_slot,
  spatial_set_unit,
  spatial_set_projectile,
  spatial_set_building,
  spatial_sync_building_capture_for_slot,
  spatial_unset_slot,
  spatial_query_units_in_radius,
  spatial_query_buildings_in_radius,
  spatial_query_units_and_buildings_in_radius,
  spatial_query_units_and_buildings_in_rect_2d,
  spatial_query_enemy_entities_in_radius,
  spatial_query_enemy_entities_in_circle_2d,
  spatial_query_units_along_line,
  spatial_query_buildings_along_line,
  spatial_query_entities_along_line,
  spatial_query_enemy_units_in_radius,
  spatial_query_enemy_projectiles_in_radius,
  spatial_query_enemy_units_and_projectiles_in_radius,
  spatial_query_occupied_cells_for_capture,
  spatial_query_occupied_cells_debug,
  spatial_scratch_ptr,
  spatial_scratch_len,
  spatial_slot_kind,
  pathfinder_init,
  pathfinder_rebuild_mask_and_cc,
  pathfinder_find_path,
  pathfinder_waypoints_ptr,
  pathfinder_grid_size_w,
  pathfinder_grid_size_h,
  messagepack_self_test,
  entity_meta_init,
  entity_meta_clear,
  entity_meta_set_unit,
  entity_meta_set_building,
  entity_meta_unset,
  entity_meta_type,
  entity_meta_type_ptr,
  entity_meta_player_id_ptr,
  entity_meta_hp_curr_ptr,
  entity_meta_hp_max_ptr,
  entity_meta_combat_mode_ptr,
  entity_meta_is_commander_ptr,
  entity_meta_build_complete_ptr,
  entity_meta_build_paid_energy_ptr,
  entity_meta_build_paid_mana_ptr,
  entity_meta_build_paid_metal_ptr,
  entity_meta_build_target_id_ptr,
  entity_meta_suspension_spring_offset_ptr,
  entity_meta_suspension_spring_velocity_ptr,
  entity_meta_jump_airborne_ptr,
  entity_meta_jump_timer_ptr,
  entity_meta_factory_is_producing_ptr,
  entity_meta_factory_build_queue_len_ptr,
  entity_meta_factory_progress_ptr,
  entity_meta_solar_open_ptr,
  entity_meta_build_progress_ptr,
  entity_meta_capacity,
  turret_pool_init,
  turret_pool_clear,
  turret_pool_max_per_entity,
  turret_pool_set_count,
  turret_pool_set_turret,
  turret_pool_unset_entity,
  turret_pool_count,
  turret_pool_entity_capacity,
  turret_pool_count_per_entity_ptr,
  turret_pool_rotation_ptr,
  turret_pool_angular_velocity_ptr,
  turret_pool_angular_acceleration_ptr,
  turret_pool_pitch_ptr,
  turret_pool_pitch_velocity_ptr,
  turret_pool_pitch_acceleration_ptr,
  turret_pool_force_field_range_ptr,
  turret_pool_target_id_ptr,
  pool_pos_x_ptr,
  pool_pos_y_ptr,
  pool_pos_z_ptr,
  pool_vel_x_ptr,
  pool_vel_y_ptr,
  pool_vel_z_ptr,
  pool_accel_x_ptr,
  pool_accel_y_ptr,
  pool_accel_z_ptr,
  pool_launch_x_ptr,
  pool_launch_y_ptr,
  pool_launch_z_ptr,
  pool_radius_ptr,
  pool_half_x_ptr,
  pool_half_y_ptr,
  pool_half_z_ptr,
  pool_inv_mass_ptr,
  pool_restitution_ptr,
  pool_ground_offset_ptr,
  pool_sleep_ticks_ptr,
  pool_flags_ptr,
} from './pkg/rts_sim_wasm';


/** Public handle to the loaded WASM module. Re-exported kernels
 *  + the Body3D pool views + per-engine static-cuboid handles all
 *  hang off this. */
export interface SimWasm {
  /** Build-stamp from the Rust crate (CARGO_PKG_VERSION).
   *  Useful in dev / startup logs to confirm a fresh wasm-pack
   *  build is being served. */
  readonly version: string;
  /** Shared unit-body integrator (Phase 2). Used by both
   *  PhysicsEngine3D.integrate (server authoritative tick) AND
   *  ClientUnitPrediction.advanceSharedUnitMotionPrediction
   *  (client visual prediction). Same kernel → bit-identical
   *  motion → client prediction stops drifting from the server.
   *
   *  `motion` is a Float64Array of length 6: [x, y, z, vx, vy, vz]
   *  read AND written in place. Caller pre-samples ground state
   *  (groundZ, normal[X/Y/Z]) so the kernel never re-enters JS
   *  during a step. The normal is only consulted when penetration
   *  is in contact, so passing zero/up for the normal is safe
   *  when the caller knows the body is airborne. */
  readonly stepUnitMotion: (
    motion: Float64Array,
    dtSec: number,
    groundOffset: number,
    ax: number,
    ay: number,
    az: number,
    airDamp: number,
    groundDamp: number,
    launchAx: number,
    launchAy: number,
    launchAz: number,
    groundZ: number,
    normalX: number,
    normalY: number,
    normalZ: number,
  ) => void;
  /** Body3D SoA pool — Phase 3d. Linear-memory-backed storage
   *  for every numeric body field. Slots are stable for a body's
   *  lifetime; `allocSlot()` returns the next free slot, `freeSlot`
   *  returns it. The view properties expose Float64Array /
   *  Uint8Array views over the pool's underlying storage so JS
   *  can read/write any body's field in O(1) without crossing
   *  the WASM boundary per access. Pool is initialized
   *  automatically at WASM load (one-time call to pool_init). */
  readonly pool: BodyPoolViews;
  /** Pool-backed integrate kernel — Phase 3d-2. Runs the per-tick
   *  integrate loop over every awake dynamic sphere by SLOT INDEX,
   *  reading body state directly from the pool. The Float64Array
   *  for body state is no longer marshalled per call; only the
   *  slot index list, pre-sampled ground state (terrain sampler
   *  is still JS-side until Phase 8), and a sleep-transitions
   *  output buffer cross the boundary. Returns the count of
   *  bodies that just slept this call (slot ids are written into
   *  sleep_transitions_out[0..return_value]). */
  readonly poolStepIntegrate: (
    awakeSlots: Uint32Array,
    groundZ: Float64Array,
    groundNormals: Float64Array,
    sleepTransitionsOut: Uint32Array,
    dtSec: number,
    airDamp: number,
    groundDamp: number,
  ) => number;
  /** Pool-backed sphere-sphere resolver — Phase 3d-2. Iterates
   *  the broadphase + N sub-passes over body slots. State read /
   *  written via the pool; only the slot list, scalar params,
   *  and a wake-transitions output buffer cross the boundary.
   *  Upward-contact flag is set on the pool flags byte directly.
   *  Returns the count of bodies that need wake bookkeeping
   *  (slot ids are written into wake_transitions_out[0..return_value]). */
  readonly poolResolveSphereSphere: (
    sphereSlots: Uint32Array,
    iterations: number,
    cellSize: number,
    wakeTransitionsOut: Uint32Array,
  ) => number;
  /** Phase 3f — per-engine static-cuboid broadphase. Each
   *  PhysicsEngine3D constructs its own handle at startup so the
   *  foreground game and the LobbyManager background battle's
   *  static cells stay isolated even though they share the global
   *  BodyPool. */
  readonly engineStaticsCreate: () => number;
  /** Release a handle previously returned by `engineStaticsCreate`.
   *  Drops the per-engine cell HashMap + visit-stamp vec so the
   *  memory comes back to Rust's allocator, and returns the slot
   *  to a free list for the next create() to recycle. Call from
   *  PhysicsEngine3D teardown (GameServer.stop -> dispose).
   *  Using the handle afterwards panics — the caller must drop
   *  every reference to it before destroy is invoked. */
  readonly engineStaticsDestroy: (handle: number) => void;
  /** Insert a cuboid (by pool slot) into this engine's static
   *  broadphase. Reads pos + half-extents from the pool, walks
   *  every overlapping cell, and pushes the slot id onto each
   *  cell's bucket. Idempotent only in the sense that a removed
   *  slot can be re-added — calling add twice for the same slot
   *  WILL produce duplicates in the cell buckets. */
  readonly engineStaticsAdd: (handle: number, slot: number, cellSize: number) => void;
  /** Remove a cuboid from this engine's static broadphase, using
   *  the same pos + half-extent walk as `engineStaticsAdd`. The
   *  caller must invoke this BEFORE freeing the pool slot or
   *  changing the cuboid's geometry, otherwise the broadphase
   *  state diverges from the pool. */
  readonly engineStaticsRemove: (handle: number, slot: number, cellSize: number) => void;
  /** Phase 3f unified sphere-vs-cuboid kernel. JS passes:
   *    - dynSlots: the dyn sphere slot ids to test (typically every
   *      `shouldProcessBodyThisStep` sphere this tick)
   *    - ignoredStaticSlots: parallel u32 array, value u32::MAX
   *      (= 0xFFFFFFFF) meaning "no ignore" for that dyn; otherwise
   *      the static slot id to skip (one-per-dyn ignore matches
   *      the JS Map<dyn,static> semantics from `setIgnoreStatic`).
   *    - cellSize: PhysicsEngine3D's CONTACT_CELL_SIZE.
   *    - wakeTransitionsOut: written with the slot ids of dyn
   *      bodies that resolved at least one pair (one entry per
   *      dyn that hit any cuboid).
   *  Returns the count of wake transitions written. */
  readonly poolResolveSphereCuboidFull: (
    handle: number,
    dynSlots: Uint32Array,
    ignoredStaticSlots: Uint32Array,
    cellSize: number,
    wakeTransitionsOut: Uint32Array,
  ) => number;
  /** Phase 4 + 3e — batched hover orientation kernel. UnitForceSystem
   *  builds a per-tick scratch with one entry per hover entity:
   *  orientation (in/out), omega (in/out), target yaw/pitch/roll
   *  (in), then the kernel writes alpha (out) and the extracted yaw
   *  of the new orientation (out). Per entity stride =
   *  QUAT_HOVER_BATCH_STRIDE f64s. JS scatters back to
   *  entity.unit.orientation / .angularVelocity3 / .angularAcceleration3
   *  and entity.transform.rotation in a post-call pass. */
  readonly quatHoverOrientationStepBatch: (
    buf: Float64Array,
    count: number,
    k: number,
    c: number,
    dtSec: number,
  ) => void;
  /** Phase 5a — Packed projectile SoA pool. Same lifetime / view
   *  semantics as `pool` (BodyPool): fixed capacity, views captured
   *  once, refresh on memory.grow via `refreshViews`. JS-side slot
   *  management (swap-remove on unregister) writes through these
   *  views directly; per-tick ballistic integrate runs in
   *  `poolStepPackedProjectilesBatch`. */
  readonly projectilePool: ProjectilePoolViews;
  /** Per-tick ballistic integrator for slots 0..count of the
   *  projectile pool. Applies gravity (gated on `hasGravity[i]`)
   *  and integrates position. Same math as the inner loop in
   *  projectileSystem._updatePackedProjectilesJS but runs entirely
   *  in WASM with no per-projectile boundary call. */
  readonly poolStepPackedProjectilesBatch: (count: number, dtSec: number) => void;
  /** Phase 5b — kinematic intercept solver. Per-call (not batched —
   *  call sites are scattered across server/client/render code).
   *
   *  `input` is a Float64Array of 22 elements:
   *    0..3   origin.position             (x, y, z)
   *    3..6   origin.velocity
   *    6..9   origin.acceleration
   *    9..12  target.position
   *    12..15 target.velocity
   *    15..18 target.acceleration
   *    18..21 projectile_acceleration
   *    21     projectile_speed
   *  `out` is a Float64Array of 7 elements:
   *    0      time
   *    1..4   aim_point
   *    4..7   launch_velocity
   *  `preferLateSolution` is 1 to keep scanning past the first root,
   *  0 to take the earliest. `maxTimeSecOrZero` overrides the auto
   *  search horizon when nonzero (clamped to [1/120, 30]).
   *  Returns 1 if a solution was written, 0 otherwise. */
  readonly solveKinematicIntercept: (
    input: Float64Array,
    out: Float64Array,
    preferLateSolution: number,
    maxTimeSecOrZero: number,
  ) => number;
  /** Phase 5c — homing steering Rodrigues rotation. Per-call (call
   *  sites loop per-projectile already). Writes (velX, velY, velZ,
   *  rotation) into out[0..4]. Speed is preserved; rotation is the
   *  yaw of the new horizontal velocity (matches the JS impl's
   *  return shape). */
  readonly applyHomingSteering: (
    out: Float64Array,
    velX: number, velY: number, velZ: number,
    targetX: number, targetY: number, targetZ: number,
    currentX: number, currentY: number, currentZ: number,
    homingTurnRate: number,
    dtSec: number,
  ) => void;
  /** Phase 6a — damped-spring single-axis rotation integrator. Per-
   *  call (call sites already loop per-turret-axis). `flags` packs
   *  the options object: bit 0 = wrap, bit 1 = has_min, bit 2 = has_max.
   *  Writes (newAngle, newAngularVel, angularAcc) into out[0..3]. */
  readonly integrateDampedRotation: (
    out: Float64Array,
    angle: number,
    angularVel: number,
    targetAngle: number,
    k: number,
    c: number,
    dtSec: number,
    flags: number,
    minAngle: number,
    maxAngle: number,
  ) => void;
  /** Phase 8 — terrain heightmap installed in WASM linear memory.
   *  Called once at world-load (or any time setAuthoritativeTerrainTileMap
   *  receives a new map) from the JS-side terrain state. Arrays are
   *  copied into Rust-side Vecs; further mutation on the JS side has
   *  no effect on the installed mesh. */
  readonly terrainInstallMesh: (
    vertexCoords: Float64Array,
    vertexHeights: Float64Array,
    triangleIndices: Int32Array,
    triangleLevels: Int32Array,
    neighborIndices: Int32Array,
    neighborLevels: Int32Array,
    cellTriangleOffsets: Int32Array,
    cellTriangleIndices: Int32Array,
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    subdiv: number,
    cellsX: number,
    cellsY: number,
  ) => void;
  /** Drop the installed mesh — Vecs come back to Rust's allocator
   *  and `terrainIsInstalled` returns 0. Sampling falls back to the
   *  TS path until the next install. */
  readonly terrainClear: () => void;
  /** 1 if a mesh is currently installed, 0 otherwise. */
  readonly terrainIsInstalled: () => number;
  /** Sample terrain surface height at world-space (x, z). Returns
   *  NaN if no mesh is installed or the triangle walk degenerates;
   *  JS callers treat NaN as "fall back to TS sampler" since that
   *  handles the bilinear-quad-over-noise path. The mesh-installed
   *  return is max(WATER_LEVEL, triangle_height). */
  readonly terrainGetSurfaceHeight: (x: number, z: number) => number;
  /** Sample terrain surface normal at world-space (x, z). Writes
   *  (nx, ny, nz) into out[0..3] and returns 1 on success, 0 if no
   *  mesh is installed or the triangle walk fails. Below-water
   *  samples return (0, 0, 1) — flat water surface normal. */
  readonly terrainGetSurfaceNormal: (x: number, z: number, out: Float64Array) => number;
  /** Phase 6c — segment-vs-terrain line-of-sight test. Returns:
   *    0 = ground blocks the ray
   *    1 = segment clears terrain end to end
   *    2 = no mesh installed → caller falls back to TS path
   *  Same step-walk algorithm as hasTerrainLineOfSight in
   *  lineOfSight.ts. Replaces N JS↔WASM groundZ samples with a
   *  single WASM call (saves boundary cost on long LOS rays). */
  readonly terrainHasLineOfSight: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    stepLen: number,
  ) => number;
  /** Phase 7 — SpatialGrid 3D voxel hash in WASM linear memory.
   *  Big-bang replacement for SpatialGrid.ts. Same public API on
   *  the JS wrapper; per-query traffic is one WASM call + one
   *  Uint32Array view over the scratch buffer. EntityId↔slot map
   *  is JS-side; Rust only sees u32 slot ids. */
  readonly spatial: SpatialApi;
  /** Phase 9 — Pathfinder A* over the build/walk grid. Mask + CC +
   *  A* + LOS smoothing all in one WASM call. */
  readonly pathfinder: PathfinderApi;
  /** Phase 10 D.1 — Entity-meta SoA pool. Foundation for future
   *  D.3 quantize/delta-encode kernel; JS-side population lands in
   *  D.3 when there's a consumer. */
  readonly entityMeta: EntityMetaApi;
  /** Phase 10 D.1b — Turret sub-pool. Per-entity turret arrays
   *  indexed at fixed offsets. JS-side population lands with D.3
   *  alongside the entity-meta capture pass. */
  readonly turretPool: TurretPoolApi;
  /** The WASM linear memory — JS wrapper code constructs typed-array
   *  views over this for zero-copy result reads. Re-bind views after
   *  any operation that might grow the memory (rare). */
  readonly memory: WebAssembly.Memory;
}

/** Constants exposed alongside the SpatialGrid API. Mirrors the
 *  SPATIAL_KIND_* values in rts-sim-wasm/src/lib.rs. */
export const SPATIAL_KIND_UNSET = 0;
export const SPATIAL_KIND_UNIT = 1;
export const SPATIAL_KIND_BUILDING = 2;
export const SPATIAL_KIND_PROJECTILE = 3;

/** Public surface of the WASM-backed spatial grid. Each query returns
 *  a count; the result slot ids land in the shared scratch buffer
 *  accessed via `scratchPtr()` and `scratchLen()`. JS-side wrappers
 *  build a `Uint32Array(memory.buffer, scratchPtr(), count)` view
 *  per call. The view is invalidated by the NEXT call (the scratch
 *  Vec is re-written), so consume results synchronously. */
export interface SpatialApi {
  /** Initialize the grid. Must be called once before any other
   *  spatial.* method. Cell size matches the JS LAND_CELL_SIZE
   *  constant. `initialSlotCapacity` is a hint — pools grow on
   *  demand if exceeded. */
  init: (cellSize: number, initialSlotCapacity: number) => void;
  /** Drop all cells, capture votes, and slot kind tags. Slot
   *  storage is retained (free list reset). */
  clear: () => void;
  /** Allocate a new slot or pop one off the free list. Returns the
   *  slot id; the JS-side wrapper stores `Map<EntityId, slot>`. */
  allocSlot: () => number;
  /** Return a slot to the free list. Unsets bucket membership. */
  freeSlot: (slot: number) => void;
  /** Insert or update a unit at slot. owner_player=0 means "no owner".
   *  hp_alive=0 unsets the slot from the grid (matches updateUnit's
   *  dead-unit fast path). radius_push is currently unused by queries
   *  but kept in the per-slot SoA for future use. */
  setUnit: (
    slot: number,
    x: number, y: number, z: number,
    radiusPush: number, radiusShot: number,
    ownerPlayer: number,
    hpAlive: number,
  ) => void;
  /** Insert or update a projectile at slot. isProjectileType=1 if
   *  proj.projectileType === 'projectile' (the only kind queries
   *  return via queryEnemyProjectilesInRadius). */
  setProjectile: (
    slot: number,
    x: number, y: number, z: number,
    ownerPlayer: number,
    isProjectileType: number,
  ) => void;
  /** Insert / re-insert a building at slot. The grid buckets the
   *  building into every cell its (hx, hy, hz) half-extents touch.
   *  Capture votes resync — pass entity_active=0 to suppress votes
   *  without unbucketing the slot. */
  setBuilding: (
    slot: number,
    x: number, y: number, z: number,
    hx: number, hy: number, hz: number,
    ownerPlayer: number,
    hpAlive: number,
    entityActive: number,
  ) => void;
  /** Re-sync the building's capture votes after isEntityActive flips
   *  (e.g. construction completion). Cell membership is unchanged. */
  syncBuildingCaptureForSlot: (slot: number) => void;
  /** Drop the slot from any cell bucket + capture vote it currently
   *  holds. Marks the slot kind as UNSET so future queries skip it. */
  unsetSlot: (slot: number) => void;

  // ---------- Queries (return slot-id counts) ----------

  /** Units in a 3D sphere. exclude_player=0 disables the filter. */
  queryUnitsInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
    requireAlive: number,
  ) => number;
  /** Buildings whose AABB closest-point ≤ r from (x, y, z). */
  queryBuildingsInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
    requireAlive: number,
  ) => number;
  /** Combined: writes [nUnits, nBuildings, unit_slots..., building_slots...]. */
  queryUnitsAndBuildingsInRadius: (
    x: number, y: number, z: number, r: number,
  ) => number;
  /** 2D rect AoI: [nUnits, nBuildings, unit_slots..., building_slots...]. */
  queryUnitsAndBuildingsInRect2D: (
    minX: number, maxX: number, minY: number, maxY: number,
  ) => number;
  /** Enemy units + buildings in a 3D sphere. shotRadius padding +
   *  hp>0 + AABB filter. Output: [nUnits, nBuildings, ...]. */
  queryEnemyEntitiesInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
  ) => number;
  /** Enemy units + buildings in a 2D ground-plane circle. */
  queryEnemyEntitiesInCircle2D: (
    x: number, y: number, r: number,
    excludePlayer: number,
    zMin: number, zMax: number,
  ) => number;
  /** Units whose cell overlaps the line's swept AABB (line + lineWidth). */
  queryUnitsAlongLine: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    lineWidth: number,
  ) => number;
  /** Buildings whose cell overlaps the line's swept AABB. */
  queryBuildingsAlongLine: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    lineWidth: number,
  ) => number;
  /** Combined: [nUnits, nBuildings, unit_slots..., building_slots...]. */
  queryEntitiesAlongLine: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    lineWidth: number,
  ) => number;
  /** Enemy units in a 3D sphere (no shot-radius pad, no alive filter). */
  queryEnemyUnitsInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
  ) => number;
  /** Enemy projectiles in a 3D sphere (only `proj.projectileType==='projectile'`). */
  queryEnemyProjectilesInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
  ) => number;
  /** Combined: [nUnits, nProjectiles, unit_slots..., projectile_slots...]. */
  queryEnemyUnitsAndProjectilesInRadius: (
    x: number, y: number, z: number, r: number,
    excludePlayer: number,
  ) => number;
  /** Capture-vote summary. Output: [nCells, per cell: (landKey: i32,
   *  nPlayers, p0, p1, ...)]. PlayerIds are u8. */
  queryOccupiedCellsForCapture: () => number;
  /** Debug: per-cell unique-player listing. Output: [nCells, per
   *  cell: (cx: i32, cy: i32, cz: i32, nPlayers, p0, p1, ...)]. */
  queryOccupiedCellsDebug: () => number;

  // ---------- Scratch buffer access ----------

  /** Raw pointer to the start of the scratch_u32 Vec. Build a fresh
   *  Uint32Array(memory.buffer, ptr, count) view per query and
   *  consume immediately — the Vec relocates on growth. */
  scratchPtr: () => number;
  /** Current scratch buffer length (== last query's return value). */
  scratchLen: () => number;
  /** Read a slot's kind tag. Useful when consuming combined query
   *  results that intermix units / buildings / projectiles. */
  slotKind: (slot: number) => number;
}

/** Phase 10 D.1 — Entity-meta SoA pool. Per-entity scalar fields
 *  the snapshot serializer reads (HP, build state, combat mode,
 *  suspension, jump, factory/solar booleans). Slot space is shared
 *  with SpatialGrid — JS calls `setUnit(slot, ...)` /
 *  `setBuilding(slot, ...)` once per dirty entity per snapshot
 *  tick. Position / velocity / orientation continue to live in
 *  BodyPool (Phase 3d). Variable-length arrays (turrets, actions)
 *  will land in a follow-up sub-pool. */
export interface EntityMetaApi {
  init: (initialCapacity: number) => void;
  clear: () => void;
  setUnit: (
    slot: number,
    playerId: number,
    hpCurr: number, hpMax: number,
    combatMode: number,
    isCommander: number,
    buildComplete: number,
    buildPaidEnergy: number, buildPaidMana: number, buildPaidMetal: number,
    buildTargetId: number,
    suspensionSpringOffset: number, suspensionSpringVelocity: number,
    jumpAirborne: number, jumpTimer: number,
  ) => void;
  setBuilding: (
    slot: number,
    playerId: number,
    hpCurr: number, hpMax: number,
    factoryIsProducing: number, factoryBuildQueueLen: number, factoryProgress: number,
    solarOpen: number,
    buildProgress: number,
  ) => void;
  unset: (slot: number) => void;
  /** Returns 0 (unset) / 1 (unit) / 2 (building) for the slot. */
  type: (slot: number) => number;
  /** Current per-slot SoA capacity (auto-grows on set*). */
  capacity: () => number;
  /** Per-field raw pointers — JS builds typed-array views once and
   *  re-builds them if `memory.grow` ever detaches them. Same
   *  pattern as BodyPool / ProjectilePool. */
  readonly typePtr: () => number;
  readonly playerIdPtr: () => number;
  readonly hpCurrPtr: () => number;
  readonly hpMaxPtr: () => number;
  readonly combatModePtr: () => number;
  readonly isCommanderPtr: () => number;
  readonly buildCompletePtr: () => number;
  readonly buildPaidEnergyPtr: () => number;
  readonly buildPaidManaPtr: () => number;
  readonly buildPaidMetalPtr: () => number;
  readonly buildTargetIdPtr: () => number;
  readonly suspensionSpringOffsetPtr: () => number;
  readonly suspensionSpringVelocityPtr: () => number;
  readonly jumpAirbornePtr: () => number;
  readonly jumpTimerPtr: () => number;
  readonly factoryIsProducingPtr: () => number;
  readonly factoryBuildQueueLenPtr: () => number;
  readonly factoryProgressPtr: () => number;
  readonly solarOpenPtr: () => number;
  readonly buildProgressPtr: () => number;
}

/** Entity-meta type tag values (mirrors lib.rs ENTITY_META_TYPE_*). */
export const ENTITY_META_TYPE_UNSET = 0;
export const ENTITY_META_TYPE_UNIT = 1;
export const ENTITY_META_TYPE_BUILDING = 2;

/** Phase 10 D.1b — Turret sub-pool. Up to 8 turrets per entity at
 *  fixed offset `entity_slot * MAX + turret_idx` in a flat SoA.
 *  Per-entity count gates which indices are live. Used by the
 *  future D.3 quantize/delta-encode kernel when serializing the
 *  turrets array in a unit snapshot DTO. */
export interface TurretPoolApi {
  init: (initialEntityCapacity: number) => void;
  clear: () => void;
  /** Max turret count per entity (mirrors TURRET_POOL_MAX_PER_ENTITY = 8). */
  maxPerEntity: () => number;
  setCount: (entitySlot: number, count: number) => void;
  setTurret: (
    entitySlot: number,
    turretIdx: number,
    rotation: number,
    angularVelocity: number,
    angularAcceleration: number,
    pitch: number,
    pitchVelocity: number,
    pitchAcceleration: number,
    forceFieldRange: number,
    targetId: number,
  ) => void;
  unsetEntity: (entitySlot: number) => void;
  count: (entitySlot: number) => number;
  entityCapacity: () => number;
  readonly countPerEntityPtr: () => number;
  readonly rotationPtr: () => number;
  readonly angularVelocityPtr: () => number;
  readonly angularAccelerationPtr: () => number;
  readonly pitchPtr: () => number;
  readonly pitchVelocityPtr: () => number;
  readonly pitchAccelerationPtr: () => number;
  readonly forceFieldRangePtr: () => number;
  readonly targetIdPtr: () => number;
}

/** Phase 9 — Pathfinder. Mirror of Pathfinder.ts findPath. Full
 *  pipeline (mask + CC + A* + LOS smoothing) runs inside a single
 *  WASM call. Caller passes the building-occupied cells list per
 *  rebuild; the Rust side caches mask + CC by version pair. */
export interface PathfinderApi {
  /** Allocate the per-cell SoA arrays for the given map dimensions.
   *  Idempotent if map size is unchanged. Recomputes cell counts as
   *  `ceil(mapW/20), ceil(mapH/20)`. */
  init: (mapWidth: number, mapHeight: number) => void;
  /** Rebuild blocked mask + CC labels from `buildingCells` (flat
   *  Uint32Array of interleaved gx, gy pairs). The terrain mask is
   *  cached by `terrainVersion`; full mask + CC by both versions —
   *  no-op when nothing has changed. */
  rebuildMaskAndCc: (
    buildingCells: Uint32Array,
    terrainVersion: number,
    buildingVersion: number,
  ) => void;
  /** Run findPath. Writes smoothed waypoints into the WASM-side
   *  scratch buffer as interleaved (x, y) f64 pairs; returns the
   *  waypoint COUNT (not the f64 element count). */
  findPath: (
    startX: number, startY: number,
    goalX: number, goalY: number,
    minNormalZ: number,
  ) => number;
  /** Raw pointer to the waypoint scratch buffer. Build a fresh
   *  Float64Array(memory.buffer, ptr, count * 2) view per call. */
  waypointsPtr: () => number;
  /** Current grid dimensions (refreshed by init). */
  gridWidth: () => number;
  gridHeight: () => number;
}

/** Bit flags for `integrateDampedRotation`. Mirrors the
 *  DAMPED_ROTATION_FLAG_* constants in rts-sim-wasm/src/lib.rs. */
export const DAMPED_ROTATION_FLAG_WRAP = 1 << 0;
export const DAMPED_ROTATION_FLAG_HAS_MIN = 1 << 1;
export const DAMPED_ROTATION_FLAG_HAS_MAX = 1 << 2;

/** Views over the projectile SoA pool. Indexed by slot id (0..count
 *  where count is JS-managed in projectileSystem.ts). All views
 *  share the same WASM linear memory and detach together if memory
 *  grows — `refreshViews` rebuilds them. */
export interface ProjectilePoolViews {
  readonly capacity: number;
  refreshViews: () => void;
  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  velZ: Float64Array;
  timeAlive: Float64Array;
  hasGravity: Uint8Array;
}

/** Layout stride for `quatHoverOrientationStepBatch`. Mirrors
 *  QUAT_HOVER_BATCH_STRIDE in rts-sim-wasm/src/lib.rs. */
export const QUAT_HOVER_BATCH_STRIDE = 14;

/** Bit flags packed into BodyPoolViews.flags[slot]. Mirrors the
 *  BODY_FLAG_* constants in rts-sim-wasm/src/lib.rs. */
export const BODY_FLAG_SLEEPING = 1 << 0;
export const BODY_FLAG_IS_STATIC = 1 << 1;
export const BODY_FLAG_UPWARD_CONTACT = 1 << 2;
export const BODY_FLAG_SHAPE_CUBOID = 1 << 3;
export const BODY_FLAG_OCCUPIED = 1 << 4;

/** Typed-array views over the WASM-side BodyPool. All views are
 *  indexed by slot id (returned by allocSlot()). Capacity is
 *  fixed at pool_init() so views never need to be refreshed
 *  unless the WASM linear memory itself grows underneath us;
 *  call `refreshViews()` after any operation that might trigger
 *  memory growth (rare under our usage pattern). */
export interface BodyPoolViews {
  readonly capacity: number;
  /** Allocate the next free slot; throws if pool is exhausted. */
  allocSlot: () => number;
  /** Return a slot to the free list. Caller must clear any
   *  pool-managed fields the slot held to sensible defaults if
   *  it's reused later (alloc_slot zeros all fields, so explicit
   *  cleanup isn't required for correctness — just for clarity). */
  freeSlot: (slot: number) => void;
  /** Re-construct all views over the WASM linear memory. Call after
   *  any operation that may have grown WASM memory and detached
   *  existing views. In practice the fixed-capacity pool means
   *  growth is very rare — call defensively at the start of each
   *  tick if you're paranoid, or rely on the views' detachment
   *  check (`view.byteLength === 0`) to detect stale views. */
  refreshViews: () => void;

  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  velZ: Float64Array;
  accelX: Float64Array;
  accelY: Float64Array;
  accelZ: Float64Array;
  launchX: Float64Array;
  launchY: Float64Array;
  launchZ: Float64Array;
  radius: Float64Array;
  halfX: Float64Array;
  halfY: Float64Array;
  halfZ: Float64Array;
  invMass: Float64Array;
  restitution: Float64Array;
  groundOffset: Float64Array;
  sleepTicks: Float64Array;
  flags: Uint8Array;
}

let cached: Promise<SimWasm> | undefined;
let resolvedHandle: SimWasm | undefined;

/** Idempotent. Concurrent callers share one fetch + compile of
 *  the wasm module. Resolves once the WASM is instantiated and
 *  the auto-init (#[wasm_bindgen(start)]) panic hook has run. */
export function initSimWasm(): Promise<SimWasm> {
  if (cached === undefined) {
    cached = (async () => {
      const initOutput = await __wbg_init();

      // Pre-grow WASM linear memory BEFORE pool_init() so the
      // BodyPool's Vec allocations land in a comfortably-sized
      // memory region. Subsequent per-tick Rust allocations
      // (HashMap rebuilds in the sphere-sphere resolver, per-cell
      // Vec growths in the static broadphase) then fit without
      // triggering memory.grow() — which would detach every typed-
      // array view JS holds over linear memory and cause the
      // "Aw, Snap!" renderer crash on the next view access.
      //
      // 32 MB upper-bounds steady-state allocations comfortably:
      // pool ~720 KB + per-engine static cells + transient
      // HashMaps. Memory still grows on demand if we exceed this,
      // but refreshViews below catches that case too.
      const PRE_GROW_TARGET_PAGES = 512;  // 64 KiB/page * 512 = 32 MiB
      const currentPages = initOutput.memory.buffer.byteLength / 65536;
      const growBy = PRE_GROW_TARGET_PAGES - currentPages;
      if (growBy > 0) {
        initOutput.memory.grow(growBy);
      }

      pool_init();
      projectile_pool_init();
      // Phase 7 — initialize SpatialGrid singleton. Cell size mirrors
      // CANONICAL_LAND_CELL_SIZE in landGrid.ts; the grid auto-grows
      // its per-slot SoA arrays past the initial capacity hint.
      spatial_init(200, 1024);
      // Phase 10 D.1 — entity-meta SoA pool. Same initial slot
      // capacity hint as SpatialGrid since the slot spaces are
      // shared (one EntityId<->slot map JS-side).
      entity_meta_init(1024);
      // Phase 10 D.1b — turret sub-pool. Per-entity turret arrays
      // indexed at fixed offsets up to MAX_TURRETS_PER_ENTITY = 8.
      turret_pool_init(1024);
      // Phase 10 D.2 — verify the hand-rolled MessagePack encoder
      // matches its expected byte output across 21 fixture cases.
      // Returns a bitmask of failed cases (0 = all pass). Future
      // Phase 10 sub-commits depend on byte-equality with the JS
      // @msgpack/msgpack output, so a regression here is fatal.
      const mpFailures = messagepack_self_test();
      if (mpFailures !== 0) {
        throw new Error(
          `(rust) rts-sim-wasm MessagePack encoder self-test failed: 0x${mpFailures.toString(16)}`,
        );
      }
      const memory = initOutput.memory;
      const capacity = pool_capacity();
      const projCapacity = projectile_pool_capacity();

      const f64View = (ptr: number): Float64Array =>
        new Float64Array(memory.buffer, ptr, capacity);
      const u8View = (ptr: number): Uint8Array =>
        new Uint8Array(memory.buffer, ptr, capacity);

      // Hold field pointers so refreshViews() can rebuild the
      // typed-array views over potentially-detached WASM memory
      // (linear memory grow detaches all existing views).
      const ptrs = {
        posX: pool_pos_x_ptr(),
        posY: pool_pos_y_ptr(),
        posZ: pool_pos_z_ptr(),
        velX: pool_vel_x_ptr(),
        velY: pool_vel_y_ptr(),
        velZ: pool_vel_z_ptr(),
        accelX: pool_accel_x_ptr(),
        accelY: pool_accel_y_ptr(),
        accelZ: pool_accel_z_ptr(),
        launchX: pool_launch_x_ptr(),
        launchY: pool_launch_y_ptr(),
        launchZ: pool_launch_z_ptr(),
        radius: pool_radius_ptr(),
        halfX: pool_half_x_ptr(),
        halfY: pool_half_y_ptr(),
        halfZ: pool_half_z_ptr(),
        invMass: pool_inv_mass_ptr(),
        restitution: pool_restitution_ptr(),
        groundOffset: pool_ground_offset_ptr(),
        sleepTicks: pool_sleep_ticks_ptr(),
        flags: pool_flags_ptr(),
      };

      const pool: BodyPoolViews = {
        capacity,
        allocSlot: pool_alloc_slot,
        freeSlot: pool_free_slot,
        refreshViews: () => {
          pool.posX = f64View(ptrs.posX);
          pool.posY = f64View(ptrs.posY);
          pool.posZ = f64View(ptrs.posZ);
          pool.velX = f64View(ptrs.velX);
          pool.velY = f64View(ptrs.velY);
          pool.velZ = f64View(ptrs.velZ);
          pool.accelX = f64View(ptrs.accelX);
          pool.accelY = f64View(ptrs.accelY);
          pool.accelZ = f64View(ptrs.accelZ);
          pool.launchX = f64View(ptrs.launchX);
          pool.launchY = f64View(ptrs.launchY);
          pool.launchZ = f64View(ptrs.launchZ);
          pool.radius = f64View(ptrs.radius);
          pool.halfX = f64View(ptrs.halfX);
          pool.halfY = f64View(ptrs.halfY);
          pool.halfZ = f64View(ptrs.halfZ);
          pool.invMass = f64View(ptrs.invMass);
          pool.restitution = f64View(ptrs.restitution);
          pool.groundOffset = f64View(ptrs.groundOffset);
          pool.sleepTicks = f64View(ptrs.sleepTicks);
          pool.flags = u8View(ptrs.flags);
        },
        // Initialised below; the explicit assignments make the
        // type narrowing happy.
        posX: f64View(ptrs.posX),
        posY: f64View(ptrs.posY),
        posZ: f64View(ptrs.posZ),
        velX: f64View(ptrs.velX),
        velY: f64View(ptrs.velY),
        velZ: f64View(ptrs.velZ),
        accelX: f64View(ptrs.accelX),
        accelY: f64View(ptrs.accelY),
        accelZ: f64View(ptrs.accelZ),
        launchX: f64View(ptrs.launchX),
        launchY: f64View(ptrs.launchY),
        launchZ: f64View(ptrs.launchZ),
        radius: f64View(ptrs.radius),
        halfX: f64View(ptrs.halfX),
        halfY: f64View(ptrs.halfY),
        halfZ: f64View(ptrs.halfZ),
        invMass: f64View(ptrs.invMass),
        restitution: f64View(ptrs.restitution),
        groundOffset: f64View(ptrs.groundOffset),
        sleepTicks: f64View(ptrs.sleepTicks),
        flags: u8View(ptrs.flags),
      };

      // Phase 5a — projectile pool views over the WASM linear
      // memory. Same lifetime/refresh pattern as the body pool.
      const projF64View = (ptr: number): Float64Array =>
        new Float64Array(memory.buffer, ptr, projCapacity);
      const projU8View = (ptr: number): Uint8Array =>
        new Uint8Array(memory.buffer, ptr, projCapacity);
      const projPtrs = {
        posX: projectile_pool_pos_x_ptr(),
        posY: projectile_pool_pos_y_ptr(),
        posZ: projectile_pool_pos_z_ptr(),
        velX: projectile_pool_vel_x_ptr(),
        velY: projectile_pool_vel_y_ptr(),
        velZ: projectile_pool_vel_z_ptr(),
        timeAlive: projectile_pool_time_alive_ptr(),
        hasGravity: projectile_pool_has_gravity_ptr(),
      };
      const projectilePool: ProjectilePoolViews = {
        capacity: projCapacity,
        refreshViews: () => {
          projectilePool.posX = projF64View(projPtrs.posX);
          projectilePool.posY = projF64View(projPtrs.posY);
          projectilePool.posZ = projF64View(projPtrs.posZ);
          projectilePool.velX = projF64View(projPtrs.velX);
          projectilePool.velY = projF64View(projPtrs.velY);
          projectilePool.velZ = projF64View(projPtrs.velZ);
          projectilePool.timeAlive = projF64View(projPtrs.timeAlive);
          projectilePool.hasGravity = projU8View(projPtrs.hasGravity);
        },
        posX: projF64View(projPtrs.posX),
        posY: projF64View(projPtrs.posY),
        posZ: projF64View(projPtrs.posZ),
        velX: projF64View(projPtrs.velX),
        velY: projF64View(projPtrs.velY),
        velZ: projF64View(projPtrs.velZ),
        timeAlive: projF64View(projPtrs.timeAlive),
        hasGravity: projU8View(projPtrs.hasGravity),
      };

      const handle: SimWasm = {
        version: version(),
        stepUnitMotion: step_unit_motion,
        pool,
        poolStepIntegrate: pool_step_integrate,
        poolResolveSphereSphere: pool_resolve_sphere_sphere,
        engineStaticsCreate: engine_statics_create,
        engineStaticsDestroy: engine_statics_destroy,
        engineStaticsAdd: engine_statics_add,
        engineStaticsRemove: engine_statics_remove,
        poolResolveSphereCuboidFull: pool_resolve_sphere_cuboid_full,
        quatHoverOrientationStepBatch: quat_hover_orientation_step_batch,
        projectilePool,
        poolStepPackedProjectilesBatch: pool_step_packed_projectiles_batch,
        solveKinematicIntercept: solve_kinematic_intercept,
        applyHomingSteering: apply_homing_steering,
        integrateDampedRotation: integrate_damped_rotation,
        terrainInstallMesh: terrain_install_mesh,
        terrainClear: terrain_clear,
        terrainIsInstalled: terrain_is_installed,
        terrainGetSurfaceHeight: terrain_get_surface_height,
        terrainGetSurfaceNormal: terrain_get_surface_normal,
        terrainHasLineOfSight: terrain_has_line_of_sight,
        memory,
        pathfinder: {
          init: pathfinder_init,
          rebuildMaskAndCc: pathfinder_rebuild_mask_and_cc,
          findPath: pathfinder_find_path,
          waypointsPtr: pathfinder_waypoints_ptr,
          gridWidth: pathfinder_grid_size_w,
          gridHeight: pathfinder_grid_size_h,
        },
        entityMeta: {
          init: entity_meta_init,
          clear: entity_meta_clear,
          setUnit: entity_meta_set_unit,
          setBuilding: entity_meta_set_building,
          unset: entity_meta_unset,
          type: entity_meta_type,
          capacity: entity_meta_capacity,
          typePtr: entity_meta_type_ptr,
          playerIdPtr: entity_meta_player_id_ptr,
          hpCurrPtr: entity_meta_hp_curr_ptr,
          hpMaxPtr: entity_meta_hp_max_ptr,
          combatModePtr: entity_meta_combat_mode_ptr,
          isCommanderPtr: entity_meta_is_commander_ptr,
          buildCompletePtr: entity_meta_build_complete_ptr,
          buildPaidEnergyPtr: entity_meta_build_paid_energy_ptr,
          buildPaidManaPtr: entity_meta_build_paid_mana_ptr,
          buildPaidMetalPtr: entity_meta_build_paid_metal_ptr,
          buildTargetIdPtr: entity_meta_build_target_id_ptr,
          suspensionSpringOffsetPtr: entity_meta_suspension_spring_offset_ptr,
          suspensionSpringVelocityPtr: entity_meta_suspension_spring_velocity_ptr,
          jumpAirbornePtr: entity_meta_jump_airborne_ptr,
          jumpTimerPtr: entity_meta_jump_timer_ptr,
          factoryIsProducingPtr: entity_meta_factory_is_producing_ptr,
          factoryBuildQueueLenPtr: entity_meta_factory_build_queue_len_ptr,
          factoryProgressPtr: entity_meta_factory_progress_ptr,
          solarOpenPtr: entity_meta_solar_open_ptr,
          buildProgressPtr: entity_meta_build_progress_ptr,
        },
        turretPool: {
          init: turret_pool_init,
          clear: turret_pool_clear,
          maxPerEntity: turret_pool_max_per_entity,
          setCount: turret_pool_set_count,
          setTurret: turret_pool_set_turret,
          unsetEntity: turret_pool_unset_entity,
          count: turret_pool_count,
          entityCapacity: turret_pool_entity_capacity,
          countPerEntityPtr: turret_pool_count_per_entity_ptr,
          rotationPtr: turret_pool_rotation_ptr,
          angularVelocityPtr: turret_pool_angular_velocity_ptr,
          angularAccelerationPtr: turret_pool_angular_acceleration_ptr,
          pitchPtr: turret_pool_pitch_ptr,
          pitchVelocityPtr: turret_pool_pitch_velocity_ptr,
          pitchAccelerationPtr: turret_pool_pitch_acceleration_ptr,
          forceFieldRangePtr: turret_pool_force_field_range_ptr,
          targetIdPtr: turret_pool_target_id_ptr,
        },
        spatial: {
          init: spatial_init,
          clear: spatial_clear,
          allocSlot: spatial_alloc_slot,
          freeSlot: spatial_free_slot,
          setUnit: spatial_set_unit,
          setProjectile: spatial_set_projectile,
          setBuilding: spatial_set_building,
          syncBuildingCaptureForSlot: spatial_sync_building_capture_for_slot,
          unsetSlot: spatial_unset_slot,
          queryUnitsInRadius: spatial_query_units_in_radius,
          queryBuildingsInRadius: spatial_query_buildings_in_radius,
          queryUnitsAndBuildingsInRadius: spatial_query_units_and_buildings_in_radius,
          queryUnitsAndBuildingsInRect2D: spatial_query_units_and_buildings_in_rect_2d,
          queryEnemyEntitiesInRadius: spatial_query_enemy_entities_in_radius,
          queryEnemyEntitiesInCircle2D: spatial_query_enemy_entities_in_circle_2d,
          queryUnitsAlongLine: spatial_query_units_along_line,
          queryBuildingsAlongLine: spatial_query_buildings_along_line,
          queryEntitiesAlongLine: spatial_query_entities_along_line,
          queryEnemyUnitsInRadius: spatial_query_enemy_units_in_radius,
          queryEnemyProjectilesInRadius: spatial_query_enemy_projectiles_in_radius,
          queryEnemyUnitsAndProjectilesInRadius: spatial_query_enemy_units_and_projectiles_in_radius,
          queryOccupiedCellsForCapture: spatial_query_occupied_cells_for_capture,
          queryOccupiedCellsDebug: spatial_query_occupied_cells_debug,
          scratchPtr: spatial_scratch_ptr,
          scratchLen: spatial_scratch_len,
          slotKind: spatial_slot_kind,
        },
      };
      resolvedHandle = handle;
      return handle;
    })();
  }
  return cached;
}

/** Synchronous accessor for the loaded WASM handle. Returns
 *  undefined if `initSimWasm()` hasn't resolved yet. Hot paths
 *  call this once at construction (or use the awaited handle)
 *  and cache it locally to avoid per-tick lookup overhead. */
export function getSimWasm(): SimWasm | undefined {
  return resolvedHandle;
}
