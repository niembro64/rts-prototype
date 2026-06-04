import {
  getClientUnitGroundNormalEmaMode,
  getMovementPosEmaMode,
  getMovementVelEmaMode,
  getPredictionMode,
  getRotationPosEmaMode,
  getRotationVelEmaMode,
} from '@/clientBarConfig';
import { LAND_CELL_SIZE } from '../../config';
import { UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC } from '@/shellConfig';
import type { Entity, TurretState } from '../sim/types';
import {
  angleDeltaAbs,
  clamp,
  lerp,
  lerpAngle,
  magnitude3,
  normalizeAngle,
} from '../math';
import { getChannelBlend, halfLifeBlend } from './driftEma';
import type { PredictionStep } from './ClientPredictionCadence';
import { advanceUnitSuspension } from '../sim/unitSuspension';
import { getSurfaceHeight, getSurfaceNormal } from '../sim/Terrain';
import {
  advanceUnitMotionPredictionBatchMutable,
} from '../sim/unitMotionIntegration';
import { getUnitAirFrictionDamp } from '../sim/unitAirFriction';
import {
  getUnitGroundFrictionDamp,
  isUnitGroundPenetrationInContact,
} from '../sim/unitGroundPhysics';
import { getUnitBodyCenterHeight } from '../sim/unitGeometry';
import {
  CT_TURRET_STATE_ENGAGED,
  getSimWasm,
  QUAT_HOVER_BATCH_STRIDE,
} from '../sim-wasm/init';
import {
  readCombatTargetingTurretFsmInto,
  type CombatTargetingTurretFsmOut,
} from '../sim/combat/targetingInputStamping';
import type { ServerTarget } from './ClientPredictionTargets';

const PREDICTION_POS_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_VEL_EPSILON_SQ = 0.01 * 0.01;
const PREDICTION_ROT_EPSILON = 0.001;
const PREDICTION_TURRET_EPSILON = 0.001;
const PREDICTION_GROUND_REST_PENETRATION_EPSILON = 0.1;
const TERRAIN_VERTICAL_SLAVE_EPSILON = 2;
const TURRET_PITCH_MIN = -Math.PI / 2;
const TURRET_PITCH_MAX = Math.PI / 2;
const MOTION_STRIDE = 6;
const INITIAL_BATCH_CAPACITY = 64;

type UnitPredictionTarget = ServerTarget;
type UnitOrientationTarget = NonNullable<UnitPredictionTarget['orientation']>;

// Slab-first read of the per-turret engaged state. On the host the
// targeting Rust kernel is the authoritative source; on a remote
// client the slab is unstamped and we fall back to the snapshot-
// hydrated JS Turret.state.
const _predictFsm: CombatTargetingTurretFsmOut = {
  stateCode: CT_TURRET_STATE_ENGAGED,
  targetId: -1,
};
function isTurretEngaged(
  entity: Entity,
  weaponIndex: number,
  jsState: TurretState,
): boolean {
  return readCombatTargetingTurretFsmInto(entity, weaponIndex, _predictFsm)
    ? _predictFsm.stateCode === CT_TURRET_STATE_ENGAGED
    : jsState === 'engaged';
}

function advanceTurretYaw(angle: number, angularVelocity: number, dt: number): number {
  const safeAngle = Number.isFinite(angle) ? angle : 0;
  const safeVelocity = Number.isFinite(angularVelocity) ? angularVelocity : 0;
  const safeDt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  return normalizeAngle(safeAngle + safeVelocity * safeDt);
}

// Reused in the per-turret prediction loop; callers copy fields immediately.
const turretPitchStepScratch = { pitch: 0, pitchVelocity: 0 };
function advanceTurretPitch(
  pitch: number,
  pitchVelocity: number,
  dt: number,
): { pitch: number; pitchVelocity: number } {
  const safePitch = Number.isFinite(pitch) ? pitch : 0;
  const safeVelocity = Number.isFinite(pitchVelocity) ? pitchVelocity : 0;
  const safeDt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const nextPitch = safePitch + safeVelocity * safeDt;
  const clampedPitch = clamp(nextPitch, TURRET_PITCH_MIN, TURRET_PITCH_MAX);
  turretPitchStepScratch.pitch = clampedPitch;
  turretPitchStepScratch.pitchVelocity = clampedPitch === nextPitch ? safeVelocity : 0;
  return turretPitchStepScratch;
}

