import type * as THREE from 'three';

// Visual-only bank for hover/flying chassis. The sim writes yaw-only
// orientation; the renderer composes a body-frame roll from centripetal
// acceleration so airborne units visibly lean into sustained turns.
const AIRBORNE_BANK_PER_LATERAL_A = 0.003;
const AIRBORNE_BANK_MAX = Math.PI * 0.25;
const AIRBORNE_BANK_TAU_SEC = 0.18;

export function applyAirborneBankRoll3D(
  yawGroup: THREE.Object3D,
  previousRoll: number | undefined,
  params: {
    velocityX: number;
    velocityY: number;
    yawRadians: number;
    yawRate: number;
    spinDtSec: number;
  },
): number {
  const cosY = Math.cos(params.yawRadians);
  const sinY = Math.sin(params.yawRadians);
  const vForward = params.velocityX * cosY + params.velocityY * sinY;
  const aLateral = -vForward * params.yawRate;
  let target = AIRBORNE_BANK_PER_LATERAL_A * aLateral;
  if (target > AIRBORNE_BANK_MAX) target = AIRBORNE_BANK_MAX;
  else if (target < -AIRBORNE_BANK_MAX) target = -AIRBORNE_BANK_MAX;
  const alpha = params.spinDtSec > 0
    ? Math.exp(-params.spinDtSec / AIRBORNE_BANK_TAU_SEC)
    : 1;
  const smoothed = alpha * (previousRoll ?? 0) + (1 - alpha) * target;
  yawGroup.rotateX(-smoothed);
  return smoothed;
}

export function applyAirborneBankToParentQuat3D(
  parentQuat: THREE.Quaternion,
  bankQuat: THREE.Quaternion,
  roll: number | undefined,
): void {
  if (roll === undefined || roll === 0) return;
  const bankHalfAngle = -roll * 0.5;
  bankQuat.set(Math.sin(bankHalfAngle), 0, 0, Math.cos(bankHalfAngle));
  parentQuat.multiply(bankQuat);
}
