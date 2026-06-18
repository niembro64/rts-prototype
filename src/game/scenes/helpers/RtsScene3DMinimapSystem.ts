import type { GraphicsConfig } from '@/types/graphics';
import type { CameraViewBasis, MinimapData, UIEntitySource } from '@/types/ui';
import type { ClientViewState } from '../../network/ClientViewState';
import { buildMinimapData } from './UIUpdateManager';

export type MinimapUpdateHandler = ((data: MinimapData) => void) | undefined;

const MINIMAP_UPDATE_INTERVAL_MS = 50;

export class RtsScene3DMinimapSystem {
  private updateTimer = 0;
  private dataScratch: MinimapData = {
    contentVersion: 0,
    mapWidth: 0,
    mapHeight: 0,
    entities: [],
    cameraQuad: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    cameraYaw: 0,
    cameraPitch: Math.PI * 0.25,
    cameraView: {
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 },
      towardCamera: { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 },
    },
    directionVersion: 0,
    showTerrain: true,
    wind: undefined,
  };

  constructor(
    private readonly clientViewState: ClientViewState,
    private readonly mapWidth: number,
    private readonly mapHeight: number,
  ) {}

  tick(
    deltaMs: number,
    graphicsConfig: GraphicsConfig,
    entitySource: UIEntitySource,
    cameraQuad: MinimapData['cameraQuad'],
    cameraYaw: number,
    cameraPitch: number,
    cameraView: CameraViewBasis | undefined,
    onMinimapUpdate: MinimapUpdateHandler,
  ): void {
    this.updateTimer += deltaMs;
    const minimapInterval = this.getUpdateInterval(graphicsConfig);
    if (this.updateTimer < minimapInterval) return;

    this.updateTimer = 0;
    this.emit(entitySource, cameraQuad, cameraYaw, cameraPitch, cameraView, onMinimapUpdate);
  }

  emit(
    entitySource: UIEntitySource,
    cameraQuad: MinimapData['cameraQuad'],
    cameraYaw: number,
    cameraPitch: number,
    cameraView: CameraViewBasis | undefined,
    onMinimapUpdate: MinimapUpdateHandler,
  ): void {
    if (!onMinimapUpdate) return;

    onMinimapUpdate(
      buildMinimapData(
        entitySource,
        this.mapWidth,
        this.mapHeight,
        cameraQuad,
        cameraYaw,
        cameraPitch,
        cameraView,
        true,
        this.clientViewState.getServerMeta()?.wind,
        this.clientViewState.getMinimapEntitiesOverride(),
        this.dataScratch,
      ),
    );
  }

  private getUpdateInterval(graphicsConfig: GraphicsConfig): number {
    const renderStrideScale = Math.min(
      4,
      Math.max(1, graphicsConfig.terrainTileFrameStride | 0),
    );
    const unitCount = this.clientViewState.getServerMeta()?.units?.count ?? 0;
    const unitScale =
      unitCount >= 8000 ? 6 :
      unitCount >= 4000 ? 4 :
      unitCount >= 1500 ? 2 :
      1;
    return MINIMAP_UPDATE_INTERVAL_MS * renderStrideScale * unitScale;
  }
}
