import type { WorkEmitterSpec, WorkStationAttachment } from '@/types/constructionTypes';
import type { Vec3 } from '@/types/vec2';
import { getTransformCosSin, normalizeAngle } from '../math/MathHelpers';
import { getTurretWorldMount } from '../math/MountGeometry';
import {
  resolveBotWeaponArmSocketPose,
  selectBotTorsoTurretIndex,
  shortestBotSocketAngleDelta,
  type BotArmSocketPose,
} from '../math/BotHostSocketGeometry';
import { getSimWasm } from '../sim-wasm/init';
import { getBuildingCombatCenterZ } from './buildingAnchors';
import { getUnitBlueprint } from './blueprints';
import { growScratchArray } from './scratchArrayGrowth';
import {
  getEntityBodyOrientation,
  updateAuthoritativeHostAttachmentKinematics,
} from './combat/combatUtils';
import { deterministicMath as DMath } from './deterministicMath';
import { isBuildInProgress } from './buildableHelpers';
import { resolveGuardServiceTarget } from './guard';
import { resolveReclaimTarget } from './reclaim';
import { getUnitGroundZ } from './unitGeometry';
import { NO_ENTITY_ID, type BuilderWorkStationRuntime, type Entity } from './types';
import type { WorldState } from './WorldState';
import { ENTITY_CHANGED_TURRETS } from '../../types/network';

type WorkTargetPose = { id: number; x: number; y: number; z: number };

const FLAT_NORMAL = { nx: 0, ny: 0, nz: 1 };
const _target: WorkTargetPose = { id: NO_ENTITY_ID, x: 0, y: 0, z: 0 };
const _socket: Vec3 = { x: 0, y: 0, z: 0 };
const _aimFrom: Vec3 = { x: 0, y: 0, z: 0 };
const ZERO_WORK_POINT: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
const _armPose: BotArmSocketPose = {
  elbowX: 0,
  elbowY: 0,
  elbowZ: 0,
  handX: 0,
  handY: 0,
  handZ: 0,
  aimX: 1,
  aimY: 0,
  aimZ: 0,
};

const _hosts: Entity[] = [];
const _stations: BuilderWorkStationRuntime[] = [];
const _emitters: WorkEmitterSpec[] = [];
let _parentYaw = new Float64Array(0);
let _targetWorldYaw = new Float64Array(0);
let _currentYaw = new Float64Array(0);
let _yawVelocity = new Float64Array(0);
let _targetYaw = new Float64Array(0);
let _yawContinuous = new Uint8Array(0);
let _yawMin = new Float64Array(0);
let _yawMax = new Float64Array(0);
let _yawMaxSpeed = new Float64Array(0);
let _yawMaxAcceleration = new Float64Array(0);
let _currentPitch = new Float64Array(0);
let _pitchVelocity = new Float64Array(0);
let _targetPitch = new Float64Array(0);
let _pitchMin = new Float64Array(0);
let _pitchMax = new Float64Array(0);
let _pitchMaxSpeed = new Float64Array(0);
let _pitchMaxAcceleration = new Float64Array(0);
let _outYaw = new Float64Array(0);
let _outYawVelocity = new Float64Array(0);
let _outYawAcceleration = new Float64Array(0);
let _outPitch = new Float64Array(0);
let _outPitchVelocity = new Float64Array(0);
let _outPitchAcceleration = new Float64Array(0);
let _outAimErrorYaw = new Float64Array(0);
let _outAimErrorPitch = new Float64Array(0);
let _workTargetX = new Float64Array(0);
let _workTargetY = new Float64Array(0);
let _workTargetZ = new Float64Array(0);

