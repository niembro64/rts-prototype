import type {
  LoadingEntityBlueprintId,
  LoadingPreviewKind,
  LoadingUnitPreviewRendererHost,
  LoadingUnitPreviewScene,
} from './loadingUnitPreviewScene';
import {
  acquireAuxiliaryRendererContext,
  type RendererContextToken,
} from '@/game/render3d/RendererContextBudget';
import { monotonicNowMs } from '@/game/time';
import {
  BUILDING_BLUEPRINT_IDS,
  UNIT_BLUEPRINT_IDS,
} from '@/types/blueprintIds';
import { CANONICAL_ENTITY_PREVIEW_YAW_RAD } from './entityPreviewCamera';

type EntityPreviewImageUse = 'grid' | 'panel' | 'loading';

type EntityPreviewImageSpec = {
  size: number;
  dpr: number;
  quality: number;
  fullBleed: boolean;
};

const ENTITY_PREVIEW_IMAGE_SPECS = {
  grid: { size: 144, dpr: 2, quality: 0.88, fullBleed: false },
  panel: { size: 320, dpr: 2, quality: 0.9, fullBleed: false },
  loading: { size: 640, dpr: 2, quality: 0.92, fullBleed: false },
} as const satisfies Record<EntityPreviewImageUse, EntityPreviewImageSpec>;

const THUMBNAIL_MIME_TYPE = 'image/webp';
const THUMBNAIL_YAW = CANONICAL_ENTITY_PREVIEW_YAW_RAD;
const THUMBNAIL_PITCH = 0;
const THUMBNAIL_RETRY_DELAYS_MS = [120, 300, 700, 1500, 3000];
const THUMBNAIL_DEFERRED_RETRY_MS = 5000;

const cachedThumbnails = new Map<string, string>();
const pendingThumbnails = new Map<string, Promise<string | null>>();
const failedThumbnails = new Set<string>();
const deferredRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

let renderQueue = Promise.resolve();
let sharedRendererRuntime: ThumbnailRendererRuntime | null = null;
let sharedRendererRuntimePromise: Promise<ThumbnailRendererRuntime | null> | null = null;
let previewWarmupPromise: Promise<void> | null = null;
let previewWarmupComplete = 0;
const previewWarmupTotal = UNIT_BLUEPRINT_IDS.length + BUILDING_BLUEPRINT_IDS.length;
const previewWarmupListeners = new Set<(complete: number, total: number) => void>();

type ThumbnailRendererRuntime = {
  canvas: HTMLCanvasElement;
  contextToken: RendererContextToken;
  rendererHost: LoadingUnitPreviewRendererHost;
  retainedScene: LoadingUnitPreviewScene | null;
};

type ThumbnailRenderResult =
  | { status: 'ready'; dataUrl: string }
  | { status: 'temporarily-unavailable' }
  | { status: 'unsupported' };

function thumbnailKey(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): string {
  return `${imageUse}:${kind}:${blueprintId}`;
}

function cachedThumbnail(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): string | undefined {
  const exact = cachedThumbnails.get(thumbnailKey(imageUse, kind, blueprintId));
  if (exact !== undefined || imageUse === 'panel') return exact;
  // The panel render is the canonical prewarmed battle image (640x640
  // physical pixels). Grid buttons can downsample it, and loading surfaces
  // can upscale it instead of starting a surprise renderer job mid-battle.
  return cachedThumbnails.get(thumbnailKey('panel', kind, blueprintId));
}

function pendingThumbnail(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): Promise<string | null> | undefined {
  const exact = pendingThumbnails.get(thumbnailKey(imageUse, kind, blueprintId));
  if (exact !== undefined || imageUse === 'panel') return exact;
  return pendingThumbnails.get(thumbnailKey('panel', kind, blueprintId));
}

function notifyPreviewWarmupProgress(): void {
  for (const listener of previewWarmupListeners) {
    listener(previewWarmupComplete, previewWarmupTotal);
  }
}

function disposeSharedRendererRuntime(): void {
  const runtime = sharedRendererRuntime;
  sharedRendererRuntime = null;
  sharedRendererRuntimePromise = null;
  if (runtime === null) return;
  runtime.retainedScene?.dispose();
  runtime.rendererHost.dispose();
  runtime.contextToken.release();
}

