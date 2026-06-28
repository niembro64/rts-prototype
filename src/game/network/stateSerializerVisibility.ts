import type { RemovedSnapshotEntity, WorldState } from '../sim/WorldState';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { NetworkServerSnapshotScanPulse } from '../../types/network';
import { hasFogOfWarLineOfSight } from '../sim/combat/lineOfSight';
import { spatialGrid } from '../sim/SpatialGrid';
import {
  canEntityProvideFullVision,
  canEntityProvideCloakDetection,
  canEntityProvideRadarVision,
  getEntityCloakDetectionRadius,
  getEntityFullVisionRadius,
  getEntityRadarRadius,
  getEntityVisibilityPadding,
  isEntityCloaked,
} from '../sim/sensorCoverage';
import {
  CT_ENTITY_FLAG_ALIVE,
  CT_ENTITY_FLAG_CLOAKED,
  ENTITY_STATE_KIND_BUILDING,
  ENTITY_STATE_KIND_TOWER,
  ENTITY_STATE_KIND_UNIT,
  getSimWasm,
} from '../sim-wasm/init';
import { entitySlotRegistry, type EntityStateViews } from '../sim/EntitySlotRegistry';
import {
  createFloat64WireRows,
  reserveFloat64WireRows,
  type Float64WireRows,
} from './snapshotWireRows';

export {
  canEntityProvideFullVision,

  
  getEntityFullVisionRadius,
  
} from '../sim/sensorCoverage';

const VISION_CELL_SIZE = 512;
/** Additional radius beyond a full-vision source where sounds carry
 *  but visuals do not (FOW-09). A vision-source's effective audio
 *  reach is `radius + EARSHOT_PAD`. Tuned roughly half the unit
 *  vision radius — enough to hear gunfire just over the rim of your
 *  scout's circle, not enough to hear a base under attack across
 *  the map. */
const EARSHOT_PAD = 600;

/** Eye-height above transform.z assumed for vision sources when
 *  running the terrain LOS check (FOW-04). Constant rather
 *  than per-entity-type because the existing transform.z already
 *  encodes ground elevation, so a unit standing on a hill gets the
 *  hill's lift "for free" — this just adds a body/turret-mount offset
 *  on top so two units on flat ground can still see each other over
 *  a small bump. */
const VISION_SOURCE_EYE_HEIGHT = 30;

/** Target-side z offset above transform.z when running the LOS check.
 *  Slightly less than VISION_SOURCE_EYE_HEIGHT — the source is
 *  actively looking (turret head, sensor mast), the target is just a
 *  body to be observed. */
const VISION_TARGET_BODY_HEIGHT = 15;

type VisionSource = {
  x: number;
  y: number;
  z: number;
  radius: number;
};

/** Three-way classification returned by classifyPointVisibility
 *  (FOW-OPT-08). The audio serializer is the primary
 *  consumer: it routes IN_VISION events normally, gates IN_EARSHOT
 *  events through audioOnly forwarding, and drops OUT_OF_RANGE
 *  events (unless authored by the recipient). Numeric literals so
 *  the hot loop can branch on a single int compare. */
const VISIBILITY_CLASS_OUT_OF_RANGE = 0;
export const VISIBILITY_CLASS_IN_EARSHOT = 1;
export const VISIBILITY_CLASS_IN_VISION = 2;
type VisibilityClass = 0 | 1 | 2;
export const SCAN_PULSE_WIRE_STRIDE = 6;

type ScanPulseWireSource = Float64WireRows;

type MutableScanPulseWireRow = Float64Array | number[];

const scanPulseWireSources = new WeakMap<object, ScanPulseWireSource>();
const directScanPulseWireSource = createFloat64WireRows();
const _scanPulseWireSource = createFloat64WireRows();

export function getScanPulseWireSource(
  pulses: readonly NetworkServerSnapshotScanPulse[],
): ScanPulseWireSource | undefined {
  return scanPulseWireSources.get(pulses);
}

function writeScanPulseWireRow(
  values: MutableScanPulseWireRow,
  base: number,
  pulse: NetworkServerSnapshotScanPulse,
): void {
  values[base + 0] = pulse.playerId;
  values[base + 1] = pulse.x;
  values[base + 2] = pulse.y;
  values[base + 3] = pulse.z;
  values[base + 4] = pulse.radius;
  values[base + 5] = pulse.expiresAtTick;
}

function appendScanPulseWireRow(
  source: ScanPulseWireSource,
  pulse: NetworkServerSnapshotScanPulse,
): void {
  const rowIndex = reserveFloat64WireRows(source, 1, SCAN_PULSE_WIRE_STRIDE);
  writeScanPulseWireRow(
    source.values,
    rowIndex * SCAN_PULSE_WIRE_STRIDE,
    pulse,
  );
}

/** Per-recipient visibility filter.
 *
 *  Two parallel source pools (FOW-03):
   *    - fullSources: entities explicitly authored with full-sight
   *      sensors. Grant FULL info (entity present in the main snapshot
   *      with all fields).
   *    - radarSources: entities explicitly authored with radar sensors.
   *      Grant ONLY positional intel — the entity appears on the
   *      minimap as a blip but is omitted from the main snapshot, so
   *      the player learns where without learning what / HP / orders.
 *
 *  The owner of an entity always sees their own stuff in full; the
 *  owner-aware short-circuit lives in isEntityVisible() and
 *  isEntityOnRadar(). */
