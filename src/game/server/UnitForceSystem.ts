// UnitForceSystem - authoritative force orchestration for unit physics bodies.
// TypeScript gathers entity/terrain inputs, the Rust/WASM batch owns the
// per-unit force decisions and writes BodyPool acceleration directly.

import {
  LOCOMOTION_FORCE_SCALE,
} from '../sim/locomotion';
import {
  UNIT_GROUND_CONTACT_EPSILON,
} from '../sim/unitGroundPhysics';
import { WATER_LEVEL } from '../sim/Terrain';
import {
  ENTITY_CHANGED_ROT,
  ENTITY_CHANGED_VEL,
  ENTITY_CHANGED_NORMAL,
} from '../../types/network';
import type { Simulation } from '../sim/Simulation';
import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId } from '../sim/types';
import type { PhysicsEngine3D, SupportSurfaceContact } from './PhysicsEngine3D';
import {
  UNIT_DRIVE_FORCE_ALIGNMENT_FULL_FORCE_DOT,
  UNIT_DRIVE_FORCE_ALIGNMENT_RESPONSE_EXPONENT,
  UNIT_DRIVE_FORCE_ALIGNMENT_ZERO_FORCE_DOT,
  UNIT_GROUND_FRICTION_PER_60HZ_FRAME,
  UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
} from '../../config';
import { createWorldSupportSurface } from '../sim/supportSurface';
import { setUnitMovementAcceleration } from '../sim/unitMovementAcceleration';
import { isBuildInProgress } from '../sim/buildableHelpers';
import { entitySlotRegistry } from '../sim/EntitySlotRegistry';
import { getSimWasm, UNIT_FORCE_BATCH_STRIDE, type SimWasm } from '../sim-wasm/init';
import { codeToUnitBlueprintId } from '../../types/network';
import { getUnitBlueprint, getUnitLocomotion } from '../sim/blueprints';
import { deterministicMath as DMath } from '@/game/sim/deterministicMath';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';
import { dragRateFromVelocityFrictionPer60HzFrame } from '../sim/motionFriction';

const WATER_PROBE_DX = [
  1, 0.7071067811865476, 0, -0.7071067811865475,
  -1, -0.7071067811865477, 0, 0.7071067811865474,
];
const WATER_PROBE_DY = [
  0, 0.7071067811865475, 1, 0.7071067811865476,
  0, -0.7071067811865475, -1, -0.7071067811865477,
];
const WATER_ESCAPE_PROBE_MULTS = [1.5, 3, 6];

// Legacy WASM ABI knobs. Unit attitude now derives stiffness/damping from
// torque authority, inertia, and active medium damping in the force kernel.
const HOVER_ORIENTATION_K = 30;
const HOVER_ORIENTATION_C = 2 * Math.sqrt(HOVER_ORIENTATION_K);
const SUPPORT_SURFACE_NORMAL_DIRTY_EPSILON = 1e-6;

const WATER_OUT_CACHE_CELL_SIZE = 25;
const WATER_OUT_CACHE_BUCKET_SCALE = 10;
const WATER_OUT_CACHE_MAX_ENTRIES = 4096;

