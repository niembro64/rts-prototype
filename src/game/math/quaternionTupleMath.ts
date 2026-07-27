export type MutableVector3Tuple = [number, number, number];
export type MutableQuaternionTuple = [number, number, number, number];

export function rotateVectorByQuaternionInto(
  output: MutableVector3Tuple,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  vx: number,
  vy: number,
  vz: number,
): MutableVector3Tuple {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  output[0] = vx + qw * tx + (qy * tz - qz * ty);
  output[1] = vy + qw * ty + (qz * tx - qx * tz);
  output[2] = vz + qw * tz + (qx * ty - qy * tx);
  return output;
}

export function multiplyQuaternionsInto(
  output: MutableQuaternionTuple,
  ax: number,
  ay: number,
  az: number,
  aw: number,
  bx: number,
  by: number,
  bz: number,
  bw: number,
): MutableQuaternionTuple {
  output[0] = aw * bx + ax * bw + ay * bz - az * by;
  output[1] = aw * by - ax * bz + ay * bw + az * bx;
  output[2] = aw * bz + ax * by - ay * bx + az * bw;
  output[3] = aw * bw - ax * bx - ay * by - az * bz;
  return output;
}

export function composeChildOffsetInto(
  output: MutableVector3Tuple,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  parentX: number,
  parentY: number,
  parentZ: number,
  childX: number,
  childY: number,
  childZ: number,
): MutableVector3Tuple {
  rotateVectorByQuaternionInto(
    output,
    qx,
    qy,
    qz,
    qw,
    childX,
    childY,
    childZ,
  );
  output[0] += parentX;
  output[1] += parentY;
  output[2] += parentZ;
  return output;
}
