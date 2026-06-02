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
import {
  LOCOMOTION_FORCE_SCALE,
  type LocomotionForceProfile,
  writeLocomotionForceProfile,
} from '../sim/locomotion';
import { isUnitGroundPointAtOrBelowTerrain } from '../sim/unitGroundPhysics';
import {
  ENTITY_CHANGED_ROT,
} from '../../types/network';
import type { Simulation } from '../sim/Simulation';
import type { WorldState } from '../sim/WorldState';
import type { Entity, EntityId, Unit } from '../sim/types';
import type { Body3D, PhysicsEngine3D } from './PhysicsEngine3D';
import { setUnitMovementAcceleration } from '../sim/unitMovementAcceleration';
import { quatYaw } from '../math/Quaternion';
import { getSimWasm, QUAT_HOVER_BATCH_STRIDE } from '../sim-wasm/init';
import { isBuildBlockingActivation } from '../sim/buildableHelpers';

const WATER_PROBE_DX = [
  1, 0.7071067811865476, 0, -0.7071067811865475,
  -1, -0.7071067811865477, 0, 0.7071067811865474,
];
const WATER_PROBE_DY = [
  0, 0.7071067811865475, 1, 0.7071067811865476,
  0, -0.7071067811865475, -1, -0.7071067811865477,
];
const WATER_ESCAPE_PROBE_MULTS = [1.5, 3, 6];
// Phase 4 + 3e — deferred batch buffer for the hover orientation
// quaternion spring. UnitForceSystem.applyForces gathers per-hover
// (orientation, omega, target yaw/pitch/roll) into this buffer
// during the per-entity loop, then runs ONE WASM call after the
// loop to advance every hover entity's orientation in place.
let _hoverDeferBuf: Float64Array = new Float64Array(0);
let _hoverDeferEntities: Entity[] = [];
let _hoverDeferCount = 0;

// Hover orientation spring stiffness. With targetPitch/targetRoll
// pinned to zero, this is effectively a yaw-only spring that gives
// hover/flying chassis rotational momentum on heading changes.
// Banking is composed by the renderer per frame — see the
// "Airborne Banking Is Visual" section of design_philosophy.html.
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

export class UnitForceSystem {
  private readonly world: WorldState;
  private readonly simulation: Simulation;
  private readonly physics: PhysicsEngine3D;

  private readonly physicsForceUnitIdsBuf: EntityId[] = [];
  private readonly physicsCandidateUnitIdsBuf: EntityId[] = [];
  private readonly physicsActiveUnitIds = new Set<EntityId>();
  private _idleBrakeForceX = 0;
  private _idleBrakeForceY = 0;
  private _idleBrakeForceZ = 0;
  private _waterOutX = 0;
  private _waterOutY = 0;
  private readonly locomotionForceProfile: LocomotionForceProfile = {
    rawDriveForce: 0,
    tractionDriveForce: 0,
    rawForceMagnitude: 0,
    tractionForceMagnitude: 0,
  };
  private waterOutCache = new Map<number, WaterOutCacheEntry>();
  private waterOutCacheTerrainVersion = -1;

  constructor(world: WorldState, simulation: Simulation, physics: PhysicsEngine3D) {
    this.world = world;
    this.simulation = simulation;
    this.physics = physics;
  }

