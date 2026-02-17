// Unified Unit Definition System
// All unit-type-specific configuration in one place

import type { UnitWeapon } from './types';
import { getWeaponConfig, type WeaponId } from './weapons';
import {
  COST_MULTIPLIER,
  UNIT_STATS,
  DEFAULT_TURRET_TURN_ACCEL,
  DEFAULT_TURRET_DRAG,
  RANGE_MULTIPLIERS,
} from '../../config';

// Union type of all unit type identifiers
export type UnitType = 'jackal' | 'lynx' | 'daddy' | 'badger' | 'scorpion'
  | 'recluse' | 'mammoth' | 'widow' | 'tarantula' | 'commander';

// Locomotion types for rendering
export type LocomotionType = 'wheels' | 'treads' | 'legs';

// Leg styles for legged units
export type LegStyle = 'widow' | 'daddy' | 'tarantula' | 'recluse' | 'commander';

// Unified unit definition - everything about a unit type in one place
export interface UnitDefinition {
  id: UnitType;
  name: string;

  // Weapon type (references WEAPON_CONFIGS key)
  weaponType: WeaponId;

  // Stats
  hp: number;
  moveSpeed: number;
  collisionRadius: number;

  // Build info
  energyCost: number;
  buildRate: number;

  // Locomotion (for rendering)
  locomotion: LocomotionType;
  legStyle?: LegStyle;

  // Weapon offset from unit center (in unit-local space, positive X = forward)
  weaponOffsetX?: number;

  // Custom weapon creation (for multi-weapon units like widow)
  createWeapons?: (radius: number, definition: UnitDefinition) => UnitWeapon[];
}

// Default weapon creation - single weapon matching unit type
// Range constraint: seeRange > fireRange > releaseRange > lockRange > fightstopRange
function createDefaultWeapons(_radius: number, definition: UnitDefinition): UnitWeapon[] {
  const weaponConfig = getWeaponConfig(definition.weaponType);
  const fireRange = weaponConfig.range;
  const seeRange = fireRange * RANGE_MULTIPLIERS.see;
  const releaseRange = fireRange * RANGE_MULTIPLIERS.release;
  const lockRange = fireRange * RANGE_MULTIPLIERS.lock;
  const fightstopRange = fireRange * RANGE_MULTIPLIERS.fightstop;
  const turretTurnAccel = weaponConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const turretDrag = weaponConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  return [{
    config: { ...weaponConfig },
    currentCooldown: 0,
    targetEntityId: null,
    seeRange,
    fireRange,
    releaseRange,
    lockRange,
    fightstopRange,
    isLocked: false,
    turretRotation: 0,
    turretAngularVelocity: 0,
    turretTurnAccel,
    turretDrag,
    offsetX: definition.weaponOffsetX ?? 0,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
  }];
}

