// Six orthogonal team sensing fields.
//
// Every mounted suite is scalar. The host entity's origin chooses exactly one
// medium for vision, radar, and jamming: with liquid present, z >= WATER_LEVEL
// is air and z below it is water; with NONE, every finite origin is air. The
// mount remains the LOS/radius center but never chooses the field. These
// checks pin authored data, JS snapshot visibility, and native targeting masks
// to that same rule.
import rawTurrets from '../sim/blueprints/turrets.json';
import { SnapshotVisibility } from './stateSerializerVisibility';
import { WorldState } from '../sim/WorldState';
import { spatialGrid } from '../sim/SpatialGrid';
import { buildTeamRosterFromSeatCounts } from '../sim/teamRoster';
import { WATER_LEVEL } from '../sim/terrain/terrainConfig';
import { buildTerrainTileMap, setAuthoritativeTerrainTileMap } from '../sim/Terrain';
import { getAuthoritativeTerrainTileMap } from '../sim/terrain/terrainState';
import {
  getCombatTargetingStateViews,
  stampCombatTargetingPool,
} from '../sim/combat/targetingInputStamping';
import {
  forEachEntityTurretJammerSource,
  forEachEntityTurretSensorSource,
  getSensorMediumAtZ,
} from '../sim/sensorCoverage';
import { MAX_JAMMING_RADIUS } from '../sim/sensorConfig';
import { getSimWasm } from '../sim-wasm/init';
import type { Entity, PlayerId } from '../sim/types';
import {
  getLiquidSurfaceMode,
  setLiquidSurfaceMode,
} from '../sim/worldSurfaceState';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[six-field sensor contract] ${message}`);
}

type SensorSuite = {
  visionRadius: number;
  radarRadius: number;
  detectorRadius: number;
  jammingRadius: number;
};
type TurretLike = { targeting?: { observation?: { sensors?: SensorSuite } } };

function assertAuthoredScalarSuites(): void {
  const turrets = rawTurrets as unknown as Record<string, TurretLike>;
  const expectedKeys = [
    'detectorRadius',
    'jammingRadius',
    'radarRadius',
    'visionRadius',
  ];
  let suites = 0;
  const authoredJammers: Record<string, number> = {};
  for (const [id, turret] of Object.entries(turrets)) {
    const sensors = turret.targeting?.observation?.sensors;
    if (sensors === undefined) continue;
    suites++;
    assertContract(
      JSON.stringify(Object.keys(sensors).sort()) === JSON.stringify(expectedKeys),
      `${id}: sensor suites must contain exactly the four scalar channels`,
    );
    for (const key of expectedKeys) {
      const radius = sensors[key as keyof SensorSuite];
      assertContract(
        Number.isFinite(radius) && radius >= 0,
        `${id}: ${key} must be a finite nonnegative scalar`,
      );
    }
    if (sensors.jammingRadius > 0) {
      authoredJammers[id] = sensors.jammingRadius;
      assertContract(
        sensors.jammingRadius <= MAX_JAMMING_RADIUS,
        `${id}: jamming must stay within the ${MAX_JAMMING_RADIUS}-unit tactical ceiling`,
      );
    }
  }
  assertContract(suites > 40, `expected the full sensor roster, found ${suites} suites`);
  assertContract(
    JSON.stringify(authoredJammers) === JSON.stringify({
      turretSensorUnitDuck: 400,
      turretSensorBuildingRadarJammer: 1200,
      turretSensorBuildingSonarJammer: 1200,
      turretSensorUnitRadarJammer: 800,
    }),
    `the authored jammer roster must stay compact and intentional; got ${JSON.stringify(authoredJammers)}`,
  );
}

function createWorld(): WorldState {
  spatialGrid.clear();
  getSimWasm()?.combatTargeting.clear();
  const world = new WorldState(6101, 4096, 4096);
  world.playerCount = 3;
  world.fogOfWarEnabled = true;
  world.setTeamRoster(buildTeamRosterFromSeatCounts(
    [1 as PlayerId, 2 as PlayerId, 3 as PlayerId],
    [2, 1],
  ));
  return world;
}

function spawn(
  world: WorldState,
  x: number,
  y: number,
  z: number,
  playerId: number,
  sensors?: Partial<SensorSuite>,
): Entity {
  const entity = world.createUnitFromBlueprint(x, y, playerId as PlayerId, 'unitJackal');
  entity.transform.z = z;
  if (sensors !== undefined) {
    const config = entity.combat!.turrets[0].config.targeting.observation.sensors;
    config.visionRadius = sensors.visionRadius ?? 0;
    config.radarRadius = sensors.radarRadius ?? 0;
    config.detectorRadius = sensors.detectorRadius ?? 0;
    config.jammingRadius = sensors.jammingRadius ?? 0;
  }
  world.addEntity(entity);
  spatialGrid.updateUnit(entity);
  return entity;
}

/** A short corridor with enough water below the surface to place complete
 * target bodies and sensor origins below the waterline without burying them. */
function findSubmergedCorridor(
  world: WorldState,
  separation: number,
): { x: number; y: number; depth: number } {
  const step = 128;
  for (let y = step; y < world.mapHeight - step; y += step) {
    for (let x = step; x < world.mapWidth - step - separation; x += step) {
      let highestBed = -Infinity;
      let submerged = true;
      for (let t = 0; t <= 8; t++) {
        const bed = world.getTerrainBedZ(x + (separation * t) / 8, y);
        if (bed > WATER_LEVEL - 80) {
          submerged = false;
          break;
        }
        highestBed = Math.max(highestBed, bed);
      }
      if (submerged) {
        return {
          x,
          y,
          depth: Math.max(highestBed + 25, WATER_LEVEL - 50),
        };
      }
    }
  }
  throw new Error('[six-field sensor contract] no submerged corridor on the current terrain');
}

function assertHostOriginVisionAndRadarRouting(): void {
  const airWorld = createWorld();
  const wet = findSubmergedCorridor(airWorld, 500);
  const airSource = spawn(airWorld, wet.x, wet.y, WATER_LEVEL, 1, {
    visionRadius: 500,
    radarRadius: 700,
  });
  const airTarget = spawn(airWorld, wet.x + 200, wet.y, WATER_LEVEL + 100, 3);
  const waterTarget = spawn(airWorld, wet.x + 200, wet.y, wet.depth, 3);
  let airHostMedium: string | undefined;
  forEachEntityTurretSensorSource(airSource, (source) => {
    airHostMedium = source.hostMedium;
  });
  assertContract(
    getSensorMediumAtZ(WATER_LEVEL) === 'aboveWater' && airHostMedium === 'aboveWater',
    'a host origin exactly on the waterline must route to air',
  );
  stampCombatTargetingPool(airWorld);
  const airVisibility = SnapshotVisibility.forRecipient(airWorld, 1 as PlayerId);
  assertContract(airVisibility.isEntityVisible(airTarget), 'air-vision must reveal the air target');
  assertContract(!airVisibility.isEntityOnRadar(waterTarget), 'air vision/radar must not enter the water field');
  const sim = getSimWasm();
  assertContract(sim !== undefined, 'sim-wasm must be initialized for native six-field checks');
  const airViews = getCombatTargetingStateViews(sim);
  assertContract(
    (airViews.teamAirSightMask[airTarget.entitySlotId] & 1) !== 0 &&
      (airViews.teamWaterSightMask[waterTarget.entitySlotId] & 1) === 0 &&
      (airViews.teamWaterSonarMask[waterTarget.entitySlotId] & 1) === 0,
    'native masks must stamp the air host only into air-vision and air-radar',
  );

  const waterWorld = createWorld();
  const waterSource = spawn(waterWorld, wet.x, wet.y, WATER_LEVEL - 1, 1, {
    visionRadius: 500,
    radarRadius: 700,
  });
  const submergedTarget = spawn(waterWorld, wet.x + 200, wet.y, wet.depth, 3);
  const surfaceTarget = spawn(waterWorld, wet.x + 200, wet.y, WATER_LEVEL + 100, 3);
  let waterHostMedium: string | undefined;
  let mountedPointAboveWater = false;
  forEachEntityTurretSensorSource(waterSource, (source) => {
    waterHostMedium = source.hostMedium;
    mountedPointAboveWater = source.position.z >= WATER_LEVEL;
  });
  assertContract(
    waterHostMedium === 'underwater' && mountedPointAboveWater,
    'a below-water host must route to water even when its mounted sensor point is above water',
  );
  stampCombatTargetingPool(waterWorld);
  const waterVisibility = SnapshotVisibility.forRecipient(waterWorld, 1 as PlayerId);
  assertContract(waterVisibility.isEntityVisible(submergedTarget), 'water-vision must reveal the water target');
  assertContract(!waterVisibility.isEntityOnRadar(surfaceTarget), 'water vision/radar must not enter the air field');
  const waterViews = getCombatTargetingStateViews(sim);
  assertContract(
    (waterViews.teamWaterSightMask[submergedTarget.entitySlotId] & 1) !== 0 &&
      (waterViews.teamWaterSonarMask[submergedTarget.entitySlotId] & 1) !== 0 &&
      (waterViews.teamAirSightMask[surfaceTarget.entitySlotId] & 1) === 0 &&
      (waterViews.teamAirRadarMask[surfaceTarget.entitySlotId] & 1) === 0,
    'native masks must stamp the submerged host only into water-vision and water-radar',
  );
}

function radarContactVisible(world: WorldState, target: Entity): boolean {
  stampCombatTargetingPool(world);
  return SnapshotVisibility.forRecipient(world, 1 as PlayerId).isEntityOnRadar(target);
}

function assertHostOriginJammingRouting(): void {
  const wetWorld = createWorld();
  const wet = findSubmergedCorridor(wetWorld, 500);
  spawn(wetWorld, wet.x, wet.y, WATER_LEVEL + 100, 1, { radarRadius: 700 });
  const airTarget = spawn(wetWorld, wet.x + 300, wet.y, WATER_LEVEL + 100, 3);
  const wrongWaterJammer = spawn(
    wetWorld,
    wet.x + 300,
    wet.y,
    wet.depth,
    3,
    { jammingRadius: 180 },
  );
  let wrongMedium: string | undefined;
  forEachEntityTurretJammerSource(wrongWaterJammer, (source) => {
    wrongMedium = source.hostMedium;
  });
  assertContract(
    wrongMedium === 'underwater' && radarContactVisible(wetWorld, airTarget),
    'water-jamming must not deny an air-radar contact',
  );
  const airJammer = spawn(
    wetWorld,
    wet.x + 300,
    wet.y,
    WATER_LEVEL + 100,
    3,
    { jammingRadius: 180 },
  );
  let airJammerMedium: string | undefined;
  forEachEntityTurretJammerSource(airJammer, (source) => {
    airJammerMedium = source.hostMedium;
  });
  assertContract(
    airJammerMedium === 'aboveWater' && !radarContactVisible(wetWorld, airTarget),
    'air-jamming must deny an air-radar contact in its radius',
  );

  const waterWorld = createWorld();
  spawn(waterWorld, wet.x, wet.y, wet.depth, 1, { radarRadius: 700 });
  const waterTarget = spawn(waterWorld, wet.x + 300, wet.y, wet.depth, 3);
  spawn(
    waterWorld,
    wet.x + 300,
    wet.y,
    WATER_LEVEL + 100,
    3,
    { jammingRadius: 180 },
  );
  assertContract(
    radarContactVisible(waterWorld, waterTarget),
    'air-jamming must not deny a water-radar contact',
  );
  spawn(
    waterWorld,
    wet.x + 300,
    wet.y,
    wet.depth,
    3,
    { jammingRadius: 180 },
  );
  assertContract(
    !radarContactVisible(waterWorld, waterTarget),
    'water-jamming must deny a water-radar contact in its radius',
  );
}

function assertDrainedBasinsUseAirFields(): void {
  const world = createWorld();
  const exposed = findSubmergedCorridor(world, 500);
  const source = spawn(world, exposed.x, exposed.y, exposed.depth, 1, {
    visionRadius: 500,
    radarRadius: 700,
  });
  const target = spawn(world, exposed.x + 200, exposed.y, exposed.depth, 3);
  let hostMedium: string | undefined;
  forEachEntityTurretSensorSource(source, (sensor) => {
    hostMedium = sensor.hostMedium;
  });
  stampCombatTargetingPool(world);
  const sim = getSimWasm();
  assertContract(sim !== undefined, 'sim-wasm must be initialized for drained-medium checks');
  const views = getCombatTargetingStateViews(sim);
  assertContract(
    hostMedium === 'aboveWater'
      && (views.teamAirSightMask[target.entitySlotId] & 1) !== 0
      && (views.teamAirRadarMask[target.entitySlotId] & 1) !== 0
      && (views.teamWaterSightMask[target.entitySlotId] & 1) === 0
      && (views.teamWaterSonarMask[target.entitySlotId] & 1) === 0,
    'a drained basin must route both JS sources and native target occupancy exclusively through air fields',
  );
}

export function runSensorWaterlineSightContractTest(): void {
  assertAuthoredScalarSuites();
  const previousMap = getAuthoritativeTerrainTileMap();
  const previousLiquidSurfaceMode = getLiquidSurfaceMode();
  setAuthoritativeTerrainTileMap(buildTerrainTileMap(4096, 4096));
  setLiquidSurfaceMode('water');
  try {
    assertHostOriginVisionAndRadarRouting();
    assertHostOriginJammingRouting();
    setLiquidSurfaceMode('none');
    assertContract(
      getSensorMediumAtZ(WATER_LEVEL - 100_000) === 'aboveWater',
      'without a liquid plane, even an exposed basin far below datum must route vision, radar, and jamming to air',
    );
    assertDrainedBasinsUseAirFields();
  } finally {
    setLiquidSurfaceMode(previousLiquidSurfaceMode);
    setAuthoritativeTerrainTileMap(previousMap);
    spatialGrid.clear();
  }
}
