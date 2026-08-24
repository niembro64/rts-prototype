import {
  BUILDING_BLUEPRINTS,
  SHOT_BLUEPRINTS,
  UNIT_BLUEPRINTS,
} from './index';
import { TURRET_CONFIGS } from '../turretConfigs';
import { CT_LOCK_ON_FAM_INCLUDE_SHOTS } from '../../sim-wasm/api/turretCombat';
import { shotBlueprintIdToCode } from '../../../types/network';
import type { BuildingBlueprintId, TurretConfig } from '../types';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[full-utilization roster contract] ${message}`);
}

function unitTurretConfigs(unitBlueprintId: string): TurretConfig[] {
  const configs: TurretConfig[] = [];
  for (const mount of UNIT_BLUEPRINTS[unitBlueprintId].turrets) {
    configs.push(TURRET_CONFIGS[mount.turretBlueprintId]);
    if (mount.sensorTurretBlueprintId !== undefined) {
      configs.push(TURRET_CONFIGS[mount.sensorTurretBlueprintId]);
    }
  }
  return configs;
}

function unitAttackConfigs(unitBlueprintId: string): TurretConfig[] {
  return unitTurretConfigs(unitBlueprintId).filter((config) => config.kind === 'attack');
}

function unitSensorConfigs(unitBlueprintId: string): TurretConfig[] {
  return unitTurretConfigs(unitBlueprintId).filter((config) => config.kind === 'sensor');
}

function buildingSensorConfigs(buildingBlueprintId: BuildingBlueprintId): TurretConfig[] {
  const configs: TurretConfig[] = [];
  for (const mount of BUILDING_BLUEPRINTS[buildingBlueprintId].turrets) {
    const primary = TURRET_CONFIGS[mount.turretBlueprintId];
    if (primary.kind === 'sensor') configs.push(primary);
    if (mount.sensorTurretBlueprintId !== undefined) {
      configs.push(TURRET_CONFIGS[mount.sensorTurretBlueprintId]);
    }
  }
  return configs;
}

function underwaterContactRange(config: TurretConfig): number {
  const contact = config.targeting.observation.sensors.contactSight;
  return Math.max(contact.aboveWater.underwater, contact.underwater.underwater);
}

function hasUnderwaterWeapon(unitBlueprintId: string): boolean {
  return unitAttackConfigs(unitBlueprintId).some((config) => {
    const matrix = config.shot?.mediumTrajectory;
    return matrix !== undefined && matrix !== null &&
      (matrix.aboveWater.underwater || matrix.underwater.underwater);
  });
}

export function runFullUtilizationRosterContractTest(): void {
  for (const unitBlueprintId of Object.keys(UNIT_BLUEPRINTS)) {
    const sensors = unitSensorConfigs(unitBlueprintId);
    assertContract(
      sensors.length === 1,
      `${unitBlueprintId} must have exactly one mounted sensor source; got ${sensors.length}`,
    );
  }
  for (const blueprint of Object.values(BUILDING_BLUEPRINTS)) {
    const buildingBlueprintId = blueprint.buildingBlueprintId;
    const sensors = buildingSensorConfigs(buildingBlueprintId);
    assertContract(
      sensors.length === 1,
      `${buildingBlueprintId} must have exactly one mounted sensor source; got ${sensors.length}`,
    );
  }

  const radarScoutSensors = unitSensorConfigs('unitRadarScout');
  assertContract(
    unitAttackConfigs('unitRadarScout').length === 0 &&
      radarScoutSensors.length === 1 &&
      radarScoutSensors[0].targeting.observation.sensors.contactSight.aboveWater.aboveWater >
        radarScoutSensors[0].targeting.observation.sensors.fullSight.aboveWater.aboveWater,
    'Kestrel must be an unarmed mobile radar host whose contact range exceeds ordinary sight',
  );

  for (const [unitBlueprintId, domain] of [
    ['unitConstructionBot', 'Bot'],
    ['unitConstructionRover', 'Vehicle'],
    ['unitConstructionDrone', 'Aircraft'],
    ['unitConstructionSubmarine', 'Naval'],
  ] as const) {
    const roster = UNIT_BLUEPRINTS[unitBlueprintId].allowedBuildBlueprintIds ?? [];
    assertContract(
      roster.includes('towerFabricator') &&
        roster.includes('buildingAdvancedUniversalFabricator') &&
        roster.includes(`building${domain}Fabricator`) &&
        roster.includes(`buildingAdvanced${domain}Fabricator`),
      `${unitBlueprintId} must start both Universal tiers and both ${domain} fabricator tiers`,
    );
  }

  const shade = UNIT_BLUEPRINTS.unitStealthScout;
  assertContract(
    shade.base.signature.radarStealth &&
      shade.base.signature.sonarStealth &&
      unitAttackConfigs('unitStealthScout').length === 0,
    'Shade must be a fragile unarmed stealth scout rather than another capstone',
  );

  const detectorSensors = unitSensorConfigs('unitDetector');
  assertContract(
    detectorSensors.length === 1 &&
      detectorSensors[0].targeting.observation.sensors.detectorRadius > 0 &&
      detectorSensors[0].targeting.observation.sensors.contactSight.aboveWater.aboveWater === 0 &&
      underwaterContactRange(detectorSensors[0]) === 0 &&
      unitAttackConfigs('unitDetector').length === 0,
    'Owl must expose modest sight plus detection, with no radar/sonar contact sensor or weapon',
  );

  const jammerSensors = unitSensorConfigs('unitRadarJammer');
  assertContract(
    jammerSensors.length === 1 &&
      jammerSensors[0].targeting.observation.sensors.radarJamRadius > 0 &&
      unitAttackConfigs('unitRadarJammer').some((config) => config.turretBlueprintId === 'turretGunLight'),
    'Murk must pair mobile radar jamming with only the weak light gun',
  );

  assertContract(
    UNIT_BLUEPRINTS.unitMissileRover.turrets.length === 1 &&
      UNIT_BLUEPRINTS.unitMissileRover.turrets[0].turretBlueprintId === 'turretMissileRover',
    'Swift must use the dedicated air-only mobile SAM launcher',
  );

  assertContract(
    UNIT_BLUEPRINTS.unitHedgehog.turrets.some((mount) => mount.turretBlueprintId === 'turretRocketDumb') &&
      SHOT_BLUEPRINTS.shotRocketDumb.turning === null,
    'Hedgehog must showcase the straight never-turning dumb rocket',
  );

  assertContract(
    UNIT_BLUEPRINTS.unitClusterArtillery.turrets.some((mount) => mount.turretBlueprintId === 'turretMortarCluster') &&
      SHOT_BLUEPRINTS.shotMortarHeavy.submunitions?.shotBlueprintId === 'shotMortarMedium' &&
      SHOT_BLUEPRINTS.shotMortarHeavy.submunitions.count > 0,
    'Bramble must fire the heavy mortar and split it into authored submunitions',
  );

  const tidal = BUILDING_BLUEPRINTS.buildingTidalGenerator;
  assertContract(
    (tidal.energyProduction ?? 0) > 0 &&
      tidal.placementSets.every((set) => set.startsWith('water-')),
    'Tidal Generator must close the naval energy loop as a water-only producer',
  );

  for (const unitBlueprintId of ['unitHippo', 'unitSeaTurtle', 'unitPatrolCorvette'] as const) {
    assertContract(
      unitSensorConfigs(unitBlueprintId).some((config) => underwaterContactRange(config) > 0) &&
        !hasUnderwaterWeapon(unitBlueprintId),
      `${unitBlueprintId} must sense underwater targets without receiving an underwater weapon`,
    );
  }

  const petrelSensors = unitSensorConfigs('unitPetrel');
  const petrelWeapons = unitAttackConfigs('unitPetrel');
  assertContract(
    petrelSensors.every((config) => underwaterContactRange(config) === 0) &&
      petrelWeapons.some((config) =>
        config.shot !== null &&
        config.shot !== undefined &&
        'shotBlueprintId' in config.shot &&
        config.shot.shotBlueprintId === 'shotTorpedoAirLaunch' &&
        config.shot.mediumTrajectory.aboveWater.underwater
      ),
    'Petrel must attack underwater from the air while depending on allied sonar for contact',
  );

  const shotTargetingTurrets = Object.values(TURRET_CONFIGS)
    .filter((config) => (config.lockOnEntityFamilyIncludeMask & CT_LOCK_ON_FAM_INCLUDE_SHOTS) !== 0)
    .map((config) => config.turretBlueprintId);
  assertContract(
    shotTargetingTurrets.length === 1 && shotTargetingTurrets[0] === 'turretInterceptor',
    'only the dedicated Interceptor turret may target travelling shots',
  );

  const expectedInterceptMask = [
    'shotRocketLight',
    'shotRocketDumb',
    'shotMortarMedium',
    'shotMortarHeavy',
  ].reduce((mask, shotBlueprintId) => mask | (1 << shotBlueprintIdToCode(shotBlueprintId)), 0) >>> 0;
  assertContract(
    TURRET_CONFIGS.turretInterceptor.lockOnShotIncludeMask === expectedInterceptMask,
    'Interceptor must target exactly controlled rockets, dumb rockets, and medium/heavy mortars',
  );

  const shotTargetingBuildings = Object.values(BUILDING_BLUEPRINTS)
    .filter((blueprint) =>
      (blueprint.includeLockOnLevel0Entities ?? []).includes('shots')
    )
    .map((blueprint) => blueprint.buildingBlueprintId);
  assertContract(
    shotTargetingBuildings.length === 1 && shotTargetingBuildings[0] === 'towerInterceptor',
    'only the Interceptor Tower host may direct a shot-targeting weapon',
  );
}
