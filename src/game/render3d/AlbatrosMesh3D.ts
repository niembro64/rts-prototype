import * as THREE from 'three';
import {
  createPrimitiveConeGeometry,
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';

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
];
for (let i = 0; i < rawIcosahedronVertices.length; i++) rawIcosahedronVertices[i].normalize();

// Kept for the old hover-fan builder, even though the albatros unit now uses
// flying locomotion.
export const ALBATROS_ICOSAHEDRON_VERTEX_DIRECTIONS: readonly THREE.Vector3[] =
  rawIcosahedronVertices;

const bodyGeom = createPrimitiveSphereGeometry('unitBody', 'close');
const smallSphereGeom = createPrimitiveSphereGeometry('unitDetail', 'mid');
const neckGeom = createPrimitiveCylinderGeometry('unitDetail', 'close');
const noseConeGeom = createPrimitiveConeGeometry('unitDetail', 'close');
const finGeom = new THREE.BoxGeometry(1, 1, 1);

const undersideMat = new THREE.MeshBasicMaterial({ color: 0xe8ece2 });
const canopyMat = new THREE.MeshBasicMaterial({ color: 0x050607 });

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

// Simple bomber body: a cylindrical fuselage with a rounded nose, tail
// cone, dark canopy, light belly panel, and a swept vertical fin. The
// wings, tail wings, and jets stay on the FlyingRig (built from the
// blueprint locomotion config) and are untouched here. Same span as the
// old bird torso so the blueprint bodyShape oval (turret roots, hitbox)
// still matches the visual.
export function buildAlbatrosChassis(
  parent: THREE.Group,
  primaryMat: THREE.Material,
  entityId: number,
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];

  // Fuselage tube, tail cone seat to nose seat.
  addCylinderBetween(parent, meshes, primaryMat, entityId, -0.80, 0.31, 0, 0.60, 0.31, 0, 0.17);
  // Rounded nose cap; tip reaches past the forward turret mount (x=0.8).
  addMesh(parent, meshes, smallSphereGeom, primaryMat, entityId, [0.60, 0.31, 0], [0.22, 0.17, 0.17]);
  // Tapered tail cone, pointing rearward.
  addMesh(parent, meshes, noseConeGeom, primaryMat, entityId, [-0.87, 0.31, 0], [0.15, 0.16, 0.15], [0, 0, Math.PI / 2]);
  // Dark glass cockpit canopy ahead of the mid turret.
  addMesh(parent, meshes, smallSphereGeom, canopyMat, entityId, [0.34, 0.46, 0], [0.14, 0.07, 0.11]);
  // Light belly panel.
  addMesh(parent, meshes, bodyGeom, undersideMat, entityId, [-0.08, 0.18, 0], [0.52, 0.07, 0.13]);
  // Swept vertical stabilizer over the tail cone.
  addMesh(parent, meshes, finGeom, primaryMat, entityId, [-0.76, 0.50, 0], [0.22, 0.26, 0.03], [0, 0, 0.45]);

  return meshes;
}
