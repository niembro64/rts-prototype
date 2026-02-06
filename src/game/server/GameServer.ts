// GameServer - Headless simulation server (no Phaser dependency)
// Owns WorldState, Simulation, Matter.Engine, and runs the game loop via setInterval

import Matter from 'matter-js';
import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue, type Command } from '../sim/commands';
import { spawnInitialEntities } from '../sim/spawn';
import { serializeGameState } from '../network/stateSerializer';
import type { NetworkGameState } from '../network/NetworkTypes';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { DeathContext } from '../sim/combat';
import { economyManager } from '../sim/economy';
import {
  createStandaloneEngine,
  createUnitBodyStandalone,
  createMatterBodiesStandalone,
  applyUnitVelocitiesStandalone,
  removeBodyStandalone,
  stepEngine,
} from './PhysicsStandalone';
import { spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  BACKGROUND_MAP_WIDTH,
  BACKGROUND_MAP_HEIGHT,
} from '../../config';

export interface GameServerConfig {
  playerIds: PlayerId[];
  backgroundMode?: boolean;
  snapshotRate?: number; // Hz, default 10
}

export class GameServer {
  private engine: Matter.Engine;
  private world: WorldState;
  private simulation: Simulation;
  private commandQueue: CommandQueue;

  private playerIds: PlayerId[];
  private backgroundMode: boolean;

  // Fixed-timestep physics
  private physicsAccumulator: number = 0;
  private readonly PHYSICS_TIMESTEP = 1000 / 60; // 60Hz
  private readonly MAX_PHYSICS_STEPS = 4;

  // Game loop
  private gameLoopInterval: ReturnType<typeof setInterval> | null = null;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime: number = 0;
  private snapshotRateHz: number;

  // Background mode
  private backgroundSpawnTimer: number = 0;
  private readonly BACKGROUND_SPAWN_INTERVAL: number = 500;

  // Snapshot listeners
  private snapshotListeners: ((state: NetworkGameState) => void)[] = [];
  private gameOverListeners: ((winnerId: PlayerId) => void)[] = [];

  // Game over tracking
  private isGameOver: boolean = false;

  // Tick rate tracking
  private tickDeltaHistory: number[] = [];
  private readonly TICK_HISTORY_SIZE = 600; // ~10 seconds at 60Hz

  constructor(config: GameServerConfig) {
    this.playerIds = config.playerIds;
    this.backgroundMode = config.backgroundMode ?? false;
    this.snapshotRateHz = config.snapshotRate ?? 10;

    // Create standalone Matter.js engine
    this.engine = createStandaloneEngine();

    // Initialize world state with appropriate map size
    const mapWidth = this.backgroundMode ? BACKGROUND_MAP_WIDTH : MAP_WIDTH;
    const mapHeight = this.backgroundMode ? BACKGROUND_MAP_HEIGHT : MAP_HEIGHT;
    this.world = new WorldState(42, mapWidth, mapHeight);
    this.world.setActivePlayer(0 as PlayerId); // Server has no active player

    this.commandQueue = new CommandQueue();
    this.simulation = new Simulation(this.world, this.commandQueue);
    this.simulation.setPlayerIds(this.playerIds);

    // Setup simulation callbacks
    this.setupSimulationCallbacks();

    // Spawn initial entities
    if (this.backgroundMode) {
      this.world.playerCount = 4;
      economyManager.initPlayer(1);
      economyManager.initPlayer(2);
      economyManager.initPlayer(3);
      economyManager.initPlayer(4);
      spawnBackgroundUnitsStandalone(this.world, this.engine, true);
    } else {
      const entities = spawnInitialEntities(this.world, this.playerIds);
      createMatterBodiesStandalone(this.engine, entities);
    }
  }

  private setupSimulationCallbacks(): void {
    // Handle unit deaths: remove matter bodies and entities
    this.simulation.onUnitDeath = (deadUnitIds: EntityId[], _deathContexts?: Map<EntityId, DeathContext>) => {
      for (const id of deadUnitIds) {
        const entity = this.world.getEntity(id);
        if (entity) {
          if (entity.body?.matterBody) {
            removeBodyStandalone(this.engine, entity.body.matterBody);
          }
        }
        this.world.removeEntity(id);
      }
    };

    // Handle building deaths
    this.simulation.onBuildingDeath = (deadBuildingIds: EntityId[]) => {
      const constructionSystem = this.simulation.getConstructionSystem();
      for (const id of deadBuildingIds) {
        const entity = this.world.getEntity(id);
        if (entity) {
          constructionSystem.onBuildingDestroyed(entity);
        }
        this.world.removeEntity(id);
      }
    };

    // Handle unit spawns: create standalone Matter bodies
    this.simulation.onUnitSpawn = (newUnits: Entity[]) => {
      for (const entity of newUnits) {
        if (entity.type === 'unit' && entity.unit) {
          const body = createUnitBodyStandalone(
            this.engine,
            entity.transform.x,
            entity.transform.y,
            entity.unit.collisionRadius,
            entity.unit.mass,
            `unit_${entity.id}`
          );
          entity.body = { matterBody: body as unknown as MatterJS.BodyType };
        }
      }
    };

    // Audio events are collected by simulation and included in snapshots
    // No need for per-event callback on server side

    // Game over callback (skip in background mode)
    if (!this.backgroundMode) {
      this.simulation.onGameOver = (winnerId: PlayerId) => {
        if (!this.isGameOver) {
          this.isGameOver = true;
          for (const listener of this.gameOverListeners) {
            listener(winnerId);
          }
        }
      };
    }
  }

