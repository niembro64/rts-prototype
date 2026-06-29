import { LAND_CELL_SIZE } from '../../config';
import { ARCHITECTURE_CONFIG } from '../../architectureConfig';
import type { GameServerConfig } from '../../types/game';
import type { PlayerId } from '../../types/sim';
import { createGame, destroyGame, type GameInstance } from '../createGame';
import { ClientViewState } from '../network/ClientViewState';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import {
  getSnapshotMaterializationMetadata,
  SNAPSHOT_MATERIALIZATION_STAGES,
  type SnapshotMaterializationKind,
  type SnapshotMaterializationMetadata,
  type SnapshotMaterializationStage,
} from '../network/snapshotMaterializationMetadata';
import { getSnapshotWireBytes } from '../network/snapshotWireMetadata';
import { LocalGameConnection } from '../server/LocalGameConnection';
import { GameServer } from '../server/GameServer';
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
  readonly memory: MemoryReport;
  readonly wasmBoundary: WasmBoundaryInstrumentationReport;
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
  readonly snapshotMainThreadMsPerSecond: number;
  readonly memory: MemoryReport;
  readonly wasmBoundary: WasmBoundaryInstrumentationReport;
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
  readonly drawCalls: NumericSummary;
  readonly triangles: NumericSummary;
  readonly bufferUploadBytes: NumericSummary;
  readonly bufferUploadCalls: NumericSummary;
  readonly renderBudgetTier: string;
  readonly renderBudgetTierIndex: NumericSummary;
  readonly renderBudgetLodDistanceScale: NumericSummary;
  readonly renderBudgetEmissionLodDistanceScale: NumericSummary;
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
  readonly renderPhaseUnitLodProxyRows: NumericSummary;
  readonly renderPhaseBuildingLodProxyRows: NumericSummary;
  readonly renderPhaseProjectileRows: NumericSummary;
  readonly renderPhaseLineProjectileRows: NumericSummary;
  readonly longtaskMsPerSec: NumericSummary;
  readonly snapshotBytes: NumericSummary;
  readonly memory: MemoryReport;
  readonly wasmBoundary: WasmBoundaryInstrumentationReport;
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
    const wasmBoundary = finishWasmBoundaryTracking();
    return {
      ...countCoreEntities(core),
      measuredTicks: options.ticks,
      wallMs,
      stepMs,
      simCeilingTpsP95: stepMs.p95 > 0 ? 1000 / stepMs.p95 : 0,
      fixedStepUtilPctP95: (stepMs.p95 / fixedStepMs) * 100,
      memory: memory.finish(),
      wasmBoundary,
    };
  } finally {
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
      snapshotMainThreadMsPerSecond:
        snapshotTotalMs.avg * (1000 / (fixedStepMs * options.snapshotEveryTicks)),
      memory: memory.finish(),
      wasmBoundary,
      snapshotMaterializationStats,
      snapshotWireStats,
    };
  } finally {
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
  const connection = new LocalGameConnection(server, LOCAL_PLAYER_ID, 'local-offline', {
    ...LOCAL_PRESENTATION_CONNECTION_OPTIONS,
  });
  const clientViewState = new ClientViewState();
  const mapSize = mapWorldSize(options.mapCells);
  clientViewState.setMapDimensions(mapSize, mapSize);
  let game: GameInstance | null = null;

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

    await waitMs(options.warmupSeconds * 1000);
    const measurementStartScene = game.getScene();
    const snapshotReceivedCounterStart =
      measurementStartScene?.getReceivedSnapshotCounters() ?? EMPTY_SNAPSHOT_TRAFFIC_COUNTERS;
    const snapshotAppliedCounterStart =
      measurementStartScene?.getSnapshotCounters() ?? EMPTY_SNAPSHOT_TRAFFIC_COUNTERS;
    const measurementStartMs = performance.now();

    const memory = createMemoryTracker();
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
    const renderBudgetLodDistanceScale: number[] = [];
    const renderBudgetEmissionLodDistanceScale: number[] = [];
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
    const renderPhaseUnitLodProxyRows: number[] = [];
    const renderPhaseBuildingLodProxyRows: number[] = [];
    const renderPhaseProjectileRows: number[] = [];
    const renderPhaseLineProjectileRows: number[] = [];
    const longtaskMsPerSec: number[] = [];
    const snapshotBytes: number[] = [];
    const snapshotMaterializationSamples = createSnapshotMaterializationAccumulator();
    const drainedSnapshotMaterialization: SnapshotMaterializationMetadata[] = [];
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
      renderBudgetLodDistanceScale.push(timing.renderBudgetLodDistanceScale);
      renderBudgetEmissionLodDistanceScale.push(timing.renderBudgetEmissionLodDistanceScale);
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
      renderPhaseUnitLodProxyRows.push(timing.renderPhaseUnitLodProxyRows);
      renderPhaseBuildingLodProxyRows.push(timing.renderPhaseBuildingLodProxyRows);
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
      drawCalls: summarize(drawCalls),
      triangles: summarize(triangles),
      bufferUploadBytes: summarize(bufferUploadBytes),
      bufferUploadCalls: summarize(bufferUploadCalls),
      renderBudgetTier,
      renderBudgetTierIndex: summarize(renderBudgetTierIndex),
      renderBudgetLodDistanceScale: summarize(renderBudgetLodDistanceScale),
      renderBudgetEmissionLodDistanceScale: summarize(renderBudgetEmissionLodDistanceScale),
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
      renderPhaseUnitLodProxyRows: summarize(renderPhaseUnitLodProxyRows),
      renderPhaseBuildingLodProxyRows: summarize(renderPhaseBuildingLodProxyRows),
      renderPhaseProjectileRows: summarize(renderPhaseProjectileRows),
      renderPhaseLineProjectileRows: summarize(renderPhaseLineProjectileRows),
      longtaskMsPerSec: summarize(longtaskMsPerSec),
      snapshotBytes: summarize(snapshotBytes),
      memory: memory.finish(),
      wasmBoundary,
      snapshotMaterializationStats,
      snapshotWireStats,
    };
  } finally {
    finishWasmBoundaryTracking();
    if (game !== null) destroyGame(game);
    else connection.disconnect();
    server.stop();
    parent.remove();
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
  bucket.entityTypedRows.length = 0;
  bucket.entityTypedPlaceholderRows.length = 0;
  bucket.removedRows.length = 0;
  bucket.projectileRows.length = 0;
  for (let i = 0; i < SNAPSHOT_MATERIALIZATION_STAGES.length; i++) {
    bucket.stages[SNAPSHOT_MATERIALIZATION_STAGES[i]].length = 0;
  }
}

