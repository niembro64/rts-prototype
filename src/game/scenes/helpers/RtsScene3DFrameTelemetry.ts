import { EMA_CONFIG, EMA_INITIAL_VALUES, FRAME_TIMING_EMA } from '../../../config';
import { SNAPSHOT_CADENCE_REGRESSION } from '../../SnapshotCadenceRegression';
import { EmaMsTracker } from './EmaMsTracker';
import { EmaTracker } from './EmaTracker';
import { LongtaskTracker } from './LongtaskTracker';

export type RtsScene3DFrameTiming = {
  frameMsAvg: number;
  frameMsHi: number;
  renderMsAvg: number;
  renderMsHi: number;
  logicMsAvg: number;
  logicMsHi: number;
  predMsAvg: number;
  predMsHi: number;
  gpuTimerMs: number;
  gpuTimerSupported: boolean;
  longtaskMsPerSec: number;
  longtaskCountPerSec: number;
  longtaskSupported: boolean;
  runtimeProfile: string;
  nativePixelRatio: number;
  activePixelRatio: number;
  dynamicPixelRatioEnabled: boolean;
  webglBufferProfilerSupported: boolean;
  webglRendererRenderMs: number;
  webglDrawCalls: number;
  webglTriangles: number;
  webglPoints: number;
  webglLines: number;
  webglGeometries: number;
  webglTextures: number;
  webglBufferDataCalls: number;
  webglBufferSubDataCalls: number;
  webglBufferUploadBytes: number;
};

type RtsScene3DFrameTimingGpuSample = {
  gpuTimerMs: number;
  gpuTimerSupported: boolean;
  runtimeProfile: string;
  nativePixelRatio: number;
  activePixelRatio: number;
  dynamicPixelRatioEnabled: boolean;
  webglBufferProfilerSupported: boolean;
  webglRendererRenderMs: number;
  webglDrawCalls: number;
  webglTriangles: number;
  webglPoints: number;
  webglLines: number;
  webglGeometries: number;
  webglTextures: number;
  webglBufferDataCalls: number;
  webglBufferSubDataCalls: number;
  webglBufferUploadBytes: number;
};

export class RtsScene3DFrameTelemetry {
  private readonly renderTpsTracker = new EmaTracker(EMA_CONFIG.tps, EMA_INITIAL_VALUES.tps);
  private readonly frameMsTracker = new EmaMsTracker(
    FRAME_TIMING_EMA.frameMs,
    EMA_INITIAL_VALUES.frameMs,
  );
  private readonly renderMsTracker = new EmaMsTracker(
    FRAME_TIMING_EMA.renderMs,
    EMA_INITIAL_VALUES.renderMs,
  );
  private readonly logicMsTracker = new EmaMsTracker(
    FRAME_TIMING_EMA.logicMs,
    EMA_INITIAL_VALUES.logicMs,
  );
  private readonly predMsTracker = new EmaMsTracker(
    FRAME_TIMING_EMA.predMs,
    EMA_INITIAL_VALUES.predMs,
  );
  private readonly longtaskTracker = new LongtaskTracker();

  recordRenderDelta(deltaMs: number): void {
    if (deltaMs <= 0) return;
    this.renderTpsTracker.update(1000 / deltaMs);
  }

  recordRenderDisabledFrame(frameStart: number): void {
    const frameEnd = performance.now();
    const frameMs = frameEnd - frameStart;
    this.frameMsTracker.update(frameMs);
    this.renderMsTracker.update(0);
    this.logicMsTracker.update(frameMs);
    this.predMsTracker.update(0);
    this.recordFrameBoundary(frameMs, frameEnd);
  }

  recordRenderFrame(params: {
    frameStart: number;
    renderMs: number;
    predMs: number;
  }): void {
    const frameEnd = performance.now();
    const frameMs = frameEnd - params.frameStart;
    const logicMs = Math.max(0, frameMs - params.renderMs - params.predMs);
    this.frameMsTracker.update(frameMs);
    this.renderMsTracker.update(params.renderMs);
    this.logicMsTracker.update(logicMs);
    this.predMsTracker.update(params.predMs);
    this.recordFrameBoundary(frameMs, frameEnd);
  }

  getFrameTiming(sample: RtsScene3DFrameTimingGpuSample): RtsScene3DFrameTiming {
    return {
      frameMsAvg: this.frameMsTracker.getAvg(),
      frameMsHi: this.frameMsTracker.getHi(),
      renderMsAvg: this.renderMsTracker.getAvg(),
      renderMsHi: this.renderMsTracker.getHi(),
      logicMsAvg: this.logicMsTracker.getAvg(),
      logicMsHi: this.logicMsTracker.getHi(),
      predMsAvg: this.predMsTracker.getAvg(),
      predMsHi: this.predMsTracker.getHi(),
      gpuTimerMs: sample.gpuTimerMs,
      gpuTimerSupported: sample.gpuTimerSupported,
      longtaskMsPerSec: this.longtaskTracker.getBlockedMsPerSec(),
      longtaskCountPerSec: this.longtaskTracker.getCountPerSec(),
      longtaskSupported: this.longtaskTracker.isSupported(),
      runtimeProfile: sample.runtimeProfile,
      nativePixelRatio: sample.nativePixelRatio,
      activePixelRatio: sample.activePixelRatio,
      dynamicPixelRatioEnabled: sample.dynamicPixelRatioEnabled,
      webglBufferProfilerSupported: sample.webglBufferProfilerSupported,
      webglRendererRenderMs: sample.webglRendererRenderMs,
      webglDrawCalls: sample.webglDrawCalls,
      webglTriangles: sample.webglTriangles,
      webglPoints: sample.webglPoints,
      webglLines: sample.webglLines,
      webglGeometries: sample.webglGeometries,
      webglTextures: sample.webglTextures,
      webglBufferDataCalls: sample.webglBufferDataCalls,
      webglBufferSubDataCalls: sample.webglBufferSubDataCalls,
      webglBufferUploadBytes: sample.webglBufferUploadBytes,
    };
  }

  getRenderTpsStats(): { avgRate: number; worstRate: number } {
    return {
      avgRate: this.renderTpsTracker.getAvg(),
      worstRate: this.renderTpsTracker.getLow(),
    };
  }

  destroy(): void {
    this.longtaskTracker.destroy();
  }

  private recordFrameBoundary(frameMs: number, now: number): void {
    SNAPSHOT_CADENCE_REGRESSION.recordFrame({ frameMs, now });
    this.longtaskTracker.tick();
  }
}
