// GameServer - Headless simulation server (no Phaser dependency)
// Owns WorldState, Simulation, PhysicsEngine3D, and runs the game loop via setInterval

import type { WorldState } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type {
  AttackCommand,
  AttackAreaCommand,
  AttackGroundCommand,
  ClearQueuedOrdersCommand,
  CommandQueue,
  Command,
  GuardCommand,
  MoveCommand,
  PingCommand,
  RemoveLastQueuedOrderCommand,
  SetCameraAoiCommand,
  SetFireEnabledCommand,
  SetJumpEnabledCommand,
  StopCommand,
  WaitCommand,
} from '../sim/commands';
import {
  resetDeltaTracking,
  resetDeltaTrackingForKey,
  type SnapshotAoiBounds,
} from '../network/stateSerializer';
import type { SnapshotCallback, GameOverCallback } from './GameConnection';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { DeathContext } from '../sim/combat';
import { ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_POS, ENTITY_CHANGED_TURRETS, ENTITY_CHANGED_VEL } from '../../types/network';
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
  getSimDetailConfig,
  tickSimQuality,
  setSimSignalStates,
} from '../sim/simQuality';
import type { ServerSimQuality } from '@/types/serverSimLod';
import type { PhysicsEngine3D } from './PhysicsEngine3D';
import {
  DEFAULT_KEYFRAME_RATIO,
  EMA_CONFIG,
  MAX_TICK_DT_MS,
  type KeyframeRatio,
} from '../../config';
import { SERVER_SIM_LOD_EMA_SOURCE } from '../../serverSimLodConfig';
import { spatialGrid } from '../sim/SpatialGrid';
import { setTiltEmaMode } from '../sim/unitTilt';
import { resetProjectileBuffers } from '../sim/combat/projectileSystem';
import { updateCombatActivityFlags } from '../sim/combat/combatActivity';
import { resetDamageBuffers } from '../sim/damage/DamageSystem';
import type { CaptureSystem } from '../sim/CaptureSystem';
import { factoryProductionSystem } from '../sim/factoryProduction';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import { ServerBootstrap } from './ServerBootstrap';
import { ServerDebugGridPublisher } from './ServerDebugGridPublisher';
import { ServerTickLoop } from './ServerTickLoop';
import {
  ServerSnapshotPublisher,
  type SnapshotListenerEntry,
} from './ServerSnapshotPublisher';
import { UnitForceSystem } from './UnitForceSystem';
import { UnitSuspensionSystem } from './UnitSuspensionSystem';
import { createPhysicsBodyForUnit } from './unitPhysicsBody';
import {
  isForceFieldReflectionMode,
  type ForceFieldReflectionMode,
} from '../../types/shotTypes';

export type { GameServerConfig } from '@/types/game';
import type { GameServerConfig } from '@/types/game';

const CAMERA_AOI_BOUNDS_EPSILON = 64;

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boundsFromCameraAoiCommand(command: SetCameraAoiCommand): SnapshotAoiBounds | undefined {
  if (command.mode === 'all') return undefined;
  const b = command.bounds;
  if (b) {
    const minX = finiteOrUndefined(b.minX);
    const maxX = finiteOrUndefined(b.maxX);
    const minY = finiteOrUndefined(b.minY);
    const maxY = finiteOrUndefined(b.maxY);
    if (
      minX !== undefined &&
      maxX !== undefined &&
      minY !== undefined &&
      maxY !== undefined
    ) {
      return {
        minX: Math.min(minX, maxX),
        maxX: Math.max(minX, maxX),
        minY: Math.min(minY, maxY),
        maxY: Math.max(minY, maxY),
      };
    }
  }
  const quad = command.quad;
  if (!quad) return undefined;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of quad) {
    const x = finiteOrUndefined(p.x);
    const y = finiteOrUndefined(p.y);
    if (x === undefined || y === undefined) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return undefined;
  if (command.mode === 'padded') {
    const pad = Math.max(maxX - minX, maxY - minY) * 0.3;
    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;
  }
  return { minX, maxX, minY, maxY };
}

function aoiBoundsChanged(
  prev: SnapshotAoiBounds | undefined,
  next: SnapshotAoiBounds | undefined,
): boolean {
  if (!prev || !next) return prev !== next;
  return (
    Math.abs(prev.minX - next.minX) > CAMERA_AOI_BOUNDS_EPSILON ||
    Math.abs(prev.maxX - next.maxX) > CAMERA_AOI_BOUNDS_EPSILON ||
    Math.abs(prev.minY - next.minY) > CAMERA_AOI_BOUNDS_EPSILON ||
    Math.abs(prev.maxY - next.maxY) > CAMERA_AOI_BOUNDS_EPSILON
  );
}

