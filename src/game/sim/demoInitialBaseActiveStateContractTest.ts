import { getModeDefaultPreset } from '../../components/battlePresets';
import { LAND_CELL_SIZE } from '../../config';
import { DEMO_CONFIG } from '../../demoConfig';
import { generateMetalDeposits } from '../../metalDepositConfig';
import { buildingBlueprintHasActiveState } from './buildingActiveState';
import { ConstructionSystem } from './construction';
import { spawnInitialBases } from './spawn';
import { buildTeamRosterFromSeatCounts } from './teamRoster';
import type { BuildingBlueprintId, Entity, PlayerId } from './types';
import { WorldState } from './WorldState';
import { setTerrainRuntimeConfig } from './Terrain';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[demo initial base active state contract] ${message}`);
}

/** Stands up one demo opening base the way ServerBootstrap does. */
function spawnDemoBase(seed: number, mode: 'demo' | 'real'): Entity[] {
  const preset = getModeDefaultPreset('demo');
  setTerrainRuntimeConfig({
    centerMagnitude: preset.centerMagnitude,
    ringMagnitude: preset.ringMagnitude,
    dividersMagnitude: preset.dividersMagnitude,
    perimeterMagnitude: preset.perimeterMagnitude,
    terrainPrecedence: preset.terrainPrecedence,
    terrainDTerrain: preset.terrainDTerrain,
    plateauWallSlopeDegrees: preset.plateauWallSlopeDegrees,
    metalDepositStep: preset.metalDepositStep,
    terrainDetail: preset.terrainDetail,
  });
  const mapWidth = preset.mapWidthLandCells * LAND_CELL_SIZE;
  const mapHeight = preset.mapLengthLandCells * LAND_CELL_SIZE;
  const playerIds: PlayerId[] = [];
  for (let i = 0; i < DEMO_CONFIG.playerCount; i++) playerIds.push((i + 1) as PlayerId);

  const world = new WorldState(seed, mapWidth, mapHeight);
  world.setTeamRoster(buildTeamRosterFromSeatCounts(playerIds, DEMO_CONFIG.allyTeamSeats));
  world.metalDeposits = generateMetalDeposits(mapWidth, mapHeight, playerIds.length);
  const construction = new ConstructionSystem(mapWidth, mapHeight, null);
  return spawnInitialBases(world, construction, playerIds, mode);
}

/** Every id on the list must actually own an ON/OFF switch. A blueprint
 *  without one silently ignores the whole feature, which is how a config list
 *  quietly stops meaning anything after a blueprint is reworked. */
function assertListedBlueprintsCanBeSwitchedOff(): void {
  const listed = DEMO_CONFIG.initiallyOffBuildingBlueprintIds;
  assertContract(
    listed.size > 0,
    'demoConfig.initiallyOffBuildingBlueprintIds is empty — the feature is authored off entirely',
  );
  for (const id of listed) {
    assertContract(
      buildingBlueprintHasActiveState(id),
      `${id} is listed as initially OFF but has no ON/OFF switch, so the entry does nothing`,
    );
  }
}

/** The listed pre-placed buildings come up OFF; nothing else does. */
function assertDemoBaseHonoursTheAuthoredOffList(): void {
  const listed = DEMO_CONFIG.initiallyOffBuildingBlueprintIds;
  const entities = spawnDemoBase(4801, 'demo');

  const seenListed = new Set<BuildingBlueprintId>();
  let switchedHosts = 0;
  for (const entity of entities) {
    const blueprintId = entity.buildingBlueprintId;
    if (blueprintId === null || entity.building === null) continue;
    const state = entity.building.activeState;
    if (!buildingBlueprintHasActiveState(blueprintId)) {
      assertContract(
        state === null || state.wantOpen,
        `${blueprintId} has no ON/OFF switch but was left switched off`,
      );
      continue;
    }
    switchedHosts++;
    assertContract(
      state !== null,
      `pre-placed ${blueprintId} should have an active state after completion`,
    );

    if (listed.has(blueprintId)) {
      seenListed.add(blueprintId);
      // OFF means both halves: the durable player-style switch AND the live
      // state. `open` alone would be indistinguishable from the activation
      // debounce, which flips ON a few seconds later.
      assertContract(
        !state.wantOpen,
        `pre-placed ${blueprintId} is on the initially-OFF list but its switch is ON`,
      );
      assertContract(
        !state.open,
        `pre-placed ${blueprintId} is on the initially-OFF list but it is producing`,
      );
    } else {
      assertContract(
        state.wantOpen,
        `pre-placed ${blueprintId} is not on the initially-OFF list but came up switched off`,
      );
    }
  }

  assertContract(
    switchedHosts > 0,
    'the demo opening base placed no ON/OFF buildings at all — the check proved nothing',
  );
  for (const id of listed) {
    assertContract(
      seenListed.has(id),
      `${id} is on the initially-OFF list but the demo base never placed one, so the entry is untested`,
    );
  }
}

/** The list is scoped to the demo's opening base. A real-battle initial base
 *  carries an empty list, so the same blueprints come up running. */
function assertRealBaseIgnoresTheDemoOffList(): void {
  const listed = DEMO_CONFIG.initiallyOffBuildingBlueprintIds;
  const entities = spawnDemoBase(4802, 'real');

  let checked = 0;
  for (const entity of entities) {
    const blueprintId = entity.buildingBlueprintId;
    if (blueprintId === null || entity.building === null) continue;
    if (!listed.has(blueprintId)) continue;
    const state = entity.building.activeState;
    checked++;
    assertContract(
      state !== null && state.wantOpen,
      `${blueprintId} came up switched off in a real initial base — the demo list leaked`,
    );
  }
  assertContract(
    checked > 0,
    'no listed blueprint appeared in the real initial base, so the scoping check proved nothing',
  );
}

export function runDemoInitialBaseActiveStateContractTest(): void {
  assertListedBlueprintsCanBeSwitchedOff();
  assertDemoBaseHonoursTheAuthoredOffList();
  assertRealBaseIgnoresTheDemoOffList();
}
