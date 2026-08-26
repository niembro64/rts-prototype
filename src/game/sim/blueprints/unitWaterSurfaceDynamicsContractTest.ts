import type { GameServerConfig } from '@/types/game';
import {
  SIMULATION_TICK_RATE_OPTIONS,
  type SimulationTickRateHz,
} from '@/types/simulationTickRate';
import { disposeCheckpointCore } from '../../architecture/CanonicalCheckpoint';
import { resetReusableSimulationStateForDeterministicReplay } from '../../architecture/DeterministicReplayHarness';
import { ServerBootstrap } from '../../server/ServerBootstrap';
import { ServerSimulationCore } from '../../server/ServerSimulationCore';
import { createPhysicsBodyForUnit } from '../../server/unitPhysicsBody';
import type { PlayerId } from '../types';
import { WATER_LEVEL } from '../Terrain';
import {
  getAuthoritativeTerrainTileMap,
  setAuthoritativeTerrainTileMap,
} from '../terrain/terrainState';

const TEST_PLAYER_ID = 1 as PlayerId;
const RELEASE_HEIGHT_ABOVE_SUPPORT = 60;
const TEST_SECONDS = 12;

type ReleaseMetrics = {
  enteredWaterSupport: boolean;
  minSupportZ: number;
  maxSupportZAfterEntry: number;
  maxAbsVerticalSpeedAfterEightSeconds: number;
  finalSupportZ: number;
  finalVerticalSpeed: number;
  perSecondSupportZ: number[];
  perSecondVerticalSpeed: number[];
  perSecondLinearDampingRate: number[];
};

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[water surface dynamics contract] ${message}`);
}

function findDeepWaterPoint(core: ServerSimulationCore): { x: number; y: number } {
  const world = core.world;
  const probeOffsets = [
    [0, 0], [100, 0], [200, 0], [-100, 0], [0, 100], [0, -100],
  ] as const;
  let lowestProbeCeiling = Number.POSITIVE_INFINITY;
  let lowestProbeCeilingPoint = { x: Number.NaN, y: Number.NaN };
  for (let y = 300; y <= world.mapHeight - 300; y += 25) {
    for (let x = 300; x <= world.mapWidth - 300; x += 25) {
      let probeCeiling = Number.NEGATIVE_INFINITY;
      for (const [dx, dy] of probeOffsets) {
        probeCeiling = Math.max(probeCeiling, world.getTerrainBedZ(x + dx, y + dy));
      }
      if (probeCeiling < lowestProbeCeiling) {
        lowestProbeCeiling = probeCeiling;
        lowestProbeCeilingPoint = { x, y };
      }
      const allProbesAreDeep = probeCeiling <= WATER_LEVEL - 80;
      if (allProbesAreDeep) return { x, y };
    }
  }
  throw new Error(
    '[water surface dynamics contract] could not find a deep-water probe area; ' +
    `lowest probe ceiling was ${lowestProbeCeiling} at ${JSON.stringify(lowestProbeCeilingPoint)}, ` +
    `required <= ${WATER_LEVEL - 80}`,
  );
}

function releaseAndMeasure(
  core: ServerSimulationCore,
  unitBlueprintId: 'unitWaterStrider' | 'unitPatrolCorvette',
  x: number,
  y: number,
  simulationTickRateHz: SimulationTickRateHz,
): ReleaseMetrics {
  const entity = core.world.createUnitFromBlueprint(
    x,
    y,
    TEST_PLAYER_ID,
    unitBlueprintId,
    { allocateSubEntityIds: false },
  );
  assertContract(entity.unit !== null, `${unitBlueprintId} fixture must be a unit`);
  entity.transform.z = WATER_LEVEL + entity.unit.supportPointOffsetZ +
    RELEASE_HEIGHT_ABOVE_SUPPORT;
  core.world.addEntity(entity);
  const body = createPhysicsBodyForUnit(core.world, core.physics, entity);
  assertContract(body !== undefined, `${unitBlueprintId} fixture must receive a physics body`);
  core.physics.wakeBody(body);

  const metrics: ReleaseMetrics = {
    enteredWaterSupport: false,
    minSupportZ: Number.POSITIVE_INFINITY,
    maxSupportZAfterEntry: Number.NEGATIVE_INFINITY,
    maxAbsVerticalSpeedAfterEightSeconds: 0,
    finalSupportZ: Number.NaN,
    finalVerticalSpeed: Number.NaN,
    perSecondSupportZ: [],
    perSecondVerticalSpeed: [],
    perSecondLinearDampingRate: [],
  };
  const fixedDtMs = 1000 / simulationTickRateHz;
  const stepCount = TEST_SECONDS * simulationTickRateHz;
  for (let step = 0; step < stepCount; step++) {
    core.stepFixedTick(fixedDtMs);
    const unit = entity.unit;
    assertContract(unit !== null, `${unitBlueprintId} must survive its water-release fixture`);
    const supportZ = entity.transform.z - unit.supportPointOffsetZ - WATER_LEVEL;
    if (supportZ <= 0) metrics.enteredWaterSupport = true;
    if (metrics.enteredWaterSupport) {
      metrics.minSupportZ = Math.min(metrics.minSupportZ, supportZ);
      metrics.maxSupportZAfterEntry = Math.max(metrics.maxSupportZAfterEntry, supportZ);
    }
    if ((step + 1) * fixedDtMs >= 8000) {
      metrics.maxAbsVerticalSpeedAfterEightSeconds = Math.max(
        metrics.maxAbsVerticalSpeedAfterEightSeconds,
        Math.abs(unit.velocityZ),
      );
    }
    metrics.finalSupportZ = supportZ;
    metrics.finalVerticalSpeed = unit.velocityZ;
    if ((step + 1) % simulationTickRateHz === 0) {
      metrics.perSecondSupportZ.push(Math.round(supportZ * 1000) / 1000);
      metrics.perSecondVerticalSpeed.push(Math.round(unit.velocityZ * 1000) / 1000);
      metrics.perSecondLinearDampingRate.push(
        Math.round(body.linearDragCoefficient / body.mass * 1000) / 1000,
      );
    }
  }
  core.world.removeEntity(entity.id);
  return metrics;
}

function assertSettledSurfaceRelease(
  unitBlueprintId: string,
  simulationTickRateHz: SimulationTickRateHz,
  metrics: ReleaseMetrics,
): void {
  const context = `${unitBlueprintId} at ${simulationTickRateHz} Hz`;
  // At 1 Hz the body can cross the water plane and spend almost one whole
  // authoritative frame falling before its newly occupied water share is
  // sampled. Keep that deliberately coarse mode bounded without pretending
  // it has 20 Hz entry resolution; ordinary rates retain the tight bound.
  const minimumSupportZ = simulationTickRateHz === 1
    ? -75
    : simulationTickRateHz === 5
      ? -25
      : -20;
  assertContract(metrics.enteredWaterSupport, `${context} must reach its water support`);
  assertContract(
    metrics.minSupportZ >= minimumSupportZ,
    `${context} must keep its entry dip bounded: ${JSON.stringify(metrics)}`,
  );
  assertContract(
    metrics.maxSupportZAfterEntry <= 12,
    `${context} must not launch back out of the water: ${JSON.stringify(metrics)}`,
  );
  assertContract(
    metrics.finalSupportZ >= -15 && metrics.finalSupportZ <= 2,
    `${context} support point must settle at the water surface: ${JSON.stringify(metrics)}`,
  );
  assertContract(
    Math.abs(metrics.finalVerticalSpeed) <= 1 &&
      metrics.maxAbsVerticalSpeedAfterEightSeconds <= 2,
    `${context} vertical motion must damp out: ${JSON.stringify(metrics)}`,
  );
}

export function runUnitWaterSurfaceDynamicsContractTest(): void {
  const installedTerrain = getAuthoritativeTerrainTileMap();
  try {
    for (const simulationTickRateHz of SIMULATION_TICK_RATE_OPTIONS) {
      resetReusableSimulationStateForDeterministicReplay();
      const config: GameServerConfig = {
        playerIds: [TEST_PLAYER_ID],
        centerMagnitude: 0,
        ringMagnitude: 0,
        dividersMagnitude: 0,
        perimeterMagnitude: -800,
        terrainPrecedence: 'perimeter-precedence',
        terrainDTerrain: 0,
        plateauWallSlopeDegrees: 89,
        metalDepositStep: 0,
        terrainDetail: 1,
        mapWidthLandCells: 9,
        mapLengthLandCells: 9,
        converterTax: 0,
        simulationTickRateHz,
      };
      const core = new ServerSimulationCore(ServerBootstrap.bootstrap(config));
      try {
        for (const entity of [...core.world.getUnitsAndBuildings()]) {
          core.world.removeEntity(entity.id);
        }
        const water = findDeepWaterPoint(core);
        assertSettledSurfaceRelease(
          'unitWaterStrider',
          simulationTickRateHz,
          releaseAndMeasure(
            core,
            'unitWaterStrider',
            water.x,
            water.y,
            simulationTickRateHz,
          ),
        );
        assertSettledSurfaceRelease(
          'unitPatrolCorvette',
          simulationTickRateHz,
          releaseAndMeasure(
            core,
            'unitPatrolCorvette',
            water.x,
            water.y,
            simulationTickRateHz,
          ),
        );
      } finally {
        disposeCheckpointCore(core);
      }
    }
  } finally {
    setAuthoritativeTerrainTileMap(installedTerrain);
  }
}