export class SnapshotVisibility {
  private readonly fullSources: VisionSource[] = [];
  private readonly fullSourceCells = new Map<number, number[]>();
  private readonly earshotSourceCells = new Map<number, number[]>();
  private readonly radarSources: VisionSource[] = [];
  private readonly radarSourceCells = new Map<number, number[]>();
  private readonly detectorSources: VisionSource[] = [];
  private readonly detectorSourceCells = new Map<number, number[]>();
  private readonly visibleEntityIds: EntityId[] = [];
  private readonly radarEntityIds: EntityId[] = [];
  private readonly visibleEntityIdSet = new Set<EntityId>();
  private readonly radarEntityIdSet = new Set<EntityId>();
  private readonly fullCandidateEntityIdSet = new Set<EntityId>();
  private readonly radarCandidateEntityIdSet = new Set<EntityId>();
  private readonly gridW: number;
  private readonly gridH: number;
  private entityIdBuffersReady = false;
  /** Recipient + their declared allies (FOW-06). Populated whenever a
   *  recipient is set, regardless of fog status. Used by
   *  isOwnedByRecipientOrAlly so every ownership check across the
   *  serializer treats allies symmetrically with the recipient:
   *  private fields, kill credit, the lot.
   *
   *  Stored as a number bitmask (FOW-OPT-10) — playerId p
   *  maps to bit (p - 1), so PlayerIds 1..31 fit. isOwnedByRecipientOrAlly
   *  collapses to a single AND + compare per probe, vs Set.has()'s
   *  hashmap lookup. Same convention already used by
   *  ServerDebugGridPublisher.playerMask. */
  private viewMask: number = 0;

  /** True when fog-of-war filtering is active for this snapshot
   *  (recipient set AND world.fogOfWarEnabled). Distinct from "has a
   *  recipient" because a recipient can still exist with fog disabled. */
  readonly isFiltered: boolean;

  /** Per-emit memo for isEntityVisible (FOW-OPT-09). The
   *  same SnapshotVisibility instance is shared across every
   *  teammate via getOrBuildVisibility's per-emit cache (FOW-OPT-01);
   *  within a single emit, the entity serializer also revisits the
   *  same entity from multiple sites (the dirty loop, the full
   *  visibility walk, canReferenceEntityId for turret/build/repair
   *  targets, the visibility-hidden cleanup). Without a memo each
   *  call repeats the spatial-hash walk AND every hasTerrainLineOfSight
   *  raycast against the heightmap — for an enemy unit sitting in
   *  the overlap of three friendly tanks, that's three raycasts per
   *  call, redone per call. The world is frozen during emit() so
   *  caching the boolean is safe; the map is cleared once at
   *  construction and lives until the SnapshotVisibility is dropped
   *  at end-of-emit. Only stores answers when isFiltered (unfiltered
   *  short-circuits to true unconditionally) and only after the
   *  owner-or-ally short-circuit (which is already O(1) — no point
   *  memoizing it). */
  private readonly entityVisibilityMemo = new Map<EntityId, boolean>();

  /** Stable identity for the recipient's view-team — the bitmask of
   *  recipient + allies, rendered as a base-36 string. Two recipients
   *  on the same team share the same key (the mask is just "which
   *  playerIds count as ours"), so the per-emit visibility cache
   *  (FOW-OPT-01) keys off this. Undefined for
   *  admin/spectator visibilities (no recipient), which the caches
   *  use to skip caching entirely.
   *  Materialized once in the constructor so callers holding the
   *  instance don't re-walk getAllies (FOW-OPT-21). */
  readonly teamMaskKey: string | undefined;

  private constructor(
    recipientPlayerId: PlayerId | undefined,
    fogEnabled: boolean,
    private readonly world: WorldState,
    mapWidth: number,
    mapHeight: number,
    precomputedTeamMask: number | undefined = undefined,
  ) {
    this.isFiltered = fogEnabled && recipientPlayerId !== undefined;
    this.gridW = Math.max(1, Math.ceil(mapWidth / VISION_CELL_SIZE));
    this.gridH = Math.max(1, Math.ceil(mapHeight / VISION_CELL_SIZE));
    if (precomputedTeamMask !== undefined) {
      this.viewMask = precomputedTeamMask;
    } else if (recipientPlayerId !== undefined) {
      this.viewMask |= 1 << (recipientPlayerId - 1);
      for (const allyId of world.getAllies(recipientPlayerId)) {
        this.viewMask |= 1 << (allyId - 1);
      }
    }
    this.teamMaskKey = this.viewMask !== 0 ? this.viewMask.toString(36) : undefined;
  }

