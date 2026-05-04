// Unit Definitions — now delegates to the blueprint system
// Kept for backward compatibility of type exports and createTurretsFromDefinition

import type { Turret } from './types';
import { getTurretConfig, computeTurretRanges } from './turretConfigs';
import { getUnitBlueprint, UNIT_BLUEPRINTS } from './blueprints';
import type { UnitBlueprint } from './blueprints';
import { createUnitLocomotion } from './locomotion';
import type { LocomotionType } from './locomotion';
import { createRuntimeTurretMount } from './turretMounts';

// Re-export types (still used by many files)
export type UnitType = keyof typeof UNIT_BLUEPRINTS;
export type { LocomotionType } from './locomotion';

// Create turrets for a unit using its blueprint
export function createTurretsFromDefinition(unitId: string, radius: number): Turret[] {
  const bp = getUnitBlueprint(unitId);
  const turrets: Turret[] = [];

  for (let i = 0; i < bp.turrets.length; i++) {
    const mount = bp.turrets[i];
    const turretConfig = getTurretConfig(mount.turretId);
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

function projectUnitBlueprint(bp: UnitBlueprint) {
  const locomotion = createUnitLocomotion(bp.locomotion);
  const turrets = bp.turrets.map((turret) => ({
    turretId: turret.turretId,
    mount: { ...turret.mount },
  }));
  return {
    id: bp.id as UnitType,
    name: bp.name,
    turretIds: turrets.map((turret) => turret.turretId),
    turrets,
    hp: bp.hp,
    locomotionPhysics: {
      driveForce: locomotion.driveForce,
      traction: locomotion.traction,
    },
    unitRadiusCollider: { ...bp.unitRadiusCollider },
    bodyRadius: bp.bodyRadius,
    bodyCenterHeight: bp.bodyCenterHeight,
    cost: { ...bp.cost },
    locomotion: locomotion.type as LocomotionType,
  };
}

// Backward-compatible lookup helpers. These now project the full unit
// blueprint instead of collapsing a multi-turret unit to one weapon id.
export function getUnitDefinition(unitId: string) {
  const bp = UNIT_BLUEPRINTS[unitId];
  if (!bp) return undefined;
  return projectUnitBlueprint(bp);
}

export function getAllUnitDefinitions() {
  return Object.values(UNIT_BLUEPRINTS).map(projectUnitBlueprint);
}
