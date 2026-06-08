export type QueueModifierEvent = {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

export type QueueCommandMode = {
  queue: boolean;
  queueFront: boolean;
  queueInsertIndex?: number;
};

export function queueModeFromEvent(
  event: QueueModifierEvent,
  selectedQueueInsertIndex?: number | null,
): QueueCommandMode {
  const queue = event.shiftKey;
  const queueFront = queue && (event.ctrlKey || event.metaKey);
  const requestedInsertIndex = selectedQueueInsertIndex ?? (event.altKey ? 1 : undefined);
  return {
    queue,
    queueFront,
    queueInsertIndex: queue && !queueFront ? requestedInsertIndex : undefined,
  };
}