let predictionMapWidth = 2000;
let predictionMapHeight = 2000;
let motionBatch = new Float64Array(0);
let groundOffsetBatch = new Float64Array(0);
let groundZBatch = new Float64Array(0);
let groundNormalBatch = new Float64Array(0);
let contactBatch = new Uint8Array(0);
const targetBatchRefs: UnitPredictionTarget[] = [];
let orientationBatch = new Float64Array(0);
const entityOrientationBatchRefs: Entity[] = [];
const targetOrientationBatchRefs: UnitPredictionTarget[] = [];

function getPredictionGroundZ(x: number, y: number): number {
  return getSurfaceHeight(
    x,
    y,
    predictionMapWidth,
    predictionMapHeight,
    LAND_CELL_SIZE,
  );
}

function getPredictionGroundNormal(
  x: number,
  y: number,
): { nx: number; ny: number; nz: number } {
  return getSurfaceNormal(
    x,
    y,
    predictionMapWidth,
    predictionMapHeight,
    LAND_CELL_SIZE,
  );
}

// Ground units resting on terrain sit at terrain + bodyCenterHeight. Deriving
// that Z locally removes between-snapshot vertical float and correction bounce.
// Elevated server targets are different: units can stand on buildings, factory
// platforms, or other units, so when the authoritative target is clearly above
// terrain we leave Z to the snapshot/drift path.
function slaveGroundUnitVerticalToTerrain(
  entity: Entity,
  target: UnitPredictionTarget | undefined,
): void {
  const unit = entity.unit;
  if (unit === null) return;
  const type = unit.locomotion?.type;
  if (type === 'hover' || type === 'flying') return;
  const transform = entity.transform;
  const terrainRestZ = getPredictionGroundZ(transform.x, transform.y)
    + getUnitBodyCenterHeight(unit);
  const authoritativeZ = target !== undefined && Number.isFinite(target.z)
    ? target.z
    : transform.z;
  if (authoritativeZ > terrainRestZ + TERRAIN_VERTICAL_SLAVE_EPSILON) return;
  transform.z = terrainRestZ;
}

function ensurePredictionBatchCapacity(count: number): void {
  if (motionBatch.length >= count * MOTION_STRIDE) return;
  let capacity = Math.max(
    INITIAL_BATCH_CAPACITY,
    motionBatch.length / MOTION_STRIDE,
    1,
  );
  while (capacity < count) capacity *= 2;
  motionBatch = new Float64Array(capacity * MOTION_STRIDE);
  groundOffsetBatch = new Float64Array(capacity);
  groundZBatch = new Float64Array(capacity);
  groundNormalBatch = new Float64Array(capacity * 3);
  contactBatch = new Uint8Array(capacity);
}

function ensureOrientationBatchCapacity(count: number): void {
  if (orientationBatch.length >= count * QUAT_HOVER_BATCH_STRIDE) return;
  let capacity = Math.max(
    INITIAL_BATCH_CAPACITY,
    orientationBatch.length / QUAT_HOVER_BATCH_STRIDE,
    1,
  );
  while (capacity < count) capacity *= 2;
  orientationBatch = new Float64Array(capacity * QUAT_HOVER_BATCH_STRIDE);
}

function packOrientationPredictionEntry(
  base: number,
  orientation: UnitOrientationTarget,
  omegaX: number,
  omegaY: number,
  omegaZ: number,
): void {
  orientationBatch[base] = Number.isFinite(orientation.x) ? orientation.x : 0;
  orientationBatch[base + 1] = Number.isFinite(orientation.y) ? orientation.y : 0;
  orientationBatch[base + 2] = Number.isFinite(orientation.z) ? orientation.z : 0;
  orientationBatch[base + 3] = Number.isFinite(orientation.w) ? orientation.w : 1;
  orientationBatch[base + 4] = Number.isFinite(omegaX) ? omegaX : 0;
  orientationBatch[base + 5] = Number.isFinite(omegaY) ? omegaY : 0;
  orientationBatch[base + 6] = Number.isFinite(omegaZ) ? omegaZ : 0;
  orientationBatch[base + 7] = 0;
  orientationBatch[base + 8] = 0;
  orientationBatch[base + 9] = 0;
}