export class GameServer {
  private physics: PhysicsEngine3D;
  private world: WorldState;
  private simulation: Simulation;
  private commandQueue: CommandQueue;

  private playerIds: PlayerId[];
  private backgroundMode: boolean;
  private terrainTileMap: TerrainTileMap;
  private terrainBuildabilityGrid: TerrainBuildabilityGrid;

  // Game loop
  private tickLoop = new ServerTickLoop();
  private tickRateHz: number;
  /** User's configured target. The setInterval rate (`tickRateHz`)
   *  may be auto-lowered below this when the host can't keep up;
   *  this field is the ceiling adaptation can claw back toward. */
  private userTickRateHz: number;
  /** Tick counter for the adaptive-rate check (separate from
   *  world.tick because the check fires every N ticks regardless of
   *  the world's own counter). */
  private _adaptCheckTicks = 0;
  private maxSnapshotIntervalMs: number; // Min ms between snapshots (0 = no cap, send every tick)
  private maxSnapshotsDisplay: number | 'none';
  private lastSnapshotTime: number = 0;
  private keyframeRatioDisplay: number | 'ALL' | 'NONE';

  // Background mode — allowed unit types for AI production & UI toggles.
  // Initial set comes from GameServerConfig.initialAllowedTypes when the
  // caller restored saved demo settings; otherwise defaults to "all".
  private backgroundAllowedTypes: Set<string>;

  // Snapshot listeners
  private snapshotListeners: SnapshotListenerEntry[] = [];
  private snapshotListenerId: number = 0;
  private gameOverListeners: GameOverCallback[] = [];
  private physicsSyncUnitIdsBuf: EntityId[] = [];
  private unitForceSystem: UnitForceSystem;
  private unitSuspensionSystem: UnitSuspensionSystem;

  // Game over tracking
  private isGameOver: boolean = false;

  // Tick rate tracking (EMA-based). Seeded in the constructor body.
  private tpsAvg: number = 0;
  private tpsLow: number = 0;
  private tpsInitialized: boolean = true;

  // Per-tick CPU cost tracking (ms). EMA-smoothed average and "hi" spike
  // value, same tier semantics as FRAME_TIMING_EMA. Computed from
  // performance.now() wrapping the tick() body. Exposed as a load-percent
  // via NetworkServerSnapshotMeta.cpu so both host and remote clients can
  // see how saturated the simulation is relative to the tick budget.
  //
  // Seeded in the constructor body.
  private tickMsAvg: number = 0;
  private tickMsHi: number = 0;
  private tickMsInitialized: boolean = true;

  // Delta snapshot keyframe ratio tracking
  private keyframeRatio: number = typeof DEFAULT_KEYFRAME_RATIO === 'number' ? DEFAULT_KEYFRAME_RATIO : DEFAULT_KEYFRAME_RATIO === 'ALL' ? 1 : 0;
  private startupReadyListenerKeys = new Set<string>();
  private startupGateOpen = false;

  // Territory capture system
  private captureSystem: CaptureSystem;
  private debugGridPublisher = new ServerDebugGridPublisher();
  private snapshotPublisher = new ServerSnapshotPublisher();

  // Public IP address (set by host component)
  private ipAddress: string = 'N/A';

  /** Async factory — kept for API compatibility with the pre-3D branch
   *  (host code still calls `GameServer.create(...)`) but there is no
   *  longer a WASM path to initialize: the 3D engine is pure TS. */
  static async create(config: GameServerConfig): Promise<GameServer> {
    return new GameServer(config);
  }

