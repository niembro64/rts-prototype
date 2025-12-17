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
  FIGHTSTOP_RANGE_MULTIPLIER,
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

  // Custom weapon creation (for multi-weapon units like widow)
  createWeapons?: (radius: number, definition: UnitDefinition) => UnitWeapon[];
}

// Get targeting mode for a unit type
// Looks up from UNIT_TARGETING_MODES config, defaults to 'nearest'
function getTargetingMode(unitId: string, weaponType?: 'beam' | 'centerBeam' | 'sonic'): TargetingMode {
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
// Range constraint: fightstopRange (0.9x) < fireRange (1.0x) < seeRange (1.1x)
function createDefaultWeapons(_radius: number, definition: UnitDefinition): UnitWeapon[] {
  const weaponConfig = getWeaponConfig(definition.id);
  const fireRange = weaponConfig.range;
  const seeRange = fireRange * SEE_RANGE_MULTIPLIER;
  const fightstopRange = fireRange * FIGHTSTOP_RANGE_MULTIPLIER;
  // Get turret acceleration physics values from weapon config, or use defaults
  const turretTurnAccel = weaponConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const turretDrag = weaponConfig.turretDrag ?? DEFAULT_TURRET_DRAG;
  // Get targeting mode and return-to-forward from config
  const targetingMode = getTargetingMode(definition.id);
  const returnToForward = getReturnToForward(definition.id);

  return [{
    config: { ...weaponConfig },
    currentCooldown: 0,
    targetEntityId: null,
    targetingMode,
    returnToForward,
    seeRange,
    fireRange,
    fightstopRange,
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

// Widow weapon creation - 6 beam lasers at hexagon + 1 sonic wave in center
// Uses explicit widowBeam, widowCenterBeam, and widowSonic configs from config.ts
// Range constraint: fightstopRange (0.9x) < fireRange (1.0x) < seeRange (1.1x)
function createWidowWeapons(radius: number, _definition: UnitDefinition): UnitWeapon[] {
  const widowBeamConfig = getWeaponConfig('widowBeam');
  const widowCenterBeamConfig = getWeaponConfig('widowCenterBeam');
  const widowSonicConfig = getWeaponConfig('widowSonic');

  // Beam weapon ranges - use multipliers
  const beamFireRange = widowBeamConfig.range;
  const beamSeeRange = beamFireRange * SEE_RANGE_MULTIPLIER;
  const beamFightstopRange = beamFireRange * FIGHTSTOP_RANGE_MULTIPLIER;
  const beamTurnAccel = widowBeamConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const beamDrag = widowBeamConfig.turretDrag ?? DEFAULT_TURRET_DRAG;
  const beamTargetingMode = getTargetingMode('widow', 'beam');

  // Center beam weapon ranges - use multipliers
  const centerBeamFireRange = widowCenterBeamConfig.range;
  const centerBeamSeeRange = centerBeamFireRange * SEE_RANGE_MULTIPLIER;
  const centerBeamFightstopRange = centerBeamFireRange * FIGHTSTOP_RANGE_MULTIPLIER;
  const centerBeamTurnAccel = widowCenterBeamConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const centerBeamDrag = widowCenterBeamConfig.turretDrag ?? DEFAULT_TURRET_DRAG;
  const centerBeamTargetingMode = getTargetingMode('widow', 'centerBeam');

  // Sonic weapon ranges - use multipliers
  const sonicFireRange = widowSonicConfig.range;
  const sonicSeeRange = sonicFireRange * SEE_RANGE_MULTIPLIER;
  const sonicFightstopRange = sonicFireRange * FIGHTSTOP_RANGE_MULTIPLIER;
  const sonicTurnAccel = widowSonicConfig.turretTurnAccel ?? DEFAULT_TURRET_TURN_ACCEL;
  const sonicDrag = widowSonicConfig.turretDrag ?? DEFAULT_TURRET_DRAG;
  const sonicTargetingMode = getTargetingMode('widow', 'sonic');

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
      fireRange: beamFireRange,
      fightstopRange: beamFightstopRange,
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
    fireRange: centerBeamFireRange,
    fightstopRange: centerBeamFightstopRange,
    turretRotation: 0,
    turretAngularVelocity: 0,
    turretTurnAccel: centerBeamTurnAccel,
    turretDrag: centerBeamDrag,
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
    targetingMode: sonicTargetingMode,
    returnToForward,
    seeRange: sonicSeeRange,
    fireRange: sonicFireRange,
    fightstopRange: sonicFightstopRange,
    turretRotation: 0,
    turretAngularVelocity: 0,
    turretTurnAccel: sonicTurnAccel,
    turretDrag: sonicDrag,
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
