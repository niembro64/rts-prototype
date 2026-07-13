import { LAND_CELL_SIZE } from '../../config';
import { ARCHITECTURE_CONFIG } from '../../architectureConfig';
import { getFogClouds, setFogClouds } from '../../clientBarConfig';
import type { GameServerConfig } from '../../types/game';
import type { EntityId, PlayerId } from '../../types/sim';
import { createGame, destroyGame, type GameInstance } from '../createGame';
import { ClientViewState } from '../network/ClientViewState';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import {
  copySnapshotEntityDtoRowBreakdown,
  createSnapshotEntityDtoRowBreakdown,
  getSnapshotMaterializationMetadata,
  SNAPSHOT_MATERIALIZATION_STAGES,
  type SnapshotEntityDtoRowBreakdown,
  type SnapshotMaterializationKind,
  type SnapshotMaterializationMetadata,
  type SnapshotMaterializationStage,
} from '../network/snapshotMaterializationMetadata';
import { getSnapshotWireBytes } from '../network/snapshotWireMetadata';
import { LocalGameConnection } from '../server/LocalGameConnection';
import { GameServer } from '../server/GameServer';
import type { ServerSimulationStepPhaseTimings } from '../server/ServerSimulationCore';
import type { SimulationUpdatePhaseTimings } from '../sim/Simulation';
import type { SimulationCombatPhaseTimings } from '../sim/SimulationCombatController';
import { SNAPSHOT_ENCODE_INSTRUMENTATION } from '../SnapshotEncodeInstrumentation';
import { getSimWasm } from '../sim-wasm/init';
import {
  WASM_BOUNDARY_INSTRUMENTATION,
  type WasmBoundaryInstrumentationReport,
} from './WasmBoundaryInstrumentation';

type NumericSummary = {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
};

type SnapshotTrafficCounters = {
  readonly total: number;
  readonly rich: number;
  readonly delta: number;
  readonly entityDelta: number;
  readonly projectileDelta: number;
};

type SnapshotTrafficMeasuredRates = SnapshotTrafficCounters & {
  readonly measuredSeconds: number;
};

type CombatTargetingProfileReport = {
  readonly scheduleSources: number;
  readonly scheduleProcessed: number;
  readonly scheduleSkipped: number;
  readonly autoTicks: number;
  readonly reacquireDue: number;
  readonly spatialQueries: number;
  readonly candidateCells: number;
  readonly candidateSlotsVisited: number;
  readonly candidatesCollected: number;
  readonly chooseCalls: number;
  readonly chooseCandidateTests: number;
  readonly gateCalls: number;
  readonly gatePasses: number;
};

const SIM_STEP_PHASE_KEYS = [
  'commandQueueMs',
  'repairBeforeMs',
  'simulationUpdateMs',
  'factoryConstructionTurretMs',
  'unitForcesMs',
  'physicsStepMs',
  'repairAfterMs',
  'syncFromPhysicsMs',
  'projectileLaunchFinalizeMs',
  'totalMs',
] as const satisfies readonly (keyof ServerSimulationStepPhaseTimings)[];

const SIM_UPDATE_PHASE_KEYS = [
  'framePrepMs',
  'commandsMs',
  'deathPrepassMs',
  'buildingWindEconomyMs',
  'unitGroundNormalMs',
  'idleBuilderAutoRepairMs',
  'energyDistributionMs',
  'constructionLifecycleMs',
  'factoryProductionMs',
  'commanderAbilitiesMs',
  'transportActionsMs',
  'unitMovementMs',
  'spatialGridMs',
  'combatMs',
  'deadCleanupMs',
  'forceFinalizeMs',
  'gameOverTickMs',
  'totalMs',
] as const satisfies readonly (keyof SimulationUpdatePhaseTimings)[];

const SIM_COMBAT_PHASE_KEYS = [
  'resetPlannerMs',
  'stampTargetingMs',
  'targetingFiringMs',
  'laserSoundsMs',
  'turretRotationMs',
  'shieldStateMs',
  'shieldSurfaceStampMs',
  'shieldSoundsMs',
  'fireTurretsMs',
  'projectileSpawnEventsMs',
  'turretDirtyMs',
  'updateProjectilesMs',
  'projectilePackedPrepMs',
  'projectilePackedIntegrateMs',
  'projectilePackedScatterMs',
  'projectileTravelingPackMs',
  'projectileHomingGuidanceMs',
  'projectileTravelingIntegrateMs',
  'projectileTravelingScatterMs',
  'projectileLineProjectilesMs',
  'projectileLineBeamPathMs',
  'projectileLineBeamFusedMs',
  'projectileLineBeamBodyMs',
  'projectileLineBeamReflectorMs',
  'projectileLineBeamGroundMs',
  'projectileLineBeamProjectileMs',
  'projectileEventCullMs',
  'projectileSpatialRefreshMs',
  'projectileCollisionsMs',
  'collisionSetupMs',
  'collisionLoopMs',
  'collisionHitboxSweepMs',
  'collisionBeamDamageMs',
  'collisionDgunDamageMs',
  'collisionTerminalPlanMs',
  'collisionSplashDamageMs',
  'collisionKilledProjectileDetonationMs',
  'collisionSubmunitionSpawnMs',
  'collisionFinalRemovalMs',
  'collisionProjectileEventsMs',
  'deathExplosionMs',
  'collisionRemovalMs',
  'totalMs',
] as const satisfies readonly (keyof SimulationCombatPhaseTimings)[];

type SimStepPhaseTimingReport = {
  -readonly [K in keyof ServerSimulationStepPhaseTimings]: NumericSummary;
};

type SimStepPhaseTimingAccumulator = {
  -readonly [K in keyof ServerSimulationStepPhaseTimings]: number[];
};

type SimUpdatePhaseTimingReport = {
  -readonly [K in keyof SimulationUpdatePhaseTimings]: NumericSummary;
};

type SimUpdatePhaseTimingAccumulator = {
  -readonly [K in keyof SimulationUpdatePhaseTimings]: number[];
};

type SimCombatPhaseTimingReport = {
  -readonly [K in keyof SimulationCombatPhaseTimings]: NumericSummary;
};

type SimCombatPhaseTimingAccumulator = {
  -readonly [K in keyof SimulationCombatPhaseTimings]: number[];
};

export type PerformanceBottleneckHarnessOptions = {
  readonly unitCap?: number;
  readonly ticks?: number;
  readonly warmupTicks?: number;
  readonly seconds?: number;
  readonly warmupSeconds?: number;
  readonly snapshotEveryTicks?: number;
  readonly mapCells?: number;
  readonly width?: number;
  readonly height?: number;
  /** Map-center eye distance for the full-stack render pass. Zero keeps
   *  the scene's normal battle framing. */
  readonly cameraDistance?: number;
  readonly fogClouds?: boolean;
  readonly selectAllUnits?: boolean;
  /** Spawn a noncombat background roster and disable AI production so high
   *  unit-cap runs can isolate renderer/LOD scale from combat pressure. */
  readonly peaceful?: boolean;
  /** Pause the server before full-stack measurement. Startup still builds and
   *  snapshots the world; the measured pass then isolates static rendering. */
  readonly renderOnly?: boolean;
};

export type PerformanceBottleneckHarnessSuiteOptions =
  PerformanceBottleneckHarnessOptions & {
    readonly unitCaps?: readonly number[];
  };

export type PerformanceBottleneckHarnessReport = {
  readonly schema: 'budget-annihilation.performance-bottleneck-harness.v1';
  readonly options: Required<PerformanceBottleneckHarnessOptions>;
  readonly environment: {
    readonly userAgent: string;
    readonly devicePixelRatio: number;
    readonly fixedStepHz: number;
    readonly fixedStepMs: number;
    readonly frameBudgetMs60: number;
    readonly richSnapshotTargetHz: number;
    readonly sparseEntityMotionSnapshotTargetHz: number;
    readonly projectileDeltaSnapshotCeilingHz: number;
  };
  readonly simOnly: SimOnlyReport;
  readonly simSnapshot: SimSnapshotReport;
  readonly fullStack: FullStackReport;
  readonly diagnosis: BottleneckDiagnosis;
};

export type PerformanceBottleneckHarnessSuiteReport = {
  readonly schema: 'budget-annihilation.performance-bottleneck-suite.v1';
  readonly unitCaps: readonly number[];
  readonly reports: readonly PerformanceBottleneckHarnessReport[];
  readonly summary: {
    readonly scenarios: number;
    readonly worstSimFixedStepUtilPctP95: number;
    readonly worstFrameMsP95: number;
    readonly worstSnapshotMainThreadMsPerSecond: number;
    readonly totalWasmBoundaryMs: number;
    readonly maxJsHeapUsedBytes: number | null;
    readonly maxWasmMemoryBytes: number | null;
  };
};

type SimOnlyReport = {
  readonly units: number;
  readonly buildings: number;
  readonly projectiles: number;
  readonly measuredTicks: number;
  readonly wallMs: number;
  readonly stepMs: NumericSummary;
  readonly simCeilingTpsP95: number;
  readonly fixedStepUtilPctP95: number;
  readonly stepPhaseMs: SimStepPhaseTimingReport;
  readonly simulationUpdatePhaseMs: SimUpdatePhaseTimingReport;
  readonly simulationCombatPhaseMs: SimCombatPhaseTimingReport;
  readonly memory: MemoryReport;
  readonly wasmBoundary: WasmBoundaryInstrumentationReport;
  readonly combatTargetingProfile: CombatTargetingProfileReport;
};

