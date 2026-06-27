import { getSimWasm, type SimWasm } from '../sim-wasm/init';
import { measureWasmBoundary } from '../perf/WasmBoundaryInstrumentation';
import type { SmokePuffEmitter } from './SmokeTrail3D';

const AIRBORNE_EMITTER_INPUT_STRIDE = 24;
const AIRBORNE_EMITTER_OUTPUT_STRIDE = 6;

export type AirborneEmitterParentPose3D = {
  parentX: number;
  parentY: number;
  parentZ: number;
  parentQX: number;
  parentQY: number;
  parentQZ: number;
  parentQW: number;
};

export class AirborneEmitterBatch3D {
  inputStride = AIRBORNE_EMITTER_INPUT_STRIDE;
  outputStride = AIRBORNE_EMITTER_OUTPUT_STRIDE;

  private input = new Float32Array(AIRBORNE_EMITTER_INPUT_STRIDE * 256);
  private output = new Float32Array(AIRBORNE_EMITTER_OUTPUT_STRIDE * 256);
  private readonly emitters: SmokePuffEmitter[] = [];
  private wasm: SimWasm | null = null;
  private count = 0;

  begin(): void {
    this.inputStride = AIRBORNE_EMITTER_INPUT_STRIDE;
    this.outputStride = AIRBORNE_EMITTER_OUTPUT_STRIDE;
    this.count = 0;
    this.emitters.length = 0;
    this.wasm = getSimWasm() ?? null;
  }

  enqueue(
    pose: AirborneEmitterParentPose3D,
    groupX: number,
    groupY: number,
    groupZ: number,
    childX: number,
    childY: number,
    childZ: number,
    childQX: number,
    childQY: number,
    childQZ: number,
    childQW: number,
    emitterX: number,
    emitterY: number,
    emitterZ: number,
    exhaustDirX: number,
    exhaustDirY: number,
    exhaustDirZ: number,
    exhaustSpeed: number,
    emitter: SmokePuffEmitter,
  ): void {
    const index = this.count;
    this.count++;
    this.ensureInputCapacity(this.count);
    const base = index * this.inputStride;
    const input = this.input;
    input[base] = pose.parentX;
    input[base + 1] = pose.parentY;
    input[base + 2] = pose.parentZ;
    input[base + 3] = pose.parentQX;
    input[base + 4] = pose.parentQY;
    input[base + 5] = pose.parentQZ;
    input[base + 6] = pose.parentQW;
    input[base + 7] = groupX;
    input[base + 8] = groupY;
    input[base + 9] = groupZ;
    input[base + 10] = childX;
    input[base + 11] = childY;
    input[base + 12] = childZ;
    input[base + 13] = childQX;
    input[base + 14] = childQY;
    input[base + 15] = childQZ;
    input[base + 16] = childQW;
    input[base + 17] = emitterX;
    input[base + 18] = emitterY;
    input[base + 19] = emitterZ;
    input[base + 20] = exhaustDirX;
    input[base + 21] = exhaustDirY;
    input[base + 22] = exhaustDirZ;
    input[base + 23] = exhaustSpeed;
    this.emitters[index] = emitter;
  }

  flush(out: SmokePuffEmitter[]): void {
    const count = this.count;
    if (count <= 0) return;
    const output = this.compute(count);
    const stride = this.outputStride;
    for (let i = 0; i < count; i++) {
      const base = i * stride;
      const emitter = this.emitters[i];
      emitter.x = output[base];
      emitter.y = output[base + 1];
      emitter.z = output[base + 2];
      emitter.vx = output[base + 3];
      emitter.vy = output[base + 4];
      emitter.vz = output[base + 5];
      out.push(emitter);
    }
  }

