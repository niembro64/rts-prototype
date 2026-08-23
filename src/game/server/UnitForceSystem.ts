// UnitForceSystem - authoritative force orchestration for unit physics bodies.
// TypeScript gathers entity/terrain inputs, the Rust/WASM batch owns the
// per-unit force decisions and writes BodyPool acceleration directly.

import {
  airSurfaceLiftMediumIsActive,
  getSurfaceLiftInverseDistanceResponse,
  getSurfaceLiftInverseDistanceToSurfaceWorld,
  getSurfaceLiftWaterDepthWorld,
} from '../sim/surfaceLiftDistanceResponse';
import { resolveSurfaceLiftGroundZ } from '../sim/surfaceLiftGroundSupport';
import {
  accumulateSurfaceProbeProposedForce,
  finalizeSurfaceProbeProposedForce,
  surfaceProbeUsesWaterSurface,
} from '../sim/surfaceProbeAggregation';
import {
  forEachSurfaceProbePoint,
  SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD,
  SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
} from '../sim/surfaceProbeSets';
import { SurfaceLiftProbeSampleCache } from './SurfaceLiftProbeSampleCache';
import { isUnitGroundPenetrationInContact } from '../sim/unitGroundPhysics';
import { WATER_LEVEL, getTerrainVersion } from '../sim/Terrain';
import {
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_NORMAL,
  ENTITY_CHANGED_HP,
} from '../../types/network';
import type { Simulation } from '../sim/Simulation';
import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId } from '../sim/types';
import type { SurfaceProbeSetId } from '@/types/unitLocomotionTypes';
import type { SurfaceLiftProbeDebugFrame } from '@/types/game';
import type { PhysicsEngine3D, SupportSurfaceContact } from './PhysicsEngine3D';
import { createWorldSupportSurface } from '../sim/supportSurface';
import { isBuildInProgress } from '../sim/buildableHelpers';
import {
  ENTITY_SLOT_BUILD_FLAG_COMPLETE,
  ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE,
  ENTITY_SLOT_BUILD_FLAG_INTERRUPTED,
  ENTITY_SLOT_FLAG_HAS_BODY,
  ENTITY_SLOT_FLAG_HAS_UNIT,
  ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY,
  ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION,
  entitySlotRegistry,
} from '../sim/EntitySlotRegistry';
import {
  ENTITY_STATE_KIND_UNIT,
  ENTITY_STATE_NO_BODY_SLOT,
  getSimWasm,
  UNIT_FORCE_BATCH_STRIDE,
  type SimWasm,
} from '../sim-wasm/init';
import { codeToUnitBlueprintId } from '../../types/network';
import { getUnitLocomotion } from '../sim/blueprints';
import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';

const SUPPORT_SURFACE_NORMAL_DIRTY_EPSILON = 1e-6;

const UF_ROW_DIR_X = 0;
const UF_ROW_DIR_Y = 1;
const UF_ROW_ROTATION = 2;
// Row 3 reserved; Rust reads effective mass from BodyPool.
// Rows 0-1 and 47-48 are filled by the kernel from native entity-state
// drive-input rows when an entity slot is available.
// Profile-owned locomotion values are filled by the kernel from its native
// blueprint table. TypeScript supplies only dynamic terrain and probe input.
const UF_ROW_GROUND_Z = 12;
const UF_ROW_NORMAL_X = 13;
const UF_ROW_NORMAL_Y = 14;
const UF_ROW_NORMAL_Z = 15;
const UF_ROW_EXTERNAL_FX = 16;
const UF_ROW_ORIENTATION_X = 19;
const UF_ROW_ORIENTATION_Y = 20;
const UF_ROW_ORIENTATION_Z = 21;
const UF_ROW_ORIENTATION_W = 22;
const UF_ROW_OMEGA_X = 23;
const UF_ROW_OMEGA_Y = 24;
const UF_ROW_OMEGA_Z = 25;
const UF_ROW_HEADING_X = 47;
const UF_ROW_HEADING_Y = 48;
const UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE = 55;
const UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE = 56;
const UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE = 58;

const UF_FLAG_HAS_THRUST = 1 << 0;
const UF_FLAG_IS_AIRBORNE_CRUISING = 1 << 1;
const UF_FLAG_IS_AIRBORNE = 1 << 2;
const UF_FLAG_BLOCKED_OR_DEAD = 1 << 3;
const UF_FLAG_HAS_EXTERNAL_FORCE = 1 << 4;
const UF_FLAG_HAS_ORIENTATION = 1 << 7;
const UF_FLAG_PROPULSION_BODY_FORWARD = 1 << 8;
const UF_FLAG_PROPULSION_FORWARD_ONLY = 1 << 9;
const UF_FLAG_ON_GROUND = 1 << 10;
const UF_FLAG_PROPULSION_ALWAYS_FORWARD = 1 << 11;
const UF_FLAG_HAS_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE = 1 << 14;
const UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE = 1 << 15;
const UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE = 1 << 17;
const UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED = 1 << 16;

const UF_OUT_CLEAR_COMBAT = 1 << 1;
const UF_OUT_ROTATION_DIRTY = 1 << 2;
const UF_OUT_HOVER_ORIENTATION = 1 << 3;
const UF_OUT_WOKE_BODY = 1 << 4;
const UF_OUT_ENTITY_STATE_SYNCED = 1 << 5;

const entitySlotForId = (entityId: EntityId): number => entitySlotRegistry.getSlot(entityId);

// The batch inputs/outputs live in WASM linear memory (ledger [25]) —
// these are views over the staging arrays exported by unit_kinetics.rs,
// so filling rows and reading results costs no boundary copies. WASM
// memory growth replaces the backing ArrayBuffer (detaching views whose
// writes then silently no-op) but never moves existing data, so the
// cached pointers stay valid until the next staging_ensure growth;
// refreshForceStagingViews re-derives the views on buffer identity
// change and MUST run after any wasm call that can allocate before the
// views are touched again.
let _forceSlots: Uint32Array = new Uint32Array(0);
let _forceEntitySlots: Uint32Array = new Uint32Array(0);
let _forceFlags: Uint32Array = new Uint32Array(0);
let _forceRows: Float64Array = new Float64Array(0);
let _forceOutFlags: Uint32Array = new Uint32Array(0);
let _forceStagingBuffer: ArrayBufferLike | null = null;
let _forceStagingCapacity = 0;
let _forceStagingSlotsPtr = 0;
let _forceStagingFlagsPtr = 0;
let _forceStagingRowsPtr = 0;
let _forceStagingOutFlagsPtr = 0;