type SimSnapshotReport = {
  readonly units: number;
  readonly buildings: number;
  readonly projectiles: number;
  readonly measuredTicks: number;
  readonly snapshots: number;
  readonly stepMs: NumericSummary;
  readonly snapshotTotalMs: NumericSummary;
  readonly snapshotApplyMs: NumericSummary;
  readonly snapshotBytes: NumericSummary;
  readonly fixedStepUtilPctP95: number;
  readonly stepPhaseMs: SimStepPhaseTimingReport;
  readonly simulationUpdatePhaseMs: SimUpdatePhaseTimingReport;
  readonly simulationCombatPhaseMs: SimCombatPhaseTimingReport;
  readonly snapshotMainThreadMsPerSecond: number;
  readonly memory: MemoryReport;
  readonly wasmBoundary: WasmBoundaryInstrumentationReport;
  readonly combatTargetingProfile: CombatTargetingProfileReport;
  readonly snapshotMaterializationStats?: SnapshotMaterializationStatsReport;
  readonly snapshotWireStats?: SnapshotWireStatsReport;
};

type FullStackReport = {
  readonly units: number;
  readonly buildings: number;
  readonly projectiles: number;
  readonly samples: number;
  readonly runtimeProfile: string;
  readonly gpuTimerSupported: boolean;
  readonly activePixelRatio: number;
  readonly nativePixelRatio: number;
  readonly cameraMapCenterDistance: number;
  readonly frameMs: NumericSummary;
  readonly logicMs: NumericSummary;
  readonly renderPrepMs: NumericSummary;
  readonly gpuMs: NumericSummary;
  readonly renderTpsAvg: NumericSummary;
  readonly renderTpsLow: NumericSummary;
  readonly snapshotTotalSps: NumericSummary;
  readonly snapshotRichSps: NumericSummary;
  readonly snapshotDeltaSps: NumericSummary;
  readonly snapshotEntityDeltaSps: NumericSummary;
  readonly snapshotProjectileDeltaSps: NumericSummary;
  readonly snapshotReceivedCounts: SnapshotTrafficCounters;
  readonly snapshotReceivedRates: SnapshotTrafficMeasuredRates;
  readonly snapshotAppliedCounts: SnapshotTrafficCounters;
  readonly snapshotAppliedRates: SnapshotTrafficMeasuredRates;
  readonly serverTpsAvg: NumericSummary;
  readonly serverCpuAvgPct: NumericSummary;
  readonly serverCpuHiPct: NumericSummary;
  readonly serverStepPhaseMs: SimStepPhaseTimingReport;
  readonly serverUpdatePhaseMs: SimUpdatePhaseTimingReport;
  readonly serverCombatPhaseMs: SimCombatPhaseTimingReport;
  readonly drawCalls: NumericSummary;
  readonly triangles: NumericSummary;
  readonly bufferUploadBytes: NumericSummary;
  readonly bufferUploadCalls: NumericSummary;
  readonly renderBudgetTier: string;
  readonly renderBudgetTierIndex: NumericSummary;
  readonly renderBudgetHudFrameStride: NumericSummary;
  readonly renderBudgetEffectFrameStride: NumericSummary;
  readonly renderPhaseScopeMs: NumericSummary;
  readonly renderPhaseProjectileQueryMs: NumericSummary;
  readonly renderPhaseEntityPacketMs: NumericSummary;
  readonly renderPhaseEntityRendererMs: NumericSummary;
  readonly renderPhaseTerrainMs: NumericSummary;
  readonly renderPhaseBeamMs: NumericSummary;
  readonly renderPhaseEffectsMs: NumericSummary;
  readonly renderPhaseHudMs: NumericSummary;
  readonly renderPhaseUnitRows: NumericSummary;
  readonly renderPhaseBuildingRows: NumericSummary;
  readonly renderPhaseProjectileRows: NumericSummary;
  readonly renderPhaseLineProjectileRows: NumericSummary;
  readonly longtaskMsPerSec: NumericSummary;
  readonly snapshotBytes: NumericSummary;
  readonly memory: MemoryReport;
  readonly wasmBoundary: WasmBoundaryInstrumentationReport;
  readonly combatTargetingProfile: CombatTargetingProfileReport;
  readonly snapshotMaterializationStats?: SnapshotMaterializationStatsReport;
  readonly snapshotWireStats?: SnapshotWireStatsReport;
};

type SnapshotWireStatsReport = {
  readonly rows: readonly unknown[];
  readonly breakdowns: readonly unknown[];
};

type SnapshotMaterializationStageSummary = {
  readonly stage: SnapshotMaterializationStage;
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

type SnapshotMaterializationKindReport = {
  readonly kind: SnapshotMaterializationKind | 'all';
  readonly samples: number;
  readonly entityRows: NumericSummary;
  readonly entityDtoRows: NumericSummary;
  readonly entityDtoBreakdownAvg: SnapshotEntityDtoRowBreakdown;
  readonly entityTypedRows: NumericSummary;
  readonly entityTypedPlaceholderRows: NumericSummary;
  readonly removedRows: NumericSummary;
  readonly projectileRows: NumericSummary;
  readonly stageMs: Partial<Record<SnapshotMaterializationStage, NumericSummary>>;
  readonly topStages: readonly SnapshotMaterializationStageSummary[];
};

type SnapshotMaterializationStatsReport = {
  readonly samples: number;
  readonly all: SnapshotMaterializationKindReport;
  readonly kinds: readonly SnapshotMaterializationKindReport[];
};

type SnapshotMaterializationBucket = {
  samples: number;
  entityRows: number[];
  entityDtoRows: number[];
  entityDtoBreakdownSums: SnapshotEntityDtoRowBreakdown;
  entityTypedRows: number[];
  entityTypedPlaceholderRows: number[];
  removedRows: number[];
  projectileRows: number[];
  stages: Record<SnapshotMaterializationStage, number[]>;
};

type SnapshotMaterializationAccumulator = {
  all: SnapshotMaterializationBucket;
  byKind: Map<SnapshotMaterializationKind, SnapshotMaterializationBucket>;
};

type MemorySample = {
  readonly jsHeapUsedBytes: number | null;
  readonly jsHeapTotalBytes: number | null;
  readonly wasmMemoryBytes: number | null;
};

type MemoryReport = {
  readonly jsHeapSupported: boolean;
  readonly wasmMemorySupported: boolean;
  readonly jsHeapUsedBytes: NumericSummary;
  readonly jsHeapTotalBytes: NumericSummary;
  readonly wasmMemoryBytes: NumericSummary;
  readonly jsHeapUsedDeltaBytes: number | null;
  readonly wasmMemoryDeltaBytes: number | null;
};

type BottleneckDiagnosis = {
  readonly primary:
    | 'simulation'
    | 'snapshot'
    | 'gpu-render'
    | 'render-main-thread'
    | 'browser-main-thread'
    | 'not-saturated';
  readonly confidence: 'low' | 'medium' | 'high';
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly nextChecks: readonly string[];
};

const DEFAULT_OPTIONS: Required<PerformanceBottleneckHarnessOptions> = {
  unitCap: 512,
  ticks: 240,
  warmupTicks: 60,
  seconds: 6,
  warmupSeconds: 2,
  snapshotEveryTicks: 6,
  mapCells: 17,
  width: 1280,
  height: 720,
  cameraDistance: 0,
  fogClouds: true,
  selectAllUnits: false,
  peaceful: false,
  renderOnly: false,
};

const DEFAULT_SUITE_UNIT_CAPS = [500, 1000, 2500, 5000] as const;
const PLAYER_IDS = [1 as PlayerId, 2 as PlayerId];
const LOCAL_PLAYER_ID = 1 as PlayerId;
const LOCAL_PRESENTATION_CONNECTION_OPTIONS = {
  loopbackSnapshotsThroughWire: false,
  recordSnapshotWireCost: false,
  directLocalSnapshotMaterialization: true,
  sharesAuthoritativeState: true,
} as const;

export async function runPerformanceBottleneckHarness(
  options: PerformanceBottleneckHarnessOptions = {},
): Promise<PerformanceBottleneckHarnessReport> {
  const resolved = normalizeOptions(options);
  const fixedStepHz = ARCHITECTURE_CONFIG.lockstep.fixedStepHz;
  const fixedStepMs = 1000 / fixedStepHz;
  const frameBudgetMs60 = 1000 / 60;

  const simOnly = await runSimOnly(resolved, fixedStepMs);
  await yieldToBrowser();
  const simSnapshot = await runSimSnapshot(resolved, fixedStepMs);
  await yieldToBrowser();
  const fullStack = await runFullStack(resolved);

  return {
    schema: 'budget-annihilation.performance-bottleneck-harness.v1',
    options: resolved,
    environment: {
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio || 1,
      fixedStepHz,
      fixedStepMs,
      frameBudgetMs60,
      richSnapshotTargetHz: ARCHITECTURE_CONFIG.lockstep.presentationSnapshots.nominalSnapshotRateHz,
      sparseEntityMotionSnapshotTargetHz: ARCHITECTURE_CONFIG.lockstep.presentationSnapshots.sparseEntityMotionRateHz,
      projectileDeltaSnapshotCeilingHz: fixedStepHz,
    },
    simOnly,
    simSnapshot,
    fullStack,
    diagnosis: diagnose({
      fixedStepMs,
      frameBudgetMs60,
      simOnly,
      simSnapshot,
      fullStack,
    }),
  };
}

export async function runPerformanceBottleneckHarnessSuite(
  options: PerformanceBottleneckHarnessSuiteOptions = {},
): Promise<PerformanceBottleneckHarnessSuiteReport> {
  const { unitCaps: rawUnitCaps, ...baseOptions } = options;
  const unitCaps = normalizeUnitCaps(rawUnitCaps);
  const reports: PerformanceBottleneckHarnessReport[] = [];
  for (let i = 0; i < unitCaps.length; i++) {
    reports.push(await runPerformanceBottleneckHarness({
      ...baseOptions,
      unitCap: unitCaps[i],
    }));
    if (i < unitCaps.length - 1) await yieldToBrowser();
  }
  return {
    schema: 'budget-annihilation.performance-bottleneck-suite.v1',
    unitCaps,
    reports,
    summary: summarizeSuite(reports),
  };
}

function normalizeOptions(
  options: PerformanceBottleneckHarnessOptions,
): Required<PerformanceBottleneckHarnessOptions> {
  return {
    unitCap: positiveInteger(options.unitCap, DEFAULT_OPTIONS.unitCap),
    ticks: positiveInteger(options.ticks, DEFAULT_OPTIONS.ticks),
    warmupTicks: positiveInteger(options.warmupTicks, DEFAULT_OPTIONS.warmupTicks),
    seconds: positiveNumber(options.seconds, DEFAULT_OPTIONS.seconds),
    warmupSeconds: positiveNumber(options.warmupSeconds, DEFAULT_OPTIONS.warmupSeconds),
    snapshotEveryTicks: positiveInteger(
      options.snapshotEveryTicks,
      DEFAULT_OPTIONS.snapshotEveryTicks,
    ),
    mapCells: positiveInteger(options.mapCells, DEFAULT_OPTIONS.mapCells),
    width: positiveInteger(options.width, DEFAULT_OPTIONS.width),
    height: positiveInteger(options.height, DEFAULT_OPTIONS.height),
    cameraDistance: positiveNumber(options.cameraDistance, DEFAULT_OPTIONS.cameraDistance),
    fogClouds: options.fogClouds ?? DEFAULT_OPTIONS.fogClouds,
    selectAllUnits: options.selectAllUnits ?? DEFAULT_OPTIONS.selectAllUnits,
    peaceful: options.peaceful ?? DEFAULT_OPTIONS.peaceful,
    renderOnly: options.renderOnly ?? DEFAULT_OPTIONS.renderOnly,
  };
}

function normalizeUnitCaps(unitCaps: readonly number[] | undefined): readonly number[] {
  const source = unitCaps === undefined || unitCaps.length === 0
    ? DEFAULT_SUITE_UNIT_CAPS
    : unitCaps;
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < source.length; i++) {
    const cap = positiveInteger(source[i], 0);
    if (cap <= 0 || seen.has(cap)) continue;
    seen.add(cap);
    out.push(cap);
  }
  return out.length > 0 ? out : [...DEFAULT_SUITE_UNIT_CAPS];
}

