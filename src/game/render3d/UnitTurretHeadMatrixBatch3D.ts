import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export const TURRET_HEAD_INPUT_STRIDE = 11;
const TURRET_HEAD_OUTPUT_STRIDE = 16;

export class UnitTurretHeadMatrixBatch3D {
  inputStride = TURRET_HEAD_INPUT_STRIDE;
  outputStride = TURRET_HEAD_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): Float32Array {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
      const renderPose = wasm.renderPose;
      renderPose.turretHeadScratchEnsure(count);
      this.inputStride = renderPose.turretHeadInputStride;
      this.outputStride = renderPose.turretHeadOutputStride;
      this.input = new Float32Array(
        wasm.memory.buffer,
        renderPose.turretHeadInputScratchPtr(),
        count * this.inputStride,
      );
      this.output = new Float32Array(
        wasm.memory.buffer,
        renderPose.turretHeadOutputScratchPtr(),
        count * this.outputStride,
      );
      return this.input;
    }

    this.inputStride = TURRET_HEAD_INPUT_STRIDE;
    this.outputStride = TURRET_HEAD_OUTPUT_STRIDE;
    const inputLength = count * this.inputStride;
    if (this.input.length < inputLength) this.input = new Float32Array(inputLength);
    const outputLength = count * this.outputStride;
    if (this.output.length < outputLength) this.output = new Float32Array(outputLength);
    return this.input;
  }

  compute(count: number): Float32Array {
    if (this.wasm !== null) {
      this.wasm.renderPose.turretHeadCompute(count);
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
      const radius = input[ib + 10];
      const center = this.rotateVec(
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        input[ib + 7],
        input[ib + 8] + radius,
        input[ib + 9],
      );

      output[ob] = radius;
      output[ob + 1] = 0;
      output[ob + 2] = 0;
      output[ob + 3] = 0;
      output[ob + 4] = 0;
      output[ob + 5] = radius;
      output[ob + 6] = 0;
      output[ob + 7] = 0;
      output[ob + 8] = 0;
      output[ob + 9] = 0;
      output[ob + 10] = radius;
      output[ob + 11] = 0;
      output[ob + 12] = input[ib] + center[0];
      output[ob + 13] = input[ib + 1] + center[1];
      output[ob + 14] = input[ib + 2] + center[2];
      output[ob + 15] = 1;
    }
  }

  private rotateVec(
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    vx: number,
    vy: number,
    vz: number,
  ): [number, number, number] {
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return [
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    ];
  }
}