function advancePackedOrientationBatch(count: number, dt: number): void {
  if (count <= 0 || !Number.isFinite(dt) || dt <= 0) return;
  const sim = getSimWasm();
  if (sim === undefined) {
    throw new Error('advancePackedOrientationBatch: sim-wasm is not initialized');
  }
  sim.quatHoverOrientationStepBatch(
    orientationBatch.subarray(0, count * QUAT_HOVER_BATCH_STRIDE),
    count,
    0,
    0,
    dt,
  );
}

function packEntityOrientationPredictionBatch(
  entities: Entity[],
  count: number,
): number {
  entityOrientationBatchRefs.length = 0;
  let batchCount = 0;
  for (let i = 0; i < count; i++) {
    const entity = entities[i];
    const unit = entity.unit;
    if (unit === null || unit.orientation === null || unit.angularVelocity3 === null) continue;
    const base = batchCount * QUAT_HOVER_BATCH_STRIDE;
    packOrientationPredictionEntry(
      base,
      unit.orientation,
      unit.angularVelocity3.x,
      unit.angularVelocity3.y,
      unit.angularVelocity3.z,
    );
    entityOrientationBatchRefs[batchCount] = entity;
    batchCount++;
  }
  return batchCount;
}

function writeEntityOrientationPredictionBatch(count: number): void {
  for (let i = 0; i < count; i++) {
    const entity = entityOrientationBatchRefs[i];
    const unit = entity.unit;
    if (unit === null || unit.orientation === null || unit.angularVelocity3 === null) continue;
    const base = i * QUAT_HOVER_BATCH_STRIDE;
    const orientation = unit.orientation;
    orientation.x = orientationBatch[base];
    orientation.y = orientationBatch[base + 1];
    orientation.z = orientationBatch[base + 2];
    orientation.w = orientationBatch[base + 3];
    const omega = unit.angularVelocity3;
    omega.x = orientationBatch[base + 4];
    omega.y = orientationBatch[base + 5];
    omega.z = orientationBatch[base + 6];
    entity.transform.rotation = normalizeAngle(orientationBatch[base + 13]);
  }
  entityOrientationBatchRefs.length = 0;
}

function packTargetOrientationPredictionBatch(
  targets: Array<UnitPredictionTarget | undefined>,
  count: number,
): number {
  targetOrientationBatchRefs.length = 0;
  let batchCount = 0;
  for (let i = 0; i < count; i++) {
    const target = targets[i];
    if (
      target === undefined ||
      target.orientation === null ||
      target.angularVelocityX === null ||
      target.angularVelocityY === null ||
      target.angularVelocityZ === null
    ) {
      continue;
    }
    const base = batchCount * QUAT_HOVER_BATCH_STRIDE;
    packOrientationPredictionEntry(
      base,
      target.orientation,
      target.angularVelocityX,
      target.angularVelocityY,
      target.angularVelocityZ,
    );
    targetOrientationBatchRefs[batchCount] = target;
    batchCount++;
  }
  return batchCount;
}

function writeTargetOrientationPredictionBatch(count: number): void {
  for (let i = 0; i < count; i++) {
    const target = targetOrientationBatchRefs[i];
    const orientation = target.orientation;
    if (orientation === null) continue;
    const base = i * QUAT_HOVER_BATCH_STRIDE;
    orientation.x = orientationBatch[base];
    orientation.y = orientationBatch[base + 1];
    orientation.z = orientationBatch[base + 2];
    orientation.w = orientationBatch[base + 3];
    target.angularVelocityX = orientationBatch[base + 4];
    target.angularVelocityY = orientationBatch[base + 5];
    target.angularVelocityZ = orientationBatch[base + 6];
    target.rotation = normalizeAngle(orientationBatch[base + 13]);
  }
  targetOrientationBatchRefs.length = 0;
}

