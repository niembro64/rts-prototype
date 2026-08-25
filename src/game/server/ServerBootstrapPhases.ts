// ServerBootstrapPhases - the ordered, side-effecting steps shared by the two
// ServerBootstrap entry points.
//
// `ServerBootstrap.bootstrapAsync` and `ServerBootstrap.bootstrap` run the
// SAME sequence; they differ only in whether they yield to a progress reporter
// between phases. Any drift between those two sequences is a desync bug (the
// host and the background/offline world would generate different terrain,
// deposits, or spawns from identical config), so the steps live here once and
// both entry points call them in order.
//
// Order dependencies are documented on each phase and must be preserved.

import { LAND_CELL_SIZE, getMapSize } from '../../config';
import { generateMetalDeposits } from '../../metalDepositConfig';
import type { MetalDeposit } from '../../metalDepositConfig';
import { ensureVegetationGenerated } from '../sim/vegetation';
import type { TerrainTileMap } from '@/types/terrain';
import type { GameServerConfig } from '@/types/game';
import { CommandQueue } from '../sim/commands';
import { Simulation } from '../sim/Simulation';
import { WorldState } from '../sim/WorldState';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import {
  buildTerrainTileMap,
  getTerrainRuntimeConfig,
  setAuthoritativeTerrainTileMap,
  setTerrainCenterMagnitude,
  setTerrainRingMagnitude,
  setTerrainDividersMagnitude,
  setTerrainPerimeterMagnitude,
  setTerrainPrecedence,
  setTerrainRuntimeConfig,
  setTerrainTeamCount,
} from '../sim/Terrain';
import { getTerrainDividerTeamCount, normalizePlayerIds } from '../sim/playerLayout';
import { resolveTeamRoster } from '../sim/teamRoster';
import type { TeamRoster } from '../sim/teamRoster';
import { spawnInitialBases, spawnMetalExtractorsOnDeposits } from '../sim/spawn';
import type { Entity, PlayerId } from '../sim/types';
import { BACKGROUND_UNIT_BLUEPRINT_IDS } from './BackgroundBattleStandalone';
import { BUILDING_BLUEPRINT_IDS } from '../../types/blueprintIds';
import { PhysicsEngine3D } from './PhysicsEngine3D';
import {
  DEFAULT_GAME_GENERATION_SEED,
  normalizeGameGenerationSeed,
} from '../network/gameGenerationSeed';
import { precomputeAllUnitPathTraversabilityGrids } from '../sim/pathfindingTraversabilityGrid';
import { setLiquidSurfaceMode, setMetalCoverage } from '../sim/worldSurfaceState';
import {
  DEFAULT_LIQUID_SURFACE_MODE,
  DEFAULT_METAL_COVERAGE,
} from '../../types/worldSurfaceMode';
import type { LiquidSurfaceMode, MetalCoverage } from '../../types/worldSurfaceMode';
import { normalizeSimulationTickRateHz } from '../../types/simulationTickRate';
import type { SimulationTickRateHz } from '../../types/simulationTickRate';

export type ResolvedBootstrapConfig = {
  playerIds: PlayerId[];
  teamRoster: TeamRoster;
  gameGenerationSeed: number;
  backgroundMode: boolean;
  simulationTickRateHz: SimulationTickRateHz;
  metalCoverage: MetalCoverage;
  liquidSurfaceMode: LiquidSurfaceMode;
  mapWidth: number;
  mapHeight: number;
};

/** Phase 1 — normalize the caller's config and install the process-wide
 *  surface settings every later phase samples. */
