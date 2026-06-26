import * as THREE from 'three';
import {
  ENTITY_LOD_PROXY_BUILDING_MAX_PIXELS,
  ENTITY_LOD_PROXY_BUILDING_MIN_PIXELS,
  ENTITY_LOD_PROXY_CAP,
  ENTITY_LOD_PROXY_UNIT_MAX_PIXELS,
  ENTITY_LOD_PROXY_UNIT_MIN_PIXELS,
  ENTITY_LOD_PROXY_USE_TEAM_COLOR,
} from '@/config';
import type { Entity } from '../sim/types';
import { entityInstanceColorHex } from './EntityInstanceColor3D';
import { entityLodProxyRadius3D } from './EntityLod3D';

const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_BUFFER_USAGE_VERTEX = 0x0020;
const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
const GPU_SHADER_STAGE_VERTEX = 0x1;

const INSTANCE_FLOATS = 8;
const INSTANCE_BYTES = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const UNIFORM_FLOATS = 40;
const UNIFORM_BYTES = UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const ENTITY_LOD_PROXY_NEUTRAL_COLOR = 0xffffff;

const QUAD_CORNERS = new Float32Array([
  -1, -1,
  1, -1,
  1, 1,
  -1, -1,
  1, 1,
  -1, 1,
]);

const PROXY_SHADER = `
struct Uniforms {
  viewProjection: mat4x4<f32>,
  view: mat4x4<f32>,
  params: vec4<f32>,
  params2: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) corner: vec2<f32>,
  @location(1) center: vec3<f32>,
  @location(2) radius: f32,
  @location(3) color: vec4<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vsMain(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let centerClip = uniforms.viewProjection * vec4<f32>(input.center, 1.0);
  if (centerClip.w <= 0.0) {
    output.position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
    output.local = vec2<f32>(2.0, 2.0);
    output.color = input.color;
    return output;
  }

  let viewPosition = uniforms.view * vec4<f32>(input.center, 1.0);
  let viewport = max(uniforms.params.xy, vec2<f32>(1.0, 1.0));
  let projectionYScale = uniforms.params.z;
  let viewDistance = max(1.0, -viewPosition.z);
  let minPixels = uniforms.params.w;
  let maxPixels = uniforms.params2.x;
  let diameterPixels = clamp(
    input.radius * projectionYScale * viewport.y / viewDistance,
    minPixels,
    maxPixels,
  );
  let radiusPixels = diameterPixels * 0.5;
  let ndcOffset = vec2<f32>(
    input.corner.x * radiusPixels * 2.0 / viewport.x,
    input.corner.y * radiusPixels * 2.0 / viewport.y,
  );

  output.position = centerClip + vec4<f32>(ndcOffset * centerClip.w, 0.0, 0.0);
  output.local = input.corner;
  output.color = input.color;
  return output;
}

@fragment
fn fsMain(input: VertexOutput) -> @location(0) vec4<f32> {
  if (dot(input.local, input.local) > 1.0) {
    discard;
  }
  return input.color;
}
`;

type GpuLike = {
  requestAdapter(options?: Record<string, unknown>): Promise<GpuAdapterLike | null>;
  getPreferredCanvasFormat(): string;
};

type GpuAdapterLike = {
  requestDevice(): Promise<GpuDeviceLike>;
};

type GpuDeviceLike = {
  readonly queue: {
    writeBuffer(
      buffer: GpuBufferLike,
      bufferOffset: number,
      data: unknown,
      dataOffset?: number,
      size?: number,
    ): void;
    submit(commandBuffers: unknown[]): void;
  };
  createBindGroup(descriptor: Record<string, unknown>): unknown;
  createBindGroupLayout(descriptor: Record<string, unknown>): unknown;
  createBuffer(descriptor: Record<string, unknown>): GpuBufferLike;
  createCommandEncoder(): GpuCommandEncoderLike;
  createPipelineLayout(descriptor: Record<string, unknown>): unknown;
  createRenderPipeline(descriptor: Record<string, unknown>): unknown;
  createShaderModule(descriptor: Record<string, unknown>): unknown;
  destroy?: () => void;
};

type GpuBufferLike = {
  destroy?: () => void;
};

type GpuCanvasContextLike = {
  configure(descriptor: Record<string, unknown>): void;
  getCurrentTexture(): {
    createView(): unknown;
  };
};

type GpuCommandEncoderLike = {
  beginRenderPass(descriptor: Record<string, unknown>): GpuRenderPassEncoderLike;
  finish(): unknown;
};

type GpuRenderPassEncoderLike = {
  draw(vertexCount: number, instanceCount: number): void;
  end(): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  setPipeline(pipeline: unknown): void;
  setVertexBuffer(slot: number, buffer: GpuBufferLike): void;
};

type GpuProxyBatch = {
  readonly data: Float32Array;
  readonly instanceBuffer: GpuBufferLike;
  readonly uniformBuffer: GpuBufferLike;
  readonly bindGroup: unknown;
  readonly minPixels: number;
  readonly maxPixels: number;
  count: number;
};

