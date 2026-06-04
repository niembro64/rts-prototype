// UnitForceSystem - authoritative force orchestration for unit physics bodies.
// TypeScript gathers entity/terrain inputs, the Rust/WASM batch owns the
// per-unit force decisions and writes BodyPool acceleration directly.

import {
  getTerrainVersion,
  isWaterAt,
} from '../sim/Terrain';
import {
  LOCOMOTION_FORCE_SCALE,
} from '../sim/locomotion';
import {
  UNIT_GROUND_CONTACT_EPSILON,
} from '../sim/unitGroundPhysics';
import {
  ENTITY_CHANGED_ROT,
} from '../../types/network';
import type { Simulation } from '../sim/Simulation';
import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId } from '../sim/types';
import type { PhysicsEngine3D } from './PhysicsEngine3D';
import { setUnitMovementAcceleration } from '../sim/unitMovementAcceleration';
import { getSimWasm, UNIT_FORCE_BATCH_STRIDE } from '../sim-wasm/init';
import { isBuildInProgress } from '../sim/buildableHelpers';

const WATER_PROBE_DX = [
  1, 0.7071067811865476, 0, -0.7071067811865475,
  -1, -0.7071067811865477, 0, 0.7071067811865474,
];
const WATER_PROBE_DY = [
  0, 0.7071067811865475, 1, 0.7071067811865476,
  0, -0.7071067811865475, -1, -0.7071067811865477,
];
const WATER_ESCAPE_PROBE_MULTS = [1.5, 3, 6];

// Hover orientation spring stiffness. Target pitch/roll stay pinned to
// zero; renderer-side banking remains visual-only.
const HOVER_ORIENTATION_K = 30;
const HOVER_ORIENTATION_C = 2 * Math.sqrt(HOVER_ORIENTATION_K);

const WATER_OUT_CACHE_CELL_SIZE = 25;
const WATER_OUT_CACHE_BUCKET_SCALE = 10;
const WATER_OUT_CACHE_MAX_ENTRIES = 4096;

const UF_ROW_DIR_X = 0;
const UF_ROW_DIR_Y = 1;
const UF_ROW_ROTATION = 2;
const UF_ROW_UNIT_MASS = 3;
const UF_ROW_DRIVE_FORCE = 4;
const UF_ROW_TRACTION = 5;
const UF_ROW_GRAVITY_COUNTER_RATIO = 6;
const UF_ROW_HOVER_HEIGHT_FORCE = 7;
const UF_ROW_HOVER_RANDOM_AMOUNT = 8;
const UF_ROW_HOVER_EMA_WEIGHT = 9;
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

const UF_FLAG_HAS_THRUST = 1 << 0;
const UF_FLAG_IS_FLYING = 1 << 1;
const UF_FLAG_IS_AIRBORNE = 1 << 2;
const UF_FLAG_BLOCKED_OR_DEAD = 1 << 3;
const UF_FLAG_HAS_EXTERNAL_FORCE = 1 << 4;
const UF_FLAG_IN_WATER = 1 << 5;
const UF_FLAG_AHEAD_IN_WATER = 1 << 6;
const UF_FLAG_HAS_ORIENTATION = 1 << 7;

const UF_OUT_MOVEMENT_ACCEL = 1 << 0;
const UF_OUT_CLEAR_COMBAT = 1 << 1;
const UF_OUT_ROTATION_DIRTY = 1 << 2;
const UF_OUT_HOVER_ORIENTATION = 1 << 3;
const UF_OUT_WOKE_BODY = 1 << 4;

let _forceSlots: Uint32Array = new Uint32Array(0);
let _forceFlags: Uint32Array = new Uint32Array(0);
let _forceRows: Float64Array = new Float64Array(0);
let _forceOutFlags: Uint32Array = new Uint32Array(0);
let _forceEntities: (Entity | undefined)[] = [];

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

export class UnitForceSystem {
  private readonly world: WorldState;
  private readonly simulation: Simulation;
  private readonly physics: PhysicsEngine3D;

