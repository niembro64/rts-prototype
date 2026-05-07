// Helpers that materialize the runtime turret list for a host
// (a unit or a building) from its blueprint. Both helpers produce
// identical Turret objects; the only difference is the mount math:
//
//   - Unit blueprints author mounts as fractions of body radius, so
//     the runtime mount is `mount × bodyRadius`.
//   - Building blueprints author mounts in absolute world units.
//
// The downstream combat pipeline never sees this distinction —
// turret.mount is always a Vec3 in world units relative to the host
// transform. Unit & building hosts share the same combat code.

import type { Turret, BuildingType } from './types';
import type { BuildingTurretMount } from '../../types/blueprints';
import { getTurretConfig, computeTurretRanges } from './turretConfigs';
import { getUnitBlueprint, getBuildingBlueprint } from './blueprints';
import { createRuntimeTurretMount } from './turretMounts';

function makeRuntimeTurret(
  turretId: string,
  mount: { x: number; y: number; z: number },
  visualVariant?: BuildingTurretMount['visualVariant'],
): Turret {
  const turretConfig = getTurretConfig(turretId);
  if (visualVariant !== undefined) {
    turretConfig.visualVariant = visualVariant;
  }
  const ranges = computeTurretRanges(turretConfig);
  const turnAccel = turretConfig.angular.turnAccel;
  const drag = turretConfig.angular.drag;
  // Initial pitch comes from the blueprint's `idlePitch` knob (e.g.
  // mirror turrets rest pointing straight up at π/2). Once the aim
  // solver runs, this is overwritten per-tick and the damper takes
  // over — `idlePitch` only governs the spawn pose.
  return {
    config: { ...turretConfig },
    cooldown: 0,
    target: null,
    ranges,
    state: 'idle',
    rotation: 0,
    pitch: turretConfig.idlePitch ?? 0,
    angularVelocity: 0,
    pitchVelocity: 0,
    turnAccel,
    drag,
    mount,
    worldPos: { x: 0, y: 0, z: 0 },
    worldVelocity: { x: 0, y: 0, z: 0 },
  };
}

export function createUnitRuntimeTurrets(unitId: string, radius: number): Turret[] {
  const bp = getUnitBlueprint(unitId);
  const turrets: Turret[] = [];
  for (let i = 0; i < bp.turrets.length; i++) {
    const mount = bp.turrets[i];
    const localMount = createRuntimeTurretMount(mount, radius);
    turrets.push(makeRuntimeTurret(mount.turretId, localMount, mount.visualVariant));
  }
  return turrets;
}

/** Build the runtime turret list for a building. Building mounts are
 *  authored in absolute world units (not body-radius fractions), so
 *  the mount value is copied through verbatim. Returns an empty array
 *  when the blueprint declares no turrets. */
export function createBuildingRuntimeTurrets(buildingType: BuildingType): Turret[] {
  const bp = getBuildingBlueprint(buildingType);
  const mounts = bp.turrets;
  if (!mounts || mounts.length === 0) return [];
  const turrets: Turret[] = [];
  for (let i = 0; i < mounts.length; i++) {
    const m = mounts[i];
    turrets.push(makeRuntimeTurret(
      m.turretId,
      { x: m.mount.x, y: m.mount.y, z: m.mount.z },
      m.visualVariant,
    ));
  }
  return turrets;
}
