import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export const CHASSIS_PART_INPUT_STRIDE = 15;
const CHASSIS_PART_OUTPUT_STRIDE = 16;

export class UnitChassisMatrixBatch3D {
  inputStride = CHASSIS_PART_INPUT_STRIDE;
  outputStride = CHASSIS_PART_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): Float32Array {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
      const renderPose = wasm.renderPose;
      renderPose.chassisPartScratchEnsure(count);
      this.inputStride = renderPose.chassisPartInputStride;
      this.outputStride = renderPose.chassisPartOutputStride;
      this.input = new Float32Array(
        wasm.memory.buffer,
        renderPose.chassisPartInputScratchPtr(),
        count * this.inputStride,
      );
      this.output = new Float32Array(
        wasm.memory.buffer,
        renderPose.chassisPartOutputScratchPtr(),
        count * this.outputStride,
      );
      return this.input;
    }

    this.inputStride = CHASSIS_PART_INPUT_STRIDE;
    this.outputStride = CHASSIS_PART_OUTPUT_STRIDE;
    const inputLength = count * this.inputStride;
    if (this.input.length < inputLength) this.input = new Float32Array(inputLength);
    const outputLength = count * this.outputStride;
    if (this.output.length < outputLength) this.output = new Float32Array(outputLength);
    return this.input;
  }

  compute(count: number): Float32Array {
    if (this.wasm !== null) {
      this.wasm.renderPose.chassisPartCompute(count);
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
      this.writeChassisPartMatrix(
        output,
        ob,
        input[ib],
        input[ib + 1],
        input[ib + 2],
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        input[ib + 7],
        input[ib + 8],
        input[ib + 9],
        input[ib + 10],
        input[ib + 11],
        input[ib + 12],
        input[ib + 13],
        input[ib + 14],
      );
    }
  }

  private writeChassisPartMatrix(
    output: Float32Array,
    offset: number,
    parentX: number,
    parentY: number,
    parentZ: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    radius: number,
    partX: number,
    partY: number,
    partZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
    rotZ: number,
  ): void {
    const x2 = qx + qx;
    const y2 = qy + qy;
    const z2 = qz + qz;
    const xx = qx * x2;
    const xy = qx * y2;
    const xz = qx * z2;
    const yy = qy * y2;
    const yz = qy * z2;
    const zz = qz * z2;
    const wx = qw * x2;
    const wy = qw * y2;
    const wz = qw * z2;

    const p0x = (1 - (yy + zz)) * radius;
    const p0y = (xy + wz) * radius;
    const p0z = (xz - wy) * radius;
    const p1x = (xy - wz) * radius;
    const p1y = (1 - (xx + zz)) * radius;
    const p1z = (yz + wx) * radius;
    const p2x = (xz + wy) * radius;
    const p2y = (yz - wx) * radius;
    const p2z = (1 - (xx + yy)) * radius;

    const c = Math.cos(rotZ);
    const s = Math.sin(rotZ);

    output[offset] = (p0x * c + p1x * s) * scaleX;
    output[offset + 1] = (p0y * c + p1y * s) * scaleX;
    output[offset + 2] = (p0z * c + p1z * s) * scaleX;
    output[offset + 3] = 0;
    output[offset + 4] = (-p0x * s + p1x * c) * scaleY;
    output[offset + 5] = (-p0y * s + p1y * c) * scaleY;
    output[offset + 6] = (-p0z * s + p1z * c) * scaleY;
    output[offset + 7] = 0;
    output[offset + 8] = p2x * scaleZ;
    output[offset + 9] = p2y * scaleZ;
    output[offset + 10] = p2z * scaleZ;
    output[offset + 11] = 0;
    output[offset + 12] = parentX + p0x * partX + p1x * partY + p2x * partZ;
    output[offset + 13] = parentY + p0y * partX + p1y * partY + p2y * partZ;
    output[offset + 14] = parentZ + p0z * partX + p1z * partY + p2z * partZ;
    output[offset + 15] = 1;
  }
}