  static forRecipient(
    world: WorldState,
    recipientPlayerId: PlayerId | undefined,
    precomputedTeamMask: number | undefined = undefined,
  ): SnapshotVisibility {
    const visibility = new SnapshotVisibility(
      recipientPlayerId,
      world.fogOfWarEnabled,
      world,
      world.mapWidth,
      world.mapHeight,
      precomputedTeamMask,
    );
    if (!visibility.isFiltered) return visibility;
    // Walk the set bits of viewMask in ascending playerId order to add
    // each viewable player's sources to the spatial hash. PlayerIds
    // are 1..31; (32 - clz32(lowBit)) recovers the id from the lowest
    // set bit, and XOR-out advances to the next.
    let pending = visibility.viewMask;
    while (pending !== 0) {
      const lowBit = pending & -pending;
      const playerId = (32 - Math.clz32(lowBit)) as PlayerId;
      visibility.addPlayerSources(world, playerId);
      pending ^= lowBit;
    }
    visibility.addScanPulseSources(world);
    return visibility;
  }

  /** True when the given playerId belongs to the recipient or one of
   *  their allies. Works regardless of fog status — a recipient with
   *  fog disabled still gets the team-aware "this is one of ours"
   *  answer for ownership checks and team-routed visibility. */
  isOwnedByRecipientOrAlly(playerId: PlayerId | null | undefined): boolean {
    if (playerId === null || playerId === undefined) return false;
    return (this.viewMask & (1 << (playerId - 1))) !== 0;
  }

  /** True when this visibility object was built for a specific
   *  player (with or without fog filtering). Distinct from isFiltered
   *  — the latter is false when fog is off. Admin / spectator-style
   *  observers (no recipient) get false. */
  get hasRecipient(): boolean {
    return this.viewMask !== 0;
  }

  getVisionPlayerMask(): number {
    return this.viewMask;
  }

  canSeePrivateEntityDetails(entity: Entity): boolean {
    if (!this.hasRecipient) return true;
    const ownership = entity.ownership;
    return this.isOwnedByRecipientOrAlly(ownership !== null ? ownership.playerId : null);
  }

  canReferenceEntityId(world: WorldState, entityId: EntityId | undefined): boolean {
    if (entityId === undefined) return false;
    if (!this.isFiltered) return true;
    const entity = world.getEntity(entityId);
    return entity !== undefined && this.isEntityVisible(entity);
  }

  /** Full-vision check: gates the MAIN snapshot. Owned entities are
   *  always full-visible; for foreign entities the recipient must have
   *  a full-vision source (unit / non-radar building) covering the
   *  entity position AND have an unobstructed terrain sightline to it
   *  (FOW-04). Radar coverage does NOT grant full visibility. */
  isEntityVisible(entity: Entity): boolean {
    if (!this.isFiltered) return true;
    const ownership = entity.ownership;
    if (this.isOwnedByRecipientOrAlly(ownership !== null ? ownership.playerId : null)) return true;
    const cached = this.entityVisibilityMemo.get(entity.id);
    if (cached !== undefined) return cached;
    const padding = getEntityVisibilityPadding(entity);
    const result = isEntityCloaked(entity)
      ? this.isEntityDetected(entity.transform.x, entity.transform.y, padding)
      : this.isEntityVisibleWithLos(
          entity.transform.x,
          entity.transform.y,
          entity.transform.z,
          padding,
        );
    this.entityVisibilityMemo.set(entity.id, result);
    return result;
  }

  /** Distance-then-LOS scan over fullSources. Reuses the spatial hash
   *  for the distance candidate set, then runs the shared fog LOS
   *  policy only on the candidates that pass distance — so a tank
   *  behind terrain or force material falls out of vision even when
   *  the source's 2D circle covers its position. */
  private isEntityVisibleWithLos(
    x: number,
    y: number,
    z: number,
    padding: number,
  ): boolean {
    const cx = Math.floor(x / VISION_CELL_SIZE);
    const cy = Math.floor(y / VISION_CELL_SIZE);
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return false;
    const sourceIndexes = this.fullSourceCells.get(this.cellKey(cx, cy));
    if (!sourceIndexes) return false;
    const targetZ = z + VISION_TARGET_BODY_HEIGHT;
    for (let i = 0; i < sourceIndexes.length; i++) {
      const source = this.fullSources[sourceIndexes[i]];
      const dx = x - source.x;
      const dy = y - source.y;
      const r = source.radius + padding;
      if (dx * dx + dy * dy > r * r) continue;
      if (hasFogOfWarLineOfSight(
        this.world,
        source.x, source.y, source.z,
        x, y, targetZ,
      )) {
        return true;
      }
    }
    return false;
  }

  private isEntityDetected(x: number, y: number, padding: number): boolean {
    return this.isPointVisibleIn(this.detectorSources, this.detectorSourceCells, x, y, padding);
  }

  /** Minimap-tier check: full vision OR radar coverage. Used by the
   *  minimap serializer so radar buildings reveal enemy positions
   *  without leaking the rest of the snapshot. */
  isEntityOnRadar(entity: Entity): boolean {
    if (!this.isFiltered) return true;
    const ownership = entity.ownership;
    if (this.isOwnedByRecipientOrAlly(ownership !== null ? ownership.playerId : null)) return true;
    const padding = getEntityVisibilityPadding(entity);
    if (isEntityCloaked(entity)) {
      return this.isEntityDetected(entity.transform.x, entity.transform.y, padding);
    }
    if (this.isPointVisibleIn(this.fullSources, this.fullSourceCells, entity.transform.x, entity.transform.y, padding)) {
      return true;
    }
    return this.isPointVisibleIn(this.radarSources, this.radarSourceCells, entity.transform.x, entity.transform.y, padding);
  }