function sampleInitialGroundBatch(count: number): void {
  for (let i = 0; i < count; i++) {
    const base = i * MOTION_STRIDE;
    const x = motionBatch[base];
    const y = motionBatch[base + 1];
    const groundZ = getPredictionGroundZ(x, y);
    const penetration = groundZ - (motionBatch[base + 2] - groundOffsetBatch[i]);
    groundZBatch[i] = groundZ;
    let nx = 0;
    let ny = 0;
    let nz = 1;
    if (isUnitGroundPenetrationInContact(penetration)) {
      const normal = getPredictionGroundNormal(x, y);
      nx = normal.nx;
      ny = normal.ny;
      nz = normal.nz;
    }
    groundNormalBatch[i * 3] = nx;
    groundNormalBatch[i * 3 + 1] = ny;
    groundNormalBatch[i * 3 + 2] = nz;
  }
}

function snapContactMotionBatch(count: number): void {
  for (let i = 0; i < count; i++) {
    const base = i * MOTION_STRIDE;
    const penetration = groundZBatch[i] - (motionBatch[base + 2] - groundOffsetBatch[i]);
    const contact = isUnitGroundPenetrationInContact(penetration);
    contactBatch[i] = contact ? 1 : 0;
    if (contact) {
      motionBatch[base + 2] = groundZBatch[i] + groundOffsetBatch[i];
    }
  }
}

function updateCurrentMotionContacts(count: number): void {
  for (let i = 0; i < count; i++) {
    const base = i * MOTION_STRIDE;
    const nextGroundZ = getPredictionGroundZ(motionBatch[base], motionBatch[base + 1]);
    contactBatch[i] = isUnitGroundPenetrationInContact(
      nextGroundZ - (motionBatch[base + 2] - groundOffsetBatch[i]),
    ) ? 1 : 0;
  }
}

function advancePackedMotionBatch(
  count: number,
  predictionMode: ReturnType<typeof getPredictionMode>,
  dt: number,
  airDamp: number,
  groundDamp: number,
): void {
  if (count <= 0) return;
  sampleInitialGroundBatch(count);

  // PLAYER CLIENT bar: PREDICT mode gates how aggressively the
  // client extrapolates motion between snapshots.
  //   'pos' — no integration. The per-channel drift lerp downstream
  //            still pulls the entity to snapshot position; this just
  //            stops the client from running any kinematic step itself.
  //   'vel' — integrate position from the last-seen velocity each
  //            frame. Acceleration is never on the wire (the client
  //            ships velocity, not forces), so there is no ACC mode.
  if (predictionMode === 'pos') {
    snapContactMotionBatch(count);
    return;
  }

  advanceUnitMotionPredictionBatchMutable(
    count,
    motionBatch,
    groundOffsetBatch,
    groundZBatch,
    groundNormalBatch,
    dt,
    airDamp,
    groundDamp,
    PREDICTION_GROUND_REST_PENETRATION_EPSILON,
    PREDICTION_VEL_EPSILON_SQ,
  );
  updateCurrentMotionContacts(count);
}

function packTargetPredictionBatch(
  targets: Array<UnitPredictionTarget | undefined>,
  count: number,
): number {
  targetBatchRefs.length = 0;
  let batchCount = 0;
  for (let i = 0; i < count; i++) {
    const target = targets[i];
    if (target === undefined) continue;
    const base = batchCount * MOTION_STRIDE;
    motionBatch[base] = target.x;
    motionBatch[base + 1] = target.y;
    motionBatch[base + 2] = target.z;
    motionBatch[base + 3] = target.velocityX ?? 0;
    motionBatch[base + 4] = target.velocityY ?? 0;
    motionBatch[base + 5] = target.velocityZ ?? 0;
    groundOffsetBatch[batchCount] = target.bodyCenterHeight;
    targetBatchRefs[batchCount] = target;
    batchCount++;
  }
  return batchCount;
}