function selectAllLocalUnits(clientViewState: ClientViewState, game: GameInstance): void {
  const selectedIds = new Set<EntityId>();
  const units = clientViewState.getUnitsByPlayer(LOCAL_PLAYER_ID);
  for (let i = 0; i < units.length; i++) {
    if (units[i].selectable !== null) selectedIds.add(units[i].id);
  }
  clientViewState.setSelectedIds(selectedIds);
  game.getScene()?.markSelectionDirty();
}

function summarizeSuite(
  reports: readonly PerformanceBottleneckHarnessReport[],
): PerformanceBottleneckHarnessSuiteReport['summary'] {
  let worstSimFixedStepUtilPctP95 = 0;
  let worstFrameMsP95 = 0;
  let worstSnapshotMainThreadMsPerSecond = 0;
  let totalWasmBoundaryMs = 0;
  let maxJsHeapUsedBytes: number | null = null;
  let maxWasmMemoryBytes: number | null = null;
  for (const report of reports) {
    worstSimFixedStepUtilPctP95 = Math.max(
      worstSimFixedStepUtilPctP95,
      report.simOnly.fixedStepUtilPctP95,
      report.simSnapshot.fixedStepUtilPctP95,
    );
    worstFrameMsP95 = Math.max(worstFrameMsP95, report.fullStack.frameMs.p95);
    worstSnapshotMainThreadMsPerSecond = Math.max(
      worstSnapshotMainThreadMsPerSecond,
      report.simSnapshot.snapshotMainThreadMsPerSecond,
    );
    totalWasmBoundaryMs +=
      report.simOnly.wasmBoundary.totalMs +
      report.simSnapshot.wasmBoundary.totalMs +
      report.fullStack.wasmBoundary.totalMs;
    if (report.simOnly.memory.jsHeapSupported) {
      maxJsHeapUsedBytes = maxNullable(maxJsHeapUsedBytes, report.simOnly.memory.jsHeapUsedBytes.max);
    }
    if (report.simSnapshot.memory.jsHeapSupported) {
      maxJsHeapUsedBytes = maxNullable(maxJsHeapUsedBytes, report.simSnapshot.memory.jsHeapUsedBytes.max);
    }
    if (report.fullStack.memory.jsHeapSupported) {
      maxJsHeapUsedBytes = maxNullable(maxJsHeapUsedBytes, report.fullStack.memory.jsHeapUsedBytes.max);
    }
    if (report.simOnly.memory.wasmMemorySupported) {
      maxWasmMemoryBytes = maxNullable(maxWasmMemoryBytes, report.simOnly.memory.wasmMemoryBytes.max);
    }
    if (report.simSnapshot.memory.wasmMemorySupported) {
      maxWasmMemoryBytes = maxNullable(maxWasmMemoryBytes, report.simSnapshot.memory.wasmMemoryBytes.max);
    }
    if (report.fullStack.memory.wasmMemorySupported) {
      maxWasmMemoryBytes = maxNullable(maxWasmMemoryBytes, report.fullStack.memory.wasmMemoryBytes.max);
    }
  }
  return {
    scenarios: reports.length,
    worstSimFixedStepUtilPctP95,
    worstFrameMsP95,
    worstSnapshotMainThreadMsPerSecond,
    totalWasmBoundaryMs,
    maxJsHeapUsedBytes,
    maxWasmMemoryBytes,
  };
}

async function runSimOnly(
  options: Required<PerformanceBottleneckHarnessOptions>,
  fixedStepMs: number,
): Promise<SimOnlyReport> {
  const server = await GameServer.create(createServerConfig(options));
  const core = server.getLockstepSimulationCore();
  try {
    for (let i = 0; i < options.warmupTicks; i++) {
      core.stepFixedTick(fixedStepMs);
    }

    const memory = createMemoryTracker();
    const stepPhaseAccumulator = createSimStepPhaseTimingAccumulator();
    const updatePhaseAccumulator = createSimUpdatePhaseTimingAccumulator();
    const combatPhaseAccumulator = createSimCombatPhaseTimingAccumulator();
    core.setStepProfiler((timings) => recordSimStepPhaseTiming(stepPhaseAccumulator, timings));
    core.simulation.setUpdateProfiler((timings) =>
      recordSimUpdatePhaseTiming(updatePhaseAccumulator, timings)
    );
    core.simulation.setCombatProfiler((timings) =>
      recordSimCombatPhaseTiming(combatPhaseAccumulator, timings)
    );
    resetCombatTargetingProfile();
    beginWasmBoundaryTracking();
    const samples: number[] = [];
    const wallStart = performance.now();
    for (let i = 0; i < options.ticks; i++) {
      const start = performance.now();
      core.stepFixedTick(fixedStepMs);
      memory.sample();
      samples.push(performance.now() - start);
    }
    const wallMs = performance.now() - wallStart;
    const stepMs = summarize(samples);
    const combatTargetingProfile = readCombatTargetingProfile();
    const wasmBoundary = finishWasmBoundaryTracking();
    return {
      ...countCoreEntities(core),
      measuredTicks: options.ticks,
      wallMs,
      stepMs,
      simCeilingTpsP95: stepMs.p95 > 0 ? 1000 / stepMs.p95 : 0,
      fixedStepUtilPctP95: (stepMs.p95 / fixedStepMs) * 100,
      stepPhaseMs: summarizeSimStepPhaseTimings(stepPhaseAccumulator),
      simulationUpdatePhaseMs: summarizeSimUpdatePhaseTimings(updatePhaseAccumulator),
      simulationCombatPhaseMs: summarizeSimCombatPhaseTimings(combatPhaseAccumulator),
      memory: memory.finish(),
      wasmBoundary,
      combatTargetingProfile,
    };
  } finally {
    core.setStepProfiler(undefined);
    core.simulation.setUpdateProfiler(undefined);
    core.simulation.setCombatProfiler(undefined);
    finishWasmBoundaryTracking();
    server.stop();
  }
}