  /** Full-visibility entity ids for the main snapshot serializer.
   *  Built once per filtered team visibility, then shared by serializers
   *  so they do not independently scan the
   *  world's unit/building arrays. Undefined for unfiltered snapshots,
   *  where the caller's existing all-entity walk is already the right
   *  shape. */
  getVisibleEntityIds(): readonly EntityId[] | undefined {
    if (!this.isFiltered) return undefined;
    this.ensureEntityIdBuffers();
    return this.visibleEntityIds;
  }

  getVisibleEntityIdSet(): ReadonlySet<EntityId> | undefined {
    if (!this.isFiltered) return undefined;
    this.ensureEntityIdBuffers();
    return this.visibleEntityIdSet;
  }

  /** Full-vision + radar-contact ids for minimap serialization. */
  getRadarEntityIds(): readonly EntityId[] | undefined {
    if (!this.isFiltered) return undefined;
    this.ensureEntityIdBuffers();
    return this.radarEntityIds;
  }

  private ensureEntityIdBuffers(): void {
    if (this.entityIdBuffersReady) return;
    this.entityIdBuffersReady = true;
    this.visibleEntityIds.length = 0;
    this.radarEntityIds.length = 0;
    this.visibleEntityIdSet.clear();
    this.radarEntityIdSet.clear();
    this.fullCandidateEntityIdSet.clear();
    this.radarCandidateEntityIdSet.clear();

    let pending = this.viewMask;
    while (pending !== 0) {
      const lowBit = pending & -pending;
      const playerId = (32 - Math.clz32(lowBit)) as PlayerId;
      this.addOwnedEntityIds(playerId);
      pending ^= lowBit;
    }

    if (getSimWasm() === undefined) {
      this.addWorldScanEntityCandidates();
      return;
    }

    if (this.addNativeObservationMaskEntityCandidates()) return;
    this.addSourceEntityCandidates(this.fullSources, true);
    this.addSourceEntityCandidates(this.radarSources, false);
    this.addSourceEntityCandidates(this.detectorSources, true);
  }

  private addNativeObservationMaskEntityCandidates(): boolean {
    // Scan pulses are merged into targeting observation masks during the
    // normal combat stamp, but this serializer owns pulse wire output. Use
    // the legacy source walk on pulse frames so a just-created pulse cannot
    // be missed if a snapshot is emitted before the next combat stamp.
    if (this.world.scanPulses.length > 0) return false;
    const sim = getSimWasm();
    const entityViews = entitySlotRegistry.getViews();
    if (sim === undefined || entityViews === null) return false;

    const targeting = sim.combatTargeting;
    const combatCapacity = targeting.entityCapacity();
    const capacity = Math.min(entityViews.capacity, combatCapacity);
    if (capacity <= 0) return false;

    const buffer = sim.memory.buffer;
    const combatEntityId = new Int32Array(buffer, targeting.entityIdPtr(), combatCapacity);
    const combatFlags = new Uint8Array(buffer, targeting.entityFlagsPtr(), combatCapacity);
    const sensorCoverageMask = new Uint32Array(
      buffer,
      targeting.entitySensorCoverageMaskPtr(),
      combatCapacity,
    );
    const fullSightCoverageMask = new Uint32Array(
      buffer,
      targeting.entityFullSightCoverageMaskPtr(),
      combatCapacity,
    );
    const detectorCoverageMask = new Uint32Array(
      buffer,
      targeting.entityDetectorCoverageMaskPtr(),
      combatCapacity,
    );

    const viewMask = this.viewMask >>> 0;
    let stampedRows = 0;
    for (let slot = 0; slot < capacity; slot++) {
      const id = entityViews.entityId[slot];
      if (id < 0 || combatEntityId[slot] !== id) continue;
      const flags = combatFlags[slot];
      if ((flags & CT_ENTITY_FLAG_ALIVE) === 0) continue;
      const kind = entityViews.kind[slot];
      if (
        kind !== ENTITY_STATE_KIND_UNIT &&
        kind !== ENTITY_STATE_KIND_BUILDING &&
        kind !== ENTITY_STATE_KIND_TOWER
      ) {
        continue;
      }
      stampedRows++;

      const ownerPlayerId = entityViews.ownerPlayerId[slot];
      if (ownerPlayerId !== 0 && (viewMask & (1 << (ownerPlayerId - 1))) !== 0) {
        continue;
      }

      const detectorCovered = (detectorCoverageMask[slot] & viewMask) !== 0;
      const cloaked = (flags & CT_ENTITY_FLAG_CLOAKED) !== 0;
      if (cloaked) {
        if (detectorCovered) {
          this.appendVisibleEntityIdById(id);
          this.appendRadarEntityIdById(id);
        }
        continue;
      }

      const radarCovered = (sensorCoverageMask[slot] & viewMask) !== 0;
      const fullSightCovered = (fullSightCoverageMask[slot] & viewMask) !== 0;
      if (fullSightCovered) {
        const visible = this.isEntityStateSlotVisibleWithLos(entityViews, slot, kind);
        this.entityVisibilityMemo.set(id, visible);
        if (visible) {
          this.appendVisibleEntityIdById(id);
          this.appendRadarEntityIdById(id);
          continue;
        }
      }
      if (radarCovered || detectorCovered) this.appendRadarEntityIdById(id);
    }
    return stampedRows > 0;
  }

