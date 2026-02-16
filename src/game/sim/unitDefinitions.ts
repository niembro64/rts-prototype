// Unified Unit Definition System
// All unit-type-specific configuration in one place

import type { UnitWeapon, TargetingMode } from './types';
import { getWeaponConfig } from './weapons';
import {
  COST_MULTIPLIER,
  UNIT_STATS,
  UNIT_TARGETING_MODES,
  DEFAULT_TURRET_TURN_ACCEL,
  DEFAULT_TURRET_DRAG,
  SEE_RANGE_MULTIPLIER,
  LOCK_RANGE_MULTIPLIER,
  FIGHTSTOP_RANGE_MULTIPLIER,
} from '../../config';

// Locomotion types for rendering
export type LocomotionType = 'wheels' | 'treads' | 'legs';

// Leg styles for legged units
export type LegStyle = 'widow' | 'daddy' | 'tarantula' | 'commander';

// Unified unit definition - everything about a unit type in one place
export interface UnitDefinition {
  id: string;
  name: string;

  // Weapon type (references WEAPON_CONFIGS key)
  weaponType: string;

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

  // Custom weapon creation (for multi-weapon units like widow)
  createWeapons?: (radius: number, definition: UnitDefinition) => UnitWeapon[];
}

// Get targeting mode for a unit type
// Looks up from UNIT_TARGETING_MODES config, defaults to 'nearest'
function getTargetingMode(unitId: string, weaponType?: 'beam' | 'centerBeam' | 'forceField'): TargetingMode {
  const unitModes = UNIT_TARGETING_MODES[unitId as keyof typeof UNIT_TARGETING_MODES];
  if (!unitModes) return 'nearest';

  // For multi-weapon units, check for specific weapon type
  if (weaponType && weaponType in unitModes) {
    const value = (unitModes as Record<string, unknown>)[weaponType];
    if (value === 'nearest' || value === 'sticky') {
      return value;
    }
  }

  // For single-weapon units or default fallback
  if ('default' in unitModes) {
    return (unitModes as { default: TargetingMode }).default;
  }

  return 'nearest';
}

// Get returnToForward setting for a unit type
// Looks up from UNIT_TARGETING_MODES config, defaults to true
function getReturnToForward(unitId: string): boolean {
  const unitModes = UNIT_TARGETING_MODES[unitId as keyof typeof UNIT_TARGETING_MODES];
  if (!unitModes) return true;

  if ('returnToForward' in unitModes) {
    return (unitModes as { returnToForward: boolean }).returnToForward;
  }

  return true; // Default to returning to forward
}

// Default weapon creation - single weapon matching unit type
// Range constraint: fightstopRange (0.9x) < fireRange (1.0x) < seeRange (1.1x or 0.95x for sticky)
function createDefaultWeapons(_radius: number, definition: UnitDefinition): UnitWeapon[] {
  const weaponConfig = getWeaponConfig(definition.weaponType);
  const fireRange = weaponConfig.range;
  const fightstopRange = fireRange * FIGHTSTOP_RANGE_MULTIPLIER;
  const lockRange = fireRange * LOCK_RANGE_MULTIPLIER;
  // Get turret acceleration physics values from weapon config, or use defaults
  const turretTurnAccel = weaponConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const turretDrag = weaponConfig.turretDrag ?? DEFAULT_TURRET_DRAG;
  // Get targeting mode and return-to-forward from config
  const targetingMode = getTargetingMode(definition.id);
  const returnToForward = getReturnToForward(definition.id);
  const seeRange = fireRange * SEE_RANGE_MULTIPLIER;

  return [{
    config: { ...weaponConfig },
    currentCooldown: 0,
    targetEntityId: null,
    targetingMode,
    returnToForward,
    seeRange,
    lockRange,
    fireRange,
    fightstopRange,
    isLocked: false,
    turretRotation: 0,
    turretAngularVelocity: 0,
    turretTurnAccel,
    turretDrag,
    offsetX: 0,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
  }];
}

// Widow weapon creation - 6 beam lasers at hexagon + 1 center beam + 1 force field
// Uses explicit widowBeam, widowCenterBeam, and widowForceField configs from config.ts
// Range constraint: fightstopRange (0.9x) < fireRange (1.0x) < seeRange (1.1x or 0.95x for sticky)
function createWidowWeapons(radius: number, _definition: UnitDefinition): UnitWeapon[] {
  const widowBeamConfig = getWeaponConfig('widowBeam');
  const widowCenterBeamConfig = getWeaponConfig('widowCenterBeam');
  const widowForceFieldConfig = getWeaponConfig('widowForceField');

  // Beam weapon - get targeting mode first to determine seeRange multiplier
  const beamTargetingMode = getTargetingMode('widow', 'beam');
  const beamFireRange = widowBeamConfig.range;
  const beamSeeRange = beamFireRange * SEE_RANGE_MULTIPLIER;
  const beamLockRange = beamFireRange * LOCK_RANGE_MULTIPLIER;
  const beamFightstopRange = beamFireRange * FIGHTSTOP_RANGE_MULTIPLIER;
  const beamTurnAccel = widowBeamConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const beamDrag = widowBeamConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  // Center beam weapon - get targeting mode first to determine seeRange multiplier
  const centerBeamTargetingMode = getTargetingMode('widow', 'centerBeam');
  const centerBeamFireRange = widowCenterBeamConfig.range;
  const centerBeamSeeRange = centerBeamFireRange * SEE_RANGE_MULTIPLIER;
  const centerBeamLockRange = centerBeamFireRange * LOCK_RANGE_MULTIPLIER;
  const centerBeamFightstopRange = centerBeamFireRange * FIGHTSTOP_RANGE_MULTIPLIER;
  const centerBeamTurnAccel = widowCenterBeamConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const centerBeamDrag = widowCenterBeamConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  // Force field weapons - get targeting mode (shared by push and pull)
  const forceFieldTargetingMode = getTargetingMode('widow', 'forceField');

  // Widow's return-to-forward setting (shared by all weapons)
  const returnToForward = getReturnToForward('widow');

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
      targetingMode: beamTargetingMode,
      returnToForward,
      seeRange: beamSeeRange,
      lockRange: beamLockRange,
      fireRange: beamFireRange,
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
    targetingMode: centerBeamTargetingMode,
    returnToForward,
    seeRange: centerBeamSeeRange,
    lockRange: centerBeamLockRange,
    fireRange: centerBeamFireRange,
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
  const ffSeeRange = ffFireRange * SEE_RANGE_MULTIPLIER;
  const ffLockRange = ffFireRange * LOCK_RANGE_MULTIPLIER;
  const ffFightstopRange = ffFireRange * FIGHTSTOP_RANGE_MULTIPLIER;
  const ffTurnAccel = widowForceFieldConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const ffDrag = widowForceFieldConfig.turretDrag ?? DEFAULT_TURRET_DRAG;

  weapons.push({
    config: { ...widowForceFieldConfig },
    currentCooldown: 0,
    targetEntityId: null,
    targetingMode: forceFieldTargetingMode,
    returnToForward,
    seeRange: ffSeeRange,
    lockRange: ffLockRange,
    fireRange: ffFireRange,
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
    locomotion: 'wheels',
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
  viper: {
    id: 'viper',
    name: 'Viper',
    weaponType: 'railgun',
    hp: UNIT_STATS.viper.hp,
    moveSpeed: UNIT_STATS.viper.moveSpeed,
    collisionRadius: UNIT_STATS.viper.collisionRadius,
    energyCost: UNIT_STATS.viper.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.viper.buildRate,
    locomotion: 'wheels',
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
