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
  UNIT_HP_MULTIPLIER,
  UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND,
  getMapSize,
} from '../../config';
import { generateMetalDeposits } from '../../metalDepositConfig';
import type { MetalDeposit } from '../../metalDepositConfig';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import type { GameServerConfig } from '@/types/game';
import type { BattleManifest, BattleManifestPlayerSlot } from '@/types/network';
import { DEFAULT_INITIAL_RNG_SEED } from '../network/BattleManifest';
import { CommandQueue } from '../sim/commands';
import { Simulation } from '../sim/Simulation';
import { WorldState } from '../sim/WorldState';
import {
  getSimWasm,
  type SimRuntime,
  type SimRuntimeBootstrapEntity,
  type SimRuntimeBootstrapInput,
  type SimRuntimeBootstrapProjection,
} from '../sim-wasm/init';
import { getUnitBlueprint, getUnitLocomotion } from '../sim/blueprints';
import { economyManager } from '../sim/economy';
import {
  buildTerrainBuildabilityGrid,
  buildTerrainTileMap,
  getTerrainRuntimeConfig,
  setAuthoritativeTerrainTileMap,
  setTerrainCenterMagnitude,
  setTerrainDividersMagnitude,
  setTerrainMapShape,
  setTerrainRuntimeConfig,
  setTerrainTeamCount,
} from '../sim/Terrain';
import { getTerrainDividerTeamCount, normalizePlayerIds } from '../sim/playerLayout';
import {
  getInitialCommanderSpawns,
  spawnInitialBases,
  spawnInitialEntities,
  spawnCommanderAt,
  spawnMetalExtractorsOnDeposits,
} from '../sim/spawn';
import type { Entity, PlayerId } from '../sim/types';
import { BACKGROUND_UNIT_TYPES, spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import { PhysicsEngine3D } from './PhysicsEngine3D';
import { createPhysicsBodyForUnit } from './unitPhysicsBody';

export interface BootstrappedServerWorld {
  physics: PhysicsEngine3D;
  runtime: SimRuntime | null;
  world: WorldState;
  simulation: Simulation;
  commandQueue: CommandQueue;
  playerIds: PlayerId[];
  backgroundMode: boolean;
  backgroundAllowedTypes: Set<string>;
  terrainTileMap: TerrainTileMap;
  terrainBuildabilityGrid: TerrainBuildabilityGrid;
}

type BootstrapProgress = (progress: number, phase: string | undefined) => void | Promise<void>;

function applyManifestTeams(
  world: WorldState,
  manifest: BattleManifest | undefined,
): void {
  if (manifest === undefined) return;
  applyPlayerSlotTeams(world, manifest.playerSlots);
}

function applyPlayerSlotTeams(
  world: WorldState,
  playerSlots: readonly Pick<BattleManifestPlayerSlot, 'playerId' | 'teamId'>[],
): void {
  const playerIdsByTeam = new Map<number, PlayerId[]>();
  for (const slot of playerSlots) {
    const teamIds = playerIdsByTeam.get(slot.teamId);
    if (teamIds === undefined) playerIdsByTeam.set(slot.teamId, [slot.playerId]);
    else teamIds.push(slot.playerId);
  }
  world.alliesByPlayer.clear();
  for (const teamPlayerIds of playerIdsByTeam.values()) {
    if (teamPlayerIds.length <= 1) continue;
    for (const playerId of teamPlayerIds) {
      world.alliesByPlayer.set(
        playerId,
        new Set(teamPlayerIds.filter((otherId) => otherId !== playerId)),
      );
    }
  }
}

export class ServerBootstrap {
  private static createRuntime(manifest: BattleManifest | undefined): SimRuntime | null {
    if (manifest === undefined) return null;
    const wasm = getSimWasm();
    if (wasm === undefined) {
      throw new Error('ServerBootstrap: initSimWasm() must resolve before creating a Rust runtime');
    }
    return wasm.createRuntimeFromManifest(manifest);
  }

  private static installRuntimeBootstrapWorld(
    runtime: SimRuntime,
    manifest: BattleManifest,
    world: WorldState,
    playerIds: readonly PlayerId[],
    deposits: readonly MetalDeposit[],
  ): SimRuntimeBootstrapProjection {
    const input = ServerBootstrap.buildRuntimeBootstrapInput(
      manifest,
      world,
      playerIds,
      deposits,
    );
    runtime.installBootstrapWorld(input);
    return runtime.readBootstrapWorld();
  }

  private static buildRuntimeBootstrapInput(
    manifest: BattleManifest,
    world: WorldState,
    playerIds: readonly PlayerId[],
    deposits: readonly MetalDeposit[],
  ): SimRuntimeBootstrapInput {
    const commanderBlueprint = getUnitBlueprint('commander');
    const commanderLocomotion = getUnitLocomotion('commander');
    const bodyCenterHeight = commanderBlueprint.bodyCenterHeight;
    const spawnCenterHeight =
      (commanderLocomotion.type === 'hover' || commanderLocomotion.type === 'flying') &&
      commanderLocomotion.hoverHeight !== undefined &&
      Number.isFinite(commanderLocomotion.hoverHeight)
        ? commanderLocomotion.hoverHeight
        : bodyCenterHeight + UNIT_INITIAL_SPAWN_HEIGHT_ABOVE_GROUND;
    const hp = commanderBlueprint.hp * UNIT_HP_MULTIPLIER;
    const entities: SimRuntimeBootstrapEntity[] = getInitialCommanderSpawns(
      world.mapWidth,
      world.mapHeight,
      playerIds,
    ).map((spawn, index) => ({
      id: (index + 1) as Entity['id'],
      type: 'unit',
      unitType: 'commander',
      playerId: spawn.playerId,
      x: spawn.x,
      y: spawn.y,
      z: world.getGroundZ(spawn.x, spawn.y) + spawnCenterHeight,
      rotation: spawn.facingAngle,
      hp,
      maxHp: hp,
    }));

    return {
      mapWidth: world.mapWidth,
      mapHeight: world.mapHeight,
      nextEntityId: (entities.length + 1) as Entity['id'],
      playerIds,
      playerSlots: manifest.playerSlots.map((slot) => ({
        playerId: slot.playerId,
        teamId: slot.teamId,
      })),
      entities,
      metalDeposits: deposits,
    };
  }

  private static hydrateRuntimeBootstrapWorld(
    world: WorldState,
    projection: SimRuntimeBootstrapProjection,
  ): Entity[] {
    if (
      Math.abs(projection.mapWidth - world.mapWidth) > 1e-6 ||
      Math.abs(projection.mapHeight - world.mapHeight) > 1e-6
    ) {
      throw new Error('Runtime bootstrap projection map dimensions do not match WorldState');
    }

    world.playerCount = projection.playerIds.length;
    applyPlayerSlotTeams(world, projection.playerSlots);
    world.metalDeposits = projection.metalDeposits;

    for (const playerId of projection.playerIds) {
      economyManager.initPlayer(playerId);
    }

    const entities: Entity[] = [];
    for (const projected of projection.entities) {
      if (projected.type !== 'unit' || projected.unitType !== 'commander') {
        throw new Error(
          `Unsupported runtime bootstrap entity type: ${projected.type}/${projected.unitType}`,
        );
      }
      const commander = spawnCommanderAt(
        world,
        projected.playerId,
        projected.x,
        projected.y,
        projected.rotation,
      );
      if (commander.id !== projected.id) {
        throw new Error(
          `Runtime bootstrap entity id mismatch: expected ${projected.id}, got ${commander.id}`,
        );
      }
      commander.transform.z = projected.z;
      if (commander.unit) {
        commander.unit.hp = projected.hp;
        commander.unit.maxHp = projected.maxHp;
      }
      entities.push(commander);
    }
    return entities;
  }

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
    const playerIds = normalizePlayerIds(
      config.manifest?.playerSlots.map((slot) => slot.playerId) ?? config.playerIds,
    );
    const backgroundMode = config.backgroundMode ?? false;
    const manifestSettings = config.manifest?.settings;

    const mapConfig = getMapSize(
      backgroundMode,
      manifestSettings?.mapWidthLandCells ?? config.mapWidthLandCells,
      manifestSettings?.mapLengthLandCells ?? config.mapLengthLandCells,
    );
    const mapWidth = mapConfig.width;
    const mapHeight = mapConfig.height;
    await report(0.06, 'Reading map size');

    const terrainRuntimeConfig = getTerrainRuntimeConfig();
    const centerMagnitude =
      manifestSettings?.centerMagnitude ?? config.centerMagnitude ?? terrainRuntimeConfig.centerMagnitude;
    const dividersMagnitude =
      manifestSettings?.dividersMagnitude ?? config.dividersMagnitude ?? terrainRuntimeConfig.dividersMagnitude;
    setTerrainRuntimeConfig({
      centerMagnitude,
      dividersMagnitude,
      terrainDTerrain:
        manifestSettings?.terrainDTerrain ?? config.terrainDTerrain ?? terrainRuntimeConfig.terrainDTerrain,
      metalDepositStep:
        manifestSettings?.metalDepositStep ?? config.metalDepositStep ?? terrainRuntimeConfig.metalDepositStep,
    });
    setTerrainTeamCount(getTerrainDividerTeamCount(playerIds.length));
    setTerrainCenterMagnitude(centerMagnitude);
    setTerrainDividersMagnitude(dividersMagnitude);
    setTerrainMapShape(manifestSettings?.terrainMapShape ?? config.terrainMapShape ?? 'circle');
    await report(0.14, 'Configuring terrain');

    const deposits = generateMetalDeposits(
      mapWidth,
      mapHeight,
      playerIds.length,
      config.manifest?.mapSeed,
    );
    await report(0.24, 'Generating metal deposits');

    const terrainTileMap = buildTerrainTileMap(mapWidth, mapHeight, LAND_CELL_SIZE);
    setAuthoritativeTerrainTileMap(terrainTileMap);
    await report(0.38, 'Building terrain map');

    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(mapWidth, mapHeight);
    await report(0.48, 'Building placement grid');

    const physics = providedPhysics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    const world = new WorldState(
      config.manifest?.initialRngSeed ?? DEFAULT_INITIAL_RNG_SEED,
      mapWidth,
      mapHeight,
    );
    const runtime = ServerBootstrap.createRuntime(config.manifest);
    world.playerCount = playerIds.length;
    applyManifestTeams(world, config.manifest);
    if (runtime === null) world.metalDeposits = deposits;
    physics.setGroundLookup(
      (x, y) => world.getGroundZ(x, y),
      (x, y) => world.getCachedSurfaceNormal(x, y),
    );
    world.thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME;
    world.setActivePlayer(0 as PlayerId);
    await report(0.58, 'Creating physics world');

    const commandQueue = new CommandQueue();
    const simulation = new Simulation(world, commandQueue, terrainBuildabilityGrid);
    simulation.setPlayerIds(playerIds);
    await report(0.66, 'Creating simulation');

    const backgroundAllowedTypes = new Set(
      config.initialAllowedTypes ?? BACKGROUND_UNIT_TYPES,
    );
    if (config.initialMaxTotalUnits !== undefined && config.initialMaxTotalUnits > 0) {
      world.maxTotalUnits = config.initialMaxTotalUnits;
    }
    if (manifestSettings?.fogOfWarEnabled !== null && manifestSettings?.fogOfWarEnabled !== undefined) {
      world.fogOfWarEnabled = manifestSettings.fogOfWarEnabled;
    }
    const converterTax = manifestSettings?.converterTax ?? config.converterTax;
    if (converterTax !== undefined && converterTax !== null && Number.isFinite(converterTax)) {
      world.converterTax = converterTax;
    }
    const aiPlayerIds = config.aiPlayerIds ?? (backgroundMode ? [...playerIds] : []);
    const spawnDemoInitialState =
      backgroundMode && (config.spawnDemoInitialState ?? aiPlayerIds.length > 0);
    await report(0.72, 'Preparing spawn rules');

    if (spawnDemoInitialState) {
      world.metalDeposits = deposits;
      const constructionSystem = simulation.getConstructionSystem();
      const entities = spawnInitialBases(
        world,
        constructionSystem,
        playerIds,
        'demo',
        backgroundAllowedTypes,
      );
      await report(0.78, 'Spawning bases');

      entities.push(...spawnMetalExtractorsOnDeposits(world, constructionSystem, playerIds));
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
        constructionSystem.getGrid(),
        backgroundAllowedTypes,
        playerIds,
      );
      await report(0.94, 'Demo units ready');
    } else if (runtime !== null && config.manifest !== undefined) {
      const projection = ServerBootstrap.installRuntimeBootstrapWorld(
        runtime,
        config.manifest,
        world,
        playerIds,
        deposits,
      );
      const entities = ServerBootstrap.hydrateRuntimeBootstrapWorld(world, projection);
      await report(0.82, 'Hydrating runtime world');
      await ServerBootstrap.createInitialPhysicsBodiesAsync(
        world,
        physics,
        entities,
        0.82,
        0.94,
        'Creating runtime unit physics',
        report,
      );
    } else {
      world.metalDeposits = deposits;
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
      runtime,
      world,
      simulation,
      commandQueue,
      playerIds,
      backgroundMode,
      backgroundAllowedTypes,
      terrainTileMap,
      terrainBuildabilityGrid,
    };
  }

  static bootstrap(
    config: GameServerConfig,
    providedPhysics: PhysicsEngine3D | undefined = undefined,
  ): BootstrappedServerWorld {
    const playerIds = normalizePlayerIds(
      config.manifest?.playerSlots.map((slot) => slot.playerId) ?? config.playerIds,
    );
    const backgroundMode = config.backgroundMode ?? false;
    const manifestSettings = config.manifest?.settings;

    const mapConfig = getMapSize(
      backgroundMode,
      manifestSettings?.mapWidthLandCells ?? config.mapWidthLandCells,
      manifestSettings?.mapLengthLandCells ?? config.mapLengthLandCells,
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
      manifestSettings?.centerMagnitude ?? config.centerMagnitude ?? terrainRuntimeConfig.centerMagnitude;
    const dividersMagnitude =
      manifestSettings?.dividersMagnitude ?? config.dividersMagnitude ?? terrainRuntimeConfig.dividersMagnitude;
    setTerrainRuntimeConfig({
      centerMagnitude,
      dividersMagnitude,
      terrainDTerrain:
        manifestSettings?.terrainDTerrain ?? config.terrainDTerrain ?? terrainRuntimeConfig.terrainDTerrain,
      metalDepositStep:
        manifestSettings?.metalDepositStep ?? config.metalDepositStep ?? terrainRuntimeConfig.metalDepositStep,
    });
    setTerrainTeamCount(getTerrainDividerTeamCount(playerIds.length));
    setTerrainCenterMagnitude(centerMagnitude);
    setTerrainDividersMagnitude(dividersMagnitude);
    setTerrainMapShape(manifestSettings?.terrainMapShape ?? config.terrainMapShape ?? 'circle');

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
      config.manifest?.mapSeed,
    );
    const terrainTileMap = buildTerrainTileMap(mapWidth, mapHeight, LAND_CELL_SIZE);
    setAuthoritativeTerrainTileMap(terrainTileMap);
    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(mapWidth, mapHeight);

    // The physics engine is now fully 3D — same module for every path.
    const physics = providedPhysics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    const world = new WorldState(
      config.manifest?.initialRngSeed ?? DEFAULT_INITIAL_RNG_SEED,
      mapWidth,
      mapHeight,
    );
    const runtime = ServerBootstrap.createRuntime(config.manifest);
    world.playerCount = playerIds.length;
    applyManifestTeams(world, config.manifest);
    if (runtime === null) world.metalDeposits = deposits;
    // Wire the heightmap into physics so ground contacts settle units
    // on top of their terrain cube tile AND project their velocity
    // onto the slope tangent each tick — keeps units glued to the
    // surface as they climb / descend instead of bobbing or
    // launching off slope transitions. Both lookups return flat-up
    // outside the ripple disc, so corner spawns stay flat.
    physics.setGroundLookup(
      (x, y) => world.getGroundZ(x, y),
      (x, y) => world.getCachedSurfaceNormal(x, y),
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
    const backgroundAllowedTypes = new Set(
      config.initialAllowedTypes ?? BACKGROUND_UNIT_TYPES,
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
    if (manifestSettings?.fogOfWarEnabled !== null && manifestSettings?.fogOfWarEnabled !== undefined) {
      world.fogOfWarEnabled = manifestSettings.fogOfWarEnabled;
    }
    const converterTax = manifestSettings?.converterTax ?? config.converterTax;
    if (converterTax !== undefined && converterTax !== null && Number.isFinite(converterTax)) {
      world.converterTax = converterTax;
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
      world.metalDeposits = deposits;
      const constructionSystem = simulation.getConstructionSystem();
      const entities = spawnInitialBases(
        world,
        constructionSystem,
        playerIds,
        'demo',
        backgroundAllowedTypes,
      );
      entities.push(...spawnMetalExtractorsOnDeposits(world, constructionSystem, playerIds));
      ServerBootstrap.createInitialPhysicsBodies(world, physics, entities);

      // Background mode: spawn a cluster of units near center for immediate combat
      spawnBackgroundUnitsStandalone(
        world, physics, true,
        constructionSystem.getGrid(),
        backgroundAllowedTypes,
        playerIds,
      );
    } else if (runtime !== null && config.manifest !== undefined) {
      const projection = ServerBootstrap.installRuntimeBootstrapWorld(
        runtime,
        config.manifest,
        world,
        playerIds,
        deposits,
      );
      const entities = ServerBootstrap.hydrateRuntimeBootstrapWorld(world, projection);
      ServerBootstrap.createInitialPhysicsBodies(world, physics, entities);
    } else {
      world.metalDeposits = deposits;
      const entities = spawnInitialEntities(world, playerIds);
      ServerBootstrap.createInitialPhysicsBodies(world, physics, entities);
    }
    simulation.setAiPlayerIds(aiPlayerIds);

    return {
      physics,
      runtime,
      world,
      simulation,
      commandQueue,
      playerIds,
      backgroundMode,
      backgroundAllowedTypes,
      terrainTileMap,
      terrainBuildabilityGrid,
    };
  }

  // Buildings are created first so units can set ignore-static for
  // overlapping buildings on the second pass.
  private static createInitialPhysicsBodies(
    world: WorldState,
    physics: PhysicsEngine3D,
    entities: Entity[],
  ): void {
    // Pass 1: create building bodies
    for (const entity of entities) {
      if (entity.type === 'building' && entity.building) {
        // baseZ matches WorldState.createBuilding's terrain lookup so
        // the static cuboid body sits where the entity transform says
        // it does — base on the local cube tile top.
        const baseZ = entity.transform.z - entity.building.depth / 2;
        const body = physics.createBuildingBody(
          entity.transform.x,
          entity.transform.y,
          entity.building.width,
          entity.building.height,
          entity.building.depth,
          baseZ,
          `building_${entity.id}`,
        );
        entity.body = { physicsBody: body };
      }
    }

    // Pass 2: create unit bodies + set ignore-static for overlapping buildings
    for (const entity of entities) {
      if (entity.type === 'unit' && entity.unit) {
        createPhysicsBodyForUnit(world, physics, entity, {
          ignoreOverlappingBuildings: true,
          overlapPadding: entity.unit.radius.push,
        });
      }
    }
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
    for (const entity of entities) {
      if (entity.type === 'building' && entity.building) {
        const baseZ = entity.transform.z - entity.building.depth / 2;
        const body = physics.createBuildingBody(
          entity.transform.x,
          entity.transform.y,
          entity.building.width,
          entity.building.height,
          entity.building.depth,
          baseZ,
          `building_${entity.id}`,
        );
        entity.body = { physicsBody: body };
      }
    }
    await report(midProgress, phase);

    for (const entity of entities) {
      if (entity.type === 'unit' && entity.unit) {
        createPhysicsBodyForUnit(world, physics, entity, {
          ignoreOverlappingBuildings: true,
          overlapPadding: entity.unit.radius.push,
        });
      }
    }
    await report(endProgress, phase);
  }
}
