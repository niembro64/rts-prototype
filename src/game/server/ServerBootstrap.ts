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
  UNIT_THRUST_MULTIPLIER_GAME,
  getMapSize,
} from '../../config';
import { generateMetalDeposits } from '../../metalDepositConfig';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import type { GameServerConfig } from '@/types/game';
import { CommandQueue } from '../sim/commands';
import { Simulation } from '../sim/Simulation';
import { WorldState } from '../sim/WorldState';
import {
  buildTerrainBuildabilityGrid,
  buildTerrainTileMap,
  getTerrainRuntimeConfig,
  setAuthoritativeTerrainTileMap,
  setTerrainCenterMagnitude,
  setTerrainDividersMagnitude,
  setTerrainPerimeterMagnitude,
  setTerrainRuntimeConfig,
  setTerrainTeamCount,
} from '../sim/Terrain';
import { getTerrainDividerTeamCount, normalizePlayerIds } from '../sim/playerLayout';
import {
  spawnInitialBases,
  spawnInitialEntities,
  spawnMetalExtractorsOnDeposits,
} from '../sim/spawn';
import type { Entity, PlayerId } from '../sim/types';
import { BACKGROUND_UNIT_BLUEPRINT_IDS, spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import { BUILDING_BLUEPRINT_IDS, TOWER_BLUEPRINT_IDS } from '../../types/blueprintIds';
import { PhysicsEngine3D } from './PhysicsEngine3D';
import {
  createBuildingBodiesForEntities,
  createUnitBodiesForEntities,
} from './InitialPhysicsBodiesHelpers';

export interface BootstrappedServerWorld {
  physics: PhysicsEngine3D;
  world: WorldState;
  simulation: Simulation;
  commandQueue: CommandQueue;
  playerIds: PlayerId[];
  backgroundMode: boolean;
  backgroundAllowedUnitBlueprintIds: Set<string>;
  backgroundAllowedBuildingBlueprintIds: Set<string>;
  backgroundAllowedTowerBlueprintIds: Set<string>;
  terrainTileMap: TerrainTileMap;
  terrainBuildabilityGrid: TerrainBuildabilityGrid;
}

type BootstrapProgress = (progress: number, phase: string | undefined) => void | Promise<void>;

export const SERVER_WORLD_SEED = 42;

export class ServerBootstrap {
  static async bootstrapAsync(
    config: GameServerConfig,
    providedPhysics: PhysicsEngine3D | undefined = undefined,
    onProgress: BootstrapProgress = () => {},
  ): Promise<BootstrappedServerWorld> {
    const report = async (progress: number, phase: string | undefined) => {
      const clamped = Number.isFinite(progress)
        ? Math.max(0, Math.min(1, progress))
        : 0;
      await onProgress(clamped, phase);
    };

    await report(0, 'Reading map size');
    const playerIds = normalizePlayerIds(config.playerIds);
    const backgroundMode = config.backgroundMode ?? false;

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
      metalDepositStep:
        config.metalDepositStep ?? terrainRuntimeConfig.metalDepositStep,
      terrainDetail:
        config.terrainDetail ?? terrainRuntimeConfig.terrainDetail,
    });
    setTerrainTeamCount(getTerrainDividerTeamCount(playerIds.length));
    setTerrainCenterMagnitude(centerMagnitude);
    setTerrainDividersMagnitude(dividersMagnitude);
    setTerrainPerimeterMagnitude(perimeterMagnitude);
    await report(0.14, 'Configuring terrain');

    const deposits = generateMetalDeposits(
      mapWidth,
      mapHeight,
      playerIds.length,
    );
    await report(0.24, 'Generating metal deposits');

    const terrainTileMap = buildTerrainTileMap(mapWidth, mapHeight, LAND_CELL_SIZE);
    setAuthoritativeTerrainTileMap(terrainTileMap);
    await report(0.38, 'Building terrain map');

    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(mapWidth, mapHeight);
    await report(0.48, 'Building placement grid');

    const physics = providedPhysics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    try {
    const world = new WorldState(SERVER_WORLD_SEED, mapWidth, mapHeight);
    world.playerCount = playerIds.length;
    world.metalDeposits = deposits;
    physics.setGroundLookup(
      (x, y) => world.getTerrainBedZ(x, y),
      (x, y) => world.getCachedTerrainBedNormal(x, y),
    );
    world.thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME;
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
    const backgroundAllowedTowerBlueprintIds = new Set(
      config.initialAllowedTowerBlueprintIds ?? TOWER_BLUEPRINT_IDS,
    );
    if (config.initialMaxTotalUnits !== undefined && config.initialMaxTotalUnits > 0) {
      world.maxTotalUnits = config.initialMaxTotalUnits;
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
        backgroundAllowedTowerBlueprintIds,
      );
      await report(0.78, 'Spawning bases');

      if (backgroundAllowedBuildingBlueprintIds.has('buildingExtractor')) {
        entities.push(...spawnMetalExtractorsOnDeposits(world, constructionSystem, playerIds));
      }
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
      backgroundAllowedTowerBlueprintIds,
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
    const backgroundMode = config.backgroundMode ?? false;

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
      metalDepositStep:
        config.metalDepositStep ?? terrainRuntimeConfig.metalDepositStep,
      terrainDetail:
        config.terrainDetail ?? terrainRuntimeConfig.terrainDetail,
    });
    setTerrainTeamCount(getTerrainDividerTeamCount(playerIds.length));
    setTerrainCenterMagnitude(centerMagnitude);
    setTerrainDividersMagnitude(dividersMagnitude);
    setTerrainPerimeterMagnitude(perimeterMagnitude);

    // Metal deposits — same set across all clients (deterministic from
    // map size + player count). `generateMetalDeposits` installs the
    // resulting flat zones into the terrain state itself (see its
    // docstring — needed for the two-pass null-dTerrain resolution),
    // so by the time we hit `buildTerrainTileMap` the heightmap and
    // every downstream sim/render sampler already sees the pads.
    const deposits = generateMetalDeposits(
      mapWidth,
      mapHeight,
      playerIds.length,
    );
    const terrainTileMap = buildTerrainTileMap(mapWidth, mapHeight, LAND_CELL_SIZE);
    setAuthoritativeTerrainTileMap(terrainTileMap);
    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(mapWidth, mapHeight);

    // The physics engine is now fully 3D — same module for every path.
    const physics = providedPhysics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    try {
    const world = new WorldState(SERVER_WORLD_SEED, mapWidth, mapHeight);
    world.playerCount = playerIds.length;
    world.metalDeposits = deposits;
    // Wire the terrain bed into physics so solid ground contacts remain
    // independent of the air/water medium occupying the same XY.
    physics.setGroundLookup(
      (x, y) => world.getTerrainBedZ(x, y),
      (x, y) => world.getCachedTerrainBedNormal(x, y),
    );
    world.thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME;
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
    const backgroundAllowedTowerBlueprintIds = new Set(
      config.initialAllowedTowerBlueprintIds ?? TOWER_BLUEPRINT_IDS,
    );
    // Same ordering rule for the unit cap: the demo spawn now fills
    // `maxTotalUnits / numPlayers` slots per team, so the cap must
    // be set BEFORE spawnBackgroundUnitsStandalone runs (in the
    // playerIds branch below). Without this override, the world
    // boots at MAX_TOTAL_UNITS (4096) regardless of user storage,
    // the spawn fills to that, and only AFTER would `setMaxTotalUnits`
    // arrive from LobbyManager — producing the visible "4075/16"
    // mismatch where the spawn count and the displayed cap disagree.
    if (config.initialMaxTotalUnits !== undefined && config.initialMaxTotalUnits > 0) {
      world.maxTotalUnits = config.initialMaxTotalUnits;
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
        backgroundAllowedTowerBlueprintIds,
      );
      if (backgroundAllowedBuildingBlueprintIds.has('buildingExtractor')) {
        entities.push(...spawnMetalExtractorsOnDeposits(world, constructionSystem, playerIds));
      }
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
      backgroundAllowedTowerBlueprintIds,
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
