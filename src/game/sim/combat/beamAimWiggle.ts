import type { BeamAimWiggleConfig } from '@/types/blueprintSchema.generated';
import { deterministicMath as DMath } from '../deterministicMath';

export type BeamAimWiggleOutput = {
  startX: number;
  startY: number;
  startZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
};

const U32_MAX = 0xffff_ffff;

function hashU32(value: number): number {
  let hash = value | 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function signedNoise(seed: number, bucket: number, channel: number): number {
  const mixed =
    (seed | 0) ^
    Math.imul((bucket + 1) | 0, 0x9e3779b1) ^
    Math.imul((channel + 1) | 0, 0x85ebca6b);
  return (hashU32(mixed) / U32_MAX) * 2 - 1;
}

function smoothStep01(value: number): number {
  return value * value * (3 - 2 * value);
}

/** Apply deterministic, smoothly changing imprecision to one physical beam
 * trace. The nominal turret socket and barrel direction remain authoritative;
 * the authored wiggle perturbs the trace itself until Precision Targeting is
 * active. This is gameplay truth, so samples are stateless hashes of stable
 * launch identity and fixed ticks rather than wall-clock or renderer noise. */
export function writeBeamAimWiggle(
  startX: number,
  startY: number,
  startZ: number,
  directionX: number,
  directionY: number,
  directionZ: number,
  config: BeamAimWiggleConfig,
  sourceTurretEntityId: number,
  spawnTick: number,
  currentTick: number,
  randomnessEnabled: boolean,
  out: BeamAimWiggleOutput,
): BeamAimWiggleOutput {
  let directionLength = DMath.hypot(directionX, directionY, directionZ);
  if (!Number.isFinite(directionLength) || directionLength <= 1e-12) {
    directionX = 1;
    directionY = 0;
    directionZ = 0;
    directionLength = 1;
  }
  directionX /= directionLength;
  directionY /= directionLength;
  directionZ /= directionLength;

  out.startX = startX;
  out.startY = startY;
  out.startZ = startZ;
  out.dirX = directionX;
  out.dirY = directionY;
  out.dirZ = directionZ;
  if (!randomnessEnabled) return out;

  const periodTicks = Math.max(1, Math.floor(config.periodTicks));
  const elapsedTicks = Math.max(0, Math.floor(currentTick) - Math.floor(spawnTick));
  const bucket = Math.floor(elapsedTicks / periodTicks);
  const phase = smoothStep01((elapsedTicks % periodTicks) / periodTicks);
  const seed =
    (sourceTurretEntityId | 0) ^
    Math.imul((Math.floor(spawnTick) + 1) | 0, 0x27d4eb2d);

  let originX0 = signedNoise(seed, bucket, 0);
  let originY0 = signedNoise(seed, bucket, 1);
  const originLength0 = DMath.hypot(originX0, originY0);
  if (originLength0 > 1) {
    originX0 /= originLength0;
    originY0 /= originLength0;
  }
  let originX1 = signedNoise(seed, bucket + 1, 0);
  let originY1 = signedNoise(seed, bucket + 1, 1);
  const originLength1 = DMath.hypot(originX1, originY1);
  if (originLength1 > 1) {
    originX1 /= originLength1;
    originY1 /= originLength1;
  }

  let directionOffsetX0 = signedNoise(seed, bucket, 2);
  let directionOffsetY0 = signedNoise(seed, bucket, 3);
  const directionOffsetLength0 = DMath.hypot(directionOffsetX0, directionOffsetY0);
  if (directionOffsetLength0 > 1) {
    directionOffsetX0 /= directionOffsetLength0;
    directionOffsetY0 /= directionOffsetLength0;
  }
  let directionOffsetX1 = signedNoise(seed, bucket + 1, 2);
  let directionOffsetY1 = signedNoise(seed, bucket + 1, 3);
  const directionOffsetLength1 = DMath.hypot(directionOffsetX1, directionOffsetY1);
  if (directionOffsetLength1 > 1) {
    directionOffsetX1 /= directionOffsetLength1;
    directionOffsetY1 /= directionOffsetLength1;
  }

  const originX = originX0 + (originX1 - originX0) * phase;
  const originY = originY0 + (originY1 - originY0) * phase;
  const directionOffsetX = directionOffsetX0 + (directionOffsetX1 - directionOffsetX0) * phase;
  const directionOffsetY = directionOffsetY0 + (directionOffsetY1 - directionOffsetY0) * phase;

  let basisX: number;
  let basisY: number;
  let basisZ: number;
  if (Math.abs(directionZ) < 0.9) {
    basisX = -directionY;
    basisY = directionX;
    basisZ = 0;
  } else {
    basisX = directionZ;
    basisY = 0;
    basisZ = -directionX;
  }
  const basisLength = DMath.hypot(basisX, basisY, basisZ);
  basisX /= basisLength;
  basisY /= basisLength;
  basisZ /= basisLength;
  const tangentX = directionY * basisZ - directionZ * basisY;
  const tangentY = directionZ * basisX - directionX * basisZ;
  const tangentZ = directionX * basisY - directionY * basisX;

  const originRadius = Math.max(0, config.originRadius);
  out.startX += (basisX * originX + tangentX * originY) * originRadius;
  out.startY += (basisY * originX + tangentY * originY) * originRadius;
  out.startZ += (basisZ * originX + tangentZ * originY) * originRadius;

  const tangentScale = DMath.tan(Math.max(0, config.maxDirectionAngle));
  let wiggledX = directionX + (basisX * directionOffsetX + tangentX * directionOffsetY) * tangentScale;
  let wiggledY = directionY + (basisY * directionOffsetX + tangentY * directionOffsetY) * tangentScale;
  let wiggledZ = directionZ + (basisZ * directionOffsetX + tangentZ * directionOffsetY) * tangentScale;
  const wiggledLength = DMath.hypot(wiggledX, wiggledY, wiggledZ);
  if (wiggledLength > 1e-12) {
    wiggledX /= wiggledLength;
    wiggledY /= wiggledLength;
    wiggledZ /= wiggledLength;
  }
  out.dirX = wiggledX;
  out.dirY = wiggledY;
  out.dirZ = wiggledZ;
  return out;
}