// Grows PER PUSHED HOST ROW in the builder collection loop, so rows
// already written this tick must survive the reallocation — see
// scratchArrayGrowth.ts for the determinism leak a contents-dropping
// growth causes here.
function ensureCapacity(required: number): void {
  if (_currentYaw.length >= required) return;
  const next = Math.max(16, required, _currentYaw.length * 2);
  _parentYaw = growScratchArray(_parentYaw, next);
  _targetWorldYaw = growScratchArray(_targetWorldYaw, next);
  _currentYaw = growScratchArray(_currentYaw, next);
  _yawVelocity = growScratchArray(_yawVelocity, next);
  _targetYaw = growScratchArray(_targetYaw, next);
  _yawContinuous = growScratchArray(_yawContinuous, next);
  _yawMin = growScratchArray(_yawMin, next);
  _yawMax = growScratchArray(_yawMax, next);
  _yawMaxSpeed = growScratchArray(_yawMaxSpeed, next);
  _yawMaxAcceleration = growScratchArray(_yawMaxAcceleration, next);
  _currentPitch = growScratchArray(_currentPitch, next);
  _pitchVelocity = growScratchArray(_pitchVelocity, next);
  _targetPitch = growScratchArray(_targetPitch, next);
  _pitchMin = growScratchArray(_pitchMin, next);
  _pitchMax = growScratchArray(_pitchMax, next);
  _pitchMaxSpeed = growScratchArray(_pitchMaxSpeed, next);
  _pitchMaxAcceleration = growScratchArray(_pitchMaxAcceleration, next);
  _outYaw = growScratchArray(_outYaw, next);
  _outYawVelocity = growScratchArray(_outYawVelocity, next);
  _outYawAcceleration = growScratchArray(_outYawAcceleration, next);
  _outPitch = growScratchArray(_outPitch, next);
  _outPitchVelocity = growScratchArray(_outPitchVelocity, next);
  _outPitchAcceleration = growScratchArray(_outPitchAcceleration, next);
  _outAimErrorYaw = growScratchArray(_outAimErrorYaw, next);
  _outAimErrorPitch = growScratchArray(_outAimErrorPitch, next);
  _workTargetX = growScratchArray(_workTargetX, next);
  _workTargetY = growScratchArray(_workTargetY, next);
  _workTargetZ = growScratchArray(_workTargetZ, next);
}

function writeEntityTarget(entity: Entity, out: WorkTargetPose): WorkTargetPose {
  out.id = entity.id;
  out.x = entity.transform.x;
  out.y = entity.transform.y;
  out.z = entity.building !== null
    ? getBuildingCombatCenterZ(entity)
    : entity.transform.z;
  return out;
}

function isAutoWorkTargetStillActive(entity: Entity): boolean {
  if (isBuildInProgress(entity.buildable)) return true;
  const hpState = entity.unit ?? entity.building;
  return hpState !== null && hpState.hp > 0 && hpState.hp < hpState.maxHp;
}

function resolveWorkTarget(
  world: WorldState,
  host: Entity,
  station: BuilderWorkStationRuntime,
  out: WorkTargetPose,
): WorkTargetPose | null {
  const action = host.unit?.actions[0];
  if (action !== undefined) {
    if (action.type === 'build' && action.buildingId !== undefined) {
      const entity = world.getEntity(action.buildingId);
      return entity === undefined ? null : writeEntityTarget(entity, out);
    }
    if (
      (action.type === 'repair' || action.type === 'capture' || action.type === 'resurrect') &&
      action.targetId !== undefined
    ) {
      const entity = world.getEntity(action.targetId);
      return entity === undefined ? null : writeEntityTarget(entity, out);
    }
    if (action.type === 'reclaim') {
      const reclaim = resolveReclaimTarget(world, action.targetId);
      if (reclaim === null) return null;
      out.id = reclaim.id;
      out.x = reclaim.x;
      out.y = reclaim.y;
      out.z = reclaim.z;
      return out;
    }
    if (action.type === 'guard' || action.guardReturnTargetId !== undefined) {
      const service = resolveGuardServiceTarget(world, host);
      if (service === null) return null;
      if (service.kind === 'factory') {
        const shellId = service.target.factory?.currentShellId ?? null;
        const shell = shellId === null ? undefined : world.getEntity(shellId);
        if (shell !== undefined) return writeEntityTarget(shell, out);
      }
      if (service.kind === 'reclaim') {
        out.id = service.target.id;
        out.x = service.target.x;
        out.y = service.target.y;
        out.z = service.target.z;
        return out;
      }
      if (service.kind === 'ready') return null;
      return writeEntityTarget(service.target, out);
    }
    // Only idle/fight/patrol builders participate in the automatic local
    // assist/repair selectors below. Any other head order is BAR StopBuild:
    // it must release the prior QueryWork target instead of inheriting it.
    if (action.type !== 'fight' && action.type !== 'patrol') return null;
  }

  // Auto-assist/repair selectors run in the economy pass. They publish their
  // chosen target here, so the station can slew toward it on the next fixed
  // tick without coupling the joint motor to resource-distribution order.
  // This is a one-tick handoff, not a durable target pointer: retain it only
  // while the target still needs construction or repair. In particular, a
  // completed buildee must fall through to StopBuilding/restoration.
  if (station.targetEntityId !== NO_ENTITY_ID) {
    const entity = world.getEntity(station.targetEntityId);
    if (entity !== undefined && isAutoWorkTargetStillActive(entity)) {
      return writeEntityTarget(entity, out);
    }
  }
  return null;
}

