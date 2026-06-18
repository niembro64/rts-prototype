import * as THREE from 'three';

export type WebGlFrameProfile = {
  readonly bufferProfilerSupported: boolean;
  readonly rendererRenderMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly points: number;
  readonly lines: number;
  readonly geometries: number;
  readonly textures: number;
  readonly bufferDataCalls: number;
  readonly bufferSubDataCalls: number;
  readonly bufferUploadBytes: number;
};

type MutableWebGlBufferFns = {
  bufferData: (...args: unknown[]) => unknown;
  bufferSubData: (...args: unknown[]) => unknown;
};

const EMPTY_PROFILE: WebGlFrameProfile = {
  bufferProfilerSupported: false,
  rendererRenderMs: 0,
  drawCalls: 0,
  triangles: 0,
  points: 0,
  lines: 0,
  geometries: 0,
  textures: 0,
  bufferDataCalls: 0,
  bufferSubDataCalls: 0,
  bufferUploadBytes: 0,
};

export class WebGlFrameProfiler {
  private latest: WebGlFrameProfile = EMPTY_PROFILE;
  private bufferDataCalls = 0;
  private bufferSubDataCalls = 0;
  private bufferUploadBytes = 0;
  private readonly gl: (WebGLRenderingContext | WebGL2RenderingContext) | null;
  private originalBufferData: ((...args: unknown[]) => unknown) | null = null;
  private originalBufferSubData: ((...args: unknown[]) => unknown) | null = null;
  private installed = false;

  constructor(
    gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined,
    profileBufferUploads: boolean,
  ) {
    this.gl = gl ?? null;
    if (profileBufferUploads) this.installBufferProfiler();
  }

  beginFrame(): void {
    this.bufferDataCalls = 0;
    this.bufferSubDataCalls = 0;
    this.bufferUploadBytes = 0;
  }

  endFrame(renderer: THREE.WebGLRenderer, rendererRenderMs: number): void {
    const info = renderer.info;
    this.latest = {
      bufferProfilerSupported: this.installed,
      rendererRenderMs,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      bufferDataCalls: this.bufferDataCalls,
      bufferSubDataCalls: this.bufferSubDataCalls,
      bufferUploadBytes: this.bufferUploadBytes,
    };
  }

  getLatest(): WebGlFrameProfile {
    return this.latest;
  }

  destroy(): void {
    if (!this.installed || this.gl === null) return;
    const gl = this.gl as unknown as MutableWebGlBufferFns;
    if (this.originalBufferData !== null) gl.bufferData = this.originalBufferData;
    if (this.originalBufferSubData !== null) gl.bufferSubData = this.originalBufferSubData;
    this.originalBufferData = null;
    this.originalBufferSubData = null;
    this.installed = false;
  }

  private installBufferProfiler(): void {
    if (this.gl === null) return;
    try {
      const gl = this.gl as unknown as MutableWebGlBufferFns;
      const originalBufferData = gl.bufferData.bind(this.gl);
      const originalBufferSubData = gl.bufferSubData.bind(this.gl);
      this.originalBufferData = originalBufferData;
      this.originalBufferSubData = originalBufferSubData;

      gl.bufferData = (...args: unknown[]): unknown => {
        this.bufferDataCalls++;
        this.bufferUploadBytes += estimateBufferDataBytes(args);
        return originalBufferData(...args);
      };
      gl.bufferSubData = (...args: unknown[]): unknown => {
        this.bufferSubDataCalls++;
        this.bufferUploadBytes += estimateBufferSubDataBytes(args);
        return originalBufferSubData(...args);
      };
      this.installed = true;
    } catch {
      this.originalBufferData = null;
      this.originalBufferSubData = null;
      this.installed = false;
    }
  }
}

function estimateBufferDataBytes(args: readonly unknown[]): number {
  const source = args[1];
  if (typeof source === 'number') return positiveByteCount(source);
  return estimateSourceBytes(source, args[4]);
}

function estimateBufferSubDataBytes(args: readonly unknown[]): number {
  return estimateSourceBytes(args[2], args[4]);
}

function estimateSourceBytes(source: unknown, length: unknown): number {
  if (source === null || source === undefined) return 0;
  const explicitLength = typeof length === 'number' && Number.isFinite(length)
    ? Math.max(0, length)
    : null;
  if (ArrayBuffer.isView(source)) {
    const bytesPerElement = bytesPerElementOf(source);
    return explicitLength !== null
      ? positiveByteCount(explicitLength * bytesPerElement)
      : positiveByteCount(source.byteLength);
  }
  if (hasByteLength(source)) {
    return explicitLength !== null
      ? positiveByteCount(explicitLength)
      : positiveByteCount(source.byteLength);
  }
  return 0;
}

function bytesPerElementOf(view: ArrayBufferView): number {
  const bytesPerElement = (view as ArrayBufferView & { BYTES_PER_ELEMENT?: number })
    .BYTES_PER_ELEMENT;
  return typeof bytesPerElement === 'number' && bytesPerElement > 0
    ? bytesPerElement
    : 1;
}

function hasByteLength(value: unknown): value is { readonly byteLength: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'byteLength' in value &&
    typeof (value as { readonly byteLength?: unknown }).byteLength === 'number'
  );
}

function positiveByteCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
