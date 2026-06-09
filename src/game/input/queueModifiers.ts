export type QueueModifierEvent = {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  getModifierState?: (keyArg: string) => boolean;
};

export type QueueCommandMode = {
  queue: boolean;
  queueFront: boolean;
  queueInsertIndex?: number;
};

const trackedQueueModifiers: QueueModifierEvent = {
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

export function clearQueueModifierState(): void {
  trackedQueueModifiers.shiftKey = false;
  trackedQueueModifiers.altKey = false;
  trackedQueueModifiers.ctrlKey = false;
  trackedQueueModifiers.metaKey = false;
}

export function setQueueModifierKeyState(
  event: Pick<KeyboardEvent, 'key' | 'code'>,
  held: boolean,
): void {
  switch (event.key) {
    case 'Shift':
      trackedQueueModifiers.shiftKey = held;
      return;
    case 'Alt':
      trackedQueueModifiers.altKey = held;
      return;
    case 'Control':
      trackedQueueModifiers.ctrlKey = held;
      return;
    case 'Meta':
      trackedQueueModifiers.metaKey = held;
      return;
  }
  switch (event.code) {
    case 'ShiftLeft':
    case 'ShiftRight':
      trackedQueueModifiers.shiftKey = held;
      break;
    case 'AltLeft':
    case 'AltRight':
      trackedQueueModifiers.altKey = held;
      break;
    case 'ControlLeft':
    case 'ControlRight':
      trackedQueueModifiers.ctrlKey = held;
      break;
    case 'MetaLeft':
    case 'MetaRight':
      trackedQueueModifiers.metaKey = held;
      break;
  }
}

export function effectiveQueueModifierEvent(event: QueueModifierEvent): QueueModifierEvent {
  return {
    shiftKey: event.shiftKey || event.getModifierState?.('Shift') === true || trackedQueueModifiers.shiftKey,
    altKey: event.altKey || event.getModifierState?.('Alt') === true || trackedQueueModifiers.altKey,
    ctrlKey: event.ctrlKey || event.getModifierState?.('Control') === true || trackedQueueModifiers.ctrlKey,
    metaKey: event.metaKey || event.getModifierState?.('Meta') === true || trackedQueueModifiers.metaKey,
  };
}

export function queueModeFromEvent(
  event: QueueModifierEvent,
  selectedQueueInsertIndex?: number | null,
): QueueCommandMode {
  const modifiers = effectiveQueueModifierEvent(event);
  const queue = modifiers.shiftKey;
  const queueFront = queue && (modifiers.ctrlKey || modifiers.metaKey);
  const requestedInsertIndex = selectedQueueInsertIndex ?? (modifiers.altKey ? 1 : undefined);
  return {
    queue,
    queueFront,
    queueInsertIndex: queue && !queueFront ? requestedInsertIndex : undefined,
  };
}

export function queueModeForDragRelease(
  dragStartQueueMode: QueueCommandMode | null,
  releaseQueueMode: QueueCommandMode,
): QueueCommandMode {
  if (dragStartQueueMode === null || releaseQueueMode.queue) return releaseQueueMode;
  return dragStartQueueMode.queue ? dragStartQueueMode : releaseQueueMode;
}
