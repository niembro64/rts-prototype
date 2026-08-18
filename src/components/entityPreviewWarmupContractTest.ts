import thumbnailSource from './entityPreviewThumbnails.ts?raw';
import previewSceneSource from './loadingUnitPreviewScene.ts?raw';
import backgroundBattleSource from './gameCanvasBackgroundBattle.ts?raw';
import realBattleStartSource from './gameCanvasRealBattleStart.ts?raw';
import sharedSimConstantsSource from '../sharedSimConstants.json?raw';

function assertContract(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[entity preview warmup contract] ${message}`);
  }
}

export function runEntityPreviewWarmupContractTest(): void {
  assertContract(
    !sharedSimConstantsSource.includes('maxTickDtMs'),
    'the unused maxTickDtMs setting must not return to shared simulation config',
  );
  assertContract(
    previewSceneSource.includes('export class LoadingUnitPreviewRendererHost') &&
      previewSceneSource.includes('rendererHost?: LoadingUnitPreviewRendererHost') &&
      previewSceneSource.includes('if (this.ownsRendererHost) this.rendererHost.dispose()'),
    'serialized thumbnails must be able to share one context-owned renderer and PMREM',
  );
  assertContract(
    thumbnailSource.includes("acquireAuxiliaryRendererContext('entity-preview-images'") &&
      thumbnailSource.includes('sharedRendererRuntime') &&
      thumbnailSource.includes('runtime.retainedScene = scene'),
    'thumbnail jobs must retain one renderer context and a live shader-program owner',
  );
  assertContract(
    thumbnailSource.includes('export function prewarmEntityPreviewImages(') &&
      thumbnailSource.includes('...UNIT_BLUEPRINT_IDS.map') &&
      thumbnailSource.includes('...BUILDING_BLUEPRINT_IDS.map') &&
      thumbnailSource.includes("await requestEntityPreviewImage('panel'"),
    'loading warmup must cover the canonical panel image for every unit and building',
  );
  assertContract(
    thumbnailSource.includes("cachedThumbnails.get(thumbnailKey('panel'") &&
      thumbnailSource.includes("pendingThumbnails.get(thumbnailKey('panel'"),
    'grid/loading consumers must reuse canonical prewarmed panel images',
  );
  assertContract(
    backgroundBattleSource.includes('await prewarmEntityPreviewImages(') &&
      realBattleStartSource.includes('await prewarmEntityPreviewImages('),
    'both demo and real battles must finish preview generation behind their loading overlays',
  );
  assertContract(
    backgroundBattleSource.includes('startupReady && rendererWarmupDone') &&
      backgroundBattleSource.includes("'Warming shaders'"),
    'demo loading must remain covered until cold renderer shader work completes',
  );
}
