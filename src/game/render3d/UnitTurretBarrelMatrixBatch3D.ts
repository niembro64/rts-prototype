import { getSimWasm, type SimWasm } from '../sim-wasm/init';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';
import { growTypedArrayGeometrically } from '../memory/typedArrayGrowth';
import {
  composeChildOffsetInto,
  multiplyQuaternionsInto,
  type MutableQuaternionTuple,
  type MutableVector3Tuple,
} from '../math/quaternionTupleMath';
import { writeScaledQuaternionMatrix } from './typedArrayRenderUtils';

export const TURRET_BARREL_INPUT_STRIDE = 38;
const TURRET_BARREL_OUTPUT_STRIDE = 16;

export class UnitTurretBarrelMatrixBatch3D {
  inputStride = TURRET_BARREL_INPUT_STRIDE;
  outputStride = TURRET_BARREL_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;
  private readonly fallbackRootWorldPos: MutableVector3Tuple = [0, 0, 0];
  private readonly fallbackPitchWorldPos: MutableVector3Tuple = [0, 0, 0];
  private readonly fallbackSpinWorldPos: MutableVector3Tuple = [0, 0, 0];
  private readonly fallbackBarrelWorldPos: MutableVector3Tuple = [0, 0, 0];
  private readonly fallbackRootWorldQ: MutableQuaternionTuple = [0, 0, 0, 1];
  private readonly fallbackPitchWorldQ: MutableQuaternionTuple = [0, 0, 0, 1];
  private readonly fallbackSpinWorldQ: MutableQuaternionTuple = [0, 0, 0, 1];
  private readonly fallbackBarrelWorldQ: MutableQuaternionTuple = [0, 0, 0, 1];

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
      const parentX = input[ib];
      const parentY = input[ib + 1];
      const parentZ = input[ib + 2];
      const parentQX = input[ib + 3];
      const parentQY = input[ib + 4];
      const parentQZ = input[ib + 5];
      const parentQW = input[ib + 6];

      const rootWorldPos = composeChildOffsetInto(
        this.fallbackRootWorldPos,
        parentQX,
        parentQY,
        parentQZ,
        parentQW,
        parentX,
        parentY,
        parentZ,
        input[ib + 7],
        input[ib + 8],
        input[ib + 9],
      );
      const rootWorldQ = multiplyQuaternionsInto(
        this.fallbackRootWorldQ,
        parentQX,
        parentQY,
        parentQZ,
        parentQW,
        input[ib + 10],
        input[ib + 11],
        input[ib + 12],
        input[ib + 13],
      );
      const pitchWorldPos = composeChildOffsetInto(
        this.fallbackPitchWorldPos,
        rootWorldQ[0],
        rootWorldQ[1],
        rootWorldQ[2],
        rootWorldQ[3],
        rootWorldPos[0],
        rootWorldPos[1],
        rootWorldPos[2],
        input[ib + 14],
        input[ib + 15],
        input[ib + 16],
      );
      const pitchWorldQ = multiplyQuaternionsInto(
        this.fallbackPitchWorldQ,
        rootWorldQ[0],
        rootWorldQ[1],
        rootWorldQ[2],
        rootWorldQ[3],
        input[ib + 17],
        input[ib + 18],
        input[ib + 19],
        input[ib + 20],
      );
      const spinWorldPos = composeChildOffsetInto(
        this.fallbackSpinWorldPos,
        pitchWorldQ[0],
        pitchWorldQ[1],
        pitchWorldQ[2],
        pitchWorldQ[3],
        pitchWorldPos[0],
        pitchWorldPos[1],
        pitchWorldPos[2],
        input[ib + 21],
        input[ib + 22],
        input[ib + 23],
      );
      const spinWorldQ = multiplyQuaternionsInto(
        this.fallbackSpinWorldQ,
        pitchWorldQ[0],
        pitchWorldQ[1],
        pitchWorldQ[2],
        pitchWorldQ[3],
        input[ib + 24],
        input[ib + 25],
        input[ib + 26],
        input[ib + 27],
      );
      const barrelWorldPos = composeChildOffsetInto(
        this.fallbackBarrelWorldPos,
        spinWorldQ[0],
        spinWorldQ[1],
        spinWorldQ[2],
        spinWorldQ[3],
        spinWorldPos[0],
        spinWorldPos[1],
        spinWorldPos[2],
        input[ib + 28],
        input[ib + 29],
        input[ib + 30],
      );
      const barrelWorldQ = multiplyQuaternionsInto(
        this.fallbackBarrelWorldQ,
        spinWorldQ[0],
        spinWorldQ[1],
        spinWorldQ[2],
        spinWorldQ[3],
        input[ib + 31],
        input[ib + 32],
        input[ib + 33],
        input[ib + 34],
      );

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

}
