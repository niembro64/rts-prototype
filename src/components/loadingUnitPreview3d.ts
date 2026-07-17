import type { LoadingEntityBlueprintId, LoadingPreviewKind } from './loadingUnitPreviewScene';
import type { LoadingUnitPreviewControls } from './loadingUnitPreviewScene';
import {
  acquireAuxiliaryRendererContext,
} from '@/game/render3d/RendererContextBudget';
import type { PrimitiveGeometryTier } from '@/game/render3d/PrimitiveGeometryQuality3D';

export type { LoadingEntityBlueprintId, LoadingPreviewKind };
export type { LoadingUnitPreviewControls };

export type LoadingUnitPreviewRuntime = {
  setControls: (controls: Partial<LoadingUnitPreviewControls>) => void;
  destroy: () => void;
};

type LoadingUnitPreviewOptions = {
  fullBleed?: boolean;
  controls?: Partial<LoadingUnitPreviewControls>;
  onReady?: () => void;
  geometryTier?: PrimitiveGeometryTier;
};

type PreviewSize = {
  width: number;
  height: number;
  dpr: number;
};

type PreviewDriver = {
  resize: (size: PreviewSize) => void;
  setControls: (controls: Partial<LoadingUnitPreviewControls>) => void;
  destroy: () => void;
};

type LoadingPreviewSceneRuntime = {
  resize: (size: PreviewSize) => void;
  updateControls: (controls: Partial<LoadingUnitPreviewControls>) => void;
  render: (now: number) => void;
  dispose: () => void;
};

type DriverHooks = {
  onReady: () => void;
};

type WorkerPreviewMessage =
  | ({
      type: 'init';
      canvas: OffscreenCanvas;
      kind: LoadingPreviewKind;
      blueprintId: LoadingEntityBlueprintId;
      fullBleed: boolean;
      geometryTier: PrimitiveGeometryTier;
      controls: Partial<LoadingUnitPreviewControls>;
    } & PreviewSize)
  | ({ type: 'resize' } & PreviewSize)
  | { type: 'controls'; controls: Partial<LoadingUnitPreviewControls> }
  | { type: 'destroy' };

type WorkerPreviewResponse =
  | { type: 'destroyed' }
  | { type: 'ready' };

const DPR_CAP = 1.75;

export function mountLoadingUnitPreview(
  host: HTMLElement,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
  options: LoadingUnitPreviewOptions = {},
): LoadingUnitPreviewRuntime {
  const fullBleed = options.fullBleed === true;
  const geometryTier = options.geometryTier ?? 'close';
  const stage = document.createElement('div');
  stage.className = `loader-unit-stage${fullBleed ? ' full-bleed' : ''}`;

  const canvas = document.createElement('canvas');
  canvas.className = 'loader-unit-canvas';
  stage.appendChild(canvas);
  host.appendChild(stage);

  let destroyed = false;
  let readyFired = false;
  const fireReady = (): void => {
    if (destroyed || readyFired) return;
    readyFired = true;
    options.onReady?.();
  };
  const hooks: DriverHooks = { onReady: fireReady };

  let latestSize = readPreviewSize(host);
  let latestControls: Partial<LoadingUnitPreviewControls> = options.controls ?? {};
  let driver = createWorkerDriver(canvas, kind, blueprintId, fullBleed, geometryTier, latestSize, latestControls, hooks);
  let fallbackDriverPromise: Promise<PreviewDriver | null> | null = null;

  if (!driver) {
    fallbackDriverPromise = createMainThreadFallbackDriver(canvas, kind, blueprintId, fullBleed, geometryTier, latestSize, latestControls, hooks);
    void fallbackDriverPromise.then((resolved) => {
      if (destroyed) {
        resolved?.destroy();
        return;
      }
      driver = resolved;
      driver?.resize(latestSize);
      driver?.setControls(latestControls);
    });
  }

  const resize = (): void => {
    if (destroyed) return;
    latestSize = readPreviewSize(host);
    driver?.resize(latestSize);
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  return {
    setControls: (controls) => {
      latestControls = { ...latestControls, ...controls };
      driver?.setControls(controls);
    },
    destroy: () => {
      destroyed = true;
      resizeObserver.disconnect();
      driver?.destroy();
      driver = null;
      if (stage.parentElement === host) host.removeChild(stage);
    },
  };
}

function createWorkerDriver(
  canvas: HTMLCanvasElement,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
  fullBleed: boolean,
  geometryTier: PrimitiveGeometryTier,
  size: PreviewSize,
  controls: Partial<LoadingUnitPreviewControls>,
  hooks: DriverHooks,
): PreviewDriver | null {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof canvas.transferControlToOffscreen !== 'function' ||
    !supportsOffscreenWebGl()
  ) {
    return null;
  }
  const acquiredContextToken = acquireAuxiliaryRendererContext('loading-preview-worker', canvas);
  if (acquiredContextToken === null) return null;
  const contextToken = acquiredContextToken;

  let worker: Worker;
  try {
    worker = new Worker(new URL('./loadingUnitPreviewWorker.ts', import.meta.url), {
      type: 'module',
    });
  } catch {
    contextToken.release();
    return null;
  }
  let destroyed = false;
  let terminated = false;
  let terminateFallback: ReturnType<typeof setTimeout> | null = null;

  function finishTerminate(): void {
    if (terminated) return;
    terminated = true;
    if (terminateFallback !== null) {
      clearTimeout(terminateFallback);
      terminateFallback = null;
    }
    worker.removeEventListener('message', handleWorkerMessage);
    worker.removeEventListener('error', handleWorkerFailure);
    worker.removeEventListener('messageerror', handleWorkerFailure);
    worker.terminate();
    contextToken.release();
  }

  function handleWorkerMessage(event: MessageEvent<WorkerPreviewResponse>): void {
    if (event.data.type === 'destroyed') finishTerminate();
    else if (event.data.type === 'ready' && !destroyed) hooks.onReady();
  }

  function handleWorkerFailure(): void {
    if (destroyed) {
      finishTerminate();
      return;
    }
    destroyed = true;
    finishTerminate();
    hooks.onReady();
  }

  worker.addEventListener('message', handleWorkerMessage);
  worker.addEventListener('error', handleWorkerFailure);
  worker.addEventListener('messageerror', handleWorkerFailure);
  let offscreen: OffscreenCanvas;
  try {
    offscreen = canvas.transferControlToOffscreen();
  } catch {
    finishTerminate();
    return null;
  }
  const initMessage: WorkerPreviewMessage = {
    type: 'init',
    canvas: offscreen,
    kind,
    blueprintId,
    fullBleed,
    geometryTier,
    controls,
    ...size,
  };
  try {
    worker.postMessage(initMessage, [offscreen]);
  } catch {
    destroyed = true;
    finishTerminate();
    return createDisabledPreviewDriver(canvas, hooks);
  }

  return {
    resize: (nextSize) => {
      if (destroyed) return;
      const message: WorkerPreviewMessage = { type: 'resize', ...nextSize };
      try {
        worker.postMessage(message);
      } catch {
        handleWorkerFailure();
      }
    },
    setControls: (nextControls) => {
      if (destroyed) return;
      const message: WorkerPreviewMessage = { type: 'controls', controls: nextControls };
      try {
        worker.postMessage(message);
      } catch {
        handleWorkerFailure();
      }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      const message: WorkerPreviewMessage = { type: 'destroy' };
      try {
        worker.postMessage(message);
        terminateFallback = setTimeout(finishTerminate, 1000);
      } catch {
        finishTerminate();
      }
    },
  };
}

