// Unified Unit Definition System
// All unit-type-specific configuration in one place

import type { UnitWeapon } from './types';
import { getWeaponConfig, computeWeaponRanges, type WeaponId } from './weapons';
import {
  COST_MULTIPLIER,
  UNIT_STATS,
  DEFAULT_TURRET_TURN_ACCEL,
  DEFAULT_TURRET_DRAG,
} from '../../config';

// Union type of all unit type identifiers
export type UnitType = 'jackal' | 'lynx' | 'daddy' | 'badger' | 'mongoose'
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
  const ranges = computeWeaponRanges(weaponConfig);
  const turretTurnAccel = weaponConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const turretDrag = weaponConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  return [{
    config: { ...weaponConfig },
    currentCooldown: 0,
    targetEntityId: null,
    ...ranges,
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

// Widow weapon creation - 6 beam lasers at hexagon + 1 mega force field
// Uses beam and megaForceField configs from config.ts
// Range constraint: seeRange > fireRange > releaseRange > lockRange > fightstopRange
function createWidowWeapons(radius: number, _definition: UnitDefinition): UnitWeapon[] {
  const beamConfig = getWeaponConfig('beam');
  const megaForceFieldConfig = getWeaponConfig('megaForceField');

  // Beam weapon ranges
  const beamRanges = computeWeaponRanges(beamConfig);
  const beamTurnAccel = beamConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const beamDrag = beamConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

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
      config: { ...beamConfig },
      currentCooldown: 0,
      targetEntityId: null,
      ...beamRanges,
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

  // 1 mega force field in center (dual push/pull zones)
  const ffRanges = computeWeaponRanges(megaForceFieldConfig);
  const ffTurnAccel = megaForceFieldConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const ffDrag = megaForceFieldConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  weapons.push({
    config: { ...megaForceFieldConfig },
    currentCooldown: 0,
    targetEntityId: null,
    ...ffRanges,
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
    locomotion: 'treads',
  },
  daddy: {
    id: 'daddy',
    name: 'Daddy',
    weaponType: 'megaBeam',
    hp: UNIT_STATS.daddy.hp,
    moveSpeed: UNIT_STATS.daddy.moveSpeed,
    collisionRadius: UNIT_STATS.daddy.collisionRadius,
    energyCost: UNIT_STATS.daddy.baseCost * COST_MULTIPLIER,
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
    locomotion: 'treads',
  },
  mongoose: {
    id: 'mongoose',
    name: 'Mongoose',
    weaponType: 'mortar',
    hp: UNIT_STATS.mongoose.hp,
    moveSpeed: UNIT_STATS.mongoose.moveSpeed,
    collisionRadius: UNIT_STATS.mongoose.collisionRadius,
    energyCost: UNIT_STATS.mongoose.baseCost * COST_MULTIPLIER,
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
    locomotion: 'legs',
    legStyle: 'recluse',
  },
  mammoth: {
    id: 'mammoth',
    name: 'Mammoth',
    weaponType: 'cannon',
    hp: UNIT_STATS.mammoth.hp,
    moveSpeed: UNIT_STATS.mammoth.moveSpeed,
    collisionRadius: UNIT_STATS.mammoth.collisionRadius,
    energyCost: UNIT_STATS.mammoth.baseCost * COST_MULTIPLIER,
    locomotion: 'treads',
  },
  widow: {
    id: 'widow',
    name: 'Widow',
    weaponType: 'beam', // Primary weapon type (has custom createWeapons)
    hp: UNIT_STATS.widow.hp,
    moveSpeed: UNIT_STATS.widow.moveSpeed,
    collisionRadius: UNIT_STATS.widow.collisionRadius,
    energyCost: UNIT_STATS.widow.baseCost * COST_MULTIPLIER,
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
