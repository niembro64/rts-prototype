import type { Turret } from '../sim/types';

export const NO_PASSIVE_TURRET_INDEX = -1;

const passiveTurretIndexCache = new WeakMap<readonly Turret[], number>();

export function getPassiveTurretIndex(turrets: readonly Turret[]): number {
  if (turrets.length === 0) return NO_PASSIVE_TURRET_INDEX;
  const cached = passiveTurretIndexCache.get(turrets);
  if (cached !== undefined) return cached;
  for (let i = 0; i < turrets.length; i++) {
    if (turrets[i].config.passive) {
      passiveTurretIndexCache.set(turrets, i);
      return i;
    }
  }
  passiveTurretIndexCache.set(turrets, NO_PASSIVE_TURRET_INDEX);
  return NO_PASSIVE_TURRET_INDEX;
}
