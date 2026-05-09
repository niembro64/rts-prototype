// ServerBootstrap - One-shot wiring of the host-side world objects.
//
// Owns the procedural sequence the GameServer constructor used to run
// inline: terrain shape configuration, metal deposit generation, terrain
// mesh / buildability grid construction, physics + WorldState + Simulation
// creation, capture-grid radial paint, and the initial entity spawn (with
// physics bodies). Pulled out of GameServer so the host class is left with
// instance-level concerns (tick scheduling, EMAs, listeners, callbacks).
//
// Order dependencies are documented inline; callers should treat the
// `bootstrap` result as the canonical wired-up state for one game session.

import { CAPTURE_CONFIG } from '../../captureConfig';
import {
  LAND_CELL_SIZE,
  UNIT_THRUST_MULTIPLIER_GAME,
  getMapSize,
} from '../../config';
import { generateMetalDeposits } from '../../metalDepositConfig';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import type { GameServerConfig } from '@/types/game';
import { CommandQueue } from '../sim/commands';
import { CaptureSystem } from '../sim/CaptureSystem';
import { Simulation } from '../sim/Simulation';
import { WorldState } from '../sim/WorldState';
import {
  buildTerrainBuildabilityGrid,
  buildTerrainTileMap,
  setAuthoritativeTerrainTileMap,
  setMetalDepositFlatZones,
  setTerrainCenterShape,
  setTerrainDividersShape,
  setTerrainMapShape,
  setTerrainTeamCount,
} from '../sim/Terrain';
import { getTerrainDividerTeamCount, normalizePlayerIds } from '../sim/playerLayout';
import {
  FIRST_PLAYER_ANGLE,
  spawnInitialBases,
  spawnInitialEntities,
  spawnMetalExtractorsOnDeposits,
} from '../sim/spawn';
import type { Entity, PlayerId } from '../sim/types';
import { BACKGROUND_UNIT_TYPES, spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import { PhysicsEngine3D } from './PhysicsEngine3D';
import { createPhysicsBodyForUnit } from './unitPhysicsBody';

export interface BootstrappedServerWorld {
  physics: PhysicsEngine3D;
  world: WorldState;
  simulation: Simulation;
  commandQueue: CommandQueue;
  captureSystem: CaptureSystem;
  playerIds: PlayerId[];
  backgroundMode: boolean;
  backgroundAllowedTypes: Set<string>;
  terrainTileMap: TerrainTileMap;
  terrainBuildabilityGrid: TerrainBuildabilityGrid;
}

export class ServerBootstrap {
  static bootstrap(
    config: GameServerConfig,
    providedPhysics?: PhysicsEngine3D,
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
    setTerrainTeamCount(getTerrainDividerTeamCount(playerIds.length));
    setTerrainCenterShape(config.terrainCenter ?? 'valley');
    setTerrainDividersShape(config.terrainDividers ?? 'valley');
    setTerrainMapShape(config.terrainMapShape ?? 'circle');

    // Metal deposits — same set across all clients (deterministic from
    // map size + player count + CENTER terrain polarity). Push their
    // flat zones (with per-ring dTerrain-derived height) to the heightmap
    // BEFORE the physics ground lookup or any sim/render code samples
    // terrain, so every consumer sees the raised/lowered pads on first read.
    const deposits = generateMetalDeposits(
      mapWidth,
      mapHeight,
      playerIds.length,
      config.terrainCenter,
    );
    setMetalDepositFlatZones(
      deposits.map((d) => ({
        x: d.x,
        y: d.y,
        radius: d.flatPadRadius,
        height: d.height,
        blendRadius: d.blendRadius,
      })),
    );
    const terrainTileMap = buildTerrainTileMap(mapWidth, mapHeight, LAND_CELL_SIZE);
    setAuthoritativeTerrainTileMap(terrainTileMap);
    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(mapWidth, mapHeight);

    // The physics engine is now fully 3D — same module for every path.
    const physics = providedPhysics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    const world = new WorldState(42, mapWidth, mapHeight);
    world.playerCount = playerIds.length;
    world.metalDeposits = deposits;
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

    // Pre-paint the capture grid into per-team radial sectors. Same
    // oval-space angular layout the spawn oval and terrain dividers use, so
    // each team starts with the territory in front of their base.
    // Border tiles get area-weighted partial ownership (the centre
    // tile is naturally split among all teams). Tiles flagged dirty
    // here flow out in the next snapshot regardless of keyframe / delta.
    //
    // Tell the capture system about the map up front so its
    // per-tile mana-production weights (hotspot multiplier) are
    // available during update() AND for the initial radial paint.
    // The renderer pulls the same weights so on-screen brightness
    // and income stay in lockstep.
    const captureSystem = new CaptureSystem();
    captureSystem.setMapSize(mapWidth, mapHeight, LAND_CELL_SIZE);
    captureSystem.initializeRadialOwnership(
      mapWidth, mapHeight, LAND_CELL_SIZE,
      playerIds, FIRST_PLAYER_ANGLE,
      CAPTURE_CONFIG.initialOwnershipHeight,
    );

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
      captureSystem,
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
}
