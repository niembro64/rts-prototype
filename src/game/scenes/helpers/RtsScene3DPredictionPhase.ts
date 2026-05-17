import type { GraphicsConfig } from '@/types/graphics';
import type { PerspectiveCamera } from 'three';
import type { ClientViewState } from '../../network/ClientViewState';
import { CLIENT_PREDICTION_DIAGNOSTICS } from '../../network/ClientPredictionDiagnostics';
import { snapshotLod, type Lod3DState } from '../../render3d/Lod3D';
import { RenderLodGrid } from '../../render3d/RenderLodGrid';

export type RtsScene3DPredictionPhaseResult = {
  renderLod: Lod3DState;
  graphicsConfig: GraphicsConfig;
  predMs: number;
};

export class RtsScene3DPredictionPhase {
  readonly renderLodGrid = new RenderLodGrid();

  constructor(private readonly clientViewState: ClientViewState) {}

  run(options: {
    deltaMs: number;
    camera: PerspectiveCamera;
    viewportHeightPx: number;
    zoom: number;
  }): RtsScene3DPredictionPhaseResult {
    const renderLod = snapshotLod(options.camera, options.viewportHeightPx);
    const graphicsConfig = renderLod.gfx;
    this.renderLodGrid.beginFrame(renderLod.view, graphicsConfig);

    const predStart = performance.now();
    const targetAge = this.clientViewState.applyPrediction(options.deltaMs);
    const predMs = performance.now() - predStart;
    CLIENT_PREDICTION_DIAGNOSTICS.recordFrame({ predictionMs: predMs, targetAge });

    return {
      renderLod,
      graphicsConfig,
      predMs,
    };
  }
}
