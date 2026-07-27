import {
  rotateVectorByQuaternionInto,
  type MutableVector3Tuple,
} from '../math/quaternionTupleMath';
import { WasmPoseBatch3D } from './wasmPoseBatch3D';

export const TURRET_HEAD_INPUT_STRIDE = 11;
const TURRET_HEAD_OUTPUT_STRIDE = 16;

export class UnitTurretHeadMatrixBatch3D extends WasmPoseBatch3D {
  private readonly fallbackCenter: MutableVector3Tuple = [0, 0, 0];

  constructor() {
    super('turretHead', TURRET_HEAD_INPUT_STRIDE, TURRET_HEAD_OUTPUT_STRIDE);
  }

  protected computeFallback(count: number): void {
    const input = this.input;
    const output = this.output;
    for (let i = 0; i < count; i++) {
      const ib = i * this.inputStride;
      const ob = i * this.outputStride;
      const radius = input[ib + 10];
      const center = rotateVectorByQuaternionInto(
        this.fallbackCenter,
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

}
