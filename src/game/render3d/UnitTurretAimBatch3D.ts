import { clampUnit } from '../math';
import {
  rotateVectorByQuaternionInto,
  type MutableVector3Tuple,
} from '../math/quaternionTupleMath';
import { WasmPoseBatch3D } from './wasmPoseBatch3D';

export const TURRET_AIM_INPUT_STRIDE = 8;
const TURRET_AIM_OUTPUT_STRIDE = 2;

export class UnitTurretAimBatch3D extends WasmPoseBatch3D {
  private readonly fallbackRotated: MutableVector3Tuple = [0, 0, 0];

  constructor() {
    super('turretAim', TURRET_AIM_INPUT_STRIDE, TURRET_AIM_OUTPUT_STRIDE);
  }

  protected computeFallback(count: number): void {
    const input = this.input;
    const output = this.output;
    for (let i = 0; i < count; i++) {
      const ib = i * this.inputStride;
      const ob = i * this.outputStride;
      const hostRotation = input[ib];
      const aimRotation = input[ib + 1];
      const aimPitch = input[ib + 2];

      const cosRot = Math.cos(aimRotation);
      const sinRot = Math.sin(aimRotation);
      const cosPitch = Math.cos(aimPitch);
      const sinPitch = Math.sin(aimPitch);
      let x = cosRot * cosPitch;
      let y = sinPitch;
      let z = sinRot * cosPitch;
      if (input[ib + 7] !== 0) {
        const rotated = rotateVectorByQuaternionInto(
          this.fallbackRotated,
          input[ib + 3],
          input[ib + 4],
          input[ib + 5],
          input[ib + 6],
          x,
          y,
          z,
        );
        x = rotated[0];
        y = rotated[1];
        z = rotated[2];
      }

      output[ob] = Math.atan2(-z, x) + hostRotation;
      output[ob + 1] = Math.asin(clampUnit(y));
    }
  }

}