async function createMainThreadFallbackDriver(
  canvas: HTMLCanvasElement,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
  fullBleed: boolean,
  geometryTier: PrimitiveGeometryTier,
  size: PreviewSize,
  controls: Partial<LoadingUnitPreviewControls>,
  hooks: DriverHooks,
): Promise<PreviewDriver | null> {
  const contextToken = acquireAuxiliaryRendererContext('loading-preview-fallback', canvas);
  if (contextToken === null) {
    return createDisabledPreviewDriver(canvas, hooks);
  }
  let scene: LoadingPreviewSceneRuntime | null = null;
  try {
    const { LoadingUnitPreviewScene } = await import('./loadingUnitPreviewScene');
    scene = new LoadingUnitPreviewScene({ canvas, kind, blueprintId, fullBleed, geometryTier });
    scene.updateControls(controls);
    scene.resize(size);
  } catch {
    scene?.dispose();
    contextToken.release();
    return createDisabledPreviewDriver(canvas, hooks);
  }
  const previewScene = scene;
  let destroyed = false;
  let rafId = 0;
  let readyFired = false;

  const fail = (): void => {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(rafId);
    previewScene.dispose();
    contextToken.release();
    hooks.onReady();
  };

  const tick = (now: number): void => {
    if (destroyed) return;
    try {
      previewScene.render(now);
    } catch {
      fail();
      return;
    }
    if (!readyFired) {
      readyFired = true;
      hooks.onReady();
    }
    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);

  return {
    resize: (nextSize) => {
      if (destroyed) return;
      try {
        previewScene.resize(nextSize);
      } catch {
        fail();
      }
    },
    setControls: (nextControls) => {
      if (destroyed) return;
      try {
        previewScene.updateControls(nextControls);
      } catch {
        fail();
      }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(rafId);
      previewScene.dispose();
      contextToken.release();
    },
  };
}

function createDisabledPreviewDriver(
  canvas: HTMLCanvasElement,
  hooks: DriverHooks,
): PreviewDriver {
  let destroyed = false;
  const clear = (): void => {
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } catch {
      // A canvas transferred to a failed worker can no longer be painted here.
    }
  };
  queueMicrotask(() => {
    if (!destroyed) hooks.onReady();
  });
  clear();
  return {
    resize: (size) => {
      try {
        canvas.width = Math.max(1, Math.round(size.width * size.dpr));
        canvas.height = Math.max(1, Math.round(size.height * size.dpr));
      } catch {
        // Keep disabled fallback inert when the canvas has been transferred.
      }
      clear();
    },
    setControls: () => {},
    destroy: () => {
      destroyed = true;
      clear();
    },
  };
}

function readPreviewSize(host: HTMLElement): PreviewSize {
  const rect = host.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
    dpr: Math.max(1, Math.min(DPR_CAP, window.devicePixelRatio || 1)),
  };
}

function supportsOffscreenWebGl(): boolean {
  try {
    const probe = new OffscreenCanvas(1, 1);
    const gl = probe.getContext('webgl') ?? probe.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}
