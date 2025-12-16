// Unified Unit Definition System
// All unit-type-specific configuration in one place

import type { UnitWeapon } from './types';
import { getWeaponConfig } from './weapons';
import {
  COST_MULTIPLIER,
  UNIT_STATS,
} from '../../config';

// Locomotion types for rendering
export type LocomotionType = 'wheels' | 'treads' | 'legs';

// Leg styles for legged units
export type LegStyle = 'arachnid' | 'daddy' | 'insect';

// Unified unit definition - everything about a unit type in one place
export interface UnitDefinition {
  id: string;
  name: string;

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

  // Weapon configuration
  // Constraint: fightstopRange < fireRange < seeRange
  weaponSeeRange?: number;       // Override default tracking range
  weaponFireRange?: number;      // Override default fire range
  weaponFightstopRange?: number; // Override default fightstop range (unit stops in fight mode when enemy within this)

  // Custom weapon creation (for multi-weapon units like widow)
  createWeapons?: (radius: number, definition: UnitDefinition) => UnitWeapon[];
}

// Default weapon creation - single weapon matching unit type
// Range constraint: fightstopRange < fireRange < seeRange
function createDefaultWeapons(_radius: number, definition: UnitDefinition): UnitWeapon[] {
  const weaponConfig = getWeaponConfig(definition.id);
  const seeRange = definition.weaponSeeRange ?? weaponConfig.range * 1.5;
  const fireRange = definition.weaponFireRange ?? weaponConfig.range;
  // Default fightstopRange is 75% of fireRange - allows unit to close distance before stopping
  const fightstopRange = definition.weaponFightstopRange ?? fireRange * 0.75;

  return [{
    config: { ...weaponConfig },
    currentCooldown: 0,
    targetEntityId: null,
    seeRange,
    fireRange,
    fightstopRange,
    turretRotation: 0,
    turretTurnRate: 1,
    offsetX: 0,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
  }];
}

// Widow weapon creation - 6 daddy lasers at hexagon + 1 insect wave in center
// Widow weapons have 1.5x the normal vision and fire range
// Range constraint: fightstopRange < fireRange < seeRange
function createWidowWeapons(radius: number, definition: UnitDefinition): UnitWeapon[] {
  const daddyConfig = getWeaponConfig('daddy');
  const insectConfig = getWeaponConfig('insect');
  const turretTurnRate = 0.3;
  const rangeMultiplier = 1.5; // Widow has extended range
  const baseSeeRange = definition.weaponSeeRange ?? 400;
  const seeRange = baseSeeRange * rangeMultiplier;
  const fireRange = (definition.weaponFireRange ?? daddyConfig.range) * rangeMultiplier;
  // Default fightstopRange is 75% of fireRange
  const fightstopRange = (definition.weaponFightstopRange ?? fireRange * 0.75);

  const weapons: UnitWeapon[] = [];

  // 6 daddy lasers at hexagon vertices
  const hexRadius = radius * 0.65;
  const hexForwardOffset = radius * 0.5;
  const hexRotationOffset = Math.PI / 6;

  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 + hexRotationOffset;
    const offsetX = Math.cos(angle) * hexRadius + hexForwardOffset;
    const offsetY = Math.sin(angle) * hexRadius;
    weapons.push({
      config: { ...daddyConfig },
      currentCooldown: 0,
      targetEntityId: null,
      seeRange,
      fireRange,
      fightstopRange,
      turretRotation: 0,
      turretTurnRate,
      offsetX,
      offsetY,
      isFiring: false,
      inFightstopRange: false,
    });
  }

  // 1 insect wave weapon in center (also gets 1.5x range)
  // Widow's insect wave has full 135° attack angle (unlike baby insect's 30°)
  const insectFireRange = insectConfig.range * rangeMultiplier;
  const widowInsectConfig = {
    ...insectConfig,
    waveAngleAttack: Math.PI * 0.75, // Full 135° slice for widow
  };
  weapons.push({
    config: widowInsectConfig,
    currentCooldown: 0,
    targetEntityId: null,
    seeRange: seeRange * 0.5, // Still half of daddy seeRange, but that's now 1.5x larger
    fireRange: insectFireRange,
    fightstopRange: insectFireRange * 0.75, // Insect also uses 75% of its fire range
    turretRotation: 0,
    turretTurnRate: turretTurnRate * 1.5,
    offsetX: hexForwardOffset,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
    waveTransitionProgress: 0,
    currentSliceAngle: widowInsectConfig.waveAngleIdle ?? Math.PI / 16,
  });

  return weapons;
}

