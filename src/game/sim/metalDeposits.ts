import type { MetalDeposit } from '../../metalDepositConfig';

export function depositCoversFootprint(
  deposit: MetalDeposit,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): boolean {
  const dx = centerX - deposit.x;
  const dy = centerY - deposit.y;
  const maxCornerDistance = Math.hypot(Math.max(0, halfWidth), Math.max(0, halfHeight));
  const allowedCenterRadius = deposit.flatRadius - maxCornerDistance;
  if (allowedCenterRadius < 0) return false;
  return dx * dx + dy * dy <= allowedCenterRadius * allowedCenterRadius;
}

export function findDepositCoveringFootprint(
  deposits: ReadonlyArray<MetalDeposit>,
  centerX: number,
  centerY: number,
  halfWidth: number,
  halfHeight: number,
): MetalDeposit | null {
  for (const deposit of deposits) {
    if (depositCoversFootprint(deposit, centerX, centerY, halfWidth, halfHeight)) {
      return deposit;
    }
  }
  return null;
}
