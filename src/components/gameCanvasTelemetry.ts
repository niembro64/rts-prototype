import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { GameScene } from '../game/createGame';
import { getRendererContextTelemetry } from '../game/render3d/RendererContextBudget';

type GameCanvasTelemetryOptions = {
  getScene: () => GameScene | null;
};

type RenderProfileSample = {
  readonly timestampMs: number;
  readonly runtimeProfile: string;
  readonly frameMsAvg: number;
  readonly frameMsHi: number;
  readonly logicMsAvg: number;
  readonly logicMsHi: number;
  readonly renderPrepMsAvg: number;
  readonly renderPrepMsHi: number;
  readonly gpuMs: number;
  readonly gpuSource: string;
  readonly gpuTimerSupported: boolean;
  readonly webglRendererRenderMs: number;
  readonly webglDrawCalls: number;
  readonly webglTriangles: number;
  readonly webglPoints: number;
  readonly webglLines: number;
  readonly webglGeometries: number;
  readonly webglTextures: number;
  readonly webglBufferProfilerSupported: boolean;
  readonly webglBufferDataCalls: number;
  readonly webglBufferSubDataCalls: number;
  readonly webglBufferUploadBytes: number;
  readonly longtaskSupported: boolean;
  readonly longtaskMsPerSec: number;
  readonly renderTpsAvg: number;
  readonly renderTpsWorst: number;
  readonly scopedRetainedUnitMeshes: number;
  readonly scopedRetainedBuildingMeshes: number;
  readonly scopedMeshDestroyPerSec: number;
  readonly scopedMeshRebuildPerSec: number;
  readonly activePixelRatio: number;
  readonly nativePixelRatio: number;
  readonly dynamicPixelRatioEnabled: boolean;
};

type RenderProfileApi = {
  readonly sample: () => RenderProfileSample;
};

function setRefIfChanged<T>(target: { value: T }, value: T): void {
  if (!Object.is(target.value, value)) target.value = value;
}

function setNumberRefIfChanged(target: { value: number }, value: number, epsilon = 0.01): void {
  if (!Number.isFinite(value)) return;
  if (Math.abs(target.value - value) > epsilon) target.value = value;
}

