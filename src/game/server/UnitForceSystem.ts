// UnitForceSystem - authoritative force orchestration for unit physics bodies.
// TypeScript gathers entity/terrain inputs, the Rust/WASM batch owns the
// per-unit force decisions and writes BodyPool acceleration directly.

import {
  getSurfaceLiftDistanceResponse,
  getSurfaceLiftDistanceToSurfaceWorld,
} from '../sim/surfaceLiftDistanceResponse';
import { resolveSurfaceLiftGroundZ } from '../sim/surfaceLiftGroundSupport';
import {
  accumulateSurfaceProbeProposedForce,
  finalizeSurfaceProbeProposedForce,
  surfaceProbeUsesWaterSurface,
} from '../sim/surfaceProbeAggregation';
import {
  SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD,
  SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
} from '../sim/unitLocomotionPresetConfig';
import {
  UNIT_GROUND_CONTACT_EPSILON,
} from '../sim/unitGroundPhysics';
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
  ENTITY_SLOT_BUILD_FLAG_GHOST,
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
import { forEachSurfaceProbePoint } from '../sim/surfaceProbeSets';

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
const UF_ROW_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE = 55;
const UF_ROW_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE = 56;

const UF_FLAG_HAS_THRUST = 1 << 0;
const UF_FLAG_IS_FLYING = 1 << 1;
const UF_FLAG_IS_AIRBORNE = 1 << 2;
const UF_FLAG_BLOCKED_OR_DEAD = 1 << 3;
const UF_FLAG_HAS_EXTERNAL_FORCE = 1 << 4;
const UF_FLAG_HAS_ORIENTATION = 1 << 7;
const UF_FLAG_PROPULSION_BODY_FORWARD = 1 << 8;
const UF_FLAG_ON_GROUND = 1 << 10;
const UF_FLAG_HAS_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE = 1 << 14;
const UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE = 1 << 15;
const UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED = 1 << 16;
const UF_PROFILE_FLAG_WATER_FATAL = 1 << 20;

const UF_OUT_CLEAR_COMBAT = 1 << 1;
const UF_OUT_ROTATION_DIRTY = 1 << 2;
const UF_OUT_HOVER_ORIENTATION = 1 << 3;
const UF_OUT_WOKE_BODY = 1 << 4;
const UF_OUT_ENTITY_STATE_SYNCED = 1 << 5;

const entitySlotForId = (entityId: EntityId): number => entitySlotRegistry.getSlot(entityId);

let _forceSlots: Uint32Array = new Uint32Array(0);
let _forceEntitySlots: Uint32Array = new Uint32Array(0);
let _forceFlags: Uint32Array = new Uint32Array(0);
let _forceRows: Float64Array = new Float64Array(0);
let _forceOutFlags: Uint32Array = new Uint32Array(0);
let _forceTerrainGroundZ: Float64Array = new Float64Array(0);
const _surfaceLiftProposedForces = {
  air: 0,
  water: 0,
};
let _forceTerrainGroundNormals: Float64Array = new Float64Array(0);
let _forceTerrainMaterialFlags: Uint32Array = new Uint32Array(0);
const _forceTerrainSurface = createWorldSupportSurface();
const _forceSupportSurface = createWorldSupportSurface();
const _forceProbeSupportSurface = createWorldSupportSurface();

