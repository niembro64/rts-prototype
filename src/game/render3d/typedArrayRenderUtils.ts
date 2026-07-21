type Vector3Like = {
  x: number;
  y: number;
  z: number;
};

type QuaternionLike = Vector3Like & {
  w: number;
};

export function growFloat32Array(
  values: Float32Array<ArrayBuffer>,
  requiredLength: number,
): Float32Array<ArrayBuffer> {
  if (values.length >= requiredLength) return values;
  let nextLength = Math.max(1, values.length);
  while (nextLength < requiredLength) nextLength *= 2;
  const expanded = new Float32Array(nextLength);
  expanded.set(values);
  return expanded;
}

export function writePositionQuaternion(
  output: Float32Array,
  offset: number,
  position: Vector3Like,
  quaternion: QuaternionLike,
): void {
  output[offset] = position.x;
  output[offset + 1] = position.y;
  output[offset + 2] = position.z;
  output[offset + 3] = quaternion.x;
  output[offset + 4] = quaternion.y;
  output[offset + 5] = quaternion.z;
  output[offset + 6] = quaternion.w;
}

export function writeScaledQuaternionMatrix(
  output: Float32Array,
  offset: number,
  px: number,
  py: number,
  pz: number,
  x: number,
  y: number,
  z: number,
  w: number,
  sx: number,
  sy: number,
  sz: number,
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

  output[offset] = (1 - (yy + zz)) * sx;
  output[offset + 1] = (xy + wz) * sx;
  output[offset + 2] = (xz - wy) * sx;
  output[offset + 3] = 0;
  output[offset + 4] = (xy - wz) * sy;
  output[offset + 5] = (1 - (xx + zz)) * sy;
  output[offset + 6] = (yz + wx) * sy;
  output[offset + 7] = 0;
  output[offset + 8] = (xz + wy) * sz;
  output[offset + 9] = (yz - wx) * sz;
  output[offset + 10] = (1 - (xx + yy)) * sz;
  output[offset + 11] = 0;
  output[offset + 12] = px;
  output[offset + 13] = py;
  output[offset + 14] = pz;
  output[offset + 15] = 1;
}
