import { setCurrentZoom } from '@/clientBarConfig';
import type { GraphicsConfig } from '@/types/graphics';
import type { PerspectiveCamera } from 'three';
import type { ClientViewState } from '../../network/ClientViewState';
import type { PredictionLodTier } from '../../network/ClientPredictionLod';
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
    setCurrentZoom(options.zoom);

    const renderLod = snapshotLod(options.camera, options.viewportHeightPx);
    const graphicsConfig = renderLod.gfx;
    this.renderLodGrid.beginFrame(renderLod.view, graphicsConfig);

    const predStart = performance.now();
    this.clientViewState.applyPrediction(options.deltaMs, {
      cameraX: renderLod.view.cameraX,
      cameraY: renderLod.view.cameraY,
      cameraZ: renderLod.view.cameraZ,
      richDistance: 0,
      simpleDistance: 0,
      massDistance: 0,
      impostorDistance: 0,
      cellSize: graphicsConfig.objectLodCellSize,
      physicsPredictionFramesSkip: graphicsConfig.clientPhysicsPredictionFramesSkip,
      resolveTier: this.resolvePredictionTier,
    });

    return {
      renderLod,
      graphicsConfig,
      predMs: performance.now() - predStart,
    };
  }

  private readonly resolvePredictionTier = (
    worldX: number,
    worldY: number,
    worldZ: number,
  ): PredictionLodTier => {
    const tier = this.renderLodGrid.resolve(worldX, worldY, worldZ);
    return tier === 'hero' ? 'rich' : tier;
  };
}