function ensureForceBatchCapacity(count: number): void {
  if (_forceSlots.length < count) {
    const next = Math.max(count, _forceSlots.length * 2, 256);
    _forceSlots = new Uint32Array(next);
    _forceEntitySlots = new Uint32Array(next);
    _forceFlags = new Uint32Array(next);
    _forceOutFlags = new Uint32Array(next);
  }
  const rowLen = count * UNIT_FORCE_BATCH_STRIDE;
  if (_forceRows.length < rowLen) {
    const nextRows = Math.max(rowLen, _forceRows.length * 2, 256 * UNIT_FORCE_BATCH_STRIDE);
    _forceRows = new Float64Array(nextRows);
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
const UF_PROFILE_STRIDE = 16;

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
        ground.maxPropulsiveForce,
        ground.staticFrictionCoefficient,
        ground.tangentialDampingRate,
        air.maxPropulsiveForce,
        air.lift.buoyancyRatio,
        air.lift.surfaceFollowingForceFromGround,
        air.lift.surfaceFollowingForceFromWater,
        air.resistance.linearDampingRate,
        air.resistance.angularDampingRate,
        water.maxPropulsiveForce,
        water.lift.buoyancyRatio,
        water.lift.surfaceFollowingForceFromGround,
        water.resistance.linearDampingRate,
        water.resistance.angularDampingRate,
        loco.environmentalHazards.fatalSubmergedFraction,
        loco.environmentalHazards.fatalExposureSeconds,
        loco.actuator.propulsionAxis,
        loco.motionControl.cruiseWhenUncommanded ? 1 : 0,
        loco.environmentalHazards.waterFatal ? 1 : 0,
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
    values[base + 0] = ground.maxPropulsiveForce;
    values[base + 1] = ground.staticFrictionCoefficient;
    values[base + 2] = ground.tangentialDampingRate;
    values[base + 3] = air.maxPropulsiveForce;
    values[base + 4] = air.lift.buoyancyRatio;
    values[base + 5] = air.lift.surfaceFollowingForceFromGround;
    values[base + 6] = air.lift.surfaceFollowingForceFromWater;
    values[base + 7] = air.resistance.linearDampingRate;
    values[base + 8] = air.resistance.angularDampingRate;
    values[base + 9] = water.maxPropulsiveForce;
    values[base + 10] = water.lift.buoyancyRatio;
    values[base + 11] = water.lift.surfaceFollowingForceFromGround;
    values[base + 12] = water.resistance.linearDampingRate;
    values[base + 13] = water.resistance.angularDampingRate;
    values[base + 14] = loco.environmentalHazards.fatalSubmergedFraction;
    values[base + 15] = loco.environmentalHazards.fatalExposureSeconds;
    flags[code] =
      (loco.actuator.propulsionAxis === 'bodyForward' ? UF_FLAG_PROPULSION_BODY_FORWARD : 0) |
      (loco.motionControl.cruiseWhenUncommanded ? UF_PROFILE_FLAG_CRUISE_WHEN_UNCOMMANDED : 0) |
      (loco.environmentalHazards.waterFatal ? UF_PROFILE_FLAG_WATER_FATAL : 0);
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
    const fatalWaterCount = sim.unitFatalWaterStepPool(dtSec);
    if (fatalWaterCount > 0) {
      const fatalEntitySlots = new Uint32Array(
        sim.memory.buffer,
        sim.unitFatalWaterEntitySlotsPtr(),
        fatalWaterCount,
      );
      for (let i = 0; i < fatalWaterCount; i++) {
        const entity = entitySlotRegistry.resolveSlot(fatalEntitySlots[i]);
        if (entity === undefined || entity.unit === null) continue;
        entity.unit.hp = 0;
        this.world.markSnapshotDirtyStateSynced(entity, ENTITY_CHANGED_HP);
      }
    }
    // Defensive: refresh BodyPool views in case WASM memory grew since
    // the last tick. See PhysicsEngine3D.step() for the detached-view
    // crash this guards against.
    sim.pool.refreshViews();
    const bodyViews = sim.pool;
    const profileFlagsView = getUnitForceProfileFlagsView(sim);
    const entityViews = entitySlotRegistry.getViews();

    const forceAccumulator = this.simulation.getForceAccumulator();
    const hasExternalForces = forceAccumulator.activeEntityCount() > 0;

    const activeSlots = this.collectPhysicsForceUnitSlots();
    if (activeSlots.length === 0) return;
    this.probeSupportIndexReady = false;

    ensureForceBatchCapacity(activeSlots.length);

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
      const surfaceContact = supportPenetration >= -UNIT_GROUND_CONTACT_EPSILON;
      const buildFlags = hasEntityState ? entityViews!.buildFlags[entitySlot] : 0;
      const buildInProgress = hasEntityState
        ? (
            (buildFlags & ENTITY_SLOT_BUILD_FLAG_HAS_BUILDABLE) !== 0 &&
            (buildFlags & (
              ENTITY_SLOT_BUILD_FLAG_COMPLETE |
              ENTITY_SLOT_BUILD_FLAG_GHOST |
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
        : unit.locomotion.actuator.propulsionAxis === 'bodyForward';
      const airGroundLiftAuthored =
        unit.locomotion.physics.air.lift.surfaceFollowingForceFromGround > 0;
      const airWaterSurfaceLiftAuthored =
        unit.locomotion.physics.air.lift.surfaceFollowingForceFromWater > 0;
      const waterGroundLiftAuthored =
        unit.locomotion.physics.water.lift.surfaceFollowingForceFromGround > 0;
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

      if (surfaceContact) flags |= UF_FLAG_ON_GROUND;

      const mediumLiftActive = !buildInProgress;
      if (cruiseWhenUncommanded && mediumLiftActive) flags |= UF_FLAG_IS_FLYING;
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
      _forceRows[base + UF_ROW_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE] = 0;
      _forceRows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE] = 0;
      if (
        mediumLiftActive &&
        (airGroundLiftAuthored || waterGroundLiftAuthored || airWaterSurfaceLiftAuthored)
      ) {
        const debugFrame = this.surfaceLiftProbeDebugEntityIds.has(entity.id)
          ? this.createSurfaceLiftProbeDebugFrame(entity.id)
          : undefined;
        const waterFraction = debugFrame !== undefined
          ? sim.unitForceWaterFraction(bodyZ, bodyRadius)
          : 0;
        const airLiftMediumActive = debugFrame !== undefined && waterFraction < 1 &&
          (airGroundLiftAuthored || airWaterSurfaceLiftAuthored);
        const waterLiftMediumActive = debugFrame !== undefined &&
          waterFraction > 0 && waterGroundLiftAuthored;
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
          unit.locomotion.surfaceFollowing.altitudeProbeSetId,
          bodyZ,
          bodyX,
          bodyY,
          bodyRadius,
          probeDirX,
          probeDirY,
          supportSurface.groundZ,
          entity.id,
          !terrainOnlySupport,
          unit.locomotion.physics.air.lift.surfaceFollowingForceFromGround,
          unit.locomotion.physics.air.lift.surfaceFollowingForceFromWater,
          unit.locomotion.physics.water.lift.surfaceFollowingForceFromGround,
          airLiftMediumActive,
          waterLiftMediumActive,
          _surfaceLiftProposedForces,
          debugFrame,
        );
        if (airGroundLiftAuthored || airWaterSurfaceLiftAuthored) {
          _forceRows[base + UF_ROW_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE] =
            _surfaceLiftProposedForces.air;
          flags |= UF_FLAG_HAS_AIR_SURFACE_FOLLOWING_PROPOSED_FORCE;
        }
        if (waterGroundLiftAuthored) {
          _forceRows[base + UF_ROW_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE] =
            _surfaceLiftProposedForces.water;
          flags |= UF_FLAG_HAS_WATER_SURFACE_FOLLOWING_PROPOSED_FORCE;
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
      if (surfaceContact) {
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
      sim.unitForceStepBatch(
        _forceSlots.subarray(0, count),
        _forceFlags.subarray(0, count),
        _forceRows.subarray(0, count * UNIT_FORCE_BATCH_STRIDE),
        _forceOutFlags.subarray(0, count),
        count,
        dtSec,
        windX,
        windY,
        windZ,
        SURFACE_FOLLOWING_MINIMUM_DISTANCE_WORLD,
      );
    });

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

    const flyingUnitSlots = this.world.getFlyingUnitSlots();
    for (let i = 0; i < flyingUnitSlots.length; i++) {
      this.pushPhysicsForceUnitSlot(flyingUnitSlots[i]);
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
      terrainSurface.supportKind = inWater ? 'water' : 'terrain';
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
    if (terrainSurface.materialKind === 'water') {
      terrainSurface.normalX = terrainBedNormal.nx;
      terrainSurface.normalY = terrainBedNormal.ny;
      terrainSurface.normalZ = terrainBedNormal.nz;
    }
    return this.physics.sampleSupportSurface(body, terrainSurface, out);
  }

  private ensureProbeSupportIndex(): void {
    if (this.probeSupportIndexReady) return;
    this.world.refreshSupportSurfaceIndex();
    this.probeSupportIndexReady = true;
  }

  private surfaceFollowingResponseFromSurfaceZ(
    bodyZ: number,
    surfaceZ: number,
  ): number {
    return getSurfaceLiftDistanceResponse(
      getSurfaceLiftDistanceToSurfaceWorld(bodyZ, surfaceZ),
    );
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

  private sampleSurfaceLiftAggregatedProposedForces(
    probeSetId: SurfaceProbeSetId,
    bodyZ: number,
    bodyX: number,
    bodyY: number,
    bodyRadius: number,
    probeDirX: number,
    probeDirY: number,
    directGroundZ: number,
    ignoreEntityId: EntityId,
    includeSupportSurfaces: boolean,
    airSurfaceFollowingForceFromGround: number,
    airSurfaceFollowingForceFromWater: number,
    waterSurfaceFollowingForceFromGround: number,
    airLiftMediumActive: boolean,
    waterLiftMediumActive: boolean,
    out: { air: number; water: number },
    debugFrame: SurfaceLiftProbeDebugFrame | undefined = undefined,
  ): void {
    let airProposedForceAggregate = 0;
    let waterProposedForceAggregate = 0;
    const sampleCount = forEachSurfaceProbePoint(
      probeSetId,
      bodyX,
      bodyY,
      probeDirX,
      probeDirY,
      bodyRadius,
      (x, y, role) => {
        const groundZ = role === 'center'
          ? directGroundZ
          : this.sampleSurfaceLiftSupportZAt(x, y, ignoreEntityId, includeSupportSurfaces);
        const waterCovered = surfaceProbeUsesWaterSurface(
          this.world.getTerrainBedZ(x, y),
          WATER_LEVEL,
        );
        if (debugFrame !== undefined) {
          const usesGroundDistance =
            (airLiftMediumActive && !waterCovered && airSurfaceFollowingForceFromGround > 0) ||
            (waterLiftMediumActive && waterSurfaceFollowingForceFromGround > 0);
          const usesWaterDistance =
            airLiftMediumActive && waterCovered && airSurfaceFollowingForceFromWater > 0;
          debugFrame.samples.push({
            x,
            y,
            bodyZ,
            role,
            groundDistanceWorld: getSurfaceLiftDistanceToSurfaceWorld(bodyZ, groundZ),
            usesGroundDistance,
            waterDistanceWorld: waterCovered
              ? getSurfaceLiftDistanceToSurfaceWorld(bodyZ, WATER_LEVEL)
              : null,
            usesWaterDistance,
          });
        }
        if (!waterCovered && airSurfaceFollowingForceFromGround > 0) {
          const forceMultiplier = this.surfaceFollowingResponseFromSurfaceZ(
            bodyZ,
            groundZ,
          );
          const proposedForce = airSurfaceFollowingForceFromGround * forceMultiplier;
          airProposedForceAggregate = accumulateSurfaceProbeProposedForce(
            airProposedForceAggregate,
            proposedForce,
            SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
          );
        }
        if (waterCovered && airSurfaceFollowingForceFromWater > 0) {
          const forceMultiplier = this.surfaceFollowingResponseFromSurfaceZ(
            bodyZ,
            WATER_LEVEL,
          );
          const proposedForce = airSurfaceFollowingForceFromWater * forceMultiplier;
          airProposedForceAggregate = accumulateSurfaceProbeProposedForce(
            airProposedForceAggregate,
            proposedForce,
            SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
          );
        }
        if (waterSurfaceFollowingForceFromGround > 0) {
          const forceMultiplier = this.surfaceFollowingResponseFromSurfaceZ(
            bodyZ,
            groundZ,
          );
          const proposedForce = waterSurfaceFollowingForceFromGround * forceMultiplier;
          waterProposedForceAggregate = accumulateSurfaceProbeProposedForce(
            waterProposedForceAggregate,
            proposedForce,
            SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
          );
        }
      },
    );

    if (sampleCount === 0) {
      const waterCovered = surfaceProbeUsesWaterSurface(
        this.world.getTerrainBedZ(bodyX, bodyY),
        WATER_LEVEL,
      );
      const airSurfaceZ = waterCovered ? WATER_LEVEL : directGroundZ;
      const airLiftForce = waterCovered
        ? airSurfaceFollowingForceFromWater
        : airSurfaceFollowingForceFromGround;
      out.air = airLiftForce > 0
        ? airLiftForce * this.surfaceFollowingResponseFromSurfaceZ(
          bodyZ,
          airSurfaceZ,
        )
        : 0;
      out.water = waterSurfaceFollowingForceFromGround > 0
        ? waterSurfaceFollowingForceFromGround * this.surfaceFollowingResponseFromSurfaceZ(
          bodyZ,
          directGroundZ,
        )
        : 0;
      return;
    }
    out.air = finalizeSurfaceProbeProposedForce(
      airProposedForceAggregate,
      sampleCount,
      SURFACE_FOLLOWING_PROBE_AGGREGATION_MODE,
    );
    out.water = finalizeSurfaceProbeProposedForce(
      waterProposedForceAggregate,
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
