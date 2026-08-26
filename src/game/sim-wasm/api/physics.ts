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
  /** Allocate the per-cell SoA arrays for the given map dimensions. The
   *  locomotion grid is always the 20 wu build grid. */
  init: (mapWidth: number, mapHeight: number) => void;
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
  /** There is deliberately NO synchronous whole-route search on this API.
   *  Every search is a resumable slice with a work budget; a route that does
   *  not finish inside its slice is retained and resumed next tick. The
   *  synchronous export was removed on 2026-08-26 after it froze production
   *  under whole-army line moves for the third time — see
   *  budget_design_philosophy.html "Path searches are resumable fixed-tick
   *  jobs" and massMovePathBudgetContractTest. */
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
  /** Drop traffic heat, per-class hierarchy graphs and retained frontiers so a
   *  match starts from identical caches on every peer. */
  resetMatchState: () => void;
  /** Cells within which a building change can alter clearance (the EDT
   *  clamp, owned by Rust). */
  clearanceReachCells: () => number;
  /** Monotonic telemetry: every work unit every search has charged since
   *  init, whichever API ran it. Never hashed. Read across one fixed tick it
   *  bounds ALL pathfinding work that tick performed. */
  totalWorkUnits: () => number;
  /** Resolution code for the most recent findPathSlice call:
   *  0 unreachable, 1 complete, 2 snapped, 3 partial, 4 pending. */
  lastResultStatus: () => number;
  /** Search strategy: 0 none, 1 direct, 2 hierarchical, 3 fine A*. */
  lastSearchStrategy: () => number;
  lastFineExpandedNodes: () => number;
  /** Fine-grid nodes closed by the most recent call, excluding prior slices. */
  lastFineExpandedNodesThisSlice: () => number;
  /** Abstract (cluster-graph) expansions of the most recent query. */
  lastCoarseExpandedNodes: () => number;
  /** Hierarchy work charged by the most recent query: cluster-build cells
   *  plus abstract expansions, in fine-expansion units. */
  lastHpaWork: () => number;
  /** Clusters in the corridor the fine search was restricted to. */
  lastCorridorClusters: () => number;
  /** Per-class hierarchy graphs currently cached. */
  classGraphCount: () => number;
  classGraphEvictions: () => number;
  /** Decay the traffic-heat layer by a quarter (fixed tick cadence). */
  decayTrafficHeat: () => void;
  /** Base pointer of the per-cell traffic-heat bytes (grid order). */
  trafficHeatPtr: () => number;
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
    /** True when the caller is CHOOSING a straight segment (direct plan,
     *  follower corner shortcut): segments walk their cells at the line
     *  clearance (body + lineClearanceMarginWu). False judges legality of a
     *  polyline at the exact body gate. */
    lineMargin: boolean,
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
  linearDragCoefficient: Float64Array;
  groundTangentialDampingRate: Float64Array;
  sleepTicks: Float64Array;
  flags: Uint8Array;
  entityId: Int32Array;
}
