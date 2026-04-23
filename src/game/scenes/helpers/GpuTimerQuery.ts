// GpuTimerQuery — real GPU execution time via EXT_disjoint_timer_query_webgl2.
//
// Wraps a renderer.render() call with beginQuery/endQuery; results are async,
// available 2-3 frames later, in nanoseconds. We poll completed queries every
// frame, drop any that overlapped a GPU_DISJOINT event (context reset /
// suspend), and EMA-smooth the result into milliseconds.
//
// When the extension isn't available (Safari, very old GPUs) the query
// helper silently no-ops — callers check `isSupported()` and fall back to
// CPU-side `renderMs` as the GPU proxy.
//
// Usage:
//   const q = new GpuTimerQuery(gl);
//   q.begin();
//   renderer.render(scene, camera);
//   q.end();
//   q.poll();
//   const gpuMs = q.getGpuMs();

type DisjointTimerQueryExt = {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

export class GpuTimerQuery {
  private gl: WebGL2RenderingContext | null = null;
  private ext: DisjointTimerQueryExt | null = null;
  // Queries in flight, oldest first. Each began in a previous frame; we
  // don't check the newest one for result availability (GPU is still busy).
  private pending: WebGLQuery[] = [];
  private activeQuery: WebGLQuery | null = null;

  // EMA-smoothed result in milliseconds. Zero until the first query resolves.
  private emaMs = 0;
  private initialized = false;

  // Hard cap so a stuck driver (never returns RESULT_AVAILABLE) can't grow
  // the queue unbounded.
  private readonly MAX_PENDING = 6;

  constructor(gl: WebGL2RenderingContext | WebGLRenderingContext | null | undefined) {
    if (!gl || !(gl as WebGL2RenderingContext).createQuery) return;
    this.gl = gl as WebGL2RenderingContext;
    const ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return;
    this.ext = ext as unknown as DisjointTimerQueryExt;
  }

  isSupported(): boolean {
    return this.ext !== null;
  }

  /** Open a query that will wrap subsequent GPU commands until `end()`. */
  begin(): void {
    if (!this.gl || !this.ext) return;
    // Don't overlap queries — if a previous begin() wasn't matched, drop it.
    if (this.activeQuery) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.activeQuery = q;
  }

  /** Close the most recent query and queue it for async result polling. */
  end(): void {
    if (!this.gl || !this.ext || !this.activeQuery) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.activeQuery);
    this.activeQuery = null;
    // If too many queries stack up (driver stall), drop the oldest to
    // bound memory. Losing samples is fine — the EMA won't notice.
    while (this.pending.length > this.MAX_PENDING) {
      const stale = this.pending.shift();
      if (stale) this.gl.deleteQuery(stale);
    }
  }

  /** Pull any completed query results and fold into the EMA. Call once per
   *  frame, after end(). Safe to call without a preceding begin()/end(). */
  poll(): void {
    if (!this.gl || !this.ext) return;
    // If the GPU has been disjoint (context reset, suspend), every pending
    // query is invalid — discard them all.
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    if (disjoint) {
      for (const q of this.pending) this.gl.deleteQuery(q);
      this.pending.length = 0;
      return;
    }
    while (this.pending.length > 0) {
      const q = this.pending[0];
      const available = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE);
      if (!available) break;
      const ns = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) as number;
      const ms = ns / 1_000_000;
      if (!this.initialized) {
        this.emaMs = ms;
        this.initialized = true;
      } else {
        // Same avg coefficient as FRAME_TIMING_EMA so the smoothing
        // timescale matches the other ms trackers.
        this.emaMs = 0.99 * this.emaMs + 0.01 * ms;
      }
      this.gl.deleteQuery(q);
      this.pending.shift();
    }
  }

  getGpuMs(): number {
    return this.emaMs;
  }

  destroy(): void {
    if (!this.gl) return;
    for (const q of this.pending) this.gl.deleteQuery(q);
    if (this.activeQuery) this.gl.deleteQuery(this.activeQuery);
    this.pending.length = 0;
    this.activeQuery = null;
    this.gl = null;
    this.ext = null;
  }
}
