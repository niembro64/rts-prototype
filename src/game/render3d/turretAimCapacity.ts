import { TURRET_AIM_INPUT_STRIDE } from './UnitTurretAimBatch3D';
import { growFloat32Array } from './typedArrayRenderUtils';

type TurretAimBuffers = {
  aimInput: Float32Array;
  parentPose: Float32Array;
};

export function createTurretAimBuffers(initialCapacity: number): TurretAimBuffers {
  return {
    aimInput: new Float32Array(TURRET_AIM_INPUT_STRIDE * initialCapacity),
    parentPose: new Float32Array(7 * initialCapacity),
  };
}

/** Mutates the shared buffer owner only on the cold capacity-growth path. */
export function ensureTurretAimBufferCapacity(
  buffers: TurretAimBuffers,
  count: number,
): void {
  const inputLength = count * TURRET_AIM_INPUT_STRIDE;
  const poseLength = count * 7;
  if (buffers.aimInput.length < inputLength) {
    buffers.aimInput = growFloat32Array(buffers.aimInput, inputLength);
  }
  if (buffers.parentPose.length < poseLength) {
    buffers.parentPose = growFloat32Array(buffers.parentPose, poseLength);
  }
}
