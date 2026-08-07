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
  chassisTiltInverse: QuaternionLike | undefined,
): void {
  input[base] = hostRotation;
  input[base + 1] = aimRotation;
  input[base + 2] = aimPitch;
  input[base + 3] = chassisTiltInverse?.x ?? 0;
  input[base + 4] = chassisTiltInverse?.y ?? 0;
  input[base + 5] = chassisTiltInverse?.z ?? 0;
  input[base + 6] = chassisTiltInverse?.w ?? 1;
  input[base + 7] = chassisTiltInverse ? 1 : 0;
}
