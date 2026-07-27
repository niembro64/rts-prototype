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
  mode: number,
  aimRotation: number,
  aimPitch: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  chassisTiltInverse: QuaternionLike | undefined,
): void {
  input[base] = hostRotation;
  input[base + 1] = mode;
  input[base + 2] = aimRotation;
  input[base + 3] = aimPitch;
  input[base + 4] = dirX;
  input[base + 5] = dirY;
  input[base + 6] = dirZ;
  input[base + 7] = chassisTiltInverse?.x ?? 0;
  input[base + 8] = chassisTiltInverse?.y ?? 0;
  input[base + 9] = chassisTiltInverse?.z ?? 0;
  input[base + 10] = chassisTiltInverse?.w ?? 1;
  input[base + 11] = chassisTiltInverse ? 1 : 0;
}
