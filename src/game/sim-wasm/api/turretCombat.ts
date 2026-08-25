// Simulation WASM turretCombat API surface.

import wireEnums from '../../../wireEnums.json';

export interface TurretPoolApi {
  init: (initialEntityCapacity: number) => void;
  clear: () => void;
  /** Max turret count per entity (mirrors TURRET_POOL_MAX_PER_ENTITY = 8). */
  maxPerEntity: () => number;
  setCount: (entitySlot: number, count: number) => void;
  setTurret: (
    entitySlot: number,
    turretIdx: number,
    entityId: number,
    parentId: number,
    rootHostId: number,
    mountIndex: number,
    rotation: number,
    angularVelocity: number,
    angularAcceleration: number,
    pitch: number,
    pitchVelocity: number,
    pitchAcceleration: number,
    shieldRange: number,
    targetId: number,
  ) => void;
  unsetEntity: (entitySlot: number) => void;
  count: (entitySlot: number) => number;
  entityCapacity: () => number;
  readonly countPerEntityPtr: () => number;
  readonly entityIdPtr: () => number;
  readonly parentIdPtr: () => number;
  readonly rootHostIdPtr: () => number;
  readonly mountIndexPtr: () => number;
  readonly rotationPtr: () => number;
  readonly angularVelocityPtr: () => number;
  readonly angularAccelerationPtr: () => number;
  readonly pitchPtr: () => number;
  readonly pitchVelocityPtr: () => number;
  readonly pitchAccelerationPtr: () => number;
  readonly shieldRangePtr: () => number;
  readonly targetIdPtr: () => number;
}

/** AIM-08.1 — Entity-flag bits packed into the combat-targeting entity
 *  slab's `flags` field. Mirrors `CT_ENTITY_FLAG_*` in lib.rs. */
export const CT_ENTITY_FLAG_ALIVE = 1 << 0;
export const CT_ENTITY_FLAG_HAS_COMBAT = 1 << 1;
export const CT_ENTITY_FLAG_FIRE_ENABLED = 1 << 2;
export const CT_ENTITY_FLAG_BUILDABLE_COMPLETE = 1 << 3;
export const CT_ENTITY_FLAG_CLOAKED = 1 << 4;
/** Host refuses every lock-on while a friendly entity sits directly above it
 *  (stamped from the host blueprint's preventLockOnIfMyTeamIsAboveMe). */
export const CT_ENTITY_FLAG_PREVENT_LOCKON_IF_TEAM_ABOVE = 1 << 5;
export const CT_ENTITY_FLAG_RADAR_STEALTH = 1 << 6;
export const CT_ENTITY_FLAG_SONAR_STEALTH = 1 << 7;

/** AIM-08.1 — Turret-config-flag bits packed into the combat-targeting
 *  turret slab's `configFlags` field. Mirrors `CT_TURRET_CFG_*`. */
export const CT_TURRET_CFG_REQUIRES_NON_OBSTRUCTED_LOS = 1 << 0;
export const CT_TURRET_CFG_NEEDS_BALLISTIC = 1 << 1;
export const CT_TURRET_CFG_VERTICAL_LAUNCHER = 1 << 2;
export const CT_TURRET_CFG_IS_MANUAL_FIRE = 1 << 3;
export const CT_TURRET_CFG_PASSIVE = 1 << 4;
export const CT_TURRET_CFG_NON_ATTACK_EMITTER = 1 << 5;
export const CT_TURRET_CFG_SHOT_IS_FORCE = 1 << 6;
export const CT_TURRET_CFG_HAS_TRACKING_RANGE = 1 << 7;
export const CT_TURRET_CFG_HOST_CONTROLLED = 1 << 8;
export const CT_TURRET_CFG_RANGE_BOTTOM_UNBOUNDED = 1 << 9;
export const CT_TURRET_CFG_RANGE_TOP_UNBOUNDED = 1 << 10;
/** Packed range-mode value: fixed water-surface ceiling with no depth floor.
 *  Bit 10 by itself was intentionally unused; bits 9+10 remain the existing
 *  fully-unbounded cylinder mode. */