export function useGameCanvasTelemetry({
  getScene,
}: GameCanvasTelemetryOptions) {
  const frameMsAvg = ref(0);
  const frameMsHi = ref(0);
  const renderMsAvg = ref(0);
  const renderMsHi = ref(0);
  const logicMsAvg = ref(0);
  const logicMsHi = ref(0);
  const gpuTimerMs = ref(0);
  const gpuTimerSupported = ref(false);
  const runtimeProfile = ref('browser-desktop');
  const nativePixelRatio = ref(1);
  const activePixelRatio = ref(1);
  const dynamicPixelRatioEnabled = ref(false);
  const webglBufferProfilerSupported = ref(false);
  const webglRendererRenderMs = ref(0);
  const webglDrawCalls = ref(0);
  const webglTriangles = ref(0);
  const webglPoints = ref(0);
  const webglLines = ref(0);
  const webglGeometries = ref(0);
  const webglTextures = ref(0);
  const webglBufferDataCalls = ref(0);
  const webglBufferSubDataCalls = ref(0);
  const webglBufferUploadBytes = ref(0);
  const rendererContextMainCount = ref(0);
  const rendererContextAuxiliaryCount = ref(0);
  const rendererContextAuxiliaryBudget = ref(0);
  const rendererContextDeniedAuxiliaryCount = ref(0);
  const hudSpriteActiveCount = ref(0);
  const hudSpriteRetainedCount = ref(0);
  const hudSpritePeakCount = ref(0);
  const hudSpriteDisposedCount = ref(0);
  const hudSpriteBudgetCount = ref(0);
  const scopedRetainedUnitMeshes = ref(0);
  const scopedRetainedBuildingMeshes = ref(0);
  const scopedMeshHiddenPerSec = ref(0);
  const scopedMeshReactivatedPerSec = ref(0);
  const scopedMeshDestroyPerSec = ref(0);
  const scopedMeshRebuildPerSec = ref(0);
  const longtaskMsPerSec = ref(0);
  const longtaskSupported = ref(false);
  const renderTpsAvg = ref(0);
  const renderTpsWorst = ref(0);
  const snapAvgRate = ref(0);
  const snapWorstRate = ref(0);
  const rawSnapshotReceivedRate = ref(0);
  const rawSnapshotAppliedRate = ref(0);
  const richSnapAvgRate = ref(0);
  const richSnapWorstRate = ref(0);
  const deltaSnapAvgRate = ref(0);
  const deltaSnapWorstRate = ref(0);
  const entityDeltaSnapAvgRate = ref(0);
  const entityDeltaSnapWorstRate = ref(0);
  const projectileDeltaSnapAvgRate = ref(0);
  const projectileDeltaSnapWorstRate = ref(0);
  const snapshotSizeAvgBytes = ref(0);
  const snapshotSizeHiBytes = ref(0);
  const richSnapshotSizeAvgBytes = ref(0);
  const richSnapshotSizeHiBytes = ref(0);
  const deltaSnapshotSizeAvgBytes = ref(0);
  const deltaSnapshotSizeHiBytes = ref(0);
  const entityDeltaSnapshotSizeAvgBytes = ref(0);
  const entityDeltaSnapshotSizeHiBytes = ref(0);
  const projectileDeltaSnapshotSizeAvgBytes = ref(0);
  const projectileDeltaSnapshotSizeHiBytes = ref(0);
  const snapshotApplyAvgMs = ref(0);
  const snapshotApplyHiMs = ref(0);
  const richSnapshotApplyAvgMs = ref(0);
  const richSnapshotApplyHiMs = ref(0);
  const deltaSnapshotApplyAvgMs = ref(0);
  const deltaSnapshotApplyHiMs = ref(0);
  const entityDeltaSnapshotApplyAvgMs = ref(0);
  const entityDeltaSnapshotApplyHiMs = ref(0);
  const projectileDeltaSnapshotApplyAvgMs = ref(0);
  const projectileDeltaSnapshotApplyHiMs = ref(0);
  const currentZoom = ref(0.4);
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  let renderProfileApi: RenderProfileApi | null = null;
  let lastSnapshotCounterSampleMs = 0;
  let lastReceivedSnapshotTotal = 0;
  let lastAppliedSnapshotTotal = 0;

  const displayGpuMs = computed(() =>
    gpuTimerSupported.value ? gpuTimerMs.value : renderMsAvg.value,
  );
  const gpuSourceLabel = computed(() =>
    gpuTimerSupported.value ? 'GPU time query' : 'renderer.render() wall-clock',
  );

  function update(): void {
    const rendererContexts = getRendererContextTelemetry();
    setNumberRefIfChanged(rendererContextMainCount, rendererContexts.activeMainCount, 0);
    setNumberRefIfChanged(rendererContextAuxiliaryCount, rendererContexts.activeAuxiliaryCount, 0);
    setNumberRefIfChanged(rendererContextAuxiliaryBudget, rendererContexts.auxiliaryBudget, 0);
    setNumberRefIfChanged(
      rendererContextDeniedAuxiliaryCount,
      rendererContexts.deniedAuxiliaryCount,
      0,
    );

    const scene = getScene();
    if (scene) {
      // Display camera altitude: distance from the y=0 ground plane along its normal.
      setNumberRefIfChanged(currentZoom, scene.cameras.main.altitude ?? scene.cameras.main.zoom, 0.05);

      const timing = scene.getFrameTiming();
      setNumberRefIfChanged(frameMsAvg, timing.frameMsAvg);
      setNumberRefIfChanged(frameMsHi, timing.frameMsHi);
      setNumberRefIfChanged(renderMsAvg, timing.renderMsAvg);
      setNumberRefIfChanged(renderMsHi, timing.renderMsHi);
      setNumberRefIfChanged(logicMsAvg, timing.logicMsAvg);
      setNumberRefIfChanged(logicMsHi, timing.logicMsHi);
      setNumberRefIfChanged(gpuTimerMs, timing.gpuTimerMs);
      setRefIfChanged(gpuTimerSupported, timing.gpuTimerSupported);
      setRefIfChanged(runtimeProfile, timing.runtimeProfile);
      setNumberRefIfChanged(nativePixelRatio, timing.nativePixelRatio, 0.001);
      setNumberRefIfChanged(activePixelRatio, timing.activePixelRatio, 0.001);
      setRefIfChanged(dynamicPixelRatioEnabled, timing.dynamicPixelRatioEnabled);
      setRefIfChanged(webglBufferProfilerSupported, timing.webglBufferProfilerSupported);
      setNumberRefIfChanged(webglRendererRenderMs, timing.webglRendererRenderMs);
      setNumberRefIfChanged(webglDrawCalls, timing.webglDrawCalls, 0);
      setNumberRefIfChanged(webglTriangles, timing.webglTriangles, 0);
      setNumberRefIfChanged(webglPoints, timing.webglPoints, 0);
      setNumberRefIfChanged(webglLines, timing.webglLines, 0);
      setNumberRefIfChanged(webglGeometries, timing.webglGeometries, 0);
      setNumberRefIfChanged(webglTextures, timing.webglTextures, 0);
      setNumberRefIfChanged(webglBufferDataCalls, timing.webglBufferDataCalls, 0);
      setNumberRefIfChanged(webglBufferSubDataCalls, timing.webglBufferSubDataCalls, 0);
      setNumberRefIfChanged(webglBufferUploadBytes, timing.webglBufferUploadBytes, 1);
      setNumberRefIfChanged(longtaskMsPerSec, timing.longtaskMsPerSec);
      setRefIfChanged(longtaskSupported, timing.longtaskSupported);

      const renderTpsStats = scene.getRenderTpsStats();
      setNumberRefIfChanged(renderTpsAvg, renderTpsStats.avgRate, 0.05);
      setNumberRefIfChanged(renderTpsWorst, renderTpsStats.worstRate, 0.05);

      const hudSprites = scene.getHudSpriteTelemetry();
      setNumberRefIfChanged(hudSpriteActiveCount, hudSprites.activeSlots, 0);
      setNumberRefIfChanged(hudSpriteRetainedCount, hudSprites.retainedSlots, 0);
      setNumberRefIfChanged(hudSpritePeakCount, hudSprites.peakRetainedSlots, 0);
      setNumberRefIfChanged(hudSpriteDisposedCount, hudSprites.disposedSlots, 0);
      setNumberRefIfChanged(hudSpriteBudgetCount, hudSprites.maxRetainedSlots, 0);

      const scopedMeshes = scene.getScopedMeshRetentionTelemetry();
      setNumberRefIfChanged(scopedRetainedUnitMeshes, scopedMeshes.retainedUnitMeshes, 0);
      setNumberRefIfChanged(scopedRetainedBuildingMeshes, scopedMeshes.retainedBuildingMeshes, 0);
      setNumberRefIfChanged(
        scopedMeshHiddenPerSec,
        scopedMeshes.unitHiddenPerSec + scopedMeshes.buildingHiddenPerSec,
        0.05,
      );
      setNumberRefIfChanged(
        scopedMeshReactivatedPerSec,
        scopedMeshes.unitReactivatedPerSec + scopedMeshes.buildingReactivatedPerSec,
        0.05,
      );
      setNumberRefIfChanged(
        scopedMeshDestroyPerSec,
        scopedMeshes.unitScopedDestroyPerSec + scopedMeshes.buildingScopedDestroyPerSec,
        0.05,
      );
      setNumberRefIfChanged(
        scopedMeshRebuildPerSec,
        scopedMeshes.unitScopedRebuildPerSec + scopedMeshes.buildingScopedRebuildPerSec,
        0.05,
      );

      const snapStats = scene.getSnapshotStats();
      setNumberRefIfChanged(snapAvgRate, snapStats.avgRate, 0.05);
      setNumberRefIfChanged(snapWorstRate, snapStats.worstRate, 0.05);
      setNumberRefIfChanged(richSnapAvgRate, snapStats.rich.avgRate, 0.05);
      setNumberRefIfChanged(richSnapWorstRate, snapStats.rich.worstRate, 0.05);
      setNumberRefIfChanged(deltaSnapAvgRate, snapStats.delta.avgRate, 0.05);
      setNumberRefIfChanged(deltaSnapWorstRate, snapStats.delta.worstRate, 0.05);
      setNumberRefIfChanged(entityDeltaSnapAvgRate, snapStats.entityDelta.avgRate, 0.05);
      setNumberRefIfChanged(entityDeltaSnapWorstRate, snapStats.entityDelta.worstRate, 0.05);
      setNumberRefIfChanged(projectileDeltaSnapAvgRate, snapStats.projectileDelta.avgRate, 0.05);
      setNumberRefIfChanged(projectileDeltaSnapWorstRate, snapStats.projectileDelta.worstRate, 0.05);

      const now = performance.now();
      const receivedSnapshotCounters = scene.getReceivedSnapshotCounters();
      const appliedSnapshotCounters = scene.getSnapshotCounters();
      if (lastSnapshotCounterSampleMs > 0 && now > lastSnapshotCounterSampleMs) {
        const seconds = (now - lastSnapshotCounterSampleMs) / 1000;
        if (seconds > 0) {
          setNumberRefIfChanged(
            rawSnapshotReceivedRate,
            Math.max(0, receivedSnapshotCounters.total - lastReceivedSnapshotTotal) / seconds,
            0.05,
          );
          setNumberRefIfChanged(
            rawSnapshotAppliedRate,
            Math.max(0, appliedSnapshotCounters.total - lastAppliedSnapshotTotal) / seconds,
            0.05,
          );
        }
      }
      lastSnapshotCounterSampleMs = now;
      lastReceivedSnapshotTotal = receivedSnapshotCounters.total;
      lastAppliedSnapshotTotal = appliedSnapshotCounters.total;

      const payloadSizeStats = scene.getSnapshotPayloadSizeStats();
      setNumberRefIfChanged(snapshotSizeAvgBytes, payloadSizeStats.avgBytes, 1);
      setNumberRefIfChanged(snapshotSizeHiBytes, payloadSizeStats.hiBytes, 1);
      setNumberRefIfChanged(richSnapshotSizeAvgBytes, payloadSizeStats.rich.avgBytes, 1);
      setNumberRefIfChanged(richSnapshotSizeHiBytes, payloadSizeStats.rich.hiBytes, 1);
      setNumberRefIfChanged(deltaSnapshotSizeAvgBytes, payloadSizeStats.delta.avgBytes, 1);
      setNumberRefIfChanged(deltaSnapshotSizeHiBytes, payloadSizeStats.delta.hiBytes, 1);
      setNumberRefIfChanged(entityDeltaSnapshotSizeAvgBytes, payloadSizeStats.entityDelta.avgBytes, 1);
      setNumberRefIfChanged(entityDeltaSnapshotSizeHiBytes, payloadSizeStats.entityDelta.hiBytes, 1);
      setNumberRefIfChanged(projectileDeltaSnapshotSizeAvgBytes, payloadSizeStats.projectileDelta.avgBytes, 1);
      setNumberRefIfChanged(projectileDeltaSnapshotSizeHiBytes, payloadSizeStats.projectileDelta.hiBytes, 1);

      const applyStats = scene.getSnapshotApplyStats();
      setNumberRefIfChanged(snapshotApplyAvgMs, applyStats.total.avgMs, 0.01);
      setNumberRefIfChanged(snapshotApplyHiMs, applyStats.total.hiMs, 0.01);
      setNumberRefIfChanged(richSnapshotApplyAvgMs, applyStats.rich.avgMs, 0.01);
      setNumberRefIfChanged(richSnapshotApplyHiMs, applyStats.rich.hiMs, 0.01);
      setNumberRefIfChanged(deltaSnapshotApplyAvgMs, applyStats.delta.avgMs, 0.01);
      setNumberRefIfChanged(deltaSnapshotApplyHiMs, applyStats.delta.hiMs, 0.01);
      setNumberRefIfChanged(entityDeltaSnapshotApplyAvgMs, applyStats.entityDelta.avgMs, 0.01);
      setNumberRefIfChanged(entityDeltaSnapshotApplyHiMs, applyStats.entityDelta.hiMs, 0.01);
      setNumberRefIfChanged(projectileDeltaSnapshotApplyAvgMs, applyStats.projectileDelta.avgMs, 0.01);
      setNumberRefIfChanged(projectileDeltaSnapshotApplyHiMs, applyStats.projectileDelta.hiMs, 0.01);
    }
  }

  function sampleRenderProfile(): RenderProfileSample {
    return {
      timestampMs: performance.now(),
      runtimeProfile: runtimeProfile.value,
      frameMsAvg: frameMsAvg.value,
      frameMsHi: frameMsHi.value,
      logicMsAvg: logicMsAvg.value,
      logicMsHi: logicMsHi.value,
      renderPrepMsAvg: renderMsAvg.value,
      renderPrepMsHi: renderMsHi.value,
      gpuMs: displayGpuMs.value,
      gpuSource: gpuSourceLabel.value,
      gpuTimerSupported: gpuTimerSupported.value,
      webglRendererRenderMs: webglRendererRenderMs.value,
      webglDrawCalls: webglDrawCalls.value,
      webglTriangles: webglTriangles.value,
      webglPoints: webglPoints.value,
      webglLines: webglLines.value,
      webglGeometries: webglGeometries.value,
      webglTextures: webglTextures.value,
      webglBufferProfilerSupported: webglBufferProfilerSupported.value,
      webglBufferDataCalls: webglBufferDataCalls.value,
      webglBufferSubDataCalls: webglBufferSubDataCalls.value,
      webglBufferUploadBytes: webglBufferUploadBytes.value,
      longtaskSupported: longtaskSupported.value,
      longtaskMsPerSec: longtaskMsPerSec.value,
      renderTpsAvg: renderTpsAvg.value,
      renderTpsWorst: renderTpsWorst.value,
      scopedRetainedUnitMeshes: scopedRetainedUnitMeshes.value,
      scopedRetainedBuildingMeshes: scopedRetainedBuildingMeshes.value,
      scopedMeshDestroyPerSec: scopedMeshDestroyPerSec.value,
      scopedMeshRebuildPerSec: scopedMeshRebuildPerSec.value,
      activePixelRatio: activePixelRatio.value,
      nativePixelRatio: nativePixelRatio.value,
      dynamicPixelRatioEnabled: dynamicPixelRatioEnabled.value,
    };
  }

  onMounted(() => {
    updateInterval = setInterval(update, 100);
    if (typeof window !== 'undefined') {
      renderProfileApi = { sample: sampleRenderProfile };
      (window as unknown as { __BA_RENDER_PROFILE__?: RenderProfileApi })
        .__BA_RENDER_PROFILE__ = renderProfileApi;
    }
  });

  onUnmounted(() => {
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
    if (
      typeof window !== 'undefined' &&
      renderProfileApi !== null &&
      (window as unknown as { __BA_RENDER_PROFILE__?: RenderProfileApi })
        .__BA_RENDER_PROFILE__ === renderProfileApi
    ) {
      delete (window as unknown as { __BA_RENDER_PROFILE__?: RenderProfileApi })
        .__BA_RENDER_PROFILE__;
    }
    renderProfileApi = null;
  });

  return {
    currentZoom,
    displayGpuMs,
    frameMsAvg,
    frameMsHi,
    gpuSourceLabel,
    gpuTimerSupported,
    runtimeProfile,
    nativePixelRatio,
    activePixelRatio,
    dynamicPixelRatioEnabled,
    webglBufferProfilerSupported,
    webglRendererRenderMs,
    webglDrawCalls,
    webglTriangles,
    webglPoints,
    webglLines,
    webglGeometries,
    webglTextures,
    webglBufferDataCalls,
    webglBufferSubDataCalls,
    webglBufferUploadBytes,
    hudSpriteActiveCount,
    hudSpriteBudgetCount,
    hudSpriteDisposedCount,
    hudSpritePeakCount,
    hudSpriteRetainedCount,
    scopedMeshDestroyPerSec,
    scopedMeshHiddenPerSec,
    scopedMeshReactivatedPerSec,
    scopedMeshRebuildPerSec,
    scopedRetainedBuildingMeshes,
    scopedRetainedUnitMeshes,
    rendererContextAuxiliaryBudget,
    rendererContextAuxiliaryCount,
    rendererContextDeniedAuxiliaryCount,
    rendererContextMainCount,
    logicMsAvg,
    logicMsHi,
    longtaskMsPerSec,
    longtaskSupported,
    renderMsAvg,
    renderMsHi,
    renderTpsAvg,
    renderTpsWorst,
    snapAvgRate,
    snapWorstRate,
    rawSnapshotReceivedRate,
    rawSnapshotAppliedRate,
    richSnapAvgRate,
    richSnapWorstRate,
    deltaSnapAvgRate,
    deltaSnapWorstRate,
    entityDeltaSnapAvgRate,
    entityDeltaSnapWorstRate,
    projectileDeltaSnapAvgRate,
    projectileDeltaSnapWorstRate,
    snapshotSizeAvgBytes,
    snapshotSizeHiBytes,
    richSnapshotSizeAvgBytes,
    richSnapshotSizeHiBytes,
    deltaSnapshotSizeAvgBytes,
    deltaSnapshotSizeHiBytes,
    entityDeltaSnapshotSizeAvgBytes,
    entityDeltaSnapshotSizeHiBytes,
    projectileDeltaSnapshotSizeAvgBytes,
    projectileDeltaSnapshotSizeHiBytes,
    snapshotApplyAvgMs,
    snapshotApplyHiMs,
    richSnapshotApplyAvgMs,
    richSnapshotApplyHiMs,
    deltaSnapshotApplyAvgMs,
    deltaSnapshotApplyHiMs,
    entityDeltaSnapshotApplyAvgMs,
    entityDeltaSnapshotApplyHiMs,
    projectileDeltaSnapshotApplyAvgMs,
    projectileDeltaSnapshotApplyHiMs,
  };
}