function recordSnapshotMaterializationBucket(
  bucket: SnapshotMaterializationBucket,
  metadata: SnapshotMaterializationMetadata,
  clientApplyMs: number,
): void {
  bucket.samples++;
  bucket.entityRows.push(metadata.entityRows);
  bucket.entityDtoRows.push(metadata.entityDtoRows);
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
    metalDepositStep: 0,
    terrainDetail: 1,
    mapWidthLandCells: options.mapCells,
    mapLengthLandCells: options.mapCells,
    backgroundMode: true,
    aiPlayerIds: PLAYER_IDS,
    spawnDemoInitialState: true,
    initialMaxTotalUnits: options.unitCap,
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
    nextChecks.push('Profile ServerSimulationCore.stepFixedTick by subsystem: targeting, physics, pathing, fog, projectiles.');
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

function beginWasmBoundaryTracking(): void {
  WASM_BOUNDARY_INSTRUMENTATION.reset();
  WASM_BOUNDARY_INSTRUMENTATION.setEnabled(true);
}

function finishWasmBoundaryTracking(): WasmBoundaryInstrumentationReport {
  const report = WASM_BOUNDARY_INSTRUMENTATION.report();
  WASM_BOUNDARY_INSTRUMENTATION.setEnabled(false);
  return report;
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