  constructor(config: GameServerConfig, physics?: PhysicsEngine3D) {
    this.tickRateHz = 60;
    this.userTickRateHz = 60;

    // Start visible host TPS/CPU EMAs at 0.0. TPS climbs as ticks are
    // measured; CPU load starts at 0% measured work.
    this.tpsAvg = 0;
    this.tpsLow = 0;
    this.tickMsAvg = 0;
    this.tickMsHi = 0;
    const maxSnaps = config.maxSnapshotsPerSec ?? 30;
    this.maxSnapshotIntervalMs = maxSnaps > 0 ? 1000 / maxSnaps : 0;
    this.maxSnapshotsDisplay = maxSnaps > 0 ? maxSnaps : 'none';
    this.keyframeRatioDisplay = DEFAULT_KEYFRAME_RATIO;

    // Bootstrap the entire world: terrain, physics, world state, sim,
    // capture grid, initial spawn. Ordering is tightly constrained
    // (terrain shape before deposits, deposits before terrain tile map,
    // tile map before physics ground lookup, etc.) and lives inside
    // ServerBootstrap so this constructor can stay focused on
    // instance-level concerns.
    const boot = ServerBootstrap.bootstrap(config, physics);
    this.physics = boot.physics;
    this.world = boot.world;
    this.simulation = boot.simulation;
    this.commandQueue = boot.commandQueue;
    this.captureSystem = boot.captureSystem;
    this.playerIds = boot.playerIds;
    this.backgroundMode = boot.backgroundMode;
    this.backgroundAllowedTypes = boot.backgroundAllowedTypes;
    this.terrainTileMap = boot.terrainTileMap;
    this.terrainBuildabilityGrid = boot.terrainBuildabilityGrid;

    this.unitForceSystem = new UnitForceSystem(this.world, this.simulation, this.physics);
    this.unitSuspensionSystem = new UnitSuspensionSystem(this.world, this.physics);

    // Setup simulation callbacks (need `this` references for physics
    // body cleanup and game-over fan-out, so they live here rather than
    // inside ServerBootstrap).
    this.setupSimulationCallbacks();
  }

