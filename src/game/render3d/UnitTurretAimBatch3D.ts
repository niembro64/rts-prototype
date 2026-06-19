import { getSimWasm, type SimWasm } from '../sim-wasm/init';

export const TURRET_AIM_INPUT_STRIDE = 12;
const TURRET_AIM_OUTPUT_STRIDE = 2;
export const TURRET_AIM_MODE_POSE = 0;
export const TURRET_AIM_MODE_WORLD_DIR = 1;

export class UnitTurretAimBatch3D {
  inputStride = TURRET_AIM_INPUT_STRIDE;
  outputStride = TURRET_AIM_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): Float32Array {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
      const renderPose = wasm.renderPose;
      renderPose.turretAimScratchEnsure(count);
      this.inputStride = renderPose.turretAimInputStride;
      this.outputStride = renderPose.turretAimOutputStride;
      this.input = new Float32Array(
        wasm.memory.buffer,
        renderPose.turretAimInputScratchPtr(),
        count * this.inputStride,
      );
      this.output = new Float32Array(
        wasm.memory.buffer,
        renderPose.turretAimOutputScratchPtr(),
        count * this.outputStride,
      );
      return this.input;
    }

    this.inputStride = TURRET_AIM_INPUT_STRIDE;
    this.outputStride = TURRET_AIM_OUTPUT_STRIDE;
    const inputLength = count * this.inputStride;
    if (this.input.length < inputLength) this.input = new Float32Array(inputLength);
    const outputLength = count * this.outputStride;
    if (this.output.length < outputLength) this.output = new Float32Array(outputLength);
    return this.input;
  }

  compute(count: number): Float32Array {
    if (this.wasm !== null) {
      this.wasm.renderPose.turretAimCompute(count);
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
      const hostRotation = input[ib];
      let aimRotation = input[ib + 2];
      let aimPitch = input[ib + 3];
      if (input[ib + 1] === TURRET_AIM_MODE_WORLD_DIR) {
        const dirX = input[ib + 4];
        const dirY = input[ib + 5];
        const dirZ = input[ib + 6];
        aimRotation = Math.atan2(dirY, dirX);
        aimPitch = Math.atan2(dirZ, Math.hypot(dirX, dirY));
      }

      const cosRot = Math.cos(aimRotation);
      const sinRot = Math.sin(aimRotation);
      const cosPitch = Math.cos(aimPitch);
      const sinPitch = Math.sin(aimPitch);
      let x = cosRot * cosPitch;
      let y = sinPitch;
      let z = sinRot * cosPitch;
      if (input[ib + 11] !== 0) {
        const rotated = this.rotateVec(
          input[ib + 7],
          input[ib + 8],
          input[ib + 9],
          input[ib + 10],
          x,
          y,
          z,
        );
        x = rotated[0];
        y = rotated[1];
        z = rotated[2];
      }

      output[ob] = Math.atan2(-z, x) + hostRotation;
      output[ob + 1] = Math.asin(y < -1 ? -1 : y > 1 ? 1 : y);
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