async function getSharedRendererRuntime(): Promise<ThumbnailRendererRuntime | null> {
  if (sharedRendererRuntime !== null) return sharedRendererRuntime;
  if (sharedRendererRuntimePromise !== null) return sharedRendererRuntimePromise;

  sharedRendererRuntimePromise = (async () => {
    const canvas = document.createElement('canvas');
    const contextToken = acquireAuxiliaryRendererContext('entity-preview-images', canvas);
    if (contextToken === null) return null;
    try {
      const { LoadingUnitPreviewRendererHost } = await import('./loadingUnitPreviewScene');
      const runtime: ThumbnailRendererRuntime = {
        canvas,
        contextToken,
        rendererHost: new LoadingUnitPreviewRendererHost(canvas, true),
        retainedScene: null,
      };
      sharedRendererRuntime = runtime;
      window.addEventListener('pagehide', disposeSharedRendererRuntime, { once: true });
      return runtime;
    } catch (error) {
      contextToken.release();
      throw error;
    }
  })().then((runtime) => {
    if (runtime === null) sharedRendererRuntimePromise = null;
    return runtime;
  }, (error) => {
    sharedRendererRuntimePromise = null;
    throw error;
  });
  return sharedRendererRuntimePromise;
}

function notifyThumbnailListeners(): void {
  for (const listener of listeners) listener();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scheduleDeferredThumbnailRetry(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): void {
  const key = thumbnailKey(imageUse, kind, blueprintId);
  if (
    listeners.size === 0 ||
    cachedThumbnails.has(key) ||
    pendingThumbnails.has(key) ||
    failedThumbnails.has(key) ||
    deferredRetryTimers.has(key)
  ) {
    return;
  }

  const timer = setTimeout(() => {
    deferredRetryTimers.delete(key);
    if (
      listeners.size === 0 ||
      cachedThumbnails.has(key) ||
      pendingThumbnails.has(key) ||
      failedThumbnails.has(key)
    ) {
      return;
    }
    void requestEntityPreviewImage(imageUse, kind, blueprintId);
  }, THUMBNAIL_DEFERRED_RETRY_MS);
  deferredRetryTimers.set(key, timer);
}

async function renderEntityThumbnailWithRetries(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): Promise<ThumbnailRenderResult> {
  for (let attempt = 0; attempt <= THUMBNAIL_RETRY_DELAYS_MS.length; attempt++) {
    const result = await renderEntityThumbnail(imageUse, kind, blueprintId);
    if (
      result.status !== 'temporarily-unavailable' ||
      attempt === THUMBNAIL_RETRY_DELAYS_MS.length
    ) {
      return result;
    }
    await delay(THUMBNAIL_RETRY_DELAYS_MS[attempt]);
  }

  return { status: 'temporarily-unavailable' };
}

export function subscribeEntityThumbnailCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      for (const timer of deferredRetryTimers.values()) clearTimeout(timer);
      deferredRetryTimers.clear();
    }
  };
}

export function getCachedEntityThumbnail(
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): string | null {
  return getCachedEntityPreviewImage('grid', kind, blueprintId);
}

export function getCachedEntityPreviewImage(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): string | null {
  return cachedThumbnail(imageUse, kind, blueprintId) ?? null;
}

export function requestEntityThumbnail(
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): Promise<string | null> {
  return requestEntityPreviewImage('grid', kind, blueprintId);
}

