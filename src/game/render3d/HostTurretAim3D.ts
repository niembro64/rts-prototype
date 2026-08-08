import { codeToTurretState } from '../../types/network';
import type { Turret, TurretState } from '../sim/types';
import type { ClientRenderTurretHostRows } from './ClientRenderTurretStateSlab';

/** Host-readable view of one mounted turret's current aim.
 *
 * The turret remains authoritative for targeting and for its own visible
 * yaw/pitch. Hosts may read this value to add secondary, intentional-looking
 * body motion, but they never rewrite or replace the turret pose through this
 * contract. The client render slab is preferred because it is the same pose
 * used by turret presentation; the entity mirror is the non-slab fallback. */
export type HostTurretAimSample3D = {
  turretIndex: number;
  yaw: number;
  pitch: number;
  state: TurretState;
};

export function readHostTurretAimSample3D(
  turretRows: ClientRenderTurretHostRows | undefined,
  turrets: readonly Turret[],
  turretIndex: number,
  out: HostTurretAimSample3D,
): boolean {
  const turret = turrets[turretIndex];
  if (turret === undefined) return false;

  const useState = turretRows !== undefined && turretIndex < turretRows.count;
  const row = (turretRows?.start ?? 0) + turretIndex;
  out.turretIndex = turretIndex;
  out.yaw = useState ? turretRows.views.rotation[row] : turret.rotation;
  out.pitch = useState ? turretRows.views.pitch[row] : turret.pitch;
  out.state = useState
    ? codeToTurretState(turretRows.views.stateCode[row])
    : turret.state;
  return true;
}
