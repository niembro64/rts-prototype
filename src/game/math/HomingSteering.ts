// Homing steering helper - shared by projectileSystem (server) and ClientViewState (client)

import { normalizeAngle } from './MathHelpers';

// Reusable output object to avoid per-call allocations
const _hsOut = { velocityX: 0, velocityY: 0, rotation: 0 };

// Turn velocity toward a target at a clamped turn rate, preserving speed.
// Returns new velocityX, velocityY, rotation via a reusable object.
export function applyHomingSteering(
  velX: number, velY: number,
  targetX: number, targetY: number,
  currentX: number, currentY: number,
  homingTurnRate: number, dtSec: number
): { velocityX: number; velocityY: number; rotation: number } {
  const dx = targetX - currentX;
  const dy = targetY - currentY;
  const desiredAngle = Math.atan2(dy, dx);
  const currentAngle = Math.atan2(velY, velX);

  const angleDiff = normalizeAngle(desiredAngle - currentAngle);

  const maxTurn = homingTurnRate * dtSec;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDiff));

  const newAngle = currentAngle + turn;
  const speed = Math.sqrt(velX * velX + velY * velY);
  _hsOut.velocityX = Math.cos(newAngle) * speed;
  _hsOut.velocityY = Math.sin(newAngle) * speed;
  _hsOut.rotation = newAngle;
  return _hsOut;
}
