// Stable blueprint ids shared by config, network coding, and event routing.
// Keep these arrays append-only where they are used for wire codes.

export const UNIT_BLUEPRINT_IDS = [
  'unitJackal', 'unitLynx', 'unitBadger', 'unitMongoose', 'unitMammoth',
  'unitTick', 'unitTarantula', 'unitLoris', 'unitDaddy', 'unitWidow',
  'unitFormik', 'unitHippo', 'unitCommander', 'unitMosquito', 'unitDragonfly',
  'unitEagle', 'unitConstructionDrone',
] as const;
export type UnitBlueprintId = typeof UNIT_BLUEPRINT_IDS[number];

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
  'shotBeamMedium',
  'shotBeamHeavy',
  'shotBeamMega',
  'shotBeamMini',
  'shotRocketFast',
  'shotMortarHeavy',
  'shotForceFieldSphere',
  'shotForceFieldPanel',
] as const;
export type ShotBlueprintId = typeof SHOT_BLUEPRINT_IDS[number];

export const FORCE_FIELD_MATERIAL_IDS = [
  'reflectiveForceField',
] as const;
export type ForceFieldMaterialId = typeof FORCE_FIELD_MATERIAL_IDS[number];

export const TURRET_BLUEPRINT_IDS = [
  'turretGunLight',
  'turretRocketSlow',
  'turretCannon',
  'turretMortarSlow',
  'turretGunBurst',
  'turretMortarFast',
  'turretGatling',
  'turretDisruptor',
  'turretForceFieldPanel',
  'turretBeam',
  'turretBeamMega',
  'turretForceFieldSphere',
  'turretConstruction',
  'turretBeamLong',
  'turretBeamMini',
  'turretCannonLong',
  'turretMortarDrop',
  'turretRocketFast',
] as const;
export type TurretBlueprintId = typeof TURRET_BLUEPRINT_IDS[number];

const UNIT_BLUEPRINT_ID_SET = new Set<string>(UNIT_BLUEPRINT_IDS);
const BUILDING_BLUEPRINT_ID_SET = new Set<string>(BUILDING_BLUEPRINT_IDS);
const SHOT_BLUEPRINT_ID_SET = new Set<string>(SHOT_BLUEPRINT_IDS);
const FORCE_FIELD_MATERIAL_ID_SET = new Set<string>(FORCE_FIELD_MATERIAL_IDS);
const TURRET_BLUEPRINT_ID_SET = new Set<string>(TURRET_BLUEPRINT_IDS);

export function isUnitBlueprintId(value: string): value is UnitBlueprintId {
  return UNIT_BLUEPRINT_ID_SET.has(value);
}

export function isBuildingBlueprintId(value: string): value is BuildingBlueprintId {
  return BUILDING_BLUEPRINT_ID_SET.has(value);
}

export function isShotBlueprintId(value: string): value is ShotBlueprintId {
  return SHOT_BLUEPRINT_ID_SET.has(value);
}

export function isForceFieldMaterialId(value: string): value is ForceFieldMaterialId {
  return FORCE_FIELD_MATERIAL_ID_SET.has(value);
}

export function isTurretBlueprintId(value: string): value is TurretBlueprintId {
  return TURRET_BLUEPRINT_ID_SET.has(value);
}
