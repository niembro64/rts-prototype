import { angleDeltaAbs } from '../math';
import {
  blendQuatShortestInPlace,
  clientUnitPredictionIsSettled,
  quatYaw,
} from './ClientUnitPrediction';
import { createServerTarget } from './ClientPredictionTargets';
import type { Entity } from '../sim/types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[client unit prediction contract] ${message}`);
  }
}

function yawQuat(yaw: number): { x: number; y: number; z: number; w: number } {
  return {
    x: 0,
    y: 0,
    z: Math.sin(yaw * 0.5),
    w: Math.cos(yaw * 0.5),
  };
}

export function runClientUnitPredictionContractTest(): void {
  const nearlyPositivePi = Math.PI - 0.01;
  const nearlyNegativePi = -Math.PI + 0.01;
  const current = yawQuat(nearlyPositivePi);
  const target = yawQuat(nearlyNegativePi);

  blendQuatShortestInPlace(current, target, 0.5);

  assertContract(
    angleDeltaAbs(quatYaw(current), Math.PI) < 0.001,
    'quaternion EMA crosses 0/360 by the shortest arc',
  );
  assertContract(
    Math.abs(quatYaw(current)) > Math.PI * 0.75,
    'quaternion EMA must not collapse through yaw zero at the wrap boundary',
  );

  const equivalent = yawQuat(nearlyPositivePi);
  equivalent.x = -equivalent.x;
  equivalent.y = -equivalent.y;
  equivalent.z = -equivalent.z;
  equivalent.w = -equivalent.w;
  blendQuatShortestInPlace(current, equivalent, 0.5);

  assertContract(
    Math.abs(quatYaw(current)) > Math.PI * 0.75,
    'quaternion EMA treats q and -q as the same orientation',
  );

  const turningEntity = {
    transform: { x: 0, y: 0, z: 0, rotation: 0 },
    unit: {
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      angularVelocity3: { x: 0, y: 0, z: 0.25 },
      orientation: yawQuat(0),
    },
    combat: null,
  } as unknown as Entity;
  const matchingTarget = createServerTarget();
  matchingTarget.orientation = yawQuat(0);
  matchingTarget.angularVelocityX = 0;
  matchingTarget.angularVelocityY = 0;
  matchingTarget.angularVelocityZ = 0.25;

  assertContract(
    !clientUnitPredictionIsSettled(turningEntity, matchingTarget, true),
    'turning units stay in active per-frame prediction while angular velocity is non-zero',
  );
}
