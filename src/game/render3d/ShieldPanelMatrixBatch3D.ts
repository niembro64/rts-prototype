import {
  multiplyQuaternionsInto,
  rotateVectorByQuaternionInto,
  type MutableQuaternionTuple,
  type MutableVector3Tuple,
} from '../math/quaternionTupleMath';
import { writeScaledQuaternionMatrix } from './typedArrayRenderUtils';
import { WasmPoseBatch3D } from './wasmPoseBatch3D';

export const SHIELD_PANEL_INPUT_STRIDE = 24;
const SHIELD_PANEL_OUTPUT_STRIDE = 16;

export class ShieldPanelMatrixBatch3D extends WasmPoseBatch3D {
  private readonly fallbackRootOffset: MutableVector3Tuple = [0, 0, 0];
  private readonly fallbackWorldOffset: MutableVector3Tuple = [0, 0, 0];
  private readonly fallbackRootQ: MutableQuaternionTuple = [0, 0, 0, 1];
  private readonly fallbackWorldQ: MutableQuaternionTuple = [0, 0, 0, 1];

  constructor() {
    super('shieldPanel', SHIELD_PANEL_INPUT_STRIDE, SHIELD_PANEL_OUTPUT_STRIDE);
  }

  protected computeFallback(count: number): void {
    const input = this.input;
    for (let i = 0; i < count; i++) {
      const ib = i * this.inputStride;
      const rootOffset = rotateVectorByQuaternionInto(
        this.fallbackRootOffset,
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
      const worldOffset = rotateVectorByQuaternionInto(
        this.fallbackWorldOffset,
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        localX,
        localY,
        localZ,
      );
      const rootQ = multiplyQuaternionsInto(
        this.fallbackRootQ,
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        input[ib + 10],
        input[ib + 11],
        input[ib + 12],
        input[ib + 13],
      );
      const worldQ = multiplyQuaternionsInto(
        this.fallbackWorldQ,
        rootQ[0],
        rootQ[1],
        rootQ[2],
        rootQ[3],
        input[ib + 17],
        input[ib + 18],
        input[ib + 19],
        input[ib + 20],
      );
      writeScaledQuaternionMatrix(
        this.output,
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

}