/** BAR StopBuild parity: sever the active work pointer immediately when a
 * builder work command completes. The joint keeps its current pose until the
 * authored restore delay expires, but it no longer tracks the old buildee. */
export function releaseBuilderWorkStation(world: WorldState, host: Entity): void {
  const station = host.builder?.workStation ?? null;
  if (station === null || station.targetEntityId === NO_ENTITY_ID) return;
  station.targetEntityId = NO_ENTITY_ID;
  station.aligned = false;
  station.idleMs = 0;
  world.markSnapshotDirty(host.id, ENTITY_CHANGED_TURRETS);
}

function botUpperBodyYaw(host: Entity): number {
  const combat = host.combat;
  if (combat === null) return host.transform.rotation;
  const ownerIndex = selectBotTorsoTurretIndex(combat.turrets);
  const owner = ownerIndex < 0 ? undefined : combat.turrets[ownerIndex];
  return owner !== undefined && Number.isFinite(owner.hostPieceYaw)
    ? owner.hostPieceYaw
    : host.transform.rotation;
}

/** Transform one authoritative bot-piece point through the moving torso,
 * suspension, ground support, and full body orientation. */
function writeBotLocalPointWorld(
  host: Entity,
  localX: number,
  localY: number,
  localZ: number,
  out: Vec3,
): Vec3 {
  const sourceUnit = host.unit;
  if (sourceUnit === null) {
    out.x = host.transform.x;
    out.y = host.transform.y;
    out.z = host.transform.z;
    return out;
  }
  const torsoYaw = botUpperBodyYaw(host);
  const torsoFromHost = shortestBotSocketAngleDelta(host.transform.rotation, torsoYaw);
  const torsoCos = DMath.cos(torsoFromHost);
  const torsoSin = DMath.sin(torsoFromHost);
  const suspension = sourceUnit.suspension;
  const { cos, sin } = getTransformCosSin(host.transform);
  return getTurretWorldMount(
    host.transform.x,
    host.transform.y,
    getUnitGroundZ(host),
    cos,
    sin,
    torsoCos * localX - torsoSin * localY + (suspension?.offsetX ?? 0),
    torsoSin * localX + torsoCos * localY + (suspension?.offsetY ?? 0),
    localZ + (suspension?.offsetZ ?? 0),
    sourceUnit.surfaceNormal ?? FLAT_NORMAL,
    getEntityBodyOrientation(host),
    out,
  );
}

/** Solve the host's articulated work arm into the shared _armPose scratch.
 *
 * Returns false — having written the plain host transform into `out` — for any
 * host that has no solved arm to speak of (no unit, a non-botArm attachment,
 * or a non-bot locomotion). Both work-emitter queries below need the exact
 * same guards and the exact same pose solve, and a divergence between them
 * would aim the nozzle somewhere the drawn arm is not. */
// Companion outputs of the last successful solveWorkStationArmPose call, kept
// alongside _armPose so the socket math below can read them without the solve
// allocating a result object on every tick.
let _armSolveRadius = 0;
let _armSolveAttachment: Extract<WorkStationAttachment, { kind: 'botArm' }> | null = null;

