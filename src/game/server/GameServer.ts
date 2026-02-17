// GameServer - Headless simulation server (no Phaser dependency)
// Owns WorldState, Simulation, Matter.Engine, and runs the game loop via setInterval

import Matter from 'matter-js';
import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue, type Command } from '../sim/commands';
import { spawnInitialEntities } from '../sim/spawn';
import { serializeGameState } from '../network/stateSerializer';
import type { NetworkGridCell } from '../network/NetworkTypes';
import type { SnapshotCallback, GameOverCallback } from './GameConnection';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { DeathContext } from '../sim/combat';
import { economyManager } from '../sim/economy';
import { beamIndex } from '../sim/BeamIndex';
import {
  createStandaloneEngine,
  createUnitBodyStandalone,
  createMatterBodiesStandalone,
  applyUnitVelocitiesStandalone,
  syncVelocitiesFromPhysics,
  removeBodyStandalone,
  stepEngine,
  toPhaserBody,
} from './PhysicsStandalone';
import { spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import {
  MAP_SETTINGS,
  UNIT_STATS,
  UNIT_THRUST_MULTIPLIER_GAME,
  UNIT_THRUST_MULTIPLIER_DEMO,
} from '../../config';
import { spatialGrid } from '../sim/SpatialGrid';

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

  // When true, caller drives emitSnapshot() inline (no interval)
  inlineSnapshots: boolean = true;

  // Background mode
  private backgroundSpawnTimer: number = 0;
  private readonly BACKGROUND_SPAWN_INTERVAL: number = 500;
  private backgroundAllowedTypes: Set<string> = new Set(Object.keys(UNIT_STATS));

  // Snapshot listeners
  private snapshotListeners: SnapshotCallback[] = [];
  private gameOverListeners: GameOverCallback[] = [];

  // Game over tracking
  private isGameOver: boolean = false;

  // Tick rate tracking (ring buffer to avoid O(n) shift)
  private tickDeltaHistory: Float64Array;
  private tickDeltaIndex: number = 0;
  private tickDeltaCount: number = 0;
  private readonly TICK_HISTORY_SIZE = 600; // ~10 seconds at 60Hz

  // Debug: send spatial grid occupancy info in snapshots
  private sendGridInfo: boolean = false;

  constructor(config: GameServerConfig) {
    this.playerIds = config.playerIds;
    this.backgroundMode = config.backgroundMode ?? false;
    this.snapshotRateHz = config.snapshotRate ?? 10;
    this.tickDeltaHistory = new Float64Array(this.TICK_HISTORY_SIZE);

    // Create standalone Matter.js engine
    this.engine = createStandaloneEngine();

    // Initialize world state with appropriate map size
    const mapConfig = this.backgroundMode ? MAP_SETTINGS.demo : MAP_SETTINGS.game;
    const mapWidth = mapConfig.width;
    const mapHeight = mapConfig.height;
    this.world = new WorldState(42, mapWidth, mapHeight);
    this.world.thrustMultiplier = this.backgroundMode ? UNIT_THRUST_MULTIPLIER_DEMO : UNIT_THRUST_MULTIPLIER_GAME;
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
      const initialUnits = spawnBackgroundUnitsStandalone(this.world, this.engine, true, this.backgroundAllowedTypes);
      const tracker = this.simulation.getCombatStatsTracker();
      for (const unit of initialUnits) {
        if (unit.unit?.unitType && unit.ownership) {
          tracker.registerEntity(unit.id, unit.ownership.playerId, unit.unit.unitType);
          tracker.recordUnitProduced(unit.ownership.playerId, unit.unit.unitType);
        }
      }
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
          entity.body = { matterBody: toPhaserBody(body) };
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
    this.snapshotListeners.length = 0;
    this.gameOverListeners.length = 0;

    // Clear simulation singletons so entity refs don't survive across sessions
    spatialGrid.clear();
    beamIndex.clear();
    economyManager.reset();
  }

  // Start in manual mode: caller drives tick() and emitSnapshot() externally
  startManual(): void {
    this.lastTickTime = performance.now();
  }

  // Main tick function (public so Phaser update() can drive it directly)
  tick(delta: number): void {
    // Track tick deltas for stats
    this.tickDeltaHistory[this.tickDeltaIndex] = delta;
    this.tickDeltaIndex = (this.tickDeltaIndex + 1) % this.TICK_HISTORY_SIZE;
    if (this.tickDeltaCount < this.TICK_HISTORY_SIZE) this.tickDeltaCount++;

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

      // Sync actual post-friction velocities to entities for snapshot serialization
      syncVelocitiesFromPhysics(this.world, this.PHYSICS_TIMESTEP);

      this.physicsAccumulator -= this.PHYSICS_TIMESTEP;
      physicsSteps++;
    }

    // Background mode: continuously spawn units
    if (this.backgroundMode) {
      this.backgroundSpawnTimer += delta;
      if (this.backgroundSpawnTimer >= this.BACKGROUND_SPAWN_INTERVAL) {
        this.backgroundSpawnTimer = 0;
        const spawnedUnits = spawnBackgroundUnitsStandalone(this.world, this.engine, false, this.backgroundAllowedTypes);
        const tracker = this.simulation.getCombatStatsTracker();
        for (const unit of spawnedUnits) {
          if (unit.unit?.unitType && unit.ownership) {
            tracker.registerEntity(unit.id, unit.ownership.playerId, unit.unit.unitType);
            tracker.recordUnitProduced(unit.ownership.playerId, unit.unit.unitType);
          }
        }
      }
    }
  }

  // Emit a snapshot to all listeners
  emitSnapshot(): void {
    const winnerId = this.simulation.getWinnerId() ?? undefined;
    const sprayTargets = this.simulation.getSprayTargets();
    const audioEvents = this.simulation.getAndClearAudioEvents();
    const projectileSpawns = this.simulation.getAndClearProjectileSpawns();
    const projectileDespawns = this.simulation.getAndClearProjectileDespawns();
    const projectileVelocityUpdates = this.simulation.getAndClearProjectileVelocityUpdates();

    // Include spatial grid occupancy and search cells when debug toggle is on
    const gridCells = this.sendGridInfo ? spatialGrid.getOccupiedCells() : undefined;
    const gridSearchCells = this.sendGridInfo ? this.computeSearchCells() : undefined;
    const gridCellSize = this.sendGridInfo ? spatialGrid.getCellSize() : undefined;

    const state = serializeGameState(this.world, winnerId, sprayTargets, audioEvents, projectileSpawns, projectileDespawns, projectileVelocityUpdates, gridCells, gridSearchCells, gridCellSize);

    // Add combat stats to snapshot
    state.combatStats = this.simulation.getCombatStatsSnapshot();

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
  addSnapshotListener(callback: SnapshotCallback): void {
    this.snapshotListeners.push(callback);
  }

  // Add a game over listener
  addGameOverListener(callback: GameOverCallback): void {
    this.gameOverListeners.push(callback);
  }

  // Change snapshot emission rate, or switch to real-time (inline) mode
  setSnapshotRate(hz: number | 'realtime'): void {
    if (hz === 'realtime') {
      this.inlineSnapshots = true;
      if (this.snapshotInterval) {
        clearInterval(this.snapshotInterval);
        this.snapshotInterval = null;
      }
    } else {
      this.inlineSnapshots = false;
      this.snapshotRateHz = hz;
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

  // Toggle spatial grid debug info in snapshots
  setSendGridInfo(enabled: boolean): void {
    this.sendGridInfo = enabled;
  }

  // Compute per-team search cells: the bounding box of cells each unit's seeRange covers
  private computeSearchCells(): NetworkGridCell[] {
    const cellSize = spatialGrid.getCellSize();
    if (cellSize <= 0) return [];

    // Map from bit-packed cell key to Set of player IDs searching that cell
    const cellMap = new Map<number, Set<number>>();

    for (const unit of this.world.getUnits()) {
      if (!unit.unit || unit.unit.hp <= 0 || !unit.weapons || unit.weapons.length === 0) continue;
      const playerId = unit.ownership?.playerId;
      if (playerId === undefined) continue;

      // Find max seeRange across all weapons
      let maxSeeRange = 0;
      for (let i = 0; i < unit.weapons.length; i++) {
        if (unit.weapons[i].seeRange > maxSeeRange) {
          maxSeeRange = unit.weapons[i].seeRange;
        }
      }
      if (maxSeeRange <= 0) continue;

      const x = unit.transform.x;
      const y = unit.transform.y;
      const minCx = Math.floor((x - maxSeeRange) / cellSize);
      const maxCx = Math.floor((x + maxSeeRange) / cellSize);
      const minCy = Math.floor((y - maxSeeRange) / cellSize);
      const maxCy = Math.floor((y + maxSeeRange) / cellSize);

      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
          // Bit-pack key: offset by 10000 to handle negative coords
          const key = (cx + 10000) * 20000 + (cy + 10000);
          let players = cellMap.get(key);
          if (!players) {
            players = new Set();
            cellMap.set(key, players);
          }
          players.add(playerId);
        }
      }
    }

    // Convert to NetworkGridCell array
    const result: NetworkGridCell[] = [];
    for (const [key, players] of cellMap) {
      const cx = Math.floor(key / 20000) - 10000;
      const cy = (key % 20000) - 10000;
      result.push({ cx, cy, players: Array.from(players) });
    }
    return result;
  }

  // Get tick rate stats (avg and worst FPS over recent history)
  getTickStats(): { avgFps: number; worstFps: number } {
    const count = this.tickDeltaCount;
    if (count === 0) return { avgFps: 0, worstFps: 0 };

    const history = this.tickDeltaHistory;
    let sum = 0;
    let maxDelta = 0;
    for (let i = 0; i < count; i++) {
      sum += history[i];
      if (history[i] > maxDelta) maxDelta = history[i];
    }

    const avgDelta = sum / count;
    return {
      avgFps: avgDelta > 0 ? 1000 / avgDelta : 0,
      worstFps: maxDelta > 0 ? 1000 / maxDelta : 0,
    };
  }

  // Background demo: toggle unit type spawning
  setBackgroundUnitTypeEnabled(unitType: string, enabled: boolean): void {
    if (enabled) {
      this.backgroundAllowedTypes.add(unitType);
    } else {
      this.backgroundAllowedTypes.delete(unitType);
      // Kill all existing units of this type
      for (const unit of this.world.getUnits()) {
        if (unit.unit?.unitType === unitType) {
          if (unit.body?.matterBody) {
            removeBodyStandalone(this.engine, unit.body.matterBody);
          }
          this.world.removeEntity(unit.id);
        }
      }
    }
  }

  getBackgroundAllowedTypes(): ReadonlySet<string> {
    return this.backgroundAllowedTypes;
  }
}
