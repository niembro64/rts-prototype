import type { Turret } from '../sim/types';
import { isShieldPanelTurret } from '../sim/shieldPanelRuntime';

export const NO_SHIELD_PANEL_TURRET_INDEX = -1;

type TurretMountLike = {
  readonly mount: { readonly y: number; readonly z: number };
};

/** Visual-only roll is safe only when every turret lies on the body's
 *  forward/roll axis. Off-axis combat mounts keep the whole presented
 *  host on its authoritative orientation so rendered centers and shot
 *  origins cannot diverge. */
export function unitTurretsAllowVisualBank3D(
  turrets: readonly TurretMountLike[],
): boolean {
  for (let i = 0; i < turrets.length; i++) {
    const mount = turrets[i].mount;
    if (mount.y !== 0 || mount.z !== 0) return false;
  }
  return true;
}

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