// Registry of all unit definitions
export const UNIT_DEFINITIONS: Record<string, UnitDefinition> = {
  scout: {
    id: 'scout',
    name: 'Scout',
    hp: UNIT_STATS.scout.hp,
    moveSpeed: UNIT_STATS.scout.moveSpeed,
    collisionRadius: UNIT_STATS.scout.collisionRadius,
    energyCost: UNIT_STATS.scout.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.scout.buildRate,
    locomotion: 'wheels',
  },
  burst: {
    id: 'burst',
    name: 'Burst',
    hp: UNIT_STATS.burst.hp,
    moveSpeed: UNIT_STATS.burst.moveSpeed,
    collisionRadius: UNIT_STATS.burst.collisionRadius,
    energyCost: UNIT_STATS.burst.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.burst.buildRate,
    locomotion: 'wheels',
  },
  daddy: {
    id: 'daddy',
    name: 'Daddy',
    hp: UNIT_STATS.daddy.hp,
    moveSpeed: UNIT_STATS.daddy.moveSpeed,
    collisionRadius: UNIT_STATS.daddy.collisionRadius,
    energyCost: UNIT_STATS.daddy.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.daddy.buildRate,
    locomotion: 'legs',
    legStyle: 'daddy',
  },
  brawl: {
    id: 'brawl',
    name: 'Brawl',
    hp: UNIT_STATS.brawl.hp,
    moveSpeed: UNIT_STATS.brawl.moveSpeed,
    collisionRadius: UNIT_STATS.brawl.collisionRadius,
    energyCost: UNIT_STATS.brawl.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.brawl.buildRate,
    locomotion: 'treads',
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    hp: UNIT_STATS.shotgun.hp,
    moveSpeed: UNIT_STATS.shotgun.moveSpeed,
    collisionRadius: UNIT_STATS.shotgun.collisionRadius,
    energyCost: UNIT_STATS.shotgun.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.shotgun.buildRate,
    locomotion: 'wheels',
  },
  snipe: {
    id: 'snipe',
    name: 'Snipe',
    hp: UNIT_STATS.snipe.hp,
    moveSpeed: UNIT_STATS.snipe.moveSpeed,
    collisionRadius: UNIT_STATS.snipe.collisionRadius,
    energyCost: UNIT_STATS.snipe.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.snipe.buildRate,
    locomotion: 'wheels',
  },
  tank: {
    id: 'tank',
    name: 'Tank',
    hp: UNIT_STATS.tank.hp,
    moveSpeed: UNIT_STATS.tank.moveSpeed,
    collisionRadius: UNIT_STATS.tank.collisionRadius,
    energyCost: UNIT_STATS.tank.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.tank.buildRate,
    locomotion: 'treads',
  },
  widow: {
    id: 'widow',
    name: 'Widow',
    hp: UNIT_STATS.widow.hp,
    moveSpeed: UNIT_STATS.widow.moveSpeed,
    collisionRadius: UNIT_STATS.widow.collisionRadius,
    energyCost: UNIT_STATS.widow.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.widow.buildRate,
    locomotion: 'legs',
    legStyle: 'arachnid',
    weaponSeeRange: 400,
    createWeapons: createWidowWeapons,
  },
  insect: {
    id: 'insect',
    name: 'Insect',
    hp: UNIT_STATS.insect.hp,
    moveSpeed: UNIT_STATS.insect.moveSpeed,
    collisionRadius: UNIT_STATS.insect.collisionRadius,
    energyCost: UNIT_STATS.insect.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.insect.buildRate,
    locomotion: 'legs',
    legStyle: 'insect',
    weaponSeeRange: 200,   // Must see beyond fire range to target enemies approaching
    weaponFireRange: 150,
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
