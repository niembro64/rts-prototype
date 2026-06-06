import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export const SHIELD_PANEL_INPUT_STRIDE = 24;
export const SHIELD_PANEL_OUTPUT_STRIDE = 16;

export class ShieldPanelMatrixBatch3D {
  inputStride = SHIELD_PANEL_INPUT_STRIDE;
  outputStride = SHIELD_PANEL_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): Float32Array {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
      const renderPose = wasm.renderPose;
      renderPose.shieldPanelScratchEnsure(count);
      this.inputStride = renderPose.shieldPanelInputStride;
      this.outputStride = renderPose.shieldPanelOutputStride;
      this.input = new Float32Array(
        wasm.memory.buffer,
        renderPose.shieldPanelInputScratchPtr(),
        count * this.inputStride,
      );
      this.output = new Float32Array(
        wasm.memory.buffer,
        renderPose.shieldPanelOutputScratchPtr(),
        count * this.outputStride,
      );
      return this.input;
    }

    this.inputStride = SHIELD_PANEL_INPUT_STRIDE;
    this.outputStride = SHIELD_PANEL_OUTPUT_STRIDE;
    const inputLength = count * this.inputStride;
    if (this.input.length < inputLength) this.input = new Float32Array(inputLength);
    const outputLength = count * this.outputStride;
    if (this.output.length < outputLength) this.output = new Float32Array(outputLength);
    return this.input;
  }

  compute(count: number): Float32Array {
    if (this.wasm !== null) {
      this.wasm.renderPose.shieldPanelCompute(count);
      return this.output;
    }
    this.computeFallback(count);
    return this.output;
  }

  private computeFallback(count: number): void {
    const input = this.input;
    for (let i = 0; i < count; i++) {
      const ib = i * this.inputStride;
      const rootOffset = this.rotateVec(
        input[ib + 10],
        input[ib + 11],
        input[ib + 12],
        input[ib + 13],
        input[ib + 14],
        input[ib + 15],
        input[ib + 16],
      );
      const localX = input[ib + 7] + rootOffset[0];
      const localY = input[ib + 8] + rootOffset[1];
      const localZ = input[ib + 9] + rootOffset[2];
      const worldOffset = this.rotateVec(
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        localX,
        localY,
        localZ,
      );
      const rootQ = this.quatMul(
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        input[ib + 10],
        input[ib + 11],
        input[ib + 12],
        input[ib + 13],
      );
      const worldQ = this.quatMul(
        rootQ[0],
        rootQ[1],
        rootQ[2],
        rootQ[3],
        input[ib + 17],
        input[ib + 18],
        input[ib + 19],
        input[ib + 20],
      );
      this.writeComposeScaled(
        i * this.outputStride,
        input[ib] + worldOffset[0],
        input[ib + 1] + worldOffset[1],
        input[ib + 2] + worldOffset[2],
        worldQ[0],
        worldQ[1],
        worldQ[2],
        worldQ[3],
        input[ib + 21],
        input[ib + 22],
        input[ib + 23],
      );
    }
  }

  private quatMul(
    ax: number,
    ay: number,
    az: number,
    aw: number,
    bx: number,
    by: number,
    bz: number,
    bw: number,
  ): [number, number, number, number] {
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
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

  private writeComposeScaled(
    offset: number,
    px: number,
    py: number,
    pz: number,
    x: number,
    y: number,
    z: number,
    w: number,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const output = this.output;

    output[offset] = (1 - (yy + zz)) * sx;
    output[offset + 1] = (xy + wz) * sx;
    output[offset + 2] = (xz - wy) * sx;
    output[offset + 3] = 0;
    output[offset + 4] = (xy - wz) * sy;
    output[offset + 5] = (1 - (xx + zz)) * sy;
    output[offset + 6] = (yz + wx) * sy;
    output[offset + 7] = 0;
    output[offset + 8] = (xz + wy) * sz;
    output[offset + 9] = (yz - wx) * sz;
    output[offset + 10] = (1 - (xx + yy)) * sz;
    output[offset + 11] = 0;
    output[offset + 12] = px;
    output[offset + 13] = py;
    output[offset + 14] = pz;
    output[offset + 15] = 1;
  }
}
