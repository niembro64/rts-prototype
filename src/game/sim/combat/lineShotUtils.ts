import type { LineShot } from '../types';

export function getLineShotDamageSphereRadius(shot: LineShot): number {
  return shot.damageSphere.radius;
}
