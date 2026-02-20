// GameServer - Headless simulation server (no Phaser dependency)
// Owns WorldState, Simulation, PhysicsEngine, and runs the game loop via setInterval

import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue, type Command } from '../sim/commands';
import { spawnInitialEntities } from '../sim/spawn';
import { serializeGameState, resetDeltaTracking } from '../network/stateSerializer';
import type { NetworkGridCell } from '../network/NetworkTypes';
import type { SnapshotCallback, GameOverCallback } from './GameConnection';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { DeathContext } from '../sim/combat';
import { economyManager } from '../sim/economy';
import { beamIndex } from '../sim/BeamIndex';
import { PhysicsEngine } from './PhysicsEngine';
import { spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import { magnitude } from '../math';
import {
  MAP_SETTINGS,
  UNIT_STATS,
  UNIT_THRUST_MULTIPLIER_GAME,
  UNIT_THRUST_MULTIPLIER_DEMO,
  SNAPSHOT_CONFIG,
  DEFAULT_KEYFRAME_RATIO,
  EMA_CONFIG,
  type KeyframeRatio,
} from '../../config';
import { spatialGrid } from '../sim/SpatialGrid';
import { resetProjectileBuffers } from '../sim/combat/projectileSystem';
import { resetDamageBuffers } from '../sim/damage/DamageSystem';

export interface GameServerConfig {
  playerIds: PlayerId[];
  backgroundMode?: boolean;
  snapshotRate?: number; // Hz, default 10
}

export class GameServer {
  private physics: PhysicsEngine;
  private world: WorldState;
  private simulation: Simulation;
  private commandQueue: CommandQueue;

  private playerIds: PlayerId[];
  private backgroundMode: boolean;

  // Game loop
  private gameLoopInterval: ReturnType<typeof setInterval> | null = null;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime: number = 0;
  private snapshotRateHz: number;
  private snapshotRateDisplay: number | 'realtime';
  private keyframeRatioDisplay: number | 'ALL' | 'NONE';

  // Background mode
  private backgroundSpawnTimer: number = 0;
  private readonly BACKGROUND_SPAWN_INTERVAL: number = 500;
  private backgroundAllowedTypes: Set<string> = new Set(Object.keys(UNIT_STATS));

  // Snapshot listeners
  private snapshotListeners: SnapshotCallback[] = [];
  private gameOverListeners: GameOverCallback[] = [];

  // Game over tracking
  private isGameOver: boolean = false;

  // Tick rate tracking (EMA-based)
  private tpsAvg: number = 0;
  private tpsLow: number = 0;
  private tpsInitialized: boolean = false;

  // Delta snapshot keyframe ratio tracking
  private isFirstSnapshot: boolean = true;
  private snapshotCounter: number = 0;
  private keyframeRatio: number = typeof DEFAULT_KEYFRAME_RATIO === 'number' ? DEFAULT_KEYFRAME_RATIO : DEFAULT_KEYFRAME_RATIO === 'ALL' ? 1 : 0;

  // Debug: send spatial grid occupancy info in snapshots
  private sendGridInfo: boolean = false;

  // Public IP address (set by host component)
  private ipAddress: string = 'N/A';

  constructor(config: GameServerConfig) {
    this.playerIds = config.playerIds;
    this.backgroundMode = config.backgroundMode ?? false;
    this.snapshotRateHz = config.snapshotRate ?? 10;
    this.snapshotRateDisplay = config.snapshotRate ?? 10;
    this.keyframeRatioDisplay = DEFAULT_KEYFRAME_RATIO;

    // Create custom physics engine
    this.physics = new PhysicsEngine();

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
      const initialUnits = spawnBackgroundUnitsStandalone(this.world, this.physics, true, this.backgroundAllowedTypes);
      const tracker = this.simulation.getCombatStatsTracker();
      for (const unit of initialUnits) {
        if (unit.unit?.unitType && unit.ownership) {
          tracker.registerEntity(unit.id, unit.ownership.playerId, unit.unit.unitType);
          tracker.recordUnitProduced(unit.ownership.playerId, unit.unit.unitType);
        }
      }
    } else {
      const entities = spawnInitialEntities(this.world, this.playerIds);
      this.createPhysicsBodies(entities);
    }
  }

  private setupSimulationCallbacks(): void {
    // Handle unit deaths: remove physics bodies and entities
    this.simulation.onUnitDeath = (deadUnitIds: EntityId[], _deathContexts?: Map<EntityId, DeathContext>) => {
      for (const id of deadUnitIds) {
        const entity = this.world.getEntity(id);
        if (entity?.body?.physicsBody) {
          this.physics.removeBody(entity.body.physicsBody);
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

    // Handle unit spawns: create physics bodies
    this.simulation.onUnitSpawn = (newUnits: Entity[]) => {
      for (const entity of newUnits) {
        if (entity.type === 'unit' && entity.unit) {
          const body = this.physics.createUnitBody(
            entity.transform.x,
            entity.transform.y,
            entity.unit.collisionRadius,
            entity.unit.mass,
            `unit_${entity.id}`
          );
          entity.body = { physicsBody: body };
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

    // Reset simulation-owned state (ForceAccumulator, CombatStatsTracker, pending event buffers)
    this.simulation.resetSessionState();

    // Reset module-level reusable buffers that hold stale entity references
    resetProjectileBuffers();
    resetDamageBuffers();
    resetDeltaTracking();

    // Reset keyframe state for next session
    this.isFirstSnapshot = true;
    this.snapshotCounter = 0;
  }

  // Main simulation tick — variable timestep (driven by internal setInterval)
  private tick(delta: number): void {
    // Track TPS via EMA
    if (delta > 0) {
      const tps = 1000 / delta;
      if (!this.tpsInitialized) {
        this.tpsAvg = tps;
        this.tpsLow = tps;
        this.tpsInitialized = true;
      } else {
        this.tpsAvg = (1 - EMA_CONFIG.tps.avg) * this.tpsAvg + EMA_CONFIG.tps.avg * tps;
        this.tpsLow = tps < this.tpsLow
          ? (1 - EMA_CONFIG.tps.low.drop) * this.tpsLow + EMA_CONFIG.tps.low.drop * tps
          : (1 - EMA_CONFIG.tps.low.recovery) * this.tpsLow + EMA_CONFIG.tps.low.recovery * tps;
      }
    }

    // Clamp dt to prevent spiral of death (max ~4 frames at 60Hz)
    const dtSec = Math.min(delta / 1000, 4 / 60);

    // Update simulation (calculates thrust velocities, runs combat, etc.)
    this.simulation.update(delta);

    // Apply thrust + external forces to physics bodies
    this.applyForces();

    // Step physics (integrate + collisions)
    this.physics.step(dtSec);

    // Sync positions/velocities from physics to entities
    this.syncFromPhysics();

    // Background mode: continuously spawn units
    if (this.backgroundMode) {
      this.backgroundSpawnTimer += delta;
      if (this.backgroundSpawnTimer >= this.BACKGROUND_SPAWN_INTERVAL) {
        this.backgroundSpawnTimer = 0;
        const spawnedUnits = spawnBackgroundUnitsStandalone(this.world, this.physics, false, this.backgroundAllowedTypes);
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

  // Apply thrust and external forces to physics bodies
  private applyForces(): void {
    const forceAccumulator = this.simulation.getForceAccumulator();

    for (const entity of this.world.getUnits()) {
      if (!entity.body?.physicsBody || !entity.unit) continue;

      const body = entity.body.physicsBody;

      // Sync position from physics body (before force application, for rotation calc)
      entity.transform.x = body.x;
      entity.transform.y = body.y;

      // Get the direction unit wants to move
      const dirX = entity.unit.velocityX ?? 0;
      const dirY = entity.unit.velocityY ?? 0;
      const dirMag = magnitude(dirX, dirY);

      // Update rotation to face movement direction
      if (dirMag > 0.01) {
        entity.transform.rotation = Math.atan2(dirY, dirX);
      }

      let thrustForceX = 0;
      let thrustForceY = 0;
      if (dirMag > 0) {
        const MATTER_FORCE_SCALE = 150000;
        const thrustMagnitude = (entity.unit.moveSpeed * this.world.thrustMultiplier * entity.unit.mass) / MATTER_FORCE_SCALE;
        thrustForceX = (dirX / dirMag) * thrustMagnitude;
        thrustForceY = (dirY / dirMag) * thrustMagnitude;
      }

      // Get external forces from the accumulator
      const externalForce = forceAccumulator.getFinalForce(entity.id);
      const externalFx = (externalForce?.fx ?? 0) / 3600;
      const externalFy = (externalForce?.fy ?? 0) / 3600;

      let totalForceX = thrustForceX + externalFx;
      let totalForceY = thrustForceY + externalFy;

      if (!Number.isFinite(totalForceX) || !Number.isFinite(totalForceY)) {
        continue;
      }

      // Matter.js Verlet integration uses (F/m) * deltaTimeMs², our Euler engine uses (F/m) * dtSec.
      // Conversion: (ms)² / (sec)² = 1000² = 1e6. With friction-first ordering this is exact.
      this.physics.applyForce(body, totalForceX * 1e6, totalForceY * 1e6);
    }
  }

  // Sync positions and velocities from physics bodies to entities
  private syncFromPhysics(): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.body?.physicsBody || !entity.unit) continue;
      const body = entity.body.physicsBody;
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      // PhysicsBody velocities are already in px/sec — no conversion needed
      entity.unit.velocityX = body.vx;
      entity.unit.velocityY = body.vy;
    }
  }

  // Create physics bodies for a list of entities
  private createPhysicsBodies(entities: Entity[]): void {
    for (const entity of entities) {
      if (entity.type === 'unit' && entity.unit) {
        const body = this.physics.createUnitBody(
          entity.transform.x,
          entity.transform.y,
          entity.unit.physicsRadius,
          entity.unit.mass,
          `unit_${entity.id}`
        );
        entity.body = { physicsBody: body };
      } else if (entity.type === 'building' && entity.building) {
        const body = this.physics.createBuildingBody(
          entity.transform.x,
          entity.transform.y,
          entity.building.width,
          entity.building.height,
          `building_${entity.id}`
        );
        entity.body = { physicsBody: body };
      }
    }
  }

  // Emit a snapshot to all listeners (driven by internal snapshot interval)
  private emitSnapshot(): void {
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

    // Determine if this snapshot should be a delta or a full keyframe
    // First snapshot is always a keyframe; then use ratio-based counter
    let isDelta = false;
    if (this.isFirstSnapshot) {
      this.isFirstSnapshot = false;
      this.snapshotCounter = 0;
    } else if (SNAPSHOT_CONFIG.deltaEnabled) {
      if (this.keyframeRatio >= 1) {
        // ALL: every snapshot is a keyframe
        isDelta = false;
      } else if (this.keyframeRatio <= 0) {
        // NONE: never a keyframe after the first
        isDelta = true;
      } else {
        this.snapshotCounter++;
        const keyframeInterval = Math.round(1 / this.keyframeRatio);
        if (this.snapshotCounter >= keyframeInterval) {
          this.snapshotCounter = 0;
          // keyframe — isDelta stays false
        } else {
          isDelta = true;
        }
      }
    }

    const state = serializeGameState(this.world, isDelta, winnerId, sprayTargets, audioEvents, projectileSpawns, projectileDespawns, projectileVelocityUpdates, gridCells, gridSearchCells, gridCellSize);

    // Add combat stats to snapshot
    state.combatStats = this.simulation.getCombatStatsSnapshot();

    // Add server metadata to snapshot
    // On delta snapshots, only include serverMeta when the time string changed (once per second)
    const currentTime = this.formatServerTime();
    const timeChanged = currentTime !== this.lastSentServerTime;
    if (!isDelta || timeChanged) {
      const tickStats = this.getTickStats();
      state.serverMeta = {
        tpsAvg: tickStats.avgFps,
        tpsWorst: tickStats.worstFps,
        snapshotRate: this.snapshotRateDisplay,
        keyframeRatio: this.keyframeRatioDisplay,
        sendGridInfo: this.sendGridInfo,
        serverTime: currentTime,
        ipAddress: this.ipAddress,
        allowedUnitTypes: this.backgroundMode
          ? [...this.backgroundAllowedTypes]
          : undefined,
        maxTotalUnits: this.world.maxTotalUnits,
      };
      this.lastSentServerTime = currentTime;
    }

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
    // Intercept server config commands (don't need tick synchronization)
    switch (command.type) {
      case 'setSnapshotRate':
        this.setSnapshotRate(command.rate);
        return;
      case 'setKeyframeRatio':
        this.setKeyframeRatio(command.ratio);
        return;
      case 'setSendGridInfo':
        this.setSendGridInfo(command.enabled);
        return;
      case 'setBackgroundUnitType':
        this.setBackgroundUnitTypeEnabled(command.unitType, command.enabled);
        return;
      case 'setMaxTotalUnits':
        this.world.maxTotalUnits = command.maxTotalUnits;
        return;
    }
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

  // Change keyframe ratio (fraction of snapshots that are full keyframes)
  setKeyframeRatio(ratio: KeyframeRatio): void {
    this.keyframeRatioDisplay = ratio;
    this.keyframeRatio = ratio === 'ALL' ? 1 : ratio === 'NONE' ? 0 : ratio;
    this.snapshotCounter = 0;
  }

  // Change snapshot emission rate ('realtime' maps to 60Hz)
  setSnapshotRate(hz: number | 'realtime'): void {
    this.snapshotRateDisplay = hz;
    this.snapshotRateHz = hz === 'realtime' ? 60 : hz;
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

  // Set the public IP address (called by host component after fetching)
  setIpAddress(ip: string): void {
    this.ipAddress = ip;
  }

  // Format current time as military format with timezone abbreviation (e.g. "14:34:05 MST")
  // Caches result so delta snapshots can skip sending unchanged time
  private lastServerTime: string = '';
  private lastServerTimeSec: number = -1;
  private lastSentServerTime: string = ''; // Track what was last sent so deltas can skip
  private formatServerTime(): string {
    const now = new Date();
    const sec = now.getSeconds();
    if (sec !== this.lastServerTimeSec) {
      this.lastServerTimeSec = sec;
      this.lastServerTime = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short',
      }).format(now);
    }
    return this.lastServerTime;
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

  // Get tick rate stats (EMA-based avg and low)
  getTickStats(): { avgFps: number; worstFps: number } {
    return { avgFps: this.tpsAvg, worstFps: this.tpsLow };
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
          if (unit.body?.physicsBody) {
            this.physics.removeBody(unit.body.physicsBody);
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
