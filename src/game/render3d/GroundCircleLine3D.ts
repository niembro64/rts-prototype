import * as THREE from 'three';

export const GROUND_CIRCLE_LINE_THICKNESS = 5;

export type ClosedRibbonGeometry = {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  centers: Float32Array;
  attr: THREE.BufferAttribute;
  pointCount: number;
};

export function createClosedRibbonGeometry(pointCount: number): ClosedRibbonGeometry {
  const safePointCount = Math.max(3, Math.floor(pointCount));
  const positions = new Float32Array(safePointCount * 2 * 3);
  const centers = new Float32Array(safePointCount * 3);
  const indices = new Uint32Array(safePointCount * 6);
  for (let i = 0; i < safePointCount; i++) {
    const next = (i + 1) % safePointCount;
    const vi = i * 2;
    const vn = next * 2;
    const ii = i * 6;
    indices[ii] = vi;
    indices[ii + 1] = vi + 1;
    indices[ii + 2] = vn + 1;
    indices[ii + 3] = vi;
    indices[ii + 4] = vn + 1;
    indices[ii + 5] = vn;
  }

  const geometry = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return {
    geometry,
    positions,
    centers,
    attr,
    pointCount: safePointCount,
  };
}

export function writeClosedRibbonGeometry(
  ribbon: ClosedRibbonGeometry,
  thickness = GROUND_CIRCLE_LINE_THICKNESS,
): void {
  const halfWidth = Math.max(0.1, thickness * 0.5);
  const { centers, positions, pointCount } = ribbon;
  for (let i = 0; i < pointCount; i++) {
    const prev = ((i - 1 + pointCount) % pointCount) * 3;
    const curr = i * 3;
    const next = ((i + 1) % pointCount) * 3;
    let tangentX = centers[next] - centers[prev];
    let tangentZ = centers[next + 2] - centers[prev + 2];
    const tangentLen = Math.hypot(tangentX, tangentZ);
    if (tangentLen > 1e-6) {
      tangentX /= tangentLen;
      tangentZ /= tangentLen;
    } else {
      tangentX = 1;
      tangentZ = 0;
    }
    const offsetX = -tangentZ * halfWidth;
    const offsetZ = tangentX * halfWidth;
    const out = i * 6;
    positions[out] = centers[curr] + offsetX;
    positions[out + 1] = centers[curr + 1];
    positions[out + 2] = centers[curr + 2] + offsetZ;
    positions[out + 3] = centers[curr] - offsetX;
    positions[out + 4] = centers[curr + 1];
    positions[out + 5] = centers[curr + 2] - offsetZ;
  }
  ribbon.attr.needsUpdate = true;
}

export function writeCircleRibbonGeometry(
  ribbon: ClosedRibbonGeometry,
  radius: number,
  thickness = GROUND_CIRCLE_LINE_THICKNESS,
): void {
  const r = Math.max(0, radius);
  for (let i = 0; i < ribbon.pointCount; i++) {
    const a = (i / ribbon.pointCount) * Math.PI * 2;
    const o = i * 3;
    ribbon.centers[o] = Math.cos(a) * r;
    ribbon.centers[o + 1] = 0;
    ribbon.centers[o + 2] = Math.sin(a) * r;
  }
  writeClosedRibbonGeometry(ribbon, thickness);
}
