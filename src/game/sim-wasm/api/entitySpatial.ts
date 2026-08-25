// Simulation WASM entitySpatial API surface.

export const SPATIAL_KIND_UNIT = 1;
export const SPATIAL_KIND_BUILDING = 2;
export const SPATIAL_KIND_PROJECTILE = 3;

export const ENTITY_STATE_KIND_BUILDING = 1;
export const ENTITY_STATE_KIND_UNIT = 2;
export const ENTITY_STATE_KIND_TOWER = 3;
export const ENTITY_STATE_KIND_SHOT = 4;
export const ENTITY_STATE_BLUEPRINT_NONE = 0xff;
export const ENTITY_STATE_NO_BODY_SLOT = -1;

/** [23] Slot-indexed canonical entity state. Rows use the same stable
 *  slot ids allocated for SpatialGrid, so future WASM action/physics/
 *  render slabs can share one EntityId <-> slot mapping. */
export interface EntityStateApi {
  init: (initialCapacity: number) => void;
  clear: () => void;
  ensureCapacity: (slot: number) => void;
  unsetSlot: (slot: number) => void;
  capacity: () => number;
  setLifecycle: (
    slot: number,
    entityId: number,
    kind: number,
    ownerPlayerId: number,
    teamId: number,
    flags: number,
  ) => void;
  setTransform: (slot: number, x: number, y: number, z: number, rotation: number) => void;
  setVelocity: (slot: number, vx: number, vy: number, vz: number) => void;
  setUnitMotion: (
    slot: number,
    surfaceNormalX: number,
    surfaceNormalY: number,
    surfaceNormalZ: number,
    orientationX: number,
    orientationY: number,
    orientationZ: number,
    orientationW: number,
    angularVelocityX: number,
    angularVelocityY: number,
    angularVelocityZ: number,
    unitMotionFlags: number,
  ) => void;
  setUnitDriveInput: (
    slot: number,
    thrustDirX: number,
    thrustDirY: number,
    headingDirX: number,
    headingDirY: number,
  ) => void;
  setOwnership: (slot: number, ownerPlayerId: number, teamId: number) => void;
  setHpBuild: (
    slot: number,
    hp: number,
    maxHp: number,
    buildProgress: number,
    buildPaidEnergy: number,
    buildPaidMetal: number,
    buildFlags: number,
  ) => void;
  setStaticShape: (
    slot: number,
    radiusCollision: number,
    radiusHitbox: number,
    radiusOther: number,
    aabbHx: number,
    aabbHy: number,
    aabbHz: number,
  ) => void;
  setBodySlot: (slot: number, bodySlot: number) => void;
  collectBodyEntitySlots: (bodySlots: Uint32Array, entitySlotsOut: Uint32Array) => number;
  syncBodyMotion: (bodySlots: Uint32Array) => number;
  syncEntityBodyMotion: (entitySlots: Uint32Array) => number;
  setBlueprints: (
    slot: number,
    unitBlueprintCode: number,
    buildingBlueprintCode: number,
    shotBlueprintCode: number,
    projectileTypeCode: number,
  ) => void;
  markDirty: (slot: number, dirtyMask: number) => void;
  clearDirty: (slot: number) => void;
  collectDirtySlots: (
    slotsOut: Uint32Array,
    dirtyMasksOut: Uint32Array,
    clear: boolean,
  ) => number;
  collectAwakeBodyEntitySlots: (slotsOut: Uint32Array) => number;
  collectAwakeUnitBodyEntitySlots: (slotsOut: Uint32Array) => number;
  sortSlotsByEntityId: (slots: Uint32Array) => number;
  setProjectilesHotBatch: (
    count: number,
    slots: Uint32Array,
    xs: Float64Array,
    ys: Float64Array,
    zs: Float64Array,
    vxs: Float64Array,
    vys: Float64Array,
    vzs: Float64Array,
    hps: Float64Array,
    maxHps: Float64Array,
    flags: Uint32Array,
    ownerPlayerIds: Uint32Array,
    projectileTypeCodes: Uint32Array,
    radiusCollision: Float64Array,
    radiusHitbox: Float64Array,
  ) => number;
  entityIdPtr: () => number;
  kindPtr: () => number;
  flagsPtr: () => number;
  ownerPlayerIdPtr: () => number;
  teamIdPtr: () => number;
  posXPtr: () => number;
  posYPtr: () => number;
  posZPtr: () => number;
  rotationPtr: () => number;
  velXPtr: () => number;
  velYPtr: () => number;
  velZPtr: () => number;
  surfaceNormalXPtr: () => number;
  surfaceNormalYPtr: () => number;
  surfaceNormalZPtr: () => number;
  orientationXPtr: () => number;
  orientationYPtr: () => number;
  orientationZPtr: () => number;
  orientationWPtr: () => number;
  angularVelocityXPtr: () => number;
  angularVelocityYPtr: () => number;
  angularVelocityZPtr: () => number;
  unitMotionFlagsPtr: () => number;
  unitThrustDirXPtr: () => number;
  unitThrustDirYPtr: () => number;
  unitHeadingDirXPtr: () => number;
  unitHeadingDirYPtr: () => number;
  hpPtr: () => number;
  maxHpPtr: () => number;
  radiusCollisionPtr: () => number;
  radiusHitboxPtr: () => number;
  radiusOtherPtr: () => number;
  aabbHxPtr: () => number;
  aabbHyPtr: () => number;
  aabbHzPtr: () => number;
  bodySlotPtr: () => number;
  unitBlueprintCodePtr: () => number;
  buildingBlueprintCodePtr: () => number;
  shotBlueprintCodePtr: () => number;
  projectileTypeCodePtr: () => number;
  buildProgressPtr: () => number;
  buildPaidEnergyPtr: () => number;
  buildPaidMetalPtr: () => number;
  buildFlagsPtr: () => number;
  dirtyMaskPtr: () => number;
}

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
  /** Drop all cells and slot kind tags. Slot storage is retained
   *  (free list reset). */
  clear: () => void;
  /** Allocate a new slot or pop one off the free list. Returns the
   *  slot id; the JS-side wrapper stores `Map<EntityId, slot>`. */
  allocSlot: () => number;
  /** Return a slot to the free list. Unsets bucket membership. */
  freeSlot: (slot: number) => void;
  /** Store the stable JS entity id for source/target exclusion in
   *  Rust-side blocker kernels that only see spatial slots. */
  setEntityId: (slot: number, entityId: number) => void;
  /** Insert or update a unit at slot. owner_player=0 means "no owner".
   *  hp_alive=0 unsets the slot from the grid (matches updateUnit's
   *  dead-unit fast path). radius_collision is currently unused by queries
   *  but kept in the per-slot SoA for future use. */
  setUnit: (
    slot: number,
    x: number, y: number, z: number,
    radiusCollision: number, radiusHitbox: number,
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
    radiusCollision: number,
    radiusHitbox: number,
  ) => void;
  /** Batch insert/update projectile slots. All arrays must contain at
   *  least `count` rows; returns `count` when applied. */
  setProjectilesBatch: (
    count: number,
    slots: Uint32Array,
    xs: Float64Array,
    ys: Float64Array,
    zs: Float64Array,
    ownerPlayers: Uint8Array,
    projectileTypeFlags: Uint8Array,
    radiusCollision: Float64Array,
    radiusHitbox: Float64Array,
  ) => number;
  /** Insert / re-insert a building at slot. The grid buckets the
   *  building into every cell its (hx, hy, hz) half-extents touch. */
  setBuilding: (
    slot: number,
    x: number, y: number, z: number,
    hx: number, hy: number, hz: number,
    ownerPlayer: number,
    hpAlive: number,
    entityActive: number,
  ) => void;
  /** Drop the slot from any cell bucket it currently holds. Marks
   *  the slot kind as UNSET so future queries skip it. */
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
  /** 2D rect query: [nUnits, nBuildings, unit_slots..., building_slots...]. */
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
  /** Travelling projectiles whose cell overlaps the line's swept AABB. */
  queryProjectilesAlongLine: (
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

/** Phase 10 D.1b — Turret sub-pool. Up to 8 turrets per entity at
 *  fixed offset `entity_slot * MAX + turret_idx` in a flat SoA.
 *  Per-entity count gates which indices are live. Used by the
 *  future D.3 quantize/delta-encode kernel when serializing the
 *  turrets array in a unit snapshot DTO. */
