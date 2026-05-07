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
  surfaceNormalX: number;
  surfaceNormalY: number;
  surfaceNormalZ: number;
  turrets: {
    rotation: number;
    angularVelocity: number;
    pitch: number;
    forceFieldRange: number | undefined;
  }[];
};

export function createServerTarget(): ServerTarget {
  return {
    x: 0, y: 0, z: 0, rotation: 0,
    velocityX: 0, velocityY: 0, velocityZ: 0,
    surfaceNormalX: 0, surfaceNormalY: 0, surfaceNormalZ: 1,
    turrets: [],
  };
}

export type BeamPathTarget = {
  points: BeamPoint[];
  obstructionT?: number;
};

export function createBeamPathTarget(): BeamPathTarget {
  return { points: [] };
}

export function ensureBeamPoint(arr: BeamPoint[], i: number): BeamPoint {
  let point = arr[i];
  if (!point) {
    point = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    arr[i] = point;
  }
  return point;
}