// Widow weapon creation - 6 beam lasers at hexagon + 1 center beam + 1 force field
// Uses explicit widowBeam, widowCenterBeam, and widowForceField configs from config.ts
// Range constraint: seeRange > fireRange > releaseRange > lockRange > fightstopRange
function createWidowWeapons(radius: number, _definition: UnitDefinition): UnitWeapon[] {
  const widowBeamConfig = getWeaponConfig('widowBeam');
  const widowCenterBeamConfig = getWeaponConfig('widowCenterBeam');
  const widowForceFieldConfig = getWeaponConfig('widowForceField');

  // Beam weapon ranges
  const beamFireRange = widowBeamConfig.range;
  const beamSeeRange = beamFireRange * RANGE_MULTIPLIERS.see;
  const beamReleaseRange = beamFireRange * RANGE_MULTIPLIERS.release;
  const beamLockRange = beamFireRange * RANGE_MULTIPLIERS.lock;
  const beamFightstopRange = beamFireRange * RANGE_MULTIPLIERS.fightstop;
  const beamTurnAccel = widowBeamConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const beamDrag = widowBeamConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  // Center beam weapon ranges
  const centerBeamFireRange = widowCenterBeamConfig.range;
  const centerBeamSeeRange = centerBeamFireRange * RANGE_MULTIPLIERS.see;
  const centerBeamReleaseRange = centerBeamFireRange * RANGE_MULTIPLIERS.release;
  const centerBeamLockRange = centerBeamFireRange * RANGE_MULTIPLIERS.lock;
  const centerBeamFightstopRange = centerBeamFireRange * RANGE_MULTIPLIERS.fightstop;
  const centerBeamTurnAccel = widowCenterBeamConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const centerBeamDrag = widowCenterBeamConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  const weapons: UnitWeapon[] = [];

  // 6 beam lasers at hexagon vertices
  const hexRadius = radius * 0.65;
  const hexForwardOffset = radius * 0.5;
  const hexRotationOffset = Math.PI / 6;

  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 + hexRotationOffset;
    const offsetX = Math.cos(angle) * hexRadius + hexForwardOffset;
    const offsetY = Math.sin(angle) * hexRadius;
    weapons.push({
      config: { ...widowBeamConfig },
      currentCooldown: 0,
      targetEntityId: null,
      seeRange: beamSeeRange,
      fireRange: beamFireRange,
      releaseRange: beamReleaseRange,
      lockRange: beamLockRange,
      fightstopRange: beamFightstopRange,
      isLocked: false,
      turretRotation: 0,
      turretAngularVelocity: 0,
      turretTurnAccel: beamTurnAccel,
      turretDrag: beamDrag,
      offsetX,
      offsetY,
      isFiring: false,
      inFightstopRange: false,
    });
  }

  // 1 center beam at hexagon center (2x stats)
  weapons.push({
    config: { ...widowCenterBeamConfig },
    currentCooldown: 0,
    targetEntityId: null,
    seeRange: centerBeamSeeRange,
    fireRange: centerBeamFireRange,
    releaseRange: centerBeamReleaseRange,
    lockRange: centerBeamLockRange,
    fightstopRange: centerBeamFightstopRange,
    isLocked: false,
    turretRotation: 0,
    turretAngularVelocity: 0,
    turretTurnAccel: centerBeamTurnAccel,
    turretDrag: centerBeamDrag,
    offsetX: hexForwardOffset,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
  });

  // 1 force field weapon in center (dual push/pull zones)
  const ffFireRange = widowForceFieldConfig.range;
  const ffSeeRange = ffFireRange * RANGE_MULTIPLIERS.see;
  const ffReleaseRange = ffFireRange * RANGE_MULTIPLIERS.release;
  const ffLockRange = ffFireRange * RANGE_MULTIPLIERS.lock;
  const ffFightstopRange = ffFireRange * RANGE_MULTIPLIERS.fightstop;
  const ffTurnAccel = widowForceFieldConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const ffDrag = widowForceFieldConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  weapons.push({
    config: { ...widowForceFieldConfig },
    currentCooldown: 0,
    targetEntityId: null,
    seeRange: ffSeeRange,
    fireRange: ffFireRange,
    releaseRange: ffReleaseRange,
    lockRange: ffLockRange,
    fightstopRange: ffFightstopRange,
    isLocked: false,
    turretRotation: 0,
    turretAngularVelocity: 0,
    turretTurnAccel: ffTurnAccel,
    turretDrag: ffDrag,
    offsetX: hexForwardOffset,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
  });

  return weapons;
}

