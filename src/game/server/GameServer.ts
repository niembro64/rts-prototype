// GameServer - Headless simulation server.
// Owns WorldState, Simulation, PhysicsEngine3D, and runs the game loop via setInterval.

import type { WorldState } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type { CommandQueue, Command } from '../sim/commands';
import { resetDeltaTracking } from '../network/stateSerializer';
import { trimEntitySnapshotPool } from '../network/stateSerializerEntities';
import type { SnapshotCallback, GameOverCallback } from './GameConnection';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { DeathContext } from '../sim/combat';
import { ENTITY_CHANGED_FACTORY, ENTITY_CHANGED_POS, ENTITY_CHANGED_TURRETS, ENTITY_CHANGED_VEL } from '../../types/network';
import { economyManager } from '../sim/economy';
import { beamIndex } from '../sim/BeamIndex';
import type { PhysicsEngine3D } from './PhysicsEngine3D';
import {
  DEFAULT_KEYFRAME_RATIO,
  EMA_CONFIG,
  type KeyframeRatio,
  type SnapshotRate,
} from '../../config';
import {
  HOST_SNAPSHOT_RATE_DEFAULT,
  normalizeSnapshotRate,
  snapshotRateIntervalMs,
} from '../../serverBarConfig';
import { spatialGrid } from '../sim/SpatialGrid';
import { getSimWasm } from '../sim-wasm/init';
import { setUnitGroundNormalEmaMode } from '../sim/unitGroundNormal';
import { resetProjectileBuffers } from '../sim/combat/projectileSystem';
import { resetDisabledTurretJsOnlyFields } from '../sim/combat/combatActivity';
import { resetDamageBuffers } from '../sim/damage/DamageSystem';
import { trimBuildingActiveStateBuffers } from '../sim/buildingActiveState';
import { trimEnergyDistributionBuffers } from '../sim/energyDistribution';
import { factoryProductionSystem } from '../sim/factoryProduction';
import { isBuildInProgress } from '../sim/buildableHelpers';
import type { TerrainBuildabilityGrid, TerrainTileMap } from '@/types/terrain';
import { initSimWasm } from '../sim-wasm/init';
import { ServerBootstrap } from './ServerBootstrap';
import { ServerDebugGridPublisher } from './ServerDebugGridPublisher';
import { ServerTickLoop } from './ServerTickLoop';
import { ServerSnapshotPublisher } from './ServerSnapshotPublisher';
import {
  ServerSnapshotListenerRegistry,
  type SnapshotListenerOptions,
} from './ServerSnapshotListenerRegistry';
import type { BootstrappedServerWorld } from './ServerBootstrap';
import { UnitForceSystem } from './UnitForceSystem';
import { FactoryConstructionTurretSystem } from './FactoryConstructionTurretSystem';
import { computeHostEffectiveMass, createPhysicsBodyForUnit } from './unitPhysicsBody';
import {
  isShieldReflectionMode,
  type ShieldReflectionMode,
} from '../../types/shotTypes';
import {
  type CommandAuthority,
} from './commandAuthority';
import { sanitizeCommand } from './commandSanitizer';
import {
  authorizeGameServerGameplayCommand,
  canApplyGameServerControlCommand,
} from './ServerCommandAuthorizer';
import {
  acquireSimSlot,
  releaseSimSlot,
  transferSimSlot,
} from '../lifecycle/sessionSingleton';
import { ReplayRecorder, type BudgetReplayFile } from './ReplayRecorder';

export type { GameServerConfig } from '@/types/game';
import type { GameServerConfig } from '@/types/game';

export type GameServerStartupProgress = (
  progress: number,
  phase: string | undefined,
) => void | Promise<void>;

