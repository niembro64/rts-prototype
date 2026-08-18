import { RequiredWasmPoseBatch3D } from './wasmPoseBatch3D';

const PROJECTILE_AXIS_INPUT_STRIDE = 4;
const PROJECTILE_AXIS_OUTPUT_STRIDE = 7;
const PLASMA_ARC_POSE_INPUT_STRIDE = 7;
const PLASMA_ARC_POSE_OUTPUT_STRIDE = 16;

/** Thin zero-copy bridge to the Rust projectile presentation-axis batch. */
export class ProjectileAxisPoseBatch3D extends RequiredWasmPoseBatch3D {
  constructor() {
    super('projectileAxis', PROJECTILE_AXIS_INPUT_STRIDE, PROJECTILE_AXIS_OUTPUT_STRIDE);
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
}

/** Thin zero-copy bridge to the Rust plasma LOW tail-pose batch.
 *
 *  The single-segment LOW tail is aimed down the shot's own recorded flight
 *  path instead of its instantaneous velocity, so each row is the head plus
 *  the trail point the tail should reach. Rust returns finished instance
 *  matrices, which the caller copies into the instanced mesh in one block.
 *  Positions are in Three coordinates, matching those matrices. */
export class PlasmaArcPoseBatch3D extends RequiredWasmPoseBatch3D {
  constructor() {
    super('plasmaArcPose', PLASMA_ARC_POSE_INPUT_STRIDE, PLASMA_ARC_POSE_OUTPUT_STRIDE);
  }

  write(
    index: number,
    headX: number,
    headY: number,
    headZ: number,
    tailX: number,
    tailY: number,
    tailZ: number,
    bodyRadius: number,
  ): void {
    const base = index * this.inputStride;
    this.input[base] = headX;
    this.input[base + 1] = headY;
    this.input[base + 2] = headZ;
    this.input[base + 3] = tailX;
    this.input[base + 4] = tailY;
    this.input[base + 5] = tailZ;
    this.input[base + 6] = bodyRadius;
  }
}
