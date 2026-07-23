// Stable blueprint ids shared by config, network coding, and event routing.
// Keep these arrays append-only where they are used for wire codes.

export const UNIT_BLUEPRINT_IDS = [
  'unitJackal', 'unitLynx', 'unitBadger', 'unitMongoose', 'unitMammoth',
  'unitTick', 'unitTarantula', 'unitLoris', 'unitDaddy', 'unitWidow',
  'unitFormik', 'unitHippo', 'unitCommander', 'unitBee', 'unitDragonfly',
  'unitEagle', 'unitConstructionDrone', 'unitAlbatros', 'unitTransport',
  'unitQueenBee', 'unitQueenTick', 'unitSeaTurtle',
  'unitOrca', 'unitDuck',
] as const;
export type UnitBlueprintId = typeof UNIT_BLUEPRINT_IDS[number];

export const BUILDING_BLUEPRINT_IDS = [
  'buildingSolar', 'buildingWind', 'towerFabricator', 'buildingExtractor',
  'towerBeamMega', 'towerCannon', 'buildingRadar', 'buildingResourceConverter',
  'towerAntiAir', 'buildingExtractorT2', 'buildingSonar',
] as const;
export type BuildingBlueprintId = typeof BUILDING_BLUEPRINT_IDS[number];

// Static structures have one blueprint family. The legacy IDs beginning with
// "tower" remain stable opaque IDs for wire compatibility; they are buildings.
export const STRUCTURE_BLUEPRINT_IDS = BUILDING_BLUEPRINT_IDS;
export type StructureBlueprintId = BuildingBlueprintId;

export const SHOT_BLUEPRINT_IDS = [
  'shotPlasmaLight',
  'shotPlasmaMedium',
  'shotRocketLight',
  'shotPlasmaHeavy',
  'shotMortarMedium',
  'shotPlasmaDisruptor',
  'shotMissileFast',
  'shotMortarHeavy',
  'shotMissileLong',
  'shotPlasmaOther',
  'shotTorpedo',
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
  'shieldSphereSmall',
  'shieldCylinderInfinite',
  'shieldCylinderInfiniteAimed',
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
  'turretBeamLong',
  'turretBeamMini',
  'turretCannonLong',
  'turretMortarDrop',
  'turretRocketFast',
  'turretAntiAir',
  'turretShieldSphereSmall',
  'turretAlbatrosSiegeCannon',
  'turretSpawnBuildingsAndTowers',
  'turretSpawnUnits',
  'turretResourcePylonConstructionMetal',
  'turretResourcePylonConstructionEnergy',
  'turretResourcePylonExtractionMetal',
  'turretResourcePylonExtractionEnergy',
  'turretTorpedo',
  'turretSensorUnitJackal',
  'turretSensorUnitLynx',
  'turretSensorUnitDaddy',
  'turretSensorUnitBadger',
  'turretSensorUnitMongoose',
  'turretSensorUnitTick',
  'turretSensorUnitMammoth',
  'turretSensorUnitFormik',
  'turretSensorUnitWidow',
  'turretSensorUnitHippo',
  'turretSensorUnitSeaTurtle',
  'turretSensorUnitOrca',
  'turretSensorUnitTarantula',
  'turretSensorUnitLoris',
  'turretSensorUnitBee',
  'turretSensorUnitDragonfly',
  'turretSensorUnitConstructionDrone',
  'turretSensorUnitEagle',
  'turretSensorUnitDuck',
  'turretSensorUnitAlbatros',
  'turretSensorUnitQueenBee',
  'turretSensorUnitQueenTick',
  'turretSensorUnitTransport',
  'turretSensorUnitCommander',
  'turretSensorBuildingSolar',
  'turretSensorBuildingWind',
  'turretSensorBuildingExtractor',
  'turretSensorBuildingExtractorT2',
  'turretSensorBuildingRadar',
  'turretSensorBuildingResourceConverter',
  'turretSensorBuildingSonar',
  'turretSensorBuildingFabricator',
  'turretSensorBuildingBeamMega',
  'turretSensorBuildingCannon',
  'turretSensorBuildingAntiAir',
] as const;
export type TurretBlueprintId = typeof TURRET_BLUEPRINT_IDS[number];

const UNIT_BLUEPRINT_ID_SET = new Set<string>(UNIT_BLUEPRINT_IDS);
const BUILDING_BLUEPRINT_ID_SET = new Set<string>(BUILDING_BLUEPRINT_IDS);
const STRUCTURE_BLUEPRINT_ID_SET = new Set<string>(STRUCTURE_BLUEPRINT_IDS);
const SHOT_BLUEPRINT_ID_SET = new Set<string>(SHOT_BLUEPRINT_IDS);
const RAY_BLUEPRINT_ID_SET = new Set<string>(RAY_BLUEPRINT_IDS);
const SHIELD_MATERIAL_ID_SET = new Set<string>(SHIELD_MATERIAL_IDS);
const TURRET_BLUEPRINT_ID_SET = new Set<string>(TURRET_BLUEPRINT_IDS);

export function isUnitBlueprintId(value: string): value is UnitBlueprintId {
  return UNIT_BLUEPRINT_ID_SET.has(value);
}

export function isBuildingBlueprintId(value: string): value is BuildingBlueprintId {
  return BUILDING_BLUEPRINT_ID_SET.has(value);
}

export function isStructureBlueprintId(value: string): value is StructureBlueprintId {
  return STRUCTURE_BLUEPRINT_ID_SET.has(value);
}

export function isShotBlueprintId(value: string): value is ShotBlueprintId {
  return SHOT_BLUEPRINT_ID_SET.has(value);
}

export function isRayBlueprintId(value: string): value is RayBlueprintId {
  return RAY_BLUEPRINT_ID_SET.has(value);
}


export function isShieldMaterialId(value: string): value is ShieldMaterialId {
  return SHIELD_MATERIAL_ID_SET.has(value);
}

export function isTurretBlueprintId(value: string): value is TurretBlueprintId {
  return TURRET_BLUEPRINT_ID_SET.has(value);
}
