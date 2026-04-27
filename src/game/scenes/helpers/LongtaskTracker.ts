// LongtaskTracker — detects main-thread blocks ≥50 ms via PerformanceObserver.
//
// The Longtask API fires an entry whenever a single task on the main thread
// blocks for ≥50 ms — a useful "CPU was saturated" signal that the frame
// timing trackers can't isolate (a stalled render/update loop still shows
// up in `frameMs`, but you can't tell it was from a longtask vs just "lots
// of work").
//
// We accumulate blocked milliseconds and event counts over rolling windows,
// then EMA-smooth "per second" rates so callers can display stable numbers.
// If the API isn't available (very old browsers), `isSupported()` returns
// false and the tracker no-ops.

export class LongtaskTracker {
  private observer: PerformanceObserver | null = null;

  // Current accumulation window.
  private windowBlockedMs = 0;
  private windowCount = 0;
  private windowStartMs = 0;
  // Flush the window into the EMA every N ms so per-second rates update at
  // a human-perceptible cadence without being too jittery.
  private readonly WINDOW_MS = 500;

  // Smoothed per-second rates. `emaBlockedMsPerSec` is ms of blocked time
  // per wall-clock second (so 100 = "main thread was blocked for 10% of
  // real time by longtasks"); `emaCountPerSec` is event frequency.
  private emaBlockedMsPerSec = 0;
  private emaCountPerSec = 0;
  private initialized = false;

  constructor() {
    if (typeof PerformanceObserver === 'undefined') return;
    // `supportedEntryTypes` is the robust feature-detection path — just
    // `observe({ entryTypes: ['longtask'] })` throws on unsupported
    // browsers (e.g. Firefox < ~90 without a flag).
    const supported = PerformanceObserver.supportedEntryTypes ?? [];
    if (!supported.includes('longtask')) return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.windowBlockedMs += entry.duration;
          this.windowCount++;
        }
      });
      // Use the singular `type` form (not `entryTypes`) because the
      // `buffered` flag is only valid alongside the singular form per
      // the PerformanceObserver spec — Chrome logs a warning when
      // `entryTypes` is paired with `buffered`. Since we only watch
      // a single entry kind here, the singular call is the right
      // shape.
      this.observer.observe({ type: 'longtask', buffered: true });
      this.windowStartMs = performance.now();
    } catch {
      this.observer = null;
    }
  }

  isSupported(): boolean {
    return this.observer !== null;
  }

  /** Call once per frame. Flushes the accumulation window into the EMA
   *  every ~500 ms of wall-clock time. */
  tick(): void {
    if (!this.observer) return;
    const now = performance.now();
    const elapsed = now - this.windowStartMs;
    if (elapsed < this.WINDOW_MS) return;

    const perSec = 1000 / elapsed;
    const blockedMsPerSec = this.windowBlockedMs * perSec;
    const countPerSec = this.windowCount * perSec;

    if (!this.initialized) {
      this.emaBlockedMsPerSec = blockedMsPerSec;
      this.emaCountPerSec = countPerSec;
      this.initialized = true;
    } else {
      // ~1.5 sec timescale (α=0.3 with 500 ms windows). Responsive enough
      // to spot a new longtask pattern, smoothed enough that a single
      // stutter doesn't flip the bar from green to red.
      this.emaBlockedMsPerSec = 0.7 * this.emaBlockedMsPerSec + 0.3 * blockedMsPerSec;
      this.emaCountPerSec = 0.7 * this.emaCountPerSec + 0.3 * countPerSec;
    }

    this.windowBlockedMs = 0;
    this.windowCount = 0;
    this.windowStartMs = now;
  }

  /** Blocked milliseconds per second of wall-clock time. 0 = never
   *  blocked; 100 = ~10% of real time lost to ≥50 ms tasks; 500+ = the
   *  main thread is essentially jammed. */
  getBlockedMsPerSec(): number {
    return this.emaBlockedMsPerSec;
  }

  /** Longtask events per second. */
  getCountPerSec(): number {
    return this.emaCountPerSec;
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }
}
