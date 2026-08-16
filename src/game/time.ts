/** Monotonic high-resolution time where available, with a server/test fallback. */
export function monotonicNowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