type EntityLodProxyWebGpuRendererOptions3D = {
  readonly baseCanvas: HTMLCanvasElement;
  readonly camera: THREE.PerspectiveCamera;
};

function getNavigatorGpu(): GpuLike | null {
  if (typeof navigator === 'undefined') return null;
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
  if (gpu === null || typeof gpu !== 'object') return null;
  return gpu as GpuLike;
}

function createOverlayCanvas(baseCanvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const parent = baseCanvas.parentElement;
  if (parent === null || typeof document === 'undefined') return null;

  const computed = getComputedStyle(parent);
  if (computed.position === 'static') {
    parent.style.position = 'relative';
  }

  const overlay = document.createElement('canvas');
  overlay.className = 'entity-lod-webgpu-overlay';
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.display = 'block';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '1';
  parent.appendChild(overlay);
  return overlay;
}

function normalizeColorHex(colorHex: number, out: Float32Array, offset: number): void {
  out[offset] = ((colorHex >> 16) & 0xff) / 255;
  out[offset + 1] = ((colorHex >> 8) & 0xff) / 255;
  out[offset + 2] = (colorHex & 0xff) / 255;
  out[offset + 3] = 1;
}

function createGpuBatch(
  device: GpuDeviceLike,
  bindGroupLayout: unknown,
  minPixels: number,
  maxPixels: number,
): GpuProxyBatch {
  const instanceBuffer = device.createBuffer({
    size: ENTITY_LOD_PROXY_CAP * INSTANCE_BYTES,
    usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
  });
  const uniformBuffer = device.createBuffer({
    size: UNIFORM_BYTES,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: uniformBuffer },
      },
    ],
  });
  return {
    data: new Float32Array(ENTITY_LOD_PROXY_CAP * INSTANCE_FLOATS),
    instanceBuffer,
    uniformBuffer,
    bindGroup,
    minPixels,
    maxPixels,
    count: 0,
  };
}

function writeProxyInstance(batch: GpuProxyBatch, slot: number, entity: Entity): void {
  const data = batch.data;
  const offset = slot * INSTANCE_FLOATS;
  data[offset] = Math.fround(entity.transform.x);
  data[offset + 1] = Math.fround(entity.transform.z);
  data[offset + 2] = Math.fround(entity.transform.y);
  data[offset + 3] = Math.fround(entityLodProxyRadius3D(entity));
  normalizeColorHex(
    ENTITY_LOD_PROXY_USE_TEAM_COLOR
      ? entityInstanceColorHex(entity)
      : ENTITY_LOD_PROXY_NEUTRAL_COLOR,
    data,
    offset + 4,
  );
}

export class EntityLodProxyWebGpuRenderer3D {
  private readonly uniformData = new Float32Array(UNIFORM_FLOATS);
  private readonly viewProjection = new THREE.Matrix4();
  private readonly quadVertexBuffer: GpuBufferLike;
  private readonly unitBatch: GpuProxyBatch;
  private readonly buildingBatch: GpuProxyBatch;
  private configuredWidth = 0;
  private configuredHeight = 0;
  private renderedLastFrame = false;

