import type * as THREE from 'three';

export function setVector3IfChanged(
  vector: THREE.Vector3,
  x: number,
  y: number,
  z: number,
): void {
  if (vector.x === x && vector.y === y && vector.z === z) return;
  vector.set(x, y, z);
}

export function setQuaternionIfChanged(
  quaternion: THREE.Quaternion,
  x: number,
  y: number,
  z: number,
  w: number,
): void {
  if (
    quaternion.x === x &&
    quaternion.y === y &&
    quaternion.z === z &&
    quaternion.w === w
  ) {
    return;
  }
  quaternion.set(x, y, z, w);
}

export function setEulerIfChanged(
  euler: THREE.Euler,
  x: number,
  y: number,
  z: number,
  order?: THREE.Euler['order'],
): void {
  if (
    euler.x === x &&
    euler.y === y &&
    euler.z === z &&
    (order === undefined || euler.order === order)
  ) {
    return;
  }
  euler.set(x, y, z, order);
}

export function setEulerXIfChanged(euler: THREE.Euler, x: number): void {
  if (euler.x === x) return;
  euler.x = x;
}

export function setEulerYIfChanged(euler: THREE.Euler, y: number): void {
  if (euler.y === y) return;
  euler.y = y;
}

export function setEulerZIfChanged(euler: THREE.Euler, z: number): void {
  if (euler.z === z) return;
  euler.z = z;
}

export function setScaleScalarIfChanged(scale: THREE.Vector3, scalar: number): void {
  if (scale.x === scalar && scale.y === scalar && scale.z === scalar) return;
  scale.setScalar(scalar);
}

export function setVector3YIfChanged(vector: THREE.Vector3, y: number): void {
  if (vector.y === y) return;
  vector.y = y;
}

export function setObjectVisibleIfChanged(object: THREE.Object3D, visible: boolean): void {
  if (object.visible === visible) return;
  object.visible = visible;
}