function solveWorkStationArmPose(
  host: Entity,
  station: BuilderWorkStationRuntime,
  emitter: WorkEmitterSpec,
  out: Vec3,
): boolean {
  const sourceUnit = host.unit;
  const attachment = emitter.attachment;
  if (sourceUnit === null || attachment.kind !== 'botArm') {
    out.x = host.transform.x;
    out.y = host.transform.y;
    out.z = host.transform.z;
    return false;
  }
  const blueprint = getUnitBlueprint(sourceUnit.unitBlueprintId);
  if (blueprint.unitLocomotion.type !== 'bot') {
    out.x = host.transform.x;
    out.y = host.transform.y;
    out.z = host.transform.z;
    return false;
  }
  const radius = sourceUnit.radius.other;
  const arms = blueprint.unitLocomotion.config.arms;
  resolveBotWeaponArmSocketPose(
    arms,
    radius,
    attachment.arm,
    radius * arms.shoulder.zUnitRadiusRatio,
    station.localPitch,
    station.localYaw,
    DMath,
    _armPose,
  );
  _armSolveRadius = radius;
  _armSolveAttachment = attachment;
  return true;
}

/** BAR-style AimFromWork pivot. The forearm joint, rather than the host
 * center, owns the direction that the QueryWork nozzle must realize. */
function writeQueryWorkAimFrom(
  host: Entity,
  station: BuilderWorkStationRuntime,
  emitter: WorkEmitterSpec,
  out: Vec3,
): Vec3 {
  if (!solveWorkStationArmPose(host, station, emitter, out)) return out;
  return writeBotLocalPointWorld(
    host,
    _armPose.elbowX,
    _armPose.elbowY,
    _armPose.elbowZ,
    out,
  );
}

/**
 * BAR-style QueryWork nozzle: the authored emitter point carried on the
 * solved forearm, in world space.
 *
 * Derived entirely from live host state — transform, surface normal, body
 * orientation, suspension, and the station's authoritative local yaw/pitch —
 * so a caller between fixed ticks gets the socket for the pose it is
 * actually drawing. That is why it is exported: client presentation resolves
 * the same nozzle every render frame (see workEmitterOrigin.ts).
 */
export function writeWorkEmitterSocketWorld(
  host: Entity,
  station: BuilderWorkStationRuntime,
  emitter: WorkEmitterSpec,
  out: Vec3,
): Vec3 {
  if (!solveWorkStationArmPose(host, station, emitter, out)) return out;

  // Articulated emitter points are QueryWork-local: +X follows the solved
  // forearm, +Y is its horizontal left, and +Z completes the right-handed
  // frame. This keeps authored nozzle offsets attached while the arm moves.
  const point = emitter.points[0] ?? ZERO_WORK_POINT;
  const forwardX = _armPose.aimX;
  const forwardY = _armPose.aimY;
  const forwardZ = _armPose.aimZ;
  const horizontal = DMath.hypot(forwardX, forwardY);
  const leftX = horizontal > 1e-9 ? -forwardY / horizontal : 0;
  const leftY = horizontal > 1e-9 ? forwardX / horizontal : 1;
  const upX = -forwardZ * leftY;
  const upY = forwardZ * leftX;
  const upZ = horizontal;
  const radius = _armSolveRadius;
  const socketOffset = _armSolveAttachment!.socketOffset;
  const socketX = _armPose.handX + radius * (
    socketOffset.x +
    point.x * forwardX + point.y * leftX + point.z * upX
  );
  const socketY = _armPose.handY + radius * (
    socketOffset.y +
    point.x * forwardY + point.y * leftY + point.z * upY
  );
  const socketZ = _armPose.handZ + radius * (
    socketOffset.z + point.x * forwardZ + point.z * upZ
  );
  return writeBotLocalPointWorld(host, socketX, socketY, socketZ, out);
}

/** Publish a resource/work request and report whether the physical station is
 * currently aligned with that exact target. Fixed emitters are always ready. */
export function requestBuilderWorkStation(
  source: Entity,
  targetEntityId: number,
): boolean {
  const builder = source.builder;
  if (builder === null) return false;
  const emitter = source.unit === null
    ? null
    : getUnitBlueprint(source.unit.unitBlueprintId).workEmitter ?? null;
  if (emitter === null || !emitter.requiresAlignmentForWork) return true;
  const station = builder.workStation;
  if (station === null) return false;
  if (station.targetEntityId !== targetEntityId) {
    station.targetEntityId = targetEntityId;
    station.aligned = false;
  }
  return station.aligned;
}

