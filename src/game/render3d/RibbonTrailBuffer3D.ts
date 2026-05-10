export type RibbonQuadCorners = {
  sLx: number;
  sLz: number;
  sRx: number;
  sRz: number;
  eRx: number;
  eRz: number;
  eLx: number;
  eLz: number;
};

export function createQuadIndexBuffer(capacity: number): Uint32Array {
  const indices = new Uint32Array(capacity * 6);
  for (let i = 0; i < capacity; i++) {
    const vBase = i * 4;
    const iBase = i * 6;
    indices[iBase] = vBase;
    indices[iBase + 1] = vBase + 1;
    indices[iBase + 2] = vBase + 2;
    indices[iBase + 3] = vBase;
    indices[iBase + 4] = vBase + 2;
    indices[iBase + 5] = vBase + 3;
  }
  return indices;
}

export function computeMiteredQuad(
  startX: number,
  startZ: number,
  endX: number,
  endZ: number,
  dirX: number,
  dirZ: number,
  prevDirX: number,
  prevDirZ: number,
  halfWidth: number,
  miterLimit: number,
  haveLivePrev: boolean,
): RibbonQuadCorners {
  const perpRX = -dirZ;
  const perpRZ = dirX;
  let sLx: number;
  let sLz: number;
  let sRx: number;
  let sRz: number;

  if (haveLivePrev) {
    const sumX = prevDirX + dirX;
    const sumZ = prevDirZ + dirZ;
    const sumLen = Math.sqrt(sumX * sumX + sumZ * sumZ);
    if (sumLen > 1e-4) {
      let miter = (halfWidth * 2) / sumLen;
      const maxMiter = halfWidth * miterLimit;
      if (miter > maxMiter) miter = maxMiter;
      const bX = sumX / sumLen;
      const bZ = sumZ / sumLen;
      const perpBX = -bZ;
      const perpBZ = bX;
      sLx = startX - perpBX * miter;
      sLz = startZ - perpBZ * miter;
      sRx = startX + perpBX * miter;
      sRz = startZ + perpBZ * miter;
    } else {
      sLx = startX - perpRX * halfWidth;
      sLz = startZ - perpRZ * halfWidth;
      sRx = startX + perpRX * halfWidth;
      sRz = startZ + perpRZ * halfWidth;
    }
  } else {
    sLx = startX - perpRX * halfWidth;
    sLz = startZ - perpRZ * halfWidth;
    sRx = startX + perpRX * halfWidth;
    sRz = startZ + perpRZ * halfWidth;
  }

  return {
    sLx,
    sLz,
    sRx,
    sRz,
    eLx: endX - perpRX * halfWidth,
    eLz: endZ - perpRZ * halfWidth,
    eRx: endX + perpRX * halfWidth,
    eRz: endZ + perpRZ * halfWidth,
  };
}

export function writeFlatQuadXZ(
  positions: Float32Array,
  slot: number,
  y: number,
  corners: RibbonQuadCorners,
): void {
  const base = slot * 12;
  positions[base] = corners.sLx;
  positions[base + 1] = y;
  positions[base + 2] = corners.sLz;
  positions[base + 3] = corners.sRx;
  positions[base + 4] = y;
  positions[base + 5] = corners.sRz;
  positions[base + 6] = corners.eRx;
  positions[base + 7] = y;
  positions[base + 8] = corners.eRz;
  positions[base + 9] = corners.eLx;
  positions[base + 10] = y;
  positions[base + 11] = corners.eLz;
}

export function writeFlatQuadEndXZ(
  positions: Float32Array,
  slot: number,
  y: number,
  eRx: number,
  eRz: number,
  eLx: number,
  eLz: number,
): void {
  const base = slot * 12;
  positions[base + 6] = eRx;
  positions[base + 7] = y;
  positions[base + 8] = eRz;
  positions[base + 9] = eLx;
  positions[base + 10] = y;
  positions[base + 11] = eLz;
}

export function writeQuadRgba(
  colors: Float32Array,
  slot: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const base = slot * 16;
  for (let i = 0; i < 4; i++) {
    const o = base + i * 4;
    colors[o] = r;
    colors[o + 1] = g;
    colors[o + 2] = b;
    colors[o + 3] = a;
  }
}

export function copyQuadSlot(
  values: Float32Array,
  valuesPerQuad: number,
  srcSlot: number,
  dstSlot: number,
): void {
  const src = srcSlot * valuesPerQuad;
  const dst = dstSlot * valuesPerQuad;
  for (let i = 0; i < valuesPerQuad; i++) values[dst + i] = values[src + i];
}

