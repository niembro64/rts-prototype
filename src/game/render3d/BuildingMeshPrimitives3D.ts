import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import { BUILDING_PALETTE, SHINY_GRAY_METAL_MATERIAL } from './BuildingVisualPalette';
import type { BuildingDetailMesh, BuildingDetailRole } from './BuildingShape3D';

export const boxGeom = new THREE.BoxGeometry(1, 1, 1);
export const cylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
export const hexCylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
export const factorySphereGeom = new THREE.SphereGeometry(1, 18, 12);
export const coneGeom = new THREE.ConeGeometry(0.5, 1, 18);
const windBladeGeom = createWindBladeGeometry();

export const windTowerMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
export const windTrimMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });
export const windNacelleMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.structureLight,
  metalness: 0.48,
  roughness: 0.16,
});
export const windBladeMat = new THREE.MeshStandardMaterial({
  color: 0xd5dfe7,
  metalness: 0.38,
  roughness: 0.14,
});
export const windGlassMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.photovoltaic,
  metalness: 1.0,
  roughness: 0.04,
});
export const extractorBladeMat = new THREE.MeshStandardMaterial(SHINY_GRAY_METAL_MATERIAL);
export const invisibleMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0,
  depthWrite: false,
});
export const factoryFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });

export function createWindBladeGeometry(): THREE.BufferGeometry {
  const stations = [
    { y: 0.06, halfW: 0.34, halfT: 0.46, sweep: -0.02 },
    { y: 0.48, halfW: 0.18, halfT: 0.28, sweep: -0.08 },
    { y: 1.0, halfW: 0.035, halfT: 0.09, sweep: 0.08 },
  ];
  const positions: number[] = [];
  for (const s of stations) {
    positions.push(
      s.sweep - s.halfW, s.y, -s.halfT,
      s.sweep + s.halfW, s.y, -s.halfT,
      s.sweep + s.halfW, s.y,  s.halfT,
      s.sweep - s.halfW, s.y,  s.halfT,
    );
  }

  const indices: number[] = [];
  const addFace = (a: number, b: number, c: number, d: number): void => {
    indices.push(a, b, c, a, c, d);
  };
  for (let i = 0; i < stations.length - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    addFace(a + 0, a + 1, b + 1, b + 0);
    addFace(a + 1, a + 2, b + 2, b + 1);
    addFace(a + 2, a + 3, b + 3, b + 2);
    addFace(a + 3, a + 0, b + 0, b + 3);
  }
  addFace(0, 3, 2, 1);
  const tip = (stations.length - 1) * 4;
  addFace(tip + 0, tip + 1, tip + 2, tip + 3);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

export function createHexFrustumGeometry(
  topRadius: number = 0.17,
  bottomRadius: number = 0.5,
): THREE.BufferGeometry {
  const positions: number[] = [];
  // Normalized footprint: when Render3DEntities scales the primary by
  // building width/depth, the widest base edge stays inside that exact
  // logical footprint instead of spilling past the building cells.
  const bottomY = -0.5;
  const topY = 0.5;
  const bottomCorners: THREE.Vector3[] = [];
  const topCorners: THREE.Vector3[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
    bottomCorners.push(new THREE.Vector3(Math.cos(angle) * bottomRadius, bottomY, Math.sin(angle) * bottomRadius));
    topCorners.push(new THREE.Vector3(Math.cos(angle) * topRadius, topY, Math.sin(angle) * topRadius));
  }

  for (let i = 0; i < 6; i++) {
    const b0 = bottomCorners[i];
    const b1 = bottomCorners[(i + 1) % 6];
    const t0 = topCorners[i];
    const t1 = topCorners[(i + 1) % 6];
    positions.push(
      b0.x, b0.y, b0.z, t1.x, t1.y, t1.z, b1.x, b1.y, b1.z,
      b0.x, b0.y, b0.z, t0.x, t0.y, t0.z, t1.x, t1.y, t1.z,
    );
  }

  const bottomCenter = new THREE.Vector3(0, bottomY, 0);
  const topCenter = new THREE.Vector3(0, topY, 0);
  for (let i = 0; i < 6; i++) {
    const b0 = bottomCorners[(i + 1) % 6];
    const b1 = bottomCorners[i];
    positions.push(bottomCenter.x, bottomCenter.y, bottomCenter.z, b1.x, b1.y, b1.z, b0.x, b0.y, b0.z);
    const t0 = topCorners[i];
    const t1 = topCorners[(i + 1) % 6];
    positions.push(topCenter.x, topCenter.y, topCenter.z, t1.x, t1.y, t1.z, t0.x, t0.y, t0.z);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

export function makeTurbineBlade(
  material: THREE.Material,
  length: number,
  rootWidth: number,
  thickness: number,
  angle: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(windBladeGeom, material);
  mesh.scale.set(rootWidth, length, thickness);
  mesh.rotation.z = angle;
  return mesh;
}

export function applyBasis(mesh: THREE.Mesh, xAxis: THREE.Vector3, yAxis: THREE.Vector3, zAxis: THREE.Vector3): void {
  const basis = new THREE.Matrix4();
  basis.makeBasis(xAxis, yAxis, zAxis);
  mesh.quaternion.setFromRotationMatrix(basis);
}

export function makeBox(
  material: THREE.Material,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(boxGeom, material);
  mesh.scale.set(width, height, depth);
  mesh.position.set(x, y, z);
  return mesh;
}

export function makeCylinder(
  material: THREE.Material,
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
  geom: THREE.BufferGeometry = cylinderGeom,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geom, material);
  mesh.scale.set(radius * 2, height, radius * 2);
  mesh.position.set(x, y, z);
  return mesh;
}

export function makeCone(
  material: THREE.Material,
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(coneGeom, material);
  mesh.scale.set(radius * 2, height, radius * 2);
  mesh.position.set(x, y, z);
  return mesh;
}

export function makeSphere(
  material: THREE.Material,
  radius: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(factorySphereGeom, material);
  mesh.scale.setScalar(radius);
  mesh.position.set(x, y, z);
  return mesh;
}

export function detail(
  mesh: THREE.Mesh,
  minTier: ConcreteGraphicsQuality,
  maxTier?: ConcreteGraphicsQuality,
  role: BuildingDetailRole = 'static',
): BuildingDetailMesh {
  return { mesh, minTier, maxTier, role };
}

export function disposeBuildingMeshPrimitives(): void {
  boxGeom.dispose();
  cylinderGeom.dispose();
  hexCylinderGeom.dispose();
  factorySphereGeom.dispose();
  coneGeom.dispose();
  windBladeGeom.dispose();
  windTowerMat.dispose();
  windTrimMat.dispose();
  windNacelleMat.dispose();
  windBladeMat.dispose();
  windGlassMat.dispose();
  extractorBladeMat.dispose();
  invisibleMat.dispose();
  factoryFrameMat.dispose();
}