  // Start the game loop
  start(): void {
    this.lastTickTime = performance.now();

    // Run simulation at ~60Hz via setInterval
    this.gameLoopInterval = setInterval(() => {
      const now = performance.now();
      const delta = now - this.lastTickTime;
      this.lastTickTime = now;
      this.tick(delta);
    }, 1000 / 60);

    // Emit snapshots at configurable rate
    this.startSnapshotBroadcast();
  }

  // Stop the game loop
  stop(): void {
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
    }
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
  }

  // Main tick function
  private tick(delta: number): void {
    // Track tick deltas for stats
    this.tickDeltaHistory.push(delta);
    if (this.tickDeltaHistory.length > this.TICK_HISTORY_SIZE) {
      this.tickDeltaHistory.shift();
    }

    // Fixed timestep physics
    this.physicsAccumulator += delta;

    const maxAccumulator = this.PHYSICS_TIMESTEP * this.MAX_PHYSICS_STEPS;
    if (this.physicsAccumulator > maxAccumulator) {
      this.physicsAccumulator = maxAccumulator;
    }

    let physicsSteps = 0;
    while (this.physicsAccumulator >= this.PHYSICS_TIMESTEP && physicsSteps < this.MAX_PHYSICS_STEPS) {
      // Update simulation (calculates velocities)
      this.simulation.update(this.PHYSICS_TIMESTEP);

      // Apply forces to Matter bodies
      applyUnitVelocitiesStandalone(this.engine, this.world, this.simulation.getForceAccumulator());

      // Step Matter.js physics
      stepEngine(this.engine, this.PHYSICS_TIMESTEP);

      this.physicsAccumulator -= this.PHYSICS_TIMESTEP;
      physicsSteps++;
    }

    // Background mode: continuously spawn units
    if (this.backgroundMode) {
      this.backgroundSpawnTimer += delta;
      if (this.backgroundSpawnTimer >= this.BACKGROUND_SPAWN_INTERVAL) {
        this.backgroundSpawnTimer = 0;
        spawnBackgroundUnitsStandalone(this.world, this.engine, false);
      }
    }
  }

  // Emit a snapshot to all listeners
  private emitSnapshot(): void {
    const winnerId = this.simulation.getWinnerId() ?? undefined;
    const sprayTargets = this.simulation.getSprayTargets();
    const audioEvents = this.simulation.getAndClearAudioEvents();
    const projectileSpawns = this.simulation.getAndClearProjectileSpawns();
    const projectileDespawns = this.simulation.getAndClearProjectileDespawns();
    const state = serializeGameState(this.world, winnerId, sprayTargets, audioEvents, projectileSpawns, projectileDespawns);

    for (const listener of this.snapshotListeners) {
      listener(state);
    }
  }

  private startSnapshotBroadcast(): void {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
    }
    const intervalMs = 1000 / this.snapshotRateHz;
    this.snapshotInterval = setInterval(() => {
      this.emitSnapshot();
    }, intervalMs);
  }

  // Receive a command from a client
  receiveCommand(command: Command): void {
    this.commandQueue.enqueue(command);
  }

  // Add a snapshot listener
  addSnapshotListener(callback: (state: NetworkGameState) => void): void {
    this.snapshotListeners.push(callback);
  }

  // Add a game over listener
  addGameOverListener(callback: (winnerId: PlayerId) => void): void {
    this.gameOverListeners.push(callback);
  }

  // Change snapshot emission rate
  setSnapshotRate(hz: number): void {
    this.snapshotRateHz = hz;
    if (this.snapshotInterval) {
      this.startSnapshotBroadcast();
    }
  }

  // Get map dimensions (for scene configuration)
  getMapWidth(): number {
    return this.world.mapWidth;
  }

  getMapHeight(): number {
    return this.world.mapHeight;
  }

  // Get tick rate stats (avg and worst FPS over recent history)
  getTickStats(): { avgFps: number; worstFps: number } {
    const history = this.tickDeltaHistory;
    if (history.length === 0) return { avgFps: 0, worstFps: 0 };

    let sum = 0;
    let maxDelta = 0;
    for (let i = 0; i < history.length; i++) {
      sum += history[i];
      if (history[i] > maxDelta) maxDelta = history[i];
    }

    const avgDelta = sum / history.length;
    return {
      avgFps: avgDelta > 0 ? 1000 / avgDelta : 0,
      worstFps: maxDelta > 0 ? 1000 / maxDelta : 0,
    };
  }
}
