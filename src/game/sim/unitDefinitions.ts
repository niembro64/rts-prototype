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
  const fireRange = definition.weaponFireRange ?? weaponConfig.range;
  // Use trackingRange from weapon config, then unit definition, then default to range * 1.5
  const seeRange = weaponConfig.trackingRange ?? definition.weaponSeeRange ?? weaponConfig.range * 1.5;
  // Use engageRange from weapon config, then unit definition, then default to 75% of fireRange
  const fightstopRange = weaponConfig.engageRange ?? definition.weaponFightstopRange ?? fireRange * 0.75;
  // Use turretTurnRate for beams, rotationRate for wave weapons, otherwise default to 1
  const turretTurnRate = weaponConfig.turretTurnRate ?? weaponConfig.rotationRate ?? 1;

  return [{
    config: { ...weaponConfig },
    currentCooldown: 0,
    targetEntityId: null,
    seeRange,
    fireRange,
    fightstopRange,
    turretRotation: 0,
    turretTurnRate,
    offsetX: 0,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
  }];
}

// Widow weapon creation - 6 beam lasers at hexagon + 1 sonic wave in center
// Uses explicit widowBeam, widowCenterBeam, and widowSonic configs from config.ts
// Range constraint: fightstopRange < fireRange < seeRange
function createWidowWeapons(radius: number, _definition: UnitDefinition): UnitWeapon[] {
  const widowBeamConfig = getWeaponConfig('widowBeam');
  const widowCenterBeamConfig = getWeaponConfig('widowCenterBeam');
  const widowSonicConfig = getWeaponConfig('widowSonic');

  // Beam weapon ranges (from widowBeam config, with defaults)
  const beamFireRange = widowBeamConfig.range;
  const beamSeeRange = widowBeamConfig.trackingRange ?? beamFireRange * 1.5;
  const beamFightstopRange = widowBeamConfig.engageRange ?? beamFireRange * 0.75;
  const beamTurretTurnRate = widowBeamConfig.turretTurnRate ?? 0.3;

  // Center beam weapon ranges (2x the regular beam)
  const centerBeamFireRange = widowCenterBeamConfig.range;
  const centerBeamSeeRange = widowCenterBeamConfig.trackingRange ?? centerBeamFireRange * 1.5;
  const centerBeamFightstopRange = widowCenterBeamConfig.engageRange ?? centerBeamFireRange * 0.75;
  const centerBeamTurretTurnRate = widowCenterBeamConfig.turretTurnRate ?? 0.3;

  // Sonic weapon ranges (from widowSonic config)
  const sonicFireRange = widowSonicConfig.range;
  const sonicSeeRange = widowSonicConfig.trackingRange ?? sonicFireRange * 1.5;
  const sonicFightstopRange = widowSonicConfig.engageRange ?? sonicFireRange * 0.75;
  const sonicRotationRate = widowSonicConfig.rotationRate ?? 0.45;

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
      fightstopRange: beamFightstopRange,
      turretRotation: 0,
      turretTurnRate: beamTurretTurnRate,
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
    fightstopRange: centerBeamFightstopRange,
    turretRotation: 0,
    turretTurnRate: centerBeamTurretTurnRate,
    offsetX: hexForwardOffset,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
  });

  // 1 sonic wave weapon in center
  weapons.push({
    config: { ...widowSonicConfig },
    currentCooldown: 0,
    targetEntityId: null,
    seeRange: sonicSeeRange,
    fireRange: sonicFireRange,
    fightstopRange: sonicFightstopRange,
    turretRotation: 0,
    turretTurnRate: sonicRotationRate,
    offsetX: hexForwardOffset,
    offsetY: 0,
    isFiring: false,
    inFightstopRange: false,
    waveTransitionProgress: 0,
    currentSliceAngle: widowSonicConfig.waveAngleIdle ?? Math.PI / 16,
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