/** Authoritative BAR-style QueryWork articulation pass. World intent is
 * converted into local joint targets; the Rust motor enforces authored stops,
 * angular speed, acceleration, and delayed restore deterministically. */
export function updateArticulatedWorkStations(
  world: WorldState,
  dtMs: number,
): void {
  _hosts.length = 0;
  _stations.length = 0;
  _emitters.length = 0;

  // Resolve work intent first. The shared host-piece pass consumes these
  // world-space claims together with the prior committed weapon intent, then
  // moves each parent exactly once before any child work joint is stepped.
  for (const host of world.getBuilderUnits()) {
    const station = host.builder?.workStation ?? null;
    if (station === null || host.unit === null) continue;
    const emitter = getUnitBlueprint(host.unit.unitBlueprintId).workEmitter ?? null;
    const articulation = emitter?.articulation ?? null;
    const actuator = emitter?.angularActuator ?? null;
    if (emitter === null || articulation === null || actuator === null) continue;
    const target = resolveWorkTarget(world, host, station, _target);
    const index = _hosts.length;
    ensureCapacity(index + 1);
    _hosts.push(host);
    _stations.push(station);
    _emitters.push(emitter);
    if (target !== null) {
      station.targetEntityId = target.id;
      station.idleMs = 0;
      _workTargetX[index] = target.x;
      _workTargetY[index] = target.y;
      _workTargetZ[index] = target.z;
      writeQueryWorkAimFrom(host, station, emitter, _aimFrom);
      const dx = target.x - _aimFrom.x;
      const dy = target.y - _aimFrom.y;
      const dz = target.z - _aimFrom.z;
      station.targetWorldYaw = DMath.atan2(dy, dx);
      station.targetWorldPitch = DMath.atan2(dz, DMath.hypot(dx, dy));
    } else {
      station.targetEntityId = NO_ENTITY_ID;
      station.aligned = !emitter.requiresAlignmentForWork;
      station.idleMs += dtMs;
      _workTargetX[index] = 0;
      _workTargetY[index] = 0;
      _workTargetZ[index] = 0;
    }
  }

  // This is the one shared-parent step for the fixed tick. Weapon claims are
  // the prior committed targeting result; work claims above are current host
  // intent. Combat targeting later in the tick produces the weapon claim for
  // the next tick, matching a sampled physical controller without double-
  // integrating a heavy waist.
  updateAuthoritativeHostAttachmentKinematics(
    world.getArmedEntities(),
    world.getTick(),
    dtMs,
    'hostAim',
  );

  for (let index = 0; index < _hosts.length; index++) {
    const host = _hosts[index];
    const station = _stations[index];
    const emitter = _emitters[index];
    const articulation = emitter.articulation!;
    const actuator = emitter.angularActuator!;
    const parentYaw = botUpperBodyYaw(host);
    _parentYaw[index] = parentYaw;
    _currentYaw[index] = station.localYaw;
    _yawVelocity[index] = station.localYawVelocity;
    _currentPitch[index] = station.localPitch;
    _pitchVelocity[index] = station.localPitchVelocity;
    _yawContinuous[index] = articulation.yaw.continuous ? 1 : 0;
    _yawMin[index] = articulation.yaw.minAngle;
    _yawMax[index] = articulation.yaw.maxAngle;
    _yawMaxSpeed[index] = actuator.yaw.maxSpeed;
    _yawMaxAcceleration[index] = actuator.yaw.maxAcceleration;
    _pitchMin[index] = articulation.pitch.minAngle;
    _pitchMax[index] = articulation.pitch.maxAngle;
    _pitchMaxSpeed[index] = actuator.pitch.maxSpeed;
    _pitchMaxAcceleration[index] = actuator.pitch.maxAcceleration;
    if (station.targetEntityId !== NO_ENTITY_ID) {
      writeQueryWorkAimFrom(host, station, emitter, _aimFrom);
      const dx = _workTargetX[index] - _aimFrom.x;
      const dy = _workTargetY[index] - _aimFrom.y;
      const dz = _workTargetZ[index] - _aimFrom.z;
      const worldYaw = DMath.atan2(dy, dx);
      const worldPitch = DMath.atan2(dz, DMath.hypot(dx, dy));
      _targetWorldYaw[index] = worldYaw;
      _targetYaw[index] = normalizeAngle(worldYaw - parentYaw);
      _targetPitch[index] = worldPitch;
      station.targetWorldYaw = worldYaw;
      station.targetWorldPitch = worldPitch;
    } else {
      const restoring = station.idleMs >= articulation.restoreDelayMs;
      _targetWorldYaw[index] = normalizeAngle(parentYaw + (restoring ? articulation.restYaw : station.localYaw));
      _targetYaw[index] = restoring ? articulation.restYaw : station.localYaw;
      _targetPitch[index] = restoring ? articulation.restPitch : station.localPitch;
    }
  }

  const count = _hosts.length;
  if (count === 0) return;
  const sim = getSimWasm();
  if (sim === undefined) throw new Error('updateArticulatedWorkStations: sim-wasm is not initialized');
  const updated = sim.articulationJointStepBatch(
    _currentYaw,
    _yawVelocity,
    _targetYaw,
    _yawContinuous,
    _yawMin,
    _yawMax,
    _yawMaxSpeed,
    _yawMaxAcceleration,
    _currentPitch,
    _pitchVelocity,
    _targetPitch,
    _pitchMin,
    _pitchMax,
    _pitchMaxSpeed,
    _pitchMaxAcceleration,
    _outYaw,
    _outYawVelocity,
    _outYawAcceleration,
    _outPitch,
    _outPitchVelocity,
    _outPitchAcceleration,
    _outAimErrorYaw,
    _outAimErrorPitch,
    count,
    dtMs / 1000,
  );
  if (updated !== count) {
    throw new Error(`updateArticulatedWorkStations: motor updated ${updated} of ${count} rows`);
  }
  const tick = world.getTick();
  const invDtSec = dtMs > 0 ? 1000 / dtMs : 0;
  for (let i = 0; i < count; i++) {
    const station = _stations[i];
    const emitter = _emitters[i];
    station.localYaw = _outYaw[i];
    station.localYawVelocity = _outYawVelocity[i];
    station.localPitch = _outPitch[i];
    station.localPitchVelocity = _outPitchVelocity[i];
    if (station.targetEntityId !== NO_ENTITY_ID) {
      const achievedWorldYaw = normalizeAngle(_parentYaw[i] + station.localYaw);
      const yawError = shortestBotSocketAngleDelta(achievedWorldYaw, station.targetWorldYaw);
      const pitchError = station.targetWorldPitch - station.localPitch;
      station.aligned = !emitter.requiresAlignmentForWork || (
        Math.abs(yawError) <= emitter.alignmentToleranceRadians &&
        Math.abs(pitchError) <= emitter.alignmentToleranceRadians
      );
    }
    const oldX = station.worldPosition.x;
    const oldY = station.worldPosition.y;
    const oldZ = station.worldPosition.z;
    writeWorkEmitterSocketWorld(_hosts[i], station, emitter, _socket);
    if (station.worldPosTick === tick - 1 && invDtSec > 0) {
      station.worldVelocity.x = (_socket.x - oldX) * invDtSec;
      station.worldVelocity.y = (_socket.y - oldY) * invDtSec;
      station.worldVelocity.z = (_socket.z - oldZ) * invDtSec;
    } else {
      station.worldVelocity.x = _hosts[i].unit?.velocityX ?? 0;
      station.worldVelocity.y = _hosts[i].unit?.velocityY ?? 0;
      station.worldVelocity.z = _hosts[i].unit?.velocityZ ?? 0;
    }
    station.worldPosition.x = _socket.x;
    station.worldPosition.y = _socket.y;
    station.worldPosition.z = _socket.z;
    station.worldPosTick = tick;
    const articulation = emitter.articulation!;
    if (
      station.targetEntityId !== NO_ENTITY_ID ||
      station.idleMs <= dtMs ||
      Math.abs(station.localYaw - articulation.restYaw) > 1e-8 ||
      Math.abs(station.localPitch - articulation.restPitch) > 1e-8 ||
      Math.abs(station.localYawVelocity) > 1e-8 ||
      Math.abs(station.localPitchVelocity) > 1e-8
    ) {
      world.markSnapshotDirty(_hosts[i].id, ENTITY_CHANGED_TURRETS);
    }
  }
}
