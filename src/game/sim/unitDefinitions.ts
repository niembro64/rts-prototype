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
  weaponSeeRange?: number;  // Override default tracking range
  weaponFireRange?: number; // Override default fire range

  // Custom weapon creation (for multi-weapon units like arachnid)
  createWeapons?: (radius: number, definition: UnitDefinition) => UnitWeapon[];
}

// Default weapon creation - single weapon matching unit type
function createDefaultWeapons(_radius: number, definition: UnitDefinition): UnitWeapon[] {
  const weaponConfig = getWeaponConfig(definition.id);
  const seeRange = definition.weaponSeeRange ?? weaponConfig.range * 1.5;
  const fireRange = definition.weaponFireRange ?? weaponConfig.range;

  return [{
    config: { ...weaponConfig },
    currentCooldown: 0,
    targetEntityId: null,
    seeRange,
    fireRange,
    turretRotation: 0,
    turretTurnRate: 1,
    offsetX: 0,
    offsetY: 0,
    isFiring: false,
  }];
}

// Arachnid weapon creation - 6 beam lasers at hexagon + 1 sonic in center
// Arachnid weapons have 1.5x the normal vision and fire range
function createArachnidWeapons(radius: number, definition: UnitDefinition): UnitWeapon[] {
  const beamConfig = getWeaponConfig('beam');
  const sonicConfig = getWeaponConfig('sonic');
  const turretTurnRate = 0.3;
  const rangeMultiplier = 1.5; // Arachnid has extended range
  const baseSeeRange = definition.weaponSeeRange ?? 400;
  const seeRange = baseSeeRange * rangeMultiplier;
  const fireRange = (definition.weaponFireRange ?? beamConfig.range) * rangeMultiplier;

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
      seeRange,
      fireRange,
      turretRotation: 0,
      turretTurnRate,
      offsetX,
      offsetY,
      isFiring: false,
    });
  }

  // 1 sonic wave weapon in center (also gets 1.5x range)
  weapons.push({
    config: { ...sonicConfig },
    currentCooldown: 0,
    targetEntityId: null,
    seeRange: seeRange * 0.5, // Still half of beam seeRange, but that's now 1.5x larger
    fireRange: sonicConfig.range * rangeMultiplier,
    turretRotation: 0,
    turretTurnRate: turretTurnRate * 1.5,
    offsetX: hexForwardOffset,
    offsetY: 0,
    isFiring: false,
    waveTransitionProgress: 0,
    currentSliceAngle: sonicConfig.waveAngleIdle ?? Math.PI / 16,
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
  beam: {
    id: 'beam',
    name: 'Beam',
    hp: UNIT_STATS.beam.hp,
    moveSpeed: UNIT_STATS.beam.moveSpeed,
    collisionRadius: UNIT_STATS.beam.collisionRadius,
    energyCost: UNIT_STATS.beam.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.beam.buildRate,
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
  mortar: {
    id: 'mortar',
    name: 'Mortar',
    hp: UNIT_STATS.mortar.hp,
    moveSpeed: UNIT_STATS.mortar.moveSpeed,
    collisionRadius: UNIT_STATS.mortar.collisionRadius,
    energyCost: UNIT_STATS.mortar.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.mortar.buildRate,
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
  arachnid: {
    id: 'arachnid',
    name: 'Arachnid',
    hp: UNIT_STATS.arachnid.hp,
    moveSpeed: UNIT_STATS.arachnid.moveSpeed,
    collisionRadius: UNIT_STATS.arachnid.collisionRadius,
    energyCost: UNIT_STATS.arachnid.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.arachnid.buildRate,
    locomotion: 'legs',
    legStyle: 'arachnid',
    weaponSeeRange: 400,
    createWeapons: createArachnidWeapons,
  },
  sonic: {
    id: 'sonic',
    name: 'Sonic',
    hp: UNIT_STATS.sonic.hp,
    moveSpeed: UNIT_STATS.sonic.moveSpeed,
    collisionRadius: UNIT_STATS.sonic.collisionRadius,
    energyCost: UNIT_STATS.sonic.baseCost * COST_MULTIPLIER,
    buildRate: UNIT_STATS.sonic.buildRate,
    locomotion: 'legs',
    legStyle: 'insect',
    weaponSeeRange: 100,
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
