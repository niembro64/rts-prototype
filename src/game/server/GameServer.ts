// GameServer - Headless simulation server (no Phaser dependency)
// Owns WorldState, Simulation, PhysicsEngine3D, and runs the game loop via setInterval

import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue, type Command } from '../sim/commands';
import { spawnInitialEntities, spawnInitialBases } from '../sim/spawn';
import { serializeGameState, resetDeltaTracking } from '../network/stateSerializer';
import type { NetworkServerSnapshotGridCell } from '../network/NetworkTypes';
import type { SnapshotCallback, GameOverCallback } from './GameConnection';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { DeathContext } from '../sim/combat';
import { economyManager } from '../sim/economy';
import { beamIndex } from '../sim/BeamIndex';
import {
  setSimQuality,
  setSimTpsRatio,
  setSimCpuRatio,
  setSimUnitCount,
  setSimUnitCap,
  getSimQuality,
  getEffectiveSimQuality,
} from '../sim/simQuality';
import type { ServerSimQuality } from '@/types/serverSimLod';
import { PhysicsEngine3D } from './PhysicsEngine3D';
import { BACKGROUND_UNIT_TYPES, spawnBackgroundUnitsStandalone } from './BackgroundBattleStandalone';
import { magnitude } from '../math';
import {
  getMapSize,
  UNIT_THRUST_MULTIPLIER_GAME,
  SNAPSHOT_CONFIG,
  DEFAULT_KEYFRAME_RATIO,
  EMA_CONFIG,
  EMA_INITIAL_VALUES,
  MAX_TICK_DT_MS,
  type KeyframeRatio,
} from '../../config';
import { spatialGrid } from '../sim/SpatialGrid';
import { resetProjectileBuffers } from '../sim/combat/projectileSystem';
import { resetDamageBuffers } from '../sim/damage/DamageSystem';
import { CaptureSystem } from '../sim/CaptureSystem';
import { MANA_PER_TILE_PER_SECOND } from '../../config';

export type { GameServerConfig } from '@/types/game';
import type { GameServerConfig } from '@/types/game';

export class GameServer {
  private physics: PhysicsEngine3D;
  private world: WorldState;
  private simulation: Simulation;
  private commandQueue: CommandQueue;

  private playerIds: PlayerId[];
  private backgroundMode: boolean;

  // Game loop
  private gameLoopInterval: ReturnType<typeof setInterval> | null = null;
  private lastTickTime: number = 0;
  private tickRateHz: number;
  private maxSnapshotIntervalMs: number; // Min ms between snapshots (0 = no cap, send every tick)
  private maxSnapshotsDisplay: number | 'none';
  private lastSnapshotTime: number = 0;
  private keyframeRatioDisplay: number | 'ALL' | 'NONE';

  // Background mode — allowed unit types for AI production & UI toggles.
  // Initial set comes from GameServerConfig.initialAllowedTypes when the
  // caller restored saved demo settings; otherwise defaults to "all".
  private backgroundAllowedTypes: Set<string>;

  // Snapshot listeners
  private snapshotListeners: SnapshotCallback[] = [];
  private gameOverListeners: GameOverCallback[] = [];

  // Game over tracking
  private isGameOver: boolean = false;

  // Tick rate tracking (EMA-based, start optimistic)
  private tpsAvg: number = EMA_INITIAL_VALUES.tps;
  private tpsLow: number = EMA_INITIAL_VALUES.tps;
  private tpsInitialized: boolean = true;

  // Per-tick CPU cost tracking (ms). EMA-smoothed average and "hi" spike
  // value, same tier semantics as FRAME_TIMING_EMA. Computed from
  // performance.now() wrapping the tick() body. Exposed as a load-percent
  // via NetworkServerSnapshotMeta.cpu so both host and remote clients can
  // see how saturated the simulation is relative to the tick budget.
  private tickMsAvg: number = 0;
  private tickMsHi: number = 0;
  private tickMsInitialized: boolean = false;