function writeTargetPredictionBatch(count: number): void {
  for (let i = 0; i < count; i++) {
    const target = targetBatchRefs[i];
    const base = i * MOTION_STRIDE;
    target.x = motionBatch[base];
    target.y = motionBatch[base + 1];
    target.z = motionBatch[base + 2];
    target.velocityX = motionBatch[base + 3];
    target.velocityY = motionBatch[base + 4];
    target.velocityZ = motionBatch[base + 5];
    target.predictedGroundContact = contactBatch[i] !== 0;
  }
  targetBatchRefs.length = 0;
}

function packEntityPredictionBatch(entities: Entity[], count: number): void {
  for (let i = 0; i < count; i++) {
    const entity = entities[i];
    const unit = entity.unit;
    const base = i * MOTION_STRIDE;
    motionBatch[base] = entity.transform.x;
    motionBatch[base + 1] = entity.transform.y;
    motionBatch[base + 2] = entity.transform.z;
    if (unit === null) {
      motionBatch[base + 3] = 0;
      motionBatch[base + 4] = 0;
      motionBatch[base + 5] = 0;
      groundOffsetBatch[i] = 0;
    } else {
      motionBatch[base + 3] = unit.velocityX;
      motionBatch[base + 4] = unit.velocityY;
      motionBatch[base + 5] = unit.velocityZ;
      groundOffsetBatch[i] = unit.bodyCenterHeight;
    }
  }
}

function writeEntityPredictionBatch(
  entities: Entity[],
  count: number,
  deltaMs: number,
): void {
  for (let i = 0; i < count; i++) {
    const entity = entities[i];
    const unit = entity.unit;
    if (!unit) continue;
    const base = i * MOTION_STRIDE;
    entity.transform.x = motionBatch[base];
    entity.transform.y = motionBatch[base + 1];
    entity.transform.z = motionBatch[base + 2];
    unit.velocityX = motionBatch[base + 3];
    unit.velocityY = motionBatch[base + 4];
    unit.velocityZ = motionBatch[base + 5];
    advanceUnitSuspension(unit, entity.transform.rotation, deltaMs, {
      legContact: contactBatch[i] !== 0,
    });
  }
}

