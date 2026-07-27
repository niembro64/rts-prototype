import { getSimWasm, type RenderPoseApi, type SimWasm } from '../sim-wasm/init';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';
import { growTypedArrayGeometrically } from '../memory/typedArrayGrowth';

/** Prefix naming a RenderPoseApi scratch-batch sextet
 *  (`<prefix>ScratchEnsure`, `<prefix>InputStride`, ...). */
type RenderPoseBatchPrefix = {
  [K in keyof RenderPoseApi]: K extends `${infer P}ScratchEnsure` ? P : never;
}[keyof RenderPoseApi];

export abstract class WasmPoseBatch3D {
  inputStride: number;
  outputStride: number;

  protected input = new Float32Array(0);
  protected output = new Float32Array(0);
  protected wasm: SimWasm | null = null;

  private readonly defaultInputStride: number;
  private readonly defaultOutputStride: number;
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

  // Views over wasm.memory.buffer must be rebuilt on every begin(): the
  // scratch-ensure call can grow (and thus detach) the wasm memory.
  begin(count: number): Float32Array {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
      const renderPose = wasm.renderPose;
      renderPose[this.scratchEnsureKey](count);
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
      measureWasmBoundary(this.computeLabel, () => {
        this.wasm!.renderPose[this.computeKey](count);
      });
      return this.output;
    }
    this.computeFallback(count);
    return this.output;
  }

  protected abstract computeFallback(count: number): void;
}
