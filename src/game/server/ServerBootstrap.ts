// ServerBootstrap - One-shot wiring of the host-side world objects.
//
// Owns the procedural sequence the GameServer constructor used to run
// inline: terrain shape configuration, metal deposit generation, terrain
// mesh / buildability grid construction, physics + WorldState + Simulation
// creation, and the initial entity spawn (with physics bodies). Pulled out
// of GameServer so the host class is left with instance-level concerns
// (tick scheduling, EMAs, listeners, callbacks).
//
// The two entry points here are the SAME sequence: `bootstrapAsync` yields to
// a progress reporter between phases, `bootstrap` does not. The phases
// themselves — and their order dependencies — live once in
// ServerBootstrapPhases so the two cannot drift; callers should treat either
// result as the canonical wired-up state for one game session.

import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import type { GameServerConfig } from '@/types/game';
import { CommandQueue } from '../sim/commands';
import { Simulation } from '../sim/Simulation';
import { WorldState } from '../sim/WorldState';
import { buildTerrainBuildabilityGrid } from '../sim/terrain/terrainBuildability';
import { spawnInitialEntities } from '../sim/spawn';
import type { Entity, PlayerId } from '../sim/types';
import { spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import { PhysicsEngine3D } from './PhysicsEngine3D';
import {
  createBuildingBodiesForEntities,
  createUnitBodiesForEntities,
} from './InitialPhysicsBodiesHelpers';
import { createLoadProgressReporter } from '../lifecycle/loadProgressReporter';
import {
  buildBootstrapTerrainTileMap,
  configureBootstrapTerrain,
  createBootstrapSimulation,
  createBootstrapWorld,
  generateBootstrapMetalDeposits,
  precomputeBootstrapPathGrids,
  resolveBootstrapConfig,
  resolveBootstrapSpawnRules,
  spawnBootstrapDemoBases,
  spawnBootstrapDemoExtractors,
  type BootstrapSpawnRules,
  type ResolvedBootstrapConfig,
} from './ServerBootstrapPhases';

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
    const resolved = resolveBootstrapConfig(config);
    await report(0.06, 'Reading map size');

    configureBootstrapTerrain(config, resolved.teamRoster);
    await report(0.14, 'Configuring terrain');

    const deposits = generateBootstrapMetalDeposits(resolved);
    await report(0.24, 'Generating metal deposits');

    const terrainTileMap = buildBootstrapTerrainTileMap(resolved);
    await report(0.38, 'Building terrain map');

    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(
      resolved.mapWidth,
      resolved.mapHeight,
    );
    await report(0.48, 'Building placement grid');
    precomputeBootstrapPathGrids(resolved);
    await report(0.53, 'Classifying unit path squares');

    const physics =
      providedPhysics ?? new PhysicsEngine3D(resolved.mapWidth, resolved.mapHeight);
    try {
      const world = createBootstrapWorld(resolved, deposits, physics);
      await report(0.58, 'Creating physics world');

      const { commandQueue, simulation } = createBootstrapSimulation(
        world,
        terrainBuildabilityGrid,
        resolved.playerIds,
      );
      await report(0.66, 'Creating simulation');

      const rules = resolveBootstrapSpawnRules(config, world, resolved);
      await report(0.72, 'Preparing spawn rules');

      if (rules.spawnDemoInitialState) {
        const entities = spawnBootstrapDemoBases(
          world,
          simulation,
          resolved.playerIds,
          rules,
        );
        await report(0.78, 'Spawning bases');

        entities.push(
          ...spawnBootstrapDemoExtractors(world, simulation, resolved.playerIds, rules),
        );
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
          rules.backgroundAllowedUnitBlueprintIds,
          resolved.playerIds,
        );
        await report(0.94, 'Demo units ready');
      } else {
        const entities = spawnInitialEntities(world, resolved.playerIds);
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
      simulation.setAiPlayerIds(rules.aiPlayerIds);
      await report(1, 'Starting AI players');

      return ServerBootstrap.finish(
        resolved,
        physics,
        world,
        simulation,
        commandQueue,
        rules,
        terrainTileMap,
        terrainBuildabilityGrid,
      );
    } catch (err) {
      if (providedPhysics === undefined) physics.dispose();
      throw err;
    }
  }

  static bootstrap(
    config: GameServerConfig,
    providedPhysics: PhysicsEngine3D | undefined = undefined,
  ): BootstrappedServerWorld {
    const resolved = resolveBootstrapConfig(config);
    configureBootstrapTerrain(config, resolved.teamRoster);
    const deposits = generateBootstrapMetalDeposits(resolved);
    const terrainTileMap = buildBootstrapTerrainTileMap(resolved);
    const terrainBuildabilityGrid = buildTerrainBuildabilityGrid(
      resolved.mapWidth,
      resolved.mapHeight,
    );
    precomputeBootstrapPathGrids(resolved);

    // The physics engine is now fully 3D — same module for every path.
    const physics =
      providedPhysics ?? new PhysicsEngine3D(resolved.mapWidth, resolved.mapHeight);
    try {
      const world = createBootstrapWorld(resolved, deposits, physics);
      const { commandQueue, simulation } = createBootstrapSimulation(
        world,
        terrainBuildabilityGrid,
        resolved.playerIds,
      );
      const rules = resolveBootstrapSpawnRules(config, world, resolved);

      if (rules.spawnDemoInitialState) {
        const entities = spawnBootstrapDemoBases(
          world,
          simulation,
          resolved.playerIds,
          rules,
        );
        entities.push(
          ...spawnBootstrapDemoExtractors(world, simulation, resolved.playerIds, rules),
        );
        ServerBootstrap.createInitialPhysicsBodies(world, physics, entities);

        // Background mode: spawn a cluster of units near center for immediate combat
        spawnBackgroundUnitsStandalone(
          world, physics, true,
          rules.backgroundAllowedUnitBlueprintIds,
          resolved.playerIds,
        );
      } else {
        const entities = spawnInitialEntities(world, resolved.playerIds);
        ServerBootstrap.createInitialPhysicsBodies(world, physics, entities);
      }
      simulation.setAiPlayerIds(rules.aiPlayerIds);

      return ServerBootstrap.finish(
        resolved,
        physics,
        world,
        simulation,
        commandQueue,
        rules,
        terrainTileMap,
        terrainBuildabilityGrid,
      );
    } catch (err) {
      if (providedPhysics === undefined) physics.dispose();
      throw err;
    }
  }

  /** The single shape of a bootstrapped world, so the sync and async entry
   *  points cannot drift in what they hand back. */
  private static finish(
    resolved: ResolvedBootstrapConfig,
    physics: PhysicsEngine3D,
    world: WorldState,
    simulation: Simulation,
    commandQueue: CommandQueue,
    rules: BootstrapSpawnRules,
    terrainTileMap: TerrainTileMap,
    terrainBuildabilityGrid: TerrainBuildabilityGrid,
  ): BootstrappedServerWorld {
    return {
      physics,
      world,
      simulation,
      commandQueue,
      playerIds: resolved.playerIds,
      backgroundMode: resolved.backgroundMode,
      backgroundAllowedUnitBlueprintIds: rules.backgroundAllowedUnitBlueprintIds,
      backgroundAllowedBuildingBlueprintIds: rules.backgroundAllowedBuildingBlueprintIds,
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
