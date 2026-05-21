import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { GameScene } from '../game/createGame';

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
  const longtaskMsPerSec = ref(0);
  const longtaskSupported = ref(false);
  const renderTpsAvg = ref(0);
  const renderTpsWorst = ref(0);
  const snapAvgRate = ref(0);
  const snapWorstRate = ref(0);
  const fullSnapAvgRate = ref(0);
  const fullSnapWorstRate = ref(0);
  const diffSnapSizeAvgBytes = ref(0);
  const diffSnapSizeHiBytes = ref(0);
  const fullSnapSizeAvgBytes = ref(0);
  const fullSnapSizeHiBytes = ref(0);
  const currentZoom = ref(0.4);
  let updateInterval: ReturnType<typeof setInterval> | null = null;

  const displayGpuMs = computed(() =>
    gpuTimerSupported.value ? gpuTimerMs.value : renderMsAvg.value,
  );
  const gpuSourceLabel = computed(() =>
    gpuTimerSupported.value ? 'GPU time query' : 'renderer.render() wall-clock',
  );

  function update(): void {
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

      const snapStats = scene.getSnapshotStats();
      setNumberRefIfChanged(snapAvgRate, snapStats.avgRate, 0.05);
      setNumberRefIfChanged(snapWorstRate, snapStats.worstRate, 0.05);
      const fullSnapStats = scene.getFullSnapshotStats();
      setNumberRefIfChanged(fullSnapAvgRate, fullSnapStats.avgRate, 0.05);
      setNumberRefIfChanged(fullSnapWorstRate, fullSnapStats.worstRate, 0.05);

      const payloadSizeStats = scene.getSnapshotPayloadSizeStats();
      setNumberRefIfChanged(diffSnapSizeAvgBytes, payloadSizeStats.diffAvgBytes, 1);
      setNumberRefIfChanged(diffSnapSizeHiBytes, payloadSizeStats.diffHiBytes, 1);
      setNumberRefIfChanged(fullSnapSizeAvgBytes, payloadSizeStats.fullAvgBytes, 1);
      setNumberRefIfChanged(fullSnapSizeHiBytes, payloadSizeStats.fullHiBytes, 1);
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
    diffSnapSizeAvgBytes,
    diffSnapSizeHiBytes,
    frameMsAvg,
    frameMsHi,
    fullSnapAvgRate,
    fullSnapSizeAvgBytes,
    fullSnapSizeHiBytes,
    fullSnapWorstRate,
    gpuSourceLabel,
    gpuTimerSupported,
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
  };
}
