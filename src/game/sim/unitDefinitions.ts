// Single helper that materializes the runtime turret list for a unit
// from its blueprint. The rest of what used to live here
// (projectUnitBlueprint, getUnitDefinition, getAllUnitDefinitions,
// the UnitType/LocomotionType re-exports) was a back-compat layer
// nobody imported any more — readers want UNIT_BLUEPRINTS or
// getUnitBlueprint() directly from ./blueprints now.

import type { Turret } from './types';
import { getTurretConfig, computeTurretRanges } from './turretConfigs';
import { getUnitBlueprint } from './blueprints';
import { createRuntimeTurretMount } from './turretMounts';

export function createTurretsFromDefinition(unitId: string, radius: number): Turret[] {
  const bp = getUnitBlueprint(unitId);
  const turrets: Turret[] = [];

  for (let i = 0; i < bp.turrets.length; i++) {
    const mount = bp.turrets[i];
    const turretConfig = getTurretConfig(mount.turretId);
    if (mount.visualVariant !== undefined) {
      turretConfig.visualVariant = mount.visualVariant;
    }
    const ranges = computeTurretRanges(turretConfig);
    const turnAccel = turretConfig.angular.turnAccel;
    const drag = turretConfig.angular.drag;

    const localMount = createRuntimeTurretMount(mount, radius);

    // Initial pitch comes from the blueprint's `idlePitch` knob (e.g.
    // mirror turrets rest pointing straight up at π/2). Once the aim
    // solver runs, this is overwritten per-tick and the damper takes
    // over — `idlePitch` only governs the spawn pose.
    turrets.push({
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
      mount: localMount,
      worldPos: { x: 0, y: 0, z: 0 },
      worldVelocity: { x: 0, y: 0, z: 0 },
    });
  }

  return turrets;
}