  // Apply thrust and external forces to physics bodies
  applyForces(dtSec: number): void {
    // Defensive: refresh BodyPool views in case WASM memory grew
    // since the last tick. See PhysicsEngine3D.step() for the
    // detached-view crash this guards against.
    getSimWasm()!.pool.refreshViews();
    const forceAccumulator = this.simulation.getForceAccumulator();
    const mw = this.world.mapWidth;
    const mh = this.world.mapHeight;

    this.collectPhysicsForceUnitIds();
    const activeIds = this.physicsForceUnitIdsBuf;
    for (let i = 0; i < activeIds.length; i++) {
      const entity = this.world.getEntity(activeIds[i]);
      if (entity === undefined || entity.body === null || entity.unit === null) continue;

      const body = entity.body.physicsBody;

      // Sync position from physics body before force application for
      // rotation calc. z is fully dynamic: gravity always pulls down
      // and the terrain spring only pushes while the locomotion ground
      // point is at/below terrain.
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;

      if (
        isBuildBlockingActivation(entity.buildable) ||
        entity.unit.hp <= 0
      ) {
        // Acceleration is no longer shipped on the wire — only update
        // the sim-side value; no markSnapshotDirty needed.
        setUnitMovementAcceleration(entity.unit, 0, 0, 0);
        if (entity.combat) {
          entity.combat.priorityTargetId = null;
          entity.combat.priorityTargetPoint = null;
        }
        continue;
      }

      // Action-system thrust target — a HORIZONTAL desired acceleration
      // vector. Direction aims the drive force; magnitude scales how much
      // of the authored force profile is used this tick.
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
      const thrustInputMag = hasThrustDir ? Math.sqrt(dirLenSq) : 0;
      const thrustScale = Math.min(1, thrustInputMag);
      const locomotionType = entity.unit.locomotion.type;
      const isFlying = locomotionType === 'flying';
      const isAirborne = locomotionType === 'hover' || locomotionType === 'flying';

      // Sleeping units that aren't being asked to thrust or react to a
      // force short-circuit before the heavier per-body work. `hasForce`
      // is a single Map.has (no allocation) where `getFinalForce` would
      // build a scratch tuple.
      if (
        body.sleeping &&
        !isFlying &&
        !hasThrustDir &&
        !forceAccumulator.hasForce(entity.id)
      ) {
        continue;
      }

      const groundContact = this.hasUnitGroundContact(entity.unit, body);

      const externalForce = forceAccumulator.getFinalForce(entity.id);
      const externalFx = externalForce === null ? 0 : externalForce.fx / 3600;
      const externalFy = externalForce === null ? 0 : externalForce.fy / 3600;
      const externalFz = externalForce === null ? 0 : externalForce.fz / 3600;

      // Unit faces its movement direction (yaw only — chassis tilt
      // is a render concern; sim transform.rotation stays a 2D yaw).
      // Hover/flying units skip this snap; their yaw is driven by
      // the orientation spring in the hover branch below so heading
      // changes carry rotational momentum. Pitch and roll are pinned
      // to zero in the sim — banking lives in the renderer.
      if (hasThrustDir && !isAirborne) {
        const nextRotation = Math.atan2(dirY, dirX);
        if (nextRotation !== entity.transform.rotation) {
          entity.transform.rotation = nextRotation;
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ROT);
        }
      }

      let thrustForceX = 0;
      let thrustForceY = 0;
      let thrustForceZ = 0;

      // Airborne locomotion (hovercraft and flying units). No ground
      // contact, no slope projection. Lift has two upward force terms:
      // a constant counter-gravity ratio that applies at every altitude,
      // and an inverse-distance ground-effect force that grows near
      // terrain:
      //
      //   F_up = m · g · r + K / altitude
      //   K    = m · g · hoverHeightUpwardForce
      //
      // The equilibrium altitude (where F_up = m·g) is:
      //   hoverHeightUpwardForce / (1 - r)
      //
      // Below it the ground-effect lift grows large and pushes the
      // unit up; above it the constant counter-gravity term keeps
      // reducing fall speed even when terrain is far away.
      // A near-zero floor on altitude keeps the force finite when the
      // unit clips into terrain during a violent push.
      //
      // Horizontal thrust is applied directly (no slope tangent) —
      // airborne units fly over arbitrary terrain at constant altitude.
      if (isAirborne) {
        let airDriveDirX = 0;
        let airDriveDirY = 0;
        let airHasDriveDir = false;
        const airThrustScale = isFlying ? 1 : thrustScale;
        if (hasThrustDir) {
          const invDirMag = 1 / thrustInputMag;
          airDriveDirX = dirX * invDirMag;
          airDriveDirY = dirY * invDirMag;
          airHasDriveDir = true;
        } else if (isFlying) {
          airDriveDirX = Math.cos(entity.transform.rotation);
          airDriveDirY = Math.sin(entity.transform.rotation);
          airHasDriveDir = true;
        }

        const groundZ = this.world.getGroundZ(body.x, body.y);
        const altitude = Math.max(body.z - groundZ, 0.5);
        const gravityCounterUpwardForceRatio =
          entity.unit.locomotion.gravityCounterUpwardForceRatio ?? 0;
        const gravityDeficitRatio = 1 - gravityCounterUpwardForceRatio;
        const baseHoverHeightUpwardForce =
          entity.unit.locomotion.hoverHeightUpwardForce ?? altitude * gravityDeficitRatio;
        // Per-tick uniform jitter on the ground-effect coefficient so
        // hover/flying units bob slightly instead of holding a perfectly
        // fixed altitude. Sampled from the deterministic sim RNG so
        // replays stay reproducible. With amount=a the multiplier is in
        // [1-a, 1+a]; amount must be < 1 to keep the coefficient positive.
        const randAmount =
          entity.unit.locomotion.hoverHeightUpwardForceRandomizationAmount ?? 0;
        const rawHoverHeightUpwardForce = randAmount > 0
          ? baseHoverHeightUpwardForce * (1 + (this.world.rng.next() * 2 - 1) * randAmount)
          : baseHoverHeightUpwardForce;
        // EMA-smooth the per-tick (jittered) ground-effect coefficient
        // so the lift target drifts instead of teleporting each tick.
        // With weight α ∈ [0,1):
        //   smoothed = α·prev + (1−α)·raw
        // α = 0 (or undefined) skips smoothing and uses the raw sample
        // directly. The first tick seeds the accumulator from the raw
        // sample so there's no settling transient on spawn.
        const emaWeight = entity.unit.locomotion.hoverHeightUpwardForceEMA ?? 0;
        let hoverHeightUpwardForce: number;
        if (emaWeight > 0) {
          const prev = entity.unit.hoverHeightUpwardForceSmoothed;
          hoverHeightUpwardForce = prev === null
            ? rawHoverHeightUpwardForce
            : emaWeight * prev + (1 - emaWeight) * rawHoverHeightUpwardForce;
          entity.unit.hoverHeightUpwardForceSmoothed = hoverHeightUpwardForce;
        } else {
          hoverHeightUpwardForce = rawHoverHeightUpwardForce;
          entity.unit.hoverHeightUpwardForceSmoothed = null;
        }
        // F_up = m·g·r + K / altitude − c · vz
        // K    = m · g · hoverHeightUpwardForce
        // c    = 2 · m · √(g · (1 - r) / stableAltitude)
        //
        // The damping term is critical damping for the linearized
        // oscillator near the current equilibrium. When r=0 it reduces
        // to the previous pure inverse-distance damping term:
        //   2 · m · √(g / hoverHeightUpwardForce)
        //
        // applyForce below multiplies thrustForceZ by 1e6 (Matter.js
        // ms² → sec² conversion) and then divides by mass internally,
        // so we pre-divide by 1e6 here to land at the intended raw
        // force. The other thrust pieces in this branch reuse the
        // existing ground-locomotion forceMagnitude convention
        // (MATTER_FORCE_SCALE = 150000) because they're authored as
        // Matter.js drive forces; lift + damping are clean Newtonian
        // formulas and bypass that scale.
        // Use the actual dynamic-body mass. Body3D stores blueprint
        // mass after UNIT_MASS_MULTIPLIER, and gravity is applied as
        // acceleration in the integrator, so hover lift must produce
        // body.mass * GRAVITY at equilibrium.
        const mass = body.mass;
        const stableAltitude = hoverHeightUpwardForce / gravityDeficitRatio;
        const counterGravityForce = mass * GRAVITY * gravityCounterUpwardForceRatio;
        const liftK = mass * GRAVITY * hoverHeightUpwardForce;
        const vzDampPerMass = 2 * Math.sqrt(
          (GRAVITY * gravityDeficitRatio) / stableAltitude,
        );
        thrustForceZ = (
          counterGravityForce +
          liftK / altitude -
          mass * vzDampPerMass * body.vz
        ) / 1e6;

        if (airHasDriveDir) {
          const locomotionForce = writeLocomotionForceProfile(
            this.locomotionForceProfile,
            entity.unit.locomotion,
            entity.unit.mass,
            this.world.thrustMultiplier,
            LOCOMOTION_FORCE_SCALE,
          );
          const thrustMagnitude = locomotionForce.tractionForceMagnitude * airThrustScale;
          thrustForceX = airDriveDirX * thrustMagnitude;
          thrustForceY = airDriveDirY * thrustMagnitude;
        }

        // Yaw-only orientation spring. Target yaw points along the
        // current thrust direction (or holds the current heading if
        // idle); target pitch and target roll are pinned to ZERO —
        // pitch/roll banking is a render-time concern, computed
        // locally from body velocity in the renderer. See the
        // "Airborne Banking Is Visual" section of
        // design_philosophy.html for why this lives outside the
        // sim, and the y=z=0 mount-axis invariant that keeps
        // turret-world-mount math agreeing with the rolled chassis.
        //
        // Defer the actual spring step into a batched WASM call
        // that runs after the per-entity loop (Phase 4+3e). JS-side
        // here we just compute the target yaw and push the buffer
        // entry; the resulting orientation is the yaw-only quat
        // (pitch=roll=0) with the spring's rotational momentum.
        const orientation = entity.unit.orientation;
        const omega = entity.unit.angularVelocity3;
        if (orientation && omega) {
          const currentYaw = quatYaw(orientation);
          const targetYaw = airHasDriveDir
            ? Math.atan2(airDriveDirY, airDriveDirX)
            : currentYaw;
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
          _hoverDeferBuf[base + 8] = 0;
          _hoverDeferBuf[base + 9] = 0;
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
        setUnitMovementAcceleration(
          entity.unit,
          thrustForceX * movementAccelScale,
          thrustForceY * movementAccelScale,
          thrustForceZ * movementAccelScale,
        );
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
        const locomotionForce = writeLocomotionForceProfile(
          this.locomotionForceProfile,
          entity.unit.locomotion,
          entity.unit.mass,
          this.world.thrustMultiplier,
          LOCOMOTION_FORCE_SCALE,
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
          const invDirMag = 1 / thrustInputMag;
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
            const thrustMagnitude = locomotionForce.tractionForceMagnitude * thrustScale;
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
      // Cache the persistent movement/traction acceleration on the sim
      // entity for force-system bookkeeping. The wire no longer carries
      // it (client predicts position from velocity only), so no
      // markSnapshotDirty here.
      const movementAccelScale = body.mass > 0 ? 1e6 / body.mass : 0;
      setUnitMovementAcceleration(
        entity.unit,
        thrustForceX * movementAccelScale,
        thrustForceY * movementAccelScale,
        thrustForceZ * movementAccelScale,
      );
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
        const unit = entity.unit;
        if (unit === null) {
          _hoverDeferEntities[i] = undefined as unknown as Entity;
          continue;
        }
        const orientation = unit.orientation;
        const omega = unit.angularVelocity3;
        if (orientation === null || omega === null) {
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
        const angularAccel = unit.angularAcceleration3;
        if (angularAccel !== null) {
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

  private hasUnitGroundContact(unit: Unit, body: Body3D): boolean {
    return isUnitGroundPointAtOrBelowTerrain(
      unit,
      body.z,
      this.world.getGroundZ(body.x, body.y),
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