export const CT_TURRET_CFG_RANGE_TOP_WATER_AND_BOTTOM_UNBOUNDED = 1 << 10;
export const CT_TURRET_CFG_RANGE_SPHERE = 1 << 11;
export const CT_TURRET_CFG_REQUIRED_ENGAGED_FOR_FIGHT_STOP = 1 << 12;
export const CT_TURRET_CFG_IGNORES_FORCE_MATERIAL_SIGHT_OBSTRUCTION = 1 << 13;
export const CT_TURRET_CFG_RAY_BISECT_TURRET_AND_BODY = 1 << 14;
/** Turret may only lock enemies seen with full sight (not radar-only). */
export const CT_TURRET_CFG_REQUIRES_FULL_SIGHT = 1 << 15;
/** Local yaw has no hard stops. */
export const CT_TURRET_CFG_YAW_CONTINUOUS = 1 << 16;
/** Host-only and slaved mounts never independently auto-acquire. */
export const CT_TURRET_CFG_NO_AUTO_ACQUIRE = 1 << 17;
/** Constant-speed guided shots aim at their velocity interception point. */
export const CT_TURRET_CFG_CONSTANT_SPEED_LEAD = 1 << 18;
/** A moving parent joint may absorb residual station yaw. */
export const CT_TURRET_CFG_HOST_YAW_ASSIST = 1 << 19;
/** Exhaustive, unordered emission source->target medium routes. */
const CT_TURRET_CFG_ROUTE_ABOVE_TO_ABOVE = 1 << 20;
const CT_TURRET_CFG_ROUTE_ABOVE_TO_UNDERWATER = 1 << 21;
const CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE = 1 << 22;
const CT_TURRET_CFG_ROUTE_UNDERWATER_TO_UNDERWATER = 1 << 23;
export const CT_TURRET_CFG_ROUTE_MASK =
  CT_TURRET_CFG_ROUTE_ABOVE_TO_ABOVE |
  CT_TURRET_CFG_ROUTE_ABOVE_TO_UNDERWATER |
  CT_TURRET_CFG_ROUTE_UNDERWATER_TO_ABOVE |
  CT_TURRET_CFG_ROUTE_UNDERWATER_TO_UNDERWATER;

/** AIM-08.1 — FSM state encodings. Single-sourced from wireEnums.json (the
 *  same file Rust generates its CT_TURRET_STATE_* constants from), so the
 *  TS sim-wasm bridge, the network wire codes, and the Rust kernels can't
 *  drift. */
export const CT_TURRET_STATE_IDLE = wireEnums.turretState.idle;
export const CT_TURRET_STATE_TRACKING = wireEnums.turretState.tracking;
export const CT_TURRET_STATE_ENGAGED = wireEnums.turretState.engaged;

/** C1 movement/combat halt modes. Single-sourced from wireEnums.json
 *  because the mode byte crosses the JS/WASM boundary. */
export const CT_COMBAT_HALT_MODE_ANY_ENGAGED = wireEnums.combatHaltMode.anyEngaged;
export const CT_COMBAT_HALT_MODE_FIGHT_REQUIRED = wireEnums.combatHaltMode.fightRequired;

/** LOCK-ON-03 — Per-turret lock-on exclusion masks compiled from each
 *  turret blueprint's authored exclusion arrays. Mirrors
 *  `CT_LOCK_ON_REL_INCLUDE_*` and `CT_LOCK_ON_FAM_INCLUDE_*` in Rust. */
export const CT_LOCK_ON_REL_INCLUDE_FRIENDLY = 1 << 0;
export const CT_LOCK_ON_REL_INCLUDE_ENEMY = 1 << 1;
export const CT_LOCK_ON_FAM_INCLUDE_BUILDINGS = 1 << 0;
export const CT_LOCK_ON_FAM_INCLUDE_UNITS = 1 << 1;
export const CT_LOCK_ON_FAM_INCLUDE_TURRETS = 1 << 2;
/** Reserved compatibility bit; new blueprint policy emits buildings. */
export const CT_LOCK_ON_FAM_INCLUDE_TOWERS = 1 << 3;
export const CT_LOCK_ON_FAM_INCLUDE_SHOTS = 1 << 5;

/** LOCK-ON-04 — Reciprocal lock-on candidacy modes. Mirrors
 *  `CT_LOCK_ON_RECIPROCAL_*` in Rust. */
export const CT_LOCK_ON_RECIPROCAL_IGNORE = 0;
export const CT_LOCK_ON_RECIPROCAL_REQUIRE = 1;
export const CT_LOCK_ON_RECIPROCAL_PREFER_REACQUIRE = 2;
export const CT_LOCK_ON_RECIPROCAL_PREFER_HOLD = 3;