const UF_ROW_DIR_X = 0;
const UF_ROW_DIR_Y = 1;
const UF_ROW_ROTATION = 2;
// Row 3 reserved; Rust reads effective mass from BodyPool.
// Rows 4-9 (drive force, traction, gravity-counter ratio, hover force /
// randomization / EMA weight) are blueprint constants filled by the kernel
// from the wasm-side profile table — see ensureUnitForceProfileTable.
const UF_ROW_HOVER_SMOOTHED_FORCE = 10;
const UF_ROW_HOVER_RANDOM_SAMPLE = 11;
const UF_ROW_GROUND_Z = 12;
const UF_ROW_NORMAL_X = 13;
const UF_ROW_NORMAL_Y = 14;
const UF_ROW_NORMAL_Z = 15;
const UF_ROW_EXTERNAL_FX = 16;
const UF_ROW_EXTERNAL_FY = 17;
const UF_ROW_EXTERNAL_FZ = 18;
const UF_ROW_ORIENTATION_X = 19;
const UF_ROW_ORIENTATION_Y = 20;
const UF_ROW_ORIENTATION_Z = 21;
const UF_ROW_ORIENTATION_W = 22;
const UF_ROW_OMEGA_X = 23;
const UF_ROW_OMEGA_Y = 24;
const UF_ROW_OMEGA_Z = 25;
const UF_ROW_WATER_ESCAPE_MASK_0 = 26;
const UF_ROW_WATER_ESCAPE_MASK_1 = 27;
const UF_ROW_WATER_ESCAPE_MASK_2 = 28;
const UF_ROW_WATER_AHEAD_MASK = 29;
const UF_ROW_MOVEMENT_ACCEL_X = 30;
const UF_ROW_MOVEMENT_ACCEL_Y = 31;
const UF_ROW_MOVEMENT_ACCEL_Z = 32;
const UF_ROW_ANGULAR_ACCEL_X = 33;
const UF_ROW_ANGULAR_ACCEL_Y = 34;
const UF_ROW_ANGULAR_ACCEL_Z = 35;
// Fully-abstracted medium force profile (appended; rows 0..36 unchanged).
// Rows 36-44 (ground/air/water friction, water force/traction, swim
// family) and row 49 (air angular damping rate) are blueprint constants
// filled by the kernel from the wasm-side profile table.
const UF_ROW_SWIM_SMOOTHED_FORCE = 45;
const UF_ROW_SWIM_RANDOM_SAMPLE = 46;
const UF_ROW_HEADING_X = 47;
const UF_ROW_HEADING_Y = 48;

const UF_FLAG_HAS_THRUST = 1 << 0;
const UF_FLAG_IS_FLYING = 1 << 1;
const UF_FLAG_IS_AIRBORNE = 1 << 2;
const UF_FLAG_BLOCKED_OR_DEAD = 1 << 3;
const UF_FLAG_HAS_EXTERNAL_FORCE = 1 << 4;
const UF_FLAG_IN_WATER = 1 << 5;
const UF_FLAG_AHEAD_IN_WATER = 1 << 6;
const UF_FLAG_HAS_ORIENTATION = 1 << 7;
const UF_FLAG_FORWARD_THRUST_REQUIRES_FACING = 1 << 8;
const UF_FLAG_DRIVE_FORCE_SCALES_WITH_FACING = 1 << 9;

const UF_OUT_MOVEMENT_ACCEL = 1 << 0;
const UF_OUT_CLEAR_COMBAT = 1 << 1;
const UF_OUT_ROTATION_DIRTY = 1 << 2;
const UF_OUT_HOVER_ORIENTATION = 1 << 3;
const UF_OUT_WOKE_BODY = 1 << 4;
const UNIT_GROUND_ANGULAR_DAMPING_RATE =
  dragRateFromVelocityFrictionPer60HzFrame(UNIT_GROUND_FRICTION_PER_60HZ_FRAME);

const entitySlotForId = (entityId: EntityId): number => entitySlotRegistry.getSlot(entityId);

let _forceSlots: Uint32Array = new Uint32Array(0);
let _forceFlags: Uint32Array = new Uint32Array(0);
let _forceRows: Float64Array = new Float64Array(0);
let _forceOutFlags: Uint32Array = new Uint32Array(0);
let _forceEntities: (Entity | undefined)[] = [];
const _forceSupportSurface = createWorldSupportSurface();
const _forceProbeSupportSurface = createWorldSupportSurface();

function ensureForceBatchCapacity(count: number): void {
  if (_forceSlots.length < count) {
    const next = Math.max(count, _forceSlots.length * 2, 256);
    _forceSlots = new Uint32Array(next);
    _forceFlags = new Uint32Array(next);
    _forceOutFlags = new Uint32Array(next);
  }
  const rowLen = count * UNIT_FORCE_BATCH_STRIDE;
  if (_forceRows.length < rowLen) {
    const nextRows = Math.max(rowLen, _forceRows.length * 2, 256 * UNIT_FORCE_BATCH_STRIDE);
    _forceRows = new Float64Array(nextRows);
  }
  if (_forceEntities.length < count) {
    _forceEntities.length = count;
  }
}