function rebuildForceStagingViews(sim: SimWasm): void {
  const buffer = sim.memory.buffer;
  _forceStagingBuffer = buffer;
  _forceSlots = new Uint32Array(buffer, _forceStagingSlotsPtr, _forceStagingCapacity);
  _forceFlags = new Uint32Array(buffer, _forceStagingFlagsPtr, _forceStagingCapacity);
  _forceRows = new Float64Array(
    buffer,
    _forceStagingRowsPtr,
    _forceStagingCapacity * UNIT_FORCE_BATCH_STRIDE,
  );
  _forceOutFlags = new Uint32Array(buffer, _forceStagingOutFlagsPtr, _forceStagingCapacity);
}

function refreshForceStagingViews(sim: SimWasm): void {
  if (sim.memory.buffer !== _forceStagingBuffer) rebuildForceStagingViews(sim);
}
let _forceTerrainGroundZ: Float64Array = new Float64Array(0);
const _surfaceLiftProposedForces = {
  airInverse: 0,
  waterInverse: 0,
  waterProportional: 0,
};
let _forceTerrainGroundNormals: Float64Array = new Float64Array(0);
let _forceTerrainMaterialFlags: Uint32Array = new Uint32Array(0);
const _forceTerrainSurface = createWorldSupportSurface();
const _forceSupportSurface = createWorldSupportSurface();
const _forceProbeSupportSurface = createWorldSupportSurface();

function ensureForceBatchCapacity(sim: SimWasm, count: number): void {
  if (count > _forceStagingCapacity) {
    const next = Math.max(count, _forceStagingCapacity * 2, 256);
    sim.unitForceStagingEnsure(next);
    _forceStagingCapacity = next;
    // Growth may have moved the staging arrays — re-fetch every pointer.
    _forceStagingSlotsPtr = sim.unitForceStagingSlotsPtr();
    _forceStagingFlagsPtr = sim.unitForceStagingFlagsPtr();
    _forceStagingRowsPtr = sim.unitForceStagingRowsPtr();
    _forceStagingOutFlagsPtr = sim.unitForceStagingOutFlagsPtr();
    rebuildForceStagingViews(sim);
  } else {
    refreshForceStagingViews(sim);
  }
  if (_forceEntitySlots.length < count) {
    const next = Math.max(count, _forceEntitySlots.length * 2, 256);
    _forceEntitySlots = new Uint32Array(next);
  }
  if (_forceTerrainGroundZ.length < count) {
    const next = Math.max(count, _forceTerrainGroundZ.length * 2, 256);
    _forceTerrainGroundZ = new Float64Array(next);
  }
  if (_forceTerrainMaterialFlags.length < count) {
    const next = Math.max(count, _forceTerrainMaterialFlags.length * 2, 256);
    _forceTerrainMaterialFlags = new Uint32Array(next);
  }
  const normalLen = count * 3;
  if (_forceTerrainGroundNormals.length < normalLen) {
    const next = Math.max(normalLen, _forceTerrainGroundNormals.length * 2, 256 * 3);
    _forceTerrainGroundNormals = new Float64Array(next);
  }
}

/** Slot order kept in lockstep with UF_PROFILE_* in unit_kinetics.rs. */
const UF_PROFILE_STRIDE = 15;

let _unitForceProfileTableUploaded = false;
let _unitForceProfileCodeCount = 0;
let _unitForceProfileFlagsView: Uint32Array | null = null;
let _unitForceProfileSignature = '';

type UnitForceProfileSignature = {
  codeCount: number;
  signature: string;
};

function buildUnitForceProfileSignature(): UnitForceProfileSignature {
  let codeCount = 0;
  let signature = '';
  while (codeToUnitBlueprintId(codeCount) !== null) {
    const unitBlueprintId = codeToUnitBlueprintId(codeCount);
    if (unitBlueprintId !== null) {
      const loco = getUnitLocomotion(unitBlueprintId);
      const { ground, air, water } = loco.physics;
      signature += [
        codeCount,
        loco.navigation.move.allowOnGround ? ground.maxPropulsiveForce : 0,
        ground.staticFrictionCoefficient,
        ground.tangentialDampingRate,
        // Navigation permissions select legal route cells. They must not erase
        // a physical medium drive: a partly exposed amphibian still needs its
        // air force while crossing the waterline.
        air.maxPropulsiveForce,
        air.lift.surfaceFollowingInverseForceFromGround,
        air.lift.surfaceFollowingInverseForceFromWater,
        air.resistance.linearDampingRate,
        air.resistance.angularDampingRate,
        water.maxPropulsiveForce,
        water.lift.surfaceFollowingInverseForceFromGround,
        water.lift.surfaceFollowingProportionalForceFromWater,
        water.resistance.linearDampingRate,
        water.resistance.angularDampingRate,
        loco.environmentalHazards.waterDamagePerSecond,
        loco.actuator.propulsionAxis,
        loco.actuator.turnRateDegreesPerSecond ?? 0,
        loco.motionControl.cruiseWhenUncommanded ? 1 : 0,
      ].join(':') + '|';
    }
    codeCount++;
  }
  return { codeCount, signature };
}

/** Upload the per-blueprint locomotion constants to the wasm-side
 *  profile table once. The force kernel resolves body slot → entity
 *  slot → blueprint code and fills the constant row slots itself, so
 *  the per-tick pack loop no longer copies them per unit. Values must
 *  mirror the row constants consumed by the Rust kernel. */
function ensureUnitForceProfileTable(sim: SimWasm): void {
  const profileSignature = import.meta.env.DEV
    ? buildUnitForceProfileSignature()
    : null;
  if (
    _unitForceProfileTableUploaded &&
    (profileSignature === null ||
      (
        profileSignature.codeCount === _unitForceProfileCodeCount &&
        profileSignature.signature === _unitForceProfileSignature
      ))
  ) {
    return;
  }
  const codeCount = profileSignature?.codeCount ?? (() => {
    let count = 0;
    while (codeToUnitBlueprintId(count) !== null) count++;
    return count;
  })();
  sim.unitForceProfileEnsure(codeCount);
  _unitForceProfileCodeCount = codeCount;
  const values = new Float64Array(
    sim.memory.buffer,
    sim.unitForceProfileValuesPtr(),
    codeCount * UF_PROFILE_STRIDE,
  );
  const flags = new Uint32Array(sim.memory.buffer, sim.unitForceProfileFlagsPtr(), codeCount);
  _unitForceProfileFlagsView = flags;
  for (let code = 0; code < codeCount; code++) {
    const unitBlueprintId = codeToUnitBlueprintId(code);
    if (unitBlueprintId === null) continue;
    const loco = getUnitLocomotion(unitBlueprintId);
    const { ground, air, water } = loco.physics;
    const base = code * UF_PROFILE_STRIDE;
    values[base + 0] = loco.navigation.move.allowOnGround ? ground.maxPropulsiveForce : 0;
    values[base + 1] = ground.staticFrictionCoefficient;
    values[base + 2] = ground.tangentialDampingRate;
    // Air and water drives are physics, not pathfinding permissions. The
    // kernel weights each by the body's occupied fraction of that medium.
    values[base + 3] = air.maxPropulsiveForce;
    values[base + 4] = air.lift.surfaceFollowingInverseForceFromGround;
    values[base + 5] = air.lift.surfaceFollowingInverseForceFromWater;
    values[base + 6] = air.resistance.linearDampingRate;
    values[base + 7] = air.resistance.angularDampingRate;
    values[base + 8] = water.maxPropulsiveForce;
    values[base + 9] = water.lift.surfaceFollowingInverseForceFromGround;
    values[base + 10] = water.lift.surfaceFollowingProportionalForceFromWater;
    values[base + 11] = water.resistance.linearDampingRate;
    values[base + 12] = water.resistance.angularDampingRate;
    values[base + 13] = loco.environmentalHazards.waterDamagePerSecond;
    // Authored constant-rate yaw slew, degrees -> radians. Zero for every
    // actuator other than alwaysForward, which keeps the damped servo.
    values[base + 14] =
      loco.actuator.propulsionAxis === 'alwaysForward'
        ? (loco.actuator.turnRateDegreesPerSecond ?? 0) * (Math.PI / 180)
        : 0;
    flags[code] =
      (loco.actuator.propulsionAxis !== 'worldPlanar' ? UF_FLAG_PROPULSION_BODY_FORWARD : 0) |
      (loco.actuator.propulsionAxis === 'waypointForwardOnly' ? UF_FLAG_PROPULSION_FORWARD_ONLY : 0) |
      (loco.actuator.propulsionAxis === 'alwaysForward' ? UF_FLAG_PROPULSION_ALWAYS_FORWARD : 0) |
      (loco.motionControl.cruiseWhenUncommanded ? UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED : 0);
  }
  _unitForceProfileTableUploaded = true;
  _unitForceProfileSignature = profileSignature?.signature ?? '';
}

