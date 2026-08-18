import { getSimWasm, type RenderPoseApi, type SimWasm } from '../sim-wasm/init';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';
import { growTypedArrayGeometrically } from '../memory/typedArrayGrowth';

/** Prefix naming a RenderPoseApi scratch-batch sextet
 *  (`<prefix>ScratchEnsure`, `<prefix>InputStride`, ...). */
type RenderPoseBatchPrefix = {
  [K in keyof RenderPoseApi]: K extends `${infer P}ScratchEnsure` ? P : never;
}[keyof RenderPoseApi];

/** Resolves one RenderPoseApi scratch-batch sextet from its prefix and owns
 *  the zero-copy view contract. Subclasses differ only in what they do when
 *  sim-wasm is absent. */
abstract class RenderPoseScratchBinding {
  inputStride: number;
  outputStride: number;

  protected input = new Float32Array(0);
  protected output = new Float32Array(0);
  protected wasm: SimWasm | null = null;

  protected readonly defaultInputStride: number;
  protected readonly defaultOutputStride: number;
  protected readonly prefix: RenderPoseBatchPrefix;
  private readonly scratchEnsureKey: `${RenderPoseBatchPrefix}ScratchEnsure`;
  private readonly inputStrideKey: `${RenderPoseBatchPrefix}InputStride`;
  private readonly outputStrideKey: `${RenderPoseBatchPrefix}OutputStride`;
  private readonly inputScratchPtrKey: `${RenderPoseBatchPrefix}InputScratchPtr`;
  private readonly outputScratchPtrKey: `${RenderPoseBatchPrefix}OutputScratchPtr`;
  private readonly computeKey: `${RenderPoseBatchPrefix}Compute`;
  private readonly computeLabel: string;

  protected constructor(
    prefix: RenderPoseBatchPrefix,
    defaultInputStride: number,
    defaultOutputStride: number,
  ) {
    this.prefix = prefix;
    this.defaultInputStride = defaultInputStride;
    this.defaultOutputStride = defaultOutputStride;
    this.inputStride = defaultInputStride;
    this.outputStride = defaultOutputStride;
    this.scratchEnsureKey = `${prefix}ScratchEnsure`;
    this.inputStrideKey = `${prefix}InputStride`;
    this.outputStrideKey = `${prefix}OutputStride`;
    this.inputScratchPtrKey = `${prefix}InputScratchPtr`;
    this.outputScratchPtrKey = `${prefix}OutputScratchPtr`;
    this.computeKey = `${prefix}Compute`;
    this.computeLabel = `renderPose.${prefix}Compute`;
  }

  /** Grows this batch's wasm-side scratch. Growth can detach every existing
   *  view over wasm memory, which is why binding is a separate step. */
  protected ensureWasmScratch(wasm: SimWasm, count: number): void {
    wasm.renderPose[this.scratchEnsureKey](count);
  }

  /** (Re)builds the input/output views. Must run after the last ensure that
   *  could have grown wasm memory. */
  protected bindWasmViews(wasm: SimWasm, count: number): void {
    const renderPose = wasm.renderPose;
    this.inputStride = renderPose[this.inputStrideKey];
    this.outputStride = renderPose[this.outputStrideKey];
    this.input = new Float32Array(
      wasm.memory.buffer,
      renderPose[this.inputScratchPtrKey](),
      count * this.inputStride,
    );
    this.output = new Float32Array(
      wasm.memory.buffer,
      renderPose[this.outputScratchPtrKey](),
      count * this.outputStride,
    );
  }

  protected runWasmCompute(wasm: SimWasm, count: number): void {
    measureWasmBoundary(this.computeLabel, () => {
      wasm.renderPose[this.computeKey](count);
    });
  }
}

/** Batch that keeps a TypeScript implementation for hosts without sim-wasm. */
export abstract class WasmPoseBatch3D extends RenderPoseScratchBinding {
  begin(count: number): Float32Array {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
      this.ensureWasmScratch(wasm, count);
      this.bindWasmViews(wasm, count);
      return this.input;
    }

    this.inputStride = this.defaultInputStride;
    this.outputStride = this.defaultOutputStride;
    this.input = growTypedArrayGeometrically(
      this.input,
      count * this.inputStride,
    );
    this.output = growTypedArrayGeometrically(
      this.output,
      count * this.outputStride,
    );
    return this.input;
  }

  compute(count: number): Float32Array {
    if (this.wasm !== null) {
      this.runWasmCompute(this.wasm, count);
      return this.output;
    }
    this.computeFallback(count);
    return this.output;
  }

  protected abstract computeFallback(count: number): void;
}

/** Batch with no TypeScript implementation: sim-wasm is the only path, so an
 *  uninitialized host is a hard error rather than a silent slow lane.
 *
 *  `ensure` and `bind` are split so a caller holding several of these at once
 *  can grow every scratch before binding any view. Growing one batch's scratch
 *  can detach wasm memory, and a view bound earlier would go with it. */
export abstract class RequiredWasmPoseBatch3D extends RenderPoseScratchBinding {
  ensure(count: number): void {
    const wasm = getSimWasm() ?? null;
    if (wasm === null) {
      throw new Error(`${this.prefix} pose batch requires initialized sim-wasm`);
    }
    this.wasm = wasm;
    this.ensureWasmScratch(wasm, count);
  }

  bind(count: number): Float32Array {
    const wasm = this.wasm;
    if (wasm === null) {
      throw new Error(`${this.prefix} pose batch bound before ensure`);
    }
    this.bindWasmViews(wasm, count);
    return this.input;
  }

  begin(count: number): Float32Array {
    this.ensure(count);
    return this.bind(count);
  }

  compute(count: number): Float32Array {
    const wasm = this.wasm;
    if (wasm === null) {
      throw new Error(`${this.prefix} pose batch computed before begin`);
    }
    this.runWasmCompute(wasm, count);
    return this.output;
  }
}
