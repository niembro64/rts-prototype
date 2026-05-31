// Stable blueprint ids shared by config, network coding, and event routing.
// Keep these arrays append-only where they are used for wire codes.

export const UNIT_BLUEPRINT_IDS = [
  'unitJackal', 'unitLynx', 'unitBadger', 'unitMongoose', 'unitMammoth',
  'unitTick', 'unitTarantula', 'unitLoris', 'unitDaddy', 'unitWidow',
  'unitFormik', 'unitHippo', 'unitCommander', 'unitMosquito', 'unitDragonfly',
  'unitEagle', 'unitConstructionDrone',
] as const;
export type UnitBlueprintId = typeof UNIT_BLUEPRINT_IDS[number];

export const LOCOMOTION_BLUEPRINT_IDS = [
  'locomotionJackal',
  'locomotionLynx',
  'locomotionDaddy',
  'locomotionBadger',
  'locomotionMongoose',
  'locomotionTick',
  'locomotionMammoth',
  'locomotionFormik',
  'locomotionWidow',
  'locomotionHippo',
  'locomotionTarantula',
  'locomotionLoris',
  'locomotionCommander',
  'locomotionHovercraft',
  'locomotionDragonflyHovercraft',
  'locomotionConstructionDrone',
  'locomotionEagleFlying',
] as const;
export type LocomotionBlueprintId = typeof LOCOMOTION_BLUEPRINT_IDS[number];

export const BUILDING_BLUEPRINT_IDS = [
  'buildingSolar', 'buildingWind', 'towerFabricator', 'buildingExtractor', 'towerBeamMega', 'towerCannon', 'buildingRadar', 'buildingResourceConverter',
] as const;
export type BuildingBlueprintId = typeof BUILDING_BLUEPRINT_IDS[number];

export const SHOT_BLUEPRINT_IDS = [
  'shotPlasmaLight',
  'shotPlasmaMedium',
  'shotRocketLight',
  'shotPlasmaHeavy',
  'shotMortarMedium',
  'shotPlasmaDisruptor',
  'shotRocketFast',
  'shotMortarHeavy',
] as const;
export type ShotBlueprintId = typeof SHOT_BLUEPRINT_IDS[number];

export const RAY_BLUEPRINT_IDS = [
  'rayBeamMedium',
  'rayBeamHeavy',
  'rayBeamMega',
  'rayBeamMini',
] as const;
export type RayBlueprintId = typeof RAY_BLUEPRINT_IDS[number];

export const SHIELD_BLUEPRINT_IDS = [
  'shieldSphere',
  'shieldPanel',
] as const;
export type ShieldBlueprintId = typeof SHIELD_BLUEPRINT_IDS[number];

export const SHIELD_MATERIAL_IDS = [
  'reflectiveShield',
] as const;
export type ShieldMaterialId = typeof SHIELD_MATERIAL_IDS[number];

export const TURRET_BLUEPRINT_IDS = [
  'turretGunLight',
  'turretRocketSlow',
  'turretCannon',
  'turretMortarSlow',
  'turretGunBurst',
  'turretMortarFast',
  'turretGatling',
  'turretDisruptor',
  'turretShieldPanel',
  'turretBeam',
  'turretBeamMega',
  'turretShieldSphere',
  'turretConstruction',
  'turretBeamLong',
  'turretBeamMini',
  'turretCannonLong',
  'turretMortarDrop',
  'turretRocketFast',
] as const;
export type TurretBlueprintId = typeof TURRET_BLUEPRINT_IDS[number];

const UNIT_BLUEPRINT_ID_SET = new Set<string>(UNIT_BLUEPRINT_IDS);
const LOCOMOTION_BLUEPRINT_ID_SET = new Set<string>(LOCOMOTION_BLUEPRINT_IDS);
const BUILDING_BLUEPRINT_ID_SET = new Set<string>(BUILDING_BLUEPRINT_IDS);
const SHOT_BLUEPRINT_ID_SET = new Set<string>(SHOT_BLUEPRINT_IDS);
const RAY_BLUEPRINT_ID_SET = new Set<string>(RAY_BLUEPRINT_IDS);
const SHIELD_BLUEPRINT_ID_SET = new Set<string>(SHIELD_BLUEPRINT_IDS);
const SHIELD_MATERIAL_ID_SET = new Set<string>(SHIELD_MATERIAL_IDS);
const TURRET_BLUEPRINT_ID_SET = new Set<string>(TURRET_BLUEPRINT_IDS);

export function isUnitBlueprintId(value: string): value is UnitBlueprintId {
  return UNIT_BLUEPRINT_ID_SET.has(value);
}

export function isLocomotionBlueprintId(value: string): value is LocomotionBlueprintId {
  return LOCOMOTION_BLUEPRINT_ID_SET.has(value);
}

export function isBuildingBlueprintId(value: string): value is BuildingBlueprintId {
  return BUILDING_BLUEPRINT_ID_SET.has(value);
}

export function isShotBlueprintId(value: string): value is ShotBlueprintId {
  return SHOT_BLUEPRINT_ID_SET.has(value);
}

export function isRayBlueprintId(value: string): value is RayBlueprintId {
  return RAY_BLUEPRINT_ID_SET.has(value);
}

export function isShieldBlueprintId(value: string): value is ShieldBlueprintId {
  return SHIELD_BLUEPRINT_ID_SET.has(value);
}

export function isShieldMaterialId(value: string): value is ShieldMaterialId {
  return SHIELD_MATERIAL_ID_SET.has(value);
}

export function isTurretBlueprintId(value: string): value is TurretBlueprintId {
  return TURRET_BLUEPRINT_ID_SET.has(value);
}
