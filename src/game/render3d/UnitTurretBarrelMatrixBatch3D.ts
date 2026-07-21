import { getSimWasm, type SimWasm } from '../sim-wasm/init';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';
import { writeScaledQuaternionMatrix } from './typedArrayRenderUtils';

export const TURRET_BARREL_INPUT_STRIDE = 38;
const TURRET_BARREL_OUTPUT_STRIDE = 16;

export class UnitTurretBarrelMatrixBatch3D {
  inputStride = TURRET_BARREL_INPUT_STRIDE;
  outputStride = TURRET_BARREL_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): Float32Array {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
      const renderPose = wasm.renderPose;
      renderPose.turretBarrelScratchEnsure(count);
      this.inputStride = renderPose.turretBarrelInputStride;
      this.outputStride = renderPose.turretBarrelOutputStride;
      this.input = new Float32Array(
        wasm.memory.buffer,
        renderPose.turretBarrelInputScratchPtr(),
        count * this.inputStride,
      );
      this.output = new Float32Array(
        wasm.memory.buffer,
        renderPose.turretBarrelOutputScratchPtr(),
        count * this.outputStride,
      );
      return this.input;
    }

    this.inputStride = TURRET_BARREL_INPUT_STRIDE;
    this.outputStride = TURRET_BARREL_OUTPUT_STRIDE;
    const inputLength = count * this.inputStride;
    if (this.input.length < inputLength) this.input = new Float32Array(inputLength);
    const outputLength = count * this.outputStride;
    if (this.output.length < outputLength) this.output = new Float32Array(outputLength);
    return this.input;
  }

  compute(count: number): Float32Array {
    if (this.wasm !== null) {
      measureWasmBoundary('renderPose.turretBarrelCompute', () => {
        this.wasm!.renderPose.turretBarrelCompute(count);
      });
      return this.output;
    }
    this.computeFallback(count);
    return this.output;
  }

  private computeFallback(count: number): void {
    const input = this.input;
    for (let i = 0; i < count; i++) {
      const ib = i * this.inputStride;
      const parentPos: [number, number, number] = [input[ib], input[ib + 1], input[ib + 2]];
      const parentQ: [number, number, number, number] = [
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
      ];
      const rootPos: [number, number, number] = [input[ib + 7], input[ib + 8], input[ib + 9]];
      const rootQ: [number, number, number, number] = [
        input[ib + 10],
        input[ib + 11],
        input[ib + 12],
        input[ib + 13],
      ];
      const pitchPos: [number, number, number] = [input[ib + 14], input[ib + 15], input[ib + 16]];
      const pitchQ: [number, number, number, number] = [
        input[ib + 17],
        input[ib + 18],
        input[ib + 19],
        input[ib + 20],
      ];
      const spinPos: [number, number, number] = [input[ib + 21], input[ib + 22], input[ib + 23]];
      const spinQ: [number, number, number, number] = [
        input[ib + 24],
        input[ib + 25],
        input[ib + 26],
        input[ib + 27],
      ];
      const barrelPos: [number, number, number] = [input[ib + 28], input[ib + 29], input[ib + 30]];
      const barrelQ: [number, number, number, number] = [
        input[ib + 31],
        input[ib + 32],
        input[ib + 33],
        input[ib + 34],
      ];

      const rootWorldPos = this.composeChildOffset(parentQ, parentPos, rootPos);
      const rootWorldQ = this.quatMul(parentQ, rootQ);
      const pitchWorldPos = this.composeChildOffset(rootWorldQ, rootWorldPos, pitchPos);
      const pitchWorldQ = this.quatMul(rootWorldQ, pitchQ);
      const spinWorldPos = this.composeChildOffset(pitchWorldQ, pitchWorldPos, spinPos);
      const spinWorldQ = this.quatMul(pitchWorldQ, spinQ);
      const barrelWorldPos = this.composeChildOffset(spinWorldQ, spinWorldPos, barrelPos);
      const barrelWorldQ = this.quatMul(spinWorldQ, barrelQ);

      writeScaledQuaternionMatrix(
        this.output,
        i * this.outputStride,
        barrelWorldPos[0],
        barrelWorldPos[1],
        barrelWorldPos[2],
        barrelWorldQ[0],
        barrelWorldQ[1],
        barrelWorldQ[2],
        barrelWorldQ[3],
        input[ib + 35],
        input[ib + 36],
        input[ib + 37],
      );
    }
  }

  private composeChildOffset(
    q: [number, number, number, number],
    pos: [number, number, number],
    childPos: [number, number, number],
  ): [number, number, number] {
    const rotated = this.rotateVec(q[0], q[1], q[2], q[3], childPos[0], childPos[1], childPos[2]);
    return [
      pos[0] + rotated[0],
      pos[1] + rotated[1],
      pos[2] + rotated[2],
    ];
  }

  private quatMul(
    a: [number, number, number, number],
    b: [number, number, number, number],
  ): [number, number, number, number] {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
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

}