// Registry of all unit definitions
export const UNIT_DEFINITIONS: Record<string, UnitDefinition> = {
  jackal: {
    id: 'jackal',
    name: 'Jackal',
    weaponType: 'gatling',
    hp: UNIT_STATS.jackal.hp,
    moveSpeed: UNIT_STATS.jackal.moveSpeed,
    collisionRadius: UNIT_STATS.jackal.collisionRadius,
    energyCost: UNIT_STATS.jackal.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.jackal.buildRate,
    locomotion: 'wheels',
  },
  lynx: {
    id: 'lynx',
    name: 'Lynx',
    weaponType: 'pulse',
    hp: UNIT_STATS.lynx.hp,
    moveSpeed: UNIT_STATS.lynx.moveSpeed,
    collisionRadius: UNIT_STATS.lynx.collisionRadius,
    energyCost: UNIT_STATS.lynx.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.lynx.buildRate,
    locomotion: 'treads',
  },
  daddy: {
    id: 'daddy',
    name: 'Daddy',
    weaponType: 'beam',
    hp: UNIT_STATS.daddy.hp,
    moveSpeed: UNIT_STATS.daddy.moveSpeed,
    collisionRadius: UNIT_STATS.daddy.collisionRadius,
    energyCost: UNIT_STATS.daddy.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.daddy.buildRate,
    locomotion: 'legs',
    legStyle: 'daddy',
  },
  badger: {
    id: 'badger',
    name: 'Badger',
    weaponType: 'shotgun',
    hp: UNIT_STATS.badger.hp,
    moveSpeed: UNIT_STATS.badger.moveSpeed,
    collisionRadius: UNIT_STATS.badger.collisionRadius,
    energyCost: UNIT_STATS.badger.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.badger.buildRate,
    locomotion: 'treads',
  },
  scorpion: {
    id: 'scorpion',
    name: 'Scorpion',
    weaponType: 'mortar',
    hp: UNIT_STATS.scorpion.hp,
    moveSpeed: UNIT_STATS.scorpion.moveSpeed,
    collisionRadius: UNIT_STATS.scorpion.collisionRadius,
    energyCost: UNIT_STATS.scorpion.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.scorpion.buildRate,
    locomotion: 'wheels',
  },
  recluse: {
    id: 'recluse',
    name: 'Recluse',
    weaponType: 'railgun',
    hp: UNIT_STATS.recluse.hp,
    moveSpeed: UNIT_STATS.recluse.moveSpeed,
    collisionRadius: UNIT_STATS.recluse.collisionRadius,
    energyCost: UNIT_STATS.recluse.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.recluse.buildRate,
    locomotion: 'legs',
    legStyle: 'recluse',
    weaponOffsetX: -UNIT_STATS.recluse.collisionRadius * 0.5,
  },
  mammoth: {
    id: 'mammoth',
    name: 'Mammoth',
    weaponType: 'cannon',
    hp: UNIT_STATS.mammoth.hp,
    moveSpeed: UNIT_STATS.mammoth.moveSpeed,
    collisionRadius: UNIT_STATS.mammoth.collisionRadius,
    energyCost: UNIT_STATS.mammoth.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.mammoth.buildRate,
    locomotion: 'treads',
  },
  widow: {
    id: 'widow',
    name: 'Widow',
    weaponType: 'widowBeam', // Primary weapon type (has custom createWeapons)
    hp: UNIT_STATS.widow.hp,
    moveSpeed: UNIT_STATS.widow.moveSpeed,
    collisionRadius: UNIT_STATS.widow.collisionRadius,
    energyCost: UNIT_STATS.widow.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.widow.buildRate,
    locomotion: 'legs',
    legStyle: 'widow',
    createWeapons: createWidowWeapons,
  },
  tarantula: {
    id: 'tarantula',
    name: 'Tarantula',
    weaponType: 'forceField',
    hp: UNIT_STATS.tarantula.hp,
    moveSpeed: UNIT_STATS.tarantula.moveSpeed,
    collisionRadius: UNIT_STATS.tarantula.collisionRadius,
    energyCost: UNIT_STATS.tarantula.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.tarantula.buildRate,
    locomotion: 'legs',
    legStyle: 'tarantula',
  },
};

// Get unit definition by ID
export function getUnitDefinition(unitId: string): UnitDefinition | undefined {
  return UNIT_DEFINITIONS[unitId];
}

// Create weapons for a unit using its definition
export function createWeaponsFromDefinition(unitId: string, radius: number): UnitWeapon[] {
  const definition = UNIT_DEFINITIONS[unitId];
  if (!definition) {
    throw new Error(`Unknown unit type: ${unitId}`);
  }

  if (definition.createWeapons) {
    return definition.createWeapons(radius, definition);
  }

  return createDefaultWeapons(radius, definition);
}

// Get all unit definitions as array
export function getAllUnitDefinitions(): UnitDefinition[] {
  return Object.values(UNIT_DEFINITIONS);
}
