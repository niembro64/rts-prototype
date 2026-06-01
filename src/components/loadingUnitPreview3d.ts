import type { BuildableUnitBlueprintId } from '@/game/sim/blueprints';
import {
  BUILDABLE_UNIT_BLUEPRINT_IDS,
  getBuildingBlueprint,
  getUnitBlueprint,
} from '@/game/sim/blueprints';
import { BUILDING_BLUEPRINT_IDS, type BuildingBlueprintId } from '@/types/blueprintIds';
import { isTowerBuildingBlueprintId } from '@/types/buildingTypes';
import type { LoadingEntityBlueprintId, LoadingPreviewKind } from './loadingUnitPreviewScene';

export type { LoadingEntityBlueprintId, LoadingPreviewKind };

export type LoadingUnitPreviewSelection = {
  kind: LoadingPreviewKind;
  id: LoadingEntityBlueprintId;
  name: string;
};

export type LoadingUnitPreviewRuntime = {
  destroy: () => void;
};

export type LoadingUnitPreviewOptions = {
  fullBleed?: boolean;
  onReady?: () => void;
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
    } & PreviewSize)
  | ({ type: 'resize' } & PreviewSize)
  | { type: 'destroy' };

type WorkerPreviewResponse =
  | { type: 'destroyed' }
  | { type: 'ready' };

const DPR_CAP = 1.75;

/** Pick a random entity to show on the loading screen. Chooses a category
 *  (unit / tower / building) uniformly first, then a blueprint within it,
 *  so towers and buildings get fair screen time despite there being far
 *  more unit blueprints than structures. */
export function pickRandomLoadingEntity(): LoadingUnitPreviewSelection {
  const towers = BUILDING_BLUEPRINT_IDS.filter((id) => isTowerBuildingBlueprintId(id));
  const buildings = BUILDING_BLUEPRINT_IDS.filter((id) => !isTowerBuildingBlueprintId(id));
  const pools = ([
    { kind: 'unit', ids: BUILDABLE_UNIT_BLUEPRINT_IDS },
    { kind: 'tower', ids: towers },
    { kind: 'building', ids: buildings },
  ] as { kind: LoadingPreviewKind; ids: readonly LoadingEntityBlueprintId[] }[])
    .filter((pool) => pool.ids.length > 0);
  const pool = pools[Math.floor(Math.random() * pools.length)] ?? pools[0];
  const id = pool.ids[Math.floor(Math.random() * pool.ids.length)] ?? pool.ids[0];
  return { kind: pool.kind, id, name: loadingEntityName(pool.kind, id) };
}

function loadingEntityName(kind: LoadingPreviewKind, id: LoadingEntityBlueprintId): string {
  return kind === 'unit'
    ? getUnitBlueprint(id as BuildableUnitBlueprintId).name
    : getBuildingBlueprint(id as BuildingBlueprintId).name;
}

export function mountLoadingUnitPreview(
  host: HTMLElement,
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
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
  let readyFired = false;
  const fireReady = (): void => {
    if (destroyed || readyFired) return;
    readyFired = true;
    options.onReady?.();
  };
  const hooks: DriverHooks = { onReady: fireReady };

  let latestSize = readPreviewSize(host);
  let driver = createWorkerDriver(canvas, kind, blueprintId, fullBleed, latestSize, hooks);
  let fallbackDriverPromise: Promise<PreviewDriver | null> | null = null;

  if (!driver) {
    fallbackDriverPromise = createMainThreadFallbackDriver(canvas, kind, blueprintId, fullBleed, latestSize, hooks);
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
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
  fullBleed: boolean,
  size: PreviewSize,
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
    else if (event.data.type === 'ready') hooks.onReady();
  }

  worker.addEventListener('message', handleWorkerMessage);
  const offscreen = canvas.transferControlToOffscreen();
  const initMessage: WorkerPreviewMessage = {
    type: 'init',
    canvas: offscreen,
    kind,
    blueprintId,
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
  kind: LoadingPreviewKind,
  blueprintId: LoadingEntityBlueprintId,
  fullBleed: boolean,
  size: PreviewSize,
  hooks: DriverHooks,
): Promise<PreviewDriver | null> {
  const { LoadingUnitPreviewScene } = await import('./loadingUnitPreviewScene');
  const scene = new LoadingUnitPreviewScene({ canvas, kind, blueprintId, fullBleed });
  let destroyed = false;
  let rafId = 0;
  let readyFired = false;

  const tick = (now: number): void => {
    if (destroyed) return;
    scene.render(now);
    if (!readyFired) {
      readyFired = true;
      hooks.onReady();
    }
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
