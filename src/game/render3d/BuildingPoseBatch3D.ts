import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export const BUILDING_POSE_INPUT_STRIDE = 8;
export const BUILDING_POSE_OUTPUT_STRIDE = 32;

const GROUP_MATRIX_OFFSET = 0;
const BODY_MATRIX_OFFSET = 16;

export class BuildingPoseBatch3D {
  inputStride = BUILDING_POSE_INPUT_STRIDE;
  outputStride = BUILDING_POSE_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): Float32Array {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
      const renderPose = wasm.renderPose;
      renderPose.buildingScratchEnsure(count);
      this.inputStride = renderPose.buildingInputStride;
      this.outputStride = renderPose.buildingOutputStride;
      this.input = new Float32Array(
        wasm.memory.buffer,
        renderPose.buildingInputScratchPtr(),
        count * this.inputStride,
      );
      this.output = new Float32Array(
        wasm.memory.buffer,
        renderPose.buildingOutputScratchPtr(),
        count * this.outputStride,
      );
      return this.input;
    }

    this.inputStride = BUILDING_POSE_INPUT_STRIDE;
    this.outputStride = BUILDING_POSE_OUTPUT_STRIDE;
    const inputLength = count * this.inputStride;
    if (this.input.length < inputLength) this.input = new Float32Array(inputLength);
    const outputLength = count * this.outputStride;
    if (this.output.length < outputLength) this.output = new Float32Array(outputLength);
    return this.input;
  }

  compute(count: number): Float32Array {
    if (this.wasm !== null) {
      this.wasm.renderPose.buildingCompute(count);
      return this.output;
    }
    this.computeFallback(count);
    return this.output;
  }

  private computeFallback(count: number): void {
    const input = this.input;
    const output = this.output;
    for (let i = 0; i < count; i++) {
      const ib = i * this.inputStride;
      const ob = i * this.outputStride;
      this.writeGroupMatrix(
        output,
        ob + GROUP_MATRIX_OFFSET,
        input[ib],
        input[ib + 1],
        input[ib + 2],
        input[ib + 3],
      );
      this.writeBodyMatrix(
        output,
        ob + BODY_MATRIX_OFFSET,
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        input[ib + 7] !== 0,
      );
    }
  }

  private writeGroupMatrix(
    output: Float32Array,
    offset: number,
    x: number,
    simY: number,
    baseY: number,
    simRotation: number,
  ): void {
    const yaw = -simRotation;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    output[offset] = c;
    output[offset + 1] = 0;
    output[offset + 2] = -s;
    output[offset + 3] = 0;
    output[offset + 4] = 0;
    output[offset + 5] = 1;
    output[offset + 6] = 0;
    output[offset + 7] = 0;
    output[offset + 8] = s;
    output[offset + 9] = 0;
    output[offset + 10] = c;
    output[offset + 11] = 0;
    output[offset + 12] = x;
    output[offset + 13] = baseY;
    output[offset + 14] = simY;
    output[offset + 15] = 1;
  }

  private writeBodyMatrix(
    output: Float32Array,
    offset: number,
    width: number,
    height: number,
    depth: number,
    bodyless: boolean,
  ): void {
    const sx = bodyless ? 1 : width;
    const sy = bodyless ? 1 : height;
    const sz = bodyless ? 1 : depth;
    output[offset] = sx;
    output[offset + 1] = 0;
    output[offset + 2] = 0;
    output[offset + 3] = 0;
    output[offset + 4] = 0;
    output[offset + 5] = sy;
    output[offset + 6] = 0;
    output[offset + 7] = 0;
    output[offset + 8] = 0;
    output[offset + 9] = 0;
    output[offset + 10] = sz;
    output[offset + 11] = 0;
    output[offset + 12] = 0;
    output[offset + 13] = bodyless ? 0 : height / 2;
    output[offset + 14] = 0;
    output[offset + 15] = 1;
  }
}
