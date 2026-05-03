// Unit Definitions — now delegates to the blueprint system
// Kept for backward compatibility of type exports and createTurretsFromDefinition

import type { Turret } from './types';
import { getTurretConfig, computeTurretRanges } from './turretConfigs';
import { getUnitBlueprint, UNIT_BLUEPRINTS } from './blueprints';
import { createRuntimeTurretMount } from './turretMounts';

// Re-export types (still used by many files)
export type { LegStyle } from './blueprints/types';
export type UnitType = 'jackal' | 'lynx' | 'daddy' | 'badger' | 'mongoose'
  | 'tick' | 'mammoth' | 'widow' | 'formik' | 'hippo' | 'tarantula' | 'commander';
export type LocomotionType = 'wheels' | 'treads' | 'legs';

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

    turrets.push({
      config: { ...turretConfig },
      cooldown: 0,
      target: null,
      ranges,
      state: 'idle',
      rotation: 0,
      pitch: 0,
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

// Backward-compatible lookup helpers
export function getUnitDefinition(unitId: string) {
  const bp = UNIT_BLUEPRINTS[unitId];
  if (!bp) return undefined;
  return {
    id: bp.id as UnitType,
    name: bp.name,
    weaponType: bp.turrets[0]?.turretId ?? 'lightTurret',
    hp: bp.hp,
    locomotionPhysics: { ...bp.locomotion.physics },
    unitRadiusCollider: { ...bp.unitRadiusCollider },
    bodyRadius: bp.bodyRadius,
    bodyCenterHeight: bp.bodyCenterHeight,
    resourceCost: bp.resourceCost,
    locomotion: bp.locomotion.type as LocomotionType,
    legStyle: bp.locomotion.type === 'legs' ? bp.locomotion.style : undefined,
  };
}

export function getAllUnitDefinitions() {
  return Object.values(UNIT_BLUEPRINTS).map(bp => ({
    id: bp.id as UnitType,
    name: bp.name,
    weaponType: bp.turrets[0]?.turretId ?? 'lightTurret',
    hp: bp.hp,
    locomotionPhysics: { ...bp.locomotion.physics },
    unitRadiusCollider: { ...bp.unitRadiusCollider },
    bodyRadius: bp.bodyRadius,
    bodyCenterHeight: bp.bodyCenterHeight,
    resourceCost: bp.resourceCost,
    locomotion: bp.locomotion.type as LocomotionType,
    legStyle: bp.locomotion.type === 'legs' ? bp.locomotion.style : undefined,
  }));
}