  // Delta snapshot keyframe ratio tracking
  private isFirstSnapshot: boolean = true;
  private snapshotCounter: number = 0;
  private keyframeRatio: number = typeof DEFAULT_KEYFRAME_RATIO === 'number' ? DEFAULT_KEYFRAME_RATIO : DEFAULT_KEYFRAME_RATIO === 'ALL' ? 1 : 0;

  // Debug: send spatial grid occupancy info in snapshots
  private sendGridInfo: boolean = false;

  // Territory capture system
  private captureSystem = new CaptureSystem();

  // Public IP address (set by host component)
  private ipAddress: string = 'N/A';

  /** Async factory — kept for API compatibility with the pre-3D branch
   *  (host code still calls `GameServer.create(...)`) but there is no
   *  longer a WASM path to initialize: the 3D engine is pure TS. */
  static async create(config: GameServerConfig): Promise<GameServer> {
    return new GameServer(config);
  }

  constructor(config: GameServerConfig, physics?: PhysicsEngine3D) {
    this.playerIds = config.playerIds;
    this.backgroundMode = config.backgroundMode ?? false;
    this.tickRateHz = 60;
    const maxSnaps = config.maxSnapshotsPerSec ?? 30;
    this.maxSnapshotIntervalMs = maxSnaps > 0 ? 1000 / maxSnaps : 0;
    this.maxSnapshotsDisplay = maxSnaps > 0 ? maxSnaps : 'none';
    this.keyframeRatioDisplay = DEFAULT_KEYFRAME_RATIO;

    // Demo / lobby battle uses MAP_SETTINGS.demo (larger); real game
    // uses MAP_SETTINGS.game.
    const mapConfig = getMapSize(this.backgroundMode);
    const mapWidth = mapConfig.width;
    const mapHeight = mapConfig.height;

    // The physics engine is now fully 3D — same module for every path.
    this.physics = physics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    this.world = new WorldState(42, mapWidth, mapHeight);
    this.world.thrustMultiplier = UNIT_THRUST_MULTIPLIER_GAME;
    this.world.setActivePlayer(0 as PlayerId); // Server has no active player

    this.commandQueue = new CommandQueue();
    this.simulation = new Simulation(this.world, this.commandQueue);
    this.simulation.setPlayerIds(this.playerIds);

    // Honour any saved demo-unit selection passed in by the caller —
    // this MUST happen before spawnBackgroundUnitsStandalone so the
    // initial spawn picks from the restricted set. Otherwise we'd
    // create units of disallowed types and immediately wipe them via
    // the toggle handler.
    this.backgroundAllowedTypes = new Set(
      config.initialAllowedTypes ?? BACKGROUND_UNIT_TYPES,
    );

    // Setup simulation callbacks
    this.setupSimulationCallbacks();

    // AI player configuration
    const aiPlayerIds = config.aiPlayerIds ?? (this.backgroundMode ? [...this.playerIds] : []);

    // Spawn initial entities
    if (aiPlayerIds.length > 0) {
      // AI game: full base with factories, solars, and commander per player
      const constructionSystem = this.simulation.getConstructionSystem();
      const entities = spawnInitialBases(this.world, constructionSystem, this.playerIds);
      this.createPhysicsBodies(entities);
      this.simulation.setAiPlayerIds(aiPlayerIds);

      // Background mode: spawn a cluster of units near center for immediate combat
      if (this.backgroundMode) {
        spawnBackgroundUnitsStandalone(this.world, this.physics, true, this.backgroundAllowedTypes);
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

    // Handle building deaths: remove physics bodies and entities
    this.simulation.onBuildingDeath = (deadBuildingIds: EntityId[]) => {
      const constructionSystem = this.simulation.getConstructionSystem();
      for (const id of deadBuildingIds) {
        const entity = this.world.getEntity(id);
        if (entity) {
          if (entity.body?.physicsBody) {
            this.physics.removeBody(entity.body.physicsBody);
          }
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
            entity.unit.unitRadiusCollider.push,
            entity.unit.mass,
            `unit_${entity.id}`
          );
          entity.body = { physicsBody: body };

          // Skip collision with the factory this unit spawned from
          // (unit starts at factory center — would be pushed in random direction)
          const spawnX = entity.transform.x;
          const spawnY = entity.transform.y;
          for (const building of this.world.getBuildings()) {
            if (!building.body?.physicsBody || !building.building) continue;
            const bw = building.building.width / 2;
            const bh = building.building.height / 2;
            if (Math.abs(spawnX - building.transform.x) < bw &&
                Math.abs(spawnY - building.transform.y) < bh) {
              this.physics.setIgnoreStatic(body, building.body.physicsBody);
              break;
            }
          }
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
    const now = performance.now();
    this.lastTickTime = now;
    this.lastSnapshotTime = 0; // Ensure first tick always emits a snapshot
    this.startGameLoop();
  }

  private startGameLoop(): void {
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
    }
    // Run simulation at configured tick rate
    // Snapshots are emitted at end of tick, gated by maxSnapshotIntervalMs
    this.gameLoopInterval = setInterval(() => {
      const tickNow = performance.now();
      const delta = tickNow - this.lastTickTime;
      this.lastTickTime = tickNow;

      // Measure how much CPU the tick body actually consumed, separately
      // from its *period* (which the TPS EMA tracks). Snapshot emission is
      // part of the same setInterval callback, so we include it — remote
      // clients care about the total load each tick imposes on the host.
      const workStart = performance.now();
      this.tick(delta);

      const elapsed = tickNow - this.lastSnapshotTime;
      // Auto-throttle: at high unit counts the snapshot serialization +
      // bandwidth dominates, so stretch the interval as the world
      // gets denser. The base interval comes from the user-configured
      // maxSnapshotsPerSec; the multiplier is 1× below 2k units and
      // climbs to 4× past 12k. Below the threshold the gate is
      // identical to before. Manual `none` (interval = 0) still
      // means "every tick" — no reason to throttle when the user has
      // explicitly opted out.
      const baseInterval = this.maxSnapshotIntervalMs;
      const effectiveInterval = baseInterval === 0
        ? 0
        : baseInterval * this.snapshotIntervalMultiplier();
      if (effectiveInterval === 0 || elapsed >= effectiveInterval) {
        this.lastSnapshotTime = tickNow;
        this.emitSnapshot();
      }

      const workMs = performance.now() - workStart;
      if (!this.tickMsInitialized) {
        this.tickMsAvg = workMs;
        this.tickMsHi = workMs;
        this.tickMsInitialized = true;
      } else {
        // Same tier semantics as FRAME_TIMING_EMA: slow drift on avg, fast
        // climb on hi, slow decay on hi.
        this.tickMsAvg = 0.99 * this.tickMsAvg + 0.01 * workMs;
        this.tickMsHi = workMs > this.tickMsHi
          ? 0.5 * this.tickMsHi + 0.5 * workMs
          : 0.9999 * this.tickMsHi + 0.0001 * workMs;
      }
    }, 1000 / this.tickRateHz);
  }

  // Stop the game loop
  stop(): void {
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
      this.gameLoopInterval = null;
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

    // Clamp dt to prevent spiral of death
    const dtMs = Math.min(delta, MAX_TICK_DT_MS);
    const dtSec = dtMs / 1000;

    // Push host signals into the SERVER LOD driver before the sim
    // runs — every throttle decision inside the upcoming tick will
    // read the freshly-resolved tier from getSimDetailConfig().
    // Cheap (a few Number assignments + the rank resolver runs once
    // per call to getSimDetailConfig, which the hot paths invoke
    // a handful of times per tick at most).
    this.refreshSimQualitySignals();

    // Update simulation (calculates thrust velocities, runs combat, etc.)
    this.simulation.update(dtMs);

    // Apply thrust + external forces to physics bodies
    this.applyForces();

    // Step physics (integrate + collisions)
    this.physics.step(dtSec);

    // Sync positions/velocities from physics to entities
    this.syncFromPhysics();

    // Update territory capture (uses spatial grid occupancy)
    this.captureSystem.update(spatialGrid.getOccupiedCellsForCapture(), dtSec);

    // Update mana income from territory (proportional to flag heights)
    const flagSums = this.captureSystem.getFlagSumsByPlayer();
    for (const playerId of this.playerIds) {
      const flagSum = flagSums.get(playerId) ?? 0;
      economyManager.setManaTerritory(playerId, flagSum * MANA_PER_TILE_PER_SECOND);
    }
  }

  // Apply thrust and external forces to physics bodies
  private applyForces(): void {
    const forceAccumulator = this.simulation.getForceAccumulator();

    for (const entity of this.world.getUnits()) {
      if (!entity.body?.physicsBody || !entity.unit) continue;

      const body = entity.body.physicsBody;

      // Sync position from physics body (before force application, for
      // rotation calc). z tracks gravity + ground contact — units sit on
      // the ground at body.radius altitude; explosions or falls push them
      // up and gravity pulls them back.
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;

      // Horizontal thrust target from the action system. velocityZ is
      // purely a physics readback — thrust is always horizontal,
      // vertical motion is gravity-driven (or knockback-driven via the
      // force accumulator, when that channel lands).
      // thrustDirX/Y is the dedicated thrust channel; velocityX/Y is
      // the authoritative physics velocity (set by syncFromPhysics)
      // and must NOT be overwritten by the action system.
      const dirX = entity.unit.thrustDirX ?? 0;
      const dirY = entity.unit.thrustDirY ?? 0;
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
      // Horizontal thrust only — vertical motion is gravity-driven. If
      // an external force accumulator ever adds a vertical channel
      // (explosion launches the unit upward, say), it flows through a
      // dedicated upgrade in M5.
      this.physics.applyForce(body, totalForceX * 1e6, totalForceY * 1e6, 0);
    }
  }

  // Sync positions and velocities from physics bodies to entities
  private syncFromPhysics(): void {
    for (const entity of this.world.getUnits()) {
      if (!entity.body?.physicsBody || !entity.unit) continue;
      const body = entity.body.physicsBody;
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;
      entity.unit.velocityX = body.vx;
      entity.unit.velocityY = body.vy;
      entity.unit.velocityZ = body.vz;
    }
  }

  // Create physics bodies for a list of entities
  // Buildings are created first so that units can set ignore-static for overlapping buildings.
  private createPhysicsBodies(entities: Entity[]): void {
    // Pass 1: create building bodies
    for (const entity of entities) {
      if (entity.type === 'building' && entity.building) {
        const body = this.physics.createBuildingBody(
          entity.transform.x,
          entity.transform.y,
          entity.building.width,
          entity.building.height,
          entity.building.depth,
          `building_${entity.id}`
        );
        entity.body = { physicsBody: body };
      }
    }

    // Pass 2: create unit bodies + set ignore-static for overlapping buildings
    for (const entity of entities) {
      if (entity.type === 'unit' && entity.unit) {
        const body = this.physics.createUnitBody(
          entity.transform.x,
          entity.transform.y,
          entity.unit.unitRadiusCollider.push,
          entity.unit.mass,
          `unit_${entity.id}`
        );
        entity.body = { physicsBody: body };

        // Skip collision with any building the unit overlaps at spawn
        const spawnX = entity.transform.x;
        const spawnY = entity.transform.y;
        for (const building of this.world.getBuildings()) {
          if (!building.body?.physicsBody || !building.building) continue;
          const bw = building.building.width / 2;
          const bh = building.building.height / 2;
          if (Math.abs(spawnX - building.transform.x) < bw + entity.unit.unitRadiusCollider.push &&
              Math.abs(spawnY - building.transform.y) < bh + entity.unit.unitRadiusCollider.push) {
            this.physics.setIgnoreStatic(body, building.body.physicsBody);
            break;
          }
        }
      }
    }

  }

  // Emit a snapshot to all listeners (driven by internal snapshot interval)
  private emitSnapshot(): void {
    const gamePhase = this.simulation.getGamePhase();
    const winnerId = gamePhase === 'gameOver' ? this.simulation.getWinnerId() ?? undefined : undefined;
    const sprayTargets = this.simulation.getSprayTargets();
    const audioEvents = this.simulation.getAndClearEvents();
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

    const state = serializeGameState(this.world, isDelta, gamePhase, winnerId, sprayTargets, audioEvents, projectileSpawns, projectileDespawns, projectileVelocityUpdates, gridCells, gridSearchCells, gridCellSize);

    // Add capture tile data (delta-aware: only changed tiles on delta snapshots)
    const captureTiles = this.captureSystem.consumeSnapshot(isDelta);
    if (captureTiles.length > 0) {
      state.capture = { tiles: captureTiles, cellSize: spatialGrid.getCellSize() };
    }

    // Add combat stats to snapshot
    state.combatStats = this.simulation.getCombatStatsSnapshot();

    // Add server metadata to snapshot
    // On delta snapshots, only include serverMeta when the time string changed (once per second)
    const currentTime = this.formatServerTime();
    const timeChanged = currentTime !== this.lastSentServerTime;
    if (!isDelta || timeChanged) {
      const tickStats = this.getTickStats();
      // CPU load = tick work / tick budget, expressed as a percent. We
      // clamp nothing here — the UI can show >100 to mean "falling behind".
      const tickBudgetMs = 1000 / this.tickRateHz;
      const cpuAvg = this.tickMsInitialized
        ? (this.tickMsAvg / tickBudgetMs) * 100
        : 0;
      const cpuHi = this.tickMsInitialized
        ? (this.tickMsHi / tickBudgetMs) * 100
        : 0;
      state.serverMeta = {
        ticks: { avg: tickStats.avgFps, low: tickStats.worstFps, rate: this.tickRateHz },
        snaps: { rate: this.maxSnapshotsDisplay, keyframes: this.keyframeRatioDisplay },
        server: { time: currentTime, ip: this.ipAddress },
        grid: this.sendGridInfo,
        units: {
          allowed: this.backgroundMode ? [...this.backgroundAllowedTypes] : undefined,
          max: this.world.maxTotalUnits,
          count: this.world.getUnits().length,
        },
        projVelInherit: this.world.projVelInherit,
        ffAccel: { units: this.world.ffAccelUnits, shots: this.world.ffAccelShots },
        cpu: { avg: cpuAvg, hi: cpuHi },
      };
      this.lastSentServerTime = currentTime;
    }

    for (const listener of this.snapshotListeners) {
      listener(state);
    }
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
      case 'setTickRate':
        this.setTickRate(command.rate);
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
      case 'setProjVelInherit':
        this.world.projVelInherit = command.enabled;
        return;
      case 'setFfAccelUnits':
        this.world.ffAccelUnits = command.enabled;
        return;
      case 'setFfAccelShots':
        this.world.ffAccelShots = command.enabled;
        return;
      case 'setSimQuality':
        this.setSimQuality(command.quality as ServerSimQuality);
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

  // Change max snapshots per second cap ('none' = no cap, send every tick)
  setSnapshotRate(rate: number | 'none'): void {
    this.maxSnapshotsDisplay = rate;
    this.maxSnapshotIntervalMs = rate === 'none' ? 0 : 1000 / rate;
  }

  /** Change HOST SERVER LOD tier ('auto' / 'auto-tps' / 'auto-cpu' /
   *  'auto-units' / 'min'..'max'). Drives sim throttling: targeting
   *  reacquire stride, beam path stride, mirror bisector iters,
   *  density-cap thresholds. The host client picks this in the UI. */
  setSimQuality(q: ServerSimQuality): void {
    setSimQuality(q);
  }

  getSimQuality(): ServerSimQuality {
    return getSimQuality();
  }

  getEffectiveSimQuality(): ReturnType<typeof getEffectiveSimQuality> {
    return getEffectiveSimQuality();
  }

  /** Push the host's current TPS / CPU / units stats into the LOD
   *  driver. Called once per tick from `tick()`, immediately before
   *  the sim runs, so every throttle that reads getSimDetailConfig()
   *  this tick sees a freshly-resolved tier. */
  private refreshSimQualitySignals(): void {
    // TPS ratio = actual / target. We use the EMA-smoothed avg here
    // (not the worst-case `low`) so the LOD doesn't bounce on a
    // single laggy tick.
    const tickStats = this.getTickStats();
    setSimTpsRatio(tickStats.avgFps / Math.max(1, this.tickRateHz));

    // CPU ratio = headroom = 1 − (cpu load / 100). The cpu fields
    // live as percent-of-tick-budget; they can exceed 100 when
    // we're falling behind. Clamp to [0, 1] for the LOD signal so
    // a momentary overshoot doesn't push the rank below MIN.
    const tickBudgetMs = 1000 / this.tickRateHz;
    const cpuLoad = this.tickMsInitialized
      ? Math.min(100, Math.max(0, (this.tickMsHi / tickBudgetMs) * 100))
      : 0;
    setSimCpuRatio(1 - cpuLoad / 100);

    // Units fullness — same shape as the client side.
    setSimUnitCount(this.world.getUnits().length);
    setSimUnitCap(this.world.maxTotalUnits);
  }

  /** Multiplier on the snapshot interval that grows with unit count.
   *  The intent: at high counts the per-snapshot serialization plus
   *  network bytes dominate the tick, so trade snapshot rate for
   *  CPU/bandwidth headroom. Returns 1.0 below the first threshold
   *  so light battles are unaffected. The thresholds line up with the
   *  UNITS auto-LOD ladder (2k/4k/8k/12k) so visual quality and
   *  network rate scale down together. */
  private snapshotIntervalMultiplier(): number {
    const n = this.world.getUnits().length;
    if (n < 2000) return 1;
    if (n < 4000) return 1.5;
    if (n < 8000) return 2;
    if (n < 12000) return 3;
    return 4;
  }

  // Change simulation tick rate (restarts the game loop interval)
  setTickRate(hz: number): void {
    this.tickRateHz = hz;
    if (this.gameLoopInterval) {
      this.startGameLoop();
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
  private computeSearchCells(): NetworkServerSnapshotGridCell[] {
    const cellSize = spatialGrid.getCellSize();
    if (cellSize <= 0) return [];

    // Map from bit-packed cell key to Set of player IDs searching that cell
    const cellMap = new Map<number, Set<number>>();

    for (const unit of this.world.getUnits()) {
      if (!unit.unit || unit.unit.hp <= 0 || !unit.turrets || unit.turrets.length === 0) continue;
      const playerId = unit.ownership?.playerId;
      if (playerId === undefined) continue;

      // Find max seeRange across all weapons
      let maxSeeRange = 0;
      for (let i = 0; i < unit.turrets.length; i++) {
        if (unit.turrets[i].ranges.tracking.release > maxSeeRange) {
          maxSeeRange = unit.turrets[i].ranges.tracking.release;
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

    // Convert to NetworkServerSnapshotGridCell array
    const result: NetworkServerSnapshotGridCell[] = [];
    for (const [key, players] of cellMap) {
      const cx = Math.floor(key / 20000) - 10000;
      const cy = (key % 20000) - 10000;
      result.push({ cell: { x: cx, y: cy }, players: Array.from(players) });
    }
    return result;
  }

  // Get tick rate stats (EMA-based avg and low)
  getTickStats(): { avgFps: number; worstFps: number } {
    return { avgFps: this.tpsAvg, worstFps: this.tpsLow };
  }

  // Background demo: toggle unit type for AI production
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
    // Update AI production filter
    this.simulation.setAiAllowedUnitTypes(this.backgroundAllowedTypes);
  }

  getBackgroundAllowedTypes(): ReadonlySet<string> {
    return this.backgroundAllowedTypes;
  }
}