  static async create(
    options: EntityLodProxyWebGpuRendererOptions3D,
  ): Promise<EntityLodProxyWebGpuRenderer3D | null> {
    if (typeof document === 'undefined') return null;
    const gpu = getNavigatorGpu();
    if (gpu === null) return null;
    const overlayCanvas = createOverlayCanvas(options.baseCanvas);
    if (overlayCanvas === null) return null;
    const context = overlayCanvas.getContext('webgpu') as GpuCanvasContextLike | null;
    if (context === null) {
      overlayCanvas.remove();
      return null;
    }

    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter === null) {
        overlayCanvas.remove();
        return null;
      }
      const device = await adapter.requestDevice();
      const format = gpu.getPreferredCanvasFormat();
      return new EntityLodProxyWebGpuRenderer3D({
        baseCanvas: options.baseCanvas,
        camera: options.camera,
        context,
        device,
        format,
        overlayCanvas,
      });
    } catch {
      overlayCanvas.remove();
      return null;
    }
  }

  private constructor(
    private readonly options: EntityLodProxyWebGpuRendererOptions3D & {
      readonly context: GpuCanvasContextLike;
      readonly device: GpuDeviceLike;
      readonly format: string;
      readonly overlayCanvas: HTMLCanvasElement;
    },
  ) {
    const { device, format } = this.options;
    const shaderModule = device.createShaderModule({ code: PROXY_SHADER });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPU_SHADER_STAGE_VERTEX,
          buffer: { type: 'uniform' },
        },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });
    this.quadVertexBuffer = device.createBuffer({
      size: QUAD_CORNERS.byteLength,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    });
    device.queue.writeBuffer(this.quadVertexBuffer, 0, QUAD_CORNERS);
    this.unitBatch = createGpuBatch(
      device,
      bindGroupLayout,
      ENTITY_LOD_PROXY_UNIT_MIN_PIXELS,
      ENTITY_LOD_PROXY_UNIT_MAX_PIXELS,
    );
    this.buildingBatch = createGpuBatch(
      device,
      bindGroupLayout,
      ENTITY_LOD_PROXY_BUILDING_MIN_PIXELS,
      ENTITY_LOD_PROXY_BUILDING_MAX_PIXELS,
    );
    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
            stepMode: 'vertex',
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: 'float32x2',
              },
            ],
          },
          {
            arrayStride: INSTANCE_BYTES,
            stepMode: 'instance',
            attributes: [
              {
                shaderLocation: 1,
                offset: 0,
                format: 'float32x3',
              },
              {
                shaderLocation: 2,
                offset: 3 * Float32Array.BYTES_PER_ELEMENT,
                format: 'float32',
              },
              {
                shaderLocation: 3,
                offset: 4 * Float32Array.BYTES_PER_ELEMENT,
                format: 'float32x4',
              },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fsMain',
        targets: [{ format }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }

  private readonly pipeline: unknown;

  beginFrame(): void {
    this.unitBatch.count = 0;
    this.buildingBatch.count = 0;
  }

  pushUnit(entity: Entity): void {
    const unit = entity.unit;
    const slot = this.unitBatch.count;
    if (unit === null || slot >= ENTITY_LOD_PROXY_CAP) return;
    writeProxyInstance(this.unitBatch, slot, entity);
    this.unitBatch.count = slot + 1;
  }

  pushBuilding(entity: Entity): void {
    const building = entity.building;
    const slot = this.buildingBatch.count;
    if (building === null || slot >= ENTITY_LOD_PROXY_CAP) return;
    writeProxyInstance(this.buildingBatch, slot, entity);
    this.buildingBatch.count = slot + 1;
  }

  flush(viewportHeight: number): void {
    const width = Math.max(1, Math.round(this.options.baseCanvas.clientWidth));
    const height = Math.max(
      1,
      Math.round(this.options.baseCanvas.clientHeight || viewportHeight),
    );
    this.resize(width, height);
    if (this.unitBatch.count <= 0 && this.buildingBatch.count <= 0) {
      if (this.renderedLastFrame) {
        this.render();
        this.renderedLastFrame = false;
      }
      return;
    }
    this.options.camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(
      this.options.camera.projectionMatrix,
      this.options.camera.matrixWorldInverse,
    );
    if (this.unitBatch.count > 0) {
      this.updateBatchUniform(this.unitBatch, width, height);
      this.uploadBatch(this.unitBatch);
    }
    if (this.buildingBatch.count > 0) {
      this.updateBatchUniform(this.buildingBatch, width, height);
      this.uploadBatch(this.buildingBatch);
    }
    this.render();
    this.renderedLastFrame = true;
  }

  destroy(): void {
    this.quadVertexBuffer.destroy?.();
    this.unitBatch.instanceBuffer.destroy?.();
    this.unitBatch.uniformBuffer.destroy?.();
    this.buildingBatch.instanceBuffer.destroy?.();
    this.buildingBatch.uniformBuffer.destroy?.();
    this.options.overlayCanvas.remove();
    this.options.device.destroy?.();
  }

  private resize(width: number, height: number): void {
    if (width === this.configuredWidth && height === this.configuredHeight) return;
    this.configuredWidth = width;
    this.configuredHeight = height;
    this.options.overlayCanvas.width = width;
    this.options.overlayCanvas.height = height;
    this.options.context.configure({
      device: this.options.device,
      format: this.options.format,
      alphaMode: 'premultiplied',
    });
  }

  private updateBatchUniform(batch: GpuProxyBatch, width: number, height: number): void {
    this.uniformData.set(this.viewProjection.elements, 0);
    this.uniformData.set(this.options.camera.matrixWorldInverse.elements, 16);
    this.uniformData[32] = width;
    this.uniformData[33] = height;
    this.uniformData[34] = this.options.camera.projectionMatrix.elements[5] ?? 1;
    this.uniformData[35] = batch.minPixels;
    this.uniformData[36] = batch.maxPixels;
    this.uniformData[37] = 0;
    this.uniformData[38] = 0;
    this.uniformData[39] = 0;
    this.options.device.queue.writeBuffer(batch.uniformBuffer, 0, this.uniformData);
  }

  private uploadBatch(batch: GpuProxyBatch): void {
    if (batch.count <= 0) return;
    this.options.device.queue.writeBuffer(
      batch.instanceBuffer,
      0,
      batch.data,
      0,
      batch.count * INSTANCE_BYTES,
    );
  }

  private render(): void {
    const encoder = this.options.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.options.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setVertexBuffer(0, this.quadVertexBuffer);
    this.drawBatch(pass, this.unitBatch);
    this.drawBatch(pass, this.buildingBatch);
    pass.end();
    this.options.device.queue.submit([encoder.finish()]);
  }

  private drawBatch(pass: GpuRenderPassEncoderLike, batch: GpuProxyBatch): void {
    if (batch.count <= 0) return;
    pass.setBindGroup(0, batch.bindGroup);
    pass.setVertexBuffer(1, batch.instanceBuffer);
    pass.draw(6, batch.count);
  }
}
