export type QueueModifierEvent = {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

export type QueueCommandMode = {
  queue: boolean;
  queueFront: boolean;
};

export function queueModeFromEvent(event: QueueModifierEvent): QueueCommandMode {
  const queue = event.shiftKey;
  return {
    queue,
    queueFront: queue && (event.ctrlKey || event.metaKey),
  };
}
