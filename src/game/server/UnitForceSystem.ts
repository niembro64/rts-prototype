// UnitForceSystem - Per-tick force application for unit physics bodies.
// Owns thrust gating against water, idle-brake on slopes, and the
// "outward from water" probe cache. Pulled out of GameServer so the
// host class can stay focused on bootstrap, tick scheduling, and
// snapshot publishing.

import { magnitude, magnitude3 } from '../math';
import { GRAVITY } from '../../config';
import {
  getTerrainVersion,
  isWaterAt,
  projectHorizontalOntoSlope,
} from '../sim/Terrain';
import { getLocomotionForceProfile } from '../sim/locomotion';
import {
  unitJumpCanRelease,
  getUnitJumpSpringEnergy,
  sampleUnitJumpLaunchForce,
  unitJumpHasActuatorWork,
  unitJumpWantsActuator,
  type UnitJumpLaunchForce,
  type UnitJumpIntent,
} from '../sim/unitJump';
import { canJumpLandAwayFromWater } from '../sim/unitJumpLanding';
import { isUnitGroundPointAtOrBelowTerrain } from '../sim/unitGroundPhysics';
import {
  ENTITY_CHANGED_MOVEMENT_ACCEL,
  ENTITY_CHANGED_JUMP,
  ENTITY_CHANGED_ROT,
} from '../../types/network';
import type { Simulation } from '../sim/Simulation';
import type { WorldState } from '../sim/WorldState';
import type { CombatComponent, Entity, EntityId, Unit } from '../sim/types';
import type { Body3D, PhysicsEngine3D } from './PhysicsEngine3D';
import { setUnitMovementAcceleration } from '../sim/unitMovementAcceleration';
import { quatYaw } from '../math/Quaternion';
import { getSimWasm, QUAT_HOVER_BATCH_STRIDE } from '../sim-wasm/init';

const WATER_PROBE_DX = [
  1, 0.7071067811865476, 0, -0.7071067811865475,
  -1, -0.7071067811865477, 0, 0.7071067811865474,
];
const WATER_PROBE_DY = [
  0, 0.7071067811865475, 1, 0.7071067811865476,
  0, -0.7071067811865475, -1, -0.7071067811865477,
];
const WATER_ESCAPE_PROBE_MULTS = [1.5, 3, 6];
const MATTER_FORCE_SCALE = 150000;

// Phase 4 + 3e — deferred batch buffer for the hover orientation
// quaternion spring. UnitForceSystem.applyForces gathers per-hover
// (orientation, omega, target yaw/pitch/roll) into this buffer
// during the per-entity loop, then runs ONE WASM call after the
// loop to advance every hover entity's orientation in place.
let _hoverDeferBuf: Float64Array = new Float64Array(0);
let _hoverDeferEntities: Entity[] = [];
let _hoverDeferCount = 0;

// Hover bank/pitch behaviour constants. Both are dimensionless
// "radians of bank/pitch per world-unit/second of body-frame
// velocity"; the clamps keep the unit from doing barrel rolls under
// large transient pushes (knockback / collision spikes).
const HOVER_BANK_PER_LATERAL_V = 0.012;
const HOVER_PITCH_PER_FORWARD_V = 0.008;
const HOVER_BANK_MAX = Math.PI * 0.25;   // 45° bank
const HOVER_PITCH_MAX = Math.PI * 0.18;  // ~32° nose-down/up
// Critically-damped spring stiffness for the hover orientation. Low
// enough that the bank lags behind input (so it READS as a real
// banking motion) but high enough to settle in well under a second
// at typical RTS pacing.
const HOVER_ORIENTATION_K = 30;
const HOVER_ORIENTATION_C = 2 * Math.sqrt(HOVER_ORIENTATION_K);
const WATER_OUT_CACHE_CELL_SIZE = 25;
const WATER_OUT_CACHE_BUCKET_SCALE = 10;
// Hard cap on the probe cache. At cell-size 25 a 4k×4k map has ~25k
// possible cells; in practice probes cluster around shorelines, so a
// few thousand keys cover every spot units actually visit. Beyond
// that the cache is just a long-tail leak, so we drop it wholesale
// on overflow rather than carry per-entry LRU bookkeeping in the
// physics tick.
const WATER_OUT_CACHE_MAX_ENTRIES = 4096;

