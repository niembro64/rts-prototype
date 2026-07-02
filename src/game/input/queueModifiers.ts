type QueueModifierEvent = {
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

export type FactoryProductionClickMode = {
  repeat: boolean;
  count: number;
};

const trackedQueueModifiers: QueueModifierEvent = {
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
};

// BAR chat_and_ui_keys.txt binds "Any+space commandinsert prepend" — holding
// Space while issuing a command inserts it at the front of the queue. Space
// is not a browser modifier, so it is tracked here like the others, and the
// input layer registers an eligibility provider so the behavior only applies
// under BAR presets when the selection is not a factory (held Space doubles
// as the factory-preset overlay there).
let trackedSpaceHeld = false;
let spaceQueueFrontEligibilityProvider: (() => boolean) | null = null;

export function setSpaceQueueFrontEligibilityProvider(provider: (() => boolean) | null): void {
  spaceQueueFrontEligibilityProvider = provider;
}

export function clearSpaceQueueFrontEligibilityProvider(provider: () => boolean): void {
  if (spaceQueueFrontEligibilityProvider === provider) {
    spaceQueueFrontEligibilityProvider = null;
  }
}

function spaceQueueFrontHeld(): boolean {
  return trackedSpaceHeld && spaceQueueFrontEligibilityProvider?.() === true;
}

export function clearQueueModifierState(): void {
  trackedQueueModifiers.shiftKey = false;
  trackedQueueModifiers.altKey = false;
  trackedQueueModifiers.ctrlKey = false;
  trackedQueueModifiers.metaKey = false;
  trackedSpaceHeld = false;
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
    case ' ':
      trackedSpaceHeld = held;
      return;
  }
  switch (event.code) {
    case 'Space':
      trackedSpaceHeld = held;
      break;
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
  const spaceFront = spaceQueueFrontHeld();
  const queue = modifiers.shiftKey || spaceFront;
  const queueFront = queue && (modifiers.ctrlKey || modifiers.metaKey || spaceFront);
  const requestedInsertIndex = selectedQueueInsertIndex ?? (modifiers.altKey ? 1 : undefined);
  return {
    queue,
    queueFront,
    queueInsertIndex: queue && !queueFront ? requestedInsertIndex : undefined,
  };
}

export function factoryProductionClickModeFromEvent(
  event: QueueModifierEvent,
  factoryRepeatsProduction: boolean,
): FactoryProductionClickMode {
  const modifiers = effectiveQueueModifierEvent(event);
  const count = (modifiers.shiftKey ? 5 : 1) * (modifiers.ctrlKey ? 20 : 1);
  return {
    repeat: factoryRepeatsProduction &&
      !(modifiers.shiftKey || modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey),
    count,
  };
}

export function factoryProductionKeyModeFromEvent(
  event: QueueModifierEvent,
  factoryRepeatsProduction: boolean,
): FactoryProductionClickMode {
  const modifiers = effectiveQueueModifierEvent(event);
  const count = (modifiers.shiftKey ? 5 : 1) * (modifiers.ctrlKey ? -1 : 1);
  return {
    repeat: factoryRepeatsProduction &&
      !(modifiers.shiftKey || modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey),
    count,
  };
}

export function queueModeForDragRelease(
  dragStartQueueMode: QueueCommandMode | null,
  releaseQueueMode: QueueCommandMode,
): QueueCommandMode {
  if (dragStartQueueMode === null || releaseQueueMode.queue) return releaseQueueMode;
  return dragStartQueueMode.queue ? dragStartQueueMode : releaseQueueMode;
}
