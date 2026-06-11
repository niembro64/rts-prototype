import * as THREE from 'three';

const PHI = (1 + Math.sqrt(5)) / 2;

const rawIcosahedronVertices = [
  new THREE.Vector3(0, 1, PHI),
  new THREE.Vector3(0, 1, -PHI),
  new THREE.Vector3(0, -1, PHI),
  new THREE.Vector3(0, -1, -PHI),
  new THREE.Vector3(1, PHI, 0),
  new THREE.Vector3(1, -PHI, 0),
  new THREE.Vector3(-1, PHI, 0),
  new THREE.Vector3(-1, -PHI, 0),
  new THREE.Vector3(PHI, 0, 1),
  new THREE.Vector3(PHI, 0, -1),
  new THREE.Vector3(-PHI, 0, 1),
  new THREE.Vector3(-PHI, 0, -1),
].map((v) => v.normalize());

// Kept for the old hover-fan builder, even though the albatros unit now uses
// flying locomotion.
export const ALBATROS_ICOSAHEDRON_VERTEX_DIRECTIONS: readonly THREE.Vector3[] =
  rawIcosahedronVertices;

const bodyGeom = new THREE.SphereGeometry(1, 24, 14);
const smallSphereGeom = new THREE.SphereGeometry(1, 12, 8);
const neckGeom = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
const beakGeom = new THREE.ConeGeometry(1, 1, 12, 1);
const featherGeom = new THREE.BoxGeometry(1, 1, 1);
const talonGeom = new THREE.ConeGeometry(1, 1, 8, 1);

const featherMat = new THREE.MeshBasicMaterial({ color: 0x1c2428 });
const undersideMat = new THREE.MeshBasicMaterial({ color: 0xe8ece2 });
const beakMat = new THREE.MeshBasicMaterial({ color: 0xd4a944 });
const eyeMat = new THREE.MeshBasicMaterial({ color: 0x050607 });
const talonMat = new THREE.MeshBasicMaterial({ color: 0xb98b30 });

const scratchUp = new THREE.Vector3(0, 1, 0);
const scratchDir = new THREE.Vector3();

function addMesh(
  parent: THREE.Group,
  meshes: THREE.Mesh[],
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  entityId: number,
  position: [number, number, number],
  scale: [number, number, number],
  rotation?: [number, number, number],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.scale.set(scale[0], scale[1], scale[2]);
  if (rotation !== undefined) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.userData.entityId = entityId;
  parent.add(mesh);
  meshes.push(mesh);
  return mesh;
}

function addCylinderBetween(
  parent: THREE.Group,
  meshes: THREE.Mesh[],
  material: THREE.Material,
  entityId: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const length = Math.hypot(dx, dy, dz);
  if (length <= 0) return;
  const mesh = new THREE.Mesh(neckGeom, material);
  mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
  mesh.scale.set(radius, length, radius);
  scratchDir.set(dx / length, dy / length, dz / length);
  mesh.quaternion.setFromUnitVectors(scratchUp, scratchDir);
  mesh.userData.entityId = entityId;
  parent.add(mesh);
  meshes.push(mesh);
}

export function buildAlbatrosChassis(
  parent: THREE.Group,
  primaryMat: THREE.Material,
  entityId: number,
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];

  addMesh(parent, meshes, bodyGeom, primaryMat, entityId, [-0.12, 0.31, 0], [0.72, 0.23, 0.25]);
  addMesh(parent, meshes, bodyGeom, primaryMat, entityId, [0.36, 0.32, 0], [0.36, 0.19, 0.20]);
  addMesh(parent, meshes, bodyGeom, undersideMat, entityId, [-0.08, 0.16, 0], [0.55, 0.07, 0.13]);
  addCylinderBetween(parent, meshes, primaryMat, entityId, 0.43, 0.36, 0, 0.68, 0.43, 0, 0.075);
  addMesh(parent, meshes, smallSphereGeom, primaryMat, entityId, [0.78, 0.45, 0], [0.16, 0.12, 0.12]);
  addMesh(parent, meshes, beakGeom, beakMat, entityId, [0.94, 0.45, 0], [0.055, 0.20, 0.055], [0, 0, -Math.PI / 2]);
  addMesh(parent, meshes, smallSphereGeom, eyeMat, entityId, [0.85, 0.49, -0.08], [0.018, 0.018, 0.018]);
  addMesh(parent, meshes, smallSphereGeom, eyeMat, entityId, [0.85, 0.49, 0.08], [0.018, 0.018, 0.018]);

  addMesh(parent, meshes, bodyGeom, featherMat, entityId, [-0.04, 0.33, -0.25], [0.42, 0.055, 0.065]);
  addMesh(parent, meshes, bodyGeom, featherMat, entityId, [-0.04, 0.33, 0.25], [0.42, 0.055, 0.065]);
  for (let i = 0; i < 5; i++) {
    addMesh(
      parent,
      meshes,
      featherGeom,
      featherMat,
      entityId,
      [-0.42 + i * 0.16, 0.50, 0],
      [0.11, 0.018, 0.05],
      [0, 0, 0.08],
    );
  }

  for (const [side, spread] of [[-1, -0.36], [0, 0], [1, 0.36]] as const) {
    addMesh(
      parent,
      meshes,
      featherGeom,
      featherMat,
      entityId,
      [-0.83, 0.34, side * 0.12],
      [0.42, 0.026, 0.09],
      [0, spread, side * -0.08],
    );
  }

  for (const side of [-1, 1] as const) {
    addMesh(
      parent,
      meshes,
      talonGeom,
      talonMat,
      entityId,
      [0.18, 0.06, side * 0.10],
      [0.028, 0.13, 0.028],
      [0, 0, Math.PI],
    );
    addMesh(
      parent,
      meshes,
      talonGeom,
      talonMat,
      entityId,
      [0.26, 0.065, side * 0.12],
      [0.020, 0.10, 0.020],
      [0.25 * side, 0, Math.PI * 0.88],
    );
  }

  return meshes;
}
