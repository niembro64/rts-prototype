import type {
  LoadingEntityBlueprintId,
  LoadingPreviewKind,
} from './loadingUnitPreviewScene';
import {
  acquireAuxiliaryRendererContext,
} from '@/game/render3d/RendererContextBudget';

export type EntityPreviewImageUse = 'grid' | 'panel' | 'loading';

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
const THUMBNAIL_YAW = -0.62;
const THUMBNAIL_PITCH = -0.16;
const THUMBNAIL_RETRY_DELAYS_MS = [120, 300, 700, 1500, 3000];
const THUMBNAIL_DEFERRED_RETRY_MS = 5000;

const cachedThumbnails = new Map<string, string>();
const pendingThumbnails = new Map<string, Promise<string | null>>();
const failedThumbnails = new Set<string>();
const deferredRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

let renderQueue = Promise.resolve();

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
  return cachedThumbnails.get(thumbnailKey(imageUse, kind, blueprintId)) ?? null;
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
  const cached = cachedThumbnails.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  if (failedThumbnails.has(key)) return Promise.resolve(null);
  const pending = pendingThumbnails.get(key);
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

async function renderEntityThumbnail(
  imageUse: EntityPreviewImageUse,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
): Promise<ThumbnailRenderResult> {
  if (typeof document === 'undefined') return { status: 'unsupported' };

  await nextFrame();
  const spec = ENTITY_PREVIEW_IMAGE_SPECS[imageUse];

  const canvas = document.createElement('canvas');
  const contextToken = acquireAuxiliaryRendererContext(`entity-${imageUse}-image`, canvas);
  if (contextToken === null) return { status: 'temporarily-unavailable' };

  let scene: import('./loadingUnitPreviewScene').LoadingUnitPreviewScene | null = null;
  try {
    const { LoadingUnitPreviewScene } = await import('./loadingUnitPreviewScene');
    scene = new LoadingUnitPreviewScene({
      canvas,
      kind,
      blueprintId,
      fullBleed: spec.fullBleed,
      preserveDrawingBuffer: true,
    });
    scene.updateControls({
      rotate: false,
      motion: false,
      yaw: THUMBNAIL_YAW,
      pitch: THUMBNAIL_PITCH,
    });
    scene.resize({
      width: spec.size,
      height: spec.size,
      dpr: spec.dpr,
    });
    scene.render(typeof performance !== 'undefined' ? performance.now() : Date.now());

    return {
      status: 'ready',
      dataUrl: canvas.toDataURL(THUMBNAIL_MIME_TYPE, spec.quality),
    };
  } finally {
    scene?.dispose();
    contextToken.release();
  }
}
