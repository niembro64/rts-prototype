// Simulation WASM physics API surface.

export interface PathfinderApi {
  /** Compute the mass/force-derived dry, wet-MOVE, and wet-WAYPOINT contact
   *  envelopes plus acceleration terms used by the route evaluator. */
  computeLocomotionClimbProfile: (
    groundMaxPropulsiveForce: number,
    waterMaxPropulsiveForce: number,
    staticFrictionCoefficient: number,
    physicsMass: number,
    gravity: number,
    forceSafetyRatio: number,
    allowOnGround: boolean,
    allowInWater: boolean,
    allowInAir: boolean,
    waterSurfaceSupported: boolean,
    out: Float64Array,
  ) => number;
  /** Allocate the per-cell SoA arrays for the given map dimensions and
   *  build-square consolidation multiplier (1..5). */
  init: (
    mapWidth: number,
    mapHeight: number,
    consolidationMultiplier: number,
  ) => void;
  /** Rebuild the terrain-only locomotion mask and connected components.
   *  Resets the building occupancy layer (version 0) so the caller resyncs
   *  it afterward. */
  rebuildTerrainMaskAndCc: (terrainVersion: number) => void;
  /** Replace the building occupancy layer with the given grounded footprint
   *  cells in canonical 20-wu build-grid coordinates; Rust conservatively
   *  maps them into the configured path grid and re-runs the O(n)
   *  blocked/clearance/component sweeps. Hovering structures are never
   *  submitted. */
  syncBuildingOccupancy: (cellGx: Int32Array, cellGy: Int32Array, version: number) => number;
  /** Version of the installed building occupancy layer; 0 = not synced. */
  buildingOccupancyVersion: () => number;
  /** Bake authoritative WAYPOINT and MOVE validity for every path square.
   *  Both arrays must hold at least gridWidth()*gridHeight() bytes. */
  bakeTraversabilityGrid: (
    minGroundNormalZ: number,
    waterSurfaceSupported: boolean,
    supportPointOffsetZ: number,
    waypointAllowOnGround: boolean,
    waypointAllowInWater: boolean,
    waypointAllowInAir: boolean,
    moveAllowOnGround: boolean,
    moveAllowInWater: boolean,
    moveAllowInAir: boolean,
    unitRadius: number,
    safeDriveAccel: number,
    safeWaterDriveAccel: number,
    staticFrictionCoefficient: number,
    waypointOut: Uint8Array,
    moveOut: Uint8Array,
  ) => number;
  /** Run findPath. Writes smoothed waypoints into the WASM-side
   *  scratch buffer as interleaved (x, y) f64 pairs; returns the
   *  waypoint COUNT (not the f64 element count). Waypoint-domain flags own
   *  intentional destinations/entries; move-domain flags own physical
   *  traversal and recovery from external displacement. */
  findPath: (
    startX: number, startY: number,
    goalX: number, goalY: number,
    minGroundNormalZ: number,
    waterSurfaceSupported: boolean,
    supportPointOffsetZ: number,
    waypointAllowOnGround: boolean,
    waypointAllowInWater: boolean,
    waypointAllowInAir: boolean,
    moveAllowOnGround: boolean,
    moveAllowInWater: boolean,
    moveAllowInAir: boolean,
    /** Unit collision radius in world units. Blockers are kept this far from
     *  the route (clearance field) so a body is not squeezed through gaps it
     *  cannot fit. 0 = point-size (no clearance gate). */
    unitRadius: number,
    /** Dry-ground tangential acceleration after drive-force and grip clamps.
     *  Used only for normalized slope travel time; 0 disables slope cost. */
    flatDriveAccel: number,
    /** Safety-reduced drive acceleration used for hard feasibility. */
    safeDriveAccel: number,
    /** Flat wet-contact acceleration after ground grip and water propulsion. */
    flatWaterContactAccel: number,
    /** Safety-reduced independent water-propulsion acceleration. */
    safeWaterDriveAccel: number,
    /** Coulomb surface-grip coefficient used for cross-slope force budget. */
    staticFrictionCoefficient: number,
    /** When true (SYMMETRIC), apply the inter-cell climb gate both ways;
     *  otherwise preserve controlled descent between locally valid cells. */
    symmetricSlope: boolean,
  ) => number;
  /** Start or resume the same fine-grid query, closing no more than the given
   *  number of A* nodes. Zero waypoints plus result status 4 means pending. */
  findPathSlice: (
    startX: number, startY: number,
    goalX: number, goalY: number,
    minGroundNormalZ: number,
    waterSurfaceSupported: boolean,
    supportPointOffsetZ: number,
    waypointAllowOnGround: boolean,
    waypointAllowInWater: boolean,
    waypointAllowInAir: boolean,
    moveAllowOnGround: boolean,
    moveAllowInWater: boolean,
    moveAllowInAir: boolean,
    unitRadius: number,
    flatDriveAccel: number,
    safeDriveAccel: number,
    flatWaterContactAccel: number,
    safeWaterDriveAccel: number,
    staticFrictionCoefficient: number,
    symmetricSlope: boolean,
    /** Stable ally-team id owning this resumable frontier. */
    continuationOwner: number,
    expansionBudget: number,
  ) => number;
  /** Discard one ally team's retained frontier when its owning intent dies. */
  cancelPathSlice: (continuationOwner: number) => void;
  /** Discard every retained team frontier at match teardown/invalidation. */
  cancelAllPathSlices: () => void;
  /** Resolution code for the most recent findPath call:
   *  0 unreachable, 1 complete, 2 snapped, 3 partial, 4 pending. */
  lastResultStatus: () => number;
  /** Search strategy: 0 none, 1 direct, 2 hierarchical, 3 fine A*. */
  lastSearchStrategy: () => number;
  lastFineExpandedNodes: () => number;
  /** Fine-grid nodes closed by the most recent call, excluding prior slices. */
  lastFineExpandedNodesThisSlice: () => number;
  lastCoarseExpandedNodes: () => number;
  lastCoarseRefinementPasses: () => number;
  lastCoarseExactEdgeChecks: () => number;
  lastCoarseFullClusterScans: () => number;
  lastFineHitNodeLimit: () => number;
  lastSmoothingLineChecks: () => number;
  lastDirectCostRatio: () => number;
  /** Validate an interleaved x/y polyline (including its start point) against
   *  the same medium, hard-clearance, slope, and LOS rules as planning. */
  validatePath: (
    points: Float64Array,
    minGroundNormalZ: number,
    waterSurfaceSupported: boolean,
    supportPointOffsetZ: number,
    waypointAllowOnGround: boolean,
    waypointAllowInWater: boolean,
    waypointAllowInAir: boolean,
    moveAllowOnGround: boolean,
    moveAllowInWater: boolean,
    moveAllowInAir: boolean,
    unitRadius: number,
    safeDriveAccel: number,
    safeWaterDriveAccel: number,
    staticFrictionCoefficient: number,
    symmetricSlope: boolean,
  ) => number;
  /** Raw pointer to the waypoint scratch buffer. Build a fresh
   *  Float64Array(memory.buffer, ptr, count * 2) view per call. */
  waypointsPtr: () => number;
  /** Current grid dimensions (refreshed by init). */
  gridWidth: () => number;
  gridHeight: () => number;
}


