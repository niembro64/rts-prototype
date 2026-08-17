import type { PresentationApi, RenderPoseApi } from './presentation';
import type { EntityStateApi, SpatialApi } from './entitySpatial';
import type { TurretPoolApi, CombatTargetingApi } from './turretCombat';
import type { ShieldSurfacePoolApi } from './shield';
import type { SnapshotEncodeApi } from './snapshot';
import type { PathfinderApi, ProjectilePoolViews, BodyPoolViews } from './physics';
export interface SimWasm {
  /** Build-stamp from the Rust crate (CARGO_PKG_VERSION).
   *  Useful in dev / startup logs to confirm a fresh wasm-pack
   *  build is being served. */
  readonly version: string;
  readonly deterministicMath: {
    readonly sin: (value: number) => number;
    readonly cos: (value: number) => number;
    readonly atan2: (y: number, x: number) => number;
    readonly sqrt: (value: number) => number;
    readonly exp: (value: number) => number;
    readonly hypot2: (x: number, y: number) => number;
    readonly hypot3: (x: number, y: number, z: number) => number;
    readonly pow: (base: number, exponent: number) => number;
  };
  readonly windSampleState: (nowMs: number, out: Float64Array) => number;
  readonly buildTargetHorizontalDistance: (
    builderX: number,
    builderY: number,
    targetX: number,
    targetY: number,
    targetKind: number,
    targetWidth: number,
    targetHeight: number,
    targetRadius: number,
  ) => number;
  readonly commanderApplyReclaimTick: (
    hpCurr: number,
    hpMax: number,
    constructionRate: number,
    dtSec: number,
    valueEnergy: number,
    valueMetal: number,
    refundFraction: number,
    out: Float64Array,
  ) => number;
  readonly factoryBuildSpot: (
    factoryX: number,
    factoryY: number,
    rallyX: number,
    rallyY: number,
    fallbackDirX: number,
    fallbackDirY: number,
    unitRadius: number,
    footprintWidth: number,
    footprintHeight: number,
    constructionRadius: number,
    buildClearance: number,
    buildRadiusFraction: number,
    mapWidth: number,
    mapHeight: number,
    clampRadius: number,
    out: Float64Array,
  ) => number;
  readonly factoryBuildSpotBlocked: (
    x: number,
    y: number,
    radius: number,
    obstacleX: Float64Array,
    obstacleY: Float64Array,
    obstacleRadius: Float64Array,
    count: number,
  ) => number;
  readonly factoryPlanProductionActions: (
    hasShell: Uint8Array,
    shellExists: Uint8Array,
    shellHasBuildable: Uint8Array,
    shellBuildableComplete: Uint8Array,
    shellInterrupted: Uint8Array,
    shellPaidEnergy: Float64Array,
    shellPaidMetal: Float64Array,
    shellRequiredEnergy: Float64Array,
    shellRequiredMetal: Float64Array,
    selectedState: Uint8Array,
    canBuildUnit: Uint8Array,
    isProducing: Uint8Array,
    count: number,
    outAction: Uint8Array,
    outProgress: Float64Array,
  ) => number;
  readonly buildingActiveStateStepBatch: (
    open: Uint8Array,
    active: Uint8Array,
    wantOpen: Uint8Array,
    damageDelayMs: Float64Array,
    reopenDelayMs: Float64Array,
    count: number,
    dtMs: number,
    reopenDelayResetMs: number,
    outOpenChanged: Uint8Array,
  ) => number;
  readonly economyAccumulatePlayerRates: (
    playerIds: Uint32Array,
    rates: Float64Array,
    count: number,
    outRatesByPlayer: Float64Array,
  ) => number;
  readonly economyComputeConverterTransfer: (
    energyCurr: number,
    energyMax: number,
    metalCurr: number,
    metalMax: number,
    totalRatePerSec: number,
    dtSec: number,
    tax: number,
    out: Float64Array,
  ) => number;
  readonly economyCreditStockpile: (
    curr: number,
    max: number,
    amount: number,
    out: Float64Array,
  ) => number;
  readonly economyDebitStockpile: (
    curr: number,
    amount: number,
    out: Float64Array,
  ) => number;
  readonly economyApplyEqualConsumerDebits: (
    remaining: Float64Array,
    caps: Float64Array,
    count: number,
    participantCount: number,
    stockpileCurr: number,
    outSpent: Float64Array,
    outTotals: Float64Array,
  ) => number;
  readonly constructionApplyCoupledConsumerDebits: (
    paidEnergy: Float64Array,
    paidMetal: Float64Array,
    requiredEnergy: Float64Array,
    requiredMetal: Float64Array,
    caps: Float64Array,
    count: number,
    energyStockpileCurr: number,
    metalStockpileCurr: number,
    outSpentEnergy: Float64Array,
    outSpentMetal: Float64Array,
    outTotals: Float64Array,
  ) => number;
  readonly constructionApplyConsumerSpends: (
    consumerTypes: Uint8Array,
    paidEnergy: Float64Array,
    paidMetal: Float64Array,
    requiredEnergy: Float64Array,
    requiredMetal: Float64Array,
    hp: Float64Array,
    maxHp: Float64Array,
    spendEnergy: Float64Array,
    spendMetal: Float64Array,
    caps: Float64Array,
    count: number,
    healCostPerHp: number,
    outBuildProgress: Float64Array,
    outEnergyRateFraction: Float64Array,
    outMetalRateFraction: Float64Array,
    outChangedMask: Uint8Array,
  ) => number;
  readonly constructionReconcileAndGrowPieces: (
    totalPaidEnergy: number,
    totalPaidMetal: number,
    requiredEnergy: Float64Array,
    requiredMetal: Float64Array,
    maxHp: Float64Array,
    currentHp: Float64Array,
    previousProgress: Float64Array,
    startsAtFrameOne: Uint8Array,
    alive: Uint8Array,
    count: number,
    outPaidEnergy: Float64Array,
    outPaidMetal: Float64Array,
    outComplete: Uint8Array,
    outActive: Uint8Array,
    outHp: Float64Array,
    outProgress: Float64Array,
  ) => number;
  readonly economyApplyIncomeCredits: (
    playerIds: Uint32Array,
    resourceCodes: Uint32Array,
    ratesPerSec: Float64Array,
    count: number,
    dtSec: number,
    energyCurrByPlayer: Float64Array,
    energyMaxByPlayer: Float64Array,
    metalCurrByPlayer: Float64Array,
    metalMaxByPlayer: Float64Array,
    outAccepted: Float64Array,
  ) => number;
  readonly economyApplyConverterTransfers: (
    playerIds: Uint32Array,
    ratesPerSec: Float64Array,
    count: number,
    dtSec: number,
    tax: number,
    energyCurrByPlayer: Float64Array,
    energyMaxByPlayer: Float64Array,
    metalCurrByPlayer: Float64Array,
    metalMaxByPlayer: Float64Array,
    ratesByPlayer: Float64Array,
    consumedByPlayer: Float64Array,
    outputByPlayer: Float64Array,
    consumedResourceByPlayer: Uint32Array,
    outputResourceByPlayer: Uint32Array,
    outConsumed: Float64Array,
    outOutput: Float64Array,
    outConsumedResource: Uint32Array,
    outOutputResource: Uint32Array,
  ) => number;
  readonly arrivalCompletionStepBatch: (
    slots: Uint32Array,
    dx: Float64Array,
    dy: Float64Array,
    fallbackVelocityX: Float64Array,
    fallbackVelocityY: Float64Array,
    flags: Uint8Array,
    outDistance: Float64Array,
    outArrived: Uint8Array,
    arrivalRadius: number,
    finalRadius: number,
    finalStopSpeed: number,
  ) => number;
  readonly airborneLoiterStepBatch: (
    slots: Uint32Array,
    dx: Float64Array,
    dy: Float64Array,
    distance: Float64Array,
    rotation: Float64Array,
    radiusCollision: Float64Array,
    existingTurnSign: Float64Array,
    fallbackVelocityX: Float64Array,
    fallbackVelocityY: Float64Array,
    outThrustX: Float64Array,
    outThrustY: Float64Array,
    outTurnSign: Float64Array,
    outActive: Uint8Array,
    minRadius: number,
    radiusMult: number,
    radialGain: number,
  ) => number;
  readonly stuckReplanStepBatch: (
    slots: Uint32Array,
    currentStuckTicks: Int32Array,
    settlingDx: Float64Array,
    settlingDy: Float64Array,
    settlingFlags: Uint8Array,
    outStuckTicks: Int32Array,
    outShouldReplan: Uint8Array,
    stuckVelocityThreshold: number,
    stuckTickThreshold: number,
    arrivalRadius: number,
  ) => number;
  readonly unitActionPlanBatch: (
    actionTypes: Uint8Array,
    flags: Uint32Array,
    slots: Uint32Array,
    rangeKind: Uint8Array,
    targetSlot: Int32Array,
    rangeParam: Float64Array,
    outPlan: Uint8Array,
  ) => number;
  readonly unitActionMovementBatch: (
    slots: Uint32Array,
    targetX: Float64Array,
    targetY: Float64Array,
    threshold: Float64Array,
    finalPoint: Uint8Array,
    outDx: Float64Array,
    outDy: Float64Array,
    outDistance: Float64Array,
    outDecision: Uint8Array,
  ) => number;
  readonly articulationJointStepBatch: (
    currentYaw: Float64Array,
    yawVelocity: Float64Array,
    targetYaw: Float64Array,
    yawContinuous: Uint8Array,
    yawMin: Float64Array,
    yawMax: Float64Array,
    yawMaxSpeed: Float64Array,
    yawMaxAcceleration: Float64Array,
    currentPitch: Float64Array,
    pitchVelocity: Float64Array,
    targetPitch: Float64Array,
    pitchMin: Float64Array,
    pitchMax: Float64Array,
    pitchMaxSpeed: Float64Array,
    pitchMaxAcceleration: Float64Array,
    outYaw: Float64Array,
    outYawVelocity: Float64Array,
    outYawAcceleration: Float64Array,
    outPitch: Float64Array,
    outPitchVelocity: Float64Array,
    outPitchAcceleration: Float64Array,
    outAimErrorYaw: Float64Array,
    outAimErrorPitch: Float64Array,
    count: number,
    dtSec: number,
  ) => number;
  readonly articulationYawStepBatch: (
    currentYaw: Float64Array,
    yawVelocity: Float64Array,
    targetYaw: Float64Array,
    maxSpeed: Float64Array,
    maxAcceleration: Float64Array,
    outYaw: Float64Array,
    outYawVelocity: Float64Array,
    outYawAcceleration: Float64Array,
    outAimError: Float64Array,
    count: number,
    dtSec: number,
  ) => number;
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
    windX: number,
    windY: number,
    windZ: number,
    mapWidth: number,
    mapHeight: number,
  ) => number;
  /** Pool-backed PhysicsEngine3D step prep. Rust clears per-step
   *  upward-contact flags, applies map-boundary acceleration, wakes
   *  boundary-pushed sleepers, and emits both awake slot ids and
   *  pre-step sync body slots. statsOut = [awakeCount, wakeCount,
   *  syncCount]. */
  readonly poolPrepareDynamicStep: (
    dynamicSlots: Uint32Array,
    awakeSlotsOut: Uint32Array,
    syncBodySlotsOut: Uint32Array,
    statsOut: Uint32Array,
    mapWidth: number,
    mapHeight: number,
    boundarySpringAccel: number,
    boundaryDampingAccelPerSpeed: number,
  ) => number;
  /** Collect awake unit EntityIds from BodyPool flags without a JS
   *  dynamic-body scan. */
  readonly poolCollectAwakeEntityIds: (
    dynamicSlots: Uint32Array,
    entityIdsOut: Int32Array,
  ) => number;
  /** Final per-step sync collection and accumulator clear over packed
   *  BodyPool slots. */
  readonly poolFinalizeDynamicStep: (
    dynamicSlots: Uint32Array,
    syncBodySlotsOut: Uint32Array,
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
  /** Variant of poolResolveSphereSphere that builds candidates from all
   *  dynamic slots but only drives pair scans from this step's active
   *  body slots. Awake bodies can still push/wake sleeping candidates. */
  readonly poolResolveSphereSphereActive: (
    activeSlots: Uint32Array,
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
  /** TS-WASM-01A — batched arrival controller. TypeScript action
   *  orchestration packs one row per unit that wants waypoint thrust;
   *  the Rust kernel reads body velocity from the BodyPool and writes
   *  normalized/scaled thrust requests for UnitForceSystem to consume. */
  readonly arrivalControlStepBatch: (
    slots: Uint32Array,
    dx: Float64Array,
    dy: Float64Array,
    distance: Float64Array,
    radiusCollision: Float64Array,
    driveScale: Float64Array,
    flags: Uint8Array,
    cornerBendCos: Float64Array,
    outThrustX: Float64Array,
    outThrustY: Float64Array,
    outActive: Uint8Array,
    dtSec: number,
    controlRadiusMin: number,
    responseTimeSec: number,
    minAccel: number,
    cornerCorridor: number,
  ) => number;
  /** Current Rust-authoritative horizontal drive acceleration for a body,
   *  blended by air/water occupancy and ground contact/load. */
  readonly unitEffectiveDriveAcceleration: (
    bodySlot: number,
  ) => number;
  /** TS-WASM-01B2 — body-pool-backed per-unit ground-normal EMA.
   *  Rust walks occupied dynamic body slots, samples the installed
   *  terrain mesh, updates the WASM-owned normal SoA, and writes the
   *  EntityIds whose normal crossed the dirty threshold. */
  readonly unitGroundNormalStepPool: (
    dirtyEntityIdsOut: Uint32Array,
    alpha: number,
    dirtyEpsilon: number,
  ) => number;
  /** Server authoritative unit-force batch. TypeScript gathers active
   *  unit rows, pre-sampled terrain/water data, and external force
   *  inputs; Rust computes drive/lift/brake/water-wall force outputs,
   *  writes BodyPool accelerations directly, and returns row flags for
   *  Unit/Entity scatter plus body wake bookkeeping. */
  readonly unitForceStepBatch: (
    slots: Uint32Array,
    flags: Uint32Array,
    rows: Float64Array,
    outFlags: Uint32Array,
    count: number,
    dtSec: number,
    windX: number,
    windY: number,
    windZ: number,
    surfaceFollowingMinimumDistanceWorld: number,
  ) => number;
  /** Grow (never shrink) the WASM-resident force-batch staging arrays.
   *  Growth may move them — re-fetch the pointers afterwards. */
  readonly unitForceStagingEnsure: (count: number) => void;
  readonly unitForceStagingSlotsPtr: () => number;
  readonly unitForceStagingFlagsPtr: () => number;
  readonly unitForceStagingRowsPtr: () => number;
  readonly unitForceStagingOutFlagsPtr: () => number;
  /** unitForceStepBatch reading inputs from / writing outputs to the
   *  staging arrays in place — no per-call boundary copies (ledger [25]). */
  readonly unitForceStepBatchStaged: (
    count: number,
    dtSec: number,
    windX: number,
    windY: number,
    windZ: number,
    surfaceFollowingMinimumDistanceWorld: number,
  ) => number;
  readonly unitForceSurfaceLiftInverseDistanceResponse: (
    distanceToSurfaceWorld: number,
    minimumDistanceWorld: number,
  ) => number;
  readonly unitForceWaterSurfaceDepthWorld: (bodyZ: number) => number;
  readonly unitForceWaterFraction: (bodyZ: number, bodyRadius: number) => number;
  /** Blueprint locomotion constants table for unitForceStepBatch,
   *  code-indexed. Ensure BEFORE taking the pointers (resize moves
   *  them); fill once when blueprints are ready. */
  unitForceProfileEnsure: (codeCount: number) => void;
  unitForceProfileValuesPtr: () => number;
  unitForceProfileFlagsPtr: () => number;
  unitForceRuntimeClear: () => void;
  /** Applies origin-submerged water damage for every live unit body,
   *  including sleeping bodies, and returns the damaged entity-slot count. */
  unitWaterDamageStepPool: (dtSec: number) => number;
  unitWaterDamagedEntitySlotsPtr: () => number;
  /** C1 — splash/area target overlap classifier. TypeScript gathers
   *  spatial candidates and applies damage/event diffs; Rust owns the
   *  unit/projectile sphere tests, building AABB tests, slice filtering,
   *  and normalized knockback directions. */
  readonly damageAreaOverlapBatch: (
    count: number,
    enabled: Uint8Array,
    targetKind: Uint8Array,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    hasSlice: number,
    sliceDirection: number,
    sliceHalfAngle: number,
    targetX: Float64Array,
    targetY: Float64Array,
    targetZ: Float64Array,
    targetRadius: Float64Array,
    boxHalfX: Float64Array,
    boxHalfY: Float64Array,
    boxHalfZ: Float64Array,
    outFlags: Uint8Array,
    outDirX: Float64Array,
    outDirY: Float64Array,
    outDirZ: Float64Array,
    outDistance: Float64Array,
  ) => number;
  /** C1 - slab-driven splash/area candidate classifier; geometry read from
   *  the combat-targeting slab by spatial-grid slot, output identical to
   *  damageAreaOverlapBatch. TypeScript collects one candidate slot per
   *  broadphase hit instead of marshalling four geometry columns. */
  readonly damageAreaCandidatesBatch: (
    count: number,
    candidateSlots: Uint32Array,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    hasSlice: number,
    sliceDirection: number,
    sliceHalfAngle: number,
    outFlags: Uint8Array,
    outDirX: Float64Array,
    outDirY: Float64Array,
    outDirZ: Float64Array,
    outDistance: Float64Array,
  ) => number;
  /** C1 - slab-driven area turret fallback classifier. Reads turret
   *  sub-hitbox mount/radius from CombatTargetingPool and reports overlap;
   *  callers preserve the body-row slice/knockback semantics. */
  readonly damageAreaTurretCandidatesBatch: (
    count: number,
    candidateSlots: Uint32Array,
    turretIdx: Int32Array,
    currentTick: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    outFlags: Uint8Array,
  ) => number;
  /** C1 - death-explosion unit/building candidate traversal. Rust queries
   *  the spatial grid, classifies unit/building body rows and unit turret
   *  fallback rows from CombatTargetingPool, and returns compact slot rows
   *  for TypeScript to apply through damageApplyBatch. */
  readonly damageDeathExplosionCandidatesBatch: (
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    queryRadius: number,
    currentTick: number,
    maxRows: number,
    outSlots: Uint32Array,
    outTargetKind: Uint8Array,
    outFlags: Uint8Array,
    outDirX: Float64Array,
    outDirY: Float64Array,
    outDirZ: Float64Array,
    outDistance: Float64Array,
    outCount: Uint32Array,
  ) => number;
  /** C1 - death-explosion chain planner. Rust owns queue/dedupe/next
   *  blast order; TypeScript applies each returned blast row and feeds
   *  newly killed unit/building ids back into the planner. */
  readonly deathExplosionPlannerReset: () => void;
  readonly deathExplosionPlannerSeed: (
    unitIds: Int32Array,
    buildingIds: Int32Array,
  ) => number;
  readonly deathExplosionPlannerAppendKills: (
    unitIds: Int32Array,
    buildingIds: Int32Array,
  ) => number;
  readonly deathExplosionPlannerNext: (
    outEntityIds: Int32Array,
    outKind: Uint8Array,
  ) => number;
  /** C1 — line/swept damage segment hit classifier. TypeScript gathers
   *  remaining live-geometry rows and applies damage/event diffs; Rust owns
   *  the segment-vs-sphere and segment-vs-AABB hit tests. */
  readonly damageSegmentHitsBatch: (
    count: number,
    enabled: Uint8Array,
    targetKind: Uint8Array,
    startX: number,
    startY: number,
    startZ: number,
    endX: number,
    endY: number,
    endZ: number,
    targetX: Float64Array,
    targetY: Float64Array,
    targetZ: Float64Array,
    targetRadius: Float64Array,
    boxHalfX: Float64Array,
    boxHalfY: Float64Array,
    boxHalfZ: Float64Array,
    outFlags: Uint8Array,
    outT: Float64Array,
  ) => number;
  /** C1 - slab-driven line/swept damage segment classifier. Unit/building
   *  bodies and turret sub-hitboxes are addressed by combat-targeting slab
   *  slot + turret index; projectile rows stay on damageSegmentHitsBatch
   *  with live post-integration geometry. */
  readonly damageSegmentCandidatesBatch: (
    count: number,
    candidateSlots: Uint32Array,
    turretIdx: Int32Array,
    currentTick: number,
    startX: number,
    startY: number,
    startZ: number,
    endX: number,
    endY: number,
    endZ: number,
    sphereInflation: number,
    aabbInflation: number,
    outFlags: Uint8Array,
    outT: Float64Array,
  ) => number;
  /** Beam hot path — spatially query live unit/building bodies and return the
   *  closest exact sphere/AABB intersection without materializing candidate
   *  slots across the WASM boundary. Returns the entity id, or -1 for none. */
  readonly damageFindClosestBodySegmentHit: (
    startX: number,
    startY: number,
    startZ: number,
    endX: number,
    endY: number,
    endZ: number,
    queryWidth: number,
    sphereInflation: number,
    bodyExcludeEntityId: number,
    bodyExcludePanelIndex: number,
  ) => number;
  /** Parametric hit distance written by damageFindClosestBodySegmentHit. */
  readonly damageClosestBodySegmentHitT: () => number;
  /** C1 — authoritative HP write-back math for damage. TypeScript
   *  gathers candidates and applies returned entity diffs; Rust owns
   *  target-kind adjustment, next HP, and kill classification. */
  readonly damageApplyBatch: (
    count: number,
    enabled: Uint8Array,
    targetKind: Uint8Array,
    hp: Float64Array,
    damage: Float64Array,
    buildingFortified: Uint8Array,
    buildingDamageMultiplier: number,
    outHp: Float64Array,
    outEffectiveDamage: Float64Array,
    outFlags: Uint8Array,
  ) => number;
  /** C1 — pending death-cleanup compact diff generator. TypeScript drains
   *  candidate ids and applies returned event/removal diffs; Rust owns
   *  unit/building HP/materialization dead-alive classification and
   *  dead-id/kind diff generation. */
  readonly deathCleanupDiffBatch: (
    count: number,
    enabled: Uint8Array,
    entityIds: Int32Array,
    entityKind: Uint8Array,
    hp: Float64Array,
    unitMaterialized: Uint8Array,
    outDeadEntityIds: Int32Array,
    outDeadKind: Uint8Array,
    outDeadCount: Uint32Array,
  ) => number;
  /** Phase 5a — Packed projectile SoA pool. Same lifetime / view
   *  semantics as `pool` (BodyPool): fixed capacity, views captured
   *  once, refresh on memory.grow via `refreshViews`. JS-side slot
   *  management (swap-remove on unregister) writes through these
   *  views directly; per-tick ballistic integrate runs in
   *  `poolStepPackedProjectilesBatch`. */
  readonly projectilePool: ProjectilePoolViews;
  /** WASM-PROJ-01/02 — nearest shield-panel / shield reflector
   *  hit for a batch of projectile sweeps. Reads the current reflector
   *  slabs; TypeScript only compacts inputs and consumes outputs. */
  readonly projectileReflectorIntersectionsBatch: (
    count: number,
    enabled: Uint8Array,
    startX: Float64Array,
    startY: Float64Array,
    startZ: Float64Array,
    endX: Float64Array,
    endY: Float64Array,
    endZ: Float64Array,
    projectileRadius: Float64Array,
    reflectionEntity: Uint8Array,
    excludeEntityId: Int32Array,
    excludePanelIndex: Int32Array,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    instantaneousRays: number,
    mirrorQueryPad: number,
    dtMs: number,
    outKind: Uint8Array,
    outEntityId: Int32Array,
    outPanelIndex: Int32Array,
    outT: Float64Array,
    outX: Float64Array,
    outY: Float64Array,
    outZ: Float64Array,
    outNormalX: Float64Array,
    outNormalY: Float64Array,
    outNormalZ: Float64Array,
    outReflectDirX: Float64Array,
    outReflectDirY: Float64Array,
    outReflectDirZ: Float64Array,
    outSurfaceVelocityX: Float64Array,
    outSurfaceVelocityY: Float64Array,
    outSurfaceVelocityZ: Float64Array,
  ) => void;
  /** C1 — reflected projectile consequence math. Rust computes the
   *  velocity, post-hit position, and optional rotation after a shield
   *  reflector contact; TypeScript applies the returned entity diff. */
  readonly projectileReflectionResponseBatch: (
    count: number,
    enabled: Uint8Array,
    hitT: Float64Array,
    hitX: Float64Array,
    hitY: Float64Array,
    hitZ: Float64Array,
    velocityX: Float64Array,
    velocityY: Float64Array,
    velocityZ: Float64Array,
    normalX: Float64Array,
    normalY: Float64Array,
    normalZ: Float64Array,
    surfaceVelocityX: Float64Array,
    surfaceVelocityY: Float64Array,
    surfaceVelocityZ: Float64Array,
    projectileRadius: Float64Array,
    dtMs: number,
    reflectivity: number,
    outReflected: Uint8Array,
    outPosX: Float64Array,
    outPosY: Float64Array,
    outPosZ: Float64Array,
    outVelocityX: Float64Array,
    outVelocityY: Float64Array,
    outVelocityZ: Float64Array,
    outRotationChanged: Uint8Array,
    outRotation: Float64Array,
  ) => number;
  /** C1 — submunition detonation consequence math. Rust computes
   *  surface-reflected parent velocity plus deterministic per-child
   *  scatter; TypeScript only materializes returned projectile spawn
   *  diffs. */
  readonly projectileSubmunitionLaunchVelocityBatch: (
    count: number,
    seed: number,
    parentVelocityX: number,
    parentVelocityY: number,
    parentVelocityZ: number,
    surfaceNormalX: number,
    surfaceNormalY: number,
    surfaceNormalZ: number,
    hasSurfaceNormal: number,
    reflectedVelocityDamper: number,
    spreadSpeedHorizontal: number,
    spreadSpeedVertical: number,
    outVelocityX: Float64Array,
    outVelocityY: Float64Array,
    outVelocityZ: Float64Array,
  ) => number;
  /** C1 — terminal projectile consequence classifier. Rust decides
   *  timeout, ground/water impact, terminal reflector, HP-zero,
   *  detonation/expire-FX eligibility, and out-of-bounds removal;
   *  TypeScript applies the compact returned flags and event diffs. */
  readonly projectileTerminalConsequenceBatch: (
    count: number,
    enabled: Uint8Array,
    isProjectileType: Uint8Array,
    isArmed: Uint8Array,
    hasExploded: Uint8Array,
    detonateOnEntityImpact: Uint8Array,
    detonateOnGroundContact: Uint8Array,
    detonateOnExpiry: Uint8Array,
    detonateOnDestroyed: Uint8Array,
    detonateOnReflectorImpact: Uint8Array,
    detonateOnWaterTransition: Uint8Array,
    hasDetonationPayload: Uint8Array,
    directHitThisTick: Uint8Array,
    reflectedProjectile: Uint8Array,
    hitShield: Uint8Array,
    terminalReflectorHit: Uint8Array,
    waterAtImpact: Uint8Array,
    waterSurfaceImpact: Uint8Array,
    waterCompatible: Uint8Array,
    posX: Float64Array,
    posY: Float64Array,
    posZ: Float64Array,
    groundZ: Float64Array,
    hp: Float64Array,
    timeAliveMs: Float64Array,
    maxLifespanMs: Float64Array,
    mapWidth: number,
    mapHeight: number,
    margin: number,
    outReason: Uint8Array,
    outFlags: Uint32Array,
    outZ: Float64Array,
    outHp: Float64Array,
  ) => number;
  /** C1 — terminal projectile effect planner. Rust maps classified
   *  terminal flags plus authored payload booleans to compact side-effect
   *  flags; TypeScript applies those event/entity diffs to JS-owned stores. */
  readonly projectileTerminalEffectPlanBatch: (
    count: number,
    enabled: Uint8Array,
    terminalFlags: Uint32Array,
    terminalReflectorHit: Uint8Array,
    hasExplosion: Uint8Array,
    hasSubmunitions: Uint8Array,
    outEffectFlags: Uint32Array,
  ) => number;
  /** C1 — nearest swept hitbox contact for projectile bodies. Rust
   *  reads unit/building/projectile colliders from the spatial slab,
   *  includes current-tick turret sub-hitboxes from the combat-targeting
   *  slab, and writes one nearest hit per row. */
  readonly projectileHitboxSweepBatch: (
    count: number,
    enabled: Uint8Array,
    startX: Float64Array,
    startY: Float64Array,
    startZ: Float64Array,
    endX: Float64Array,
    endY: Float64Array,
    endZ: Float64Array,
    projectileRadius: Float64Array,
    excludeOffsets: Uint32Array,
    excludeCounts: Uint32Array,
    excludeEntityIds: Int32Array,
    removedProjectileEntityIds: Int32Array,
    maxTargetableRadius: number,
    queryExtra: number,
    currentTick: number,
    outKind: Uint8Array,
    outSlot: Uint32Array,
    outEntityId: Int32Array,
    outT: Float64Array,
    outNormalX: Float64Array,
    outNormalY: Float64Array,
    outNormalZ: Float64Array,
  ) => number;
  /** Grow (never shrink) the single-sweep staging id arrays; growth may
   *  move them, so re-fetch the pointers afterwards. */
  readonly projectileHitboxSweepStagingEnsure: (
    excludeCapacity: number,
    removedCapacity: number,
  ) => void;
  readonly projectileHitboxSweepExcludeIdsPtr: () => number;
  readonly projectileHitboxSweepRemovedIdsPtr: () => number;
  readonly projectileHitboxSweepOutKindPtr: () => number;
  readonly projectileHitboxSweepOutSlotPtr: () => number;
  readonly projectileHitboxSweepOutEntityIdPtr: () => number;
  readonly projectileHitboxSweepOutTPtr: () => number;
  /** (nx, ny, nz) at offsets 0..3. */
  readonly projectileHitboxSweepOutNormalPtr: () => number;
  /** projectileHitboxSweepBatch with count 1, scalar geometry, and
   *  staged id lists / outputs — no per-call slice marshalling. The
   *  collision handler calls the sweep once per projectile per tick,
   *  which made the slice export's ~15 array copies the dominant cost. */
  readonly projectileHitboxSweepSingle: (
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
    projectileRadius: number,
    excludeCount: number,
    removedCount: number,
    maxTargetableRadius: number,
    queryExtra: number,
    currentTick: number,
  ) => number;
  /** Per-tick ballistic integrator for slots 0..count of the
   *  projectile pool. Applies gravity with exact constant-acceleration
   *  position integration and advances pool-owned lifetime in the same
   *  WASM pass. */
  readonly poolStepPackedProjectilesBatch: (count: number, dtSec: number, dtMs: number) => void;
  /** C1 — non-packed projectile/body constant-acceleration integrator.
   *  TypeScript packs guided/D-gun projectile state and acceleration,
   *  this kernel advances position and velocity in one batch. */
  readonly projectileIntegrateStepBatch: (
    count: number,
    posX: Float64Array,
    posY: Float64Array,
    posZ: Float64Array,
    velX: Float64Array,
    velY: Float64Array,
    velZ: Float64Array,
    accelX: Float64Array,
    accelY: Float64Array,
    accelZ: Float64Array,
    airDragCoefficient: Float64Array,
    invMass: Float64Array,
    windX: number,
    windY: number,
    windZ: number,
    dtSec: number,
  ) => number;
  /** C1 — batched server homing guidance for non-packed projectiles.
   *  Each row contains current projectile kinematics, target kinematics,
   *  gravity/thrust config, and an optional intercept-solve flag. Rust
   *  writes thrust acceleration outputs into the same row. */
  readonly projectileHomingGuidanceBatch: (
    rows: Float64Array,
    count: number,
    dtSec: number,
    windX: number,
    windY: number,
    windZ: number,
  ) => number;
  /** C1 — batched homing guidance that writes thrust into projectile
   *  acceleration slabs before the Rust integrator runs. */
  readonly projectileHomingGuidanceApplyBatch: (
    rows: Float64Array,
    projectileIndices: Int32Array,
    accelX: Float64Array,
    accelY: Float64Array,
    accelZ: Float64Array,
    velX: Float64Array,
    velY: Float64Array,
    velZ: Float64Array,
    count: number,
    dtSec: number,
    windX: number,
    windY: number,
    windZ: number,
  ) => number;
  /** Beam/ray range-volume clipping. `rangeVolume` uses
   *  lineShotRange.ts string-to-code mapping. */
  readonly lineShotDistanceToRangeVolume: (
    startX: number,
    startY: number,
    startZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    rangeVolume: number,
  ) => number;
  readonly lineShotRangeEndpoint: (
    out: Float64Array,
    startX: number,
    startY: number,
    startZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    centerX: number,
    centerY: number,
    centerZ: number,
    radius: number,
    rangeVolume: number,
  ) => number;
  /** C1 — terrain-follow vertical thrust acceleration for D-gun waves.
   *  Gravity remains caller-owned. */
  readonly terrainFollowVerticalThrustAccel: (
    positionZ: number,
    velocityZ: number,
    targetZ: number,
    mass: number,
    gravity: number,
    springAccelPerWorldUnit: number,
    dampingRatio: number,
    maxThrustForce: number,
  ) => number;
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
   *  The public TypeScript targeting API derives projectile_acceleration
   *  from the required gravity parameter as (0, 0, -gravity); callers do
   *  not pass air resistance or entity ids into the calculation.
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
  /** AIM-05 — homing thrust acceleration. Per-call (call sites loop
   *  per-projectile already). Writes (thrustX, thrustY, thrustZ) into
   *  out[0..3]. Caller integrates `thrust + (0, 0, -gravity)` into
   *  position and velocity; the kernel never opts out of gravity, it
   *  just decides how much engine thrust to spend cancelling it. */
  readonly computeHomingThrust: (
    out: Float64Array,
    velX: number, velY: number, velZ: number,
    targetX: number, targetY: number, targetZ: number,
    currentX: number, currentY: number, currentZ: number,
    homingTurnRate: number,
    maxThrustAccel: number,
    gravity: number,
    dtSec: number,
  ) => void;
  /** AIM-05b — constant-speed missile guidance. Writes the rotated
   *  velocity vector into out[0..3] while preserving its magnitude. */
  readonly computeConstantSpeedHomingVelocity: (
    out: Float64Array,
    velX: number, velY: number, velZ: number,
    targetX: number, targetY: number, targetZ: number,
    currentX: number, currentY: number, currentZ: number,
    homingTurnRate: number,
    dtSec: number,
  ) => void;
  /** C16 — deterministic metal-deposit placement and connected
   *  resource footprint. TS owns config validation and object
   *  assembly; Rust owns oval/ring layout, snapped grid placement,
   *  explicit-height derivation, null-height terrain anchoring,
   *  candidate counting, and seeded frontier growth. */
  readonly metalDepositCountPlacements: (playerCount: number, rings: Float64Array) => number;
  readonly metalDepositGeneratePlacements: (
    mapWidth: number,
    mapHeight: number,
    playerCount: number,
    extentFraction: number,
    edgeMarginPx: number,
    buildGridCellSize: number,
    metalDepositStep: number,
    resourceCells: number,
    resourceRadiusCells: number,
    rings: Float64Array,
    outPlacements: Float64Array,
  ) => number;
  readonly metalDepositResolveTerrainHeights: (
    mapWidth: number,
    mapHeight: number,
    extentFraction: number,
    terrainConfig: Float64Array,
    explicitFlatZones: Float64Array,
    heightInputs: Float64Array,
    outHeights: Float64Array,
  ) => number;
  /** Map-boundary (PERIMETER ring) fade weight at packed (x, y) pairs —
   *  the renderer's edge shading samples Rust instead of mirroring the
   *  fade math. */
  readonly terrainSampleMapBoundaryFades: (
    mapWidth: number,
    mapHeight: number,
    extentFraction: number,
    terrainConfig: Float64Array,
    pointsXy: Float64Array,
    outFades: Float64Array,
  ) => number;
  /** Vegetation — trees, grass, and seaweed as reclaimable energy
   *  deposits. Rust owns deterministic placement, the prop store, the
   *  BAR gradual-reclaim arithmetic, and the removal log; TS owns
   *  config validation, asset identity, and command plumbing. Every
   *  peer runs `vegetationGenerate` with the same inputs and gets a
   *  bit-identical prop list, so the layout never crosses the wire. */
  readonly vegetationClear: () => void;
  readonly vegetationGenerate: (
    mapWidth: number,
    mapHeight: number,
    configSeed: number,
    areaScaleMin: number,
    areaScaleMax: number,
    defaultMapWidth: number,
    defaultMapHeight: number,
    maxAttemptsPerTarget: number,
    edgeClearance: number,
    assetScaleJitter: number,
    kindRows: Float64Array,
    assetRows: Float64Array,
  ) => number;
  readonly vegetationCount: () => number;
  readonly vegetationReadProps: (outRows: Float64Array) => number;
  readonly vegetationPropState: (index: number, out: Float64Array) => number;
  readonly vegetationQueryCircle: (
    x: number,
    y: number,
    radius: number,
    kindMask: number,
    outIndices: Uint32Array,
  ) => number;
  readonly vegetationRaycast: (
    originX: number,
    originY: number,
    originZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    maxDistance: number,
    kindMask: number,
    out: Float64Array,
  ) => number;
  readonly vegetationApplyReclaimTick: (
    index: number,
    buildPower: number,
    dtSec: number,
    out: Float64Array,
  ) => number;
  readonly vegetationRemovedCount: () => number;
  readonly vegetationReadRemoved: (from: number, out: Uint32Array) => number;
  readonly vegetationStateHash: () => number;
  readonly metalDepositCountResourceCandidates: (radiusCells: number) => number;
  readonly metalDepositGrowResourceCells: (
    originGx: number,
    originGy: number,
    targetCellCount: number,
    radiusCells: number,
    seed: number,
    outCells: Int32Array,
  ) => number;
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
  /** C16 — first pass for terrain mesh cell->triangle index baking.
   *  Fills prefix offsets and returns the required flat ref count,
   *  or -1 when TS should keep the compatibility path. */
  readonly terrainCountCellTriangleRefs: (
    cellsX: number,
    cellsY: number,
    cellSize: number,
    vertexCoords: Float64Array,
    triangleIndices: Int32Array,
    cellTriangleOffsetsOut: Int32Array,
  ) => number;
  /** C16 — second pass for terrain mesh cell->triangle index baking. */
  readonly terrainFillCellTriangleIndices: (
    cellsX: number,
    cellsY: number,
    cellSize: number,
    vertexCoords: Float64Array,
    triangleIndices: Int32Array,
    cellTriangleOffsets: Int32Array,
    cellTriangleIndicesOut: Int32Array,
  ) => number;
  /** C16 — full adaptive equilateral terrain mesh build. Rust owns the
   *  entire topology generation + crack-repair loop; TypeScript only
   *  assembles the config slice and splats the returned flat buffer into
   *  a TerrainTileMap. Returns `[status, vertexCount, triangleCount,
   *  cellOffsetsLen, cellRefsCount, ...sections]`; `[0]` on failure. */
  readonly terrainBuildAdaptiveMesh: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    cellsX: number,
    cellsY: number,
    maxSubdiv: number,
    extentFraction: number,
    terrainConfig: Float64Array,
    flatZones: Float64Array,
    lodConfig: Float64Array,
  ) => Float64Array;
  /** Sample terrain surface height at world-space (x, z). Returns
   *  NaN if no mesh is installed or the triangle walk degenerates;
   *  JS callers treat NaN as "fall back to TS sampler" since that
   *  handles the bilinear-quad-over-noise path. The mesh-installed
   *  return is max(WATER_LEVEL, triangle_height). */
  readonly terrainGetSurfaceHeight: (x: number, z: number) => number;
  /** Raw terrain-bed height at world-space (x, z), without water-plane clamp. */
  readonly terrainGetBedHeight: (x: number, z: number) => number;
  /** Batch raw terrain-bed height sampling for arbitrary world-space points. */
  readonly terrainSampleBedHeights: (
    xs: Float64Array,
    zs: Float64Array,
    heights: Float64Array,
  ) => number;
  /** Sample terrain surface normal at world-space (x, z). Writes
   *  (nx, ny, nz) into out[0..3] and returns 1 on success, 0 if no
   *  mesh is installed or the triangle walk fails. Below-water
   *  samples return (0, 0, 1) — flat water surface normal. */
  readonly terrainGetSurfaceNormal: (x: number, z: number, out: Float64Array) => number;
  /** Raw terrain-bed normal at world-space (x, z), without flattening
   *  below-water samples to the water-surface normal. */
  readonly terrainGetBedNormal: (x: number, z: number, out: Float64Array) => number;
  /** Batch terrain ground sampling for pool-backed body slots.
   *  Writes groundZ[i] and groundNormals[i * 3..i * 3 + 3] for
   *  each awake body slot, using body positions from the WASM
   *  BodyPool. Normals are only computed for near-ground slots.
   *  Returns 1 on complete WASM sampling, 0 when JS should fall
   *  back to the compatibility terrain sampler. */
  readonly terrainSampleGroundForSlots: (
    bodySlots: Uint32Array,
    groundZ: Float64Array,
    groundNormals: Float64Array,
  ) => number;
  /** UnitForceSystem support sampling variant: writes terrain bed height,
   *  terrain bed normal, and a water material flag for each body slot. */
  readonly terrainSampleForceSupportForSlots: (
    bodySlots: Uint32Array,
    groundZ: Float64Array,
    groundNormals: Float64Array,
    materialFlags: Uint32Array,
  ) => number;
  /** Terrain-only water probe batch. Writes center water flags and eight-way
   *  dry masks for each supplied center/radius. Callers that need authored
   *  building/unit support surfaces must use the TS support index instead. */
  readonly terrainSampleWaterProbeMasks: (
    centersX: Float64Array,
    centersY: Float64Array,
    probeRadii: Float64Array,
    centerWaterFlags: Uint32Array,
    dryMasks: Uint32Array,
  ) => number;
  /** C16 — bake the static terrain-buildability grid from the
   *  installed authoritative terrain mesh. TypeScript supplies
   *  config scalars + flat-zone rows and assembles the public object. */
  readonly terrainBakeBuildabilityGrid: (
    mapWidth: number,
    mapHeight: number,
    buildCellSize: number,
    terrainDTerrain: number,
    shelfHeightTolerance: number,
    minNormalUp: number,
    flatZones: Float64Array,
    flagsOut: Uint8Array,
    levelsOut: Int32Array,
  ) => number;
  /** Phase 6c — segment-vs-terrain line-of-sight test. Returns:
   *    0 = ground blocks the ray
   *    1 = segment clears terrain end to end
   *    2 = no mesh installed → caller falls back to TS path
   *  Same step-walk algorithm as hasTerrainLineOfSight in
   *  terrainLineOfSight.ts. Replaces N JS↔WASM groundZ samples with a
   *  single WASM call (saves boundary cost on long LOS rays). */
  readonly terrainHasLineOfSight: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    stepLen: number,
  ) => number;
  /** FOW-OPT-WASM — shared scanline circle fill for fog reveal
   *  bitmaps and alpha maps. Returns 1 if any byte flipped
   *  0 -> 1. TypeScript keeps only orchestration/fallback. */
  readonly fogMarkCircleScanline: (
    bitmap: Uint8Array,
    gridW: number,
    gridH: number,
    cx: number,
    cy: number,
    radius: number,
    cellAnchor: number,
  ) => number;
  readonly fogMarkCircleScanlineRgba: (
    bitmap: Uint8Array,
    rgba: Uint8Array,
    gridW: number,
    gridH: number,
    cx: number,
    cy: number,
    radius: number,
    cellAnchor: number,
    rgbValue: number,
  ) => number;
  /** AIM-08.LOS — one-kernel combat sightline gate. Returns 1 when
   *  terrain plus live unit/building blockers all clear, 0 when any
   *  blocker intersects. Source/target entity ids are excluded so
   *  the ray may start/end inside their colliders. */
  readonly combatHasLineOfSight: (
    sx: number, sy: number, sz: number,
    tx: number, ty: number, tz: number,
    terrainStepLen: number,
    entityLineWidth: number,
    sourceEntityId: number,
    targetEntityId: number,
  ) => number;
  /** Phase 7 — SpatialGrid 3D voxel hash in WASM linear memory.
   *  Big-bang replacement for SpatialGrid.ts. Same public API on
   *  the JS wrapper; per-query traffic is one WASM call + one
   *  Uint32Array view over the scratch buffer. EntityId↔slot map
   *  is JS-side; Rust only sees u32 slot ids. */
  readonly spatial: SpatialApi;
  /** [23] Canonical high-count entity state slab. Slot space is shared
   *  with SpatialGrid, BodyPool/turret consumers store references to
   *  those slots, and JS Entity objects remain compatibility views. */
  readonly entityState: EntityStateApi;
  /** Phase 9 — Pathfinder A* over the build/walk grid. Mask + CC +
   *  A* + LOS smoothing all in one WASM call. */
  readonly pathfinder: PathfinderApi;
  /** Phase 10 D.1b — Turret sub-pool. Per-entity turret arrays
   *  indexed at fixed offsets and keyed by the shared entity-state
   *  slot. */
  readonly turretPool: TurretPoolApi;
  /** AIM-08.1 — Targeting input slabs, stamped from JS each tick.
   *  Source of truth for the scheduled Rust targeting kernels. JS
   *  still mirrors slab results back to Turret objects for downstream
   *  rendering/firing/snapshot consumers. */
  readonly combatTargeting: CombatTargetingApi;
  /** Materials Are Independent Of Shape — one pool holds every active
   *  shield surface, sphere and flat-panel alike, rebuilt each tick.
   *  Spheres come from getActiveShields(); flat panels are stamped
   *  through the per-unit + per-panel arrays. The clearance / projectile
   *  kernels read both shapes and apply the same material policy. */
  readonly shieldSurfacePool: ShieldSurfacePoolApi;
  /** Phase 10 D.3j — Entity-DTO encoder kernels. Each successive
   *  commit handles one more field group of the snapshot DTO; the
   *  ported portion is verified byte-equal against
   *  @msgpack/msgpack's `ignoreUndefined: true` output on every
   *  dev build. No consumer reads the bytes yet. */
  readonly snapshotEncode: SnapshotEncodeApi;
  /** Two adjacent authoritative fixed-tick poses plus one shared render
   *  interpolation alpha. This is presentation-only and is never read by
   *  gameplay. */
  readonly presentation: PresentationApi;
  /** Render-pose scratch kernels. These are presentation-side matrix
   *  transforms whose inputs come from client render packets and whose
   *  outputs are consumed synchronously by Three.js instance writers. */
  readonly renderPose: RenderPoseApi;
  /** The WASM linear memory — JS wrapper code constructs typed-array
   *  views over this for zero-copy result reads. Re-bind views after
   *  any operation that might grow the memory (rare). */
  readonly memory: WebAssembly.Memory;
}