async function runSimSnapshot(
  options: Required<PerformanceBottleneckHarnessOptions>,
  fixedStepMs: number,
): Promise<SimSnapshotReport> {
  const server = await GameServer.create(createServerConfig(options));
  const core = server.getLockstepSimulationCore();
  const connection = new LocalGameConnection(server, LOCAL_PLAYER_ID, 'local-offline', {
    ...LOCAL_PRESENTATION_CONNECTION_OPTIONS,
  });
  const view = new ClientViewState();
  view.setMapDimensions(mapWorldSize(options.mapCells), mapWorldSize(options.mapCells));

  const applySamples: number[] = [];
  const byteSamples: number[] = [];
  const materializationSamples = createSnapshotMaterializationAccumulator();
  const unsubscribe = connection.onSnapshot((snapshot: NetworkServerSnapshot) => {
    const materialization = getSnapshotMaterializationMetadata(snapshot);
    const applyStart = performance.now();
    view.applyNetworkState(snapshot, {
      syncEconomy: false,
      collectMaterializationStages: true,
      deferPredictedTurretRenderRefresh: true,
    });
    const applyMs = performance.now() - applyStart;
    applySamples.push(applyMs);
    recordSnapshotMaterializationSample(materializationSamples, materialization, applyMs);
    const bytes = getSnapshotWireBytes(snapshot);
    if (bytes !== undefined && Number.isFinite(bytes)) byteSamples.push(bytes);
  });

  try {
    server.emitLockstepPresentationSnapshot();
    connection.markClientReady();
    for (let i = 0; i < options.warmupTicks; i++) {
      core.stepFixedTick(fixedStepMs);
      if (i % options.snapshotEveryTicks === 0) server.emitLockstepPresentationSnapshot();
    }

    applySamples.length = 0;
    byteSamples.length = 0;
    resetSnapshotMaterializationAccumulator(materializationSamples);
    const memory = createMemoryTracker();
    const stepPhaseAccumulator = createSimStepPhaseTimingAccumulator();
    const updatePhaseAccumulator = createSimUpdatePhaseTimingAccumulator();
    const combatPhaseAccumulator = createSimCombatPhaseTimingAccumulator();
    core.setStepProfiler((timings) => recordSimStepPhaseTiming(stepPhaseAccumulator, timings));
    core.simulation.setUpdateProfiler((timings) =>
      recordSimUpdatePhaseTiming(updatePhaseAccumulator, timings)
    );
    core.simulation.setCombatProfiler((timings) =>
      recordSimCombatPhaseTiming(combatPhaseAccumulator, timings)
    );
    resetCombatTargetingProfile();
    beginWasmBoundaryTracking();
    const stepSamples: number[] = [];
    const snapshotSamples: number[] = [];
    for (let i = 0; i < options.ticks; i++) {
      const stepStart = performance.now();
      core.stepFixedTick(fixedStepMs);
      memory.sample();
      stepSamples.push(performance.now() - stepStart);
      if (i % options.snapshotEveryTicks === 0) {
        const snapshotStart = performance.now();
        server.emitLockstepPresentationSnapshot();
        memory.sample();
        snapshotSamples.push(performance.now() - snapshotStart);
      }
    }

    const stepMs = summarize(stepSamples);
    const snapshotTotalMs = summarize(snapshotSamples);
    const snapshotWireStats = readSnapshotWireStats();
    const snapshotMaterializationStats = summarizeSnapshotMaterialization(
      materializationSamples,
    );
    const combatTargetingProfile = readCombatTargetingProfile();
    const wasmBoundary = finishWasmBoundaryTracking();
    return {
      ...countCoreEntities(core),
      measuredTicks: options.ticks,
      snapshots: snapshotSamples.length,
      stepMs,
      snapshotTotalMs,
      snapshotApplyMs: summarize(applySamples),
      snapshotBytes: summarize(byteSamples),
      fixedStepUtilPctP95: (stepMs.p95 / fixedStepMs) * 100,
      stepPhaseMs: summarizeSimStepPhaseTimings(stepPhaseAccumulator),
      simulationUpdatePhaseMs: summarizeSimUpdatePhaseTimings(updatePhaseAccumulator),
      simulationCombatPhaseMs: summarizeSimCombatPhaseTimings(combatPhaseAccumulator),
      snapshotMainThreadMsPerSecond:
        snapshotTotalMs.avg * (1000 / (fixedStepMs * options.snapshotEveryTicks)),
      memory: memory.finish(),
      wasmBoundary,
      combatTargetingProfile,
      snapshotMaterializationStats,
      snapshotWireStats,
    };
  } finally {
    core.setStepProfiler(undefined);
    core.simulation.setUpdateProfiler(undefined);
    core.simulation.setCombatProfiler(undefined);
    finishWasmBoundaryTracking();
    unsubscribe();
    connection.disconnect();
    server.stop();
  }
}

