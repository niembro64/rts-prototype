import * as THREE from 'three';

const PHI = (1 + Math.sqrt(5)) / 2;
const VERTEX_RADIUS_FRAC = 0.72;
const EDGE_RADIUS_FRAC = 0.028;
const EDGE_SEGMENTS = 12;
const EDGE_EPS = 1e-4;

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

const edgeGeom = new THREE.CylinderGeometry(1, 1, 1, EDGE_SEGMENTS, 1);
const scratchUp = new THREE.Vector3(0, 1, 0);

function buildIcosahedronEdges(): readonly [number, number][] {
  let minDist = Infinity;
  for (let i = 0; i < rawIcosahedronVertices.length; i++) {
    for (let j = i + 1; j < rawIcosahedronVertices.length; j++) {
      minDist = Math.min(minDist, rawIcosahedronVertices[i].distanceTo(rawIcosahedronVertices[j]));
    }
  }

  const edges: [number, number][] = [];
  for (let i = 0; i < rawIcosahedronVertices.length; i++) {
    for (let j = i + 1; j < rawIcosahedronVertices.length; j++) {
      const dist = rawIcosahedronVertices[i].distanceTo(rawIcosahedronVertices[j]);
      if (Math.abs(dist - minDist) <= EDGE_EPS) edges.push([i, j]);
    }
  }
  return edges;
}

export const ALBATROS_ICOSAHEDRON_VERTEX_DIRECTIONS: readonly THREE.Vector3[] =
  rawIcosahedronVertices;

const ICOSAHEDRON_EDGES = buildIcosahedronEdges();

export function buildAlbatrosChassis(
  parent: THREE.Group,
  primaryMat: THREE.Material,
  entityId: number,
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  const radius = VERTEX_RADIUS_FRAC;
  const edgeRadius = EDGE_RADIUS_FRAC;

  for (const [aIndex, bIndex] of ICOSAHEDRON_EDGES) {
    const a = rawIcosahedronVertices[aIndex];
    const b = rawIcosahedronVertices[bIndex];
    const ax = a.x * radius;
    const ay = a.y * radius;
    const az = a.z * radius;
    const bx = b.x * radius;
    const by = b.y * radius;
    const bz = b.z * radius;
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const length = Math.hypot(dx, dy, dz);
    if (length <= 0) continue;

    const mesh = new THREE.Mesh(edgeGeom, primaryMat);
    mesh.position.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    mesh.scale.set(edgeRadius, length, edgeRadius);
    mesh.quaternion.setFromUnitVectors(
      scratchUp,
      new THREE.Vector3(dx / length, dy / length, dz / length),
    );
    mesh.userData.entityId = entityId;
    parent.add(mesh);
    meshes.push(mesh);
  }

  return meshes;
}