  private readonly physicsForceUnitIdsBuf: EntityId[] = [];
  private readonly physicsCandidateUnitIdsBuf: EntityId[] = [];
  private readonly physicsActiveUnitIds = new Set<EntityId>();
  private waterDryMaskCache = new Map<number, number>();
  private waterDryMaskCacheTerrainVersion = -1;

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

    const forceAccumulator = this.simulation.getForceAccumulator();
    const mw = this.world.mapWidth;
    const mh = this.world.mapHeight;

    this.collectPhysicsForceUnitIds();
    const activeIds = this.physicsForceUnitIdsBuf;
    if (activeIds.length === 0) return;

    ensureForceBatchCapacity(activeIds.length);

    let count = 0;
    for (let i = 0; i < activeIds.length; i++) {
      const entity = this.world.getEntity(activeIds[i]);
      if (entity === undefined || entity.body === null || entity.unit === null) continue;

      const body = entity.body.physicsBody;
      const unit = entity.unit;
      const base = count * UNIT_FORCE_BATCH_STRIDE;

      // Sync position from physics before force application for any
      // consumer that reads transform during this tick. z is fully
      // dynamic; terrain support is applied by the integrator.
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;

      _forceSlots[count] = body.slot;
      _forceEntities[count] = entity;
      _forceRows[base + UF_ROW_ROTATION] = entity.transform.rotation;
      _forceRows[base + UF_ROW_UNIT_MASS] = unit.mass;
      _forceRows[base + UF_ROW_DRIVE_FORCE] = unit.locomotion.driveForce;
      _forceRows[base + UF_ROW_TRACTION] = unit.locomotion.traction;
      _forceRows[base + UF_ROW_GRAVITY_COUNTER_RATIO] =
        unit.locomotion.gravityCounterUpwardForceRatio ?? 0;
      _forceRows[base + UF_ROW_HOVER_HEIGHT_FORCE] =
        unit.locomotion.hoverHeightUpwardForce ?? Number.NaN;
      _forceRows[base + UF_ROW_HOVER_RANDOM_AMOUNT] =
        unit.locomotion.hoverHeightUpwardForceRandomizationAmount ?? 0;
      _forceRows[base + UF_ROW_HOVER_EMA_WEIGHT] =
        unit.locomotion.hoverHeightUpwardForceEMA ?? 0;
      _forceRows[base + UF_ROW_HOVER_SMOOTHED_FORCE] =
        unit.hoverHeightUpwardForceSmoothed ?? Number.NaN;
      _forceRows[base + UF_ROW_HOVER_RANDOM_SAMPLE] = 0;
      _forceRows[base + UF_ROW_NORMAL_X] = 0;
      _forceRows[base + UF_ROW_NORMAL_Y] = 0;
      _forceRows[base + UF_ROW_NORMAL_Z] = 1;
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

      let flags = 0;

      if (unit.hp <= 0) {
        _forceRows[base + UF_ROW_DIR_X] = 0;
        _forceRows[base + UF_ROW_DIR_Y] = 0;
        _forceRows[base + UF_ROW_GROUND_Z] = 0;
        _forceFlags[count] = UF_FLAG_BLOCKED_OR_DEAD;
        count++;
        continue;
      }

      const dirX = unit.thrustDirX ?? 0;
      const dirY = unit.thrustDirY ?? 0;
      _forceRows[base + UF_ROW_DIR_X] = dirX;
      _forceRows[base + UF_ROW_DIR_Y] = dirY;
      const dirLenSq = dirX * dirX + dirY * dirY;
      const hasThrustDir = dirLenSq > 0.0001;
      if (hasThrustDir) flags |= UF_FLAG_HAS_THRUST;
      const thrustInputMag = hasThrustDir ? Math.sqrt(dirLenSq) : 0;

      const locomotionType = unit.locomotion.type;
      const isConstructionShell = isBuildInProgress(entity.buildable);
      // Construction shells keep their locomotion contact/friction, but
      // they do not get autonomous hover/flying lift while the factory is
      // trying to drop them onto a build platform.
      const isFlying = !isConstructionShell && locomotionType === 'flying';
      const isAirborne = !isConstructionShell && (locomotionType === 'hover' || locomotionType === 'flying');
      if (isFlying) flags |= UF_FLAG_IS_FLYING;
      if (isAirborne) flags |= UF_FLAG_IS_AIRBORNE;

      const externalForce = forceAccumulator.getFinalForce(entity.id);
      if (externalForce !== null) {
        flags |= UF_FLAG_HAS_EXTERNAL_FORCE;
        _forceRows[base + UF_ROW_EXTERNAL_FX] = externalForce.fx;
        _forceRows[base + UF_ROW_EXTERNAL_FY] = externalForce.fy;
        _forceRows[base + UF_ROW_EXTERNAL_FZ] = externalForce.fz;
      }

      const groundZ = this.world.getGroundZ(body.x, body.y);
      _forceRows[base + UF_ROW_GROUND_Z] = groundZ;

      if (isAirborne) {
        const orientation = unit.orientation;
        const omega = unit.angularVelocity3;
        if (orientation !== null && omega !== null) {
          flags |= UF_FLAG_HAS_ORIENTATION;
          _forceRows[base + UF_ROW_ORIENTATION_X] = orientation.x;
          _forceRows[base + UF_ROW_ORIENTATION_Y] = orientation.y;
          _forceRows[base + UF_ROW_ORIENTATION_Z] = orientation.z;
          _forceRows[base + UF_ROW_ORIENTATION_W] = orientation.w;
          _forceRows[base + UF_ROW_OMEGA_X] = omega.x;
          _forceRows[base + UF_ROW_OMEGA_Y] = omega.y;
          _forceRows[base + UF_ROW_OMEGA_Z] = omega.z;
        }

        const willRustSkipSleeping =
          body.sleeping &&
          !isFlying &&
          !hasThrustDir &&
          externalForce === null;
        const randAmount =
          unit.locomotion.hoverHeightUpwardForceRandomizationAmount ?? 0;
        if (!willRustSkipSleeping && randAmount > 0) {
          _forceRows[base + UF_ROW_HOVER_RANDOM_SAMPLE] = this.world.rng.next();
        }
      } else {
        const terrainContact =
          groundZ - (body.z - body.groundOffset) >= -UNIT_GROUND_CONTACT_EPSILON;
        const surfaceContact = !terrainContact && this.physics.hasUpwardSurfaceContact(body);
        if (terrainContact || surfaceContact) {
          if (surfaceContact) {
            _forceRows[base + UF_ROW_GROUND_Z] = body.z - body.groundOffset;
            _forceRows[base + UF_ROW_NORMAL_X] = 0;
            _forceRows[base + UF_ROW_NORMAL_Y] = 0;
            _forceRows[base + UF_ROW_NORMAL_Z] = 1;
          }
          const radius = body.radius || 10;
          const inWater = terrainContact && isWaterAt(body.x, body.y, mw, mh);
          if (inWater) {
            flags |= UF_FLAG_IN_WATER;
            _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_0] = this.waterDryMask(
              body.x,
              body.y,
              radius * WATER_ESCAPE_PROBE_MULTS[0],
              mw,
              mh,
            );
            _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_1] = this.waterDryMask(
              body.x,
              body.y,
              radius * WATER_ESCAPE_PROBE_MULTS[1],
              mw,
              mh,
            );
            _forceRows[base + UF_ROW_WATER_ESCAPE_MASK_2] = this.waterDryMask(
              body.x,
              body.y,
              radius * WATER_ESCAPE_PROBE_MULTS[2],
              mw,
              mh,
            );
          } else {
            if (hasThrustDir) {
              const invDirMag = 1 / thrustInputMag;
              const useDirX = dirX * invDirMag;
              const useDirY = dirY * invDirMag;
              const probe = radius + 5;
              const aheadX = body.x + useDirX * probe;
              const aheadY = body.y + useDirY * probe;
              if (isWaterAt(aheadX, aheadY, mw, mh)) {
                flags |= UF_FLAG_AHEAD_IN_WATER;
                _forceRows[base + UF_ROW_WATER_AHEAD_MASK] = this.waterDryMask(
                  aheadX,
                  aheadY,
                  radius,
                  mw,
                  mh,
                );
              }
            }
            const n = this.world.getCachedSurfaceNormal(body.x, body.y);
            _forceRows[base + UF_ROW_NORMAL_X] = n.nx;
            _forceRows[base + UF_ROW_NORMAL_Y] = n.ny;
            _forceRows[base + UF_ROW_NORMAL_Z] = n.nz;
          }
        }
      }

      _forceFlags[count] = flags;
      count++;
    }

    if (count === 0) return;

    sim.unitForceStepBatch(
      _forceSlots.subarray(0, count),
      _forceFlags.subarray(0, count),
      _forceRows.subarray(0, count * UNIT_FORCE_BATCH_STRIDE),
      _forceOutFlags.subarray(0, count),
      count,
      dtSec,
      this.world.thrustMultiplier,
      LOCOMOTION_FORCE_SCALE,
      HOVER_ORIENTATION_K,
      HOVER_ORIENTATION_C,
    );

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
        }
        continue;
      }

      if ((outFlags & UF_OUT_HOVER_ORIENTATION) !== 0) {
        const orientation = unit.orientation;
        const omega = unit.angularVelocity3;
        if (orientation !== null && omega !== null) {
          orientation.x = _forceRows[base + UF_ROW_ORIENTATION_X];
          orientation.y = _forceRows[base + UF_ROW_ORIENTATION_Y];
          orientation.z = _forceRows[base + UF_ROW_ORIENTATION_Z];
          orientation.w = _forceRows[base + UF_ROW_ORIENTATION_W];
          omega.x = _forceRows[base + UF_ROW_OMEGA_X];
          omega.y = _forceRows[base + UF_ROW_OMEGA_Y];
          omega.z = _forceRows[base + UF_ROW_OMEGA_Z];
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
        unit.hoverHeightUpwardForceSmoothed =
          (unit.locomotion.hoverHeightUpwardForceEMA ?? 0) > 0
            ? _forceRows[base + UF_ROW_HOVER_SMOOTHED_FORCE]
            : null;
      }

      if ((outFlags & UF_OUT_ROTATION_DIRTY) !== 0) {
        entity.transform.rotation = _forceRows[base + UF_ROW_ROTATION];
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ROT);
      }
    }
  }

  private collectPhysicsForceUnitIds(): void {
    const ids = this.physicsForceUnitIdsBuf;
    const seen = this.physicsActiveUnitIds;
    ids.length = 0;
    seen.clear();

    const pushId = (id: EntityId): void => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };

    const movingUnits = this.simulation.getMovingUnits();
    for (let i = 0; i < movingUnits.length; i++) {
      pushId(movingUnits[i].id);
    }

    const units = this.world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const unit = units[i].unit;
      if (unit !== null && unit.locomotion.type === 'flying') {
        pushId(units[i].id);
      }
    }

    const candidates = this.physicsCandidateUnitIdsBuf;
    candidates.length = 0;
    this.simulation.getForceAccumulator().collectActiveEntityIds(candidates);
    for (let i = 0; i < candidates.length; i++) {
      pushId(candidates[i]);
    }

    candidates.length = 0;
    this.physics.collectAwakeEntityIds(candidates);
    for (let i = 0; i < candidates.length; i++) {
      pushId(candidates[i]);
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
    mapWidth: number,
    mapHeight: number,
  ): number {
    const tv = getTerrainVersion();
    if (
      tv !== this.waterDryMaskCacheTerrainVersion ||
      this.waterDryMaskCache.size >= WATER_OUT_CACHE_MAX_ENTRIES
    ) {
      this.waterDryMaskCache.clear();
      this.waterDryMaskCacheTerrainVersion = tv;
    }
    const key = this.waterOutCacheKey(x, y, probeR);
    const cached = this.waterDryMaskCache.get(key);
    if (cached !== undefined) return cached;

    let mask = 0;
    for (let i = 0; i < WATER_PROBE_DX.length; i++) {
      if (
        !isWaterAt(
          x + WATER_PROBE_DX[i] * probeR,
          y + WATER_PROBE_DY[i] * probeR,
          mapWidth,
          mapHeight,
        )
      ) {
        mask |= 1 << i;
      }
    }
    this.waterDryMaskCache.set(key, mask);
    return mask;
  }
}