  private setupSimulationCallbacks(): void {
    this.world.onEntityRemoving = (entity: Entity) => {
      const body = entity.body?.physicsBody;
      if (!body) return;
      this.physics.removeBody(body);
      entity.body = undefined;
    };

    // Handle unit deaths: remove entities. WorldState.onEntityRemoving
    // releases physics bodies for every removal path.
    this.simulation.onUnitDeath = (deadUnitIds: EntityId[], _deathContexts?: Map<EntityId, DeathContext>) => {
      for (const id of deadUnitIds) {
        this.world.removeEntity(id);
      }
    };

    // Handle building deaths: run destruction effects, then remove
    // entities. WorldState.onEntityRemoving releases physics bodies.
    this.simulation.onBuildingDeath = (deadBuildingIds: EntityId[]) => {
      const constructionSystem = this.simulation.getConstructionSystem();
      for (const id of deadBuildingIds) {
        const entity = this.world.getEntity(id);
        if (entity) {
          constructionSystem.onBuildingDestroyed(this.world, entity);
        }
        this.world.removeEntity(id);
      }
    };

    // Handle unit spawns: create physics bodies
    this.simulation.onUnitSpawn = (newUnits: Entity[]) => {
      for (const entity of newUnits) {
        createPhysicsBodyForUnit(this.world, this.physics, entity, {
          ignoreOverlappingBuildings: true,
        });
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
    this.lastSnapshotTime = 0; // Ensure first tick always emits a snapshot
    this.startupGateOpen = this.snapshotListeners.length === 0;
    if (!this.startupGateOpen) {
      this.emitStartupSnapshot(now);
    }
    this.startGameLoop();
  }

  private startGameLoop(): void {
    // Run simulation at configured tick rate
    // Snapshots are emitted at end of tick, gated by maxSnapshotIntervalMs
    this.tickLoop.start(this.tickRateHz, (tickNow, delta) => {
      // Measure how much CPU the tick body actually consumed, separately
      // from its *period* (which the TPS EMA tracks). Snapshot emission is
      // part of the same setInterval callback, so we include it — remote
      // clients care about the total load each tick imposes on the host.
      const workStart = performance.now();
      if (!this.areStartupClientsReady()) {
        const elapsed = tickNow - this.lastSnapshotTime;
        const interval = this.maxSnapshotIntervalMs;
        if (interval === 0 || elapsed >= interval) {
          this.emitStartupSnapshot(tickNow);
        }
        this.recordTickWork(performance.now() - workStart);
        return;
      }
      this.startupGateOpen = true;
      this.tick(delta);

      const elapsed = tickNow - this.lastSnapshotTime;
      const interval = this.maxSnapshotIntervalMs;
      if (interval === 0 || elapsed >= interval) {
        this.lastSnapshotTime = tickNow;
        this.emitSnapshot();
      }

      this.recordTickWork(performance.now() - workStart);

      // Adaptive rate: every ~64 ticks check whether we're chronically
      // over (halve effective rate) or chronically under (claw back
      // toward user's pick). This is the FLOOR that guarantees the
      // tick loop completes even when the host genuinely can't do
      // userTickRateHz worth of work per second.
      this.maybeAdaptTickRate();
    });
  }

  private emitStartupSnapshot(now: number): void {
    this.forceNextSnapshotKeyframe();
    this.lastSnapshotTime = now;
    this.emitSnapshot();
  }

  private areStartupClientsReady(): boolean {
    if (this.startupGateOpen) return true;
    if (this.snapshotListeners.length === 0) return true;
    for (const listener of this.snapshotListeners) {
      if (!this.startupReadyListenerKeys.has(listener.trackingKey)) return false;
    }
    return true;
  }

  private recordTickWork(workMs: number): void {
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
  }

  // Stop the game loop
  stop(): void {
    this.tickLoop.stop();
    this.snapshotListeners.length = 0;
    this.gameOverListeners.length = 0;

    // Clear simulation singletons so entity refs don't survive across sessions
    spatialGrid.clear();
    beamIndex.clear();
    economyManager.reset();

    // Reset simulation-owned state (ForceAccumulator, pending event buffers)
    this.simulation.resetSessionState();

    // Reset module-level reusable buffers that hold stale entity references
    resetProjectileBuffers();
    resetDamageBuffers();
    this.debugGridPublisher.clear();
    resetDeltaTracking();

    // Reset keyframe state for next session
    this.snapshotPublisher.reset();
    this.startupReadyListenerKeys.clear();
    this.startupGateOpen = false;
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

    // Push host signals into the SERVER LOD driver, then resolve
    // the effective tier ONCE for this tick. Every getSimDetailConfig()
    // call inside the upcoming sim systems hits the cached answer
    // instead of re-running the AUTO resolver per beam projectile /
    // per mirror turret.
    this.refreshSimQualitySignals();
    tickSimQuality();

    // Update simulation (calculates thrust velocities, runs combat, etc.)
    this.simulation.update(dtMs);

    // Apply thrust + external forces to physics bodies
    this.unitForceSystem.applyForces(dtSec);

    // Step physics (integrate + collisions)
    this.physics.step(dtSec);

    // Sync positions/velocities from physics to entities
    this.syncFromPhysics();

    // Update visible chassis-vs-locomotion springs after the physics
    // anchor has its authoritative velocity for this tick.
    this.unitSuspensionSystem.update(dtMs);

    // Update territory capture (uses spatial grid occupancy). Same
    // skip-and-scale-dt pattern as other low-detail systems at low
    // LOD: the time-integral of flag accumulation matches the
    // every-tick path; tile colours just step in coarser intervals.
    const captureStride = Math.max(1, getSimDetailConfig().captureStride | 0);
    if (captureStride === 1 || this.world.getTick() % captureStride === 0) {
      this.captureSystem.update(
        spatialGrid.getOccupiedCellsForCapture(),
        dtSec * captureStride,
      );
    }

    // Update mana income from territory. The capture system's
    // running totals are already in mana/sec, weighted per-tile by
    // the central-hotspot multiplier — same weighting the GRID
    // renderer uses for tile brightness, so what you see is what
    // you earn.
    const productionRates = this.captureSystem.getManaProductionRatesByPlayer();
    for (const playerId of this.playerIds) {
      economyManager.setManaTerritory(playerId, productionRates.get(playerId) ?? 0);
    }
  }

  // Sync positions and velocities from physics bodies to entities
  private syncFromPhysics(): void {
    const ids = this.physicsSyncUnitIdsBuf;
    ids.length = 0;
    this.physics.collectLastStepEntityIds(ids);
    for (let i = 0; i < ids.length; i++) {
      const entity = this.world.getEntity(ids[i]);
      if (!entity || !entity.body?.physicsBody || !entity.unit) continue;
      const body = entity.body.physicsBody;
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;
      entity.unit.velocityX = body.vx;
      entity.unit.velocityY = body.vy;
      entity.unit.velocityZ = body.vz;
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
    }
  }

  // Emit a snapshot to all listeners (driven by internal snapshot interval)
  private emitSnapshot(): void {
    this.snapshotPublisher.emit({
      world: this.world,
      simulation: this.simulation,
      captureSystem: this.captureSystem,
      debugGridPublisher: this.debugGridPublisher,
      listeners: this.snapshotListeners,
      terrainTileMap: this.terrainTileMap,
      terrainBuildabilityGrid: this.terrainBuildabilityGrid,
      tpsAvg: this.tpsAvg,
      tpsLow: this.tpsLow,
      tickRateHz: this.tickRateHz,
      userTickRateHz: this.userTickRateHz,
      maxSnapshotsDisplay: this.maxSnapshotsDisplay,
      keyframeRatioDisplay: this.keyframeRatioDisplay,
      keyframeRatio: this.keyframeRatio,
      ipAddress: this.ipAddress,
      backgroundMode: this.backgroundMode,
      backgroundAllowedTypes: this.backgroundAllowedTypes,
      tickMsAvg: this.tickMsAvg,
      tickMsHi: this.tickMsHi,
      tickMsInitialized: this.tickMsInitialized,
      simQuality: this.getSimQuality(),
      effectiveSimQuality: this.getEffectiveSimQuality(),
    });
  }

  // Receive a command from a client
  receiveCommand(command: Command, fromPlayerId?: PlayerId): void {
    // Intercept server config commands (don't need tick synchronization)
    switch (command.type) {
      case 'setSnapshotRate':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setSnapshotRate(command.rate);
        return;
      case 'setKeyframeRatio':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setKeyframeRatio(command.ratio);
        return;
      case 'setTickRate':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setTickRate(command.rate);
        return;
      case 'setTiltEmaMode':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        // updateUnitTilt reads its mode from the unitTilt module's
        // private state; flipping it from a command keeps host +
        // every client running with the same effective EMA the
        // moment the user clicks the bar button.
        setTiltEmaMode(command.mode);
        return;
      case 'setSendGridInfo':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setSendGridInfo(command.enabled);
        return;
      case 'setBackgroundUnitType':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setBackgroundUnitTypeEnabled(command.unitType, command.enabled);
        return;
      case 'setMaxTotalUnits':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.world.maxTotalUnits = command.maxTotalUnits;
        return;
      case 'setMirrorsEnabled':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setMirrorsEnabled(command.enabled);
        return;
      case 'setForceFieldsEnabled':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setForceFieldsEnabled(command.enabled);
        return;
      case 'setForceFieldReflectionMode':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setForceFieldReflectionMode(command.mode);
        return;
      case 'setSimQuality':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        this.setSimQuality(command.quality as ServerSimQuality);
        return;
      case 'setSimSignalStates':
        if (!this.canApplyServerControlCommand(fromPlayerId)) return;
        // Each field is optional; only the ones the user just clicked
        // will be present. setSimSignalStates validates internally.
        setSimSignalStates({
          tps: command.tps as ('off' | 'active' | 'solo' | undefined),
          cpu: command.cpu as ('off' | 'active' | 'solo' | undefined),
          units: command.units as ('off' | 'active' | 'solo' | undefined),
        });
        return;
      case 'setCameraAoi':
        this.setCameraAoi(command, fromPlayerId);
        return;
    }
    const authorizedCommand = this.authorizeGameplayCommand(command, fromPlayerId);
    if (authorizedCommand) this.commandQueue.enqueue(authorizedCommand);
  }

  private canApplyServerControlCommand(fromPlayerId?: PlayerId): boolean {
    if (fromPlayerId === undefined) return true;
    return fromPlayerId === this.playerIds[0];
  }

  private authorizeGameplayCommand(command: Command, fromPlayerId?: PlayerId): Command | null {
    if (fromPlayerId === undefined) return command;

    switch (command.type) {
      case 'select':
      case 'clearSelection':
        // Selection is client-local. Never let a network command mutate
        // authoritative world selection state for other players.
        return null;

      case 'ping':
        return this.authorizePingCommand(command, fromPlayerId);

      case 'move':
        return this.authorizeMoveCommand(command, fromPlayerId);

      case 'stop':
      case 'clearQueuedOrders':
      case 'removeLastQueuedOrder':
        return this.authorizeUnitListCommand(command, fromPlayerId);

      case 'wait':
        return this.authorizeUnitListCommand(command, fromPlayerId);

      case 'setJumpEnabled':
        return this.authorizeUnitListCommand(command, fromPlayerId);

      case 'setFireEnabled':
        return this.authorizeUnitListCommand(command, fromPlayerId);

      case 'attack':
      case 'attackGround':
      case 'attackArea':
        return this.authorizeUnitListCommand(command, fromPlayerId);

      case 'guard':
        if (!this.isOwnedEntity(command.targetId, fromPlayerId)) return null;
        return this.authorizeUnitListCommand(command, fromPlayerId);

      case 'startBuild':
        return this.isOwnedEntity(command.builderId, fromPlayerId) ? command : null;

      case 'queueUnit':
      case 'cancelQueueItem':
      case 'setRallyPoint':
      case 'setFactoryWaypoints':
        return this.isOwnedFactory(command.factoryId, fromPlayerId) ? command : null;

      case 'fireDGun':
        return this.isOwnedEntity(command.commanderId, fromPlayerId) ? command : null;

      case 'repair':
        if (!this.isOwnedEntity(command.commanderId, fromPlayerId)) return null;
        return this.isOwnedEntity(command.targetId, fromPlayerId) ? command : null;

      case 'repairArea':
        return this.isOwnedEntity(command.commanderId, fromPlayerId) ? command : null;

      case 'reclaim':
        return this.isOwnedEntity(command.commanderId, fromPlayerId) ? command : null;

      default:
        return null;
    }
  }

  private authorizePingCommand(command: PingCommand, playerId: PlayerId): PingCommand | null {
    if (!Number.isFinite(command.targetX) || !Number.isFinite(command.targetY)) return null;
    if (command.targetZ !== undefined && !Number.isFinite(command.targetZ)) return null;
    return { ...command, playerId };
  }

  private authorizeMoveCommand(command: MoveCommand, playerId: PlayerId): MoveCommand | null {
    const sourceIds = command.entityIds;
    if (sourceIds.length === 0) return null;

    const hasPerUnitTargets =
      command.individualTargets !== undefined &&
      command.individualTargets.length === sourceIds.length;

    const entityIds: EntityId[] = [];

    if (hasPerUnitTargets) {
      const individualTargets: MoveCommand['individualTargets'] = [];
      for (let i = 0; i < sourceIds.length; i++) {
        const id = sourceIds[i];
        if (!this.isOwnedUnit(id, playerId)) continue;
        entityIds.push(id);
        individualTargets.push(command.individualTargets![i]);
      }
      if (entityIds.length === 0) return null;
      return { ...command, entityIds, individualTargets };
    }

    for (let i = 0; i < sourceIds.length; i++) {
      const id = sourceIds[i];
      if (this.isOwnedUnit(id, playerId)) entityIds.push(id);
    }
    if (entityIds.length === 0) return null;
    return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
  }

  private authorizeUnitListCommand(
    command: SetJumpEnabledCommand | SetFireEnabledCommand | AttackCommand | AttackGroundCommand | AttackAreaCommand | GuardCommand | StopCommand | WaitCommand | ClearQueuedOrdersCommand | RemoveLastQueuedOrderCommand,
    playerId: PlayerId,
  ): SetJumpEnabledCommand | SetFireEnabledCommand | AttackCommand | AttackGroundCommand | AttackAreaCommand | GuardCommand | StopCommand | WaitCommand | ClearQueuedOrdersCommand | RemoveLastQueuedOrderCommand | null {
    const sourceIds = command.entityIds;
    if (sourceIds.length === 0) return null;

    const entityIds: EntityId[] = [];
    for (let i = 0; i < sourceIds.length; i++) {
      const id = sourceIds[i];
      if (this.isOwnedUnit(id, playerId)) entityIds.push(id);
    }
    if (entityIds.length === 0) return null;
    return entityIds.length === sourceIds.length ? command : { ...command, entityIds };
  }

  private isOwnedEntity(entityId: EntityId, playerId: PlayerId): boolean {
    return this.world.getEntity(entityId)?.ownership?.playerId === playerId;
  }

  private isOwnedUnit(entityId: EntityId, playerId: PlayerId): boolean {
    const entity = this.world.getEntity(entityId);
    return (
      entity?.type === 'unit' &&
      entity.unit !== undefined &&
      entity.ownership?.playerId === playerId
    );
  }

  private isOwnedFactory(entityId: EntityId, playerId: PlayerId): boolean {
    const entity = this.world.getEntity(entityId);
    return entity?.factory !== undefined && entity.ownership?.playerId === playerId;
  }

  private setCameraAoi(command: SetCameraAoiCommand, fromPlayerId?: PlayerId): void {
    const playerId = fromPlayerId ?? command.playerId;
    if (playerId === undefined) return;
    const next = boundsFromCameraAoiCommand(command);
    for (const listener of this.snapshotListeners) {
      if (listener.playerId !== playerId) continue;
      if (!aoiBoundsChanged(listener.aoi, next)) continue;
      listener.aoi = next;
      listener.forceKeyframe = true;
    }
  }

  private setMirrorsEnabled(enabled: boolean): void {
    if (this.world.mirrorsEnabled === enabled) return;
    this.world.mirrorsEnabled = enabled;
    if (enabled) return;
    for (const unit of this.world.getMirrorUnits()) {
      const combat = unit.combat;
      if (!combat) continue;
      const turrets = combat.turrets;
      for (let i = 0; i < turrets.length; i++) {
        const turret = turrets[i];
        if (!turret.config.passive) continue;
        turret.target = null;
        turret.state = 'idle';
        turret.angularVelocity = 0;
        turret.pitchVelocity = 0;
      }
      updateCombatActivityFlags(combat);
      this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
    }
  }

  private setForceFieldsEnabled(enabled: boolean): void {
    if (this.world.forceFieldsEnabled === enabled) return;
    this.world.forceFieldsEnabled = enabled;
    if (enabled) return;
    for (const unit of this.world.getForceFieldUnits()) {
      const combat = unit.combat;
      if (!combat) continue;
      const turrets = combat.turrets;
      for (const turret of turrets) {
        if (turret.config.shot?.type !== 'force') continue;
        turret.target = null;
        turret.state = 'idle';
        turret.angularVelocity = 0;
        turret.pitchVelocity = 0;
        if (turret.forceField) {
          turret.forceField.transition = 0;
          turret.forceField.range = 0;
        }
      }
      updateCombatActivityFlags(combat);
      this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
    }
  }

  private setForceFieldReflectionMode(mode: ForceFieldReflectionMode): void {
    if (!isForceFieldReflectionMode(mode)) return;
    if (this.world.forceFieldReflectionMode === mode) return;
    this.world.forceFieldReflectionMode = mode;
  }

  // Add a snapshot listener. Returns the trackingKey so callers can
  // later removeSnapshotListener — without that, listeners (and the
  // closures they capture) accumulate forever as clients connect /
  // disconnect or as connections are re-created across restarts.
  addSnapshotListener(callback: SnapshotCallback, playerId?: PlayerId): string {
    const trackingScope = playerId === undefined ? 'global' : `player-${playerId}`;
    const trackingKey = `${trackingScope}-${this.snapshotListenerId++}`;
    const deltaTrackingKey = playerId === undefined ? 'global-shared' : trackingKey;
    this.snapshotListeners.push({ callback, playerId, trackingKey, deltaTrackingKey });
    return trackingKey;
  }

  markSnapshotListenerReady(trackingKey: string): void {
    this.startupReadyListenerKeys.add(trackingKey);
  }

  markPlayerReady(playerId: PlayerId): void {
    for (const listener of this.snapshotListeners) {
      if (listener.playerId === playerId) {
        this.startupReadyListenerKeys.add(listener.trackingKey);
      }
    }
  }

  removeSnapshotListener(trackingKey: string): void {
    const idx = this.snapshotListeners.findIndex((l) => l.trackingKey === trackingKey);
    if (idx < 0) return;
    const [removed] = this.snapshotListeners.splice(idx, 1);
    this.startupReadyListenerKeys.delete(removed.trackingKey);
    if (!this.snapshotListeners.some((l) => l.deltaTrackingKey === removed.deltaTrackingKey)) {
      resetDeltaTrackingForKey(removed.deltaTrackingKey);
    }
  }

  // Add a game over listener. Returns the callback reference so callers
  // can remove it on cleanup; otherwise the listener pins the callback's
  // closure (and whatever component owns it) for the GameServer's life.
  addGameOverListener(callback: GameOverCallback): GameOverCallback {
    this.gameOverListeners.push(callback);
    return callback;
  }

  removeGameOverListener(callback: GameOverCallback): void {
    const idx = this.gameOverListeners.indexOf(callback);
    if (idx >= 0) this.gameOverListeners.splice(idx, 1);
  }

  // Change keyframe ratio (fraction of snapshots that are full keyframes)
  setKeyframeRatio(ratio: KeyframeRatio): void {
    this.keyframeRatioDisplay = ratio;
    this.keyframeRatio = ratio === 'ALL' ? 1 : ratio === 'NONE' ? 0 : ratio;
    this.snapshotPublisher.reset();
  }

  // Force the next emitted snapshot to be a self-contained keyframe.
  // Used after network battle start so clients that attach their
  // render scene slightly after the first server tick still receive
  // commander/unit creation data even when KEYFRAMES is set to NONE.
  forceNextSnapshotKeyframe(): void {
    this.snapshotPublisher.forceNextKeyframe();
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
    // TPS ratio = actual / target. Source is configurable in
    // serverSimLodConfig.ts so HOST SERVER TPS can use either steady
    // avg or pessimistic low without touching this runtime path.
    const tickStats = this.getTickStats();
    const tpsForLod = SERVER_SIM_LOD_EMA_SOURCE.tps === 'avg'
      ? tickStats.avgFps
      : tickStats.worstFps;
    setSimTpsRatio(tpsForLod / Math.max(1, this.tickRateHz));

    // CPU ratio = headroom = 1 − (cpu load / 100). The cpu fields
    // live as percent-of-tick-budget; they can exceed 100 when
    // we're falling behind. Source is configurable: 'avg' uses steady
    // load, while 'low' uses the spike/high load because that produces
    // lower pessimistic headroom. Clamp to [0, 1] for the LOD signal
    // so a momentary overshoot doesn't push the rank below MIN.
    const tickBudgetMs = 1000 / this.tickRateHz;
    const tickMsForLod = SERVER_SIM_LOD_EMA_SOURCE.cpu === 'avg'
      ? this.tickMsAvg
      : this.tickMsHi;
    const cpuLoad = this.tickMsInitialized
      ? Math.min(100, Math.max(0, (tickMsForLod / tickBudgetMs) * 100))
      : 0;
    setSimCpuRatio(1 - cpuLoad / 100);

    // Units fullness — same shape as the client side.
    setSimUnitCount(this.world.getUnits().length);
    setSimUnitCap(this.world.maxTotalUnits);
  }

  // Change simulation tick rate (restarts the game loop interval).
  // This is the user's configured target — adaptive rate may
  // lower the EFFECTIVE rate below this when the host is overloaded.
  setTickRate(hz: number): void {
    this.userTickRateHz = hz;
    this.tickRateHz = hz;
    if (this.tickLoop.isRunning()) {
      this.startGameLoop();
    }
  }

  /** Adaptive rate evaluation. Called every N ticks. When the EMA
   *  per-tick CPU load is sustained above 150% of the budget, halve
   *  the effective tick rate (down to 4 Hz floor). When it's
   *  sustained below 50%, double back up toward the user's pick.
   *
   *  Why not the LOD ladder alone: the LOD throttles cut targeting,
   *  beam tracing, force fields, capture — but every other system
   *  (physics step, projectile motion, collision) still runs every
   *  tick. If the host can only do 16 ticks of work per second,
   *  trying to fire 128 of them just buries the loop. Drop the
   *  target, complete every tick, sim runs slower in real time but
   *  the game stays responsive.
   *
   *  Floor at 4 Hz. Below that the snapshot rate is too low for
   *  remote clients to interpolate cleanly anyway, and the host
   *  has bigger problems. */
  private maybeAdaptTickRate(): void {
    this._adaptCheckTicks++;
    // Check every ~64 ticks. At a healthy 60 TPS that's ~1s, at a
    // crushed 6 TPS it's ~10s — both reasonable cadences for an
    // automated rate change.
    if (this._adaptCheckTicks < 64) return;
    this._adaptCheckTicks = 0;

    if (!this.tickMsInitialized) return;

    const tickBudgetMs = 1000 / this.tickRateHz;
    const loadAvg = this.tickMsAvg / tickBudgetMs;

    const FLOOR_HZ = 4;
    if (loadAvg > 1.5 && this.tickRateHz > FLOOR_HZ) {
      // Halve, snapping to int. Don't drop below floor.
      const next = Math.max(FLOOR_HZ, Math.floor(this.tickRateHz / 2));
      if (next !== this.tickRateHz) {
        this.tickRateHz = next;
        if (this.tickLoop.isRunning()) this.startGameLoop();
      }
    } else if (loadAvg < 0.5 && this.tickRateHz < this.userTickRateHz) {
      const next = Math.min(this.userTickRateHz, this.tickRateHz * 2);
      if (next !== this.tickRateHz) {
        this.tickRateHz = next;
        if (this.tickLoop.isRunning()) this.startGameLoop();
      }
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

  // Toggle spatial grid debug info in snapshots
  setSendGridInfo(enabled: boolean): void {
    this.debugGridPublisher.setEnabled(enabled);
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
      for (const factory of this.world.getFactoryBuildings()) {
        const factoryComp = factory.factory;
        if (!factoryComp) continue;
        let touched = false;
        if (factoryComp.currentShellId !== null) {
          const shell = this.world.getEntity(factoryComp.currentShellId);
          if (shell?.unit?.unitType === unitType) {
            factoryProductionSystem.cancelActiveShell(this.world, factory);
            touched = true;
          }
        }
        for (let i = factoryComp.buildQueue.length - 1; i >= 0; i--) {
          if (factoryComp.buildQueue[i] !== unitType) continue;
          factoryComp.buildQueue.splice(i, 1);
          touched = true;
        }
        if (!touched) continue;
        if (factoryComp.buildQueue.length === 0) {
          factoryComp.isProducing = false;
          factoryComp.currentBuildProgress = 0;
        }
        this.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      }
      // Kill all existing units of this type
      for (const unit of this.world.getUnits()) {
        if (unit.unit?.unitType === unitType) {
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
