import type { BeamPoint, Entity } from '../../types/sim';

// Lightweight copy of server state used for per-frame drift in client prediction.
// Owns its data instead of retaining references to pooled serializer objects.
export type ServerTarget = {
  updatedAtMs: number;
  x: number;
  y: number;
  z: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  surfaceNormalX: number;
  surfaceNormalY: number;
  surfaceNormalZ: number;
  bodyCenterHeight: number;
  predictedGroundContact: boolean;
  /** Full 3-DOF orientation triad, populated only when the snapshot
   *  carries an `orientation` field (hover units etc.). Null for ground
   *  units — the client reads `rotation` (yaw scalar) when absent. */
  orientation: { x: number; y: number; z: number; w: number } | null;
  angularVelocityX: number | null;
  angularVelocityY: number | null;
  angularVelocityZ: number | null;
  turrets: {
    rotation: number;
    angularVelocity: number;
    pitch: number;
    pitchVelocity: number;
    shieldRange: number | null;
  }[];
};

export function createServerTarget(): ServerTarget {
  return {
    updatedAtMs: 0,
    x: 0, y: 0, z: 0, rotation: 0,
    velocityX: 0, velocityY: 0, velocityZ: 0,
    surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 1,
    bodyCenterHeight: 0,
    predictedGroundContact: true,
    orientation: null,
    angularVelocityX: null,
    angularVelocityY: null,
    angularVelocityZ: null,
    turrets: [],
  };
}

export type BeamPathTarget = {
  updatedAtMs: number;
  points: BeamPoint[];
  obstructionT: number | null;
  endpointDamageable: boolean | null;
  initialSnapPending: boolean;
};

export function createBeamPathTarget(): BeamPathTarget {
  return {
    updatedAtMs: 0,
    points: [],
    obstructionT: null,
    endpointDamageable: null,
    initialSnapPending: true,
  };
}

// Module-level free list of BeamPoint objects. Beam paths grow and
// shrink as reflections come and go (a beam tracking a moving target
// across mirrors can gain or lose entries every frame). Without a
// pool, every length truncation drops the trailing point objects to
// GC and every regrowth allocates fresh ones — pure churn for a value
// type that's recycled minutes later.
const _beamPointFreeList: BeamPoint[] = [];
const BEAM_POINT_FREE_LIST_WARM_CAPACITY = 512;

export type ClientPredictionTargetPoolStats = {
  freeBeamPoints: number;
  warmBeamPoints: number;
};

export function getClientPredictionTargetPoolStats(): ClientPredictionTargetPoolStats {
  return {
    freeBeamPoints: _beamPointFreeList.length,
    warmBeamPoints: BEAM_POINT_FREE_LIST_WARM_CAPACITY,
  };
}

export function resetClientPredictionTargetPools(
  maxRetained = BEAM_POINT_FREE_LIST_WARM_CAPACITY,
): ClientPredictionTargetPoolStats {
  const retained = Math.max(0, Math.floor(maxRetained));
  if (_beamPointFreeList.length > retained) {
    _beamPointFreeList.length = retained;
  }
  return getClientPredictionTargetPoolStats();
}

function clearBeamPoint(p: BeamPoint): void {
  p.x = 0; p.y = 0; p.z = 0;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.reflectorEntityId = null;
  p.reflectorKind = null;
  p.reflectorPlayerId = null;
  p.normalX = null;
  p.normalY = null;
  p.normalZ = null;
}

function acquireBeamPoint(): BeamPoint {
  const pooled = _beamPointFreeList.pop();
  if (pooled) return pooled;
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    reflectorEntityId: null,
    reflectorKind: null,
    reflectorPlayerId: null,
    normalX: null,
    normalY: null,
    normalZ: null,
  };
}

function releaseBeamPoint(point: BeamPoint): void {
  if (_beamPointFreeList.length >= BEAM_POINT_FREE_LIST_WARM_CAPACITY) return;
  clearBeamPoint(point);
  _beamPointFreeList.push(point);
}

/** Truncate `arr` to `newLength`, returning the trailing point objects
 *  to the free list. Optional fields are cleared so the next acquire
 *  gets a clean slate without stale reflector metadata. */
export function shrinkBeamPoints(arr: BeamPoint[], newLength: number): void {
  const length = Math.max(0, Math.floor(newLength));
  for (let i = arr.length - 1; i >= length; i--) {
    const p = arr[i];
    if (p) releaseBeamPoint(p);
  }
  arr.length = length;
}

export function ensureBeamPoint(arr: BeamPoint[], i: number): BeamPoint {
  let point = arr[i];
  if (!point) {
    point = acquireBeamPoint();
    arr[i] = point;
  }
  return point;
}

function copyBeamPointState(dst: BeamPoint, src: BeamPoint): void {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.reflectorEntityId = src.reflectorEntityId;
  dst.reflectorKind = src.reflectorKind;
  dst.reflectorPlayerId = src.reflectorPlayerId;
  dst.normalX = src.normalX;
  dst.normalY = src.normalY;
  dst.normalZ = src.normalZ;
}

export function snapBeamPathDisplayToTarget(entity: Entity, target: BeamPathTarget): boolean {
  const proj = entity.projectile;
  if (proj === null) return false;

  const targetPoints = target.points;
  const displayPoints = proj.points ?? (proj.points = []);
  const oldLength = displayPoints.length;
  if (oldLength > targetPoints.length) {
    shrinkBeamPoints(displayPoints, targetPoints.length);
  } else if (oldLength < targetPoints.length) {
    displayPoints.length = targetPoints.length;
  }

  for (let i = 0; i < targetPoints.length; i++) {
    copyBeamPointState(ensureBeamPoint(displayPoints, i), targetPoints[i]);
  }

  proj.obstructionT = target.obstructionT;
  proj.endpointDamageable = target.endpointDamageable !== false;

  const start = displayPoints[0];
  if (start !== undefined) {
    entity.transform.x = start.x;
    entity.transform.y = start.y;
    entity.transform.z = start.z;
    const second = displayPoints[1];
    if (second !== undefined) {
      entity.transform.rotation = Math.atan2(second.y - start.y, second.x - start.x);
    }
  }

  return oldLength !== targetPoints.length || targetPoints.length > 0;
}
