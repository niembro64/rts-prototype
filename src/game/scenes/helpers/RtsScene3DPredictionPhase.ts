import type { GraphicsConfig } from '@/types/graphics';
import type { PerspectiveCamera } from 'three';
import type { ClientViewState } from '../../network/ClientViewState';
import { CLIENT_PREDICTION_DIAGNOSTICS } from '../../network/ClientPredictionDiagnostics';
import { snapshotRenderFrameState, type RenderFrameState3D } from '../../render3d/RenderFrameState3D';

export type RtsScene3DPredictionPhaseResult = {
  renderFrameState: RenderFrameState3D;
  graphicsConfig: GraphicsConfig;
  predMs: number;
};

export class RtsScene3DPredictionPhase {
  constructor(private readonly clientViewState: ClientViewState) {}

  run(options: {
    deltaMs: number;
    camera: PerspectiveCamera;
    viewportHeightPx: number;
    zoom: number;
  }): RtsScene3DPredictionPhaseResult {
    const renderFrameState = snapshotRenderFrameState(options.camera, options.viewportHeightPx);
    const graphicsConfig = renderFrameState.gfx;

    const predStart = performance.now();
    const targetAge = this.clientViewState.applyPrediction(options.deltaMs);
    const predMs = performance.now() - predStart;
    CLIENT_PREDICTION_DIAGNOSTICS.recordFrame({ predictionMs: predMs, targetAge });

    return {
      renderFrameState,
      graphicsConfig,
      predMs,
    };
  }
}