function applyClientUnitVisualDrift(
  entity: Entity,
  target: UnitPredictionTarget | undefined,
  movPosBlend: number,
  movVelBlend: number,
  rotPosBlend: number,
  rotVelBlend: number,
  normalAlpha: number,
): void {
  if (!entity.unit || !target) return;

  // Movement position channel — snap / EMA.
  if (movPosBlend >= 0) {
    entity.transform.x = lerp(entity.transform.x, target.x, movPosBlend);
    entity.transform.y = lerp(entity.transform.y, target.y, movPosBlend);
    entity.transform.z = lerp(entity.transform.z, target.z, movPosBlend);
  }

  // Rotation position channel — covers the body yaw scalar AND, below,
  // each turret's rotation/pitch.
  if (rotPosBlend >= 0) {
    entity.transform.rotation = lerpAngle(
      entity.transform.rotation,
      target.rotation,
      rotPosBlend,
    );
  }

  // Movement velocity channel.
  if (movVelBlend >= 0) {
    entity.unit.velocityX = lerp(
      entity.unit.velocityX ?? 0,
      target.velocityX ?? 0,
      movVelBlend,
    );
    entity.unit.velocityY = lerp(
      entity.unit.velocityY ?? 0,
      target.velocityY ?? 0,
      movVelBlend,
    );
    entity.unit.velocityZ = lerp(
      entity.unit.velocityZ ?? 0,
      target.velocityZ ?? 0,
      movVelBlend,
    );
  }

  // Full 3-DOF orientation drift for hover-style units. The body
  // quaternion is the rotation-position channel for hovers; we use the
  // same blend factor as the yaw scalar so changing the rotation-pos
  // EMA mode affects both ground and hover bodies consistently. We
  // componentwise-lerp + renormalize rather than slerp because the
  // per-frame blend is small (a few percent of the remaining error)
  // and componentwise lerp is much cheaper.
  if (rotPosBlend >= 0 && target.orientation !== null && entity.unit.orientation !== null) {
    const eo = entity.unit.orientation;
    const to = target.orientation;
    eo.x = lerp(eo.x, to.x, rotPosBlend);
    eo.y = lerp(eo.y, to.y, rotPosBlend);
    eo.z = lerp(eo.z, to.z, rotPosBlend);
    eo.w = lerp(eo.w, to.w, rotPosBlend);
    const m2 = eo.x * eo.x + eo.y * eo.y + eo.z * eo.z + eo.w * eo.w;
    if (m2 > 1e-12) {
      const inv = 1 / Math.sqrt(m2);
      eo.x *= inv; eo.y *= inv; eo.z *= inv; eo.w *= inv;
    }
  }

  // Hover angular velocity — paired with orientation. Blends with the
  // rotation-velocity channel.
  if (
    rotVelBlend >= 0
    && entity.unit.angularVelocity3
    && target.angularVelocityX !== null
    && target.angularVelocityY !== null
    && target.angularVelocityZ !== null
  ) {
    const av = entity.unit.angularVelocity3;
    av.x = lerp(av.x, target.angularVelocityX, rotVelBlend);
    av.y = lerp(av.y, target.angularVelocityY, rotVelBlend);
    av.z = lerp(av.z, target.angularVelocityZ, rotVelBlend);
  }

  // Unit Ground Normal EMA is its own knob — orthogonal to the per-channel snapshot
  // drift — because it smooths a SERVER-side EMA's output (slope
  // normal), not a snapshot drift correction. Always applied.
  const sn = entity.unit.surfaceNormal;
  const tnx = sn.nx + (target.surfaceNormalX - sn.nx) * normalAlpha;
  const tny = sn.ny + (target.surfaceNormalY - sn.ny) * normalAlpha;
  const tnz = sn.nz + (target.surfaceNormalZ - sn.nz) * normalAlpha;
  const tlen = magnitude3(tnx, tny, tnz);
  if (tlen > 1e-6) {
    const inv = 1 / tlen;
    sn.nx = tnx * inv;
    sn.ny = tny * inv;
    sn.nz = tnz * inv;
  }
}

export function applyClientUnitVisualPredictionBatch(options: {
  entities: Entity[];
  targets: Array<UnitPredictionTarget | undefined>;
  deltaMs: number;
  mapWidth: number;
  mapHeight: number;
}): void {
  const { entities, targets, deltaMs, mapWidth, mapHeight } = options;
  const count = entities.length;
  if (count === 0) return;

  const dt = deltaMs / 1000;
  const movPosBlend = getChannelBlend(getMovementPosEmaMode(), dt);
  const movVelBlend = getChannelBlend(getMovementVelEmaMode(), dt);
  const rotPosBlend = getChannelBlend(getRotationPosEmaMode(), dt);
  const rotVelBlend = getChannelBlend(getRotationVelEmaMode(), dt);
  const normalAlpha = halfLifeBlend(
    dt,
    UNIT_GROUND_NORMAL_EMA_HALF_LIFE_SEC[getClientUnitGroundNormalEmaMode()],
  );
  const airDamp = getUnitAirFrictionDamp(dt);
  const groundDamp = getUnitGroundFrictionDamp(dt);
  const predictionMode = getPredictionMode();
  predictionMapWidth = mapWidth;
  predictionMapHeight = mapHeight;
  ensurePredictionBatchCapacity(count);
  ensureOrientationBatchCapacity(count);

  // Unit body motion is a visual contract, not an optional detail.
  // Keep both the stored server target and the rendered entity moving
  // smoothly at render cadence while crossing JS/WASM only twice per
  // frame for all predicted units.
  const targetCount = packTargetPredictionBatch(targets, count);
  advancePackedMotionBatch(targetCount, predictionMode, dt, airDamp, groundDamp);
  writeTargetPredictionBatch(targetCount);

  packEntityPredictionBatch(entities, count);
  advancePackedMotionBatch(count, predictionMode, dt, airDamp, groundDamp);
  writeEntityPredictionBatch(entities, count, deltaMs);

  if (predictionMode !== 'pos') {
    const targetOrientationCount = packTargetOrientationPredictionBatch(targets, count);
    advancePackedOrientationBatch(targetOrientationCount, dt);
    writeTargetOrientationPredictionBatch(targetOrientationCount);

    const entityOrientationCount = packEntityOrientationPredictionBatch(entities, count);
    advancePackedOrientationBatch(entityOrientationCount, dt);
    writeEntityOrientationPredictionBatch(entityOrientationCount);
  }

  for (let i = 0; i < count; i++) {
    const entity = entities[i];
    applyClientUnitVisualDrift(
      entity,
      targets[i],
      movPosBlend,
      movVelBlend,
      rotPosBlend,
      rotVelBlend,
      normalAlpha,
    );
    // Terrain-level ground units clamp to the local terrain rest height; elevated
    // server targets keep their snapshot/drift Z. Runs after drift so the check
    // sees the final predicted (x, y) footprint.
    slaveGroundUnitVerticalToTerrain(entity, targets[i]);
  }
}

