import type { Turret } from '../sim/types';
import { isShieldPanelTurret } from '../sim/shieldPanelRuntime';

export const NO_SHIELD_PANEL_TURRET_INDEX = -1;

const shieldPanelTurretIndexCache = new WeakMap<readonly Turret[], number>();

export function getShieldPanelTurretIndex(turrets: readonly Turret[]): number {
  if (turrets.length === 0) return NO_SHIELD_PANEL_TURRET_INDEX;
  const cached = shieldPanelTurretIndexCache.get(turrets);
  if (cached !== undefined) return cached;
  for (let i = 0; i < turrets.length; i++) {
    if (isShieldPanelTurret(turrets[i])) {
      shieldPanelTurretIndexCache.set(turrets, i);
      return i;
    }
  }
  shieldPanelTurretIndexCache.set(turrets, NO_SHIELD_PANEL_TURRET_INDEX);
  return NO_SHIELD_PANEL_TURRET_INDEX;
}