export function resolveBootstrapConfig(config: GameServerConfig): ResolvedBootstrapConfig {
  const playerIds = normalizePlayerIds(config.playerIds);
  const teamRoster = resolveTeamRoster(playerIds, {
    allyTeamCount: config.allyTeamCount,
    allyTeamSeats: config.allyTeamSeats,
    allyTeamByPlayerId: config.allyTeamByPlayerId,
  });
  const gameGenerationSeed = normalizeGameGenerationSeed(
    config.gameGenerationSeed ?? DEFAULT_GAME_GENERATION_SEED,
  );
  const backgroundMode = config.backgroundMode ?? false;
  const simulationTickRateHz = normalizeSimulationTickRateHz(
    config.simulationTickRateHz,
  );
  const metalCoverage = config.metalCoverage ?? DEFAULT_METAL_COVERAGE;
  const liquidSurfaceMode = config.liquidSurfaceMode ?? DEFAULT_LIQUID_SURFACE_MODE;
  setMetalCoverage(metalCoverage);
  setLiquidSurfaceMode(liquidSurfaceMode);

  const mapConfig = getMapSize(
    backgroundMode,
    config.mapWidthLandCells,
    config.mapLengthLandCells,
  );

  return {
    playerIds,
    teamRoster,
    gameGenerationSeed,
    backgroundMode,
    simulationTickRateHz,
    metalCoverage,
    liquidSurfaceMode,
    mapWidth: mapConfig.width,
    mapHeight: mapConfig.height,
  };
}

/** Phase 2 — install the terrain shape.
 *
 *  Tell the heightmap how many radial player slices are active so it can lay
 *  down the matching divider ridges. A one-player map still uses one slice and
 *  one divider slice; no map-building math branches on "solo". This must run
 *  BEFORE WorldState, deposit flattening, and renderer mesh baking so every
 *  consumer reads the same surface. */
export function configureBootstrapTerrain(
  config: GameServerConfig,
  teamRoster: TeamRoster,
): void {
  const terrainRuntimeConfig = getTerrainRuntimeConfig();
  const centerMagnitude =
    config.centerMagnitude ?? terrainRuntimeConfig.centerMagnitude;
  const ringMagnitude =
    config.ringMagnitude ?? terrainRuntimeConfig.ringMagnitude;
  const dividersMagnitude =
    config.dividersMagnitude ?? terrainRuntimeConfig.dividersMagnitude;
  const perimeterMagnitude =
    config.perimeterMagnitude ?? terrainRuntimeConfig.perimeterMagnitude;
  const terrainPrecedence =
    config.terrainPrecedence ?? terrainRuntimeConfig.terrainPrecedence;
  setTerrainRuntimeConfig({
    centerMagnitude,
    ringMagnitude,
    dividersMagnitude,
    perimeterMagnitude,
    terrainPrecedence,
    terrainDTerrain:
      config.terrainDTerrain ?? terrainRuntimeConfig.terrainDTerrain,
    plateauWallSlopeDegrees:
      config.plateauWallSlopeDegrees ??
      terrainRuntimeConfig.plateauWallSlopeDegrees,
    metalDepositStep:
      config.metalDepositStep ?? terrainRuntimeConfig.metalDepositStep,
    terrainDetail:
      config.terrainDetail ?? terrainRuntimeConfig.terrainDetail,
  });
  setTerrainTeamCount(getTerrainDividerTeamCount(teamRoster.allyTeamIds.length));
  setTerrainCenterMagnitude(centerMagnitude);
  setTerrainRingMagnitude(ringMagnitude);
  setTerrainDividersMagnitude(dividersMagnitude);
  setTerrainPerimeterMagnitude(perimeterMagnitude);
  setTerrainPrecedence(terrainPrecedence);
}

/** Phase 3 — metal deposits.
 *
 *  Same set across all clients (deterministic from map size + player count).
 *  `generateMetalDeposits` installs the resulting flat zones into the terrain
 *  state itself (see its docstring — needed for the two-pass null-dTerrain
 *  resolution), so by the time we hit `buildBootstrapTerrainTileMap` the
 *  heightmap and every downstream sim/render sampler already sees the pads.
 *
 *  Deposits are laid out in radial slices phase-aligned to the terrain
 *  dividers, so they must count SIDES, not seats — otherwise a 2v2v2 would
 *  phase deposits on 60-degree spokes while the ridges run on 120-degree ones
 *  and metal would end up buried inside a divider. */