export function applyClientCombatExpensivePrediction(options: {
  entity: Entity;
  target: UnitPredictionTarget | undefined;
  predictionStep: PredictionStep;
  turretShieldSpheresEnabled: boolean;
}): void {
  const { entity, target, predictionStep, turretShieldSpheresEnabled } = options;
  if (!entity.combat) return;
  const dt = predictionStep.entityDeltaMs / 1000;
  const targetDt = predictionStep.targetDeltaMs / 1000;
  const rotPosBlend = getChannelBlend(getRotationPosEmaMode(), dt);
  const rotVelBlend = getChannelBlend(getRotationVelEmaMode(), dt);

  // PREDICT mode gates turret yaw / pitch integration. POS skips both
  // and only the per-channel rotation-position EMA pulls toward the
  // snapshot rotation. VEL integrates rotation from angular velocity.
  // Angular acceleration is not on the wire, so the velocity-only
  // integrator is the only available kinematic step.
  const predictionMode = getPredictionMode();
  const integrateRotation = predictionMode !== 'pos';
  const turrets = entity.combat.turrets;
  const targetTurrets = target !== undefined ? target.turrets : undefined;
  for (let i = 0; i < turrets.length; i++) {
    const weapon = turrets[i];
    if (weapon.config.visualOnly) continue;
    if (integrateRotation) {
      weapon.rotation = advanceTurretYaw(weapon.rotation, weapon.angularVelocity, dt);
      const pitchStep = advanceTurretPitch(weapon.pitch, weapon.pitchVelocity, dt);
      weapon.pitch = pitchStep.pitch;
      weapon.pitchVelocity = pitchStep.pitchVelocity;
    }

    const tw = targetTurrets !== undefined ? targetTurrets[i] : undefined;
    if (tw !== undefined) {
      if (integrateRotation) {
        tw.rotation = advanceTurretYaw(tw.rotation, tw.angularVelocity, targetDt);
        const targetPitchStep = advanceTurretPitch(tw.pitch, tw.pitchVelocity, targetDt);
        tw.pitch = targetPitchStep.pitch;
        tw.pitchVelocity = targetPitchStep.pitchVelocity;
      }
      if (rotPosBlend >= 0) {
        weapon.rotation = normalizeAngle(lerpAngle(weapon.rotation, tw.rotation, rotPosBlend));
        weapon.pitch = clamp(
          lerpAngle(weapon.pitch, tw.pitch, rotPosBlend),
          TURRET_PITCH_MIN,
          TURRET_PITCH_MAX,
        );
      }
      if (rotVelBlend >= 0) {
        weapon.angularVelocity = lerp(
          weapon.angularVelocity,
          tw.angularVelocity,
          rotVelBlend,
        );
        weapon.pitchVelocity = lerp(
          weapon.pitchVelocity,
          tw.pitchVelocity,
          rotVelBlend,
        );
      }
    }

    const shot = weapon.config.shot;
    if (shot === undefined || shot.type !== 'shield') continue;
    if (!turretShieldSpheresEnabled) {
      const shield = weapon.shield;
      if (shield !== undefined) {
        shield.range = 0;
        shield.transition = 0;
      }
      continue;
    }
    const fieldShot = shot;
    const shield = weapon.shield;
    const cur = shield !== undefined ? shield.range : 0;
    const targetProgress = isTurretEngaged(entity, i, weapon.state) ? 1 : 0;
    const progressDelta = dt / (fieldShot.transitionTime / 1000);
    let next = cur;
    if (cur < targetProgress) {
      next = Math.min(cur + progressDelta, 1);
    } else if (cur > targetProgress) {
      next = Math.max(cur - progressDelta, 0);
    }

    // The shield range is a slow visual transition, not a
    // snapshot-drift channel. It rides along with rotation-position
    // correction.
    const serverRange = tw !== undefined ? tw.shieldRange : undefined;
    if (serverRange !== undefined && rotPosBlend >= 0) {
      next = lerp(next, serverRange, rotPosBlend);
    }
    if (shield === undefined) {
      weapon.shield = { range: next, transition: 0 };
    } else {
      shield.range = next;
    }
  }
}