export type GameServerCreateOptions = {
  onProgress: GameServerStartupProgress | undefined;
};

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
  private maxSnapshotIntervalMs: number; // Min ms between snapshots (0 = no cap, send every tick)
  private maxSnapshotsDisplay: SnapshotRate;
  private lastSnapshotTime: number = 0;
  private keyframeRatioDisplay: KeyframeRatio;

  // Background mode — allowed unit blueprints for AI production & UI toggles.
  // Initial set comes from GameServerConfig.initialAllowedUnitBlueprintIds when the
  // caller restored saved demo settings; otherwise defaults to "all".
  private backgroundAllowedUnitBlueprintIds: Set<string>;

  // Snapshot listeners
  private snapshotListeners = new ServerSnapshotListenerRegistry();
  private gameOverListeners: GameOverCallback[] = [];
  private physicsSyncUnitIdsBuf: EntityId[] = [];
  private unitForceSystem: UnitForceSystem;
  private factoryConstructionTurretSystem: FactoryConstructionTurretSystem;
  private stopped = false;

  // Game over tracking
  private isGameOver: boolean = false;

  // Tick rate tracking (EMA-based). Starts empty; the first real tick
  // period seeds both lanes so the low lane does not report startup
  // zero as a real server-cadence sample.
  private tpsAvg: number = 0;
  private tpsLow: number = 0;
  private tpsInitialized: boolean = false;

  // Per-tick CPU cost tracking (ms). EMA-smoothed average and "hi" spike
  // value, same tier semantics as FRAME_TIMING_EMA. Computed from
  // performance.now() wrapping the tick() body. Exposed as a load-percent
  // via NetworkServerSnapshotMeta.cpu so both host and remote clients can
  // see how saturated the simulation is relative to the tick budget.
  //
  // Seeded in the constructor body.
  private tickMsAvg: number = 0;
  private tickMsHi: number = 0;
  private tickMsInitialized: boolean = false;

  // Delta snapshot keyframe ratio tracking
  private keyframeRatio: number = typeof DEFAULT_KEYFRAME_RATIO === 'number' ? DEFAULT_KEYFRAME_RATIO : DEFAULT_KEYFRAME_RATIO === 'ALL' ? 1 : 0;
  private startupGateOpen = false;

  private debugGridPublisher = new ServerDebugGridPublisher();
  private snapshotPublisher = new ServerSnapshotPublisher();
  private replayRecorder!: ReplayRecorder;

  // Public IP address (set by host component)
  private ipAddress: string = 'N/A';

  /** Async factory. Awaits the bespoke Rust/WASM physics module
   *  (rts-sim-wasm) before constructing the engine — Body3D state
   *  lives in WASM linear memory via the SoA pool (Phase 3d), so
   *  the pool MUST be initialised before any PhysicsEngine3D body
   *  is created. main.ts kicks initSimWasm() in parallel with the
   *  Vue mount, so by the time host code calls create() the
   *  promise is usually already resolved (no actual wait). */
  static async create(
    config: GameServerConfig,
    options: GameServerCreateOptions = { onProgress: undefined },
  ): Promise<GameServer> {
    const slotOwner = { constructor: { name: 'GameServer.create' } };
    acquireSimSlot(slotOwner);
    const report = async (progress: number, phase: string | undefined) => {
      if (options.onProgress === undefined) return;
      const clamped = Number.isFinite(progress)
        ? Math.max(0, Math.min(1, progress))
        : 0;
      await options.onProgress(clamped, phase);
    };

    try {
      await report(0, 'Loading simulation core');
      await initSimWasm();
      await report(0.08, 'Simulation core ready');

      const boot = options.onProgress
        ? await ServerBootstrap.bootstrapAsync(config, undefined, (progress, phase) =>
            report(0.08 + progress * 0.84, phase),
          )
        : ServerBootstrap.bootstrap(config);
      await report(0.94, 'Finalizing server');

      const server = new GameServer(config, undefined, boot, slotOwner);
      await report(1, 'Server ready');
      return server;
    } catch (err) {
      releaseSimSlot(slotOwner);
      throw err;
    }
  }

  constructor(
    config: GameServerConfig,
    physics: PhysicsEngine3D | undefined = undefined,
    bootstrapped: BootstrappedServerWorld | undefined = undefined,
    reservedSimSlotOwner: object | undefined = undefined,
  ) {
    if (reservedSimSlotOwner !== undefined) {
      transferSimSlot(reservedSimSlotOwner, this);
    } else {
      acquireSimSlot(this);
    }

    this.tickRateHz = 60;

    // Start visible host TPS at 0.0 until the first real tick period
    // seeds the EMA. CPU load starts at 0% measured work.
    this.tpsAvg = 0;
    this.tpsLow = 0;
    this.tpsInitialized = false;
    this.tickMsAvg = 0;
    this.tickMsHi = 0;
    const maxSnaps = normalizeSnapshotRate(
      config.maxSnapshotsPerSec ?? HOST_SNAPSHOT_RATE_DEFAULT,
    );
    this.maxSnapshotIntervalMs = snapshotRateIntervalMs(maxSnaps);
    this.maxSnapshotsDisplay = maxSnaps;
    this.keyframeRatioDisplay = DEFAULT_KEYFRAME_RATIO;

    // Bootstrap the entire world: terrain, physics, world state, sim,
    // and initial spawn. Ordering is tightly constrained
    // (terrain shape before deposits, deposits before terrain tile map,
    // tile map before physics ground lookup, etc.) and lives inside
    // ServerBootstrap so this constructor can stay focused on
    // instance-level concerns.
    let boot: BootstrappedServerWorld | undefined;
    try {
      boot = bootstrapped ?? ServerBootstrap.bootstrap(config, physics);
      this.physics = boot.physics;
      this.world = boot.world;
      this.simulation = boot.simulation;
      this.commandQueue = boot.commandQueue;
      this.playerIds = boot.playerIds;
      this.backgroundMode = boot.backgroundMode;
      this.backgroundAllowedUnitBlueprintIds = boot.backgroundAllowedUnitBlueprintIds;
      this.terrainTileMap = boot.terrainTileMap;
      this.terrainBuildabilityGrid = boot.terrainBuildabilityGrid;
      this.replayRecorder = new ReplayRecorder(config, this.playerIds);

      this.unitForceSystem = new UnitForceSystem(this.world, this.simulation, this.physics);
      this.factoryConstructionTurretSystem = new FactoryConstructionTurretSystem(this.world);

      // Setup simulation callbacks (need `this` references for physics
      // body cleanup and game-over fan-out, so they live here rather than
      // inside ServerBootstrap).
      this.setupSimulationCallbacks();
    } catch (err) {
      boot?.physics.dispose();
      releaseSimSlot(this);
      throw err;
    }
  }

  private setupSimulationCallbacks(): void {
    this.world.onEntityRemoving = (entity: Entity) => {
      const bodySlot = entity.body;
      if (bodySlot === null) return;
      const body = bodySlot.physicsBody;
      this.physics.removeBody(body);
      entity.body = null;
    };
    // Recompute dynamic body mass when host-authored body mass changes.
    // Mounted turrets are inseparable emitters, so turret lifetime no
    // longer changes host mass.
    this.world.onHostMassChanged = (host: Entity) => {
      const bodyRef = host.body;
      if (bodyRef === null || host.unit === null) return;
      this.physics.setBodyEffectiveMass(bodyRef.physicsBody, computeHostEffectiveMass(host));
    };

    // Handle unit deaths: remove entities. WorldState.onEntityRemoving
    // releases physics bodies for every removal path.
    this.simulation.onUnitDeath = (deadUnitIds: EntityId[], _deathContexts: Map<EntityId, DeathContext> | null) => {
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
        const isFactoryShell = entity.unit !== null && isBuildInProgress(entity.buildable);
        createPhysicsBodyForUnit(this.world, this.physics, entity, {
          ignoreOverlappingBuildings: !isFactoryShell,
          overlapPadding: undefined,
        });
      }
    };

    this.simulation.onBuildingSpawn = (newBuildings: Entity[]) => {
      for (const entity of newBuildings) {
        if (entity.building === null || entity.body !== null) continue;
        const baseZ = entity.transform.z - entity.building.depth / 2;
        const body = this.physics.createBuildingBody(
          entity.transform.x,
          entity.transform.y,
          entity.building.width,
          entity.building.height,
          entity.building.depth,
          baseZ,
          entity.building.supportSurface,
          `building_${entity.id}`,
          entity.id,
        );
        entity.body = { physicsBody: body };
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
    if (this.stopped) return;
    acquireSimSlot(this);
    const now = performance.now();
    this.lastSnapshotTime = 0; // Ensure first tick always emits a snapshot
    this.startupGateOpen = this.snapshotListeners.count === 0;
    if (!this.startupGateOpen) {
      this.emitStartupSnapshot(now);
    }
    this.startGameLoop();
  }

  private startGameLoop(): void {
    // Run simulation at configured tick rate. Snapshot interval is normally
    // uncapped, which emits once at the end of every server tick.
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
        return false;
      }
      this.startupGateOpen = true;
      if (this.simulation.getGamePhase() !== 'paused') {
        this.tick(delta);
      }

      const elapsed = tickNow - this.lastSnapshotTime;
      const interval = this.maxSnapshotIntervalMs;
      if (interval === 0 || elapsed >= interval) {
        this.lastSnapshotTime = tickNow;
        this.emitSnapshot();
      }

      this.recordTickWork(performance.now() - workStart);
      return true;
    }, {
      onFrame: ({ elapsedMs, stepsRun }) => {
        this.recordTickCadence(elapsedMs, stepsRun);
      },
    });
  }

  private emitStartupSnapshot(now: number): void {
    this.forceNextSnapshotKeyframe();
    this.lastSnapshotTime = now;
    this.emitSnapshot();
  }

  private areStartupClientsReady(): boolean {
    if (this.startupGateOpen) return true;
    return this.snapshotListeners.areStartupListenersReady();
  }

  isStartupGateOpen(): boolean {
    return this.startupGateOpen;
  }

  private recordTickCadence(elapsedMs: number, stepsRun: number): void {
    if (stepsRun <= 0 || elapsedMs <= 0) return;

    const tps = Math.min(this.tickRateHz, (stepsRun * 1000) / elapsedMs);
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
    if (this.stopped) return;
    this.stopped = true;
    releaseSimSlot(this);
    this.tickLoop.stop();
    this.releaseSnapshotListeners();
    this.gameOverListeners.length = 0;
    this.commandQueue.clear();
    this.physicsSyncUnitIdsBuf.length = 0;

    // Clear simulation singletons so entity refs don't survive across sessions
    spatialGrid.clear();
    beamIndex.clear();
    economyManager.reset();

    // Reset simulation-owned state (ForceAccumulator, pending event buffers)
    this.simulation.resetSessionState();
    this.factoryConstructionTurretSystem.reset();

    // Reset module-level reusable buffers that hold stale entity references
    resetProjectileBuffers();
    resetDamageBuffers();
    trimBuildingActiveStateBuffers();
    trimEnergyDistributionBuffers();
    trimEntitySnapshotPool();
    const sim = getSimWasm();
    if (sim !== undefined) {
      sim.combatTargeting.clear();
      sim.shieldSurfacePool.clear();
      sim.projectilePool.clear();
    }
    this.debugGridPublisher.clear();
    resetDeltaTracking();

    // Reset keyframe state for next session
    this.snapshotPublisher.clear();
    this.snapshotListeners.clearStartupReady();
    this.startupGateOpen = false;
    this.detachSimulationCallbacks();

    // Release the WASM-side per-engine static-cuboid broadphase
    // handle so its HashMap + visit-stamp Vec come back to Rust's
    // allocator and the handle slot can be reused by a future
    // GameServer.create() (avoids unbounded growth across
    // load/teardown cycles in dev hot-reload).
    this.physics.dispose();
  }

  private releaseSnapshotListeners(): void {
    this.snapshotListeners.releaseAll();
  }

  private detachSimulationCallbacks(): void {
    this.world.onEntityRemoving = null;
    this.world.onHostMassChanged = null;
    this.simulation.onUnitDeath = null;
    this.simulation.onUnitSpawn = null;
    this.simulation.onBuildingSpawn = null;
    this.simulation.onBuildingDeath = null;
    this.simulation.onSimEvent = null;
    this.simulation.onGameOver = null;
  }

  // Main simulation tick — fixed timestep driven by ServerTickLoop's accumulator.
  private tick(delta: number): void {
    const dtMs = delta;
    const dtSec = dtMs / 1000;

    // Update simulation (calculates thrust velocities, runs combat, etc.)
    this.simulation.update(dtMs);

    // Fabricator bases stay static. Only the construction turret receives
    // server-authored yaw/velocity while it is actively funding a shell.
    this.factoryConstructionTurretSystem.update(dtSec);

    // Apply thrust + external forces to physics bodies
    this.unitForceSystem.applyForces(dtSec);

    // Step physics (integrate + collisions)
    this.physics.step(dtSec);

    // Sync positions/velocities from physics to entities
    this.syncFromPhysics();

  }

  // Sync positions and velocities from physics bodies to entities
  private syncFromPhysics(): void {
    const ids = this.physicsSyncUnitIdsBuf;
    ids.length = 0;
    this.physics.collectLastStepEntityIds(ids);
    for (let i = 0; i < ids.length; i++) {
      const entity = this.world.getEntity(ids[i]);
      if (entity === undefined) continue;
      const bodySlot = entity.body;
      if (bodySlot === null) continue;
      const body = bodySlot.physicsBody;
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;
      if (entity.unit !== null) {
        entity.unit.velocityX = body.vx;
        entity.unit.velocityY = body.vy;
        entity.unit.velocityZ = body.vz;
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
      } else if (entity.building !== null) {
        spatialGrid.addBuilding(entity);
        this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS);
      }
    }
  }

  // Emit a snapshot to all listeners (driven by internal snapshot interval)
  private emitSnapshot(): void {
    this.snapshotPublisher.emit({
      world: this.world,
      simulation: this.simulation,
      debugGridPublisher: this.debugGridPublisher,
      listeners: this.snapshotListeners.entries,
      terrainTileMap: this.terrainTileMap,
      terrainBuildabilityGrid: this.terrainBuildabilityGrid,
      tpsAvg: this.tpsAvg,
      tpsLow: this.tpsLow,
      tickRateHz: this.tickRateHz,
      maxSnapshotsDisplay: this.maxSnapshotsDisplay,
      keyframeRatioDisplay: this.keyframeRatioDisplay,
      keyframeRatio: this.keyframeRatio,
      ipAddress: this.ipAddress,
      backgroundMode: this.backgroundMode,
      backgroundAllowedUnitBlueprintIds: this.backgroundAllowedUnitBlueprintIds,
      tickMsAvg: this.tickMsAvg,
      tickMsHi: this.tickMsHi,
      tickMsInitialized: this.tickMsInitialized,
    });
  }

  // Receive a command from a client
  receiveCommand(command: Command, authority: CommandAuthority): void {
    const sanitizedCommand = sanitizeCommand(command, this.world);
    if (!sanitizedCommand) return;
    const recordAcceptedCommand = (acceptedCommand: Command): void => {
      this.replayRecorder.recordAcceptedCommand(
        acceptedCommand,
        authority,
        this.world.getTick(),
        performance.now(),
      );
    };

    // Intercept server config commands (don't need tick synchronization)
    const canApplyServerControl = canApplyGameServerControlCommand(authority, this.playerIds[0]);
    switch (sanitizedCommand.type) {
      case 'setSnapshotRate':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setSnapshotRate(sanitizedCommand.rate);
        return;
      case 'setKeyframeRatio':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setKeyframeRatio(sanitizedCommand.ratio);
        return;
      case 'setTickRate':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setTickRate(sanitizedCommand.rate);
        return;
      case 'setPaused':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setPaused(sanitizedCommand.paused);
        return;
      case 'setUnitGroundNormalEmaMode':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        // updateUnitGroundNormal reads its mode from the unitGroundNormal module's
        // private state; flipping it from a command keeps host +
        // every client running with the same effective EMA the
        // moment the user clicks the bar button.
        setUnitGroundNormalEmaMode(sanitizedCommand.mode);
        return;
      case 'setSendGridInfo':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setSendGridInfo(sanitizedCommand.enabled);
        return;
      case 'setBackgroundUnitBlueprintEnabled':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setBackgroundUnitBlueprintEnabled(sanitizedCommand.unitBlueprintId, sanitizedCommand.enabled);
        return;
      case 'setMaxTotalUnits':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.world.maxTotalUnits = sanitizedCommand.maxTotalUnits;
        return;
      case 'setTurretShieldPanelsEnabled':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setTurretShieldPanelsEnabled(sanitizedCommand.enabled);
        return;
      case 'setTurretShieldSpheresEnabled':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setTurretShieldSpheresEnabled(sanitizedCommand.enabled);
        return;
      case 'setShieldsObstructSight':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setShieldsObstructSight(sanitizedCommand.enabled);
        return;
      case 'setShieldReflectionMode':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setShieldReflectionMode(sanitizedCommand.mode);
        return;
      case 'setFogOfWarEnabled':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setFogOfWarEnabled(sanitizedCommand.enabled);
        return;
      case 'setConverterTax':
        if (!canApplyServerControl) return;
        recordAcceptedCommand(sanitizedCommand);
        this.setConverterTax(sanitizedCommand.tax);
        return;
    }
    const authorizedCommand = authorizeGameServerGameplayCommand(
      this.world,
      sanitizedCommand,
      authority,
    );
    if (authorizedCommand) {
      recordAcceptedCommand(authorizedCommand);
      this.commandQueue.enqueue(authorizedCommand);
    }
  }

  exportReplay(): BudgetReplayFile {
    return this.replayRecorder.export(this.world.getTick());
  }

  getReplayCommandCount(): number {
    return this.replayRecorder.getCommandCount();
  }

  private setTurretShieldPanelsEnabled(enabled: boolean): void {
    if (this.world.turretShieldPanelsEnabled === enabled) return;
    this.world.turretShieldPanelsEnabled = enabled;
    if (enabled) return;
    for (const unit of this.world.getShieldPanelUnits()) {
      const combat = unit.combat;
      if (!combat) continue;
      const turrets = combat.turrets;
      for (let i = 0; i < turrets.length; i++) {
        const turret = turrets[i];
        if (!turret.config.passive) continue;
        turret.target = null;
        turret.state = 'idle';
        resetDisabledTurretJsOnlyFields(turret);
      }
      this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
    }
  }

  private setTurretShieldSpheresEnabled(enabled: boolean): void {
    if (this.world.turretShieldSpheresEnabled === enabled) return;
    this.world.turretShieldSpheresEnabled = enabled;
    if (enabled) return;
    for (const unit of this.world.getShieldUnits()) {
      const combat = unit.combat;
      if (!combat) continue;
      const turrets = combat.turrets;
      for (const turret of turrets) {
        const shot = turret.config.shot;
        if (shot === null || shot.type !== 'shield') continue;
        turret.target = null;
        turret.state = 'idle';
        resetDisabledTurretJsOnlyFields(turret);
      }
      this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
    }
  }

  private setShieldReflectionMode(mode: ShieldReflectionMode): void {
    if (!isShieldReflectionMode(mode)) return;
    if (this.world.shieldReflectionMode === mode) return;
    this.world.shieldReflectionMode = mode;
  }

  private setShieldsObstructSight(enabled: boolean): void {
    if (this.world.shieldsObstructSight === enabled) return;
    this.world.shieldsObstructSight = enabled;
    // No cleanup needed: per-tick target re-validation will drop any
    // existing lock whose line crosses an active shield on the next
    // pass, and turning the rule off just stops the check from running.
  }

  private setFogOfWarEnabled(enabled: boolean): void {
    if (this.world.fogOfWarEnabled === enabled) return;
    this.world.fogOfWarEnabled = enabled;
    this.forceNextSnapshotKeyframe();
  }

  private setConverterTax(tax: number): void {
    if (this.world.converterTax === tax) return;
    this.world.converterTax = tax;
  }

  // Add a snapshot listener. Returns the trackingKey so callers can
  // later removeSnapshotListener — without that, listeners (and the
  // closures they capture) accumulate forever as clients connect /
  // disconnect or as connections are re-created across restarts.
  addSnapshotListener(
    callback: SnapshotCallback,
    playerId: PlayerId | undefined = undefined,
    options: SnapshotListenerOptions = {},
  ): string {
    return this.snapshotListeners.add(callback, playerId, options);
  }

  markSnapshotListenerReady(trackingKey: string): void {
    this.snapshotListeners.markReady(trackingKey);
  }

  markPlayerReady(playerId: PlayerId): void {
    this.snapshotListeners.markPlayerReady(playerId);
  }

  removeSnapshotListener(trackingKey: string): void {
    this.snapshotListeners.remove(trackingKey);
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

  // Force the next emitted snapshot to be a dynamic keyframe. Static
  // terrain/buildability is listener-gated; pass includeStatic for an
  // explicit map resync.
  // Used after network battle start so clients that attach their
  // render scene slightly after the first server tick still receive
  // commander/unit creation data even when KEYFRAMES is set to NONE.
  forceNextSnapshotKeyframe(includeStatic = false): void {
    this.snapshotPublisher.forceNextKeyframe(includeStatic);
  }

  // Change snapshot cadence. Invalid/legacy rates normalize to the
  // configured HOST SERVER DIFFSNAP default.
  setSnapshotRate(rate: SnapshotRate): void {
    const normalizedRate = normalizeSnapshotRate(rate);
    this.maxSnapshotsDisplay = normalizedRate;
    this.maxSnapshotIntervalMs = snapshotRateIntervalMs(normalizedRate);
  }

  // Change simulation tick rate (restarts the game loop interval).
  setTickRate(hz: number): void {
    if (this.tickRateHz === hz) return;
    this.tickRateHz = hz;
    if (this.tickLoop.isRunning()) {
      this.startGameLoop();
    }
  }

  setPaused(paused: boolean): void {
    this.simulation.setPaused(paused);
    this.forceNextSnapshotKeyframe();
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

  // Background demo: toggle unit blueprint for AI production
  setBackgroundUnitBlueprintEnabled(unitBlueprintId: string, enabled: boolean): void {
    if (enabled) {
      this.backgroundAllowedUnitBlueprintIds.add(unitBlueprintId);
    } else {
      this.backgroundAllowedUnitBlueprintIds.delete(unitBlueprintId);
      for (const factory of this.world.getFactoryBuildings()) {
        const factoryComp = factory.factory;
        if (!factoryComp) continue;
        let touched = false;
        if (factoryComp.currentShellId !== null) {
          const shell = this.world.getEntity(factoryComp.currentShellId);
          if (shell !== undefined && shell.unit !== null && shell.unit.unitBlueprintId === unitBlueprintId) {
            factoryProductionSystem.cancelActiveShell(this.world, factory);
            touched = true;
          }
        }
        if (factoryComp.selectedUnitBlueprintId === unitBlueprintId) {
          factoryComp.selectedUnitBlueprintId = null;
          factoryComp.repeatProduction = true;
          touched = true;
        }
        const queueLengthBefore = factoryComp.productionQueue.length;
        if (queueLengthBefore > 0) {
          factoryComp.productionQueue = factoryComp.productionQueue.filter(id => id !== unitBlueprintId);
          if (factoryComp.productionQueue.length !== queueLengthBefore) {
            touched = true;
          }
        }
        if (factoryComp.selectedUnitBlueprintId === null && factoryComp.productionQueue.length > 0) {
          factoryComp.selectedUnitBlueprintId = factoryComp.productionQueue.shift() ?? null;
          factoryComp.repeatProduction = factoryComp.selectedUnitBlueprintId === null;
          touched = true;
        }
        if (!touched) continue;
        factoryComp.isProducing = false;
        factoryComp.currentBuildProgress = 0;
        this.world.markSnapshotDirty(factory.id, ENTITY_CHANGED_FACTORY);
      }
      // Kill all existing units of this type
      for (const unit of this.world.getUnits()) {
        if (unit.unit !== null && unit.unit.unitBlueprintId === unitBlueprintId) {
          this.world.removeEntity(unit.id);
        }
      }
    }
    // Update AI production filter
    this.simulation.setAiAllowedUnitBlueprintIds(this.backgroundAllowedUnitBlueprintIds);
  }

  getBackgroundAllowedUnitBlueprintIds(): ReadonlySet<string> {
    return this.backgroundAllowedUnitBlueprintIds;
  }
}