export function generateBootstrapMetalDeposits(
  resolved: ResolvedBootstrapConfig,
): MetalDeposit[] {
  return generateMetalDeposits(
    resolved.mapWidth,
    resolved.mapHeight,
    resolved.teamRoster.allyTeamIds.length,
    resolved.metalCoverage,
  );
}

/** Phase 4 — bake the authoritative terrain tile map. */
export function buildBootstrapTerrainTileMap(
  resolved: ResolvedBootstrapConfig,
): TerrainTileMap {
  const terrainTileMap = buildTerrainTileMap(
    resolved.mapWidth,
    resolved.mapHeight,
    LAND_CELL_SIZE,
  );
  setAuthoritativeTerrainTileMap(terrainTileMap);
  return terrainTileMap;
}

/** Phase 5 — the path-traversability classification pass. */
export function precomputeBootstrapPathGrids(resolved: ResolvedBootstrapConfig): void {
  precomputeAllUnitPathTraversabilityGrids(resolved.mapWidth, resolved.mapHeight);
}

/** Phase 6 — build the WorldState and wire it to physics. */
export function createBootstrapWorld(
  resolved: ResolvedBootstrapConfig,
  deposits: MetalDeposit[],
  physics: PhysicsEngine3D,
): WorldState {
  const world = new WorldState(
    resolved.gameGenerationSeed,
    resolved.mapWidth,
    resolved.mapHeight,
  );
  world.simulationTickRateHz = resolved.simulationTickRateHz;
  world.metalCoverage = resolved.metalCoverage;
  world.liquidSurfaceMode = resolved.liquidSurfaceMode;
  world.playerCount = resolved.playerIds.length;
  // One assignment drives alliances, terrain slices, and spawn angles.
  world.setTeamRoster(resolved.teamRoster);
  world.metalDeposits = deposits;
  // Trees, grass, and seaweed are reclaimable energy deposits, so their
  // layout is simulation state. It is derived deterministically from the
  // installed terrain mesh plus map/config inputs — the renderer calls the
  // same idempotent front door and gets this exact list rather than laying
  // out a second, private forest.
  ensureVegetationGenerated(
    resolved.mapWidth,
    resolved.mapHeight,
    resolved.playerIds.length,
  );
  // Wire the terrain bed into physics so solid ground contacts remain
  // independent of the air/water medium occupying the same XY.
  physics.setGroundLookup(
    (x, y) => world.getTerrainBedZ(x, y),
    (x, y) => world.getCachedTerrainBedNormal(x, y),
  );
  world.setActivePlayer(0 as PlayerId); // Server has no active player
  return world;
}

/** Phase 7 — the command queue + simulation pair. */
export function createBootstrapSimulation(
  world: WorldState,
  terrainBuildabilityGrid: TerrainBuildabilityGrid,
  playerIds: PlayerId[],
): { commandQueue: CommandQueue; simulation: Simulation } {
  const commandQueue = new CommandQueue();
  const simulation = new Simulation(world, commandQueue, terrainBuildabilityGrid);
  simulation.setPlayerIds(playerIds);
  return { commandQueue, simulation };
}

export type BootstrapSpawnRules = {
  backgroundAllowedUnitBlueprintIds: Set<string>;
  backgroundAllowedBuildingBlueprintIds: Set<string>;
  /** Seats with AGENT TYPE 'bot' — see src/game/sim/agentSeat.ts. */
  aiPlayerIds: PlayerId[];
  /** Seats with INITIAL STATE 'base'; everyone else spawns a commander. */
  baseSeatPlayerIds: PlayerId[];
};

/** Phase 8 — resolve the spawn rules and apply the world-level overrides they
 *  depend on.
 *
 *  Honour any saved demo-unit selection passed in by the caller — this MUST
 *  happen before spawnBackgroundUnitsStandalone so the initial spawn picks
 *  from the restricted set. Otherwise we'd create units of disallowed types
 *  and immediately wipe them via the toggle handler.
 *
 *  Same ordering rule for the entity count cap: the demo spawn fills each
 *  SIDE's share of it in randomized slots, so the cap must be set BEFORE
 *  spawnBackgroundUnitsStandalone runs. Without this override, the world boots
 *  at DEFAULT_ENTITY_COUNT_CAP (4096) regardless of user storage, the spawn
 *  fills to that, and only AFTER would `setEntityCountCap` arrive from
 *  LobbyManager — producing the visible "4075/16" mismatch where the spawn
 *  count and the displayed cap disagree. */