export function requestEntityPreviewImage(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): Promise<string | null> {
  const key = thumbnailKey(imageUse, kind, blueprintId);
  const cached = cachedThumbnail(imageUse, kind, blueprintId);
  if (cached !== undefined) return Promise.resolve(cached);
  if (failedThumbnails.has(key)) return Promise.resolve(null);
  const pending = pendingThumbnail(imageUse, kind, blueprintId);
  if (pending !== undefined) return pending;

  const task = renderQueue
    .then(() => renderEntityThumbnailWithRetries(imageUse, kind, blueprintId))
    .then((result) => {
      pendingThumbnails.delete(key);
      if (result.status === 'ready') {
        cachedThumbnails.set(key, result.dataUrl);
      } else if (result.status === 'unsupported') {
        failedThumbnails.add(key);
      } else {
        scheduleDeferredThumbnailRetry(imageUse, kind, blueprintId);
      }
      notifyThumbnailListeners();
      return result.status === 'ready' ? result.dataUrl : null;
    })
    .catch((error: unknown) => {
      pendingThumbnails.delete(key);
      failedThumbnails.add(key);
      console.warn(`Failed to render entity thumbnail for ${key}`, error);
      notifyThumbnailListeners();
      return null;
    });

  pendingThumbnails.set(key, task);
  renderQueue = task.then(() => undefined, () => undefined);
  return task;
}

/** Generate the canonical panel image for every entity while a battle loading
 *  overlay is intentionally covering main-thread shader compilation/readback.
 *  Grid and later loading-image requests reuse these images, so opening a
 *  factory menu or selecting a never-before-seen unit cannot create a cold
 *  WebGL/encoding long task during gameplay. Calls are idempotent and share
 *  the same serialized warmup if demo and real-battle startup overlap. */
export function prewarmEntityPreviewImages(
  onProgress?: (complete: number, total: number) => void,
): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  if (onProgress !== undefined) {
    previewWarmupListeners.add(onProgress);
    onProgress(previewWarmupComplete, previewWarmupTotal);
  }

  if (previewWarmupPromise === null) {
    const entries: Array<{
      kind: LoadingPreviewKind;
      blueprintId: LoadingEntityBlueprintId;
    }> = [
      ...UNIT_BLUEPRINT_IDS.map((blueprintId) => ({ kind: 'unit' as const, blueprintId })),
      ...BUILDING_BLUEPRINT_IDS.map((blueprintId) => ({ kind: 'building' as const, blueprintId })),
    ];
    previewWarmupPromise = (async () => {
      for (const entry of entries) {
        await requestEntityPreviewImage('panel', entry.kind, entry.blueprintId);
        previewWarmupComplete++;
        notifyPreviewWarmupProgress();
      }
    })().finally(() => {
      // Every known battle entity now has a canonical image, so retaining an
      // auxiliary WebGL context/PMREM for the rest of the match would buy
      // nothing. Grid and loading uses resolve from the panel cache.
      disposeSharedRendererRuntime();
    });
  }

  const promise = previewWarmupPromise;
  return promise.finally(() => {
    if (onProgress !== undefined) previewWarmupListeners.delete(onProgress);
  });
}

async function renderEntityThumbnail(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): Promise<ThumbnailRenderResult> {
  if (typeof document === 'undefined') return { status: 'unsupported' };

  await nextFrame();
  const spec = ENTITY_PREVIEW_IMAGE_SPECS[imageUse];
  const runtime = await getSharedRendererRuntime();
  if (runtime === null) return { status: 'temporarily-unavailable' };

  let scene: import('./loadingUnitPreviewScene').LoadingUnitPreviewScene | null = null;
  try {
    const { LoadingUnitPreviewScene } = await import('./loadingUnitPreviewScene');
    scene = new LoadingUnitPreviewScene({
      canvas: runtime.canvas,
      kind,
      blueprintId,
      fullBleed: spec.fullBleed,
      rendererHost: runtime.rendererHost,
      initialSize: {
        width: spec.size,
        height: spec.size,
        dpr: spec.dpr,
      },
    });
    scene.updateControls({
      rotate: false,
      motion: false,
      yaw: THUMBNAIL_YAW,
      pitch: THUMBNAIL_PITCH,
    });
    scene.render(monotonicNowMs());
    const dataUrl = runtime.canvas.toDataURL(THUMBNAIL_MIME_TYPE, spec.quality);

    // Keep the newest material set alive until its successor has rendered.
    // Three.js can then reuse the context's live program cache instead of
    // deleting the last reference and recompiling the same variants.
    runtime.retainedScene?.dispose();
    runtime.retainedScene = scene;
    scene = null;

    return {
      status: 'ready',
      dataUrl,
    };
  } finally {
    scene?.dispose();
  }
}