async function runFullStack(
  options: Required<PerformanceBottleneckHarnessOptions>,
): Promise<FullStackReport> {
  const parent = document.createElement('div');
  parent.style.cssText = [
    `width:${options.width}px`,
    `height:${options.height}px`,
    'position:fixed',
    'left:0',
    'top:0',
    'overflow:hidden',
  ].join(';');
  document.body.appendChild(parent);

  const server = await GameServer.create(createServerConfig(options));
  const core = server.getLockstepSimulationCore();
  const connection = new LocalGameConnection(server, LOCAL_PLAYER_ID, 'local-offline', {
    ...LOCAL_PRESENTATION_CONNECTION_OPTIONS,
  });
  const clientViewState = new ClientViewState();
  const mapSize = mapWorldSize(options.mapCells);
  clientViewState.setMapDimensions(mapSize, mapSize);
  let game: GameInstance | null = null;
  const serverStepPhaseAccumulator = createSimStepPhaseTimingAccumulator();
  const serverUpdatePhaseAccumulator = createSimUpdatePhaseTimingAccumulator();
  const serverCombatPhaseAccumulator = createSimCombatPhaseTimingAccumulator();
  const previousFogClouds = getFogClouds();
  setFogClouds(options.fogClouds);

  try {
    game = createGame({
      parent,
      width: options.width,
      height: options.height,
      playerIds: PLAYER_IDS,
      localPlayerId: LOCAL_PLAYER_ID,
      gameConnection: connection,
      clientViewState,
      mapWidth: mapSize,
      mapHeight: mapSize,
      centerMagnitude: 0,
      dividersMagnitude: 0,
      perimeterMagnitude: -800,
      backgroundMode: true,
    });
    server.start();
    connection.markClientReady();

    if (options.cameraDistance > 0) {
      const scene = game.getScene();
      const orbit = scene?.getOrbitCamera();
      if (orbit !== undefined) {
        orbit.setState({
          targetX: mapSize * 0.5,
          targetY: 0,
          targetZ: mapSize * 0.5,
          distance: options.cameraDistance,
          yaw: orbit.yaw,
          pitch: orbit.pitch,
        });
      }
    }

    await waitMs(options.warmupSeconds * 1000);
    if (options.selectAllUnits) selectAllLocalUnits(clientViewState, game);
    if (options.renderOnly) {
      server.setPaused(true);
      await waitMs(100);
    }
    core.setStepProfiler((timings) =>
      recordSimStepPhaseTiming(serverStepPhaseAccumulator, timings)
    );
    core.simulation.setUpdateProfiler((timings) =>
      recordSimUpdatePhaseTiming(serverUpdatePhaseAccumulator, timings)
    );
    core.simulation.setCombatProfiler((timings) =>
      recordSimCombatPhaseTiming(serverCombatPhaseAccumulator, timings)
    );
    const measurementStartScene = game.getScene();
    const drainedSnapshotMaterialization: SnapshotMaterializationMetadata[] = [];
    measurementStartScene?.drainSnapshotMaterializationMetadata(drainedSnapshotMaterialization);
    drainedSnapshotMaterialization.length = 0;
    const snapshotReceivedCounterStart =
      measurementStartScene?.getReceivedSnapshotCounters() ?? EMPTY_SNAPSHOT_TRAFFIC_COUNTERS;
    const snapshotAppliedCounterStart =
      measurementStartScene?.getSnapshotCounters() ?? EMPTY_SNAPSHOT_TRAFFIC_COUNTERS;
    const measurementStartMs = performance.now();

    const memory = createMemoryTracker();
    resetCombatTargetingProfile();
    beginWasmBoundaryTracking();
    const frameMs: number[] = [];
    const logicMs: number[] = [];
    const renderPrepMs: number[] = [];
    const gpuMs: number[] = [];
    const renderTpsAvg: number[] = [];
    const renderTpsLow: number[] = [];
    const snapshotTotalSps: number[] = [];
    const snapshotRichSps: number[] = [];
    const snapshotDeltaSps: number[] = [];
    const snapshotEntityDeltaSps: number[] = [];
    const snapshotProjectileDeltaSps: number[] = [];
    const serverTpsAvg: number[] = [];
    const serverCpuAvgPct: number[] = [];
    const serverCpuHiPct: number[] = [];
    const drawCalls: number[] = [];
    const triangles: number[] = [];
    const bufferUploadBytes: number[] = [];
    const bufferUploadCalls: number[] = [];
    const renderBudgetTierIndex: number[] = [];
    const renderBudgetHudFrameStride: number[] = [];
    const renderBudgetEffectFrameStride: number[] = [];
    const renderPhaseScopeMs: number[] = [];
    const renderPhaseProjectileQueryMs: number[] = [];
    const renderPhaseEntityPacketMs: number[] = [];
    const renderPhaseEntityRendererMs: number[] = [];
    const renderPhaseTerrainMs: number[] = [];
    const renderPhaseBeamMs: number[] = [];
    const renderPhaseEffectsMs: number[] = [];
    const renderPhaseHudMs: number[] = [];
    const renderPhaseUnitRows: number[] = [];
    const renderPhaseBuildingRows: number[] = [];
    const renderPhaseProjectileRows: number[] = [];
    const renderPhaseLineProjectileRows: number[] = [];
    const longtaskMsPerSec: number[] = [];
    const snapshotBytes: number[] = [];
    const snapshotMaterializationSamples = createSnapshotMaterializationAccumulator();
    let runtimeProfile = 'unknown';
    let gpuTimerSupported = false;
    let activePixelRatio = 1;
    let nativePixelRatio = 1;
    let renderBudgetTier = 'normal';

    const deadline = measurementStartMs + options.seconds * 1000;
    while (performance.now() < deadline) {
      await waitMs(250);
      const scene = game.getScene();
      if (scene === null) continue;
      const timing = scene.getFrameTiming();
      const renderTps = scene.getRenderTpsStats();
      const snapshotStats = scene.getSnapshotStats();
      const meta = clientViewState.getServerMeta();
      const snapSize = scene.getSnapshotPayloadSizeStats();
      scene.drainSnapshotMaterializationMetadata(drainedSnapshotMaterialization);
      for (let i = 0; i < drainedSnapshotMaterialization.length; i++) {
        recordSnapshotMaterializationSample(
          snapshotMaterializationSamples,
          drainedSnapshotMaterialization[i],
          0,
        );
      }
      drainedSnapshotMaterialization.length = 0;

      runtimeProfile = timing.runtimeProfile;
      gpuTimerSupported = timing.gpuTimerSupported;
      activePixelRatio = timing.activePixelRatio;
      nativePixelRatio = timing.nativePixelRatio;
      frameMs.push(timing.frameMsAvg);
      logicMs.push(timing.logicMsAvg);
      renderPrepMs.push(timing.renderMsAvg);
      gpuMs.push(timing.gpuTimerSupported ? timing.gpuTimerMs : timing.webglRendererRenderMs);
      renderTpsAvg.push(renderTps.avgRate);
      renderTpsLow.push(renderTps.worstRate);
      snapshotTotalSps.push(snapshotStats.total.avgRate);
      snapshotRichSps.push(snapshotStats.rich.avgRate);
      snapshotDeltaSps.push(snapshotStats.delta.avgRate);
      snapshotEntityDeltaSps.push(snapshotStats.entityDelta.avgRate);
      snapshotProjectileDeltaSps.push(snapshotStats.projectileDelta.avgRate);
      serverTpsAvg.push(meta?.ticks.avg ?? 0);
      serverCpuAvgPct.push(meta?.cpu?.avg ?? 0);
      serverCpuHiPct.push(meta?.cpu?.hi ?? 0);
      drawCalls.push(timing.webglDrawCalls);
      triangles.push(timing.webglTriangles);
      bufferUploadBytes.push(timing.webglBufferUploadBytes);
      bufferUploadCalls.push(timing.webglBufferDataCalls + timing.webglBufferSubDataCalls);
      renderBudgetTier = timing.renderBudgetTier;
      renderBudgetTierIndex.push(timing.renderBudgetTierIndex);
      renderBudgetHudFrameStride.push(timing.renderBudgetHudFrameStride);
      renderBudgetEffectFrameStride.push(timing.renderBudgetEffectFrameStride);
      renderPhaseScopeMs.push(timing.renderPhaseScopeMs);
      renderPhaseProjectileQueryMs.push(timing.renderPhaseProjectileQueryMs);
      renderPhaseEntityPacketMs.push(timing.renderPhaseEntityPacketMs);
      renderPhaseEntityRendererMs.push(timing.renderPhaseEntityRendererMs);
      renderPhaseTerrainMs.push(timing.renderPhaseTerrainMs);
      renderPhaseBeamMs.push(timing.renderPhaseBeamMs);
      renderPhaseEffectsMs.push(timing.renderPhaseEffectsMs);
      renderPhaseHudMs.push(timing.renderPhaseHudMs);
      renderPhaseUnitRows.push(timing.renderPhaseUnitRows);
      renderPhaseBuildingRows.push(timing.renderPhaseBuildingRows);
      renderPhaseProjectileRows.push(timing.renderPhaseProjectileRows);
      renderPhaseLineProjectileRows.push(timing.renderPhaseLineProjectileRows);
      longtaskMsPerSec.push(timing.longtaskMsPerSec);
      snapshotBytes.push(snapSize.avgBytes);
      memory.sample();
    }
    const measurementEndMs = performance.now();
    const scene = game.getScene();
    const snapshotReceivedCounterEnd =
      scene?.getReceivedSnapshotCounters() ?? snapshotReceivedCounterStart;
    const snapshotAppliedCounterEnd =
      scene?.getSnapshotCounters() ?? snapshotAppliedCounterStart;
    const measuredSeconds = (measurementEndMs - measurementStartMs) / 1000;
    const snapshotReceivedCounts = diffSnapshotTrafficCounters(
      snapshotReceivedCounterEnd,
      snapshotReceivedCounterStart,
    );
    const snapshotReceivedRates = snapshotTrafficRates(
      snapshotReceivedCounts,
      measuredSeconds,
    );
    const snapshotAppliedCounts = diffSnapshotTrafficCounters(
      snapshotAppliedCounterEnd,
      snapshotAppliedCounterStart,
    );
    const snapshotAppliedRates = snapshotTrafficRates(
      snapshotAppliedCounts,
      measuredSeconds,
    );
    if (scene !== null) {
      scene.drainSnapshotMaterializationMetadata(drainedSnapshotMaterialization);
      for (let i = 0; i < drainedSnapshotMaterialization.length; i++) {
        recordSnapshotMaterializationSample(
          snapshotMaterializationSamples,
          drainedSnapshotMaterialization[i],
          0,
        );
      }
      drainedSnapshotMaterialization.length = 0;
    }

    const snapshotWireStats = readSnapshotWireStats();
    const snapshotMaterializationStats = summarizeSnapshotMaterialization(
      snapshotMaterializationSamples,
    );
    const combatTargetingProfile = readCombatTargetingProfile();
    const wasmBoundary = finishWasmBoundaryTracking();
    return {
      units: clientViewState.getUnits().length,
      buildings: clientViewState.getBuildings().length,
      projectiles: clientViewState.getProjectiles().length,
      samples: frameMs.length,
      runtimeProfile,
      gpuTimerSupported,
      activePixelRatio,
      nativePixelRatio,
      cameraMapCenterDistance: scene?.cameras.main.mapCenterDistance ?? 0,
      frameMs: summarize(frameMs),
      logicMs: summarize(logicMs),
      renderPrepMs: summarize(renderPrepMs),
      gpuMs: summarize(gpuMs),
      renderTpsAvg: summarize(renderTpsAvg),
      renderTpsLow: summarize(renderTpsLow),
      snapshotTotalSps: summarize(snapshotTotalSps),
      snapshotRichSps: summarize(snapshotRichSps),
      snapshotDeltaSps: summarize(snapshotDeltaSps),
      snapshotEntityDeltaSps: summarize(snapshotEntityDeltaSps),
      snapshotProjectileDeltaSps: summarize(snapshotProjectileDeltaSps),
      snapshotReceivedCounts,
      snapshotReceivedRates,
      snapshotAppliedCounts,
      snapshotAppliedRates,
      serverTpsAvg: summarize(serverTpsAvg),
      serverCpuAvgPct: summarize(serverCpuAvgPct),
      serverCpuHiPct: summarize(serverCpuHiPct),
      serverStepPhaseMs: summarizeSimStepPhaseTimings(serverStepPhaseAccumulator),
      serverUpdatePhaseMs: summarizeSimUpdatePhaseTimings(serverUpdatePhaseAccumulator),
      serverCombatPhaseMs: summarizeSimCombatPhaseTimings(serverCombatPhaseAccumulator),
      drawCalls: summarize(drawCalls),
      triangles: summarize(triangles),
      bufferUploadBytes: summarize(bufferUploadBytes),
      bufferUploadCalls: summarize(bufferUploadCalls),
      renderBudgetTier,
      renderBudgetTierIndex: summarize(renderBudgetTierIndex),
      renderBudgetHudFrameStride: summarize(renderBudgetHudFrameStride),
      renderBudgetEffectFrameStride: summarize(renderBudgetEffectFrameStride),
      renderPhaseScopeMs: summarize(renderPhaseScopeMs),
      renderPhaseProjectileQueryMs: summarize(renderPhaseProjectileQueryMs),
      renderPhaseEntityPacketMs: summarize(renderPhaseEntityPacketMs),
      renderPhaseEntityRendererMs: summarize(renderPhaseEntityRendererMs),
      renderPhaseTerrainMs: summarize(renderPhaseTerrainMs),
      renderPhaseBeamMs: summarize(renderPhaseBeamMs),
      renderPhaseEffectsMs: summarize(renderPhaseEffectsMs),
      renderPhaseHudMs: summarize(renderPhaseHudMs),
      renderPhaseUnitRows: summarize(renderPhaseUnitRows),
      renderPhaseBuildingRows: summarize(renderPhaseBuildingRows),
      renderPhaseProjectileRows: summarize(renderPhaseProjectileRows),
      renderPhaseLineProjectileRows: summarize(renderPhaseLineProjectileRows),
      longtaskMsPerSec: summarize(longtaskMsPerSec),
      snapshotBytes: summarize(snapshotBytes),
      memory: memory.finish(),
      wasmBoundary,
      combatTargetingProfile,
      snapshotMaterializationStats,
      snapshotWireStats,
    };
  } finally {
    core.setStepProfiler(undefined);
    core.simulation.setUpdateProfiler(undefined);
    core.simulation.setCombatProfiler(undefined);
    finishWasmBoundaryTracking();
    if (game !== null) destroyGame(game);
    else connection.disconnect();
    server.stop();
    parent.remove();
    setFogClouds(previousFogClouds);
  }
}

function readSnapshotWireStats(): SnapshotWireStatsReport | undefined {
  if (!SNAPSHOT_ENCODE_INSTRUMENTATION.enabled) return undefined;
  const rows = SNAPSHOT_ENCODE_INSTRUMENTATION.rows();
  const breakdowns = SNAPSHOT_ENCODE_INSTRUMENTATION.breakdowns();
  if (rows.length === 0 && breakdowns.length === 0) return undefined;
  return { rows, breakdowns };
}

function createSnapshotMaterializationAccumulator(): SnapshotMaterializationAccumulator {
  return {
    all: createSnapshotMaterializationBucket(),
    byKind: new Map(),
  };
}

function resetSnapshotMaterializationAccumulator(
  accumulator: SnapshotMaterializationAccumulator,
): void {
  resetSnapshotMaterializationBucket(accumulator.all);
  accumulator.byKind.clear();
}

function recordSnapshotMaterializationSample(
  accumulator: SnapshotMaterializationAccumulator,
  metadata: SnapshotMaterializationMetadata | undefined,
  clientApplyMs: number,
): void {
  if (metadata === undefined) return;
  recordSnapshotMaterializationBucket(accumulator.all, metadata, clientApplyMs);
  let bucket = accumulator.byKind.get(metadata.kind);
  if (bucket === undefined) {
    bucket = createSnapshotMaterializationBucket();
    accumulator.byKind.set(metadata.kind, bucket);
  }
  recordSnapshotMaterializationBucket(bucket, metadata, clientApplyMs);
}

function summarizeSnapshotMaterialization(
  accumulator: SnapshotMaterializationAccumulator,
): SnapshotMaterializationStatsReport | undefined {
  if (accumulator.all.samples === 0) return undefined;
  const kinds: SnapshotMaterializationKindReport[] = [];
  for (const [kind, bucket] of accumulator.byKind) {
    kinds.push(summarizeSnapshotMaterializationBucket(kind, bucket));
  }
  kinds.sort((a, b) => a.kind.localeCompare(b.kind));
  return {
    samples: accumulator.all.samples,
    all: summarizeSnapshotMaterializationBucket('all', accumulator.all),
    kinds,
  };
}

