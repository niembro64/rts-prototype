// Unit Definitions — now delegates to the blueprint system
// Kept for backward compatibility of type exports and createWeaponsFromDefinition

import type { UnitWeapon } from './types';
import { getWeaponConfig, computeWeaponRanges } from './weapons';
import { getUnitBlueprint, UNIT_BLUEPRINTS } from './blueprints';

// Re-export types (still used by many files)
export type { LegStyle } from './blueprints/types';
export type UnitType = 'jackal' | 'lynx' | 'daddy' | 'badger' | 'mongoose'
  | 'tick' | 'mammoth' | 'widow' | 'tarantula' | 'commander';
export type LocomotionType = 'wheels' | 'treads' | 'legs';

// Create weapons for a unit using its blueprint
export function createWeaponsFromDefinition(unitId: string, radius: number): UnitWeapon[] {
  const bp = getUnitBlueprint(unitId);
  const weapons: UnitWeapon[] = [];
  const mounts = bp.chassisMounts;

  for (let i = 0; i < bp.weapons.length; i++) {
    const mount = bp.weapons[i];
    const weaponConfig = getWeaponConfig(mount.weaponId);
    const ranges = computeWeaponRanges(weaponConfig);
    const turretTurnAccel = weaponConfig.turretTurnAccel!;
    const turretDrag = weaponConfig.turretDrag!;

    // Override seeRange if blueprint specifies weaponSeeRange
    if (bp.weaponSeeRange != null) {
      ranges.seeRange = bp.weaponSeeRange;
    }

    // For multi-weapon units (widow), offsets come from chassisMounts (world-space fractions of radius)
    // For single-weapon units, offsets are 0,0
    const chassisMount = mounts[Math.min(i, mounts.length - 1)];
    const offsetX = chassisMount.x * radius;
    const offsetY = chassisMount.y * radius;

    weapons.push({
      config: { ...weaponConfig },
      currentCooldown: 0,
      targetEntityId: null,
      ...ranges,
      isLocked: false,
      turretRotation: 0,
      turretAngularVelocity: 0,
      turretTurnAccel,
      turretDrag,
      offsetX,
      offsetY,
      isFiring: false,
      inFightstopRange: false,
    });
  }

  return weapons;
}

// Backward-compatible lookup helpers
export function getUnitDefinition(unitId: string) {
  const bp = UNIT_BLUEPRINTS[unitId];
  if (!bp) return undefined;
  // Return a shim that looks enough like the old UnitDefinition
  return {
    id: bp.id as UnitType,
    name: bp.name,
    weaponType: bp.weapons[0]?.weaponId ?? 'gatlingTurret',
    hp: bp.hp,
    moveSpeed: bp.moveSpeed,
    collisionRadius: bp.collisionRadius,
    energyCost: bp.baseCost,
    locomotion: bp.locomotion.type as LocomotionType,
    legStyle: bp.locomotion.type === 'legs' ? bp.locomotion.style : undefined,
  };
}

export function getAllUnitDefinitions() {
  return Object.values(UNIT_BLUEPRINTS).map(bp => ({
    id: bp.id as UnitType,
    name: bp.name,
    weaponType: bp.weapons[0]?.weaponId ?? 'gatlingTurret',
    hp: bp.hp,
    moveSpeed: bp.moveSpeed,
    collisionRadius: bp.collisionRadius,
    energyCost: bp.baseCost,
    locomotion: bp.locomotion.type as LocomotionType,
    legStyle: bp.locomotion.type === 'legs' ? bp.locomotion.style : undefined,
  }));
}