/** LOCK-ON-03 — Per-entity family encoding. Mirrors
 *  `CT_ENTITY_FAMILY_*` in Rust. NONE is the cleared/unstamped sentinel
 *  used after `clear()` so a stale row never matches a real family. */
export const CT_ENTITY_FAMILY_NONE = 0;
export const CT_ENTITY_FAMILY_BUILDING = 1;
export const CT_ENTITY_FAMILY_UNIT = 2;
/** Reserved compatibility tag; new runtime stamping uses BUILDING. */
export const CT_ENTITY_FAMILY_TOWER = 3;
export const CT_ENTITY_FAMILY_SHOT = 4;

/** LOCK-ON-03 — Sentinel for `entity_blueprint_code` when the family is
 *  NONE. Mirrors `CT_BLUEPRINT_CODE_NONE` in Rust. */
export const CT_BLUEPRINT_CODE_NONE = 0xff;

/** LOCK-ON-03 — Maximum blueprint count that can be addressed by the
 *  per-turret level-1 u64 bitmask (one bit per blueprint code). */
export const CT_LOCK_ON_LEVEL1_MASK_CAPACITY = 64;

/** AIM-08.5 — `out_modes` byte the scheduler writes per queued entity.
 *  Mirrors `CT_TARGETING_TICK_MODE_*` in Rust. The writeback path uses
 *  these to dispatch JS-only bookkeeping (activity flags, priority
 *  command cleanup) after the slab is authoritative for the FSM. */
export const CT_TARGETING_TICK_MODE_AUTO = 0;
export const CT_TARGETING_TICK_MODE_CLEAR_LOCKS = 3;
export const CT_TARGETING_TICK_MODE_SKIP = 255;

/** AIM-08.1 — Targeting input slabs. The JS stamping pass populates
 *  these once per tick before the scheduled Rust targeting batch
 *  runs; AIM-08.2..5 added the SoA kernels that read from them, and
 *  the slab is now authoritative for targeting FSM state.
 *  Ranges land pre-squared as authored radii. Targeting kernels apply
 *  them as vertical cylinders: horizontal radius R, top cap mount.z + R,
 *  and either bounded or unbounded vertical caps depending on
 *  the turret blueprint; `outermostAcquire` is the raw radius the
 *  broadphase spatial query wants. */
