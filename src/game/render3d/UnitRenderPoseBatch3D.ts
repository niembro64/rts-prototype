import { getSimWasm, type SimWasm } from '../sim-wasm/init';

const UNIT_POSE_INPUT_STRIDE = 11;
const UNIT_POSE_OUTPUT_STRIDE = 32;

export class UnitRenderPoseBatch3D {
  inputStride = UNIT_POSE_INPUT_STRIDE;
  outputStride = UNIT_POSE_OUTPUT_STRIDE;

  private input = new Float32Array(0);
  private output = new Float32Array(0);
  private wasm: SimWasm | null = null;

  begin(count: number): void {
    const wasm = getSimWasm() ?? null;
    this.wasm = wasm;
    if (wasm !== null) {
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
      return;
    }

    this.inputStride = UNIT_POSE_INPUT_STRIDE;
    this.outputStride = UNIT_POSE_OUTPUT_STRIDE;
    const inputLength = count * this.inputStride;
    if (this.input.length < inputLength) this.input = new Float32Array(inputLength);
    const outputLength = count * this.outputStride;
    if (this.output.length < outputLength) this.output = new Float32Array(outputLength);
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
  }

  compute(count: number): Float32Array {
    if (this.wasm !== null) {
      this.wasm.renderPose.unitCompute(count);
      return this.output;
    }
    this.computeFallback(count);
    return this.output;
  }

  private computeFallback(count: number): void {
    for (let i = 0; i < count; i++) {
      const ib = i * this.inputStride;
      const ob = i * this.outputStride;
      const baseX = this.input[ib];
      const baseY = this.input[ib + 1];
      const baseZ = this.input[ib + 2];
      const simRotation = this.input[ib + 3];
      const normalX = this.input[ib + 4];
      const normalY = this.input[ib + 5];
      const normalZ = this.input[ib + 6];
      const liftX = this.input[ib + 7];
      const liftY = this.input[ib + 8];
      const liftZ = this.input[ib + 9];
      const airborne = this.input[ib + 10] !== 0;

      const tilt = this.tiltQuatFromSurfaceNormal(normalX, normalY, normalZ, airborne);
      const tiltX = tilt[0];
      const tiltY = tilt[1];
      const tiltZ = tilt[2];
      const tiltW = tilt[3];
      const chassisTilted = tilt[4] !== 0;
      const invTiltX = chassisTilted ? -tiltX : 0;
      const invTiltY = chassisTilted ? -tiltY : 0;
      const invTiltZ = chassisTilted ? -tiltZ : 0;
      const invTiltW = chassisTilted ? tiltW : 1;
      const yaw = -simRotation;
      const yawY = Math.sin(yaw * 0.5);
      const yawW = Math.cos(yaw * 0.5);
      const parentX = tiltX * yawW - tiltZ * yawY;
      const parentY = tiltW * yawY + tiltY * yawW;
      const parentZ = tiltZ * yawW + tiltX * yawY;
      const parentW = tiltW * yawW - tiltY * yawY;
      const lifted = this.rotateVec(parentX, parentY, parentZ, parentW, liftX, liftY, liftZ);
      const liftedX = baseX + lifted[0];
      const liftedY = baseY + lifted[1];
      const liftedZ = baseZ + lifted[2];

      const output = this.output;
      output[ob] = tiltX;
      output[ob + 1] = tiltY;
      output[ob + 2] = tiltZ;
      output[ob + 3] = tiltW;
      output[ob + 4] = invTiltX;
      output[ob + 5] = invTiltY;
      output[ob + 6] = invTiltZ;
      output[ob + 7] = invTiltW;
      output[ob + 8] = parentX;
      output[ob + 9] = parentY;
      output[ob + 10] = parentZ;
      output[ob + 11] = parentW;
      output[ob + 12] = liftedX;
      output[ob + 13] = liftedY;
      output[ob + 14] = liftedZ;
      output[ob + 15] = chassisTilted ? 1 : 0;
      this.writeComposeMatrix(ob + 16, liftedX, liftedY, liftedZ, parentX, parentY, parentZ, parentW);
    }
  }

  private tiltQuatFromSurfaceNormal(
    simNx: number,
    simNy: number,
    simNz: number,
    airborne: boolean,
  ): [number, number, number, number, number] {
    if (airborne || (simNx === 0 && simNy === 0)) return [0, 0, 0, 1, 0];
    let x = simNy;
    let y = 0;
    let z = -simNx;
    let w = simNz + 1;
    if (w < 1e-6) {
      x = 0;
      y = 0;
      z = 1;
      w = 0;
    }
    const inv = 1 / Math.hypot(x, y, z, w);
    return [x * inv, y * inv, z * inv, w * inv, 1];
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

  private writeComposeMatrix(
    offset: number,
    px: number,
    py: number,
    pz: number,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void {
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const output = this.output;
    output[offset] = 1 - (yy + zz);
    output[offset + 1] = xy + wz;
    output[offset + 2] = xz - wy;
    output[offset + 3] = 0;
    output[offset + 4] = xy - wz;
    output[offset + 5] = 1 - (xx + zz);
    output[offset + 6] = yz + wx;
    output[offset + 7] = 0;
    output[offset + 8] = xz + wy;
    output[offset + 9] = yz - wx;
    output[offset + 10] = 1 - (xx + yy);
    output[offset + 11] = 0;
    output[offset + 12] = px;
    output[offset + 13] = py;
    output[offset + 14] = pz;
    output[offset + 15] = 1;
  }
}