function getUnitForceProfileFlagsView(sim: SimWasm): Uint32Array {
  if (
    _unitForceProfileFlagsView === null ||
    _unitForceProfileFlagsView.buffer !== sim.memory.buffer
  ) {
    _unitForceProfileFlagsView = new Uint32Array(
      sim.memory.buffer,
      sim.unitForceProfileFlagsPtr(),
      _unitForceProfileCodeCount,
    );
  }
  return _unitForceProfileFlagsView;
}

export class UnitForceSystem {
  private readonly world: WorldState;
  private readonly simulation: Simulation;
  private readonly physics: PhysicsEngine3D;

  private physicsForceUnitSlotsBuf = new Uint32Array(1024);
  private physicsForceUnitSlotCount = 0;
  private physicsCandidateUnitSlotsBuf = new Uint32Array(1024);
  private physicsActiveUnitSlotMarks = new Uint32Array(1024);
  private physicsActiveUnitSlotMark = 1;
  private probeSupportIndexReady = false;
  /** Sampled surfaces under each lifted unit's outrigger probes, refreshed
   *  one deterministic bucket per tick instead of every unit every tick. */
  private readonly surfaceProbeSamples = new SurfaceLiftProbeSampleCache();
  private readonly surfaceLiftProbeDebugEntityIds = new Set<EntityId>();
  private readonly surfaceLiftProbeDebugFrames = new Map<EntityId, SurfaceLiftProbeDebugFrame>();

  constructor(world: WorldState, simulation: Simulation, physics: PhysicsEngine3D) {
    this.world = world;
    this.simulation = simulation;
    this.physics = physics;
  }

  setSurfaceLiftProbeDebugEntityIds(entityIds: readonly EntityId[]): void {
    this.surfaceLiftProbeDebugEntityIds.clear();
    for (let i = 0; i < entityIds.length; i++) {
      this.surfaceLiftProbeDebugEntityIds.add(entityIds[i]);
    }
    if (entityIds.length === 0) this.surfaceLiftProbeDebugFrames.clear();
  }

  getSurfaceLiftProbeDebugFrame(entityId: EntityId): SurfaceLiftProbeDebugFrame | undefined {
    return this.surfaceLiftProbeDebugFrames.get(entityId);
  }

