import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { GameScene } from '../game/createGame';
import { getRendererContextTelemetry } from '../game/render3d/RendererContextBudget';

type GameCanvasTelemetryOptions = {
  getScene: () => GameScene | null;
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

  onMounted(() => {
    updateInterval = setInterval(update, 100);
  });

  onUnmounted(() => {
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });

  return {
    currentZoom,
    displayGpuMs,
    frameMsAvg,
    frameMsHi,
    gpuSourceLabel,
    gpuTimerSupported,
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