function createSnapshotMaterializationBucket(): SnapshotMaterializationBucket {
  return {
    samples: 0,
    entityRows: [],
    entityDtoRows: [],
    entityDtoBreakdownSums: createSnapshotEntityDtoRowBreakdown(),
    entityTypedRows: [],
    entityTypedPlaceholderRows: [],
    removedRows: [],
    projectileRows: [],
    stages: createSnapshotMaterializationStageSampleRows(),
  };
}

function createSnapshotMaterializationStageSampleRows(): Record<SnapshotMaterializationStage, number[]> {
  const stages = {} as Record<SnapshotMaterializationStage, number[]>;
  for (let i = 0; i < SNAPSHOT_MATERIALIZATION_STAGES.length; i++) {
    stages[SNAPSHOT_MATERIALIZATION_STAGES[i]] = [];
  }
  return stages;
}

function resetSnapshotMaterializationBucket(bucket: SnapshotMaterializationBucket): void {
  bucket.samples = 0;
  bucket.entityRows.length = 0;
  bucket.entityDtoRows.length = 0;
  resetSnapshotEntityDtoRowBreakdown(bucket.entityDtoBreakdownSums);
  bucket.entityTypedRows.length = 0;
  bucket.entityTypedPlaceholderRows.length = 0;
  bucket.removedRows.length = 0;
  bucket.projectileRows.length = 0;
  for (let i = 0; i < SNAPSHOT_MATERIALIZATION_STAGES.length; i++) {
    bucket.stages[SNAPSHOT_MATERIALIZATION_STAGES[i]].length = 0;
  }
}

function resetSnapshotEntityDtoRowBreakdown(breakdown: SnapshotEntityDtoRowBreakdown): void {
  breakdown.fullRows = 0;
  breakdown.deltaRows = 0;
  breakdown.unitRows = 0;
  breakdown.buildingRows = 0;
  breakdown.towerRows = 0;
  breakdown.basicRows = 0;
  breakdown.motionRows = 0;
  breakdown.hpRows = 0;
  breakdown.buildRows = 0;
  breakdown.actionRows = 0;
  breakdown.factoryRows = 0;
  breakdown.turretRows = 0;
  breakdown.combatModeRows = 0;
  breakdown.otherDeltaRows = 0;
}

function addSnapshotEntityDtoRowBreakdown(
  dst: SnapshotEntityDtoRowBreakdown,
  src: SnapshotEntityDtoRowBreakdown,
): void {
  dst.fullRows += src.fullRows;
  dst.deltaRows += src.deltaRows;
  dst.unitRows += src.unitRows;
  dst.buildingRows += src.buildingRows;
  dst.towerRows += src.towerRows;
  dst.basicRows += src.basicRows;
  dst.motionRows += src.motionRows;
  dst.hpRows += src.hpRows;
  dst.buildRows += src.buildRows;
  dst.actionRows += src.actionRows;
  dst.factoryRows += src.factoryRows;
  dst.turretRows += src.turretRows;
  dst.combatModeRows += src.combatModeRows;
  dst.otherDeltaRows += src.otherDeltaRows;
}

function averageSnapshotEntityDtoRowBreakdown(
  sums: SnapshotEntityDtoRowBreakdown,
  samples: number,
): SnapshotEntityDtoRowBreakdown {
  if (samples <= 0) return createSnapshotEntityDtoRowBreakdown();
  const out = copySnapshotEntityDtoRowBreakdown(sums);
  out.fullRows /= samples;
  out.deltaRows /= samples;
  out.unitRows /= samples;
  out.buildingRows /= samples;
  out.towerRows /= samples;
  out.basicRows /= samples;
  out.motionRows /= samples;
  out.hpRows /= samples;
  out.buildRows /= samples;
  out.actionRows /= samples;
  out.factoryRows /= samples;
  out.turretRows /= samples;
  out.combatModeRows /= samples;
  out.otherDeltaRows /= samples;
  return out;
}

function recordSnapshotMaterializationBucket(
  bucket: SnapshotMaterializationBucket,
  metadata: SnapshotMaterializationMetadata,
  clientApplyMs: number,
): void {
  bucket.samples++;
  bucket.entityRows.push(metadata.entityRows);
  bucket.entityDtoRows.push(metadata.entityDtoRows);
  if (metadata.entityDtoBreakdown !== undefined) {
    addSnapshotEntityDtoRowBreakdown(
      bucket.entityDtoBreakdownSums,
      metadata.entityDtoBreakdown,
    );
  }
  bucket.entityTypedRows.push(metadata.entityTypedRows);
  bucket.entityTypedPlaceholderRows.push(metadata.entityTypedPlaceholderRows);
  bucket.removedRows.push(metadata.removedRows);
  bucket.projectileRows.push(metadata.projectileRows);
  for (let i = 0; i < SNAPSHOT_MATERIALIZATION_STAGES.length; i++) {
    const stage = SNAPSHOT_MATERIALIZATION_STAGES[i];
    let ms = metadata.stages[stage];
    if (stage === 'clientApply') {
      ms = (ms ?? 0) + (Number.isFinite(clientApplyMs) && clientApplyMs >= 0 ? clientApplyMs : 0);
    }
    if (ms !== undefined && Number.isFinite(ms) && ms >= 0) {
      bucket.stages[stage].push(ms);
    }
  }
}

function summarizeSnapshotMaterializationBucket(
  kind: SnapshotMaterializationKind | 'all',
  bucket: SnapshotMaterializationBucket,
): SnapshotMaterializationKindReport {
  const stageMs: Partial<Record<SnapshotMaterializationStage, NumericSummary>> = {};
  const topStages: SnapshotMaterializationStageSummary[] = [];
  for (let i = 0; i < SNAPSHOT_MATERIALIZATION_STAGES.length; i++) {
    const stage = SNAPSHOT_MATERIALIZATION_STAGES[i];
    const samples = bucket.stages[stage];
    if (samples.length === 0) continue;
    const summary = summarize(samples);
    stageMs[stage] = summary;
    if (stage !== 'total') {
      topStages.push({
        stage,
        avgMs: summary.avg,
        p95Ms: summary.p95,
        maxMs: summary.max,
      });
    }
  }
  topStages.sort((a, b) =>
    b.avgMs - a.avgMs ||
    b.p95Ms - a.p95Ms ||
    a.stage.localeCompare(b.stage)
  );
  return {
    kind,
    samples: bucket.samples,
    entityRows: summarize(bucket.entityRows),
    entityDtoRows: summarize(bucket.entityDtoRows),
    entityDtoBreakdownAvg: averageSnapshotEntityDtoRowBreakdown(
      bucket.entityDtoBreakdownSums,
      bucket.samples,
    ),
    entityTypedRows: summarize(bucket.entityTypedRows),
    entityTypedPlaceholderRows: summarize(bucket.entityTypedPlaceholderRows),
    removedRows: summarize(bucket.removedRows),
    projectileRows: summarize(bucket.projectileRows),
    stageMs,
    topStages: topStages.slice(0, 6),
  };
}

function createServerConfig(
  options: Required<PerformanceBottleneckHarnessOptions>,
): GameServerConfig {
  return {
    playerIds: PLAYER_IDS,
    centerMagnitude: 0,
    dividersMagnitude: 0,
    perimeterMagnitude: -800,
    terrainDTerrain: 0,
    plateauWallSlopeDegrees: 89,
    watersEdgeBeachSlopeDegrees: 10,
    watersEdgeCliffHeight: 100,
    metalDepositStep: 0,
    terrainDetail: 1,
    mapWidthLandCells: options.mapCells,
    mapLengthLandCells: options.mapCells,
    backgroundMode: true,
    aiPlayerIds: options.peaceful ? [] : PLAYER_IDS,
    spawnDemoInitialState: true,
    initialMaxTotalUnits: options.unitCap,
    initialAllowedUnitBlueprintIds: options.peaceful
      ? new Set(['unitConstructionDrone'])
      : undefined,
    initialAllowedBuildingBlueprintIds: options.peaceful
      ? new Set()
      : undefined,
    initialAllowedTowerBlueprintIds: options.peaceful
      ? new Set()
      : undefined,
    converterTax: 0,
  };
}

