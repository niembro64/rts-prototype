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
  const snapshotSizeAvgBytes = ref(0);
  const snapshotSizeHiBytes = ref(0);
  const currentZoom = ref(0.4);
  let updateInterval: ReturnType<typeof setInterval> | null = null;
  let renderProfileApi: RenderProfileApi | null = null;

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

      const payloadSizeStats = scene.getSnapshotPayloadSizeStats();
      setNumberRefIfChanged(snapshotSizeAvgBytes, payloadSizeStats.avgBytes, 1);
      setNumberRefIfChanged(snapshotSizeHiBytes, payloadSizeStats.hiBytes, 1);
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
    snapshotSizeAvgBytes,
    snapshotSizeHiBytes,
  };
}