export function clientUnitPredictionIsSettled(
  entity: Entity,
  target: UnitPredictionTarget | undefined,
  turretShieldSpheresEnabled: boolean,
): boolean {
  const unit = entity.unit;
  if (unit) {
    const vx = unit.velocityX ?? 0;
    const vy = unit.velocityY ?? 0;
    const vz = unit.velocityZ ?? 0;
    if (vx * vx + vy * vy + vz * vz > PREDICTION_VEL_EPSILON_SQ) return false;

    if (target) {
      const tvx = target.velocityX ?? 0;
      const tvy = target.velocityY ?? 0;
      const tvz = target.velocityZ ?? 0;
      if (tvx * tvx + tvy * tvy + tvz * tvz > PREDICTION_VEL_EPSILON_SQ) return false;

      const dx = entity.transform.x - target.x;
      const dy = entity.transform.y - target.y;
      const dz = entity.transform.z - target.z;
      if (dx * dx + dy * dy + dz * dz > PREDICTION_POS_EPSILON_SQ) return false;
      if (angleDeltaAbs(entity.transform.rotation, target.rotation) > PREDICTION_ROT_EPSILON) return false;
    }
  }

  const combat = entity.combat;
  const weapons = combat !== null ? combat.turrets : null;
  if (weapons === null || weapons.length === 0) return true;
  const targetTurrets = target !== undefined ? target.turrets : undefined;

  for (let i = 0; i < weapons.length; i++) {
    const weapon = weapons[i];
    if (weapon.config.visualOnly) continue;
    if (Math.abs(weapon.angularVelocity) > PREDICTION_TURRET_EPSILON) return false;

    const tw = targetTurrets !== undefined ? targetTurrets[i] : undefined;
    if (tw !== undefined) {
      if (Math.abs(tw.angularVelocity) > PREDICTION_TURRET_EPSILON) return false;
      if (angleDeltaAbs(weapon.rotation, tw.rotation) > PREDICTION_TURRET_EPSILON) return false;
      if (angleDeltaAbs(weapon.pitch, tw.pitch) > PREDICTION_TURRET_EPSILON) return false;
      if (turretShieldSpheresEnabled) {
        const shield = weapon.shield;
        const localRange = shield !== undefined ? shield.range : 0;
        const targetRange = tw.shieldRange ?? 0;
        if (Math.abs(localRange - targetRange) > PREDICTION_TURRET_EPSILON) return false;
      }
    }

    const shot = weapon.config.shot;
    if (
      turretShieldSpheresEnabled &&
      shot !== undefined &&
      shot.type === 'shield' &&
      shot.barrier !== undefined
    ) {
      const shield = weapon.shield;
      const range = shield !== undefined ? shield.range : 0;
      if (range > PREDICTION_TURRET_EPSILON) return false;
      if (isTurretEngaged(entity, i, weapon.state)) return false;
    }
  }

  return true;
}