function diagnose(input: {
  fixedStepMs: number;
  frameBudgetMs60: number;
  simOnly: SimOnlyReport;
  simSnapshot: SimSnapshotReport;
  fullStack: FullStackReport;
}): BottleneckDiagnosis {
  const evidence: string[] = [];
  const nextChecks: string[] = [];
  const simUtil = input.simOnly.fixedStepUtilPctP95;
  const snapshotMsPerSecond = input.simSnapshot.snapshotMainThreadMsPerSecond;
  const frameP95 = input.fullStack.frameMs.p95;
  const gpuP95 = input.fullStack.gpuMs.p95;
  const renderPrepP95 = input.fullStack.renderPrepMs.p95;
  const logicP95 = input.fullStack.logicMs.p95;
  const longtaskP95 = input.fullStack.longtaskMsPerSec.p95;
  const frameBudget = input.frameBudgetMs60;

  evidence.push(
    `sim p95 ${fmt(input.simOnly.stepMs.p95)}ms = ${fmt(simUtil)}% of fixed-step budget`,
  );
  const simPhaseEvidence = formatSimStepPhaseEvidence(input.simOnly.stepPhaseMs, 'sim-only');
  if (simPhaseEvidence !== '') evidence.push(simPhaseEvidence);
  const simUpdatePhaseEvidence = formatSimUpdatePhaseEvidence(
    input.simOnly.simulationUpdatePhaseMs,
    'sim-only',
  );
  if (simUpdatePhaseEvidence !== '') evidence.push(simUpdatePhaseEvidence);
  const simCombatPhaseEvidence = formatSimCombatPhaseEvidence(
    input.simOnly.simulationCombatPhaseMs,
    'sim-only',
  );
  if (simCombatPhaseEvidence !== '') evidence.push(simCombatPhaseEvidence);
  const collisionDetailEvidence = formatProjectileCollisionDetailEvidence(
    input.simOnly.simulationCombatPhaseMs,
    'sim-only',
  );
  if (collisionDetailEvidence !== '') evidence.push(collisionDetailEvidence);
  evidence.push(
    `snapshot p95 ${fmt(input.simSnapshot.snapshotTotalMs.p95)}ms, ` +
      `${fmt(snapshotMsPerSecond)}ms/s main-thread share`,
  );
  const materializationEvidence = formatSnapshotMaterializationEvidence(
    input.simSnapshot.snapshotMaterializationStats,
  );
  if (materializationEvidence !== '') evidence.push(materializationEvidence);
  const fullStackMaterializationEvidence = formatSnapshotMaterializationEvidence(
    input.fullStack.snapshotMaterializationStats,
    'full-stack snapshot materialization',
  );
  if (fullStackMaterializationEvidence !== '') evidence.push(fullStackMaterializationEvidence);
  evidence.push(
    `full frame p95 ${fmt(frameP95)}ms, render prep p95 ${fmt(renderPrepP95)}ms, ` +
      `gpu p95 ${fmt(gpuP95)}ms`,
  );
  evidence.push(
    `render budget ${input.fullStack.renderBudgetTier}, entity packet p95 ` +
      `${fmt(input.fullStack.renderPhaseEntityPacketMs.p95)}ms, entity renderer p95 ` +
      `${fmt(input.fullStack.renderPhaseEntityRendererMs.p95)}ms, effects p95 ` +
      `${fmt(input.fullStack.renderPhaseEffectsMs.p95)}ms`,
  );

  if (simUtil >= 85 || input.simOnly.simCeilingTpsP95 < ARCHITECTURE_CONFIG.lockstep.fixedStepHz * 1.15) {
    nextChecks.push('Use Simulation.update phase p95s to move the dominant subsystem toward Rust/data-oriented slabs: unit movement/action planning, combat, spatial refresh, or economy/construction.');
    nextChecks.push('Run the same harness with lower unit caps to find the unit-count slope.');
    return {
      primary: 'simulation',
      confidence: simUtil >= 100 ? 'high' : 'medium',
      summary: 'The fixed-step simulation is close to or over budget before rendering enters the picture.',
      evidence,
      nextChecks,
    };
  }

  if (snapshotMsPerSecond >= 80 || input.simSnapshot.snapshotTotalMs.p95 >= frameBudget * 0.5) {
    nextChecks.push('Use snapshot materialization stage p95s to pick the next reduction target: visibility, entity DTOs, projectiles, wire encode, clone/merge, or ClientViewState.applyNetworkState.');
    nextChecks.push('Repeat with lower presentation snapshot rates to confirm serialization sensitivity.');
    return {
      primary: 'snapshot',
      confidence: snapshotMsPerSecond >= 150 ? 'high' : 'medium',
      summary: 'Snapshot serialization/decode/apply is consuming enough main-thread time to be a bottleneck candidate.',
      evidence,
      nextChecks,
    };
  }

  if (frameP95 <= frameBudget * 0.9 && input.fullStack.renderTpsLow.p95 >= 55) {
    nextChecks.push('Increase unit cap or enable a combat/projectile-heavy scenario to find the next ceiling.');
    return {
      primary: 'not-saturated',
      confidence: 'medium',
      summary: 'The measured scenario has usable headroom at the current cap and viewport.',
      evidence,
      nextChecks,
    };
  }

  if (longtaskP95 >= 100) {
    nextChecks.push('Record a Chrome performance trace and inspect long tasks for GC, snapshot apply, renderer prep, or Vue/UI work.');
    return {
      primary: 'browser-main-thread',
      confidence: longtaskP95 >= 200 ? 'high' : 'medium',
      summary: 'Long main-thread tasks are large enough to explain frame misses independent of raw GPU time.',
      evidence,
      nextChecks,
    };
  }

  if (gpuP95 >= frameBudget * 0.8 && gpuP95 >= renderPrepP95 && gpuP95 >= logicP95) {
    nextChecks.push('Repeat at lower DPR/resolution; a large improvement confirms GPU/fill-rate pressure.');
    nextChecks.push('Inspect DRAW and UPLOAD counters for draw-call count, triangle count, and buffer upload volume.');
    return {
      primary: 'gpu-render',
      confidence: gpuP95 >= frameBudget ? 'high' : 'medium',
      summary: 'GPU/render submission time dominates the frame budget while sim headroom remains healthy.',
      evidence,
      nextChecks,
    };
  }

  nextChecks.push('Split RtsScene3DRenderPhase.run into entity packet prep, entityRenderer.update, HUD, effects, terrain, and uploads.');
  nextChecks.push('Toggle HUD/effects/render scope and rerun to identify the render-prep slope.');
  return {
    primary: 'render-main-thread',
    confidence: 'medium',
    summary: 'Frame misses are more consistent with JavaScript render prep, prediction, HUD, uploads, or scene bookkeeping than pure sim math.',
    evidence,
    nextChecks,
  };
}

function formatSnapshotMaterializationEvidence(
  stats: SnapshotMaterializationStatsReport | undefined,
  label = 'snapshot materialization',
): string {
  if (stats === undefined || stats.all.topStages.length === 0) return '';
  const top = stats.all.topStages.slice(0, 4).map((stage) =>
    `${stage.stage} avg ${fmt(stage.avgMs)}ms/p95 ${fmt(stage.p95Ms)}ms`
  ).join(', ');
  const total = stats.all.stageMs.total;
  const totalPart = total !== undefined
    ? `total avg ${fmt(total.avg)}ms/p95 ${fmt(total.p95)}ms; `
    : '';
  return `${label} ${totalPart}top stages: ${top}`;
}

function formatSimStepPhaseEvidence(
  phases: SimStepPhaseTimingReport | undefined,
  label: string,
): string {
  if (phases === undefined) return '';
  const entries: Array<{ label: string; p95: number }> = [
    { label: 'simulation.update', p95: phases.simulationUpdateMs.p95 },
    { label: 'physics.step', p95: phases.physicsStepMs.p95 },
    { label: 'syncFromPhysics', p95: phases.syncFromPhysicsMs.p95 },
    { label: 'unitForces', p95: phases.unitForcesMs.p95 },
    { label: 'repairBefore', p95: phases.repairBeforeMs.p95 },
    { label: 'repairAfter', p95: phases.repairAfterMs.p95 },
    { label: 'factoryTurrets', p95: phases.factoryConstructionTurretMs.p95 },
    { label: 'projectileFinalize', p95: phases.projectileLaunchFinalizeMs.p95 },
    { label: 'commandQueue', p95: phases.commandQueueMs.p95 },
  ];
  entries.sort((a, b) => b.p95 - a.p95);
  const top = entries
    .slice(0, 4)
    .map((entry) => `${entry.label} p95 ${fmt(entry.p95)}ms`)
    .join(', ');
  return `${label} step phases top: ${top}`;
}

function formatSimUpdatePhaseEvidence(
  phases: SimUpdatePhaseTimingReport | undefined,
  label: string,
): string {
  if (phases === undefined) return '';
  const entries: Array<{ label: string; p95: number }> = [
    { label: 'unitMovement', p95: phases.unitMovementMs.p95 },
    { label: 'combat', p95: phases.combatMs.p95 },
    { label: 'unitGroundNormal', p95: phases.unitGroundNormalMs.p95 },
    { label: 'spatialGrid', p95: phases.spatialGridMs.p95 },
    { label: 'constructionLifecycle', p95: phases.constructionLifecycleMs.p95 },
    { label: 'factoryProduction', p95: phases.factoryProductionMs.p95 },
    { label: 'commanderAbilities', p95: phases.commanderAbilitiesMs.p95 },
    { label: 'buildingWindEconomy', p95: phases.buildingWindEconomyMs.p95 },
    { label: 'energyDistribution', p95: phases.energyDistributionMs.p95 },
    { label: 'idleBuilderAutoRepair', p95: phases.idleBuilderAutoRepairMs.p95 },
    { label: 'deadCleanup', p95: phases.deadCleanupMs.p95 },
    { label: 'commands', p95: phases.commandsMs.p95 },
  ];
  entries.sort((a, b) => b.p95 - a.p95);
  const top = entries
    .slice(0, 5)
    .map((entry) => `${entry.label} p95 ${fmt(entry.p95)}ms`)
    .join(', ');
  return `${label} Simulation.update phases top: ${top}`;
}

function formatSimCombatPhaseEvidence(
  phases: SimCombatPhaseTimingReport | undefined,
  label: string,
): string {
  if (phases === undefined) return '';
  const entries: Array<{ label: string; p95: number }> = [
    { label: 'projectileCollisions', p95: phases.projectileCollisionsMs.p95 },
    { label: 'updateProjectiles', p95: phases.updateProjectilesMs.p95 },
    { label: 'targetingFiring', p95: phases.targetingFiringMs.p95 },
    { label: 'stampTargeting', p95: phases.stampTargetingMs.p95 },
    { label: 'fireTurrets', p95: phases.fireTurretsMs.p95 },
    { label: 'turretRotation', p95: phases.turretRotationMs.p95 },
    { label: 'shieldState', p95: phases.shieldStateMs.p95 },
    { label: 'deathExplosion', p95: phases.deathExplosionMs.p95 },
    { label: 'projectileSpatialRefresh', p95: phases.projectileSpatialRefreshMs.p95 },
    { label: 'projectileEvents', p95: phases.projectileEventCullMs.p95 },
  ];
  entries.sort((a, b) => b.p95 - a.p95);
  const top = entries
    .slice(0, 5)
    .map((entry) => `${entry.label} p95 ${fmt(entry.p95)}ms`)
    .join(', ');
  return `${label} combat phases top: ${top}`;
}