type WaterOutCacheEntry = { ok: boolean; x: number; y: number };
type LocomotionForceProfile = ReturnType<typeof getLocomotionForceProfile>;

export class UnitForceSystem {
  private readonly world: WorldState;
  private readonly simulation: Simulation;
  private readonly physics: PhysicsEngine3D;

  private readonly physicsForceUnitIdsBuf: EntityId[] = [];
  private readonly physicsCandidateUnitIdsBuf: EntityId[] = [];
  private readonly jumpActuatorUnitIds: EntityId[] = [];
  private readonly physicsActiveUnitIds = new Set<EntityId>();
  private jumpActuatorUnitSetVersion = -1;
  private _idleBrakeForceX = 0;
  private _idleBrakeForceY = 0;
  private _idleBrakeForceZ = 0;
  private _waterOutX = 0;
  private _waterOutY = 0;
  private readonly _jumpLaunchForce: UnitJumpLaunchForce = { x: 0, y: 0, z: 0 };
  private waterOutCache = new Map<number, WaterOutCacheEntry>();
  private waterOutCacheTerrainVersion = -1;

  constructor(world: WorldState, simulation: Simulation, physics: PhysicsEngine3D) {
    this.world = world;
    this.simulation = simulation;
    this.physics = physics;
  }

  // Apply thrust and external forces to physics bodies
  applyForces(dtSec: number): void {
    const forceAccumulator = this.simulation.getForceAccumulator();
    const mw = this.world.mapWidth;
    const mh = this.world.mapHeight;

    this.collectPhysicsForceUnitIds();
    const activeIds = this.physicsForceUnitIdsBuf;
    for (let i = 0; i < activeIds.length; i++) {
      const entity = this.world.getEntity(activeIds[i]);
      if (!entity || !entity.body?.physicsBody || !entity.unit) continue;

      const body = entity.body.physicsBody;

      // Sync position from physics body before force application for
      // rotation calc. z is fully dynamic: gravity always pulls down
      // and the terrain spring only pushes while the locomotion ground
      // point is at/below terrain.
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;

      if (entity.buildable && !entity.buildable.isComplete) {
        if (setUnitMovementAcceleration(entity.unit, 0, 0, 0)) {
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_MOVEMENT_ACCEL);
        }
        if (entity.combat) {
          entity.combat.priorityTargetId = undefined;
          entity.combat.priorityTargetPoint = undefined;
        }
        continue;
      }

      // Action-system thrust target — a HORIZONTAL desired direction.
      // Locomotion owns propulsion: driveForce is the authored motor
      // strength and traction is how much of that force couples into
      // the ground. Sloped terrain projects the direction onto the
      // local surface tangent below so units climb / descend along the
      // actual ground instead of trying to push straight through it.
      // velocityX/Y/Z is authoritative physics, not touched here.
      const dirX = entity.unit.thrustDirX ?? 0;
      const dirY = entity.unit.thrustDirY ?? 0;
      const dirLenSq = dirX * dirX + dirY * dirY;
      const hasThrustDir = dirLenSq > 0.0001;
      const jumpIntent = this.getJumpIntent(entity.unit, entity.combat, hasThrustDir);

      // Sleeping units that aren't being asked to thrust, react to a
      // force, or run a leg actuator short-circuit before the heavier
      // per-body work. `hasForce` is a single Map.has (no allocation)
      // where `getFinalForce` would build a scratch tuple.
      const hasJumpActuatorWork = this.hasJumpActuatorWork(entity.unit, jumpIntent);
      if (body.sleeping && !hasThrustDir && !forceAccumulator.hasForce(entity.id) && !hasJumpActuatorWork) {
        continue;
      }

      const groundContact = this.hasUnitGroundContact(entity.unit, body);
      const jumpStateChanged = this.applyJumpActuator(
        entity.unit,
        body,
        groundContact || this.physics.hasUpwardSurfaceContact(body),
        dtSec,
        jumpIntent,
      );
      if (jumpStateChanged) {
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_JUMP);
      }

      const externalForce = forceAccumulator.getFinalForce(entity.id);
      const externalFx = (externalForce?.fx ?? 0) / 3600;
      const externalFy = (externalForce?.fy ?? 0) / 3600;
      const externalFz = (externalForce?.fz ?? 0) / 3600;

