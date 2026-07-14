import { getSimWasm, type SimWasm } from '../sim-wasm/init';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';

const UNIT_POSE_INPUT_STRIDE = 21;
const UNIT_POSE_OUTPUT_STRIDE = 33;

export class UnitRenderPoseBatch3D {
  inputStride = UNIT_POSE_INPUT_STRIDE;
  outputStride = UNIT_POSE_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): void {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm === null) {
      throw new Error('UnitRenderPoseBatch3D requires initialized sim-wasm');
    }
    const renderPose = wasm.renderPose;
    renderPose.unitScratchEnsure(count);
    this.inputStride = renderPose.unitInputStride;
    this.outputStride = renderPose.unitOutputStride;
    this.input = new Float32Array(
      wasm.memory.buffer,
      renderPose.unitInputScratchPtr(),
      count * this.inputStride,
    );
    this.output = new Float32Array(
      wasm.memory.buffer,
      renderPose.unitOutputScratchPtr(),
      count * this.outputStride,
    );
  }

  writeUnit(
    index: number,
    baseX: number,
    baseY: number,
    baseZ: number,
    simRotation: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    liftX: number,
    liftY: number,
    liftZ: number,
    airborne: boolean,
    velocityX: number,
    velocityY: number,
    yawRate: number,
    previousBankRoll: number,
    dtSec: number,
    orientationX: number,
    orientationY: number,
    orientationZ: number,
    orientationW: number,
    hasFullOrientation: boolean,
  ): void {
    const base = index * this.inputStride;
    const input = this.input;
    input[base] = baseX;
    input[base + 1] = baseY;
    input[base + 2] = baseZ;
    input[base + 3] = simRotation;
    input[base + 4] = normalX;
    input[base + 5] = normalY;
    input[base + 6] = normalZ;
    input[base + 7] = liftX;
    input[base + 8] = liftY;
    input[base + 9] = liftZ;
    input[base + 10] = airborne ? 1 : 0;
    input[base + 11] = velocityX;
    input[base + 12] = velocityY;
    input[base + 13] = yawRate;
    input[base + 14] = previousBankRoll;
    input[base + 15] = dtSec;
    input[base + 16] = orientationX;
    input[base + 17] = orientationY;
    input[base + 18] = orientationZ;
    input[base + 19] = orientationW;
    input[base + 20] = hasFullOrientation ? 1 : 0;
  }

  compute(count: number): Float32Array {
    if (this.wasm === null) {
      throw new Error('UnitRenderPoseBatch3D.compute called before begin');
    }
    measureWasmBoundary('renderPose.unitCompute', () => {
      this.wasm!.renderPose.unitCompute(count);
    });
    return this.output;
  }
}
