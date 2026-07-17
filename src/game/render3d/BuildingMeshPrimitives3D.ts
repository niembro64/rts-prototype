import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import { BUILDING_PALETTE } from './BuildingVisualPalette';
import type { BuildingDetailMesh, BuildingDetailRole } from './BuildingShape3D';
import {
  createPrimitiveConeGeometry,
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
  getSharedExtrudedEquilateralTriangleGeometry,
  getSharedPrimitiveTetrahedronGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

export const boxGeom = new THREE.BoxGeometry(1, 1, 1);
export const cylinderGeom = createPrimitiveCylinderGeometry('building', 'close', 0.5, 0.5);
export const hexCylinderGeom = createPrimitiveCylinderGeometry('building', 'far', 0.5, 0.5);
const factorySphereGeom = createPrimitiveSphereGeometry('building', 'close');
const coneGeom = createPrimitiveConeGeometry('building', 'close', 0.5);
const cylinderGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>([
  ['close', cylinderGeom],
]);
const sphereGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>([
  ['close', factorySphereGeom],
]);
const coneGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>([
  ['close', coneGeom],
]);
let activeBuildingGeometryTier: PrimitiveGeometryTier = 'close';

export function withBuildingGeometryTier<T>(
  tier: PrimitiveGeometryTier,
  build: () => T,
): T {
  const previous = activeBuildingGeometryTier;
  activeBuildingGeometryTier = tier;
  try {
    return build();
  } finally {
    activeBuildingGeometryTier = previous;
  }
}

export function getActiveBuildingGeometryTier(): PrimitiveGeometryTier {
  return activeBuildingGeometryTier;
}

export function getBuildingCylinderGeometry(
  tier: PrimitiveGeometryTier = activeBuildingGeometryTier,
): THREE.BufferGeometry {
  let geometry = cylinderGeomByTier.get(tier);
  if (geometry === undefined) {
    geometry = tier === 'far'
      ? getSharedExtrudedEquilateralTriangleGeometry(0.5, 1).clone()
      : createPrimitiveCylinderGeometry('building', tier, 0.5, 0.5);
    cylinderGeomByTier.set(tier, geometry);
  }
  return geometry;
}

function getBuildingSphereGeometry(
  tier: PrimitiveGeometryTier = activeBuildingGeometryTier,
): THREE.BufferGeometry {
  let geometry = sphereGeomByTier.get(tier);
  if (geometry === undefined) {
    geometry = tier === 'far'
      ? getSharedPrimitiveTetrahedronGeometry(1).clone()
      : createPrimitiveSphereGeometry('building', tier);
    sphereGeomByTier.set(tier, geometry);
  }
  return geometry;
}

function getBuildingConeGeometry(
  tier: PrimitiveGeometryTier = activeBuildingGeometryTier,
): THREE.BufferGeometry {
  let geometry = coneGeomByTier.get(tier);
  if (geometry === undefined) {
    geometry = createPrimitiveConeGeometry('building', tier, 0.5);
    coneGeomByTier.set(tier, geometry);
  }
  return geometry;
}
const windBladeGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();

function getWindBladeGeometry(
  tier: PrimitiveGeometryTier = activeBuildingGeometryTier,
): THREE.BufferGeometry {
  let geometry = windBladeGeomByTier.get(tier);
  if (geometry === undefined) {
    geometry = createWindBladeGeometry(tier);
    windBladeGeomByTier.set(tier, geometry);
  }
  return geometry;
}

const windTowerMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
export const windTrimMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });
export const windNacelleMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.windNacelle.colorHex,
  metalness: COLORS.buildings.materials.windNacelle.metalness,
  roughness: COLORS.buildings.materials.windNacelle.roughness,
});
export const windBladeMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.windBlade.colorHex,
  metalness: COLORS.buildings.materials.windBlade.metalness,
  roughness: COLORS.buildings.materials.windBlade.roughness,
  side: THREE.DoubleSide,
});
export const windGlassMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.windGlass.colorHex,
  metalness: COLORS.buildings.materials.windGlass.metalness,
  roughness: COLORS.buildings.materials.windGlass.roughness,
});
/** Spinning blades on the metal extractor. Tinted with the metal-resource
 *  color while staying deliberately dull so the moving pieces don't read
 *  like polished trim. */
export const extractorBladeMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.extractorBlade.colorHex,
  metalness: COLORS.buildings.materials.extractorBlade.metalness,
  roughness: COLORS.buildings.materials.extractorBlade.roughness,
  envMapIntensity: COLORS.buildings.materials.extractorBlade.envMapIntensity,
  side: THREE.DoubleSide,
});
export const invisibleMat = new THREE.MeshBasicMaterial({
  color: COLORS.buildings.materials.invisible.colorHex,
  transparent: true,
  opacity: COLORS.buildings.materials.invisible.opacity,
  depthWrite: false,
});
export const factoryFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });

function createWindBladeGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  if (tier === 'far') {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.68, 0.06, 0, 0.68, 0.06, 0, 0.08, 1, 0,
      -0.68, 0.06, 0, 0.08, 1, 0, -0.08, 1, 0,
    ], 3));
    geom.computeVertexNormals();
    return geom;
  }
  const stations = tier === 'close' ? [
    { y: 0.06, halfW: 0.68, halfT: 0.92, sweep: -0.02 },
    { y: 0.48, halfW: 0.376, halfT: 0.509, sweep: 0.025 },
    { y: 1.0, halfW: 0.0, halfT: 0.0, sweep: 0.08 },
  ] : [
    { y: 0.06, halfW: 0.68, halfT: 0.92, sweep: -0.02 },
    { y: 1.0, halfW: 0.0, halfT: 0.0, sweep: 0.08 },
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
  const mesh = new THREE.Mesh(getWindBladeGeometry(), material);
  mesh.scale.set(rootWidth, length, thickness);
  mesh.rotation.z = angle;
  return mesh;
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
  geom?: THREE.BufferGeometry,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geom ?? getBuildingCylinderGeometry(), material);
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
  const mesh = new THREE.Mesh(getBuildingConeGeometry(), material);
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
  const mesh = new THREE.Mesh(getBuildingSphereGeometry(), material);
  mesh.scale.setScalar(radius);
  mesh.position.set(x, y, z);
  return mesh;
}

export function detail(
  mesh: THREE.Mesh,
  _legacyVisibility?: unknown,
  _legacyMaxVisibility?: unknown,
  role: BuildingDetailRole = 'static',
): BuildingDetailMesh {
  return { mesh, role };
}

export function disposeBuildingMeshPrimitives(): void {
  boxGeom.dispose();
  hexCylinderGeom.dispose();
  for (const geometry of cylinderGeomByTier.values()) geometry.dispose();
  for (const geometry of sphereGeomByTier.values()) geometry.dispose();
  for (const geometry of coneGeomByTier.values()) geometry.dispose();
  cylinderGeomByTier.clear();
  sphereGeomByTier.clear();
  coneGeomByTier.clear();
  for (const geometry of windBladeGeomByTier.values()) geometry.dispose();
  windBladeGeomByTier.clear();
  windTowerMat.dispose();
  windTrimMat.dispose();
  windNacelleMat.dispose();
  windBladeMat.dispose();
  windGlassMat.dispose();
  extractorBladeMat.dispose();
  invisibleMat.dispose();
  factoryFrameMat.dispose();
}
