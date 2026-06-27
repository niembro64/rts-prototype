import { LAND_CELL_SIZE } from '../../config';
import { ARCHITECTURE_CONFIG } from '../../architectureConfig';
import type { GameServerConfig } from '../../types/game';
import type { PlayerId } from '../../types/sim';
import { createGame, destroyGame, type GameInstance } from '../createGame';
import { ClientViewState } from '../network/ClientViewState';
import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import { getSnapshotWireBytes } from '../network/snapshotWireMetadata';
import { LocalGameConnection } from '../server/LocalGameConnection';
import { GameServer } from '../server/GameServer';
import { SNAPSHOT_ENCODE_INSTRUMENTATION } from '../SnapshotEncodeInstrumentation';

type NumericSummary = {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
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

export type PerformanceBottleneckHarnessReport = {
  readonly schema: 'budget-annihilation.performance-bottleneck-harness.v1';
  readonly options: Required<PerformanceBottleneckHarnessOptions>;
  readonly environment: {
    readonly userAgent: string;
    readonly devicePixelRatio: number;
    readonly fixedStepHz: number;
    readonly fixedStepMs: number;
    readonly frameBudgetMs60: number;
  };
  readonly simOnly: SimOnlyReport;
  readonly simSnapshot: SimSnapshotReport;
  readonly fullStack: FullStackReport;
  readonly diagnosis: BottleneckDiagnosis;
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
  readonly snapshotWireStats?: SnapshotWireStatsReport;
};

type SnapshotWireStatsReport = {
  readonly rows: readonly unknown[];
  readonly breakdowns: readonly unknown[];
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

const PLAYER_IDS = [1 as PlayerId, 2 as PlayerId];
const LOCAL_PLAYER_ID = 1 as PlayerId;

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

    const samples: number[] = [];
    const wallStart = performance.now();
    for (let i = 0; i < options.ticks; i++) {
      const start = performance.now();
      core.stepFixedTick(fixedStepMs);
      samples.push(performance.now() - start);
    }
    const wallMs = performance.now() - wallStart;
    const stepMs = summarize(samples);
    return {
      ...countCoreEntities(core),
      measuredTicks: options.ticks,
      wallMs,
      stepMs,
      simCeilingTpsP95: stepMs.p95 > 0 ? 1000 / stepMs.p95 : 0,
      fixedStepUtilPctP95: (stepMs.p95 / fixedStepMs) * 100,
    };
  } finally {
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
    loopbackSnapshotsThroughWire: true,
    sharesAuthoritativeState: true,
  });
  const view = new ClientViewState();
  view.setMapDimensions(mapWorldSize(options.mapCells), mapWorldSize(options.mapCells));

  const applySamples: number[] = [];
  const byteSamples: number[] = [];
  const unsubscribe = connection.onSnapshot((snapshot: NetworkServerSnapshot) => {
    const applyStart = performance.now();
    view.applyNetworkState(snapshot, { syncEconomy: false });
    applySamples.push(performance.now() - applyStart);
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

    const stepSamples: number[] = [];
    const snapshotSamples: number[] = [];
    for (let i = 0; i < options.ticks; i++) {
      const stepStart = performance.now();
      core.stepFixedTick(fixedStepMs);
      stepSamples.push(performance.now() - stepStart);
      if (i % options.snapshotEveryTicks === 0) {
        const snapshotStart = performance.now();
        server.emitLockstepPresentationSnapshot();
        snapshotSamples.push(performance.now() - snapshotStart);
      }
    }

    const stepMs = summarize(stepSamples);
    const snapshotTotalMs = summarize(snapshotSamples);
    const snapshotWireStats = readSnapshotWireStats();
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
      snapshotWireStats,
    };
  } finally {
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
    loopbackSnapshotsThroughWire: true,
    sharesAuthoritativeState: true,
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

    const frameMs: number[] = [];
    const logicMs: number[] = [];
    const renderPrepMs: number[] = [];
    const gpuMs: number[] = [];
    const renderTpsAvg: number[] = [];
    const renderTpsLow: number[] = [];
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
    let runtimeProfile = 'unknown';
    let gpuTimerSupported = false;
    let activePixelRatio = 1;
    let nativePixelRatio = 1;
    let renderBudgetTier = 'normal';

    const deadline = performance.now() + options.seconds * 1000;
    while (performance.now() < deadline) {
      await waitMs(250);
      const scene = game.getScene();
      if (scene === null) continue;
      const timing = scene.getFrameTiming();
      const renderTps = scene.getRenderTpsStats();
      const meta = clientViewState.getServerMeta();
      const snapSize = scene.getSnapshotPayloadSizeStats();

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
    }

    const snapshotWireStats = readSnapshotWireStats();
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
      snapshotWireStats,
    };
  } finally {
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
    nextChecks.push('Split snapshot emit into visibility, DTO materialization, wire encode/decode, and ClientViewState.applyNetworkState.');
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
