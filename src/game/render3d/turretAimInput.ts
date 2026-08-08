type QuaternionLike = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export function writeTurretAimInput(
  input: Float32Array,
  base: number,
  hostRotation: number,
  aimRotation: number,
  aimPitch: number,
  parentWorldQuaternion: QuaternionLike | undefined,
): void {
  input[base] = hostRotation;
  input[base + 1] = aimRotation;
  input[base + 2] = aimPitch;
  input[base + 3] = parentWorldQuaternion?.x ?? 0;
  input[base + 4] = parentWorldQuaternion?.y ?? 0;
  input[base + 5] = parentWorldQuaternion?.z ?? 0;
  input[base + 6] = parentWorldQuaternion?.w ?? 1;
  input[base + 7] = parentWorldQuaternion ? 1 : 0;
}
