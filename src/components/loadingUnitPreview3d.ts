import type { BuildableUnitId } from '@/game/sim/blueprints';
import {
  BUILDABLE_UNIT_IDS,
  getUnitBlueprint,
} from '@/game/sim/blueprints';

export type LoadingUnitPreviewSelection = {
  id: BuildableUnitId;
  name: string;
};

export type LoadingUnitPreviewRuntime = {
  destroy: () => void;
};

export type LoadingUnitPreviewOptions = {
  fullBleed?: boolean;
};

type PreviewSize = {
  width: number;
  height: number;
  dpr: number;
};

type PreviewDriver = {
  resize: (size: PreviewSize) => void;
  destroy: () => void;
};

type WorkerPreviewMessage =
  | ({
      type: 'init';
      canvas: OffscreenCanvas;
      unitId: BuildableUnitId;
      fullBleed: boolean;
    } & PreviewSize)
  | ({ type: 'resize' } & PreviewSize)
  | { type: 'destroy' };

type WorkerPreviewResponse = {
  type: 'destroyed';
};

const DPR_CAP = 1.75;

export function pickRandomLoadingUnit(): LoadingUnitPreviewSelection {
  const unitIds = BUILDABLE_UNIT_IDS;
  const selected = unitIds[Math.floor(Math.random() * unitIds.length)] ?? unitIds[0];
  const blueprint = getUnitBlueprint(selected);
  return { id: selected, name: blueprint.name };
}

export function mountLoadingUnitPreview(
  host: HTMLElement,
  unitId: BuildableUnitId,
  options: LoadingUnitPreviewOptions = {},
): LoadingUnitPreviewRuntime {
  const fullBleed = options.fullBleed === true;
  const stage = document.createElement('div');
  stage.className = `loader-unit-stage${fullBleed ? ' full-bleed' : ''}`;

  const canvas = document.createElement('canvas');
  canvas.className = 'loader-unit-canvas';
  stage.appendChild(canvas);
  host.appendChild(stage);

  let destroyed = false;
  let latestSize = readPreviewSize(host);
  let driver = createWorkerDriver(canvas, unitId, fullBleed, latestSize);
  let fallbackDriverPromise: Promise<PreviewDriver | null> | null = null;

  if (!driver) {
    fallbackDriverPromise = createMainThreadFallbackDriver(canvas, unitId, fullBleed, latestSize);
    void fallbackDriverPromise.then((resolved) => {
      if (destroyed) {
        resolved?.destroy();
        return;
      }
      driver = resolved;
      driver?.resize(latestSize);
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
  unitId: BuildableUnitId,
  fullBleed: boolean,
  size: PreviewSize,
): PreviewDriver | null {
  if (
    typeof Worker === 'undefined' ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof canvas.transferControlToOffscreen !== 'function' ||
    !supportsOffscreenWebGl()
  ) {
    return null;
  }

  const worker = new Worker(new URL('./loadingUnitPreviewWorker.ts', import.meta.url), {
    type: 'module',
  });
  let destroyed = false;
  let terminateFallback: ReturnType<typeof setTimeout> | null = null;

  function finishTerminate(): void {
    if (terminateFallback !== null) {
      clearTimeout(terminateFallback);
      terminateFallback = null;
    }
    worker.removeEventListener('message', handleWorkerMessage);
    worker.terminate();
  }

  function handleWorkerMessage(event: MessageEvent<WorkerPreviewResponse>): void {
    if (event.data.type === 'destroyed') finishTerminate();
  }

  worker.addEventListener('message', handleWorkerMessage);
  const offscreen = canvas.transferControlToOffscreen();
  const initMessage: WorkerPreviewMessage = {
    type: 'init',
    canvas: offscreen,
    unitId,
    fullBleed,
    ...size,
  };
  worker.postMessage(initMessage, [offscreen]);

  return {
    resize: (nextSize) => {
      if (destroyed) return;
      const message: WorkerPreviewMessage = { type: 'resize', ...nextSize };
      worker.postMessage(message);
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
  unitId: BuildableUnitId,
  fullBleed: boolean,
  size: PreviewSize,
): Promise<PreviewDriver | null> {
  const { LoadingUnitPreviewScene } = await import('./loadingUnitPreviewScene');
  const scene = new LoadingUnitPreviewScene({ canvas, unitId, fullBleed });
  let destroyed = false;
  let rafId = 0;

  const tick = (now: number): void => {
    if (destroyed) return;
    scene.render(now);
    rafId = requestAnimationFrame(tick);
  };

  scene.resize(size);
  rafId = requestAnimationFrame(tick);

  return {
    resize: (nextSize) => {
      scene.resize(nextSize);
    },
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(rafId);
      scene.dispose();
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