  applyForces(dtSec: number): void {
    if (this.surfaceLiftProbeDebugEntityIds.size > 0) {
      this.surfaceLiftProbeDebugFrames.clear();
    }
    const sim = getSimWasm()!;
    ensureUnitForceProfileTable(sim);
    const waterDamagedCount = sim.unitWaterDamageStepPool(dtSec);
    const entityViews = entitySlotRegistry.getViews();
    if (waterDamagedCount > 0) {
      const damagedEntitySlots = new Uint32Array(
        sim.memory.buffer,
        sim.unitWaterDamagedEntitySlotsPtr(),
        waterDamagedCount,
      );
      for (let i = 0; i < waterDamagedCount; i++) {
        const entitySlot = damagedEntitySlots[i];
        const entity = entitySlotRegistry.resolveSlot(entitySlot);
        if (entity === undefined || entity.unit === null) continue;
        if (entityViews !== null && entitySlot < entityViews.capacity) {
          entity.unit.hp = entityViews.hp[entitySlot];
        }
        this.world.markSnapshotDirtyStateSynced(entity, ENTITY_CHANGED_HP);
      }
    }
    // Defensive: refresh BodyPool views in case WASM memory grew since
    // the last tick. See PhysicsEngine3D.step() for the detached-view
    // crash this guards against.
    sim.pool.refreshViews();
    const bodyViews = sim.pool;
    const profileFlagsView = getUnitForceProfileFlagsView(sim);

    const forceAccumulator = this.simulation.getForceAccumulator();
    const hasExternalForces = forceAccumulator.activeEntityCount() > 0;

    const activeSlots = this.collectPhysicsForceUnitSlots();
    if (activeSlots.length === 0) return;
    this.probeSupportIndexReady = false;

    ensureForceBatchCapacity(sim, activeSlots.length);

    let candidateCount = 0;
    for (let i = 0; i < activeSlots.length; i++) {
      const entitySlot = activeSlots[i];
      if (
        entityViews !== null &&
        entitySlot >= 0 &&
        entitySlot < entityViews.capacity &&
        entityViews.entityId[entitySlot] >= 0 &&
        entityViews.kind[entitySlot] === ENTITY_STATE_KIND_UNIT &&
        (entityViews.flags[entitySlot] & (ENTITY_SLOT_FLAG_HAS_BODY | ENTITY_SLOT_FLAG_HAS_UNIT)) ===
          (ENTITY_SLOT_FLAG_HAS_BODY | ENTITY_SLOT_FLAG_HAS_UNIT)
      ) {
        const bodySlot = entityViews.bodySlot[entitySlot];
        if (bodySlot !== ENTITY_STATE_NO_BODY_SLOT && bodySlot >= 0) {
          _forceSlots[candidateCount] = bodySlot;
          _forceEntitySlots[candidateCount] = entitySlot;
          candidateCount++;
          continue;
        }
      }
      const entity = entitySlotRegistry.resolveSlot(entitySlot);
      if (entity === undefined || entity.body === null || entity.unit === null) continue;
      _forceSlots[candidateCount] = entity.body.physicsBody.slot;
      _forceEntitySlots[candidateCount] = entitySlot;
      candidateCount++;
    }

    if (candidateCount === 0) return;

    const terrainSampled = measureWasmBoundary('server.unitForceTerrainSampleForceSupportForSlots', () =>
      sim.terrainSampleForceSupportForSlots(
        _forceSlots.subarray(0, candidateCount),
        _forceTerrainGroundZ.subarray(0, candidateCount),
        _forceTerrainGroundNormals.subarray(0, candidateCount * 3),
        _forceTerrainMaterialFlags.subarray(0, candidateCount),
      ),
    ) !== 0;
    // The terrain-sample call marshals copies inside WASM and can grow
    // memory, detaching the staging views written above (contents stay
    // put — growth never moves data). Re-derive before the row fill.
    refreshForceStagingViews(sim);
    const terrainOnlySupport =
      terrainSampled &&
      !this.physics.hasSupportSurfaceBodies() &&
      this.world.getSupportSurfaceEntities().length === 0;

    let count = 0;
    for (let i = 0; i < candidateCount; i++) {
      const entitySlot = _forceEntitySlots[i];
      const entity = entitySlotRegistry.resolveSlot(entitySlot);
      if (entity === undefined || entity.body === null || entity.unit === null) continue;

      const body = entity.body.physicsBody;
      const unit = entity.unit;
      const bodySlot = body.slot;
      const bodyX = bodyViews.posX[bodySlot];
      const bodyY = bodyViews.posY[bodySlot];
      const bodyZ = bodyViews.posZ[bodySlot];
      const bodyGroundOffset = bodyViews.groundOffset[bodySlot];
      const bodyRadius = bodyViews.radius[bodySlot] || 10;
      const base = count * UNIT_FORCE_BATCH_STRIDE;
      let profileFlags = 0;
      let hasProfileFlags = false;
      const hasEntityState =
        entityViews !== null &&
        entitySlot >= 0 &&
        entitySlot < entityViews.capacity &&
        entityViews.entityId[entitySlot] === entity.id &&
        entityViews.bodySlot[entitySlot] === bodySlot;
      if (hasEntityState) {
        const code = entityViews.unitBlueprintCode[entitySlot];
        if (code < _unitForceProfileCodeCount) {
          profileFlags = profileFlagsView[code];
          hasProfileFlags = true;
        }
      }

      _forceSlots[count] = bodySlot;
      _forceEntitySlots[count] = entitySlot;
      const rotationForPack = hasEntityState
        ? entityViews!.rotation[entitySlot]
        : entity.transform.rotation;
      _forceRows[base + UF_ROW_ROTATION] = rotationForPack;
      const supportSurface = this.sampleBodySupportSurface(
        body,
        bodyX,
        bodyY,
        _forceSupportSurface,
        terrainSampled,
        terrainOnlySupport,
        i,
      );
      const supportSurfaceContact =
        supportSurface.supportKind === 'building' || supportSurface.supportKind === 'unit';
      const supportPenetration = supportSurface.groundZ - (bodyZ - bodyGroundOffset);
      const locomotionGroundContact = isUnitGroundPenetrationInContact(
        supportPenetration,
        bodyRadius,
      );
      const buildFlags = hasEntityState ? entityViews!.buildFlags[entitySlot] : 0;
      const buildInProgress = hasEntityState
        ? (
            (buildFlags & ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE) !== 0 &&
            (buildFlags & (
              ENTITY_SLOT_BUILD_FLAG_COMPLETE |
              ENTITY_SLOT_BUILD_FLAG_INTERRUPTED
            )) === 0
          )
        : isBuildInProgress(entity.buildable);
      if (entity.heldBy !== null) {
        bodyViews.velX[bodySlot] = 0;
        bodyViews.velY[bodySlot] = 0;
        bodyViews.velZ[bodySlot] = 0;
      } else if (buildInProgress) {
        // Freeze the shell's horizontal motion while it is still being built:
        // legacy non-held construction shells cannot slide out of their
        // production area. Gravity still acts on Z.
        bodyViews.velX[bodySlot] = 0;
        bodyViews.velY[bodySlot] = 0;
      }
      _forceRows[base + UF_ROW_NORMAL_X] = supportSurface.normalX;
      _forceRows[base + UF_ROW_NORMAL_Y] = supportSurface.normalY;
      _forceRows[base + UF_ROW_NORMAL_Z] = supportSurface.normalZ;
      const cruiseWhenUncommanded = hasProfileFlags
        ? (profileFlags & UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED) !== 0
        : unit.locomotion.motionControl.cruiseWhenUncommanded;
      const propulsionBodyForward = hasProfileFlags
        ? (profileFlags & UF_FLAG_PROPULSION_BODY_FORWARD) !== 0
        : unit.locomotion.actuator.propulsionAxis !== 'worldPlanar';
      const airGroundInverseLiftAuthored =
        unit.locomotion.physics.air.lift.surfaceFollowingInverseForceFromGround > 0;
      const airWaterInverseLiftAuthored =
        unit.locomotion.physics.air.lift.surfaceFollowingInverseForceFromWater > 0;
      const waterGroundInverseLiftAuthored =
        unit.locomotion.physics.water.lift.surfaceFollowingInverseForceFromGround > 0;
      const waterSurfaceProportionalLiftAuthored =
        unit.locomotion.physics.water.lift.surfaceFollowingProportionalForceFromWater > 0;
      let flags = 0;

      const unitHp = hasEntityState ? entityViews!.hp[entitySlot] : unit.hp;
      if (unitHp <= 0) {
        _forceRows[base + UF_ROW_DIR_X] = 0;
        _forceRows[base + UF_ROW_DIR_Y] = 0;
        _forceRows[base + UF_ROW_GROUND_Z] = 0;
        _forceFlags[count] = UF_FLAG_BLOCKED_OR_DEAD;
        count++;
        continue;
      }

      // Actuator axis is a blueprint constant OR'd in by the kernel profile.
      const dirX = hasEntityState ? entityViews!.unitThrustDirX[entitySlot] : unit.thrustDirX ?? 0;
      const dirY = hasEntityState ? entityViews!.unitThrustDirY[entitySlot] : unit.thrustDirY ?? 0;
      if (!hasEntityState) {
        _forceRows[base + UF_ROW_DIR_X] = dirX;
        _forceRows[base + UF_ROW_DIR_Y] = dirY;
        _forceRows[base + UF_ROW_HEADING_X] = unit.headingDirX ?? 0;
        _forceRows[base + UF_ROW_HEADING_Y] = unit.headingDirY ?? 0;
      }
      const dirLenSq = dirX * dirX + dirY * dirY;
      const hasThrustDir = dirLenSq > 0.0001;
      if (hasThrustDir) flags |= UF_FLAG_HAS_THRUST;
      const thrustInputMag = hasThrustDir ? DMath.sqrt(dirLenSq) : 0;

      if (locomotionGroundContact) flags |= UF_FLAG_ON_GROUND;

      // A BEAM-CARRIED passenger (transported) must not fight the
      // transport's tractor spring with its own hover lift or cruise —
      // the same self-motion kill switch factory-held shells use. Drag,
      // gravity, and the accumulated beam force still apply.
      const mediumLiftActive = !buildInProgress && entity.transported === null;
      if (cruiseWhenUncommanded && mediumLiftActive) flags |= UF_FLAG_IS_AIRBORNE_CRUISING;
      if (mediumLiftActive) flags |= UF_FLAG_IS_AIRBORNE;

      const hasExternalForce =
        hasExternalForces &&
        forceAccumulator.copyFinalForceBySlot(
          entitySlot,
          _forceRows,
          base + UF_ROW_EXTERNAL_FX,
          entity.id,
        );
      if (hasExternalForce) {
        flags |= UF_FLAG_HAS_EXTERNAL_FORCE;
      }

      _forceRows[base + UF_ROW_GROUND_Z] = supportSurface.groundZ;
      _forceRows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE] = 0;
      _forceRows[base + UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE] = 0;
      _forceRows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE] = 0;
      if (
        mediumLiftActive &&
        (
          airGroundInverseLiftAuthored ||
          airWaterInverseLiftAuthored ||
          waterGroundInverseLiftAuthored ||
          waterSurfaceProportionalLiftAuthored
        )
      ) {
        const debugFrame = this.surfaceLiftProbeDebugEntityIds.has(entity.id)
          ? this.createSurfaceLiftProbeDebugFrame(entity.id)
          : undefined;
        // Surface support is gameplay physics, not a debug-only feature. The
        // overlay merely records the samples; every unit still needs its
        // occupied-medium support proposal during an ordinary simulation tick.
        const waterFraction = sim.unitForceWaterFraction(bodyZ, bodyRadius);
        const airLiftMediumActive = airSurfaceLiftMediumIsActive(
          bodyZ,
          waterFraction,
          WATER_LEVEL,
        ) &&
          (airGroundInverseLiftAuthored || airWaterInverseLiftAuthored);
        const waterLiftMediumActive = waterFraction > 0 &&
          (waterGroundInverseLiftAuthored || waterSurfaceProportionalLiftAuthored);
        let probeDirX = 0;
        let probeDirY = 0;
        const yaw = Number.isFinite(rotationForPack) ? rotationForPack : 0;
        if (hasThrustDir) {
          if (propulsionBodyForward) {
            probeDirX = DMath.cos(yaw);
            probeDirY = DMath.sin(yaw);
          } else {
            const invDirMag = 1 / thrustInputMag;
            probeDirX = dirX * invDirMag;
            probeDirY = dirY * invDirMag;
          }
        } else {
          probeDirX = DMath.cos(yaw);
          probeDirY = DMath.sin(yaw);
        }

        this.sampleSurfaceLiftAggregatedProposedForces(
          entitySlot,
          unit.locomotion.surfaceFollowing.altitudeProbeSetId,
          bodyZ,
          bodyX,
          bodyY,
          probeDirX,
          probeDirY,
          supportSurface.groundZ,
          entity.id,
          !terrainOnlySupport,
          unit.locomotion.physics.air.lift.surfaceFollowingInverseForceFromGround,
          unit.locomotion.physics.air.lift.surfaceFollowingInverseForceFromWater,
          unit.locomotion.physics.water.lift.surfaceFollowingInverseForceFromGround,
          unit.locomotion.physics.water.lift.surfaceFollowingProportionalForceFromWater,
          airLiftMediumActive,
          waterLiftMediumActive,
          _surfaceLiftProposedForces,
          debugFrame,
        );
        if (airGroundInverseLiftAuthored || airWaterInverseLiftAuthored) {
          _forceRows[base + UF_ROW_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE] =
            _surfaceLiftProposedForces.airInverse;
          flags |= UF_FLAG_HAS_AIR_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE;
        }
        if (waterGroundInverseLiftAuthored) {
          _forceRows[base + UF_ROW_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE] =
            _surfaceLiftProposedForces.waterInverse;
          flags |= UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_INVERSE_PROPOSED_FORCE;
        }
        if (waterSurfaceProportionalLiftAuthored) {
          _forceRows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE] =
            _surfaceLiftProposedForces.waterProportional;
          flags |= UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_PROPORTIONAL_PROPOSED_FORCE;
        }
      }

      const unitMotionFlags = hasEntityState ? entityViews!.unitMotionFlags[entitySlot] : 0;
      const hasOrientationState =
        hasEntityState && (unitMotionFlags & ENTITY_SLOT_UNIT_MOTION_HAS_ORIENTATION) !== 0;
      const hasAngularVelocityState =
        hasEntityState && (unitMotionFlags & ENTITY_SLOT_UNIT_MOTION_HAS_ANGULAR_VELOCITY) !== 0;
      if (hasOrientationState) {
        _forceRows[base + UF_ROW_ORIENTATION_X] = entityViews!.orientationX[entitySlot];
        _forceRows[base + UF_ROW_ORIENTATION_Y] = entityViews!.orientationY[entitySlot];
        _forceRows[base + UF_ROW_ORIENTATION_Z] = entityViews!.orientationZ[entitySlot];
        _forceRows[base + UF_ROW_ORIENTATION_W] = entityViews!.orientationW[entitySlot];
        if (unit.orientation === null) {
          unit.orientation = {
            x: _forceRows[base + UF_ROW_ORIENTATION_X],
            y: _forceRows[base + UF_ROW_ORIENTATION_Y],
            z: _forceRows[base + UF_ROW_ORIENTATION_Z],
            w: _forceRows[base + UF_ROW_ORIENTATION_W],
          };
        }
      } else {
        let orientation = unit.orientation;
        if (orientation === null) {
          const halfYaw = (Number.isFinite(rotationForPack) ? rotationForPack : 0) * 0.5;
          orientation = unit.orientation = {
            x: 0,
            y: 0,
            z: DMath.sin(halfYaw),
            w: DMath.cos(halfYaw),
          };
        }
        _forceRows[base + UF_ROW_ORIENTATION_X] = orientation.x;
        _forceRows[base + UF_ROW_ORIENTATION_Y] = orientation.y;
        _forceRows[base + UF_ROW_ORIENTATION_Z] = orientation.z;
        _forceRows[base + UF_ROW_ORIENTATION_W] = orientation.w;
      }
      if (hasAngularVelocityState) {
        _forceRows[base + UF_ROW_OMEGA_X] = entityViews!.angularVelocityX[entitySlot];
        _forceRows[base + UF_ROW_OMEGA_Y] = entityViews!.angularVelocityY[entitySlot];
        _forceRows[base + UF_ROW_OMEGA_Z] = entityViews!.angularVelocityZ[entitySlot];
        if (unit.angularVelocity3 === null) {
          unit.angularVelocity3 = {
            x: _forceRows[base + UF_ROW_OMEGA_X],
            y: _forceRows[base + UF_ROW_OMEGA_Y],
            z: _forceRows[base + UF_ROW_OMEGA_Z],
          };
        }
      } else {
        let omega = unit.angularVelocity3;
        if (omega === null) {
          omega = unit.angularVelocity3 = { x: 0, y: 0, z: 0 };
        }
        _forceRows[base + UF_ROW_OMEGA_X] = omega.x;
        _forceRows[base + UF_ROW_OMEGA_Y] = omega.y;
        _forceRows[base + UF_ROW_OMEGA_Z] = omega.z;
      }
      flags |= UF_FLAG_HAS_ORIENTATION;
      if (locomotionGroundContact) {
        if (supportSurfaceContact) {
          this.writeSupportSurfaceNormal(entity, supportSurface);
        }
      }

      _forceFlags[count] = flags;
      count++;
    }

    if (count === 0) return;

    const wind = this.simulation.getWindState();
    const windX = Number.isFinite(wind.x) ? wind.x : 0;
    const windY = Number.isFinite(wind.y) ? wind.y : 0;
    const windZ = Number.isFinite(wind.z) ? wind.z : 0;
    measureWasmBoundary('server.unitForceStepBatch', () => {
      sim.unitForceStepBatchStaged(
        count,
        dtSec,
        windX,
        windY,
        windZ,
        SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD,
      );
    });
    // The staged batch itself does not allocate, but keep the scatter
    // reads honest against any future allocation inside it.
    refreshForceStagingViews(sim);

    for (let i = 0; i < count; i++) {
      const outFlags = _forceOutFlags[i];
      if (outFlags === 0) {
        continue;
      }
      const entity = entitySlotRegistry.resolveSlot(_forceEntitySlots[i]);
      if (entity === undefined || entity.unit === null || entity.body === null) continue;
      const unit = entity.unit;
      const body = entity.body.physicsBody;
      const base = i * UNIT_FORCE_BATCH_STRIDE;
      const entityStateSynced = (outFlags & UF_OUT_ENTITY_STATE_SYNCED) !== 0;

      if ((outFlags & UF_OUT_WOKE_BODY) !== 0) {
        this.physics.recordWasmForceWake(body);
      }

      if ((outFlags & UF_OUT_CLEAR_COMBAT) !== 0) {
        if (entity.combat) {
          entity.combat.priorityTargetId = null;
          entity.combat.priorityTargetPoint = null;
          entity.combat.manualLaunchActive = false;
        }
        continue;
      }

      if ((outFlags & UF_OUT_HOVER_ORIENTATION) !== 0) {
        const orientation = unit.orientation;
        const omega = unit.angularVelocity3;
        if (orientation !== null && omega !== null) {
          const omegaChanged =
            Math.abs(omega.x - _forceRows[base + UF_ROW_OMEGA_X]) > 1e-9 ||
            Math.abs(omega.y - _forceRows[base + UF_ROW_OMEGA_Y]) > 1e-9 ||
            Math.abs(omega.z - _forceRows[base + UF_ROW_OMEGA_Z]) > 1e-9;
          orientation.x = _forceRows[base + UF_ROW_ORIENTATION_X];
          orientation.y = _forceRows[base + UF_ROW_ORIENTATION_Y];
          orientation.z = _forceRows[base + UF_ROW_ORIENTATION_Z];
          orientation.w = _forceRows[base + UF_ROW_ORIENTATION_W];
          omega.x = _forceRows[base + UF_ROW_OMEGA_X];
          omega.y = _forceRows[base + UF_ROW_OMEGA_Y];
          omega.z = _forceRows[base + UF_ROW_OMEGA_Z];
          if (omegaChanged) {
            if (entityStateSynced) {
              this.world.markSnapshotDirtyStateSynced(entity, ENTITY_CHANGED_VEL);
            } else {
              this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_VEL);
            }
          }
        }
      }

      if ((outFlags & UF_OUT_ROTATION_DIRTY) !== 0) {
        entity.transform.rotation = _forceRows[base + UF_ROW_ROTATION];
        if (entityStateSynced) {
          this.world.markSnapshotDirtyStateSynced(entity, ENTITY_CHANGED_ROT);
        } else {
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ROT);
        }
      }
    }
  }

  private writeSupportSurfaceNormal(entity: Entity, supportSurface: SupportSurfaceContact): void {
    const body = entity.body?.physicsBody;
    if (body === undefined) return;
    if (
      Math.abs(body.surfaceNormalX - supportSurface.normalX) <=
        SUPPORT_SURFACE_NORMAL_DIRTY_EPSILON &&
      Math.abs(body.surfaceNormalY - supportSurface.normalY) <=
        SUPPORT_SURFACE_NORMAL_DIRTY_EPSILON &&
      Math.abs(body.surfaceNormalZ - supportSurface.normalZ) <=
        SUPPORT_SURFACE_NORMAL_DIRTY_EPSILON
    ) {
      return;
    }
    body.surfaceNormalX = supportSurface.normalX;
    body.surfaceNormalY = supportSurface.normalY;
    body.surfaceNormalZ = supportSurface.normalZ;
    this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_NORMAL);
  }

  private collectPhysicsForceUnitSlots(): Uint32Array {
    this.physicsForceUnitSlotCount = 0;
    this.beginPhysicsActiveUnitSlotMarkFrame();

    const movingUnitSlots = this.simulation.getMovingUnitSlots();
    for (let i = 0; i < movingUnitSlots.length; i++) {
      this.pushPhysicsForceUnitSlot(movingUnitSlots[i]);
    }

    const cruisingUnitSlots = this.world.getCruisingUnitSlots();
    for (let i = 0; i < cruisingUnitSlots.length; i++) {
      this.pushPhysicsForceUnitSlot(cruisingUnitSlots[i]);
    }

    const forceAccumulator = this.simulation.getForceAccumulator();
    const activeForceCount = forceAccumulator.activeEntityCount();
    this.ensurePhysicsCandidateSlotCapacity(
      activeForceCount,
    );
    let candidateCount = 0;
    if (activeForceCount > 0) {
      candidateCount = forceAccumulator.collectActiveEntitySlots(
        this.physicsCandidateUnitSlotsBuf,
      );
      for (let i = 0; i < candidateCount; i++) {
        this.pushPhysicsForceUnitSlot(this.physicsCandidateUnitSlotsBuf[i]);
      }
    }

    const sim = getSimWasm();
    candidateCount = sim !== undefined
      ? sim.entityState.collectAwakeUnitBodyEntitySlots(this.physicsCandidateUnitSlotsBuf)
      : this.physics.collectAwakeEntitySlots(
        this.physicsCandidateUnitSlotsBuf,
        entitySlotForId,
      );
    if (candidateCount < 0) {
      this.ensurePhysicsCandidateSlotCapacity(-candidateCount);
      candidateCount = sim !== undefined
        ? sim.entityState.collectAwakeUnitBodyEntitySlots(this.physicsCandidateUnitSlotsBuf)
        : this.physics.collectAwakeEntitySlots(
          this.physicsCandidateUnitSlotsBuf,
          entitySlotForId,
        );
    }
    for (let i = 0; i < candidateCount; i++) {
      this.pushPhysicsForceUnitSlot(this.physicsCandidateUnitSlotsBuf[i]);
    }

    const slots = this.physicsForceUnitSlotsBuf.subarray(0, this.physicsForceUnitSlotCount);
    if (sim !== undefined) {
      sim.entityState.sortSlotsByEntityId(slots);
    } else {
      const views = entitySlotRegistry.getViews();
      if (views !== null) {
        slots.sort((a, b) => views.entityId[a] - views.entityId[b]);
      } else {
        slots.sort();
      }
    }
    return slots;
  }

  private ensurePhysicsCandidateSlotCapacity(count: number): void {
    if (this.physicsCandidateUnitSlotsBuf.length >= count) return;
    let cap = this.physicsCandidateUnitSlotsBuf.length;
    while (cap < count) cap *= 2;
    this.physicsCandidateUnitSlotsBuf = new Uint32Array(cap);
  }

  private beginPhysicsActiveUnitSlotMarkFrame(): void {
    if (this.physicsActiveUnitSlotMark >= 0xffffffff) {
      this.physicsActiveUnitSlotMarks.fill(0);
      this.physicsActiveUnitSlotMark = 1;
      return;
    }
    this.physicsActiveUnitSlotMark++;
  }

  private pushPhysicsForceUnitSlot(slot: number): void {
    if (slot < 0 || !Number.isInteger(slot)) return;
    if (slot >= this.physicsActiveUnitSlotMarks.length) {
      let cap = this.physicsActiveUnitSlotMarks.length;
      while (cap <= slot) cap *= 2;
      const next = new Uint32Array(cap);
      next.set(this.physicsActiveUnitSlotMarks);
      this.physicsActiveUnitSlotMarks = next;
    }
    if (this.physicsActiveUnitSlotMarks[slot] === this.physicsActiveUnitSlotMark) return;
    this.physicsActiveUnitSlotMarks[slot] = this.physicsActiveUnitSlotMark;
    if (this.physicsForceUnitSlotCount >= this.physicsForceUnitSlotsBuf.length) {
      const next = new Uint32Array(this.physicsForceUnitSlotsBuf.length * 2);
      next.set(this.physicsForceUnitSlotsBuf);
      this.physicsForceUnitSlotsBuf = next;
    }
    this.physicsForceUnitSlotsBuf[this.physicsForceUnitSlotCount++] = slot;
  }

  private sampleBodySupportSurface(
    body: NonNullable<Entity['body']>['physicsBody'],
    bodyX: number,
    bodyY: number,
    out: SupportSurfaceContact,
    terrainSampled: boolean,
    terrainOnlySupport: boolean,
    terrainSampleIndex: number,
  ): SupportSurfaceContact {
    const x = bodyX;
    const y = bodyY;
    if (terrainSampled) {
      const normalBase = terrainSampleIndex * 3;
      const terrainSurface = _forceTerrainSurface;
      const inWater = _forceTerrainMaterialFlags[terrainSampleIndex] !== 0;
      terrainSurface.groundZ = _forceTerrainGroundZ[terrainSampleIndex];
      terrainSurface.normalX = _forceTerrainGroundNormals[normalBase];
      terrainSurface.normalY = _forceTerrainGroundNormals[normalBase + 1];
      terrainSurface.normalZ = _forceTerrainGroundNormals[normalBase + 2];
      terrainSurface.supportEntityId = null;
      // A terrain bed remains terrain when a fluid covers it. The material
      // row carries water occupancy/navigation; the support row carries the
      // actual geometry used for traction and attitude.
      terrainSurface.supportKind = 'terrain';
      terrainSurface.materialKind = inWater ? 'water' : 'solid';
      terrainSurface.supportVelocityX = 0;
      terrainSurface.supportVelocityY = 0;
      terrainSurface.supportVelocityZ = 0;
      terrainSurface.walkable = !inWater;
      terrainSurface.sourceKey = getTerrainVersion();
      if (terrainOnlySupport) return terrainSurface;
      return this.physics.sampleSupportSurface(body, terrainSurface, out);
    }
    const terrainBedNormal = this.world.getCachedTerrainBedNormal(x, y);
    const terrainSurface = this.world.writeTerrainSupportSurfaceAt(
      x,
      y,
      this.world.getTerrainBedZ(x, y),
      terrainBedNormal,
      _forceTerrainSurface,
    );
    return this.physics.sampleSupportSurface(body, terrainSurface, out);
  }

  private ensureProbeSupportIndex(): void {
    if (this.probeSupportIndexReady) return;
    this.world.refreshSupportSurfaceIndex();
    this.probeSupportIndexReady = true;
  }

  private surfaceFollowingInverseResponseFromSurfaceZ(
    bodyZ: number,
    surfaceZ: number,
  ): number {
    return getSurfaceLiftInverseDistanceResponse(
      getSurfaceLiftInverseDistanceToSurfaceWorld(bodyZ, surfaceZ),
    );
  }

  private surfaceFollowingProportionalResponseFromWater(bodyZ: number): number {
    return getSurfaceLiftWaterDepthWorld(bodyZ);
  }

  private createSurfaceLiftProbeDebugFrame(entityId: EntityId): SurfaceLiftProbeDebugFrame {
    const frame: SurfaceLiftProbeDebugFrame = {
      tick: this.world.getTick(),
      entityId,
      samples: [],
    };
    this.surfaceLiftProbeDebugFrames.set(entityId, frame);
    return frame;
  }

  /**
   * Resolve the three surface-following force proposals for one unit.
   *
   * Two halves with different cadences. SAMPLING the outrigger lattice —
   * a terrain-bed lookup plus a support-surface query per point — is the
   * expensive half, so it runs only on this unit's deterministic refresh
   * tick and is cached (see SurfaceLiftProbeSampleCache). AGGREGATING runs
   * every tick against the unit's live altitude, so the response still
   * tracks the body the instant it rises or falls. The centre point is
   * never cached: it sits at the body, its support height is the contact
   * surface this tick already resolved, and its medium is a single bed
   * lookup.
   */
  private sampleSurfaceLiftAggregatedProposedForces(
    entitySlot: number,
    probeSetId: SurfaceProbeSetId,
    bodyZ: number,
    bodyX: number,
    bodyY: number,
    probeDirX: number,
    probeDirY: number,
    directGroundZ: number,
    ignoreEntityId: EntityId,
    includeSupportSurfaces: boolean,
    airSurfaceFollowingInverseForceFromGround: number,
    airSurfaceFollowingInverseForceFromWater: number,
    waterSurfaceFollowingInverseForceFromGround: number,
    waterSurfaceFollowingProportionalForceFromWater: number,
    airLiftMediumActive: boolean,
    waterLiftMediumActive: boolean,
    out: {
      airInverse: number;
      waterInverse: number;
      waterProportional: number;
    },
    debugFrame: SurfaceLiftProbeDebugFrame | undefined = undefined,
  ): void {
    const samples = this.surfaceProbeSamples;
    if (samples.needsRefresh(entitySlot, ignoreEntityId, this.world.getTick())) {
      samples.beginRefresh(entitySlot, ignoreEntityId);
      forEachSurfaceProbePoint(
        probeSetId,
        bodyX,
        bodyY,
        probeDirX,
        probeDirY,
        (x, y, isCenter) => {
          if (isCenter) return;
          samples.push(
            entitySlot,
            x,
            y,
            this.sampleSurfaceLiftSupportZAt(x, y, ignoreEntityId, includeSupportSurfaces),
            surfaceProbeUsesWaterSurface(this.world.getTerrainBedZ(x, y), WATER_LEVEL),
          );
        },
      );
      samples.endRefresh(entitySlot);
    }

    const waterSurfaceDepth = waterSurfaceFollowingProportionalForceFromWater > 0
      ? this.surfaceFollowingProportionalResponseFromWater(bodyZ)
      : 0;
    let airInverseProposedForceAggregate = 0;
    let waterInverseProposedForceAggregate = 0;
    let waterProportionalProposedForceAggregate = 0;

    const accumulateProbe = (
      x: number,
      y: number,
      groundZ: number,
      waterCovered: boolean,
      isCenter: boolean,
    ): void => {
      if (debugFrame !== undefined) {
        const usesGroundInverseDistance =
          (airLiftMediumActive && !waterCovered && airSurfaceFollowingInverseForceFromGround > 0) ||
          (waterLiftMediumActive && waterCovered &&
            waterSurfaceFollowingInverseForceFromGround > 0);
        const usesWaterSurfaceInverseDistance =
          airLiftMediumActive && waterCovered && airSurfaceFollowingInverseForceFromWater > 0;
        const usesWaterSurfaceDepth =
          waterLiftMediumActive && waterCovered &&
          waterSurfaceFollowingProportionalForceFromWater > 0;
        debugFrame.samples.push({
          x,
          y,
          bodyZ,
          isCenter,
          groundInverseDistanceWorld: getSurfaceLiftInverseDistanceToSurfaceWorld(bodyZ, groundZ),
          usesGroundInverseDistance,
          waterSurfaceInverseDistanceWorld: waterCovered
            ? getSurfaceLiftInverseDistanceToSurfaceWorld(bodyZ, WATER_LEVEL)
            : null,
          usesWaterSurfaceInverseDistance,
          waterSurfaceDepthWorld: waterCovered
            ? waterSurfaceDepth
            : null,
          usesWaterSurfaceDepth,
        });
      }
      if (!waterCovered && airSurfaceFollowingInverseForceFromGround > 0) {
        const forceMultiplier = this.surfaceFollowingInverseResponseFromSurfaceZ(
          bodyZ,
          groundZ,
        );
        const proposedForce = airSurfaceFollowingInverseForceFromGround * forceMultiplier;
        airInverseProposedForceAggregate = accumulateSurfaceProbeProposedForce(
          airInverseProposedForceAggregate,
          proposedForce,
          SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
        );
      }
      if (waterCovered && airSurfaceFollowingInverseForceFromWater > 0) {
        const forceMultiplier = this.surfaceFollowingInverseResponseFromSurfaceZ(
          bodyZ,
          WATER_LEVEL,
        );
        const proposedForce = airSurfaceFollowingInverseForceFromWater * forceMultiplier;
        airInverseProposedForceAggregate = accumulateSurfaceProbeProposedForce(
          airInverseProposedForceAggregate,
          proposedForce,
          SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
        );
      }
      if (waterCovered && waterSurfaceFollowingInverseForceFromGround > 0) {
        const forceMultiplier = this.surfaceFollowingInverseResponseFromSurfaceZ(
          bodyZ,
          groundZ,
        );
        const proposedForce = waterSurfaceFollowingInverseForceFromGround * forceMultiplier;
        waterInverseProposedForceAggregate = accumulateSurfaceProbeProposedForce(
          waterInverseProposedForceAggregate,
          proposedForce,
          SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
        );
      }
      if (waterCovered && waterSurfaceFollowingProportionalForceFromWater > 0) {
        const proposedForce = waterSurfaceFollowingProportionalForceFromWater * waterSurfaceDepth;
        waterProportionalProposedForceAggregate = accumulateSurfaceProbeProposedForce(
          waterProportionalProposedForceAggregate,
          proposedForce,
          SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
        );
      }
    };

    // The centre carries the body's own live ground and medium; the
    // outriggers carry this unit's most recent lattice refresh.
    const centerWaterCovered = surfaceProbeUsesWaterSurface(
      this.world.getTerrainBedZ(bodyX, bodyY),
      WATER_LEVEL,
    );
    accumulateProbe(bodyX, bodyY, directGroundZ, centerWaterCovered, true);
    const outriggerCount = samples.count(entitySlot);
    for (let i = 0; i < outriggerCount; i++) {
      accumulateProbe(
        samples.x(entitySlot, i),
        samples.y(entitySlot, i),
        samples.groundZ(entitySlot, i),
        samples.waterCovered(entitySlot, i),
        false,
      );
    }

    const sampleCount = 1 + outriggerCount;
    out.airInverse = finalizeSurfaceProbeProposedForce(
      airInverseProposedForceAggregate,
      sampleCount,
      SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
    );
    out.waterInverse = finalizeSurfaceProbeProposedForce(
      waterInverseProposedForceAggregate,
      sampleCount,
      SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
    );
    out.waterProportional = finalizeSurfaceProbeProposedForce(
      waterProportionalProposedForceAggregate,
      sampleCount,
      SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
    );
  }


  private sampleSurfaceLiftSupportZAt(
    x: number,
    y: number,
    ignoreEntityId: EntityId,
    includeSupportSurfaces: boolean,
  ): number {
    const terrainBedZ = this.world.getTerrainBedZ(x, y);
    if (!includeSupportSurfaces) return terrainBedZ;
    this.ensureProbeSupportIndex();
    const support = this.world.sampleSupportSurfaceFromIndex(
      x,
      y,
      { ignoreEntityId },
      _forceProbeSupportSurface,
    );
    return resolveSurfaceLiftGroundZ(support, terrainBedZ);
  }
}
