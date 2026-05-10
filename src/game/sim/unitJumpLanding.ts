import { GRAVITY } from '../../config';
import { isFarFromWater } from './Terrain';

const JUMP_LANDING_MIN_WATER_CLEARANCE = 12;
const JUMP_LANDING_RADIUS_WATER_PADDING = 5;
const JUMP_LANDING_SAMPLE_RATE = 30;
const JUMP_LANDING_MIN_SAMPLES = 6;
const JUMP_LANDING_MAX_SAMPLES = 36;
const JUMP_LANDING_TERRAIN_VARIANCE_TIME_SEC = 0.35;
const JUMP_LANDING_MIN_TIME_SEC = 1 / 60;
const JUMP_LANDING_MAX_TIME_SEC = 3;

export type JumpLandingBody = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mass: number;
  radius: number;
  groundOffset: number;
};

export type JumpLandingOptions = {
  dtSec: number;
  launchForce: number;
  mapWidth: number;
  mapHeight: number;
  getGroundZ: (x: number, y: number) => number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.ceil(value)));
}

function isFiniteJumpBody(body: JumpLandingBody): boolean {
  return (
    Number.isFinite(body.x) &&
    Number.isFinite(body.y) &&
    Number.isFinite(body.z) &&
    Number.isFinite(body.vx) &&
    Number.isFinite(body.vy) &&
    Number.isFinite(body.vz) &&
    Number.isFinite(body.mass) &&
    Number.isFinite(body.radius) &&
    Number.isFinite(body.groundOffset)
  );
}

export function canJumpLandAwayFromWater(
  body: JumpLandingBody,
  options: JumpLandingOptions,
): boolean {
  if (
    !isFiniteJumpBody(body) ||
    !Number.isFinite(options.dtSec) ||
    !Number.isFinite(options.launchForce) ||
    body.mass <= 0 ||
    options.dtSec <= 0 ||
    options.launchForce <= 0
  ) {
    return false;
  }

  const launchDeltaVz = (options.launchForce / body.mass) * options.dtSec;
  const launchVz = body.vz + launchDeltaVz;
  const startGroundPointZ = body.z - body.groundOffset;
  const startGroundZ = options.getGroundZ(body.x, body.y);
  const startHeight = Math.max(0, startGroundPointZ - startGroundZ);
  const upwardVz = Math.max(0, launchVz);
  const sameHeightFlightTime =
    (upwardVz + Math.sqrt(upwardVz * upwardVz + 2 * GRAVITY * startHeight)) /
    GRAVITY;
  const maxFlightTime = clamp(
    sameHeightFlightTime + JUMP_LANDING_TERRAIN_VARIANCE_TIME_SEC,
    JUMP_LANDING_MIN_TIME_SEC,
    JUMP_LANDING_MAX_TIME_SEC,
  );
  const sampleCount = clampInt(
    maxFlightTime * JUMP_LANDING_SAMPLE_RATE,
    JUMP_LANDING_MIN_SAMPLES,
    JUMP_LANDING_MAX_SAMPLES,
  );
  const waterClearance = Math.max(
    JUMP_LANDING_MIN_WATER_CLEARANCE,
    body.radius + JUMP_LANDING_RADIUS_WATER_PADDING,
  );

  let finalX = body.x;
  let finalY = body.y;
  for (let i = 1; i <= sampleCount; i++) {
    const t = (maxFlightTime * i) / sampleCount;
    const x = body.x + body.vx * t;
    const y = body.y + body.vy * t;
    const groundPointZ = startGroundPointZ + launchVz * t - 0.5 * GRAVITY * t * t;
    const groundZ = options.getGroundZ(x, y);
    finalX = x;
    finalY = y;
    if (groundPointZ <= groundZ) {
      return isFarFromWater(x, y, options.mapWidth, options.mapHeight, waterClearance);
    }
  }

  return isFarFromWater(finalX, finalY, options.mapWidth, options.mapHeight, waterClearance);
}
