// Unit Definitions — now delegates to the blueprint system
// Kept for backward compatibility of type exports and createTurretsFromDefinition

import type { Turret } from './types';
import { getTurretConfig, computeTurretRanges } from './turretConfigs';
import { getUnitBlueprint, UNIT_BLUEPRINTS } from './blueprints';

// Re-export types (still used by many files)
export type { LegStyle } from './blueprints/types';
export type UnitType = 'jackal' | 'lynx' | 'daddy' | 'badger' | 'mongoose'
  | 'tick' | 'mammoth' | 'widow' | 'hippo' | 'tarantula' | 'commander';
export type LocomotionType = 'wheels' | 'treads' | 'legs';

// Create turrets for a unit using its blueprint
export function createTurretsFromDefinition(unitId: string, radius: number): Turret[] {
  const bp = getUnitBlueprint(unitId);
  const turrets: Turret[] = [];
  const mounts = bp.chassisMounts;

  for (let i = 0; i < bp.turrets.length; i++) {
    const mount = bp.turrets[i];
    const turretConfig = getTurretConfig(mount.turretId);
    const ranges = computeTurretRanges(turretConfig);
    const turnAccel = turretConfig.angular.turnAccel;
    const drag = turretConfig.angular.drag;

    // Override tracking acquire range if blueprint specifies seeRange
    if (bp.seeRange != null) {
      const ratio = ranges.tracking.release / ranges.tracking.acquire;
      ranges.tracking.acquire = bp.seeRange;
      ranges.tracking.release = bp.seeRange * ratio;
    }

    // For multi-turret units (widow), offsets come from chassisMounts (world-space fractions of radius)
    // For single-turret units, offsets are 0,0
    const chassisMount = mounts[Math.min(i, mounts.length - 1)];
    const offsetX = chassisMount.x * radius;
    const offsetY = chassisMount.y * radius;

    turrets.push({
      config: { ...turretConfig },
      cooldown: 0,
      target: null,
      ranges,
      state: 'idle',
      rotation: 0,
      angularVelocity: 0,
      turnAccel,
      drag,
      offset: { x: offsetX, y: offsetY },
    });
  }

  return turrets;
}

// Backward-compatible lookup helpers
export function getUnitDefinition(unitId: string) {
  const bp = UNIT_BLUEPRINTS[unitId];
  if (!bp) return undefined;
  // Return a shim that looks enough like the old UnitDefinition
  return {
    id: bp.id as UnitType,
    name: bp.name,
    weaponType: bp.turrets[0]?.turretId ?? 'lightTurret',
    hp: bp.hp,
    moveSpeed: bp.moveSpeed,
    radiusColliderUnitShot: bp.unitRadiusColliderShot,
    energyCost: bp.baseCost,
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
    moveSpeed: bp.moveSpeed,
    radiusColliderUnitShot: bp.unitRadiusColliderShot,
    energyCost: bp.baseCost,
    locomotion: bp.locomotion.type as LocomotionType,
    legStyle: bp.locomotion.type === 'legs' ? bp.locomotion.style : undefined,
  }));
}