/** Slot order kept in lockstep with UF_PROFILE_* in unit_kinetics.rs. */
const UF_PROFILE_STRIDE = 16;

let _unitForceProfileTableUploaded = false;

/** Upload the per-blueprint locomotion constants to the wasm-side
 *  profile table once. The force kernel resolves body slot → entity
 *  slot → blueprint code and fills the constant row slots itself, so
 *  the per-tick pack loop no longer copies them per unit. Values must
 *  mirror exactly what the pack loop used to write (same ??-defaults,
 *  NaN for an unauthored hover height force). */
function ensureUnitForceProfileTable(sim: SimWasm): void {
  if (_unitForceProfileTableUploaded) return;
  let codeCount = 0;
  while (codeToUnitBlueprintId(codeCount) !== null) codeCount++;
  sim.unitForceProfileEnsure(codeCount);
  const values = new Float64Array(
    sim.memory.buffer,
    sim.unitForceProfileValuesPtr(),
    codeCount * UF_PROFILE_STRIDE,
  );
  const flags = new Uint32Array(sim.memory.buffer, sim.unitForceProfileFlagsPtr(), codeCount);
  for (let code = 0; code < codeCount; code++) {
    const unitBlueprintId = codeToUnitBlueprintId(code);
    if (unitBlueprintId === null) continue;
    const blueprint = getUnitBlueprint(unitBlueprintId);
    const loco = getUnitLocomotion(unitBlueprintId);
    const base = code * UF_PROFILE_STRIDE;
    values[base + 0] = loco.driveForce;
    values[base + 1] = loco.traction;
    values[base + 2] = loco.gravityCounterUpwardForceRatio ?? 0;
    values[base + 3] = loco.hoverHeightUpwardForce ?? Number.NaN;
    values[base + 4] = loco.hoverHeightUpwardForceRandomizationAmount ?? 0;
    values[base + 5] = loco.hoverHeightUpwardForceEMA ?? 0;
    values[base + 6] = loco.groundFriction ?? 0;
    values[base + 7] = loco.airFriction ?? 0;
    values[base + 8] = loco.waterForce ?? 0;
    values[base + 9] = loco.waterTraction ?? 0;
    values[base + 10] = loco.waterFriction ?? 0;
    values[base + 11] = loco.swimGravityCounterUpwardForceRatio ?? 0;
    values[base + 12] = loco.swimHeightUpwardForce ?? 0;
    values[base + 13] = loco.swimHeightUpwardForceRandomizationAmount ?? 0;
    values[base + 14] = loco.swimHeightUpwardForceEMA ?? 0;
    values[base + 15] = dragRateFromVelocityFrictionPer60HzFrame(blueprint.airFrictionPer60HzFrame);
    flags[code] =
      (loco.forwardForceRequiresFacing ? UF_FLAG_FORWARD_THRUST_REQUIRES_FACING : 0) |
      (loco.driveForceScalesWithFacing ? UF_FLAG_DRIVE_FORCE_SCALES_WITH_FACING : 0);
  }
  _unitForceProfileTableUploaded = true;
}

export class UnitForceSystem {
  private readonly world: WorldState;
  private readonly simulation: Simulation;
  private readonly physics: PhysicsEngine3D;

  private physicsForceUnitSlotsBuf = new Uint32Array(1024);
  private physicsForceUnitSlotCount = 0;
  private physicsForceSlotEntities: (Entity | undefined)[] = [];
  private physicsCandidateUnitSlotsBuf = new Uint32Array(1024);
  private physicsActiveUnitSlotMarks = new Uint32Array(1024);
  private physicsActiveUnitSlotMark = 1;
  private waterDryMaskCache = new Map<number, number>();

  constructor(world: WorldState, simulation: Simulation, physics: PhysicsEngine3D) {
    this.world = world;
    this.simulation = simulation;
    this.physics = physics;
  }

