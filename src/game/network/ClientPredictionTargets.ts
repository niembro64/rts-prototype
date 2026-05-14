import type { BeamPoint } from '../../types/sim';

// Lightweight copy of server state used for per-frame drift in client prediction.
// Owns its data instead of retaining references to pooled serializer objects.
export type ServerTarget = {
  x: number;
  y: number;
  z: number;
  rotation: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  movementAccelX: number;
  movementAccelY: number;
  movementAccelZ: number;
  surfaceNormalX: number;
  surfaceNormalY: number;
  surfaceNormalZ: number;
  bodyCenterHeight: number;
  jumpActive: boolean;
  jumpLaunchSeq: number;
  predictedGroundContact: boolean;
  /** Full 3-DOF orientation triad, populated only when the snapshot
   *  carries an `orientation` field (hover units etc.). Undefined for
   *  ground units — the client reads `rotation` (yaw scalar) when
   *  these are absent. */
  orientation?: { x: number; y: number; z: number; w: number };
  angularVelocityX?: number;
  angularVelocityY?: number;
  angularVelocityZ?: number;
  angularAccelerationX?: number;
  angularAccelerationY?: number;
  angularAccelerationZ?: number;
  turrets: {
    rotation: number;
    angularVelocity: number;
    angularAcceleration: number;
    pitch: number;
    pitchVelocity: number;
    pitchAcceleration: number;
    forceFieldRange: number | undefined;
  }[];
};

export function createServerTarget(): ServerTarget {
  return {
    x: 0, y: 0, z: 0, rotation: 0,
    velocityX: 0, velocityY: 0, velocityZ: 0,
    movementAccelX: 0, movementAccelY: 0, movementAccelZ: 0,
    surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 1,
    bodyCenterHeight: 0,
    jumpActive: false,
    jumpLaunchSeq: 0,
    predictedGroundContact: true,
    turrets: [],
  };
}

export type BeamPathTarget = {
  points: BeamPoint[];
  obstructionT?: number;
  endpointDamageable?: boolean;
};

export function createBeamPathTarget(): BeamPathTarget {
  return { points: [] };
}

// Module-level free list of BeamPoint objects. Beam paths grow and
// shrink as reflections come and go (a beam tracking a moving target
// across mirrors can gain or lose entries every frame). Without a
// pool, every length truncation drops the trailing point objects to
// GC and every regrowth allocates fresh ones — pure churn for a value
// type that's recycled minutes later.
const _beamPointFreeList: BeamPoint[] = [];

function clearBeamPoint(p: BeamPoint): void {
  p.x = 0; p.y = 0; p.z = 0;
  p.vx = 0; p.vy = 0; p.vz = 0;
  p.ax = 0; p.ay = 0; p.az = 0;
  p.mirrorEntityId = undefined;
  p.reflectorKind = undefined;
  p.reflectorPlayerId = undefined;
  p.normalX = undefined;
  p.normalY = undefined;
  p.normalZ = undefined;
}

function acquireBeamPoint(): BeamPoint {
  const pooled = _beamPointFreeList.pop();
  if (pooled) return pooled;
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0 };
}

/** Truncate `arr` to `newLength`, returning the trailing point objects
 *  to the free list. Optional fields are cleared so the next acquire
 *  gets a clean slate without stale reflector metadata. */
export function shrinkBeamPoints(arr: BeamPoint[], newLength: number): void {
  for (let i = arr.length - 1; i >= newLength; i--) {
    const p = arr[i];
    if (p) {
      clearBeamPoint(p);
      _beamPointFreeList.push(p);
    }
  }
  arr.length = newLength;
}

export function ensureBeamPoint(arr: BeamPoint[], i: number): BeamPoint {
  let point = arr[i];
  if (!point) {
    point = acquireBeamPoint();
    arr[i] = point;
  }
  return point;
}