function formatProjectileCollisionDetailEvidence(
  phases: SimCombatPhaseTimingReport | undefined,
  label: string,
): string {
  if (phases === undefined) return '';
  const entries: Array<{ label: string; p95: number }> = [
    { label: 'loop', p95: phases.collisionLoopMs.p95 },
    { label: 'hitboxSweep', p95: phases.collisionHitboxSweepMs.p95 },
    { label: 'splashDamage', p95: phases.collisionSplashDamageMs.p95 },
    { label: 'terminalPlan', p95: phases.collisionTerminalPlanMs.p95 },
    { label: 'beamDamage', p95: phases.collisionBeamDamageMs.p95 },
    { label: 'dgunDamage', p95: phases.collisionDgunDamageMs.p95 },
    { label: 'killedProjectileDetonation', p95: phases.collisionKilledProjectileDetonationMs.p95 },
    { label: 'submunitionSpawn', p95: phases.collisionSubmunitionSpawnMs.p95 },
    { label: 'setup', p95: phases.collisionSetupMs.p95 },
    { label: 'finalRemoval', p95: phases.collisionFinalRemovalMs.p95 },
  ];
  entries.sort((a, b) => b.p95 - a.p95);
  const top = entries
    .slice(0, 5)
    .map((entry) => `${entry.label} p95 ${fmt(entry.p95)}ms`)
    .join(', ');
  return `${label} projectile collision detail top: ${top}`;
}

function countCoreEntities(core: ReturnType<GameServer['getLockstepSimulationCore']>): {
  units: number;
  buildings: number;
  projectiles: number;
} {
  return {
    units: core.world.getUnits().length,
    buildings: core.world.getBuildings().length,
    projectiles: core.world.getProjectiles().length,
  };
}

function createSimStepPhaseTimingAccumulator(): SimStepPhaseTimingAccumulator {
  const accumulator = {} as SimStepPhaseTimingAccumulator;
  for (const key of SIM_STEP_PHASE_KEYS) {
    accumulator[key] = [];
  }
  return accumulator;
}

function recordSimStepPhaseTiming(
  accumulator: SimStepPhaseTimingAccumulator,
  timings: ServerSimulationStepPhaseTimings,
): void {
  for (const key of SIM_STEP_PHASE_KEYS) {
    accumulator[key].push(timings[key]);
  }
}

function summarizeSimStepPhaseTimings(
  accumulator: SimStepPhaseTimingAccumulator,
): SimStepPhaseTimingReport {
  const report = {} as SimStepPhaseTimingReport;
  for (const key of SIM_STEP_PHASE_KEYS) {
    report[key] = summarize(accumulator[key]);
  }
  return report;
}

function createSimUpdatePhaseTimingAccumulator(): SimUpdatePhaseTimingAccumulator {
  const accumulator = {} as SimUpdatePhaseTimingAccumulator;
  for (const key of SIM_UPDATE_PHASE_KEYS) {
    accumulator[key] = [];
  }
  return accumulator;
}

function recordSimUpdatePhaseTiming(
  accumulator: SimUpdatePhaseTimingAccumulator,
  timings: SimulationUpdatePhaseTimings,
): void {
  for (const key of SIM_UPDATE_PHASE_KEYS) {
    accumulator[key].push(timings[key]);
  }
}

function summarizeSimUpdatePhaseTimings(
  accumulator: SimUpdatePhaseTimingAccumulator,
): SimUpdatePhaseTimingReport {
  const report = {} as SimUpdatePhaseTimingReport;
  for (const key of SIM_UPDATE_PHASE_KEYS) {
    report[key] = summarize(accumulator[key]);
  }
  return report;
}

function createSimCombatPhaseTimingAccumulator(): SimCombatPhaseTimingAccumulator {
  const accumulator = {} as SimCombatPhaseTimingAccumulator;
  for (const key of SIM_COMBAT_PHASE_KEYS) {
    accumulator[key] = [];
  }
  return accumulator;
}

function recordSimCombatPhaseTiming(
  accumulator: SimCombatPhaseTimingAccumulator,
  timings: SimulationCombatPhaseTimings,
): void {
  for (const key of SIM_COMBAT_PHASE_KEYS) {
    accumulator[key].push(timings[key]);
  }
}

function summarizeSimCombatPhaseTimings(
  accumulator: SimCombatPhaseTimingAccumulator,
): SimCombatPhaseTimingReport {
  const report = {} as SimCombatPhaseTimingReport;
  for (const key of SIM_COMBAT_PHASE_KEYS) {
    report[key] = summarize(accumulator[key]);
  }
  return report;
}

function beginWasmBoundaryTracking(): void {
  WASM_BOUNDARY_INSTRUMENTATION.reset();
  WASM_BOUNDARY_INSTRUMENTATION.setEnabled(true);
}

function finishWasmBoundaryTracking(): WasmBoundaryInstrumentationReport {
  const report = WASM_BOUNDARY_INSTRUMENTATION.report();
  WASM_BOUNDARY_INSTRUMENTATION.setEnabled(false);
  return report;
}

const EMPTY_COMBAT_TARGETING_PROFILE: CombatTargetingProfileReport = {
  scheduleSources: 0,
  scheduleProcessed: 0,
  scheduleSkipped: 0,
  autoTicks: 0,
  reacquireDue: 0,
  spatialQueries: 0,
  candidateCells: 0,
  candidateSlotsVisited: 0,
  candidatesCollected: 0,
  chooseCalls: 0,
  chooseCandidateTests: 0,
  gateCalls: 0,
  gatePasses: 0,
};

function resetCombatTargetingProfile(): void {
  getSimWasm()?.combatTargeting.profileReset();
}

function readCombatTargetingProfile(): CombatTargetingProfileReport {
  const targeting = getSimWasm()?.combatTargeting;
  if (targeting === undefined) return EMPTY_COMBAT_TARGETING_PROFILE;
  const values = new Float64Array(targeting.profileLen());
  targeting.profileCopy(values);
  return {
    scheduleSources: values[0] ?? 0,
    scheduleProcessed: values[1] ?? 0,
    scheduleSkipped: values[2] ?? 0,
    autoTicks: values[3] ?? 0,
    reacquireDue: values[4] ?? 0,
    spatialQueries: values[5] ?? 0,
    candidateCells: values[6] ?? 0,
    candidateSlotsVisited: values[7] ?? 0,
    candidatesCollected: values[8] ?? 0,
    chooseCalls: values[9] ?? 0,
    chooseCandidateTests: values[10] ?? 0,
    gateCalls: values[11] ?? 0,
    gatePasses: values[12] ?? 0,
  };
}

function createMemoryTracker(): {
  sample(): void;
  finish(): MemoryReport;
} {
  const samples: MemorySample[] = [sampleMemory()];
  return {
    sample(): void {
      samples.push(sampleMemory());
    },
    finish(): MemoryReport {
      samples.push(sampleMemory());
      return summarizeMemory(samples);
    },
  };
}

function sampleMemory(): MemorySample {
  const heap = (
    performance as Performance & {
      memory?: {
        usedJSHeapSize?: number;
        totalJSHeapSize?: number;
      };
    }
  ).memory;
  const wasm = getSimWasm();
  return {
    jsHeapUsedBytes: finiteOrNull(heap?.usedJSHeapSize),
    jsHeapTotalBytes: finiteOrNull(heap?.totalJSHeapSize),
    wasmMemoryBytes: finiteOrNull(wasm?.memory.buffer.byteLength),
  };
}

function summarizeMemory(samples: readonly MemorySample[]): MemoryReport {
  const jsHeapUsed = samples
    .map((sample) => sample.jsHeapUsedBytes)
    .filter((value): value is number => value !== null);
  const jsHeapTotal = samples
    .map((sample) => sample.jsHeapTotalBytes)
    .filter((value): value is number => value !== null);
  const wasmMemory = samples
    .map((sample) => sample.wasmMemoryBytes)
    .filter((value): value is number => value !== null);
  return {
    jsHeapSupported: jsHeapUsed.length > 0 || jsHeapTotal.length > 0,
    wasmMemorySupported: wasmMemory.length > 0,
    jsHeapUsedBytes: summarize(jsHeapUsed),
    jsHeapTotalBytes: summarize(jsHeapTotal),
    wasmMemoryBytes: summarize(wasmMemory),
    jsHeapUsedDeltaBytes: deltaOrNull(jsHeapUsed),
    wasmMemoryDeltaBytes: deltaOrNull(wasmMemory),
  };
}

function finiteOrNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function deltaOrNull(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  return values[values.length - 1] - values[0];
}

function maxNullable(current: number | null, ...values: readonly number[]): number | null {
  let max = current;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

function summarize(values: readonly number[]): NumericSummary {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  let total = 0;
  for (let i = 0; i < finite.length; i++) total += finite[i];
  return {
    avg: total / finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite[finite.length - 1],
  };
}

const EMPTY_SNAPSHOT_TRAFFIC_COUNTERS: SnapshotTrafficCounters = {
  total: 0,
  rich: 0,
  delta: 0,
  entityDelta: 0,
  projectileDelta: 0,
};

function diffSnapshotTrafficCounters(
  end: SnapshotTrafficCounters,
  start: SnapshotTrafficCounters,
): SnapshotTrafficCounters {
  return {
    total: Math.max(0, end.total - start.total),
    rich: Math.max(0, end.rich - start.rich),
    delta: Math.max(0, end.delta - start.delta),
    entityDelta: Math.max(0, end.entityDelta - start.entityDelta),
    projectileDelta: Math.max(0, end.projectileDelta - start.projectileDelta),
  };
}

function snapshotTrafficRates(
  counts: SnapshotTrafficCounters,
  measuredSeconds: number,
): SnapshotTrafficMeasuredRates {
  const seconds = Math.max(0.001, measuredSeconds);
  return {
    measuredSeconds: seconds,
    total: counts.total / seconds,
    rich: counts.rich / seconds,
    delta: counts.delta / seconds,
    entityDelta: counts.entityDelta / seconds,
    projectileDelta: counts.projectileDelta / seconds,
  };
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * p) - 1),
  );
  return sortedValues[index];
}

function mapWorldSize(mapCells: number): number {
  return mapCells * LAND_CELL_SIZE;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function yieldToBrowser(): Promise<void> {
  return waitMs(50);
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'n/a';
}