export function resolveBootstrapSpawnRules(
  config: GameServerConfig,
  world: WorldState,
  resolved: ResolvedBootstrapConfig,
): BootstrapSpawnRules {
  const backgroundAllowedUnitBlueprintIds = new Set(
    config.initialAllowedUnitBlueprintIds ?? BACKGROUND_UNIT_BLUEPRINT_IDS,
  );
  const backgroundAllowedBuildingBlueprintIds = new Set(
    config.initialAllowedBuildingBlueprintIds ?? BUILDING_BLUEPRINT_IDS,
  );
  if (config.initialEntityCountCap !== undefined && config.initialEntityCountCap > 0) {
    world.entityCountCap = config.initialEntityCountCap;
  }
  if (config.converterTax !== undefined && Number.isFinite(config.converterTax)) {
    world.converterTax = config.converterTax;
  }
  const aiPlayerIds =
    config.aiPlayerIds ?? (resolved.backgroundMode ? [...resolved.playerIds] : []);
  // Initial state is a PER-SEAT axis (src/game/sim/agentSeat.ts). When the
  // caller says nothing, the old defaults hold: the demo/background battle
  // opens every seat with a full base, real games open every seat as a
  // commander so their spawn layout matches hosted network games. Callers
  // mix the axes explicitly — a lobby preview passes [] to stay
  // commander-only, a skirmish may hand a base to any subset of seats.
  const baseSeatPlayerIds =
    config.baseSeatPlayerIds !== undefined
      ? normalizeSeatSubset(config.baseSeatPlayerIds, resolved.playerIds)
      : resolved.backgroundMode && aiPlayerIds.length > 0
        ? [...resolved.playerIds]
        : [];
  return {
    backgroundAllowedUnitBlueprintIds,
    backgroundAllowedBuildingBlueprintIds,
    aiPlayerIds,
    baseSeatPlayerIds,
  };
}

/** A seat-axis subset is only meaningful over seats that exist; anything
 *  else in it is a caller bug that would otherwise spawn a ghost base. */
function normalizeSeatSubset(
  subset: readonly PlayerId[],
  playerIds: readonly PlayerId[],
): PlayerId[] {
  const seats = new Set(playerIds);
  return subset.filter((playerId) => seats.has(playerId));
}

/** Phase 9a — the full-base spawn for every seat whose INITIAL STATE is
 *  'base'. The base MODE (initially-off switches, fight-leg distance)
 *  follows the battle kind, not the seat: a base seat in a real battle
 *  plays by real-battle rules. Game-start factories get the full patrol
 *  route in BOTH modes — the complex-vs-simple waypoint split is game-init
 *  vs built-in-play, decided in spawn.ts/construction.ts. */
export function spawnBootstrapDemoBases(
  world: WorldState,
  simulation: Simulation,
  playerIds: PlayerId[],
  rules: BootstrapSpawnRules,
  backgroundMode: boolean,
): Entity[] {
  return spawnInitialBases(
    world,
    simulation.getConstructionSystem(),
    playerIds,
    backgroundMode ? 'demo' : 'real',
    rules.backgroundAllowedUnitBlueprintIds,
    rules.backgroundAllowedBuildingBlueprintIds,
  );
}

/** Phase 9b — metal extractors seeded onto the generated deposits. */
export function spawnBootstrapDemoExtractors(
  world: WorldState,
  simulation: Simulation,
  playerIds: PlayerId[],
  rules: BootstrapSpawnRules,
  ownerCandidatePlayerIds: readonly PlayerId[],
): Entity[] {
  return spawnMetalExtractorsOnDeposits(
    world,
    simulation.getConstructionSystem(),
    playerIds,
    rules.backgroundAllowedBuildingBlueprintIds,
    ownerCandidatePlayerIds,
  );
}
