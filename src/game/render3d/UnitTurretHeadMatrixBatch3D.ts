import {
  composeChildOffsetInto,
  multiplyQuaternionsInto,
  type MutableQuaternionTuple,
  type MutableVector3Tuple,
} from '../math/quaternionTupleMath';
import { writeScaledQuaternionMatrix } from './typedArrayRenderUtils';
import { WasmPoseBatch3D } from './wasmPoseBatch3D';

export const TURRET_HEAD_INPUT_STRIDE = 15;
const TURRET_HEAD_OUTPUT_STRIDE = 16;

type Vector3Like = { x: number; y: number; z: number };
type QuaternionLike = Vector3Like & { w: number };

/** Write the complete visual turret-body pose. The spherical head's surface
 * chart contains a directional pitch slot, so yaw is visible data even though
 * the underlying geometry is rotationally symmetric. */
export function writeTurretHeadInput(
  output: Float32Array,
  offset: number,
  parentPosition: Vector3Like,
  parentQuaternion: QuaternionLike,
  mountPosition: Vector3Like,
  headRadius: number,
  bodyYawQuaternion: QuaternionLike,
): void {
  output[offset] = parentPosition.x;
  output[offset + 1] = parentPosition.y;
  output[offset + 2] = parentPosition.z;
  output[offset + 3] = parentQuaternion.x;
  output[offset + 4] = parentQuaternion.y;
  output[offset + 5] = parentQuaternion.z;
  output[offset + 6] = parentQuaternion.w;
  output[offset + 7] = mountPosition.x;
  output[offset + 8] = mountPosition.y;
  output[offset + 9] = mountPosition.z;
  output[offset + 10] = headRadius;
  output[offset + 11] = bodyYawQuaternion.x;
  output[offset + 12] = bodyYawQuaternion.y;
  output[offset + 13] = bodyYawQuaternion.z;
  output[offset + 14] = bodyYawQuaternion.w;
}

export class UnitTurretHeadMatrixBatch3D extends WasmPoseBatch3D {
  private readonly fallbackMountWorld: MutableVector3Tuple = [0, 0, 0];
  private readonly fallbackCenter: MutableVector3Tuple = [0, 0, 0];
  private readonly fallbackBodyWorldQ: MutableQuaternionTuple = [0, 0, 0, 1];

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
      const mountWorld = composeChildOffsetInto(
        this.fallbackMountWorld,
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        input[ib],
        input[ib + 1],
        input[ib + 2],
        input[ib + 7],
        input[ib + 8],
        input[ib + 9],
      );
      const bodyWorldQ = multiplyQuaternionsInto(
        this.fallbackBodyWorldQ,
        input[ib + 3],
        input[ib + 4],
        input[ib + 5],
        input[ib + 6],
        input[ib + 11],
        input[ib + 12],
        input[ib + 13],
        input[ib + 14],
      );
      const center = composeChildOffsetInto(
        this.fallbackCenter,
        bodyWorldQ[0],
        bodyWorldQ[1],
        bodyWorldQ[2],
        bodyWorldQ[3],
        mountWorld[0],
        mountWorld[1],
        mountWorld[2],
        0,
        radius,
        0,
      );
      writeScaledQuaternionMatrix(
        output,
        ob,
        center[0], center[1], center[2],
        bodyWorldQ[0], bodyWorldQ[1], bodyWorldQ[2], bodyWorldQ[3],
        radius, radius, radius,
      );
    }
  }

}
