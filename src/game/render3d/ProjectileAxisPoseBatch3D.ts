import { getSimWasm, type SimWasm } from '../sim-wasm/init';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';

const PROJECTILE_AXIS_INPUT_STRIDE = 4;
const PROJECTILE_AXIS_OUTPUT_STRIDE = 7;

/** Thin zero-copy bridge to the Rust projectile presentation-axis batch. */
export class ProjectileAxisPoseBatch3D {
  inputStride = PROJECTILE_AXIS_INPUT_STRIDE;
  outputStride = PROJECTILE_AXIS_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): void {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm === null) {
      throw new Error('ProjectileAxisPoseBatch3D requires initialized sim-wasm');
    }
    const renderPose = wasm.renderPose;
    renderPose.projectileAxisScratchEnsure(count);
    this.inputStride = renderPose.projectileAxisInputStride;
    this.outputStride = renderPose.projectileAxisOutputStride;
    this.input = new Float32Array(
      wasm.memory.buffer,
      renderPose.projectileAxisInputScratchPtr(),
      count * this.inputStride,
    );
    this.output = new Float32Array(
      wasm.memory.buffer,
      renderPose.projectileAxisOutputScratchPtr(),
      count * this.outputStride,
    );
  }

  write(
    index: number,
    velocityX: number,
    velocityY: number,
    velocityZ: number,
    fallbackRotation: number,
  ): void {
    const base = index * this.inputStride;
    this.input[base] = velocityX;
    this.input[base + 1] = velocityY;
    this.input[base + 2] = velocityZ;
    this.input[base + 3] = fallbackRotation;
  }

  compute(count: number): Float32Array {
    if (this.wasm === null) {
      throw new Error('ProjectileAxisPoseBatch3D.compute called before begin');
    }
    measureWasmBoundary('renderPose.projectileAxisCompute', () => {
      this.wasm!.renderPose.projectileAxisCompute(count);
    });
    return this.output;
  }
}
