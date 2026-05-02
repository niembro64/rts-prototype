// GameServer - Headless simulation server (no Phaser dependency)
// Owns WorldState, Simulation, PhysicsEngine3D, and runs the game loop via setInterval

import { WorldState } from '../sim/WorldState';
import { Simulation } from '../sim/Simulation';
import { CommandQueue, type Command } from '../sim/commands';
import { spawnInitialEntities, spawnInitialBases, spawnMetalExtractorsOnDeposits, FIRST_PLAYER_ANGLE } from '../sim/spawn';
import { CAPTURE_CONFIG } from '../../captureConfig';
import { serializeGameState, resetDeltaTracking, resetDeltaTrackingForKey, resetProtocolSeeded } from '../network/stateSerializer';
import type { SerializeGameStateOptions, SnapshotInterest } from '../network/stateSerializer';
import type { NetworkServerSnapshot, NetworkServerSnapshotGridCell } from '../network/NetworkTypes';
import type { SnapshotCallback, GameOverCallback } from './GameConnection';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { DeathContext } from '../sim/combat';
import { ENTITY_CHANGED_POS, ENTITY_CHANGED_ROT, ENTITY_CHANGED_TURRETS, ENTITY_CHANGED_VEL } from '../../types/network';
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
  getSimSignalStates,
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
  MANA_TILE_SIZE,
  MAX_TICK_DT_MS,
  SERVER_GRID_DEBUG_INTERVAL_MS,
  SERVER_GRID_DEBUG_MAX_OCCUPIED_CELLS,
  SERVER_GRID_DEBUG_MAX_SEARCH_CELLS,
  type KeyframeRatio,
} from '../../config';
import { SERVER_SIM_LOD_EMA_SOURCE } from '../../serverSimLodConfig';
import { spatialGrid } from '../sim/SpatialGrid';
import { resetProjectileBuffers } from '../sim/combat/projectileSystem';
import { resetDamageBuffers } from '../sim/damage/DamageSystem';
import { CaptureSystem } from '../sim/CaptureSystem';
import { projectHorizontalOntoSlope, setTerrainTeamCount, isWaterAt, setMetalDepositFlatZones, getTerrainVersion } from '../sim/Terrain';
import { generateMetalDeposits } from '../../metalDepositConfig';

export type { GameServerConfig } from '@/types/game';
import type { GameServerConfig } from '@/types/game';

const WATER_PROBE_DX = [
  1, 0.7071067811865476, 0, -0.7071067811865475,
  -1, -0.7071067811865477, 0, 0.7071067811865474,
];
const WATER_PROBE_DY = [
  0, 0.7071067811865475, 1, 0.7071067811865476,
  0, -0.7071067811865475, -1, -0.7071067811865477,
];
const WATER_ESCAPE_PROBE_MULTS = [1.5, 3, 6];
const MATTER_FORCE_SCALE = 150000;
const WATER_OUT_CACHE_CELL_SIZE = 25;
const WATER_OUT_CACHE_BUCKET_SCALE = 10;
// Hard cap on the probe cache. At cell-size 25 a 4k×4k map has ~25k
// possible cells; in practice probes cluster around shorelines, so a
// few thousand keys cover every spot units actually visit. Beyond
// that the cache is just a long-tail leak, so we drop it wholesale
// on overflow rather than carry per-entry LRU bookkeeping in the
// physics tick.
const WATER_OUT_CACHE_MAX_ENTRIES = 4096;
type WaterOutCacheEntry = { ok: boolean; x: number; y: number };
const SNAPSHOT_AOI_PADDING = 1200;
const GRID_DEBUG_KEY_BIAS = 10000;
const GRID_DEBUG_KEY_BASE = 20000;
const GRID_DEBUG_KEY_Y_MULT = GRID_DEBUG_KEY_BASE;
const GRID_DEBUG_KEY_X_MULT = GRID_DEBUG_KEY_BASE * GRID_DEBUG_KEY_BASE;

type SnapshotListenerEntry = {
  callback: SnapshotCallback;
  playerId?: PlayerId;
  trackingKey: string;
  deltaTrackingKey: string;
};

type SnapshotInterestPlan = {
  predicate?: SnapshotInterest;
  candidateEntityIds?: EntityId[];
};

type SnapshotInterestBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  hasOwnedEntity: boolean;
};

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
  private snapshotDirtyIdsBuf: EntityId[] = [];
  private snapshotDirtyFieldsBuf: number[] = [];
  private snapshotRemovedIdsBuf: EntityId[] = [];
  private snapshotInterestPlansByPlayer: Map<PlayerId, SnapshotInterestPlan> = new Map();
  private snapshotInterestBoundsByPlayer: Map<PlayerId, SnapshotInterestBounds> = new Map();
  private snapshotInterestCandidateIdsByPlayer: Map<PlayerId, EntityId[]> = new Map();
  private snapshotInterestPlayerIdsBuf: PlayerId[] = [];
  private snapshotInterestBuildingIdsBuf: EntityId[] = [];
  private snapshotInterestBuildingBoundsByPlayer: Map<PlayerId, SnapshotInterestBounds> = new Map();
  private snapshotInterestBuildingCacheVersion: number = -1;
  private gridDebugCellsCache: NetworkServerSnapshotGridCell[] = [];
  private gridDebugSearchCellsCache: NetworkServerSnapshotGridCell[] = [];
  private gridDebugCellPool: NetworkServerSnapshotGridCell[] = [];
  private gridDebugSearchCellMaskByKey = new Map<number, number>();
  private gridDebugLastSnapshotMs = -Infinity;
  private gridDebugForceRefresh = true;
  private gameOverListeners: GameOverCallback[] = [];
  private physicsForceUnitIdsBuf: EntityId[] = [];
  private physicsSyncUnitIdsBuf: EntityId[] = [];
  private physicsCandidateUnitIdsBuf: EntityId[] = [];
  private physicsActiveUnitIds = new Set<EntityId>();

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
    this.userTickRateHz = 60;
    const maxSnaps = config.maxSnapshotsPerSec ?? 30;
    this.maxSnapshotIntervalMs = maxSnaps > 0 ? 1000 / maxSnaps : 0;
    this.maxSnapshotsDisplay = maxSnaps > 0 ? maxSnaps : 'none';
    this.keyframeRatioDisplay = DEFAULT_KEYFRAME_RATIO;

    // Demo / lobby battle uses MAP_SETTINGS.demo (larger); real game
    // uses MAP_SETTINGS.game.
    const mapConfig = getMapSize(this.backgroundMode);
    const mapWidth = mapConfig.width;
    const mapHeight = mapConfig.height;

    // Tell the heightmap how many teams are playing so it can lay
    // down the radial team-separation ridges. Set BEFORE the
    // WorldState (which spawns commanders / bases) and the renderer
    // (which bakes terrain geometry once at construction) so every
    // downstream consumer reads the same surface.
    setTerrainTeamCount(this.playerIds.length);

    // Metal deposits — same set across all clients (deterministic from
    // map size + player count). Push their flat zones (with per-ring
    // height) to the heightmap BEFORE the physics ground lookup or any
    // sim/render code samples terrain, so every consumer sees the
    // raised pads on first read.
    const deposits = generateMetalDeposits(mapWidth, mapHeight, this.playerIds.length, config.terrainCenter);
    setMetalDepositFlatZones(
      deposits.map((d) => ({
        x: d.x,
        y: d.y,
        flatRadius: d.flatRadius,
        height: d.height,
        blendRadius: d.blendRadius,
      })),
    );

    // The physics engine is now fully 3D — same module for every path.
    this.physics = physics ?? new PhysicsEngine3D(mapWidth, mapHeight);
    this.world = new WorldState(42, mapWidth, mapHeight);
    this.world.metalDeposits = deposits;
    // Wire the heightmap into physics so ground contacts settle units
    // on top of their terrain cube tile AND project their velocity
    // onto the slope tangent each tick — keeps units glued to the
    // surface as they climb / descend instead of bobbing or
    // launching off slope transitions. Both lookups return flat-up
    // outside the ripple disc, so corner spawns stay flat.
    this.physics.setGroundLookup(
      (x, y) => this.world.getGroundZ(x, y),
      (x, y) => this.world.getCachedSurfaceNormal(x, y),
    );
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
    // Same ordering rule for the unit cap: the demo spawn now fills
    // `maxTotalUnits / numPlayers` slots per team, so the cap must
    // be set BEFORE spawnBackgroundUnitsStandalone runs (in the
    // playerIds branch below). Without this override, the world
    // boots at MAX_TOTAL_UNITS (4096) regardless of user storage,
    // the spawn fills to that, and only AFTER would `setMaxTotalUnits`
    // arrive from LobbyManager — producing the visible "4075/16"
    // mismatch where the spawn count and the displayed cap disagree.
    if (config.initialMaxTotalUnits !== undefined && config.initialMaxTotalUnits > 0) {
      this.world.maxTotalUnits = config.initialMaxTotalUnits;
    }

    // Setup simulation callbacks
    this.setupSimulationCallbacks();

    // Pre-paint the capture grid into per-team radial sectors. Same
    // angular layout the spawn circle and terrain dividers use, so
    // each team starts with the territory in front of their base.
    // Border tiles get area-weighted partial ownership (the centre
    // tile is naturally split among all teams). Tiles flagged dirty
    // here flow out in the next snapshot regardless of keyframe / delta.
    {
      // Tell the capture system about the map up front so its
      // per-tile mana-production weights (hotspot multiplier) are
      // available during update() AND for the initial radial paint
      // below. The renderer pulls the same weights so on-screen
      // brightness and income stay in lockstep.
      this.captureSystem.setMapSize(mapWidth, mapHeight, MANA_TILE_SIZE);
      this.captureSystem.initializeRadialOwnership(
        mapWidth, mapHeight, MANA_TILE_SIZE,
        this.playerIds, FIRST_PLAYER_ANGLE,
        CAPTURE_CONFIG.initialOwnershipHeight,
      );
    }

    // AI player configuration
    const aiPlayerIds = config.aiPlayerIds ?? (this.backgroundMode ? [...this.playerIds] : []);

    // Spawn initial entities
    if (aiPlayerIds.length > 0) {
      // AI game: full base with factories, solars, and commander per player
      const constructionSystem = this.simulation.getConstructionSystem();
      const entities = spawnInitialBases(this.world, constructionSystem, this.playerIds);
      if (this.backgroundMode) {
        entities.push(...spawnMetalExtractorsOnDeposits(this.world, constructionSystem, this.playerIds));
      }
      this.createPhysicsBodies(entities);
      this.simulation.setAiPlayerIds(aiPlayerIds);

      // Background mode: spawn a cluster of units near center for immediate combat
      if (this.backgroundMode) {
        spawnBackgroundUnitsStandalone(
          this.world, this.physics, true,
          constructionSystem.getGrid(),
          this.backgroundAllowedTypes,
        );
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
            `unit_${entity.id}`,
            entity.id,
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

      // Adaptive rate: every ~64 ticks check whether we're chronically
      // over (halve effective rate) or chronically under (claw back
      // toward user's pick). This is the FLOOR that guarantees the
      // tick loop completes even when the host genuinely can't do
      // userTickRateHz worth of work per second.
      this.maybeAdaptTickRate();
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
    this.applyForces();

    // Step physics (integrate + collisions)
    this.physics.step(dtSec);

    // Sync positions/velocities from physics to entities
    this.syncFromPhysics();

    // Update territory capture (uses spatial grid occupancy). Same
    // skip-and-scale-dt pattern as applyForceFieldDamage at low
    // LOD: the time-integral of flag accumulation matches the
    // every-tick path; tile colours just step in coarser intervals.
    const captureStride = Math.max(1, getSimDetailConfig().captureStride | 0);
    if (captureStride === 1 || this.world.getTick() % captureStride === 0) {
      this.captureSystem.update(
        spatialGrid.getOccupiedCellsForCapture(this.captureSystem.getCellSize()),
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

  // Apply thrust and external forces to physics bodies
  private applyForces(): void {
    const forceAccumulator = this.simulation.getForceAccumulator();
    const mw = this.world.mapWidth;
    const mh = this.world.mapHeight;

    this.collectPhysicsForceUnitIds();
    const activeIds = this.physicsForceUnitIdsBuf;
    for (let i = 0; i < activeIds.length; i++) {
      const entity = this.world.getEntity(activeIds[i]);
      if (!entity || !entity.body?.physicsBody || !entity.unit) continue;

      const body = entity.body.physicsBody;

      // Sync position from physics body (before force application, for
      // rotation calc). z tracks gravity + ground contact — units sit on
      // the ground at body.radius altitude; explosions or falls push them
      // up and gravity pulls them back.
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;

      // Action-system thrust target — a HORIZONTAL direction at the
      // unit's chosen `moveSpeed`. Sloped terrain gets the direction
      // projected onto the local surface tangent below so units climb
      // / descend along the actual ground instead of trying to push
      // straight through it. velocityX/Y/Z is authoritative physics,
      // not touched here.
      const dirX = entity.unit.thrustDirX ?? 0;
      const dirY = entity.unit.thrustDirY ?? 0;
      const dirMag = magnitude(dirX, dirY);

      // Sleeping units that aren't being asked to thrust short-circuit
      // BEFORE the accumulator probe — `hasForce` is a single Map.has
      // (no allocation) where `getFinalForce` would build a scratch
      // tuple. Skip the rotation update too: dirMag is already below
      // the threshold there.
      if (body.sleeping && dirMag <= 0.01 && !forceAccumulator.hasForce(entity.id)) {
        continue;
      }

      const externalForce = forceAccumulator.getFinalForce(entity.id);
      const externalFx = (externalForce?.fx ?? 0) / 3600;
      const externalFy = (externalForce?.fy ?? 0) / 3600;

      // Unit faces its movement direction (yaw only — chassis tilt
      // is a render concern; sim transform.rotation stays a 2D yaw).
      if (dirMag > 0.01) {
        const nextRotation = Math.atan2(dirY, dirX);
        if (nextRotation !== entity.transform.rotation) {
          entity.transform.rotation = nextRotation;
          this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_ROT);
        }
      }

      let thrustForceX = 0;
      let thrustForceY = 0;
      let thrustForceZ = 0;

      // Water as a WALL.
      //
      // Two-pronged behaviour, both built on `isWaterAt` against the
      // local heightmap (no clamp, no surface, just "is this position
      // submerged?"):
      //
      //   1. THRUST GATE on dry land: when the action system wants
      //      to push the body in a direction that would step into
      //      water, decompose the thrust into the local outward
      //      component (toward dry land) and the parallel component
      //      (along the shore). Zero the inward component, keep the
      //      parallel. The unit slides along the shore and physically
      //      cannot push past the boundary — exactly the behaviour
      //      you want from a wall.
      //
      //   2. ESCAPE FORCE in water: when the body has somehow ended
      //      up over water anyway (knockback impulse, spawn edge
      //      case, sub-tick collision push), apply a strong outward
      //      force so they're expelled within a couple of frames.
      //      3× the unit's normal thrust magnitude — water is a
      //      WALL, not a friendly current.
      //
      // The body's tilt (`getSurfaceNormal`) is already land-only
      // by construction (Terrain.ts excludes wet samples from the
      // gradient), so the chassis never inherits the water plane's
      // flat normal. Combined with the wall-push, water has no
      // "solid" aspect: nothing rests on it, units never tilt to
      // its surface, and they bounce off the boundary like it's a
      // building wall.
      const radius = body.radius || 10;
      const inWater = isWaterAt(body.x, body.y, mw, mh);

      if (inWater) {
        // ESCAPE FORCE — push toward dry land. Try expanding probe
        // radii so even a unit teleported deep into a lake gets a
        // valid outward direction.
        let hasOutDir = false;
        for (let i = 0; i < WATER_ESCAPE_PROBE_MULTS.length; i++) {
          hasOutDir = this.probeWaterOutward(
            body.x, body.y,
            radius * WATER_ESCAPE_PROBE_MULTS[i],
            mw, mh,
          );
          if (hasOutDir) break;
        }
        if (hasOutDir) {
          // 3× normal thrust strength — feels like a hard wall pushing
          // the unit out, not a gentle current.
          const wallPush = 3 * (entity.unit.moveSpeed * this.world.thrustMultiplier * entity.unit.mass) / MATTER_FORCE_SCALE;
          thrustForceX = this._waterOutX * wallPush;
          thrustForceY = this._waterOutY * wallPush;
          // No z thrust — water surface is flat, no slope to climb out of.
        }
      } else if (dirMag > 0) {
        let useDirX = dirX / dirMag;
        let useDirY = dirY / dirMag;

        // THRUST GATE — if a body-radius step ahead would put the
        // body in water, project the thrust onto the local "along
        // the shore" direction. The inward component (into water)
        // gets zeroed; the parallel component (sliding along the
        // boundary) is preserved.
        const probe = radius + 5;
        const aheadX = body.x + useDirX * probe;
        const aheadY = body.y + useDirY * probe;
        if (isWaterAt(aheadX, aheadY, mw, mh)) {
          if (this.probeWaterOutward(aheadX, aheadY, radius, mw, mh)) {
            // Decompose useDir against outward direction.
            // dotOut > 0 ⇒ thrust outward (away from water) — fine.
            // dotOut < 0 ⇒ thrust has inward component — remove it.
            const dotOut = useDirX * this._waterOutX + useDirY * this._waterOutY;
            if (dotOut < 0) {
              useDirX -= dotOut * this._waterOutX;
              useDirY -= dotOut * this._waterOutY;
              const m = Math.sqrt(useDirX * useDirX + useDirY * useDirY);
              if (m > 1e-3) {
                useDirX /= m;
                useDirY /= m;
              } else {
                // Thrust was purely inward — nothing parallel to the
                // shore left. Unit stops at the wall.
                useDirX = 0;
                useDirY = 0;
              }
            }
          }
        }

        if (useDirX !== 0 || useDirY !== 0) {
          const thrustMagnitude = (entity.unit.moveSpeed * this.world.thrustMultiplier * entity.unit.mass) / MATTER_FORCE_SCALE;
          // Project horizontal thrust onto the slope tangent so
          // hill-climbing produces the right z-aware force. Slope
          // normal is land-only (Terrain.getSurfaceNormal excludes
          // wet samples), so this never inherits the water plane's
          // tilt.
          const n = this.world.getCachedSurfaceNormal(body.x, body.y);
          const t = projectHorizontalOntoSlope(useDirX, useDirY, n);
          thrustForceX = t.x * thrustMagnitude;
          thrustForceY = t.y * thrustMagnitude;
          thrustForceZ = t.z * thrustMagnitude;
        }
      }

      let totalForceX = thrustForceX + externalFx;
      let totalForceY = thrustForceY + externalFy;
      let totalForceZ = thrustForceZ;

      if (
        !Number.isFinite(totalForceX) ||
        !Number.isFinite(totalForceY) ||
        !Number.isFinite(totalForceZ)
      ) {
        continue;
      }

      // Matter.js Verlet integration uses (F/m) * deltaTimeMs², our Euler engine uses (F/m) * dtSec.
      // Conversion: (ms)² / (sec)² = 1000² = 1e6. With friction-first ordering this is exact.
      // The Z thrust component lifts the unit along the slope when
      // climbing; gravity continues to pull through the integrator
      // and the ground-contact resolver clamps to the surface, so the
      // unit settles onto the rendered tile triangle each tick.
      this.physics.applyForce(body, totalForceX * 1e6, totalForceY * 1e6, totalForceZ * 1e6);
    }
  }

  private collectPhysicsForceUnitIds(): void {
    const ids = this.physicsForceUnitIdsBuf;
    const seen = this.physicsActiveUnitIds;
    ids.length = 0;
    seen.clear();

    const pushId = (id: EntityId): void => {
      if (seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };

    const movingUnits = this.simulation.getMovingUnits();
    for (let i = 0; i < movingUnits.length; i++) {
      pushId(movingUnits[i].id);
    }

    const candidates = this.physicsCandidateUnitIdsBuf;
    candidates.length = 0;
    this.simulation.getForceAccumulator().collectActiveEntityIds(candidates);
    for (let i = 0; i < candidates.length; i++) {
      pushId(candidates[i]);
    }

    candidates.length = 0;
    this.physics.collectAwakeEntityIds(candidates);
    for (let i = 0; i < candidates.length; i++) {
      pushId(candidates[i]);
    }
  }

  private _waterOutX = 0;
  private _waterOutY = 0;
  private waterOutCache = new Map<number, WaterOutCacheEntry>();
  private waterOutCacheTerrainVersion = -1;

  private waterOutCacheKey(x: number, y: number, probeR: number): number {
    const cx = Math.floor(x / WATER_OUT_CACHE_CELL_SIZE) + 32768;
    const cy = Math.floor(y / WATER_OUT_CACHE_CELL_SIZE) + 32768;
    const rb = Math.max(0, Math.min(255, Math.round(probeR / WATER_OUT_CACHE_BUCKET_SCALE)));
    return cx * 0x1000000 + cy * 0x100 + rb;
  }

  // Compute "outward from water" direction at (x, y). Samples 8
  // fixed directions at probeR and stores the normalized dry-sample
  // average into _waterOutX/Y. Returns false if every sample is wet.
  private probeWaterOutward(
    x: number,
    y: number,
    probeR: number,
    mapWidth: number,
    mapHeight: number,
  ): boolean {
    // Cache invariants: tied to terrain shape AND map dims AND a soft
    // size cap. Drop on any of those changing so a long match (terrain
    // edits, generator-driven flat zones, hour-long sessions probing
    // new shorelines) can't grow the map indefinitely.
    const tv = getTerrainVersion();
    if (tv !== this.waterOutCacheTerrainVersion || this.waterOutCache.size >= WATER_OUT_CACHE_MAX_ENTRIES) {
      this.waterOutCache.clear();
      this.waterOutCacheTerrainVersion = tv;
    }
    const key = this.waterOutCacheKey(x, y, probeR);
    const cached = this.waterOutCache.get(key);
    if (cached) {
      this._waterOutX = cached.x;
      this._waterOutY = cached.y;
      return cached.ok;
    }

    let ox = 0;
    let oy = 0;
    for (let i = 0; i < WATER_PROBE_DX.length; i++) {
      const dx = WATER_PROBE_DX[i];
      const dy = WATER_PROBE_DY[i];
      if (!isWaterAt(x + dx * probeR, y + dy * probeR, mapWidth, mapHeight)) {
        ox += dx;
        oy += dy;
      }
    }
    const m = Math.sqrt(ox * ox + oy * oy);
    if (m <= 0) {
      this._waterOutX = 0;
      this._waterOutY = 0;
      this.waterOutCache.set(key, { ok: false, x: 0, y: 0 });
      return false;
    }
    this._waterOutX = ox / m;
    this._waterOutY = oy / m;
    this.waterOutCache.set(key, { ok: true, x: this._waterOutX, y: this._waterOutY });
    return true;
  }

  // Sync positions and velocities from physics bodies to entities
  private syncFromPhysics(): void {
    const ids = this.physicsSyncUnitIdsBuf;
    ids.length = 0;
    this.physics.collectAwakeEntityIds(ids);
    for (let i = 0; i < ids.length; i++) {
      const entity = this.world.getEntity(ids[i]);
      if (!entity || !entity.body?.physicsBody || !entity.unit) continue;
      const body = entity.body.physicsBody;
      if (body.sleeping) continue;
      entity.transform.x = body.x;
      entity.transform.y = body.y;
      entity.transform.z = body.z;
      entity.unit.velocityX = body.vx;
      entity.unit.velocityY = body.vy;
      entity.unit.velocityZ = body.vz;
      this.world.markSnapshotDirty(entity.id, ENTITY_CHANGED_POS | ENTITY_CHANGED_VEL);
    }
  }

  // Create physics bodies for a list of entities
  // Buildings are created first so that units can set ignore-static for overlapping buildings.
  private createPhysicsBodies(entities: Entity[]): void {
    // Pass 1: create building bodies
    for (const entity of entities) {
      if (entity.type === 'building' && entity.building) {
        // baseZ matches WorldState.createBuilding's terrain lookup so
        // the static cuboid body sits where the entity transform says
        // it does — base on the local cube tile top.
        const baseZ = entity.transform.z - entity.building.depth / 2;
        const body = this.physics.createBuildingBody(
          entity.transform.x,
          entity.transform.y,
          entity.building.width,
          entity.building.height,
          entity.building.depth,
          baseZ,
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
          `unit_${entity.id}`,
          entity.id,
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

    this.snapshotDirtyIdsBuf.length = 0;
    this.snapshotDirtyFieldsBuf.length = 0;
    this.snapshotRemovedIdsBuf.length = 0;
    this.world.drainSnapshotDirtyEntities(this.snapshotDirtyIdsBuf, this.snapshotDirtyFieldsBuf);
    this.world.drainRemovedSnapshotEntityIds(this.snapshotRemovedIdsBuf);

    // Add capture tile data (delta-aware: only changed tiles on delta snapshots)
    const captureTiles = this.captureSystem.consumeSnapshot(isDelta);

    // CombatStats are end-of-game-style aggregates (units killed,
    // resources spent) that the UI reads at human rates. Shipping them
    // on every tick burned ~unit-count bytes/snapshot for fields that
    // never changed. Send on keyframes plus once per ~500ms in deltas.
    const combatStatsThrottleMs = 500;
    const nowMs = performance.now();
    let combatStats: ReturnType<Simulation['getCombatStatsSnapshot']> | undefined;
    if (!isDelta || nowMs - this.lastSentCombatStatsMs >= combatStatsThrottleMs) {
      combatStats = this.simulation.getCombatStatsSnapshot();
      this.lastSentCombatStatsMs = nowMs;
    }

    // Add server metadata to snapshot. Wind is visual/gameplay-visible and
    // intentionally changes continuously, so metadata must ride every
    // snapshot instead of only when the human-readable clock changes.
    let serverMeta: NetworkServerSnapshot['serverMeta'] | undefined;
    const currentTime = this.formatServerTime();
    {
      const tickStats = this.getTickStats();
      const wind = this.simulation.getWindState();
      // CPU load = tick work / tick budget, expressed as a percent. We
      // clamp nothing here — the UI can show >100 to mean "falling behind".
      const tickBudgetMs = 1000 / this.tickRateHz;
      const cpuAvg = this.tickMsInitialized
        ? (this.tickMsAvg / tickBudgetMs) * 100
        : 0;
      const cpuHi = this.tickMsInitialized
        ? (this.tickMsHi / tickBudgetMs) * 100
        : 0;
      serverMeta = {
        ticks: {
          avg: tickStats.avgFps,
          low: tickStats.worstFps,
          rate: this.tickRateHz,
          target: this.userTickRateHz,
        },
        snaps: { rate: this.maxSnapshotsDisplay, keyframes: this.keyframeRatioDisplay },
        server: { time: currentTime, ip: this.ipAddress },
        grid: this.sendGridInfo,
        units: {
          allowed: this.backgroundMode ? [...this.backgroundAllowedTypes] : undefined,
          max: this.world.maxTotalUnits,
          count: this.world.getUnits().length,
        },
        ffAccel: { units: this.world.ffAccelUnits, shots: this.world.ffAccelShots },
        mirrorsEnabled: this.world.mirrorsEnabled,
        forceFieldsEnabled: this.world.forceFieldsEnabled,
        cpu: { avg: cpuAvg, hi: cpuHi },
        simLod: {
          picked: this.getSimQuality(),
          effective: this.getEffectiveSimQuality(),
          signals: { ...getSimSignalStates() },
        },
        wind: {
          x: wind.x,
          y: wind.y,
          speed: wind.speed,
          angle: wind.angle,
        },
      };
    }

    // Spatial-grid debug data is diagnostic and expensive to build.
    // Emit it on a slower cadence; clients retain the last grid payload
    // between updates while normal gameplay snapshots keep flowing.
    const includeGridDebug = this.refreshGridDebugSnapshot(nowMs);
    const gridCells = includeGridDebug ? this.gridDebugCellsCache : undefined;
    const gridSearchCells = includeGridDebug ? this.gridDebugSearchCellsCache : undefined;
    const gridCellSize = includeGridDebug ? spatialGrid.getCellSize() : undefined;

    this.prepareSnapshotInterestPlans();

    const serializeForListener = (listener: SnapshotListenerEntry): NetworkServerSnapshot => {
      const interest = this.getSnapshotInterestPlan(listener.playerId);
      const serializeOptions: SerializeGameStateOptions = {
        trackingKey: listener.deltaTrackingKey,
        dirtyEntityIds: this.snapshotDirtyIdsBuf,
        dirtyEntityFields: this.snapshotDirtyFieldsBuf,
        removedEntityIds: this.snapshotRemovedIdsBuf,
        interest: interest.predicate,
        candidateEntityIds: interest.candidateEntityIds,
      };
      const state = serializeGameState(
        this.world,
        isDelta,
        gamePhase,
        winnerId,
        sprayTargets,
        audioEvents,
        projectileSpawns,
        projectileDespawns,
        projectileVelocityUpdates,
        gridCells,
        gridSearchCells,
        gridCellSize,
        serializeOptions,
      );

      // _snapshotBuf is reused across listeners and across ticks, so
      // any optional field that's only set on some paths must be
      // explicitly cleared on the others — otherwise the previous
      // listener / tick's data leaks into the next encode.
      state.capture = captureTiles.length > 0
        ? { tiles: captureTiles, cellSize: this.captureSystem.getCellSize() }
        : undefined;
      state.combatStats = combatStats;
      state.serverMeta = serverMeta;
      return state;
    };

    let sharedGlobalState: NetworkServerSnapshot | undefined;
    for (const listener of this.snapshotListeners) {
      if (listener.playerId !== undefined) continue;
      if (!sharedGlobalState) sharedGlobalState = serializeForListener(listener);
      listener.callback(sharedGlobalState);
    }

    for (const listener of this.snapshotListeners) {
      if (listener.playerId === undefined) continue;
      listener.callback(serializeForListener(listener));
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
      case 'setFfAccelUnits':
        this.world.ffAccelUnits = command.enabled;
        return;
      case 'setFfAccelShots':
        this.world.ffAccelShots = command.enabled;
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
      if (!unit.turrets) continue;
      for (let i = 0; i < unit.turrets.length; i++) {
        const turret = unit.turrets[i];
        if (!turret.config.passive) continue;
        turret.target = null;
        turret.state = 'idle';
        turret.angularVelocity = 0;
        turret.pitchVelocity = 0;
      }
      this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
    }
  }

  private setForceFieldsEnabled(enabled: boolean): void {
    if (this.world.forceFieldsEnabled === enabled) return;
    this.world.forceFieldsEnabled = enabled;
    if (enabled) return;
    for (const unit of this.world.getForceFieldUnits()) {
      if (!unit.turrets) continue;
      for (const turret of unit.turrets) {
        if (turret.config.shot.type !== 'force') continue;
        turret.target = null;
        turret.state = 'idle';
        turret.angularVelocity = 0;
        turret.pitchVelocity = 0;
        if (turret.forceField) {
          turret.forceField.transition = 0;
          turret.forceField.range = 0;
        }
      }
      this.world.markSnapshotDirty(unit.id, ENTITY_CHANGED_TURRETS);
    }
  }

  private getSnapshotInterestPlan(playerId?: PlayerId): SnapshotInterestPlan {
    if (playerId === undefined || this.backgroundMode) return {};
    return this.snapshotInterestPlansByPlayer.get(playerId) ?? {};
  }

  private getSnapshotInterestBounds(playerId: PlayerId): SnapshotInterestBounds {
    let bounds = this.snapshotInterestBoundsByPlayer.get(playerId);
    if (!bounds) {
      bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, hasOwnedEntity: false };
      this.snapshotInterestBoundsByPlayer.set(playerId, bounds);
    } else {
      bounds.minX = Infinity;
      bounds.minY = Infinity;
      bounds.maxX = -Infinity;
      bounds.maxY = -Infinity;
      bounds.hasOwnedEntity = false;
    }
    return bounds;
  }

  private getSnapshotInterestCandidates(playerId: PlayerId): EntityId[] {
    let candidates = this.snapshotInterestCandidateIdsByPlayer.get(playerId);
    if (!candidates) {
      candidates = [];
      this.snapshotInterestCandidateIdsByPlayer.set(playerId, candidates);
    } else {
      candidates.length = 0;
    }
    return candidates;
  }

  private expandSnapshotBounds(bounds: SnapshotInterestBounds, entity: Entity): void {
    bounds.hasOwnedEntity = true;
    const x = entity.transform.x;
    const y = entity.transform.y;
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
  }

  private mergeSnapshotBounds(dst: SnapshotInterestBounds, src: SnapshotInterestBounds): void {
    if (!src.hasOwnedEntity) return;
    dst.hasOwnedEntity = true;
    if (src.minX < dst.minX) dst.minX = src.minX;
    if (src.maxX > dst.maxX) dst.maxX = src.maxX;
    if (src.minY < dst.minY) dst.minY = src.minY;
    if (src.maxY > dst.maxY) dst.maxY = src.maxY;
  }

  private getSnapshotInterestBuildingBounds(playerId: PlayerId): SnapshotInterestBounds {
    let bounds = this.snapshotInterestBuildingBoundsByPlayer.get(playerId);
    if (!bounds) {
      bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, hasOwnedEntity: false };
      this.snapshotInterestBuildingBoundsByPlayer.set(playerId, bounds);
    }
    return bounds;
  }

  private prepareSnapshotInterestBuildingCache(): void {
    const buildingVersion = this.world.getBuildingVersion();
    if (buildingVersion === this.snapshotInterestBuildingCacheVersion) return;

    this.snapshotInterestBuildingIdsBuf.length = 0;
    this.snapshotInterestBuildingBoundsByPlayer.clear();
    for (const building of this.world.getBuildings()) {
      this.snapshotInterestBuildingIdsBuf.push(building.id);
      const playerId = building.ownership?.playerId;
      if (playerId !== undefined) {
        this.expandSnapshotBounds(this.getSnapshotInterestBuildingBounds(playerId), building);
      }
    }
    this.snapshotInterestBuildingCacheVersion = buildingVersion;
  }

  // Reusable scratch buffers for prepareSnapshotInterestPlans. Hoisted
  // out so the units×players inner loop reads from local arrays instead
  // of calling Map.get() per (unit, player) — at 1000 units × 4 players
  // that's 4k Map lookups per snapshot we used to pay every tick.
  private _aoiBoundsBuf: SnapshotInterestBounds[] = [];
  private _aoiCandidatesBuf: EntityId[][] = [];

  private prepareSnapshotInterestPlans(): void {
    this.snapshotInterestPlansByPlayer.clear();
    if (this.backgroundMode) return;

    const targetPlayerIds = this.snapshotInterestPlayerIdsBuf;
    targetPlayerIds.length = 0;
    for (const listener of this.snapshotListeners) {
      const playerId = listener.playerId;
      if (playerId === undefined || targetPlayerIds.includes(playerId)) continue;
      targetPlayerIds.push(playerId);
    }
    if (targetPlayerIds.length === 0) return;

    this.prepareSnapshotInterestBuildingCache();

    const playerCount = targetPlayerIds.length;
    const boundsBuf = this._aoiBoundsBuf;
    const candidatesBuf = this._aoiCandidatesBuf;
    boundsBuf.length = playerCount;
    candidatesBuf.length = playerCount;

    for (let i = 0; i < playerCount; i++) {
      const playerId = targetPlayerIds[i];
      const bounds = this.getSnapshotInterestBounds(playerId);
      const buildingBounds = this.snapshotInterestBuildingBoundsByPlayer.get(playerId);
      if (buildingBounds) this.mergeSnapshotBounds(bounds, buildingBounds);
      boundsBuf[i] = bounds;
      candidatesBuf[i] = this.getSnapshotInterestCandidates(playerId);
    }

    for (let i = 0; i < playerCount; i++) {
      const ownedUnits = this.world.getUnitsByPlayer(targetPlayerIds[i]);
      const bounds = boundsBuf[i];
      for (let j = 0; j < ownedUnits.length; j++) {
        this.expandSnapshotBounds(bounds, ownedUnits[j]);
      }
    }

    for (let i = 0; i < playerCount; i++) {
      const bounds = boundsBuf[i];
      if (!bounds.hasOwnedEntity) continue;
      bounds.minX -= SNAPSHOT_AOI_PADDING;
      bounds.minY -= SNAPSHOT_AOI_PADDING;
      bounds.maxX += SNAPSHOT_AOI_PADDING;
      bounds.maxY += SNAPSHOT_AOI_PADDING;
    }

    // Hot loop: with bounds + candidates pre-fetched into parallel
    // arrays, per-(unit, player) cost is 4 comparisons + 1 push, no
    // Map lookups. Single-player fast path skips the inner loop.
    if (playerCount === 1) {
      const playerId = targetPlayerIds[0];
      const bounds = boundsBuf[0];
      const candidates = candidatesBuf[0];
      const includeOthers = bounds.hasOwnedEntity;
      const ownedUnits = this.world.getUnitsByPlayer(playerId);
      for (let i = 0; i < ownedUnits.length; i++) {
        candidates.push(ownedUnits[i].id);
      }
      for (const unit of this.world.getUnits()) {
        const unitPlayerId = unit.ownership?.playerId;
        if (unitPlayerId === playerId) continue;
        if (!includeOthers) continue;
        const x = unit.transform.x;
        const y = unit.transform.y;
        if (x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY) {
          candidates.push(unit.id);
        }
      }
    } else {
      for (const unit of this.world.getUnits()) {
        const unitPlayerId = unit.ownership?.playerId;
        const x = unit.transform.x;
        const y = unit.transform.y;
        for (let i = 0; i < playerCount; i++) {
          const bounds = boundsBuf[i];
          if (unitPlayerId === targetPlayerIds[i]) {
            candidatesBuf[i].push(unit.id);
            continue;
          }
          if (!bounds.hasOwnedEntity) continue;
          if (x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY) {
            candidatesBuf[i].push(unit.id);
          }
        }
      }
    }

    const buildingIds = this.snapshotInterestBuildingIdsBuf;
    const buildingCount = buildingIds.length;
    for (let i = 0; i < playerCount; i++) {
      const candidates = candidatesBuf[i];
      for (let j = 0; j < buildingCount; j++) candidates.push(buildingIds[j]);
    }

    for (let i = 0; i < playerCount; i++) {
      const playerId = targetPlayerIds[i];
      const bounds = boundsBuf[i];
      const candidates = candidatesBuf[i];
      // Predicate captures the per-player bounds object directly so
      // the serializer's per-entity test costs 4 comparisons + 1
      // ownership read — no Map lookups in the inner loop.
      const predicate: SnapshotInterest = (entity) => {
        if (entity.type === 'building') return true;
        if (entity.ownership?.playerId === playerId) return true;
        if (!bounds.hasOwnedEntity) return false;
        const x = entity.transform.x;
        const y = entity.transform.y;
        return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
      };
      this.snapshotInterestPlansByPlayer.set(playerId, { predicate, candidateEntityIds: candidates });
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

  removeSnapshotListener(trackingKey: string): void {
    const idx = this.snapshotListeners.findIndex((l) => l.trackingKey === trackingKey);
    if (idx < 0) return;
    const [removed] = this.snapshotListeners.splice(idx, 1);
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
    this.snapshotCounter = 0;
  }

  // Force the next emitted snapshot to be a self-contained keyframe.
  // Used after network battle start so clients that attach their
  // render scene slightly after the first server tick still receive
  // commander/unit creation data even when KEYFRAMES is set to NONE.
  forceNextSnapshotKeyframe(): void {
    resetProtocolSeeded();
    this.isFirstSnapshot = true;
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
    if (this.gameLoopInterval) {
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
        if (this.gameLoopInterval) this.startGameLoop();
      }
    } else if (loadAvg < 0.5 && this.tickRateHz < this.userTickRateHz) {
      const next = Math.min(this.userTickRateHz, this.tickRateHz * 2);
      if (next !== this.tickRateHz) {
        this.tickRateHz = next;
        if (this.gameLoopInterval) this.startGameLoop();
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

  // Format current time as military format with timezone abbreviation (e.g. "14:34:05 MST")
  // Caches result so delta snapshots can skip sending unchanged time
  private lastServerTime: string = '';
  private lastServerTimeSec: number = -1;
  // Wall-clock of the last delta snapshot that included combatStats.
  // Stats only ship on keyframes or after this throttle elapses; the
  // value is in performance.now() ms so it's monotonic across timer
  // resets the host might do mid-game.
  private lastSentCombatStatsMs: number = 0;
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
    this.gridDebugForceRefresh = true;
    this.gridDebugLastSnapshotMs = -Infinity;
    if (!enabled) {
      this.releaseGridDebugCells(this.gridDebugCellsCache);
      this.releaseGridDebugCells(this.gridDebugSearchCellsCache);
    }
  }

  private refreshGridDebugSnapshot(nowMs: number): boolean {
    if (!this.sendGridInfo) return false;
    if (
      !this.gridDebugForceRefresh &&
      nowMs - this.gridDebugLastSnapshotMs < SERVER_GRID_DEBUG_INTERVAL_MS
    ) {
      return false;
    }
    this.gridDebugForceRefresh = false;
    this.gridDebugLastSnapshotMs = nowMs;
    this.computeOccupiedGridDebugCells();
    this.computeSearchCells();
    return true;
  }

  private acquireGridDebugCell(
    cx: number,
    cy: number,
    cz: number,
    playersMask: number,
  ): NetworkServerSnapshotGridCell {
    const cell = this.gridDebugCellPool.pop() ?? { cell: { x: 0, y: 0, z: 0 }, players: [] };
    cell.cell.x = cx;
    cell.cell.y = cy;
    cell.cell.z = cz;
    this.writeGridDebugPlayers(cell.players, playersMask);
    return cell;
  }

  private releaseGridDebugCells(cells: NetworkServerSnapshotGridCell[]): void {
    for (let i = 0; i < cells.length; i++) {
      cells[i].players.length = 0;
      this.gridDebugCellPool.push(cells[i]);
    }
    cells.length = 0;
  }

  private writeGridDebugPlayers(players: number[], playersMask: number): void {
    players.length = 0;
    for (let playerId = 1; playerId <= 31; playerId++) {
      if ((playersMask & (1 << (playerId - 1))) !== 0) players.push(playerId);
    }
  }

  private playerGridDebugMask(playerId: number | undefined): number {
    if (playerId === undefined || playerId < 1 || playerId > 31) return 0;
    return 1 << (playerId - 1);
  }

  private packGridDebugCellKey(cx: number, cy: number, cz: number): number {
    return (
      (cx + GRID_DEBUG_KEY_BIAS) * GRID_DEBUG_KEY_X_MULT +
      (cy + GRID_DEBUG_KEY_BIAS) * GRID_DEBUG_KEY_Y_MULT +
      (cz + GRID_DEBUG_KEY_BIAS)
    );
  }

  private unpackGridDebugCellKey(key: number): { cx: number; cy: number; cz: number } {
    const cz = (key % GRID_DEBUG_KEY_BASE) - GRID_DEBUG_KEY_BIAS;
    const cy = (Math.floor(key / GRID_DEBUG_KEY_Y_MULT) % GRID_DEBUG_KEY_BASE) - GRID_DEBUG_KEY_BIAS;
    const cx = Math.floor(key / GRID_DEBUG_KEY_X_MULT) - GRID_DEBUG_KEY_BIAS;
    return { cx, cy, cz };
  }

  private computeOccupiedGridDebugCells(): void {
    this.releaseGridDebugCells(this.gridDebugCellsCache);
    const occupiedCells = spatialGrid.getOccupiedCells();
    const count = Math.min(occupiedCells.length, SERVER_GRID_DEBUG_MAX_OCCUPIED_CELLS);
    for (let i = 0; i < count; i++) {
      const src = occupiedCells[i];
      let mask = 0;
      for (let p = 0; p < src.players.length; p++) {
        mask |= this.playerGridDebugMask(src.players[p]);
      }
      this.gridDebugCellsCache.push(
        this.acquireGridDebugCell(src.cell.x, src.cell.y, src.cell.z, mask),
      );
    }
  }

  // Compute per-team search cells: the bounding box of cells each unit's seeRange covers
  private computeSearchCells(): void {
    this.releaseGridDebugCells(this.gridDebugSearchCellsCache);
    this.gridDebugSearchCellMaskByKey.clear();
    const cellSize = spatialGrid.getCellSize();
    if (cellSize <= 0) return;

    for (const unit of this.world.getUnits()) {
      if (!unit.unit || unit.unit.hp <= 0 || !unit.turrets || unit.turrets.length === 0) continue;
      const playerId = unit.ownership?.playerId;
      if (playerId === undefined) continue;
      const playerMask = this.playerGridDebugMask(playerId);
      if (playerMask === 0) continue;

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
      const z = unit.transform.z;
      const halfCell = cellSize / 2;
      const minCx = Math.floor((x - maxSeeRange) / cellSize);
      const maxCx = Math.floor((x + maxSeeRange) / cellSize);
      const minCy = Math.floor((y - maxSeeRange) / cellSize);
      const maxCy = Math.floor((y + maxSeeRange) / cellSize);
      const minCz = Math.floor((z - maxSeeRange + halfCell) / cellSize);
      const maxCz = Math.floor((z + maxSeeRange + halfCell) / cellSize);

      for (let cz = minCz; cz <= maxCz; cz++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          for (let cx = minCx; cx <= maxCx; cx++) {
            const key = this.packGridDebugCellKey(cx, cy, cz);
            const previousMask = this.gridDebugSearchCellMaskByKey.get(key);
            if (previousMask === undefined) {
              if (this.gridDebugSearchCellMaskByKey.size >= SERVER_GRID_DEBUG_MAX_SEARCH_CELLS) {
                continue;
              }
              this.gridDebugSearchCellMaskByKey.set(key, playerMask);
            } else if ((previousMask & playerMask) === 0) {
              this.gridDebugSearchCellMaskByKey.set(key, previousMask | playerMask);
            }
          }
        }
      }
    }

    for (const [key, playersMask] of this.gridDebugSearchCellMaskByKey) {
      const { cx, cy, cz } = this.unpackGridDebugCellKey(key);
      this.gridDebugSearchCellsCache.push(
        this.acquireGridDebugCell(cx, cy, cz, playersMask),
      );
    }
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
