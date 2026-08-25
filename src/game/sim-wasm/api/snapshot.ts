// Simulation WASM snapshot API surface.

export interface SnapshotEncodeApi {
  /** Encode the basic entity envelope into the D.2 scratch. Returns
   *  the byte count; caller reads via writerPtr() + writerLen(). */
  encodeEntityBasic: (
    id: number,
    typeTag: number,
    qposX: number, qposY: number, qposZ: number,
    qrot: number,
    playerId: number,
    hasChangedFields: number,
    changedFields: number,
  ) => number;
  /** Encode envelope + the unit sub-object. Numeric vector components
   *  are pre-quantized JS numbers (caller does qVel / qNormal).
   *  Optional static fields are controlled by their has* flags. */
  encodeEntityUnit: (
    id: number,
    typeTag: number,
    qposX: number, qposY: number, qposZ: number,
    qrot: number,
    playerId: number,
    hasChangedFields: number,
    changedFields: number,
    hpCurr: number,
    hpMax: number,
    qvelX: number, qvelY: number, qvelZ: number,
    hasUnitType: number,
    unitTypeCode: number,
    hasRadius: number,
    radiusOther: number,
    radiusHitbox: number,
    radiusCollision: number,
    hasSupportPointOffsetZ: number,
    supportPointOffsetZ: number,
    hasMass: number,
    mass: number,
    hasSurfaceNormal: number,
    qnormalX: number, qnormalY: number, qnormalZ: number,
    hasOrientation: number,
    qorientX: number, qorientY: number, qorientZ: number, qorientW: number,
    hasAngularVelocity3: number,
    qangvelX: number, qangvelY: number, qangvelZ: number,
    hasFireEnabled: number,
    hasIsCommander: number,
    hasBuildTargetId: number,
    buildTargetIdIsNull: number,
    buildTargetId: number,
    hasActions: number,
    actionCount: number,
    hasTurrets: number,
    turretCount: number,
    hasBuild: number,
    buildComplete: number,
    buildPaidEnergy: number,
    buildPaidMetal: number,
  ) => number;
  /** Raw pointer to the D.2 MessagePack writer scratch. Refreshed
   *  by every encoder call. */
  writerPtr: () => number;
  /** Bytes currently in the D.2 scratch (matches the last encoder
   *  call's return value). */
  writerLen: () => number;
  /** Clear the MessagePack writer scratch (length back to 0). */
  writerClear: () => void;
  /** Append an already MessagePack-encoded value to the writer. Used
   *  by the DP-02 parity flag as a temporary fallback for DTO shapes
   *  that are not fully ported to Rust yet. */
  appendRawValue: (bytes: Uint8Array) => number;
  /** Raw pointer to the turret scratch buffer. JS fills 13 f64 per
   *  turret (see lib.rs SNAPSHOT_ENCODE_TURRET_STRIDE layout)
   *  before calling encodeEntityUnit with hasTurrets=1. */
  turretScratchPtr: () => number;
  /** Pre-grow the turret scratch to fit `count` turrets (13 f64 each). */
  turretScratchEnsure: (count: number) => void;
  /** Stride per turret in the scratch buffer (f64 count). */
  readonly turretScratchStride: number;
  /** Encode a building entity DTO (envelope + building sub-object
   *  with numeric type / dim / hp / build / metalExtractionRate / solar /
   *  turrets). Turrets reuse the same scratch as unit turrets.
   *  Factory sub-object not yet supported. */
  encodeEntityBuilding: (
    id: number,
    qposX: number, qposY: number, qposZ: number,
    qrot: number,
    playerId: number,
    hasChangedFields: number,
    changedFields: number,
    hasType: number,
    typeCode: number,
    hasDim: number,
    dimX: number, dimY: number,
    hpCurr: number,
    hpMax: number,
    buildComplete: number,
    buildPaidEnergy: number,
    buildPaidMetal: number,
    hasMetalExtractionRate: number,
    metalExtractionRate: number,
    hasSolar: number,
    solarOpen: number,
    hasTurrets: number,
    turretCount: number,
    hasFactory: number,
    factorySelectedUnitCount: number,
    factoryProgress: number,
    factoryProducing: number,
    factoryEnergyRate: number,
    factoryMetalRate: number,
    factoryWaypointCount: number,
  ) => number;
  /** Raw pointer to the action scratch buffer. JS fills 19 f64 per
   *  action (see lib.rs SNAPSHOT_ENCODE_ACTION_STRIDE layout)
   *  before calling encodeEntityUnit with hasActions=1. */
  actionScratchPtr: () => number;
  /** Pre-grow the action scratch to fit `count` actions (19 f64 each). */
  actionScratchEnsure: (count: number) => void;
  /** Stride per action in the scratch buffer (f64 count). */
  readonly actionScratchStride: number;
  /** Raw pointer to the string-scratch UTF-8 byte buffer. JS writes
   *  the concatenated UTF-8 bytes of every string field here. */
  stringScratchBytesPtr: () => number;
  /** Raw pointer to the string-scratch offset/length table (Uint32Array).
   *  table[2i] is the byte offset, table[2i+1] is the byte length for
   *  string slot `i`. */
  stringScratchTablePtr: () => number;
  /** Pre-grow the byte buffer to hold at least `byteCount` bytes. */
  stringScratchEnsureBytes: (byteCount: number) => void;
  /** Pre-grow the offset/length table to fit `slotCount` strings. */
  stringScratchEnsureTable: (slotCount: number) => void;
  /** Raw pointer to the factory selected-unit scratch (Uint32Array with
   *  one unit type code when production is on). JS fills before
   *  encodeEntityBuilding with hasFactory=1; encoder reads
   *  factorySelectedUnitCount entries. */
  factorySelectedUnitScratchPtr: () => number;
  /** Pre-grow the factory selected-unit scratch to hold `count` codes. */
  factorySelectedUnitScratchEnsure: (count: number) => void;
  /** Raw pointer to the waypoint scratch (Float64Array, 5 f64
   *  per waypoint — see SNAPSHOT_ENCODE_WAYPOINT_STRIDE in lib.rs).
   *  type field is a string-scratch slot index. */
  waypointScratchPtr: () => number;
  /** Pre-grow the waypoint scratch to hold `count` waypoints. */
  waypointScratchEnsure: (count: number) => void;
  /** Stride per waypoint in the scratch buffer (f64 count). */
  readonly waypointScratchStride: number;
  /** Open the snapshot envelope: clear writer, emit map header with
   *  totalKeyCount (caller-tallied), then tick + entities array
   *  header. Per-entity encodeEntityUnit/encodeEntityBuilding calls
   *  follow, then emitMinimap/emitEconomy/emitProjectiles in pool
   *  order, then envelopeContinue closes the envelope. */
  envelopeBegin: (tick: number, entityCount: number, totalKeyCount: number) => void;
  /** Open the snapshot envelope for a pre-packed `entities` value.
   *  Caller must emit the entities key next with emitRawKeyValue. */
  envelopeBeginPackedEntities: (tick: number, totalKeyCount: number) => void;
  /** Append a top-level key and an already MessagePack-encoded value.
   *  Transitional DP-02 bridge for low-frequency fields whose
   *  dedicated Rust encoders are still pending. */
  emitRawKeyValue: (key: string, value: Uint8Array) => number;
  /** Emit the `entities` key + compact V6 `{v,m,t,b,e}` value.
   *  Caller must first bulk-fill the V6 input scratches (kinds /
   *  rowIndices / basic / unit / building) + the shared turret / action /
   *  waypoint / factory selected-unit / string scratches from entityWireSource.
   *  RAW (private-detail DTO) rows must be pre-encoded to MessagePack and
   *  bulk-filled into the raw-bytes/raw-spans scratches in entity-index
   *  order; the kernel copies them verbatim into the `e` array.
   *  `waypointStringBase` is the slot where waypoint-type strings begin in
   *  the (action ++ waypoint) ordered string scratch. Returns the writer
   *  length. */
  emitEntitiesV6: (entityCount: number, waypointStringBase: number) => number;
  v6KindsScratchPtr: () => number;
  v6KindsScratchEnsure: (count: number) => void;
  v6RowIndicesScratchPtr: () => number;
  v6RowIndicesScratchEnsure: (count: number) => void;
  v6BasicScratchPtr: () => number;
  v6BasicScratchEnsure: (rowCount: number) => void;
  readonly v6BasicScratchStride: number;
  v6UnitScratchPtr: () => number;
  v6UnitScratchEnsure: (rowCount: number) => void;
  readonly v6UnitScratchStride: number;
  v6BuildingScratchPtr: () => number;
  v6BuildingScratchEnsure: (rowCount: number) => void;
  readonly v6BuildingScratchStride: number;
  v6RawBytesScratchPtr: () => number;
  v6RawBytesScratchEnsure: (byteLen: number) => void;
  v6RawSpansScratchPtr: () => number;
  v6RawSpansScratchEnsure: (rawRowCount: number) => void;
  /** Emit `serverMeta: {...}` in ServerSnapshotMetaBuilder field
   *  order. String values must already be packed into string scratch;
   *  the `units.allowed` array uses contiguous string slots beginning
   *  at `unitsAllowedSlotStart`. */
  emitServerMeta: (
    ticksAvg: number,
    ticksLow: number,
    ticksRate: number,
    snapsRateIsString: number,
    snapsRate: number,
    snapsRateSlot: number,
    serverTimeSlot: number,
    serverIpSlot: number,
    hasUnitsAllowed: number,
    unitsAllowedSlotStart: number,
    unitsAllowedCount: number,
    hasUnitsMax: number,
    unitsMax: number,
    hasUnitsCount: number,
    unitsCount: number,
    hasMirrorsEnabled: number,
    turretShieldPanelsEnabled: number,
    hasShieldsEnabled: number,
    turretShieldSpheresEnabled: number,
    hasForceFieldsVisible: number,
    forceFieldsVisible: number,
    hasShieldAwareTargetingPlayerMask: number,
    shieldAwareTargetingPlayerMask: number,
    hasShieldPowerPlayerMask: number,
    shieldPowerPlayerMask: number,
    hasShieldReflectionMode: number,
    shieldReflectionModeSlot: number,
    hasFogOfWarEnabled: number,
    fogOfWarEnabled: number,
    cpuAvg: number,
    cpuHi: number,
    windX: number,
    windY: number,
    windZ: number,
    windSpeed: number,
    windAngle: number,
    unitGroundNormalEmaSlot: number,
  ) => number;
  /** Close the envelope. Emits gameState (if hasGameState),
   *  removedEntityIds (if hasRemovedIds), visibilityFiltered (if
   *  hasVisibilityFiltered) in that order. Returns total bytes
   *  written. */
  envelopeContinue: (
    hasGameState: number,
    gameStatePhaseSlot: number,
    hasWinnerId: number,
    winnerId: number,
    hasRemovedEntityIds: number,
    removedEntityIdCount: number,
    hasVisibilityFiltered: number,
    visibilityFiltered: number,
  ) => number;
  /** Emit `economy: { [playerId]: EconomyDTO }`. Caller pre-packs the
   *  economy scratch (16 f64 per player, ASC by playerId) and passes
   *  the player count. Pass 0 to emit an empty economy map. */
  emitEconomy: (playerCount: number) => number;
  /** Emit `resourceMovements: [...]`. Reads `count` entries from the
   *  resource-movement scratch (7 f64 per movement). */
  emitResourceMovements: (count: number) => number;
  /** Raw pointer to the resource-movement scratch (Float64Array, 7 f64 per movement). */
  resourceMovementScratchPtr: () => number;
  /** Pre-grow the resource-movement scratch to hold `count` movements. */
  resourceMovementScratchEnsure: (count: number) => void;
  /** Stride per resource-movement entry (f64 count). */
  readonly resourceMovementScratchStride: number;
  /** Emit `minimapEntities: [...]`. Reads `count` entries from the
   *  minimap scratch (6 f64 per entry). */
  emitMinimap: (count: number) => void;
  /** Emit packed `minimapEntities: { v: 2, b }`. Reads `count`
   *  entries from the minimap scratch and writes the compact binary
   *  wire shape used by snapshotMinimapWirePack.ts. */
  emitPackedMinimap: (count: number) => number;
  /** Emit `projectiles: { spawns?, despawns?, motionUpdates?,
   *  beamUpdates? }`. Reads spawn DTOs from projSpawnScratch (32 f64
   *  each), despawn ids from projDespawnScratch, motion-update
   *  tuples from projVelScratch (9 f64 each), beam-update headers
   *  from beamUpdateScratch (4 f64 each, with point_count[3] driving
   *  the per-update slice of beamPointScratch (12 f64 each)). */
  emitProjectiles: (
    hasSpawns: number,
    spawnCount: number,
    hasDespawns: number,
    despawnCount: number,
    hasMotionUpdates: number,
    motionUpdateCount: number,
    hasBeamUpdates: number,
    beamUpdateCount: number,
  ) => void;
  /** Emit packed `projectiles: { v: 3, s?, d?, u?, b? }`. Reads the
   *  same projectile scratches as emitProjectiles, but writes the
   *  compact binary wire shape used by snapshotProjectileWirePack.ts. */
  emitPackedProjectiles: (
    hasSpawns: number,
    spawnCount: number,
    hasDespawns: number,
    despawnCount: number,
    hasMotionUpdates: number,
    motionUpdateCount: number,
    hasBeamUpdates: number,
    beamUpdateCount: number,
    beamPointCount: number,
  ) => number;
  /** Raw pointer to the minimap scratch (Float64Array, 6 f64 per
   *  entry: id, posX, posY, typeTag, playerId, radarPacked). */
  minimapScratchPtr: () => number;
  /** Pre-grow the minimap scratch to hold `count` entries. */
  minimapScratchEnsure: (count: number) => void;
  /** Stride per minimap entry (f64 count). */
  readonly minimapScratchStride: number;
  /** Emit `scanPulses: [...]`. Sits AFTER visibilityFiltered in
   *  pool-iteration order (lazy-added to _snapshotBuf). Reads
   *  `count` entries (6 f64 each) from the scan-pulse scratch. */
  emitScanPulses: (count: number) => number;
  /** Raw pointer to the scan-pulse scratch (Float64Array, 6 f64 per
   *  pulse: playerId, x, y, z, radius, expiresAtTick). */
  scanPulseScratchPtr: () => number;
  /** Pre-grow the scan-pulse scratch to hold `count` pulses. */
  scanPulseScratchEnsure: (count: number) => void;
  /** Stride per scan-pulse entry (f64 count). */
  readonly scanPulseScratchStride: number;
  /** Emit compact `terrain: {v,m,vc,vh,ti,tw}` from raw TerrainTileMap
   *  arrays copied into number scratch. */
  emitPackedTerrain: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    subdiv: number,
    cellsX: number,
    cellsY: number,
    verticesX: number,
    verticesY: number,
    version: number,
    meshVertexCoordsOffset: number,
    meshVertexCoordsCount: number,
    meshVertexHeightsOffset: number,
    meshVertexHeightsCount: number,
    meshTriangleIndicesOffset: number,
    meshTriangleIndicesCount: number,
    meshTriangleWallFlagsOffset: number,
    meshTriangleWallFlagsCount: number,
  ) => number;
  /** Emit full `terrain: TerrainTileMap`. Retained for byte-parity
   *  fixtures and raw DTO fallback diagnostics. */
  emitTerrain: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    subdiv: number,
    cellsX: number,
    cellsY: number,
    verticesX: number,
    verticesY: number,
    version: number,
    meshVertexCoordsOffset: number,
    meshVertexCoordsCount: number,
    meshVertexHeightsOffset: number,
    meshVertexHeightsCount: number,
    meshTriangleIndicesOffset: number,
    meshTriangleIndicesCount: number,
    meshTriangleLevelsOffset: number,
    meshTriangleLevelsCount: number,
    meshTriangleWallFlagsOffset: number,
    meshTriangleWallFlagsCount: number,
    meshTriangleNeighborIndicesOffset: number,
    meshTriangleNeighborIndicesCount: number,
    meshTriangleNeighborLevelsOffset: number,
    meshTriangleNeighborLevelsCount: number,
    meshCellTriangleOffsetsOffset: number,
    meshCellTriangleOffsetsCount: number,
    meshCellTriangleIndicesOffset: number,
    meshCellTriangleIndicesCount: number,
  ) => number;
  /** Emit compact `buildability: {v,m,k,r}` from raw flags/levels
   *  copied into number scratch. */
  emitPackedBuildability: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    cellsX: number,
    cellsY: number,
    version: number,
    configKeySlot: number,
    flagsOffset: number,
    flagsCount: number,
    levelsOffset: number,
    levelsCount: number,
  ) => number;
  /** Emit full `buildability: TerrainBuildabilityGrid`. Retained for
   *  byte-parity fixtures and raw DTO fallback diagnostics. */
  emitBuildability: (
    mapWidth: number,
    mapHeight: number,
    cellSize: number,
    cellsX: number,
    cellsY: number,
    version: number,
    configKeySlot: number,
    flagsOffset: number,
    flagsCount: number,
    levelsOffset: number,
    levelsCount: number,
  ) => number;
  /** Shared Float64 scratch for top-level numeric arrays. */
  numberScratchPtr: () => number;
  /** Pre-grow the shared numeric scratch to hold `numberCount` f64s. */
  numberScratchEnsure: (numberCount: number) => void;
  /** Emit `sprayTargets: [...]`. Sits between economy and projectiles
   *  in iteration order. Reads `count` entries (17 f64 each) from the
   *  spray scratch. */
  emitSprayTargets: (count: number) => number;
  /** Raw pointer to the spray-target scratch (Float64Array, 17 f64
   *  per spray — see lib.rs SNAPSHOT_ENCODE_SPRAY_STRIDE for layout). */
  sprayScratchPtr: () => number;
  /** Pre-grow the spray scratch to hold `count` sprays. */
  sprayScratchEnsure: (count: number) => void;
  /** Stride per spray entry (f64 count). */
  readonly sprayScratchStride: number;
  /** Raw pointer to the economy scratch (Float64Array, 16 f64 per
   *  player — see lib.rs SNAPSHOT_ENCODE_ECONOMY_STRIDE for layout).
   *  Caller must sort entries ASCENDING by playerId. */
  economyScratchPtr: () => number;
  /** Pre-grow the economy scratch to hold `count` players. */
  economyScratchEnsure: (count: number) => void;
  /** Stride per economy entry (f64 count). */
  readonly economyScratchStride: number;
  /** Emit `audioEvents: [...]`. D.3j-26 covers everything except
   *  deathContext + impactContext (large nested objects deferred to
   *  later commits). Caller pre-packs strings into the shared string
   *  scratch and stores their slot indices in the audio scratch. */
  emitAudioEvents: (count: number) => number;
  /** Emit compact `audioEvents: {v,s,e,d?,i?,t?}` from pre-packed
   *  audio/death/impact/turret-pose scratches. */
  emitPackedAudioEvents: (
    count: number,
    stringCount: number,
    deathContextCount: number,
    impactContextCount: number,
    turretPoseCount: number,
  ) => number;
  /** Raw pointer to the audio-event scratch (Float64Array, 20 f64
   *  per event — see lib.rs SNAPSHOT_ENCODE_AUDIO_EVENT_STRIDE). */
  audioEventScratchPtr: () => number;
  /** Pre-grow the audio-event scratch to hold `count` events. */
  audioEventScratchEnsure: (count: number) => void;
  /** Stride per audio-event entry (f64 count). */
  readonly audioEventScratchStride: number;
  /** Raw pointer to the death-context scratch (16 f64 per
   *  deathContext, one per audio event with the has_deathContext
   *  flag set). Caller packs in audio-event order. */
  deathContextScratchPtr: () => number;
  /** Pre-grow the death-context scratch to hold `count` contexts. */
  deathContextScratchEnsure: (count: number) => void;
  /** Stride per death-context entry (f64 count). */
  readonly deathContextScratchStride: number;
  /** Raw pointer to the turret-pose scratch (2 f64 per pose: rotation,
   *  pitch — flat across all deathContexts in pack order). */
  turretPoseScratchPtr: () => number;
  /** Pre-grow the turret-pose scratch to hold `count` total poses. */
  turretPoseScratchEnsure: (count: number) => void;
  /** Stride per turret-pose entry (f64 count). */
  readonly turretPoseScratchStride: number;
  /** Raw pointer to the impact-context scratch (11 f64 per
   *  impactContext, one per audio event with the has_impactContext
   *  flag set). All fields required (no optionals). */
  impactContextScratchPtr: () => number;
  /** Pre-grow the impact-context scratch to hold `count` contexts. */
  impactContextScratchEnsure: (count: number) => void;
  /** Stride per impact-context entry (f64 count). */
  readonly impactContextScratchStride: number;
  /** Raw pointer to the beam-update header scratch (Float64Array,
   *  4 f64 per update: id, flags, obstructionT, point_count). */
  beamUpdateScratchPtr: () => number;
  /** Pre-grow the beam-update header scratch to hold `count` updates. */
  beamUpdateScratchEnsure: (count: number) => void;
  /** Stride per beam-update header (f64 count). */
  readonly beamUpdateScratchStride: number;
  /** Raw pointer to the beam-point scratch (Float64Array, 12 f64 per
   *  point — flat across all beam updates in pool order). */
  beamPointScratchPtr: () => number;
  /** Pre-grow the beam-point scratch to hold `count` total points. */
  beamPointScratchEnsure: (count: number) => void;
  /** Stride per beam-point (f64 count). */
  readonly beamPointScratchStride: number;
  /** Raw pointer to the projectile-despawn scratch (Uint32Array of
   *  ids). */
  projDespawnScratchPtr: () => number;
  /** Pre-grow the proj-despawn scratch to hold `count` ids. */
  projDespawnScratchEnsure: (count: number) => void;
  /** Raw pointer to the projectile-spawn scratch (Float64Array,
   *  SNAPSHOT_ENCODE_PROJ_SPAWN_STRIDE f64 per entry — see lib.rs
   *  layout comment for field offsets and the optional-presence
   *  bitmask at offset 26). */
  projSpawnScratchPtr: () => number;
  /** Pre-grow the proj-spawn scratch to hold `count` entries. */
  projSpawnScratchEnsure: (count: number) => void;
  /** Stride per proj-spawn entry (f64 count). */
  readonly projSpawnScratchStride: number;
  /** Raw pointer to the projectile-motion-update scratch
   *  (Float64Array, 9 f64 per entry: id, pos.x/y/z, vel.x/y/z,
   *  rotation, angularVelocity). */
  projVelScratchPtr: () => number;
  /** Pre-grow the proj-vel scratch to hold `count` entries. */
  projVelScratchEnsure: (count: number) => void;
  /** Stride per proj-vel entry (f64 count). */
  readonly projVelScratchStride: number;
  /** Raw pointer to the removed-entity-ids scratch (Uint32Array). */
  removedIdsScratchPtr: () => number;
  /** Pre-grow the removed-ids scratch to hold `count` ids. */
  removedIdsScratchEnsure: (count: number) => void;
}

/** Entity-type tags for SnapshotEncodeApi.encodeEntityBasic. Mirrors
 *  SNAPSHOT_ENTITY_TYPE_* in lib.rs. */
export const SNAPSHOT_ENTITY_TYPE_UNIT = 1;
export const SNAPSHOT_ENTITY_TYPE_BUILDING = 2;

/** Phase 9 — Pathfinder. Mirror of Pathfinder.ts findPath. Full
 *  pipeline (mask + CC + A* + LOS smoothing) runs inside a single
 *  WASM call. The mask is rebuilt from terrain only; construction
 *  reservations deliberately remain outside locomotion pathfinding. */
