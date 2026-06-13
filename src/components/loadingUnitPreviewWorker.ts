import {
  LoadingUnitPreviewScene,
  type LoadingEntityBlueprintId,
  type LoadingPreviewKind,
  type LoadingUnitPreviewControls,
  type LoadingUnitPreviewSceneSize,
} from './loadingUnitPreviewScene';

type InitMessage = {
  type: 'init';
  canvas: OffscreenCanvas;
  kind: LoadingPreviewKind;
  blueprintId: LoadingEntityBlueprintId;
  fullBleed: boolean;
  controls: Partial<LoadingUnitPreviewControls>;
} & LoadingUnitPreviewSceneSize;

type ResizeMessage = {
  type: 'resize';
} & LoadingUnitPreviewSceneSize;

type DestroyMessage = {
  type: 'destroy';
};

type ControlsMessage = {
  type: 'controls';
  controls: Partial<LoadingUnitPreviewControls>;
};

type PreviewWorkerMessage = InitMessage | ResizeMessage | ControlsMessage | DestroyMessage;

type DestroyedMessage = {
  type: 'destroyed';
};

type ReadyMessage = {
  type: 'ready';
};

type AnimationScope = typeof self & {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

type ClosableWorkerScope = typeof self & {
  close?: () => void;
};

let preview: LoadingUnitPreviewScene | null = null;
let running = false;
let frameHandle: number | null = null;
let timeoutHandle: number | null = null;
let readySent = false;

self.onmessage = (event: MessageEvent<PreviewWorkerMessage>): void => {
  const message = event.data;
  if (message.type === 'init') {
    preview?.dispose();
    preview = new LoadingUnitPreviewScene({
      canvas: message.canvas,
      kind: message.kind,
      blueprintId: message.blueprintId,
      fullBleed: message.fullBleed,
    });
    preview.updateControls(message.controls);
    preview.resize(message);
    if (!running) {
      running = true;
      scheduleFrame();
    }
    return;
  }

  if (message.type === 'resize') {
    preview?.resize(message);
    return;
  }

  if (message.type === 'controls') {
    preview?.updateControls(message.controls);
    return;
  }

  destroyPreview();
  self.postMessage({ type: 'destroyed' } satisfies DestroyedMessage);
  (self as ClosableWorkerScope).close?.();
};

function destroyPreview(): void {
  running = false;
  readySent = false;
  cancelScheduledFrame();
  preview?.dispose();
  preview = null;
}

function tick(now: number): void {
  frameHandle = null;
  timeoutHandle = null;
  if (!running) return;
  preview?.render(now);
  if (!readySent && preview !== null) {
    readySent = true;
    self.postMessage({ type: 'ready' } satisfies ReadyMessage);
  }
  scheduleFrame();
}

function scheduleFrame(): void {
  const scope = self as AnimationScope;
  if (typeof scope.requestAnimationFrame === 'function') {
    frameHandle = scope.requestAnimationFrame(tick);
    return;
  }
  timeoutHandle = setTimeout(() => tick(performance.now()), 1000 / 60);
}

function cancelScheduledFrame(): void {
  const scope = self as AnimationScope;
  if (frameHandle !== null && typeof scope.cancelAnimationFrame === 'function') {
    scope.cancelAnimationFrame(frameHandle);
  }
  if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  frameHandle = null;
  timeoutHandle = null;
}