  applyForces(dtSec: number): void {
    const sim = getSimWasm()!;
    // Defensive: refresh BodyPool views in case WASM memory grew since
    // the last tick. See PhysicsEngine3D.step() for the detached-view
    // crash this guards against.
    sim.pool.refreshViews();
    ensureUnitForceProfileTable(sim);

    const forceAccumulator = this.simulation.getForceAccumulator();

    const activeSlots = this.collectPhysicsForceUnitSlots();
    if (activeSlots.length === 0) return;
    // Support-surface indexing still reads JS Entity transforms, so keep this
    // bridge until support providers are slot-native.
    this.syncActiveBodyTransforms(activeSlots, this.physicsForceSlotEntities);
    this.world.refreshSupportSurfaceIndex();
    this.waterDryMaskCache.clear();

    ensureForceBatchCapacity(activeSlots.length);

    let count = 0;
    for (let i = 0; i < activeSlots.length; i++) {
      const entity = this.physicsForceSlotEntities[i];
      this.physicsForceSlotEntities[i] = undefined;
      if (entity === undefined || entity.body === null || entity.unit === null) continue;

      const body = entity.body.physicsBody;
      const unit = entity.unit;
      const base = count * UNIT_FORCE_BATCH_STRIDE;

      _forceSlots[count] = body.slot;
      _forceEntities[count] = entity;
      _forceRows[base + UF_ROW_ROTATION] = entity.transform.rotation;
      const supportSurface = this.world.sampleSupportSurfaceFromIndex(
        body.x,
        body.y,
        {
          bodyZ: body.z,
          groundOffset: body.groundOffset,
          ignoreEntityId: entity.id,
        },
        _forceSupportSurface,
      );
      const supportSurfaceContact =
        supportSurface.supportKind === 'building' || supportSurface.supportKind === 'unit';
      const supportPenetration = supportSurface.groundZ - (body.z - body.groundOffset);
      const surfaceContact = supportPenetration >= -UNIT_GROUND_CONTACT_EPSILON;
      const buildInProgress = isBuildInProgress(entity.buildable);
      if (buildInProgress) {
        // Freeze the shell's horizontal motion while it is still being built:
        // a factory shell free-falling out of the fabricator torus drops
        // straight down into the production area and cannot slide out. Gravity
        // still acts on Z; the unit is released the tick it completes.
        body.vx = 0;
        body.vy = 0;
        // A shell attached to a mobile producer (a queen building its bee/tick)
        // is locked in all three axes so it rides along with the host instead of
        // free-falling; the static spawn-column case (fabricator) keeps Z free.
        if (entity.buildable !== null && entity.buildable.buildLockHostId !== null) {
          body.vz = 0;
        }
      }
      const locomotionType = unit.locomotion.type;
      const isFlying = locomotionType === 'flying';
      const isAirborneLocomotion = locomotionType === 'hover' || locomotionType === 'flying';
      const suppressAirborneLift = buildInProgress;
      // Blueprint constants (gravity-counter ratio, hover force family)
      // are filled by the kernel from the profile table; the kernel only
      // reads them under IS_AIRBORNE, which already excludes suppressed
      // (build-in-progress) lift, so the old zeroing was redundant.
      _forceRows[base + UF_ROW_HOVER_SMOOTHED_FORCE] =
        suppressAirborneLift ? Number.NaN : unit.hoverHeightUpwardForceSmoothed ?? Number.NaN;
      _forceRows[base + UF_ROW_HOVER_RANDOM_SAMPLE] = 0;
      _forceRows[base + UF_ROW_NORMAL_X] = supportSurface.normalX;
      _forceRows[base + UF_ROW_NORMAL_Y] = supportSurface.normalY;
      _forceRows[base + UF_ROW_NORMAL_Z] = supportSurface.normalZ;
      _forceRows[base + UF_ROW_EXTERNAL_FX] = 0;
      _forceRows[base + UF_ROW_EXTERNAL_FY] = 0;
      _forceRows[base + UF_ROW_EXTERNAL_FZ] = 0;
      _forceRows[base + UF_ROW_ORIENTATION_X] = 0;
      _forceRows[base + UF_ROW_ORIENTATION_Y] = 0;
      _forceRows[base + UF_ROW_ORIENTATION_Z] = 0;
      _forceRows[base + UF_ROW_ORIENTATION_W] = 1;
      _forceRows[base + UF_ROW_OMEGA_X] = 0;
      _forceRows[base + UF_ROW_OMEGA_Y] = 0;
      _forceRows[base + UF_ROW_OMEGA_Z] = 0;
      _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_0] = 0;
      _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_1] = 0;
      _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_2] = 0;
      _forceRows[base + UF_ROW_WATER_AHEAD_MASK] = 0;

      // Fully-abstracted medium force profile (all opt-in, default 0/inert).
      const loco = unit.locomotion;
      // A unit "swims" only if it authored water drive or swim lift. Used to
      // gate the open-water medium flag below so non-swimmers (every existing
      // unit) keep their exact pre-profile UF_FLAG_IN_WATER and stay byte-
      // identical.
      const unitIsSwimmer =
        (loco.waterForce ?? 0) > 0 || (loco.swimHeightUpwardForce ?? 0) > 0;
      // Ground/air/water friction, water force/traction, the swim family
      // and the air angular damping rate are blueprint constants filled by
      // the kernel from the profile table.
      _forceRows[base + UF_ROW_SWIM_SMOOTHED_FORCE] =
        unit.swimHeightUpwardForceSmoothed ?? Number.NaN;
      _forceRows[base + UF_ROW_SWIM_RANDOM_SAMPLE] = 0;
      _forceRows[base + UF_ROW_HEADING_X] = 0;
      _forceRows[base + UF_ROW_HEADING_Y] = 0;

      let flags = 0;

      if (unit.hp <= 0) {
        _forceRows[base + UF_ROW_DIR_X] = 0;
        _forceRows[base + UF_ROW_DIR_Y] = 0;
        _forceRows[base + UF_ROW_GROUND_Z] = 0;
        _forceFlags[count] = UF_FLAG_BLOCKED_OR_DEAD;
        count++;
        continue;
      }

      // The facing flags (forwardForceRequiresFacing /
      // driveForceScalesWithFacing) are blueprint constants OR'd in by
      // the kernel from the profile table.
      const dirX = unit.thrustDirX ?? 0;
      const dirY = unit.thrustDirY ?? 0;
      _forceRows[base + UF_ROW_DIR_X] = dirX;
      _forceRows[base + UF_ROW_DIR_Y] = dirY;
      _forceRows[base + UF_ROW_HEADING_X] = unit.headingDirX ?? 0;
      _forceRows[base + UF_ROW_HEADING_Y] = unit.headingDirY ?? 0;
      const dirLenSq = dirX * dirX + dirY * dirY;
      const hasThrustDir = dirLenSq > 0.0001;
      if (hasThrustDir) flags |= UF_FLAG_HAS_THRUST;
      const thrustInputMag = hasThrustDir ? DMath.sqrt(dirLenSq) : 0;

      const liftLocomotionActive = isAirborneLocomotion && !buildInProgress;
      if (isFlying && liftLocomotionActive) flags |= UF_FLAG_IS_FLYING;
      if (liftLocomotionActive) flags |= UF_FLAG_IS_AIRBORNE;

      const externalForce = forceAccumulator.getFinalForce(entity.id);
      if (externalForce !== null) {
        flags |= UF_FLAG_HAS_EXTERNAL_FORCE;
        _forceRows[base + UF_ROW_EXTERNAL_FX] = externalForce.fx;
        _forceRows[base + UF_ROW_EXTERNAL_FY] = externalForce.fy;
        _forceRows[base + UF_ROW_EXTERNAL_FZ] = externalForce.fz;
      }

      _forceRows[base + UF_ROW_GROUND_Z] = supportSurface.groundZ;

      let orientation = unit.orientation;
      if (orientation === null) {
        const halfYaw = (Number.isFinite(entity.transform.rotation)
          ? entity.transform.rotation
          : 0) * 0.5;
        orientation = unit.orientation = {
          x: 0,
          y: 0,
          z: Math.sin(halfYaw),
          w: Math.cos(halfYaw),
        };
      }
      let omega = unit.angularVelocity3;
      if (omega === null) {
        omega = unit.angularVelocity3 = { x: 0, y: 0, z: 0 };
      }
      if (unit.angularAcceleration3 === null) {
        unit.angularAcceleration3 = { x: 0, y: 0, z: 0 };
      }
      const hasAngularMotionForSleep =
        omega.x * omega.x + omega.y * omega.y + omega.z * omega.z > 1e-12;
      flags |= UF_FLAG_HAS_ORIENTATION;
      _forceRows[base + UF_ROW_ORIENTATION_X] = orientation.x;
      _forceRows[base + UF_ROW_ORIENTATION_Y] = orientation.y;
      _forceRows[base + UF_ROW_ORIENTATION_Z] = orientation.z;
      _forceRows[base + UF_ROW_ORIENTATION_W] = orientation.w;
      _forceRows[base + UF_ROW_OMEGA_X] = omega.x;
      _forceRows[base + UF_ROW_OMEGA_Y] = omega.y;
      _forceRows[base + UF_ROW_OMEGA_Z] = omega.z;

      if (liftLocomotionActive) {
        const willRustSkipSleeping =
          body.sleeping &&
          !isFlying &&
          !hasThrustDir &&
          externalForce === null &&
          !hasAngularMotionForSleep;
        const randAmount =
          unit.locomotion.hoverHeightUpwardForceRandomizationAmount ?? 0;
        if (!willRustSkipSleeping && randAmount > 0) {
          _forceRows[base + UF_ROW_HOVER_RANDOM_SAMPLE] = this.world.rng.next();
        }
      } else if (surfaceContact) {
        if (supportSurfaceContact) {
          this.writeSupportSurfaceNormal(entity, supportSurface);
        }
        _forceRows[base + UF_ROW_GROUND_Z] = supportSurface.groundZ;
        _forceRows[base + UF_ROW_NORMAL_X] = supportSurface.normalX;
        _forceRows[base + UF_ROW_NORMAL_Y] = supportSurface.normalY;
        _forceRows[base + UF_ROW_NORMAL_Z] = supportSurface.normalZ;
        const radius = body.radius || 10;
        const inWater = supportSurface.materialKind === 'water';
        if (inWater) {
          flags |= UF_FLAG_IN_WATER;
          _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_0] = this.waterDryMask(
            body.x,
            body.y,
            radius * WATER_ESCAPE_PROBE_MULTS[0],
          );
          _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_1] = this.waterDryMask(
            body.x,
            body.y,
            radius * WATER_ESCAPE_PROBE_MULTS[1],
          );
          _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_2] = this.waterDryMask(
            body.x,
            body.y,
            radius * WATER_ESCAPE_PROBE_MULTS[2],
          );
        } else if (supportSurfaceContact) {
          // The top of another physics body is a flat support plane for
          // locomotion, independent of the terrain/water underneath it.
        } else {
          if (hasThrustDir) {
            const invDirMag = 1 / thrustInputMag;
            const useDirX = loco.forwardForceRequiresFacing
              ? Math.cos(entity.transform.rotation)
              : dirX * invDirMag;
            const useDirY = loco.forwardForceRequiresFacing
              ? Math.sin(entity.transform.rotation)
              : dirY * invDirMag;
            const probe = radius + 5;
            const aheadX = body.x + useDirX * probe;
            const aheadY = body.y + useDirY * probe;
            const aheadSurface = this.world.sampleSupportSurfaceFromIndex(
              aheadX,
              aheadY,
              { ignoreEntityId: entity.id },
              _forceProbeSupportSurface,
            );
            if (aheadSurface.materialKind === 'water') {
              flags |= UF_FLAG_AHEAD_IN_WATER;
              _forceRows[base + UF_ROW_WATER_AHEAD_MASK] = this.waterDryMask(
                aheadX,
                aheadY,
                radius,
              );
            }
          }
        }
      } else if (unitIsSwimmer && body.z < WATER_LEVEL) {
        // Suspended in the water column with no ground contact: only swimmers
        // reach here. Mark the water medium so the kernel's swim path can drive
        // and seek depth. Gated on unitIsSwimmer so non-swimmers (every
        // existing unit) never get this flag and stay byte-identical.
        flags |= UF_FLAG_IN_WATER;
      }

      // Feed the swim-lift RNG sample iff the kernel will consume it (submerged,
      // non-zero swim randomization + force, body not sleep-skipped). For
      // non-swimmers swimForce is 0, so the RNG stream is untouched.
      if ((flags & UF_FLAG_IN_WATER) !== 0) {
        const swimRand = loco.swimHeightUpwardForceRandomizationAmount ?? 0;
        const swimForce = loco.swimHeightUpwardForce ?? 0;
        if (swimRand > 0 && swimForce > 0) {
          // Mirror the kernel sleep-skip (isFlying is always false on the
          // in-water paths) so RNG advances in lockstep across peers.
          const willRustSkipSleeping =
            body.sleeping &&
            !hasThrustDir &&
            externalForce === null &&
            !hasAngularMotionForSleep;
          if (!willRustSkipSleeping) {
            _forceRows[base + UF_ROW_SWIM_RANDOM_SAMPLE] = this.world.rng.next();
          }
        }
      }

      _forceFlags[count] = flags;
      count++;
    }

    if (count === 0) return;

    measureWasmBoundary('server.unitForceStepBatch', () => {
      sim.unitForceStepBatch(
        _forceSlots.subarray(0, count),
        _forceFlags.subarray(0, count),
        _forceRows.subarray(0, count * UNIT_FORCE_BATCH_STRIDE),
        _forceOutFlags.subarray(0, count),
        count,
        dtSec,
        this.world.thrustMultiplier,
        LOCOMOTION_FORCE_SCALE,
        UNIT_LOCOMOTION_FORCE_REFERENCE_MASS,
        HOVER_ORIENTATION_K,
        HOVER_ORIENTATION_C,
        UNIT_GROUND_ANGULAR_DAMPING_RATE,
        UNIT_DRIVE_FORCE_ALIGNMENT_ZERO_FORCE_DOT,
        UNIT_DRIVE_FORCE_ALIGNMENT_FULL_FORCE_DOT,
        UNIT_DRIVE_FORCE_ALIGNMENT_RESPONSE_EXPONENT,
      );
    });

    for (let i = 0; i < count; i++) {
      const entity = _forceEntities[i];
      _forceEntities[i] = undefined;
      if (entity === undefined || entity.unit === null || entity.body === null) continue;
      const unit = entity.unit;
      const body = entity.body.physicsBody;
      const outFlags = _forceOutFlags[i];
      const base = i * UNIT_FORCE_BATCH_STRIDE;

      if ((outFlags & UF_OUT_WOKE_BODY) !== 0) {
        this.physics.recordWasmForceWake(body);
      }

      if ((outFlags & UF_OUT_MOVEMENT_ACCEL) !== 0) {
        setUnitMovementAcceleration(
          unit,
          _forceRows[base + UF_ROW_MOVEMENT_ACCEL_X],
          _forceRows[base + UF_ROW_MOVEMENT_ACCEL_Y],
          _forceRows[base + UF_ROW_MOVEMENT_ACCEL_Z],
        );
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
            this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_VEL);
          }
        }
        const angularAccel = unit.angularAcceleration3;
        if (angularAccel !== null) {
          angularAccel.x = _forceRows[base + UF_ROW_ANGULAR_ACCEL_X];
          angularAccel.y = _forceRows[base + UF_ROW_ANGULAR_ACCEL_Y];
          angularAccel.z = _forceRows[base + UF_ROW_ANGULAR_ACCEL_Z];
        }
      }

      const locomotionType = unit.locomotion.type;
      if (
        (locomotionType === 'hover' || locomotionType === 'flying') &&
        (outFlags & UF_OUT_MOVEMENT_ACCEL) !== 0
      ) {
        const smoothedHoverForce = _forceRows[base + UF_ROW_HOVER_SMOOTHED_FORCE];
        unit.hoverHeightUpwardForceSmoothed =
          (unit.locomotion.hoverHeightUpwardForceEMA ?? 0) > 0 && Number.isFinite(smoothedHoverForce)
            ? smoothedHoverForce
            : null;
      }

      if (
        (unit.locomotion.swimHeightUpwardForceEMA ?? 0) > 0 &&
        (outFlags & UF_OUT_MOVEMENT_ACCEL) !== 0
      ) {
        // Persist the swim-lift EMA accumulator. When the unit was not
        // submerged this tick the kernel left the row at its marshaled value,
        // so this read-back is a no-op (preserves the accumulator across brief
        // surfacing); NaN clears it for a fresh reseed.
        const smoothedSwimForce = _forceRows[base + UF_ROW_SWIM_SMOOTHED_FORCE];
        unit.swimHeightUpwardForceSmoothed = Number.isFinite(smoothedSwimForce)
          ? smoothedSwimForce
          : null;
      }

      if ((outFlags & UF_OUT_ROTATION_DIRTY) !== 0) {
        entity.transform.rotation = _forceRows[base + UF_ROW_ROTATION];
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ROT);
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

    const movingUnits = this.simulation.getMovingUnits();
    for (let i = 0; i < movingUnits.length; i++) {
      this.pushPhysicsForceUnitSlot(entitySlotRegistry.getEntitySlot(movingUnits[i]));
    }

    const flyingUnits = this.world.getFlyingUnits();
    for (let i = 0; i < flyingUnits.length; i++) {
      this.pushPhysicsForceUnitSlot(entitySlotRegistry.getEntitySlot(flyingUnits[i]));
    }

    const forceAccumulator = this.simulation.getForceAccumulator();
    const units = this.world.getUnits();
    this.ensurePhysicsCandidateSlotCapacity(
      Math.max(units.length, forceAccumulator.activeEntityCount()),
    );
    let candidateCount = forceAccumulator.collectActiveEntitySlots(
      this.physicsCandidateUnitSlotsBuf,
      entitySlotForId,
    );
    for (let i = 0; i < candidateCount; i++) {
      this.pushPhysicsForceUnitSlot(this.physicsCandidateUnitSlotsBuf[i]);
    }

    const sim = getSimWasm();
    candidateCount = sim !== undefined
      ? sim.entityState.collectAwakeBodyEntitySlots(this.physicsCandidateUnitSlotsBuf)
      : this.physics.collectAwakeEntitySlots(
        this.physicsCandidateUnitSlotsBuf,
        entitySlotForId,
      );
    if (candidateCount < 0) {
      this.ensurePhysicsCandidateSlotCapacity(-candidateCount);
      candidateCount = sim !== undefined
        ? sim.entityState.collectAwakeBodyEntitySlots(this.physicsCandidateUnitSlotsBuf)
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

  private syncActiveBodyTransforms(
    activeSlots: Uint32Array,
    activeEntities: (Entity | undefined)[],
  ): void {
    for (let i = 0; i < activeSlots.length; i++) {
      const entity = entitySlotRegistry.resolveSlot(activeSlots[i]);
      activeEntities[i] = entity;
      if (entity === undefined || entity.body === null) continue;
      const body = entity.body.physicsBody;
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;
    }
  }

  private waterOutCacheKey(x: number, y: number, probeR: number): number {
    const cx = Math.floor(x / WATER_OUT_CACHE_CELL_SIZE) + 32768;
    const cy = Math.floor(y / WATER_OUT_CACHE_CELL_SIZE) + 32768;
    const rb = Math.max(0, Math.min(255, Math.round(probeR / WATER_OUT_CACHE_BUCKET_SCALE)));
    return cx * 0x1000000 + cy * 0x100 + rb;
  }

  private waterDryMask(
    x: number,
    y: number,
    probeR: number,
  ): number {
    if (this.waterDryMaskCache.size >= WATER_OUT_CACHE_MAX_ENTRIES) {
      this.waterDryMaskCache.clear();
    }
    const key = this.waterOutCacheKey(x, y, probeR);
    const cached = this.waterDryMaskCache.get(key);
    if (cached !== undefined) return cached;

    let mask = 0;
    for (let i = 0; i < WATER_PROBE_DX.length; i++) {
      const surface = this.world.sampleSupportSurfaceFromIndex(
        x + WATER_PROBE_DX[i] * probeR,
        y + WATER_PROBE_DY[i] * probeR,
        {},
        _forceProbeSupportSurface,
      );
      if (surface.materialKind !== 'water') {
        mask |= 1 << i;
      }
    }
    this.waterDryMaskCache.set(key, mask);
    return mask;
  }
}
