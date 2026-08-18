// ServerBootstrap - One-shot wiring of the host-side world objects.
//
// Owns the procedural sequence the GameServer constructor used to run
// inline: terrain shape configuration, metal deposit generation, terrain
// mesh / buildability grid construction, physics + WorldState + Simulation
// creation, and the initial entity spawn (with physics bodies). Pulled out
// of GameServer so the host class is left with instance-level concerns
// (tick scheduling, EMAs, listeners, callbacks).
//
// Order dependencies are documented inline; callers should treat the
// `bootstrap` result as the canonical wired-up state for one game session.

import {
  LAND_CELL_SIZE,
  getMapSize,
} from '../../config';
import { generateMetalDeposits } from '../../metalDepositConfig';
import { ensureVegetationGenerated } from '../sim/vegetation';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import type { GameServerConfig } from '@/types/game';
import { CommandQueue } from '../sim/commands';
import { Simulation } from '../sim/Simulation';
import { WorldState } from '../sim/WorldState';
import {
  buildTerrainTileMap,
  getTerrainRuntimeConfig,
  setAuthoritativeTerrainTileMap,
  setTerrainCenterMagnitude,
  setTerrainDividersMagnitude,
  setTerrainPerimeterMagnitude,
  setTerrainRuntimeConfig,
  setTerrainTeamCount,
} from '../sim/Terrain';
import { buildTerrainBuildabilityGrid } from '../sim/terrain/terrainBuildability';
import { getTerrainDividerTeamCount, normalizePlayerIds } from '../sim/playerLayout';
import { resolveTeamRoster } from '../sim/teamRoster';
import {
  spawnInitialBases,
  spawnInitialEntities,
  spawnMetalExtractorsOnDeposits,
} from '../sim/spawn';
import type { Entity, PlayerId } from '../sim/types';
import { BACKGROUND_UNIT_BLUEPRINT_IDS, spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import { BUILDING_BLUEPRINT_IDS } from '../../types/blueprintIds';
import { PhysicsEngine3D } from './PhysicsEngine3D';
import {
  createBuildingBodiesForEntities,
  createUnitBodiesForEntities,
} from './InitialPhysicsBodiesHelpers';
import {
  DEFAULT_GAME_GENERATION_SEED,
  normalizeGameGenerationSeed,
} from '../network/gameGenerationSeed';
import { createLoadProgressReporter } from '../lifecycle/loadProgressReporter';
import { precomputeAllUnitPathTraversabilityGrids } from '../sim/pathfindingTraversabilityGrid';
import { configurePathfindingCellConsolidationMultiplier } from '../sim/pathfinderTerrainCache';
import {
  setLiquidSurfaceMode,
  setTerrainSurfaceMode,
} from '../sim/worldSurfaceState';
import {
  DEFAULT_LIQUID_SURFACE_MODE,
  DEFAULT_TERRAIN_SURFACE_MODE,
} from '../../types/worldSurfaceMode';
import { normalizePathfindingCellConsolidationMultiplier } from '../../types/pathfinding';
import { normalizeSimulationTickRateHz } from '../../types/simulationTickRate';

export interface BootstrappedServerWorld {
  physics: PhysicsEngine3D;
  world: WorldState;
  simulation: Simulation;
  commandQueue: CommandQueue;
  playerIds: PlayerId[];
  backgroundMode: boolean;
  backgroundAllowedUnitBlueprintIds: Set<string>;
  backgroundAllowedBuildingBlueprintIds: Set<string>;
  terrainTileMap: TerrainTileMap;
  terrainBuildabilityGrid: TerrainBuildabilityGrid;
}

type BootstrapProgress = (progress: number, phase: string | undefined) => void | Promise<void>;

export class ServerBootstrap {
  static async bootstrapAsync(
    config: GameServerConfig,
    providedPhysics: PhysicsEngine3D | undefined = undefined,
    onProgress: BootstrapProgress = () => {},
  ): Promise<BootstrappedServerWorld> {
    const report = createLoadProgressReporter(onProgress);

    await report(0, 'Reading map size');
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
    const pathfindingCellConsolidationMultiplier =
      normalizePathfindingCellConsolidationMultiplier(
        config.pathfindingCellConsolidationMultiplier,
      );
    const simulationTickRateHz = normalizeSimulationTickRateHz(
      config.simulationTickRateHz,
    );
    configurePathfindingCellConsolidationMultiplier(
      pathfindingCellConsolidationMultiplier,
    );
    const terrainSurfaceMode =
      config.terrainSurfaceMode ?? DEFAULT_TERRAIN_SURFACE_MODE;
    const liquidSurfaceMode =
      config.liquidSurfaceMode ?? DEFAULT_LIQUID_SURFACE_MODE;
    setTerrainSurfaceMode(terrainSurfaceMode);
    setLiquidSurfaceMode(liquidSurfaceMode);

    const mapConfig = getMapSize(
      backgroundMode,
      config.mapWidthLandCells,
      config.mapLengthLandCells,
    );
    const mapWidth = mapConfig.width;
    const mapHeight = mapConfig.height;
    await report(0.06, 'Reading map size');

    const terrainRuntimeConfig = getTerrainRuntimeConfig();
    const centerMagnitude =
      config.centerMagnitude ?? terrainRuntimeConfig.centerMagnitude;
    const dividersMagnitude =
      config.dividersMagnitude ?? terrainRuntimeConfig.dividersMagnitude;
    const perimeterMagnitude =
      config.perimeterMagnitude ?? terrainRuntimeConfig.perimeterMagnitude;
    setTerrainRuntimeConfig({
      centerMagnitude,
      dividersMagnitude,
      perimeterMagnitude,
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
    setTerrainDividersMagnitude(dividersMagnitude);
    setTerrainPerimeterMagnitude(perimeterMagnitude);
    await report(0.14, 'Configuring terrain');

    // Deposits are laid out in radial slices phase-aligned to the terrain
    // dividers, so they must count SIDES, not seats — otherwise a 2v2v2
    // would phase deposits on 60-degree spokes while the ridges run on
    // 120-degree ones and metal would end up buried inside a divider.
    const deposits = generateMetalDeposits(
      mapWidth,
      mapHeight,
      teamRoster.allyTeamIds.length,
    );
    await report(0.24, 'Generating metal deposits');

    const terrainTileMap = buildTerrainTileMap(mapWidth, mapHeight, LAND_CELL_SIZE);
    setAuthoritativeTerrainTileMap(terrainTileMap);
    await report(0.38, 'Building terrain map');

    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(mapWidth, mapHeight);
    await report(0.48, 'Building placement grid');
    precomputeAllUnitPathTraversabilityGrids(mapWidth, mapHeight);
    await report(0.53, 'Classifying unit path squares');

    const physics = providedPhysics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    try {
    const world = new WorldState(gameGenerationSeed, mapWidth, mapHeight);
    world.simulationTickRateHz = simulationTickRateHz;
    world.terrainSurfaceMode = terrainSurfaceMode;
    world.liquidSurfaceMode = liquidSurfaceMode;
    world.pathfindingCellConsolidationMultiplier =
      pathfindingCellConsolidationMultiplier;
    world.playerCount = playerIds.length;
    // One assignment drives alliances, terrain slices, and spawn angles.
    world.setTeamRoster(teamRoster);
    world.metalDeposits = deposits;
    // Trees, grass, and seaweed are reclaimable energy deposits, so their
    // layout is simulation state. It is derived deterministically from the
    // installed terrain mesh plus map/config inputs — the
    // renderer calls the same idempotent front door and gets this exact
    // list rather than laying out a second, private forest.
    ensureVegetationGenerated(mapWidth, mapHeight, playerIds.length);
    physics.setGroundLookup(
      (x, y) => world.getTerrainBedZ(x, y),
      (x, y) => world.getCachedTerrainBedNormal(x, y),
    );
    world.setActivePlayer(0 as PlayerId);
    await report(0.58, 'Creating physics world');

    const commandQueue = new CommandQueue();
    const simulation = new Simulation(world, commandQueue, terrainBuildabilityGrid);
    simulation.setPlayerIds(playerIds);
    await report(0.66, 'Creating simulation');

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
    const aiPlayerIds = config.aiPlayerIds ?? (backgroundMode ? [...playerIds] : []);
    const spawnDemoInitialState =
      backgroundMode && (config.spawnDemoInitialState ?? aiPlayerIds.length > 0);
    await report(0.72, 'Preparing spawn rules');

    if (spawnDemoInitialState) {
      const constructionSystem = simulation.getConstructionSystem();
      const entities = spawnInitialBases(
        world,
        constructionSystem,
        playerIds,
        'demo',
        backgroundAllowedUnitBlueprintIds,
        backgroundAllowedBuildingBlueprintIds,
      );
      await report(0.78, 'Spawning bases');

      entities.push(...spawnMetalExtractorsOnDeposits(
        world,
        constructionSystem,
        playerIds,
        backgroundAllowedBuildingBlueprintIds,
      ));
      await report(0.82, 'Placing metal extractors');

      await ServerBootstrap.createInitialPhysicsBodiesAsync(
        world,
        physics,
        entities,
        0.82,
        0.88,
        'Creating base physics',
        report,
      );

      await report(0.9, 'Generating demo units');
      spawnBackgroundUnitsStandalone(
        world, physics, true,
        backgroundAllowedUnitBlueprintIds,
        playerIds,
      );
      await report(0.94, 'Demo units ready');
    } else {
      const entities = spawnInitialEntities(world, playerIds);
      await report(0.82, 'Spawning commanders');
      await ServerBootstrap.createInitialPhysicsBodiesAsync(
        world,
        physics,
        entities,
        0.82,
        0.94,
        'Creating unit physics',
        report,
      );
    }
    simulation.setAiPlayerIds(aiPlayerIds);
    await report(1, 'Starting AI players');

    return {
      physics,
      world,
      simulation,
      commandQueue,
      playerIds,
      backgroundMode,
      backgroundAllowedUnitBlueprintIds,
      backgroundAllowedBuildingBlueprintIds,
      terrainTileMap,
      terrainBuildabilityGrid,
    };
    } catch (err) {
      if (providedPhysics === undefined) physics.dispose();
      throw err;
    }
  }

  static bootstrap(
    config: GameServerConfig,
    providedPhysics: PhysicsEngine3D | undefined = undefined,
  ): BootstrappedServerWorld {
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
    const pathfindingCellConsolidationMultiplier =
      normalizePathfindingCellConsolidationMultiplier(
        config.pathfindingCellConsolidationMultiplier,
      );
    const simulationTickRateHz = normalizeSimulationTickRateHz(
      config.simulationTickRateHz,
    );
    configurePathfindingCellConsolidationMultiplier(
      pathfindingCellConsolidationMultiplier,
    );
    const terrainSurfaceMode =
      config.terrainSurfaceMode ?? DEFAULT_TERRAIN_SURFACE_MODE;
    const liquidSurfaceMode =
      config.liquidSurfaceMode ?? DEFAULT_LIQUID_SURFACE_MODE;
    setTerrainSurfaceMode(terrainSurfaceMode);
    setLiquidSurfaceMode(liquidSurfaceMode);

    const mapConfig = getMapSize(
      backgroundMode,
      config.mapWidthLandCells,
      config.mapLengthLandCells,
    );
    const mapWidth = mapConfig.width;
    const mapHeight = mapConfig.height;

    // Tell the heightmap how many radial player slices are active so
    // it can lay down the matching divider ridges. A one-player map
    // still uses one slice and one divider slice; no map-building math
    // branches on "solo". Set BEFORE WorldState, deposit flattening,
    // and renderer mesh baking so every consumer reads the same surface.
    const terrainRuntimeConfig = getTerrainRuntimeConfig();
    const centerMagnitude =
      config.centerMagnitude ?? terrainRuntimeConfig.centerMagnitude;
    const dividersMagnitude =
      config.dividersMagnitude ?? terrainRuntimeConfig.dividersMagnitude;
    const perimeterMagnitude =
      config.perimeterMagnitude ?? terrainRuntimeConfig.perimeterMagnitude;
    setTerrainRuntimeConfig({
      centerMagnitude,
      dividersMagnitude,
      perimeterMagnitude,
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
    setTerrainDividersMagnitude(dividersMagnitude);
    setTerrainPerimeterMagnitude(perimeterMagnitude);

    // Metal deposits — same set across all clients (deterministic from
    // map size + player count). `generateMetalDeposits` installs the
    // resulting flat zones into the terrain state itself (see its
    // docstring — needed for the two-pass null-dTerrain resolution),
    // so by the time we hit `buildTerrainTileMap` the heightmap and
    // every downstream sim/render sampler already sees the pads.
    // Deposits are laid out in radial slices phase-aligned to the terrain
    // dividers, so they must count SIDES, not seats — otherwise a 2v2v2
    // would phase deposits on 60-degree spokes while the ridges run on
    // 120-degree ones and metal would end up buried inside a divider.
    const deposits = generateMetalDeposits(
      mapWidth,
      mapHeight,
      teamRoster.allyTeamIds.length,
    );
    const terrainTileMap = buildTerrainTileMap(mapWidth, mapHeight, LAND_CELL_SIZE);
    setAuthoritativeTerrainTileMap(terrainTileMap);
    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(mapWidth, mapHeight);
    precomputeAllUnitPathTraversabilityGrids(mapWidth, mapHeight);

    // The physics engine is now fully 3D — same module for every path.
    const physics = providedPhysics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    try {
    const world = new WorldState(gameGenerationSeed, mapWidth, mapHeight);
    world.simulationTickRateHz = simulationTickRateHz;
    world.terrainSurfaceMode = terrainSurfaceMode;
    world.liquidSurfaceMode = liquidSurfaceMode;
    world.pathfindingCellConsolidationMultiplier =
      pathfindingCellConsolidationMultiplier;
    world.playerCount = playerIds.length;
    // One assignment drives alliances, terrain slices, and spawn angles.
    world.setTeamRoster(teamRoster);
    world.metalDeposits = deposits;
    // Trees, grass, and seaweed are reclaimable energy deposits, so their
    // layout is simulation state. It is derived deterministically from the
    // installed terrain mesh plus map/config inputs — the
    // renderer calls the same idempotent front door and gets this exact
    // list rather than laying out a second, private forest.
    ensureVegetationGenerated(mapWidth, mapHeight, playerIds.length);
    // Wire the terrain bed into physics so solid ground contacts remain
    // independent of the air/water medium occupying the same XY.
    physics.setGroundLookup(
      (x, y) => world.getTerrainBedZ(x, y),
      (x, y) => world.getCachedTerrainBedNormal(x, y),
    );
    world.setActivePlayer(0 as PlayerId); // Server has no active player

    const commandQueue = new CommandQueue();
    const simulation = new Simulation(world, commandQueue, terrainBuildabilityGrid);
    simulation.setPlayerIds(playerIds);

    // Honour any saved demo-unit selection passed in by the caller —
    // this MUST happen before spawnBackgroundUnitsStandalone so the
    // initial spawn picks from the restricted set. Otherwise we'd
    // create units of disallowed types and immediately wipe them via
    // the toggle handler.
    const backgroundAllowedUnitBlueprintIds = new Set(
      config.initialAllowedUnitBlueprintIds ?? BACKGROUND_UNIT_BLUEPRINT_IDS,
    );
    const backgroundAllowedBuildingBlueprintIds = new Set(
      config.initialAllowedBuildingBlueprintIds ?? BUILDING_BLUEPRINT_IDS,
    );
    // Same ordering rule for the entity count cap: the demo spawn fills
    // each SIDE's share of it in randomized slots, so the cap must
    // be set BEFORE spawnBackgroundUnitsStandalone runs (in the
    // playerIds branch below). Without this override, the world
    // boots at DEFAULT_ENTITY_COUNT_CAP (4096) regardless of user storage,
    // the spawn fills to that, and only AFTER would `setEntityCountCap`
    // arrive from LobbyManager — producing the visible "4075/16"
    // mismatch where the spawn count and the displayed cap disagree.
    if (config.initialEntityCountCap !== undefined && config.initialEntityCountCap > 0) {
      world.entityCountCap = config.initialEntityCountCap;
    }
    if (config.converterTax !== undefined && Number.isFinite(config.converterTax)) {
      world.converterTax = config.converterTax;
    }

    // AI player configuration
    const aiPlayerIds = config.aiPlayerIds ?? (backgroundMode ? [...playerIds] : []);
    const spawnDemoInitialState =
      backgroundMode && (config.spawnDemoInitialState ?? aiPlayerIds.length > 0);

    // Spawn initial entities. Only background/demo battles get full
    // bases; real games, including offline games with AI players,
    // start from commanders so their spawn layout matches hosted
    // network games.
    if (spawnDemoInitialState) {
      const constructionSystem = simulation.getConstructionSystem();
      const entities = spawnInitialBases(
        world,
        constructionSystem,
        playerIds,
        'demo',
        backgroundAllowedUnitBlueprintIds,
        backgroundAllowedBuildingBlueprintIds,
      );
      entities.push(...spawnMetalExtractorsOnDeposits(
        world,
        constructionSystem,
        playerIds,
        backgroundAllowedBuildingBlueprintIds,
      ));
      ServerBootstrap.createInitialPhysicsBodies(world, physics, entities);

      // Background mode: spawn a cluster of units near center for immediate combat
      spawnBackgroundUnitsStandalone(
        world, physics, true,
        backgroundAllowedUnitBlueprintIds,
        playerIds,
      );
    } else {
      const entities = spawnInitialEntities(world, playerIds);
      ServerBootstrap.createInitialPhysicsBodies(world, physics, entities);
    }
    simulation.setAiPlayerIds(aiPlayerIds);

    return {
      physics,
      world,
      simulation,
      commandQueue,
      playerIds,
      backgroundMode,
      backgroundAllowedUnitBlueprintIds,
      backgroundAllowedBuildingBlueprintIds,
      terrainTileMap,
      terrainBuildabilityGrid,
    };
    } catch (err) {
      if (providedPhysics === undefined) physics.dispose();
      throw err;
    }
  }

  // Buildings are created first so units can set ignore-static for
  // overlapping buildings on the second pass.
  private static createInitialPhysicsBodies(
    world: WorldState,
    physics: PhysicsEngine3D,
    entities: Entity[],
  ): void {
    createBuildingBodiesForEntities(world, physics, entities);
    createUnitBodiesForEntities(world, physics, entities);
  }

  private static async createInitialPhysicsBodiesAsync(
    world: WorldState,
    physics: PhysicsEngine3D,
    entities: Entity[],
    startProgress: number,
    endProgress: number,
    phase: string,
    report: BootstrapProgress,
  ): Promise<void> {
    await report(startProgress, phase);
    const midProgress = startProgress + (endProgress - startProgress) * 0.45;
    createBuildingBodiesForEntities(world, physics, entities);
    await report(midProgress, phase);

    createUnitBodiesForEntities(world, physics, entities);
    await report(endProgress, phase);
  }
}