export interface CombatTargetingApi {
  init: (initialEntityCapacity: number) => void;
  clear: () => void;
  /** Starts a tick stamp while retaining stable entity-id slot mappings. */
  beginStamp: () => void;
  /** Mirrors `COMBAT_TARGETING_MAX_TURRETS_PER_ENTITY` (= 8). */
  maxTurretsPerEntity: () => number;
  entityCapacity: () => number;
  setEntity: (
    entitySlot: number,
    entityId: number,
    ownerPlayerId: number,
    teamId: number,
    viewMask: number,
    posX: number,
    posY: number,
    posZ: number,
    velX: number,
    velY: number,
    velZ: number,
    groundZ: number,
    rotCos: number,
    rotSin: number,
    surfaceNx: number,
    surfaceNy: number,
    surfaceNz: number,
    suspensionOffsetX: number,
    suspensionOffsetY: number,
    suspensionOffsetZ: number,
    radiusHitbox: number,
    aabbHalfX: number,
    aabbHalfY: number,
    aabbHalfZ: number,
    hp: number,
    flags: number,
    family: number,
    blueprintCode: number,
    lockOnRelationshipIncludeMask: number,
    lockOnEntityFamilyIncludeMask: number,
    lockOnBuildingIncludeMask: bigint,
    lockOnTowerIncludeMask: bigint,
    lockOnUnitIncludeMask: bigint,
    lockOnTurretIncludeMask: bigint,
    lockOnShotIncludeMask: bigint,
    sensorSourceX: number,
    sensorSourceY: number,
    sensorSourceZ: number,
    fullVisionAboveWaterRadius: number,
    fullVisionUnderwaterRadius: number,
    radarRadius: number,
    sonarRadius: number,
    detectorAboveWaterRadius: number,
    detectorUnderwaterRadius: number,
    radarJamRadius: number,
    sonarJamRadius: number,
    detectionPadding: number,
    priorityTargetId: number,
    priorityPointPresent: number,
    priorityPointX: number,
    priorityPointY: number,
    priorityPointZ: number,
    scheduledProbeTick: number,
    turretCount: number,
  ) => void;
  unsetEntity: (entitySlot: number) => void;
  /** Rebuilds targeting observability masks from stamped sight/radar/sonar
   *  sources. Must run after all entities are stamped and before any
   *  targeting scheduler tick. */
  rebuildObservationMasks: () => void;
  /** Same as rebuildObservationMasks, but walks only the stamped source
   *  slots supplied by JS. The caller must have cleared the targeting
   *  pool earlier in the tick. */
  rebuildObservationMasksForSources: (sourceSlots: Uint32Array) => void;
  /** Snapshot visibility collector over the native observation masks.
   *  Writes compact [visible ids, radar ids, LOS slots] output rows and
   *  returns the number of handled entity rows, or a negative required
   *  capacity if an output buffer is too small. */
  collectObservationVisibility: (
    viewMask: number,
    targetSlots: Uint32Array,
    visibleIdsOut: Int32Array,
    visibleSlotsOut: Uint32Array,
    radarIdsOut: Int32Array,
    radarSlotsOut: Uint32Array,
    losSlotsOut: Uint32Array,
    countsOut: Uint32Array,
  ) => number;
  /** Adds a temporary full-sight source, currently scan pulses. Full
   *  sight is included in radar-level coverage. */
  addSensorObservationCircle: (
    ownerPlayerId: number,
    teamId: number,
    x: number,
    y: number,
    z: number,
    radius: number,
  ) => void;
  setWind: (x: number, y: number, z: number) => void;
  setTurret: (
    entitySlot: number,
    turretIdx: number,
    turretEntityId: number,
    turretParentId: number,
    turretRootHostId: number,
    turretMountIndex: number,
    mountX: number,
    mountY: number,
    mountZ: number,
    radiusHitbox: number,
    mountVx: number,
    mountVy: number,
    mountVz: number,
    rotation: number,
    pitch: number,
    angularVelocity: number,
    pitchVelocity: number,
    hostPieceYaw: number,
    hostPieceYawVelocity: number,
    parentYaw: number,
    yawMin: number,
    yawMax: number,
    pitchMin: number,
    pitchMax: number,
    fireMaxAcquireSq: number,
    fireMaxReleaseSq: number,
    fireMinAcquireSq: number,
    fireMinReleaseSq: number,
    trackingAcquireSq: number,
    trackingReleaseSq: number,
    outermostAcquire: number,
    mountOffset2d: number,
    localMountX: number,
    localMountY: number,
    localMountZ: number,
    worldPosTick: number,
    configFlags: number,
    targetRescorePeriodTicks: number,
    dps: number,
    projectileSpeed: number,
    projectileLinearDampingRate: number,
    projectileUsesAirMedium: number,
    muzzleForwardOffset: number,
    arcPreference: number,
    maxTimeSec: number,
    groundAimFraction: number,
    underOnly: number,
    turretBlueprintCode: number,
    lockonRelationshipMask: number,
    lockonEntityFamilyMask: number,
    lockonBuildingMask: bigint,
    lockonTowerMask: bigint,
    lockonUnitMask: bigint,
    lockonTurretMask: bigint,
    lockonShotMask: bigint,
    lockonReciprocalMode: number,
    taskTargetId: number,
    taskPointActive: number,
    slavedToMountIndex: number,
  ) => void;
  /** AIM-08.5 — Refresh the slab's per-entity active/firing turret
   *  masks for `entitySlot`. Reads slab FSM target/state + angular/
   *  pitch velocity + config flags inline; downstream readers
   *  (turretSystem, projectileSystem) consume the result via the
   *  entityActiveTurretMask / entityFiringTurretMask views. */
  refreshActivityMasksForEntity: (entitySlot: number) => void;
  /** AIM-08.5 — Batch activity-mask refresh. Same per-entity logic as
   *  refreshActivityMasksForEntity, walked over a Uint32Array of slot
   *  indices in one boundary call. */
  refreshActivityMasksBatch: (entitySlots: Uint32Array) => void;
  /** AIM-08.5 — Slab-side mid-tick turret state clear. JS calls this
   *  when the rotation pass discovers a ballistic-fail or other reason
   *  to drop a turret's lock, so the next activity-mask refresh sees
   *  the cleared state. Mirrors `weapon.state = 'idle'` plus
   *  `weapon.target = null` for the slab. */
  clearTurretFsm: (entitySlot: number, turretIdx: number) => void;
  entityFlags: (entitySlot: number) => number;
  turretCount: (entitySlot: number) => number;
  /** AIM-08.5 — Rust Pass 0 mount kinematics. Updates the slab's
   *  turret world mount position/velocity for one stamped entity. */
  updateMountKinematics: (
    entitySlot: number,
    currentTick: number,
    dtMs: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
  ) => void;
  /** AIM-08.5 — batch Pass 0 mount kinematics over a world-order run
   *  of armed entities. Same slab mutation as updateMountKinematics,
   *  but with one boundary crossing for the run. */
  updateMountKinematicsBatch: (
    entitySlots: Uint32Array,
    currentTick: number,
    dtMs: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
  ) => void;
  /** AIM-08.5 — slab-backed observability check. Returns 1 if
   *  `viewerPlayerId` can observe the entity addressed by `targetId`
   *  (alive + (own-team OR covered by the viewer's sight/radar)),
   *  0 otherwise. */
  canPlayerObserveEntity: (
    targetId: number,
    viewerPlayerId: number,
  ) => number;
  /** C1 — Rust-owned per-turret combat halt classifier for movement.
   *  Direct attacks halt only for the ordered target id; point intent uses
   *  the priority-point flag. Fight/patrol use per-mount stop flags. */
  haltDecisionBatch: (
    entitySlots: Uint32Array,
    modes: Uint8Array,
    priorityPointPresent: Uint8Array,
    expectedTargetIds: Int32Array,
    outShouldHalt: Uint8Array,
  ) => number;
  readonly entityIdPtr: () => number;
  readonly entityOwnerPlayerIdPtr: () => number;
  readonly entityPosXPtr: () => number;
  readonly entityPosYPtr: () => number;
  readonly entityPosZPtr: () => number;
  readonly entityVelXPtr: () => number;
  readonly entityVelYPtr: () => number;
  readonly entityVelZPtr: () => number;
  readonly entityRadiusHitboxPtr: () => number;
  readonly entityHpPtr: () => number;
  readonly entityFlagsPtr: () => number;
  readonly entityActiveTurretMaskPtr: () => number;
  readonly entityFiringTurretMaskPtr: () => number;
  readonly entityTeamAirSightMaskPtr: () => number;
  readonly entityTeamWaterSightMaskPtr: () => number;
  readonly entityTeamAirRadarMaskPtr: () => number;
  readonly entityTeamWaterSonarMaskPtr: () => number;
  readonly entitySensorCoverageMaskPtr: () => number;
  readonly entityFullSightCoverageMaskPtr: () => number;
  readonly entityDetectorCoverageMaskPtr: () => number;
  readonly turretCountPerEntityPtr: () => number;
  readonly turretEntityIdPtr: () => number;
  readonly turretParentIdPtr: () => number;
  readonly turretRootHostIdPtr: () => number;
  readonly turretMountIndexPtr: () => number;
  readonly turretMountXPtr: () => number;
  readonly turretMountYPtr: () => number;
  readonly turretMountZPtr: () => number;
  readonly turretMountVxPtr: () => number;
  readonly turretMountVyPtr: () => number;
  readonly turretMountVzPtr: () => number;
  readonly turretWorldPosTickPtr: () => number;
  readonly turretRotationPtr: () => number;
  readonly turretPitchPtr: () => number;
  readonly turretAngularVelocityPtr: () => number;
  readonly turretPitchVelocityPtr: () => number;
  readonly turretHostPieceYawPtr: () => number;
  readonly turretHostPieceYawVelocityPtr: () => number;
  readonly turretStatePtr: () => number;
  readonly turretTargetIdPtr: () => number;
  readonly turretCooldownPtr: () => number;
  readonly turretBurstCooldownPtr: () => number;
  readonly turretFireMaxAcquireSqPtr: () => number;
  readonly turretFireMaxReleaseSqPtr: () => number;
  readonly turretFireMinAcquireSqPtr: () => number;
  readonly turretFireMinReleaseSqPtr: () => number;
  readonly turretTrackingAcquireSqPtr: () => number;
  readonly turretTrackingReleaseSqPtr: () => number;
  readonly turretOutermostAcquirePtr: () => number;
  readonly turretLosBlockedTicksPtr: () => number;
  readonly turretConfigFlagsPtr: () => number;
  readonly turretBallisticHasSolutionPtr: () => number;
  readonly turretBallisticFlightTimePtr: () => number;
  readonly turretBallisticLaunchVxPtr: () => number;
  readonly turretBallisticLaunchVyPtr: () => number;
  readonly turretBallisticLaunchVzPtr: () => number;
  readonly turretBallisticYawPtr: () => number;
  readonly turretBallisticPitchPtr: () => number;
  readonly turretBallisticAimXPtr: () => number;
  readonly turretBallisticAimYPtr: () => number;
  readonly turretBallisticAimZPtr: () => number;
  /** AIM-08.4 — solve ballistic turret aim by reading the turret
   *  mount kinematics from the combat-targeting slab at
   *  (entitySlot, turretIdx), then writing reusable outputs back to
   *  the same slab. `arcPreference`: 0 = low, 1 = high. Returns 1
   *  when a real solution was written, 0 when the fallback pose was
   *  written as a no-solution result. */
  readonly solveBallisticAim: (
    entitySlot: number,
    turretIdx: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    targetVx: number,
    targetVy: number,
    targetVz: number,
    projectileSpeed: number,
    projectileLinearDampingRate: number,
    gravity: number,
    arcPreference: number,
    maxTimeSecOrZero: number,
    fallbackYaw: number,
    fallbackPitch: number,
  ) => number;
  /** AIM-08.5 — Rust auto-targeting pre-scan. Writes
   *  cachedFireRanks[i], cachedFireDistSqs[i], and outF64[0..2] =
   *  [maxAcquireRange, maxWeaponOffset]. Returns 1 when any turret
   *  needs a batched enemy query. */
  readonly prepareAutoScan: (
    entitySlot: number,
    currentTick: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    outF64: Float64Array,
  ) => number;
  /** AIM-08.5 — Rust-owned candidate-pass gate prep. Return flags:
   *  bit 0 = at least one turret should scan candidates, bit 1 = at
   *  least one passive turret needs shield-panel candidate scores. */
  readonly prepareFireChoiceFsmInputs: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    applyMask: Uint8Array,
    seedRanks: Uint8Array,
    seedDistSqs: Float64Array,
    seedShieldPanelScores: Float64Array,
  ) => number;
  readonly prepareAcquisitionChoiceFsmInputs: (
    entitySlot: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    applyMask: Uint8Array,
    seedRanks: Uint8Array,
    seedDistSqs: Float64Array,
    seedShieldPanelScores: Float64Array,
  ) => number;
  /** AIM-08.3 — Rust target preference rank helper. `rankMode`: 0 =
   *  fire-only, 1 = acquisition; `edge`: 0 = acquire, 1 = release.
   *  `distSq` is horizontal distance squared; this compatibility helper
   *  assumes any vertical range-volume gates were applied by the caller. */
  readonly rankTarget: (
    rankMode: number,
    edge: number,
    fireMaxAcquire: number,
    fireMaxRelease: number,
    hasFireMin: number,
    fireMinAcquire: number,
    fireMinRelease: number,
    hasTracking: number,
    trackingAcquire: number,
    trackingRelease: number,
    distSq: number,
    targetRadius: number,
  ) => number;
  /** AIM-08.5 — Batch target candidate score/ranking kernel with
   *  internal fire-gate evaluation. Replaces the legacy callback-
   *  based version. Candidate aim points are resolved from the slab
   *  AABB; LOS / ballistic / FF / shield-panel gates all run in Rust
   *  via the shared `compute_turret_gates_for_aim_point` helper. */
  readonly computeAndChooseBestCandidatesBatch: (
    entitySlot: number,
    rankMode: number,
    minimumRank: number,
    applyMask: Uint8Array,
    seedRanks: Uint8Array,
    seedDistSqs: Float64Array,
    seedShieldPanelScores: Float64Array,
    candidateCount: number,
    candidateIds: Int32Array,
    candidatePosX: Float64Array,
    candidatePosY: Float64Array,
    candidatePosZ: Float64Array,
    candidateRadius: Float64Array,
    candidateShieldPanelScore: Float64Array,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    outTargetIds: Int32Array,
    outRanks: Uint8Array,
  ) => void;
  /** AIM-08.5 — Rust-owned targeting FSM transition writes. JS still
   *  supplies object-owned expensive gates during migration; these
   *  calls mutate the combat-targeting slab's target/state/LOS tuple. */
  readonly clearTurretLock: (entitySlot: number, turretIdx: number) => void;
  readonly clearEntityLocks: (entitySlot: number) => void;
  readonly applyPriorityPointFsmBatch: (
    entitySlot: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    applyMask: Uint8Array,
    losClear: Uint8Array,
    ballisticClear: Uint8Array,
    shieldClear: Uint8Array,
  ) => void;
  /** AIM-08.5 — unified priority-point gate compute + FSM apply for one
   *  entity. Rust iterates the slab turrets, computes LOS / ballistic /
   *  shield / shield-panel gates (calling the existing kernels in-
   *  process), and applies the priority-point FSM transition in the
   *  same pass. Saves ~3 cross-boundary calls per weapon vs the legacy
   *  per-turret path.
   *
   *  Per-turret ballistic gate config is read from the targeting slab. */
  readonly computeAndApplyPriorityPointFsmBatch: (
    entitySlot: number,
    pointX: number,
    pointY: number,
    pointZ: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
  ) => void;
  /** AIM-08.5 — unified attack-entity priority gate compute + FSM
   *  apply. TS resolves compatibility-wrapper aim points; the scheduled
   *  Rust path resolves body/AABB/turret-family aim points from the slab and does LOS /
   *  ballistic / FF / shield-panel / FSM. Passive-mirror `mirror_valid`
   *  is computed in Rust by walking the target's turrets via the slab —
   *  no JS pre-pass needed. */
  readonly computeAndApplyPriorityTargetFsmBatch: (
    entitySlot: number,
    targetId: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    aimX: Float64Array,
    aimY: Float64Array,
    aimZ: Float64Array,
  ) => void;
  /** AIM-08.5 — unified existing-lock gate compute + FSM apply. Each
   *  turret's current target is read from the slab; TS supplies only
   *  the per-turret aim point. Rust computes observability +
   *  passive shield-panel_valid + shield-panel clearance + LOS / FF /
   *  ballistic from slab data and derives sight_blocked internally. */
  readonly computeAndApplyValidateExistingLockFsmBatch: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    aimX: Float64Array,
    aimY: Float64Array,
    aimZ: Float64Array,
  ) => void;
  readonly applyPriorityTargetFsmBatch: (
    entitySlot: number,
    targetId: number,
    applyMask: Uint8Array,
    mirrorValid: Uint8Array,
    losClear: Uint8Array,
    ballisticClear: Uint8Array,
    shieldClear: Uint8Array,
  ) => void;
  readonly validateExistingLockFsmBatch: (
    entitySlot: number,
    applyMask: Uint8Array,
    targetObservable: Uint8Array,
    mirrorValid: Uint8Array,
    ballisticClear: Uint8Array,
    losBlocked: Uint8Array,
    losDropGraceTicks: number,
  ) => void;
  readonly applyFireChoiceFsmBatch: (
    entitySlot: number,
    applyMask: Uint8Array,
    targetIds: Int32Array,
  ) => void;
  readonly applyAcquisitionChoiceFsmBatch: (
    entitySlot: number,
    applyMask: Uint8Array,
    targetIds: Int32Array,
    ranks: Uint8Array,
  ) => void;
  /** AIM-08.5 — combined existing-lock validation + auto-scan tick.
   *  Replaces `computeAndApplyValidateExistingLockFsmBatch` →
   *  `prepareAutoScan` with one boundary call. Returns 1 when at
   *  least one turret still wants the spatial candidate scan, 0
   *  otherwise; `outF64[0..2]` receives `[maxAcquireRange,
   *  maxWeaponOffset]` and `cachedFireRanks` / `cachedFireDistSqs`
   *  are filled for the auto-mode candidate tick. */
  readonly existingLockAndAutoScanTick: (
    entitySlot: number,
    sourceEntityId: number,
    currentTick: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    aimX: Float64Array,
    aimY: Float64Array,
    aimZ: Float64Array,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    outF64: Float64Array,
  ) => number;
  /** AIM-08.5 — collapses the fire-choice + acquisition pair (six
   *  per-entity boundary calls in the legacy flow) into a single Rust
   *  tick. Scratch buffers for apply mask / seed ranks / choose-best
   *  outputs live on the kernel's stack; per-turret ballistic config
   *  is read from the targeting slab. */
  readonly autoModeCandidateTick: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    candidateCount: number,
    candidateIds: Int32Array,
    candidatePosX: Float64Array,
    candidatePosY: Float64Array,
    candidatePosZ: Float64Array,
    candidateRadius: Float64Array,
    candidateShieldPanelScore: Float64Array,
  ) => void;
  /** AIM-08.5 — auto-mode candidate tick with Rust-owned spatial
   *  broadphase. JS passes the auto-scan radius result and the kernel
   *  queries the WASM spatial grid, stamps candidate SoA from the
   *  combat slab, then runs autoModeCandidateTick internally. */
  readonly autoModeSpatialCandidateTick: (
    entitySlot: number,
    sourceEntityId: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    needsSpatialQuery: number,
    maxAcquireRange: number,
    maxWeaponOffset: number,
    maxTargetableRadius: number,
  ) => void;
  /** AIM-08.5 — multi-entity auto-mode batch. Entity slots and source
   *  IDs are one row per queued entity; aim/cached arrays are flat
   *  entity-major rows of maxTurretsPerEntity entries. */
  readonly autoModeSpatialCandidateTickBatch: (
    entitySlots: Uint32Array,
    sourceEntityIds: Int32Array,
    currentTick: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    aimX: Float64Array,
    aimY: Float64Array,
    aimZ: Float64Array,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    maxTargetableRadius: number,
  ) => void;
  /** AIM-08.5 — mixed-mode world-order FSM batch. TS still prepares
   *  object-owned command/cooldown state; Rust resolves per-turret
   *  aim points and dispatches auto-mode, priority-point, and
   *  priority-target targeting work across the queued entities. */
  readonly tickBatch: (
    entitySlots: Uint32Array,
    sourceEntityIds: Int32Array,
    currentTick: number,
    modes: Uint8Array,
    priorityTargetIds: Int32Array,
    priorityPointX: Float64Array,
    priorityPointY: Float64Array,
    priorityPointZ: Float64Array,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    shieldObstructionActive: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    maxTargetableRadius: number,
  ) => void;
  /** AIM-08.5 — scheduled mixed-mode world-order targeting batch.
   *  Rust chooses skip / hold-fire clear / priority-point /
   *  priority-target / auto from slab-backed source slots, reading
   *  per-entity priority + probe-tick inputs from the slab, updating
   *  mount kinematics for processed rows, refreshing activity masks
   *  inline, and writing compact mode / active-work outputs for the
   *  JS bookkeeping pass. */
  readonly scheduleAndTickBatch: (
    sourceSlots: Uint32Array,
    currentTick: number,
    dtMs: number,
    turretShieldPanelsEnabled: number,
    turretShieldSpheresEnabled: number,
    /** Per-player shield-aware targeting upgrade bits
     *  (`combat_targeting_player_bit` convention: bit `playerId - 1`). */
    shieldObstructionPlayerMask: number,
    terrainStepLen: number,
    entityLineWidth: number,
    gravity: number,
    losDropGraceTicks: number,
    /** Phase period for priority hosts' TRAILING fallback scans (the same
     *  reacquire cadence idle hosts use), sharded by entity id. */
    reacquirePeriodTicks: number,
    cachedFireRanks: Uint8Array,
    cachedFireDistSqs: Float64Array,
    maxTargetableRadius: number,
    outHadCooldown: Uint8Array,
    outModes: Uint8Array,
    outHasActiveWork: Uint8Array,
  ) => void;
}

/** AIM-08.1 — Shield input slab. Compact list of `count` active
 *  fields, rebuilt from scratch each tick from the JS-side
 *  getActiveShields(). Owner entity id sentinels: -1 means the
 *  field is not tied to a stamped entity. */
/** Materials Are Independent Of Shape — one pool, one material, two shapes.
 *  Sphere surfaces live in the flat per-field arrays (`setField` /
 *  `setFieldCount`); flat-panel surfaces live in the per-unit + per-panel
 *  arrays (`setUnit` / `setPanel`). The clearance + projectile kernels read
 *  all groups and apply the same reflection / occlusion policy. */
