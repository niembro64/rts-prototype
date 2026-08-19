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

const shieldFieldReachCache = new WeakMap<readonly Turret[], number>();

/**
 * The widest shield field this host projects, or 0 when it projects none.
 *
 * A field reaches well past the body carrying it, so a host can be off the
 * unit render scope while its dome is still on screen. The render scope has
 * to cover the field for the host to be posed at all — the bubble composes
 * through that pose (HostRenderPoseStore3D) and is not drawn without it.
 */
export function shieldFieldRenderReach3D(turrets: readonly Turret[]): number {
  if (turrets.length === 0) return 0;
  const cached = shieldFieldReachCache.get(turrets);
  if (cached !== undefined) return cached;
  let reach = 0;
  for (let i = 0; i < turrets.length; i++) {
    const shot = turrets[i].config.shot;
    if (shot === null || shot === undefined) continue;
    if (shot.type !== 'shield') continue;
    const barrier = shot.barrier;
    if (barrier === null || barrier === undefined) continue;
    if (barrier.outerRange > reach) reach = barrier.outerRange;
  }
  shieldFieldReachCache.set(turrets, reach);
  return reach;
}