  private isEntityStateSlotVisibleWithLos(
    views: EntityStateViews,
    slot: number,
    kind: number,
  ): boolean {
    const padding = kind === ENTITY_STATE_KIND_UNIT
      ? Math.max(
          views.radiusOther[slot],
          views.radiusHitbox[slot],
          views.radiusCollision[slot],
        )
      : views.radiusOther[slot];
    return this.isEntityVisibleWithLos(
      views.posX[slot],
      views.posY[slot],
      views.posZ[slot],
      padding,
    );
  }

  private addOwnedEntityIds(playerId: PlayerId): void {
    this.addOwnedEntitySource(this.world.getUnitsByPlayer(playerId));
    this.addOwnedEntitySource(this.world.getBuildingsByPlayer(playerId));
  }

  private addOwnedEntitySource(source: readonly Entity[]): void {
    for (let i = 0; i < source.length; i++) {
      const entity = source[i];
      this.appendVisibleEntityId(entity);
      this.appendRadarEntityId(entity);
    }
  }

  private addWorldScanEntityCandidates(): void {
    const sources: ReadonlyArray<readonly Entity[]> = [
      this.world.getUnits(),
      this.world.getBuildings(),
    ];
    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        this.addCandidateEntity(entity, true);
      }
    }
  }

  private addSourceEntityCandidates(
    sources: readonly VisionSource[],
    canGrantFullVisibility: boolean,
  ): void {
    const maxPadding = this.world.getMaxVisibilityPadding();
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const candidates = spatialGrid.queryUnitsAndBuildingsInRadius(
        source.x,
        source.y,
        source.z,
        source.radius + maxPadding,
      );
      const units = candidates.units;
      for (let u = 0; u < units.length; u++) {
        this.addCandidateEntity(units[u], canGrantFullVisibility);
      }
      const buildings = candidates.buildings;
      for (let b = 0; b < buildings.length; b++) {
        this.addCandidateEntity(buildings[b], canGrantFullVisibility);
      }
    }
  }

  private addCandidateEntity(entity: Entity, canGrantFullVisibility: boolean): void {
    const id = entity.id;

    if (canGrantFullVisibility) {
      if (this.visibleEntityIdSet.has(id)) {
        this.appendRadarEntityId(entity);
        this.radarCandidateEntityIdSet.add(id);
        return;
      }

      if (!this.fullCandidateEntityIdSet.has(id)) {
        this.fullCandidateEntityIdSet.add(id);
        if (this.isEntityVisible(entity)) {
          this.appendVisibleEntityId(entity);
          this.appendRadarEntityId(entity);
          this.radarCandidateEntityIdSet.add(id);
          return;
        }
      }
    }

    if (this.radarEntityIdSet.has(id) || this.radarCandidateEntityIdSet.has(id)) return;
    this.radarCandidateEntityIdSet.add(id);
    if (this.isEntityOnRadar(entity)) this.appendRadarEntityId(entity);
  }

  private appendVisibleEntityId(entity: Entity): void {
    this.appendVisibleEntityIdById(entity.id);
  }

  private appendVisibleEntityIdById(id: EntityId): void {
    if (this.visibleEntityIdSet.has(id)) return;
    this.visibleEntityIdSet.add(id);
    this.visibleEntityIds.push(id);
  }

  private appendRadarEntityId(entity: Entity): void {
    this.appendRadarEntityIdById(entity.id);
  }

  private appendRadarEntityIdById(id: EntityId): void {
    if (this.radarEntityIdSet.has(id)) return;
    this.radarEntityIdSet.add(id);
    this.radarEntityIds.push(id);
  }

  /** Full-vision point test. Audio events and projectile spawns hang
   *  off this — radar coverage doesn't leak sound or beam visuals. */
  isPointVisible(x: number, y: number, padding = 0): boolean {
    if (!this.isFiltered) return true;
    return this.isPointVisibleIn(this.fullSources, this.fullSourceCells, x, y, padding);
  }

  /** True when the point sits inside any of the recipient's
   *  full-vision sources extended by EARSHOT_PAD. Used by the audio
   *  serializer for the FOW-09 distant-gunfire forwarding: events
   *  outside isPointVisible but inside the earshot pad ride along
   *  with audioOnly=true. Returns true unconditionally when fog is
   *  off, so admin observers still hear everything. */
  isPointWithinEarshot(x: number, y: number): boolean {
    if (!this.isFiltered) return true;
    return this.isPointVisibleIn(this.fullSources, this.earshotSourceCells, x, y, EARSHOT_PAD);
  }

  /** Combined vision/earshot test in a single bucket walk
   *  (FOW-OPT-08). The audio path used to call
   *  isPointVisible AND isPointWithinEarshot in sequence — two
   *  spatial-hash lookups + two walks of the same cell bucket per
   *  fog-hidden event. This single helper returns IN_VISION as
   *  soon as one source covers the point (mirrors isPointVisible's
   *  early-return), demotes to IN_EARSHOT when only the padded
   *  radius reaches, and returns OUT_OF_RANGE when no candidate
   *  qualifies. With fog disabled the recipient hears everything,
   *  so it returns IN_VISION unconditionally. */
  classifyPointVisibility(x: number, y: number): VisibilityClass {
    if (!this.isFiltered) return VISIBILITY_CLASS_IN_VISION;
    const cx = Math.floor(x / VISION_CELL_SIZE);
    const cy = Math.floor(y / VISION_CELL_SIZE);
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) {
      return VISIBILITY_CLASS_OUT_OF_RANGE;
    }
    const sourceIndexes = this.earshotSourceCells.get(this.cellKey(cx, cy));
    if (!sourceIndexes) return VISIBILITY_CLASS_OUT_OF_RANGE;
    let result: VisibilityClass = VISIBILITY_CLASS_OUT_OF_RANGE;
    for (let i = 0; i < sourceIndexes.length; i++) {
      const source = this.fullSources[sourceIndexes[i]];
      const dx = x - source.x;
      const dy = y - source.y;
      const distSq = dx * dx + dy * dy;
      const visionR = source.radius;
      if (distSq <= visionR * visionR) return VISIBILITY_CLASS_IN_VISION;
      // Vision dominates earshot; the padded earshot broadphase makes
      // radius + EARSHOT_PAD candidates available even outside the full
      // vision cell footprint.
      if (result === VISIBILITY_CLASS_OUT_OF_RANGE) {
        const earshotR = source.radius + EARSHOT_PAD;
        if (distSq <= earshotR * earshotR) result = VISIBILITY_CLASS_IN_EARSHOT;
      }
    }
    return result;
  }

  shouldSendRemoval(record: RemovedSnapshotEntity): boolean {
    if (!this.isFiltered) return true;
    if (this.isOwnedByRecipientOrAlly(record.playerId)) return true;
    return this.isPointVisible(record.x, record.y);
  }

  /** True when the recipient (or any of their allies under FOW-06)
   *  authored the event and so should receive it regardless of vision.
   *  Callers:
   *
   *    - FOW-17 kill credit. Death SimEvents carry the killer's
   *      playerId; passing that here keeps the death notification in
   *      the killer's (and their teammates') audio stream even when
   *      the corpse falls outside their full vision.
   *    - Own pings. Minimap pings carry the pinger's playerId; the
   *      pinger plus their team see the marker even on fog points.
   *    - FOW-08 attackAlert (victimPlayerId). The victim and their
   *      allies see the marker at the attacker's position when an
   *      otherwise-silent splash from fog lands on a teammate's unit. */
  isAuthoredByRecipient(authorPlayerId: PlayerId | undefined): boolean {
    return this.isOwnedByRecipientOrAlly(authorPlayerId);
  }

  private addPlayerSources(world: WorldState, playerId: PlayerId): void {
    const sources: ReadonlyArray<readonly Entity[]> = [
      world.getUnitsByPlayer(playerId),
      world.getBuildingsByPlayer(playerId),
    ];
    for (let s = 0; s < sources.length; s++) {
      const source = sources[s];
      for (let i = 0; i < source.length; i++) {
        const entity = source[i];
        // Eye z = entity's ground height plus a fixed offset (FOW-04).
        // A unit standing on a hill already has transform.z lifted by
        // the hill, so the constant just adds the body / turret mount
        // height — units on flat ground can still see over a small
        // bump, units behind a tall ridge can't.
        const eyeZ = entity.transform.z + VISION_SOURCE_EYE_HEIGHT;
        if (canEntityProvideFullVision(entity)) {
          const radius = getEntityFullVisionRadius(entity);
          const sourceIndex = this.addSource(
            this.fullSources,
            this.fullSourceCells,
            entity.transform.x,
            entity.transform.y,
            eyeZ,
            radius,
          );
          if (sourceIndex >= 0) {
            this.addSourceCells(
              this.earshotSourceCells,
              sourceIndex,
              entity.transform.x,
              entity.transform.y,
              radius + EARSHOT_PAD,
            );
          }
        }
        if (canEntityProvideRadarVision(entity)) {
          this.addSource(
            this.radarSources,
            this.radarSourceCells,
            entity.transform.x,
            entity.transform.y,
            eyeZ,
            getEntityRadarRadius(entity),
          );
        }
        if (canEntityProvideCloakDetection(entity)) {
          this.addSource(
            this.detectorSources,
            this.detectorSourceCells,
            entity.transform.x,
            entity.transform.y,
            eyeZ,
            getEntityCloakDetectionRadius(entity),
          );
        }
      }
    }
  }

  /** Wire rows for the recipient's team-owned scan pulses, built in
   *  the same pass that seeds the spatial-hash sources
   *  (FOW-OPT-16). Shared across teammates via the
   *  per-emit visibility cache so two teammates' snapshots ship the
   *  same row source instead of each walking world.scanPulses
   *  independently to produce identical content. */
  private readonly cachedScanPulseWireSource: ScanPulseWireSource = createFloat64WireRows();
  private readonly cachedScanPulseDtos: NetworkServerSnapshotScanPulse[] = [];
  private cachedScanPulseDtoCount = -1;

  /** Merge active scan pulses into the full-vision source pool for any
   *  pulse owned by the recipient or one of their allies (FOW-14 +
   *  FOW-06). Pulses don't currently grant radar vision —
   *  treat them as a brief floodlight only. Also populates the
   *  cached wire-row source for scan-pulse serialization (FOW-OPT-16)
   *  so direct wire serialization is a lookup, not a second filter walk. */
  private addScanPulseSources(world: WorldState): void {
    this.cachedScanPulseWireSource.count = 0;
    this.cachedScanPulseDtos.length = 0;
    this.cachedScanPulseDtoCount = -1;
    const pulses = world.scanPulses;
    if (pulses.length === 0) return;
    for (let i = 0; i < pulses.length; i++) {
      const pulse = pulses[i];
      if ((this.viewMask & (1 << (pulse.playerId - 1))) === 0) continue;
      const sourceIndex = this.addSource(
        this.fullSources,
        this.fullSourceCells,
        pulse.x,
        pulse.y,
        pulse.z + VISION_SOURCE_EYE_HEIGHT,
        pulse.radius,
      );
      this.addSource(
        this.detectorSources,
        this.detectorSourceCells,
        pulse.x,
        pulse.y,
        pulse.z + VISION_SOURCE_EYE_HEIGHT,
        pulse.radius,
      );
      if (sourceIndex >= 0) {
        this.addSourceCells(
          this.earshotSourceCells,
          sourceIndex,
          pulse.x,
          pulse.y,
          pulse.radius + EARSHOT_PAD,
        );
      }
      appendScanPulseWireRow(this.cachedScanPulseWireSource, pulse);
    }
  }

  /** Per-team scan-pulse DTO array materialized lazily from the
   *  row cache. Filtered visibilities only — admin / spectator paths
   *  fall back to a full re-walk in serializeScanPulses. Callers must
   *  not mutate the returned array; it's shared across teammates via
   *  the visibility cache. */
  getCachedScanPulseDtos(): NetworkServerSnapshotScanPulse[] {
    const source = this.cachedScanPulseWireSource;
    if (this.cachedScanPulseDtoCount === source.count) {
      return this.cachedScanPulseDtos;
    }

    const dtos = this.cachedScanPulseDtos;
    dtos.length = source.count;
    const values = source.values;
    for (let i = 0; i < source.count; i++) {
      let dto = dtos[i];
      if (dto === undefined) {
        dto = {
          playerId: 1,
          x: 0,
          y: 0,
          z: 0,
          radius: 0,
          expiresAtTick: 0,
        };
        dtos[i] = dto;
      }
      const base = i * SCAN_PULSE_WIRE_STRIDE;
      dto.playerId = values[base + 0] as PlayerId;
      dto.x = values[base + 1];
      dto.y = values[base + 2];
      dto.z = values[base + 3];
      dto.radius = values[base + 4];
      dto.expiresAtTick = values[base + 5];
    }
    this.cachedScanPulseDtoCount = source.count;
    return dtos;
  }

  getCachedScanPulseWireSource(): ScanPulseWireSource {
    return this.cachedScanPulseWireSource;
  }

  private addSource(
    sources: VisionSource[],
    cells: Map<number, number[]>,
    x: number,
    y: number,
    z: number,
    radius: number,
  ): number {
    if (radius <= 0) return -1;
    const index = sources.length;
    sources.push({ x, y, z, radius });
    this.addSourceCells(cells, index, x, y, radius);
    return index;
  }

  private addSourceCells(
    cells: Map<number, number[]>,
    sourceIndex: number,
    x: number,
    y: number,
    radius: number,
  ): void {
    const minCx = Math.max(0, Math.floor((x - radius) / VISION_CELL_SIZE));
    const maxCx = Math.min(this.gridW - 1, Math.floor((x + radius) / VISION_CELL_SIZE));
    const minCy = Math.max(0, Math.floor((y - radius) / VISION_CELL_SIZE));
    const maxCy = Math.min(this.gridH - 1, Math.floor((y + radius) / VISION_CELL_SIZE));
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = this.cellKey(cx, cy);
        let bucket = cells.get(key);
        if (!bucket) {
          bucket = [];
          cells.set(key, bucket);
        }
        bucket.push(sourceIndex);
      }
    }
  }

  private isPointVisibleIn(
    sources: VisionSource[],
    cells: Map<number, number[]>,
    x: number,
    y: number,
    padding: number,
  ): boolean {
    const cx = Math.floor(x / VISION_CELL_SIZE);
    const cy = Math.floor(y / VISION_CELL_SIZE);
    if (cx < 0 || cy < 0 || cx >= this.gridW || cy >= this.gridH) return false;
    const sourceIndexes = cells.get(this.cellKey(cx, cy));
    if (!sourceIndexes) return false;
    for (let i = 0; i < sourceIndexes.length; i++) {
      const source = sources[sourceIndexes[i]];
      const dx = x - source.x;
      const dy = y - source.y;
      const r = source.radius + padding;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  private cellKey(cx: number, cy: number): number {
    return cy * this.gridW + cx;
  }
}

/** Per-emit cache used to share one SnapshotVisibility across every
 *  recipient on the same team (FOW-OPT-01). The publisher
 *  creates one of these at the top of each emit() and threads it into
 *  the per-listener serializer; the rebuild cost — iterating every
 *  team unit + building + scan pulse and inserting them into the
 *  spatial hash — runs once per team per snapshot instead of once per
 *  listener per snapshot. */
type SnapshotVisibilityCache = Map<string, SnapshotVisibility>;

export function createSnapshotVisibilityCache(): SnapshotVisibilityCache {
  return new Map();
}

/** Look up the team's SnapshotVisibility in the cache, building it on
 *  first call and reusing it for every subsequent teammate. Admin /
 *  spectator visibilities (no recipient) are not cacheable — every
 *  caller wants the same unfiltered instance, but mixing them with
 *  the team map would collide on the missing key — so they fall
 *  through to the standard constructor. */
export function getOrBuildVisibility(
  world: WorldState,
  recipientPlayerId: PlayerId | undefined,
  cache: SnapshotVisibilityCache | undefined,
): SnapshotVisibility {
  // Admin / spectator visibilities are never cached — each caller wants
  // its own unfiltered instance, and they don't share a team-mask key.
  if (recipientPlayerId === undefined || !cache) {
    return SnapshotVisibility.forRecipient(world, recipientPlayerId);
  }
  // Compute the team mask once (one getAllies walk) and use it for
  // both the cache key AND the SnapshotVisibility's viewMask, so a
  // cache miss doesn't pay a second walk in the constructor
  // (FOW-OPT-21).
  let mask = 1 << (recipientPlayerId - 1);
  for (const allyId of world.getAllies(recipientPlayerId)) {
    mask |= 1 << (allyId - 1);
  }
  const key = mask.toString(36);
  const cached = cache.get(key);
  if (cached) return cached;
  const fresh = SnapshotVisibility.forRecipient(world, recipientPlayerId, mask);
  cache.set(key, fresh);
  return fresh;
}

/** Reusable buffer for the admin / spectator path only — filtered
 *  visibilities read from SnapshotVisibility's scan-pulse row cache
 *  (FOW-OPT-16) which is built once per team during
 *  forRecipient's source-merge pass. */
const _scanPulseBuf: NetworkServerSnapshotScanPulse[] = [];

export function writeScanPulseWireRowsDirect(
  world: WorldState,
  visibility: SnapshotVisibility,
  pulsesOut: NetworkServerSnapshotScanPulse[],
): NetworkServerSnapshotScanPulse[] | undefined {
  pulsesOut.length = 0;
  const source = visibility.isFiltered
    ? visibility.getCachedScanPulseWireSource()
    : directScanPulseWireSource;
  if (!visibility.isFiltered) {
    source.count = 0;
    const pulses = world.scanPulses;
    for (let i = 0; i < pulses.length; i++) {
      appendScanPulseWireRow(source, pulses[i]);
    }
  }
  if (source.count === 0) return undefined;
  scanPulseWireSources.set(pulsesOut, source);
  pulsesOut.length = source.count;
  return pulsesOut;
}

/** Filter the world's active scan pulses down to the ones the
 *  recipient's team owns (FOW-14 + FOW-06). When no team owns any
 *  live pulses, returns undefined so the snapshot field stays absent.
 *  When fog is disabled, returns all pulses regardless of owner —
 *  admin / observer modes should see the whole picture.
 *
 *  FOW-OPT-16: for filtered (player-bound) visibilities this just
 *  hands back the cached DTO array that addScanPulseSources already
 *  built; two teammates ship the same reference without each
 *  re-walking world.scanPulses to produce identical content. */
export function serializeScanPulses(
  world: WorldState,
  visibility: SnapshotVisibility,
): NetworkServerSnapshotScanPulse[] | undefined {
  if (visibility.isFiltered) {
    const cached = visibility.getCachedScanPulseDtos();
    if (cached.length > 0) {
      scanPulseWireSources.set(cached, visibility.getCachedScanPulseWireSource());
    }
    return cached.length > 0 ? cached : undefined;
  }
  const pulses = world.scanPulses;
  if (pulses.length === 0) return undefined;
  _scanPulseBuf.length = 0;
  _scanPulseWireSource.count = 0;
  scanPulseWireSources.set(_scanPulseBuf, _scanPulseWireSource);
  for (let i = 0; i < pulses.length; i++) {
    const pulse = pulses[i];
    const out = {
      playerId: pulse.playerId,
      x: pulse.x,
      y: pulse.y,
      z: pulse.z,
      radius: pulse.radius,
      expiresAtTick: pulse.expiresAtTick,
    };
    _scanPulseBuf.push(out);
    appendScanPulseWireRow(_scanPulseWireSource, out);
  }
  return _scanPulseBuf.length > 0 ? _scanPulseBuf : undefined;
}
