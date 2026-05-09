// GameServer - Headless simulation server (no Phaser dependency)
// Owns WorldState, Simulation, PhysicsEngine3D, and runs the game loop via setInterval

import type { WorldState } from '../sim/WorldState';
import type { Simulation } from '../sim/Simulation';
import type { CommandQueue, Command } from '../sim/commands';
import { resetDeltaTracking, resetDeltaTrackingForKey } from '../network/stateSerializer';
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

export type { GameServerConfig } from '@/types/game';
import type { GameServerConfig } from '@/types/game';

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
        const baseInterval = this.maxSnapshotIntervalMs;
        const effectiveInterval = baseInterval === 0
          ? 0
          : baseInterval * this.snapshotIntervalMultiplier();
        if (effectiveInterval === 0 || elapsed >= effectiveInterval) {
          this.emitStartupSnapshot(tickNow);
        }
        this.recordTickWork(performance.now() - workStart);
        return;
      }
      this.startupGateOpen = true;
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
      case 'setTiltEmaMode':
        // updateUnitTilt reads its mode from the unitTilt module's
        // private state; flipping it from a command keeps host +
        // every client running with the same effective EMA the
        // moment the user clicks the bar button.
        setTiltEmaMode(command.mode);
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
      case 'setMirrorsEnabled':
        this.setMirrorsEnabled(command.enabled);
        return;
      case 'setForceFieldsEnabled':
        this.setForceFieldsEnabled(command.enabled);
        return;
      case 'setSimQuality':
        this.setSimQuality(command.quality as ServerSimQuality);
        return;
      case 'setSimSignalStates':
        // Each field is optional; only the ones the user just clicked
        // will be present. setSimSignalStates validates internally.
        setSimSignalStates({
          tps: command.tps as ('off' | 'active' | 'solo' | undefined),
          cpu: command.cpu as ('off' | 'active' | 'solo' | undefined),
          units: command.units as ('off' | 'active' | 'solo' | undefined),
        });
        return;
    }
    this.commandQueue.enqueue(command);
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

  /** Multiplier on the snapshot interval, driven by unit count AND
   *  CPU load — whichever forces the bigger multiplier wins. The
   *  intent: at high unit counts the per-snapshot serialization plus
   *  network bytes dominate the tick; at high CPU load the snapshot
   *  emission itself fights the sim for the budget, so stretch the
   *  interval the same way. Returns 1.0 in calm conditions; both
   *  signals only kick in past their thresholds.
   *
   *  Unit-count thresholds line up with the UNITS auto-LOD ladder
   *  (2k/4k/8k/12k). CPU thresholds line up with "have we missed
   *  the budget for a sustained period" — 100% load is the budget,
   *  150%+ is in trouble. */
  private snapshotIntervalMultiplier(): number {
    const n = this.world.getUnits().length;
    let unitMul = 1;
    if (n >= 12000) unitMul = 4;
    else if (n >= 8000) unitMul = 3;
    else if (n >= 4000) unitMul = 2;
    else if (n >= 2000) unitMul = 1.5;

    // tickMsHi is the EMA-spike CPU load. At >100% the host is
    // already over budget; throttle snapshots to free up CPU.
    const tickBudgetMs = 1000 / this.tickRateHz;
    const cpuPct = this.tickMsInitialized
      ? (this.tickMsHi / tickBudgetMs) * 100
      : 0;
    let cpuMul = 1;
    if (cpuPct >= 250) cpuMul = 4;
    else if (cpuPct >= 175) cpuMul = 3;
    else if (cpuPct >= 125) cpuMul = 2;
    else if (cpuPct >= 100) cpuMul = 1.5;

    return Math.max(unitMul, cpuMul);
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