  private compute(count: number): Float32Array {
    if (this.wasm !== null) {
      const renderPose = this.wasm.renderPose;
      renderPose.airborneEmitterScratchEnsure(count);
      this.inputStride = renderPose.airborneEmitterInputStride;
      this.outputStride = renderPose.airborneEmitterOutputStride;
      const wasmInput = new Float32Array(
        this.wasm.memory.buffer,
        renderPose.airborneEmitterInputScratchPtr(),
        count * this.inputStride,
      );
      wasmInput.set(this.input.subarray(0, count * this.inputStride));
      measureWasmBoundary('renderPose.airborneEmitterCompute', () => {
        renderPose.airborneEmitterCompute(count);
      });
      return new Float32Array(
        this.wasm.memory.buffer,
        renderPose.airborneEmitterOutputScratchPtr(),
        count * this.outputStride,
      );
    }

    this.inputStride = AIRBORNE_EMITTER_INPUT_STRIDE;
    this.outputStride = AIRBORNE_EMITTER_OUTPUT_STRIDE;
    this.ensureOutputCapacity(count);
    this.computeFallback(count);
    return this.output;
  }

  private computeFallback(count: number): void {
    const input = this.input;
    const output = this.output;
    for (let i = 0; i < count; i++) {
      const ib = i * this.inputStride;
      const ob = i * this.outputStride;
      const parentX = input[ib];
      const parentY = input[ib + 1];
      const parentZ = input[ib + 2];
      const parentQX = input[ib + 3];
      const parentQY = input[ib + 4];
      const parentQZ = input[ib + 5];
      const parentQW = input[ib + 6];
      const groupX = input[ib + 7];
      const groupY = input[ib + 8];
      const groupZ = input[ib + 9];
      const childX = input[ib + 10];
      const childY = input[ib + 11];
      const childZ = input[ib + 12];
      const childQX = input[ib + 13];
      const childQY = input[ib + 14];
      const childQZ = input[ib + 15];
      const childQW = input[ib + 16];
      const emitterX = input[ib + 17];
      const emitterY = input[ib + 18];
      const emitterZ = input[ib + 19];
      const dirX = input[ib + 20];
      const dirY = input[ib + 21];
      const dirZ = input[ib + 22];
      const speed = input[ib + 23];

      const groupWorld = this.rotateVec(parentQX, parentQY, parentQZ, parentQW, groupX, groupY, groupZ);
      const childWorld = this.rotateVec(parentQX, parentQY, parentQZ, parentQW, childX, childY, childZ);
      const childWorldQ = this.quatMul(
        parentQX, parentQY, parentQZ, parentQW,
        childQX, childQY, childQZ, childQW,
      );
      const emitterWorld = this.rotateVec(
        childWorldQ[0],
        childWorldQ[1],
        childWorldQ[2],
        childWorldQ[3],
        emitterX,
        emitterY,
        emitterZ,
      );
      const exhaustWorld = this.rotateVec(
        childWorldQ[0],
        childWorldQ[1],
        childWorldQ[2],
        childWorldQ[3],
        dirX,
        dirY,
        dirZ,
      );

      output[ob] = parentX + groupWorld[0] + childWorld[0] + emitterWorld[0];
      output[ob + 1] = parentZ + groupWorld[2] + childWorld[2] + emitterWorld[2];
      output[ob + 2] = parentY + groupWorld[1] + childWorld[1] + emitterWorld[1];
      output[ob + 3] = exhaustWorld[0] * speed;
      output[ob + 4] = exhaustWorld[2] * speed;
      output[ob + 5] = exhaustWorld[1] * speed;
    }
  }

  private quatMul(
    ax: number,
    ay: number,
    az: number,
    aw: number,
    bx: number,
    by: number,
    bz: number,
    bw: number,
  ): [number, number, number, number] {
    return [
      ax * bw + aw * bx + ay * bz - az * by,
      ay * bw + aw * by + az * bx - ax * bz,
      az * bw + aw * bz + ax * by - ay * bx,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
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

  private ensureInputCapacity(count: number): void {
    const needed = count * this.inputStride;
    if (this.input.length >= needed) return;
    let next = this.input.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.input);
    this.input = expanded;
  }

  private ensureOutputCapacity(count: number): void {
    const needed = count * this.outputStride;
    if (this.output.length >= needed) return;
    let next = this.output.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.output);
    this.output = expanded;
  }
}