      // Unit faces its movement direction (yaw only — chassis tilt
      // is a render concern; sim transform.rotation stays a 2D yaw).
      // Hover units skip this snap; their orientation is driven by
      // the quaternion spring in the hover branch below so yaw,
      // pitch, and roll all evolve together as a damped continuous
      // motion.
      if (hasThrustDir && entity.unit.locomotion.type !== 'hover') {
        const nextRotation = Math.atan2(dirY, dirX);
        if (nextRotation !== entity.transform.rotation) {
          entity.transform.rotation = nextRotation;
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ROT);
        }
      }

      let thrustForceX = 0;
      let thrustForceY = 0;
      let thrustForceZ = 0;

      // Hover locomotion (drones, gunships). No ground contact, no
      // slope projection. Lift force is inversely proportional to the
      // distance from the ground directly below the unit:
      //
      //   F_up = K / altitude,  K = m · g · hoverHeight
      //
      // The equilibrium altitude (where F_up = m·g) is exactly
      // hoverHeight. Below it the lift grows large and pushes the
      // unit up; above it the lift drops and gravity pulls it back.
      // A near-zero floor on altitude keeps the force finite when the
      // unit clips into terrain during a violent push.
      //
      // Horizontal thrust is applied directly (no slope tangent) —
      // hovers fly over arbitrary terrain at constant altitude.
      if (entity.unit.locomotion.type === 'hover') {
        const groundZ = this.world.getGroundZ(body.x, body.y);
        const altitude = Math.max(body.z - groundZ, 0.5);
        const hoverHeight = entity.unit.locomotion.hoverHeight ?? altitude;
        // F_up = K / altitude  −  c · vz
        // K   = m · g · hoverHeight   (raw force)
        // c   = 2 · m · √(g / hoverHeight)  ≈ critical damping for the
        //   linearized oscillator near equilibrium. Without this the
        //   pure inverse-distance lift is an undamped harmonic
        //   oscillator at ω = √(g / hoverHeight) — a ~3-second period
        //   at hoverHeight=120, which feels like the drone is bouncing.
        //   Critical damping settles within ~1 period instead of
        //   relying on the slow global air-friction multiplier.
        //
        // applyForce below multiplies thrustForceZ by 1e6 (Matter.js
        // ms² → sec² conversion) and then divides by mass internally,
        // so we pre-divide by 1e6 here to land at the intended raw
        // force. The other thrust pieces in this branch reuse the
        // existing ground-locomotion forceMagnitude convention
        // (MATTER_FORCE_SCALE = 150000) because they're authored as
        // Matter.js drive forces; lift + damping are clean Newtonian
        // formulas and bypass that scale.
        const mass = entity.unit.mass;
        const liftK = mass * GRAVITY * hoverHeight;
        const vzDampPerMass = 2 * Math.sqrt(GRAVITY / hoverHeight);
        thrustForceZ = (liftK / altitude - mass * vzDampPerMass * body.vz) / 1e6;

        if (hasThrustDir) {
          const invDirMag = 1 / Math.sqrt(dirLenSq);
          const useDirX = dirX * invDirMag;
          const useDirY = dirY * invDirMag;
          const locomotionForce = getLocomotionForceProfile(
            entity.unit.locomotion,
            entity.unit.mass,
            this.world.thrustMultiplier,
            MATTER_FORCE_SCALE,
          );
          thrustForceX = useDirX * locomotionForce.tractionForceMagnitude;
          thrustForceY = useDirY * locomotionForce.tractionForceMagnitude;
        }

        // Quaternion orientation spring. Target yaw points along the
        // current thrust direction (or holds the current heading if
        // idle); target pitch and roll are derived from body-frame
        // velocity components so the drone visibly leans forward
        // when accelerating and banks INTO the turn when its
        // velocity has a sideways component (the classic aircraft
        // bank). The damped spring on the unit-quaternion advances
        // all three axes through ONE law — α = k · (axis·angle) −
        // c · ω — with no preferred axis or gimbal lock.
        //
        // Defer the actual spring step into a batched WASM call
        // that runs after the per-entity loop (Phase 4+3e). JS-side
        // here we just compute the target yaw/pitch/roll (cheap
        // scalars, depend on body-frame velocity which is per-entity)
        // and push the buffer entry; alpha + new orientation come
        // back from the kernel below.
        const orientation = entity.unit.orientation;
        const omega = entity.unit.angularVelocity3;
        if (orientation && omega) {
          const currentYaw = quatYaw(orientation);
          const targetYaw = hasThrustDir
            ? Math.atan2(dirY, dirX)
            : currentYaw;
          const cosY = Math.cos(currentYaw);
          const sinY = Math.sin(currentYaw);
          const vForward = body.vx * cosY + body.vy * sinY;
          const vLateral = -body.vx * sinY + body.vy * cosY;
          let targetPitch = -HOVER_PITCH_PER_FORWARD_V * vForward;
          let targetRoll = HOVER_BANK_PER_LATERAL_V * vLateral;
          if (targetPitch > HOVER_PITCH_MAX) targetPitch = HOVER_PITCH_MAX;
          else if (targetPitch < -HOVER_PITCH_MAX) targetPitch = -HOVER_PITCH_MAX;
          if (targetRoll > HOVER_BANK_MAX) targetRoll = HOVER_BANK_MAX;
          else if (targetRoll < -HOVER_BANK_MAX) targetRoll = -HOVER_BANK_MAX;
          const requiredLen = (_hoverDeferCount + 1) * QUAT_HOVER_BATCH_STRIDE;
          if (_hoverDeferBuf.length < requiredLen) {
            const grown = new Float64Array(
              Math.max(requiredLen, _hoverDeferBuf.length * 2, 256),
            );
            grown.set(_hoverDeferBuf);
            _hoverDeferBuf = grown;
          }
          const base = _hoverDeferCount * QUAT_HOVER_BATCH_STRIDE;
          _hoverDeferBuf[base + 0] = orientation.x;
          _hoverDeferBuf[base + 1] = orientation.y;
          _hoverDeferBuf[base + 2] = orientation.z;
          _hoverDeferBuf[base + 3] = orientation.w;
          _hoverDeferBuf[base + 4] = omega.x;
          _hoverDeferBuf[base + 5] = omega.y;
          _hoverDeferBuf[base + 6] = omega.z;
          _hoverDeferBuf[base + 7] = targetYaw;
          _hoverDeferBuf[base + 8] = targetPitch;
          _hoverDeferBuf[base + 9] = targetRoll;
          _hoverDeferEntities[_hoverDeferCount] = entity;
          _hoverDeferCount++;
        }

        // Fall through to the shared totalForce / applyForce block
        // below; skip the ground-locomotion branch entirely.
        const totalForceX = thrustForceX + externalFx;
        const totalForceY = thrustForceY + externalFy;
        const totalForceZ = thrustForceZ + externalFz;
        if (
          !Number.isFinite(totalForceX) ||
          !Number.isFinite(totalForceY) ||
          !Number.isFinite(totalForceZ)
        ) {
          continue;
        }
        const movementAccelScale = body.mass > 0 ? 1e6 / body.mass : 0;
        if (setUnitMovementAcceleration(
          entity.unit,
          thrustForceX * movementAccelScale,
          thrustForceY * movementAccelScale,
          thrustForceZ * movementAccelScale,
        )) {
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_MOVEMENT_ACCEL);
        }
        this.physics.applyForce(body, totalForceX * 1e6, totalForceY * 1e6, totalForceZ * 1e6);
        continue;
      }

      // Water as a WALL.
      //
      // Two-pronged behaviour, both built on `isWaterAt` against the
      // local heightmap (no clamp, no surface, just "is this position
      // submerged?"):
      //
      //   1. THRUST GATE on dry land: when the action system wants
      //      to push the body in a direction that would step into
      //      water, decompose the thrust into the local outward
      //      component (toward dry land) and the parallel component
      //      (along the shore). Zero the inward component, keep the
      //      parallel. The unit slides along the shore and physically
      //      cannot push past the boundary — exactly the behaviour
      //      you want from a wall.
      //
      //   2. ESCAPE FORCE in water: when the body has somehow ended
      //      up over water anyway (knockback impulse, spawn edge
      //      case, sub-tick collision push), apply a strong outward
      //      force so they're expelled within a couple of frames.
      //      3× the unit's normal thrust magnitude — water is a
      //      WALL, not a friendly current.
      //
      // The body's tilt (`getSurfaceNormal`) is already land-only
      // by construction (Terrain.ts excludes wet samples from the
      // gradient), so the chassis never inherits the water plane's
      // flat normal. Combined with the wall-push, water has no
      // "solid" aspect: nothing rests on it, units never tilt to
      // its surface, and they bounce off the boundary like it's a
      // building wall.
      if (groundContact) {
        const locomotionForce = getLocomotionForceProfile(
          entity.unit.locomotion,
          entity.unit.mass,
          this.world.thrustMultiplier,
          MATTER_FORCE_SCALE,
        );
        const radius = body.radius || 10;
        const inWater = isWaterAt(body.x, body.y, mw, mh);

        if (inWater) {
          // ESCAPE FORCE — push toward dry land. Try expanding probe
          // radii so even a unit teleported deep into a valley gets a
          // valid outward direction.
          let hasOutDir = false;
          for (let i = 0; i < WATER_ESCAPE_PROBE_MULTS.length; i++) {
            hasOutDir = this.probeWaterOutward(
              body.x, body.y,
              radius * WATER_ESCAPE_PROBE_MULTS[i],
              mw,
              mh,
            );
            if (hasOutDir) break;
          }
          if (hasOutDir) {
            // 3× normal thrust strength — feels like a hard wall pushing
            // the unit out, not a gentle current.
            const wallPush = 3 * locomotionForce.rawForceMagnitude;
            thrustForceX = this._waterOutX * wallPush;
            thrustForceY = this._waterOutY * wallPush;
            // No z thrust — water surface is flat, no slope to climb out of.
          }
        } else if (hasThrustDir) {
          const invDirMag = 1 / Math.sqrt(dirLenSq);
          let useDirX = dirX * invDirMag;
          let useDirY = dirY * invDirMag;

          // THRUST GATE — if a body-radius step ahead would put the
          // body in water, project the thrust onto the local "along
          // the shore" direction. The inward component (into water)
          // gets zeroed; the parallel component (sliding along the
          // boundary) is preserved.
          const probe = radius + 5;
          const aheadX = body.x + useDirX * probe;
          const aheadY = body.y + useDirY * probe;
          if (isWaterAt(aheadX, aheadY, mw, mh)) {
            if (this.probeWaterOutward(aheadX, aheadY, radius, mw, mh)) {
              // Decompose useDir against outward direction.
              // dotOut > 0 ⇒ thrust outward (away from water) — fine.
              // dotOut < 0 ⇒ thrust has inward component — remove it.
              const dotOut = useDirX * this._waterOutX + useDirY * this._waterOutY;
              if (dotOut < 0) {
                useDirX -= dotOut * this._waterOutX;
                useDirY -= dotOut * this._waterOutY;
                const m = magnitude(useDirX, useDirY);
                if (m > 1e-3) {
                  useDirX /= m;
                  useDirY /= m;
                } else {
                  // Thrust was purely inward — nothing parallel to the
                  // shore left. Unit stops at the wall.
                  useDirX = 0;
                  useDirY = 0;
                }
              }
            }
          }

          if (useDirX !== 0 || useDirY !== 0) {
            const thrustMagnitude = locomotionForce.tractionForceMagnitude;
            // Project horizontal thrust onto the slope tangent so
            // hill-climbing produces the right z-aware force. Slope
            // normal is land-only (Terrain.getSurfaceNormal excludes
            // wet samples), so this never inherits the water plane's
            // tilt.
            const n = this.world.getCachedSurfaceNormal(body.x, body.y);
            const t = projectHorizontalOntoSlope(useDirX, useDirY, n);
            thrustForceX = t.x * thrustMagnitude;
            thrustForceY = t.y * thrustMagnitude;
            thrustForceZ = t.z * thrustMagnitude;
          }
        } else {
          const n = this.world.getCachedSurfaceNormal(body.x, body.y);
          if (this.computeIdleBrakeForce(body, n, locomotionForce, dtSec)) {
            thrustForceX = this._idleBrakeForceX;
            thrustForceY = this._idleBrakeForceY;
            thrustForceZ = this._idleBrakeForceZ;
          }
        }
      }

      const totalForceX = thrustForceX + externalFx;
      const totalForceY = thrustForceY + externalFy;
      const totalForceZ = thrustForceZ + externalFz;

      if (
        !Number.isFinite(totalForceX) ||
        !Number.isFinite(totalForceY) ||
        !Number.isFinite(totalForceZ)
      ) {
        continue;
      }
      // Ship only the persistent movement/traction acceleration for
      // client prediction. Jump, gravity, terrain spring, damping, and
      // transient external forces are handled through their own paths.
      const movementAccelScale = body.mass > 0 ? 1e6 / body.mass : 0;
      if (setUnitMovementAcceleration(
        entity.unit,
        thrustForceX * movementAccelScale,
        thrustForceY * movementAccelScale,
        thrustForceZ * movementAccelScale,
      )) {
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_MOVEMENT_ACCEL);
      }
      if (totalForceX === 0 && totalForceY === 0 && totalForceZ === 0) {
        continue;
      }

      // Matter.js Verlet integration uses (F/m) * deltaTimeMs², our Euler engine uses (F/m) * dtSec.
      // Conversion: (ms)² / (sec)² = 1000² = 1e6. With friction-first ordering this is exact.
      // The Z thrust component lifts the unit along the slope when
      // climbing; gravity continues to pull through the integrator
      // and the ground-contact resolver clamps to the surface, so the
      // unit settles onto the rendered tile triangle each tick.
      this.physics.applyForce(body, totalForceX * 1e6, totalForceY * 1e6, totalForceZ * 1e6);
    }

    // Phase 4 + 3e — flush the hover orientation batch. One WASM
    // call processes every hover entity that pushed an entry above;
    // the kernel runs quat_from_yaw_pitch_roll → spring step →
    // integrate → renormalize → quat_yaw extraction internally and
    // writes back orientation/omega/alpha/yaw. Scatter the results
    // back to entity.unit.* and entity.transform.rotation.
    if (_hoverDeferCount > 0) {
      const sim = getSimWasm()!;
      const view = _hoverDeferBuf.subarray(0, _hoverDeferCount * QUAT_HOVER_BATCH_STRIDE);
      sim.quatHoverOrientationStepBatch(
        view,
        _hoverDeferCount,
        HOVER_ORIENTATION_K,
        HOVER_ORIENTATION_C,
        dtSec,
      );
      for (let i = 0; i < _hoverDeferCount; i++) {
        const entity = _hoverDeferEntities[i];
        const orientation = entity.unit?.orientation;
        const omega = entity.unit?.angularVelocity3;
        if (!orientation || !omega) {
          _hoverDeferEntities[i] = undefined as unknown as Entity;
          continue;
        }
        const base = i * QUAT_HOVER_BATCH_STRIDE;
        orientation.x = _hoverDeferBuf[base + 0];
        orientation.y = _hoverDeferBuf[base + 1];
        orientation.z = _hoverDeferBuf[base + 2];
        orientation.w = _hoverDeferBuf[base + 3];
        omega.x = _hoverDeferBuf[base + 4];
        omega.y = _hoverDeferBuf[base + 5];
        omega.z = _hoverDeferBuf[base + 6];
        const angularAccel = entity.unit?.angularAcceleration3;
        if (angularAccel) {
          angularAccel.x = _hoverDeferBuf[base + 10];
          angularAccel.y = _hoverDeferBuf[base + 11];
          angularAccel.z = _hoverDeferBuf[base + 12];
        }
        // Sync transform.rotation to the kernel's yaw extraction so
        // every existing consumer of the 2D yaw scalar (turret mounts,
        // camera, AI, network code) stays correct.
        const newYaw = _hoverDeferBuf[base + 13];
        if (newYaw !== entity.transform.rotation) {
          entity.transform.rotation = newYaw;
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ROT);
        }
        _hoverDeferEntities[i] = undefined as unknown as Entity;
      }
      _hoverDeferCount = 0;
    }
  }

  private collectPhysicsForceUnitIds(): void {
    this.refreshJumpActuatorUnitIds();
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

    const jumpIds = this.jumpActuatorUnitIds;
    for (let i = 0; i < jumpIds.length; i++) {
      const entity = this.world.getEntity(jumpIds[i]);
      if (!entity?.unit || !entity.body?.physicsBody) continue;
      if (entity.buildable && !entity.buildable.isComplete) continue;
      if (this.hasJumpActuatorWork(
        entity.unit,
        this.getJumpIntent(entity.unit, entity.combat),
      )) {
        pushId(entity.id);
      }
    }
  }

  private refreshJumpActuatorUnitIds(): void {
    const version = this.world.getUnitSetVersion();
    if (version === this.jumpActuatorUnitSetVersion) return;
    this.jumpActuatorUnitSetVersion = version;

    const ids = this.jumpActuatorUnitIds;
    ids.length = 0;
    const units = this.world.getUnits();
    for (let i = 0; i < units.length; i++) {
      const unit = units[i].unit;
      if (!unit || getUnitJumpSpringEnergy(unit) <= 0) continue;
      ids.push(units[i].id);
    }
  }

  private getJumpIntent(
    unit: Unit,
    combat: CombatComponent | undefined,
    knownHasThrustDir?: boolean,
  ): UnitJumpIntent {
    const moving = knownHasThrustDir ?? this.unitHasThrustDir(unit);
    return {
      moving,
      combat: this.hasCombatJumpIntent(combat),
    };
  }

  private unitHasThrustDir(unit: Unit): boolean {
    const dirX = unit.thrustDirX ?? 0;
    const dirY = unit.thrustDirY ?? 0;
    return dirX * dirX + dirY * dirY > 0.0001;
  }

  private hasCombatJumpIntent(combat: CombatComponent | undefined): boolean {
    return !!combat && (
      combat.priorityTargetId !== undefined ||
      combat.priorityTargetPoint !== undefined ||
      combat.hasActiveCombat ||
      combat.activeTurretMask !== 0 ||
      combat.firingTurretMask !== 0
    );
  }

  private hasJumpActuatorWork(unit: Unit, intent: UnitJumpIntent): boolean {
    return unitJumpHasActuatorWork(unit, intent);
  }

  private hasUnitGroundContact(unit: Unit, body: Body3D): boolean {
    return isUnitGroundPointAtOrBelowTerrain(
      unit,
      body.z,
      this.world.getGroundZ(body.x, body.y),
    );
  }

  private applyJumpActuator(
    unit: Unit,
    body: Body3D,
    surfaceContact: boolean,
    dtSec: number,
    intent: UnitJumpIntent,
  ): boolean {
    const jump = unit.jump;
    if (!jump) return false;

    const beforeRequested = jump.requested;
    const beforeActive = jump.active;
    const beforeLaunchSeq = jump.launchSeq;

    const wantsJump = unitJumpWantsActuator(unit, intent);
    const releaseJump = unitJumpCanRelease(unit, surfaceContact, body.vz, intent);
    jump.requested = false;

    if (!surfaceContact || !wantsJump) {
      jump.active = false;
      return (
        jump.requested !== beforeRequested ||
        jump.active !== beforeActive
      );
    }
    if (!releaseJump) {
      return jump.requested !== beforeRequested;
    }

    const jumpForce = sampleUnitJumpLaunchForce(unit, dtSec, this._jumpLaunchForce);
    if (jumpForce.z <= 0) {
      jump.active = false;
      return (
        jump.requested !== beforeRequested ||
        jump.active !== beforeActive
      );
    }

    if (!canJumpLandAwayFromWater(body, {
      dtSec,
      launchForce: jumpForce.z,
      launchForceX: jumpForce.x,
      launchForceY: jumpForce.y,
      mapWidth: this.world.mapWidth,
      mapHeight: this.world.mapHeight,
      getGroundZ: (x, y) => this.world.getGroundZ(x, y),
    })) {
      jump.active = false;
      return (
        jump.requested !== beforeRequested ||
        jump.active !== beforeActive
      );
    }

    this.physics.applyForce(body, jumpForce.x, jumpForce.y, jumpForce.z, {
      canLaunchFromGround: true,
    });
    jump.launchSeq++;
    jump.active = true;
    return (
      jump.requested !== beforeRequested ||
      jump.active !== beforeActive ||
      jump.launchSeq !== beforeLaunchSeq
    );
  }

  private computeIdleBrakeForce(
    body: Body3D,
    normal: { nx: number; ny: number; nz: number },
    locomotionForce: LocomotionForceProfile,
    dtSec: number,
  ): boolean {
    this._idleBrakeForceX = 0;
    this._idleBrakeForceY = 0;
    this._idleBrakeForceZ = 0;

    const maxForce = locomotionForce.tractionForceMagnitude;
    if (dtSec <= 0 || maxForce <= 0 || body.mass <= 0) return false;

    // When the action system is not asking this unit to move, use the
    // same locomotion traction as a contact brake: cancel gravity's
    // downhill tangent component and bleed current tangent velocity
    // toward zero, capped by the unit's available grip.
    const vDotN = body.vx * normal.nx + body.vy * normal.ny + body.vz * normal.nz;
    const tangentVx = body.vx - vDotN * normal.nx;
    const tangentVy = body.vy - vDotN * normal.ny;
    const tangentVz = body.vz - vDotN * normal.nz;

    const slopeGravityX = GRAVITY * normal.nz * normal.nx;
    const slopeGravityY = GRAVITY * normal.nz * normal.ny;
    const slopeGravityZ = -GRAVITY + GRAVITY * normal.nz * normal.nz;

    const desiredAx = -slopeGravityX - tangentVx / dtSec;
    const desiredAy = -slopeGravityY - tangentVy / dtSec;
    const desiredAz = -slopeGravityZ - tangentVz / dtSec;
    const desiredAccelMag = magnitude3(desiredAx, desiredAy, desiredAz);
    if (desiredAccelMag <= 1e-6) return false;

    const desiredForce = (desiredAccelMag * body.mass) / 1e6;
    const scale = desiredForce > maxForce ? maxForce / desiredForce : 1;
    const forceScale = (body.mass / 1e6) * scale;
    this._idleBrakeForceX = desiredAx * forceScale;
    this._idleBrakeForceY = desiredAy * forceScale;
    this._idleBrakeForceZ = desiredAz * forceScale;
    return true;
  }

  private waterOutCacheKey(x: number, y: number, probeR: number): number {
    const cx = Math.floor(x / WATER_OUT_CACHE_CELL_SIZE) + 32768;
    const cy = Math.floor(y / WATER_OUT_CACHE_CELL_SIZE) + 32768;
    const rb = Math.max(0, Math.min(255, Math.round(probeR / WATER_OUT_CACHE_BUCKET_SCALE)));
    return cx * 0x1000000 + cy * 0x100 + rb;
  }

  // Compute "outward from water" direction at (x, y). Samples 8
  // fixed directions at probeR and stores the normalized dry-sample
  // average into _waterOutX/Y. Returns false if every sample is wet.
  private probeWaterOutward(
    x: number,
    y: number,
    probeR: number,
    mapWidth: number,
    mapHeight: number,
  ): boolean {
    // Cache invariants: tied to terrain shape AND map dims AND a soft
    // size cap. Drop on any of those changing so a long match (terrain
    // edits, generator-driven flat zones, hour-long sessions probing
    // new shorelines) can't grow the map indefinitely.
    const tv = getTerrainVersion();
    if (tv !== this.waterOutCacheTerrainVersion || this.waterOutCache.size >= WATER_OUT_CACHE_MAX_ENTRIES) {
      this.waterOutCache.clear();
      this.waterOutCacheTerrainVersion = tv;
    }
    const key = this.waterOutCacheKey(x, y, probeR);
    const cached = this.waterOutCache.get(key);
    if (cached) {
      this._waterOutX = cached.x;
      this._waterOutY = cached.y;
      return cached.ok;
    }

    let ox = 0;
    let oy = 0;
    for (let i = 0; i < WATER_PROBE_DX.length; i++) {
      const dx = WATER_PROBE_DX[i];
      const dy = WATER_PROBE_DY[i];
      if (!isWaterAt(x + dx * probeR, y + dy * probeR, mapWidth, mapHeight)) {
        ox += dx;
        oy += dy;
      }
    }
    const m = magnitude(ox, oy);
    if (m <= 0) {
      this._waterOutX = 0;
      this._waterOutY = 0;
      this.waterOutCache.set(key, { ok: false, x: 0, y: 0 });
      return false;
    }
    this._waterOutX = ox / m;
    this._waterOutY = oy / m;
    this.waterOutCache.set(key, { ok: true, x: this._waterOutX, y: this._waterOutY });
    return true;
  }
}