/** Views over the projectile SoA pool. Indexed by slot id (0..count
 *  where count is JS-managed in projectileSystem.ts). All views
 *  share the same WASM linear memory and detach together if memory
 *  grows — `refreshViews` rebuilds them. */
export interface ProjectilePoolViews {
  readonly capacity: number;
  refreshViews: () => void;
  clear: () => void;
  posX: Float64Array;
  posY: Float64Array;
  posZ: Float64Array;
  velX: Float64Array;
  velY: Float64Array;
  velZ: Float64Array;
  timeAlive: Float64Array;
  sourceTurretEntityId: Int32Array;
  sourceHostEntityId: Int32Array;
  sourceRootEntityId: Int32Array;
  sourcePlayerId: Int32Array;
  sourceTeamId: Int32Array;
  sourceTurretBlueprintCode: Uint32Array;
  sourceShotBlueprintCode: Uint32Array;
  spawnTick: Uint32Array;
  parentShotEntityId: Int32Array;
}

/** Layout stride for `unitForceStepBatch`. Mirrors
 *  UNIT_FORCE_BATCH_STRIDE in rts-sim-wasm/src/unit_kinetics.rs. */
export const UNIT_FORCE_BATCH_STRIDE = 59;

/** Bit flags packed into BodyPoolViews.flags[slot]. Mirrors the
 *  BODY_FLAG_* constants in rts-sim-wasm/src/lib.rs. */
export const BODY_FLAG_SLEEPING = 1 << 0;
export const BODY_FLAG_IS_STATIC = 1 << 1;
export const BODY_FLAG_UPWARD_CONTACT = 1 << 2;
export const BODY_FLAG_SHAPE_CUBOID = 1 << 3;
export const BODY_FLAG_OCCUPIED = 1 << 4;
export const BODY_FLAG_SHAPE_RING = 1 << 5;

/** Typed-array views over the WASM-side BodyPool. All views are
 *  indexed by slot id (returned by allocSlot()). Capacity is
 *  fixed at pool_init() so views never need to be refreshed
 *  unless the WASM linear memory itself grows underneath us;
 *  call `refreshViews()` after any operation that might trigger
 *  memory growth (rare under our usage pattern). */
export interface BodyPoolViews {
  readonly capacity: number;
  /** Allocate the next free slot. Returns `capacity` as an exhaustion
   *  sentinel — callers must check (Body3D.allocate turns it into a
   *  descriptive throw instead of an out-of-bounds WASM trap). */
  allocSlot: () => number;
  /** Occupied slot count; `capacity - liveCount()` is spawn headroom. */
  liveCount: () => number;
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
  surfaceNormalX: Float64Array;
  surfaceNormalY: Float64Array;
  surfaceNormalZ: Float64Array;
  radius: Float64Array;
  halfX: Float64Array;
  halfY: Float64Array;
  halfZ: Float64Array;
  invMass: Float64Array;
  restitution: Float64Array;
  groundOffset: Float64Array;
  airDragCoefficient: Float64Array;
  groundTangentialDampingRate: Float64Array;
  sleepTicks: Float64Array;
  flags: Uint8Array;
  entityId: Int32Array;
}
