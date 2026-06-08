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

export function queueModeFromEvent(event: QueueModifierEvent): QueueCommandMode {
  const queue = event.shiftKey;
  const queueFront = queue && (event.ctrlKey || event.metaKey);
  return {
    queue,
    queueFront,
    queueInsertIndex: queue && !queueFront && event.altKey ? 1 : undefined,
  };
}
