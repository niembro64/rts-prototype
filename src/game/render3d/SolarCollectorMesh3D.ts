import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import { SOLAR_BUILDING_VISUAL_HEIGHT } from '../sim/blueprints';
import { BUILDING_PALETTE } from './BuildingVisualPalette';
import {
  buildProductionRateIndicator,
  type ProductionRateIndicatorRig,
} from './ConstructionEmitterMesh3D';
import type { BuildingDetailMesh, BuildingDetailRole, BuildingShape } from './BuildingShape3D';

export type SolarPetalAnimation = {
  width: number;
  length: number;
  hinge: THREE.Vector3;
  tangent: THREE.Vector3;
  openDirection: THREE.Vector3;
  closedDirection: THREE.Vector3;
  panelSideHint: THREE.Vector3;
  inset: number;
  normalOffset: number;
  thickness: number;
};

export type SolarRig = {
  rateIndicator: ProductionRateIndicatorRig;
};

const SOLAR_HEIGHT = SOLAR_BUILDING_VISUAL_HEIGHT;
const SOLAR_PETAL_CHOP_FRACTION = 2 / 3;
const SOLAR_CHOP_HALF = (1 - SOLAR_PETAL_CHOP_FRACTION) / 2;
const SOLAR_FRUSTUM_TOP_Y = -0.5 + SOLAR_PETAL_CHOP_FRACTION;
const h = SOLAR_CHOP_HALF;
const ty = SOLAR_FRUSTUM_TOP_Y;

const solarPanelPyramidGeom = new THREE.BufferGeometry();
solarPanelPyramidGeom.setAttribute('position', new THREE.Float32BufferAttribute([
  -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   h, ty,  h,
  -0.5, -0.5,  0.5,   h, ty,  h,  -h, ty,  h,
   0.5, -0.5, -0.5,  -0.5, -0.5, -0.5,  -h, ty, -h,
   0.5, -0.5, -0.5,  -h, ty, -h,   h, ty, -h,
   0.5, -0.5,  0.5,   0.5, -0.5, -0.5,   h, ty, -h,
   0.5, -0.5,  0.5,   h, ty, -h,   h, ty,  h,
  -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -h, ty,  h,
  -0.5, -0.5, -0.5,  -h, ty,  h,  -h, ty, -h,
  -h, ty, -h,  -h, ty,  h,   h, ty,  h,
  -h, ty, -h,   h, ty,  h,   h, ty, -h,
], 3));
solarPanelPyramidGeom.computeVertexNormals();

const solarTrianglePetalShape = new THREE.Shape([
  new THREE.Vector2(-0.5, 0),
  new THREE.Vector2(0.5, 0),
  new THREE.Vector2(SOLAR_CHOP_HALF, SOLAR_PETAL_CHOP_FRACTION),
  new THREE.Vector2(-SOLAR_CHOP_HALF, SOLAR_PETAL_CHOP_FRACTION),
]);
const solarTrianglePanelGeom = new THREE.ShapeGeometry(solarTrianglePetalShape);
const solarTrianglePetalGeom = new THREE.ExtrudeGeometry(solarTrianglePetalShape, {
  depth: 1,
  bevelEnabled: false,
  steps: 1,
});
const cylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
const sphereGeom = new THREE.SphereGeometry(1, 18, 12);

const solarCellMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.photovoltaic,
  metalness: 1.0,
  roughness: 0.02,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -4,
});
const solarPetalBackMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.photovoltaicBack,
  side: THREE.DoubleSide,
});

const _solarPetalTangent = new THREE.Vector3();
const _solarPetalDirection = new THREE.Vector3();
const _solarPetalNormal = new THREE.Vector3();
const _solarPetalOrigin = new THREE.Vector3();
const _solarPetalXAxis = new THREE.Vector3();
const _solarPetalYAxis = new THREE.Vector3();
const _solarPetalZAxis = new THREE.Vector3();

export function buildSolarCollector(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(solarPanelPyramidGeom, solarCellMat);
  const details: BuildingDetailMesh[] = [];

  const petalTilt = 0.42;
  const petalHingeY = 0;
  const petalThickness = 3.2;
  const panelRaise = 2.4;
  const petalFaceOffset = petalThickness + panelRaise;
  const teamAccentThickness = 0.85;
  const teamAccentOffset = -teamAccentThickness - 0.35;
  const frontBackAspect = width / Math.hypot(SOLAR_HEIGHT, depth * 0.5);
  const sideAspect = depth / Math.hypot(SOLAR_HEIGHT, width * 0.5);

  const frontBackSpan = width;
  const frontBackLen = frontBackSpan / frontBackAspect;
  const frontBackZ = depth * 0.5;
  const sideSpan = depth;
  const sideLen = sideSpan / sideAspect;
  const sideX = width * 0.5;
  const hingeRadius = Math.max(2.2, Math.min(width, depth) * 0.035);
  const hingeCapRadius = hingeRadius * 1.08;

  for (const xSign of [-1, 1] as const) {
    for (const zSign of [-1, 1] as const) {
      details.push(detail(makeSphere(
        solarPetalBackMat,
        hingeCapRadius,
        xSign * sideX,
        hingeCapRadius,
        zSign * frontBackZ,
      ), 'low'));
    }
  }

  for (const sign of [-1, 1]) {
    const frontBackClosedDir = new THREE.Vector3(0, SOLAR_HEIGHT, -sign * frontBackZ);
    const frontBackPanelSide = new THREE.Vector3(0, 0, -sign);
    details.push(detail(makeHingeBar(
      solarPetalBackMat,
      frontBackSpan,
      hingeRadius,
      0,
      hingeRadius,
      sign * frontBackZ,
      1,
      0,
    ), 'low'));
    details.push(detail(makeTrianglePetal(
      solarPetalBackMat,
      frontBackSpan,
      frontBackLen,
      0,
      petalHingeY,
      sign * frontBackZ,
      1,
      0,
      0,
      sign,
      petalTilt,
      0,
      0,
      petalThickness,
      frontBackClosedDir,
      frontBackPanelSide,
    ), 'low', undefined, 'solarLeaf'));
    details.push(detail(makeTrianglePetal(
      primaryMat,
      frontBackSpan * 0.58,
      frontBackLen * 0.42,
      0,
      petalHingeY,
      sign * frontBackZ,
      1,
      0,
      0,
      sign,
      petalTilt,
      frontBackLen * 0.2,
      teamAccentOffset,
      teamAccentThickness,
      frontBackClosedDir,
      frontBackPanelSide,
    ), 'medium', undefined, 'solarTeamAccent'));
    details.push(detail(makeTrianglePetal(
      solarCellMat,
      frontBackSpan,
      frontBackLen,
      0,
      petalHingeY,
      sign * frontBackZ,
      1,
      0,
      0,
      sign,
      petalTilt,
      0,
      petalFaceOffset,
      0,
      frontBackClosedDir,
      frontBackPanelSide,
    ), 'low', undefined, 'solarPanel'));

    const sideClosedDir = new THREE.Vector3(-sign * sideX, SOLAR_HEIGHT, 0);
    const sidePanelSide = new THREE.Vector3(-sign, 0, 0);
    details.push(detail(makeHingeBar(
      solarPetalBackMat,
      sideSpan,
      hingeRadius,
      sign * sideX,
      hingeRadius,
      0,
      0,
      1,
    ), 'low'));
    details.push(detail(makeTrianglePetal(
      solarPetalBackMat,
      sideSpan,
      sideLen,
      sign * sideX,
      petalHingeY,
      0,
      0,
      1,
      sign,
      0,
      petalTilt,
      0,
      0,
      petalThickness,
      sideClosedDir,
      sidePanelSide,
    ), 'low', undefined, 'solarLeaf'));
    details.push(detail(makeTrianglePetal(
      primaryMat,
      sideSpan * 0.58,
      sideLen * 0.42,
      sign * sideX,
      petalHingeY,
      0,
      0,
      1,
      sign,
      0,
      petalTilt,
      sideLen * 0.2,
      teamAccentOffset,
      teamAccentThickness,
      sideClosedDir,
      sidePanelSide,
    ), 'medium', undefined, 'solarTeamAccent'));
    details.push(detail(makeTrianglePetal(
      solarCellMat,
      sideSpan,
      sideLen,
      sign * sideX,
      petalHingeY,
      0,
      0,
      1,
      sign,
      0,
      petalTilt,
      0,
      petalFaceOffset,
      0,
      sideClosedDir,
      sidePanelSide,
    ), 'low', undefined, 'solarPanel'));
  }

  const minDim = Math.min(width, depth);
  const squareTopY = SOLAR_PETAL_CHOP_FRACTION * SOLAR_HEIGHT;
  const ratePillarBaseY = squareTopY + 2;
  const shortRatePillarHeight = Math.max(10, Math.min(16, SOLAR_HEIGHT - ratePillarBaseY - 4));
  const ratePillarHeight = shortRatePillarHeight * 2;
  const ratePillarRadius = Math.max(3.8, minDim * 0.055);
  const energyRateIndicator = buildProductionRateIndicator(
    'energy',
    ratePillarRadius * 1.7,
    ratePillarHeight,
    ratePillarBaseY,
    0,
    0,
    ratePillarRadius,
  );
  for (const mesh of energyRateIndicator.staticMeshes) {
    details.push(detail(mesh, 'low'));
  }
  details.push(detail(energyRateIndicator.rig.shower, 'low'));

  return {
    primary,
    details,
    height: SOLAR_HEIGHT,
    primaryMaterialLocked: true,
    solarRig: { rateIndicator: energyRateIndicator.rig },
  };
}

function makeTrianglePetal(
  material: THREE.Material,
  width: number,
  length: number,
  hingeX: number,
  hingeY: number,
  hingeZ: number,
  tangentX: number,
  tangentZ: number,
  outwardX: number,
  outwardZ: number,
  openAngle: number,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  closedDirection?: THREE.Vector3,
  panelSideHint = new THREE.Vector3(0, 1, 0),
): THREE.Mesh {
  const hinge = new THREE.Vector3(hingeX, hingeY, hingeZ);
  const tangent = new THREE.Vector3(tangentX, 0, tangentZ);
  const openDirection = new THREE.Vector3(
    outwardX * Math.cos(openAngle),
    Math.sin(openAngle),
    outwardZ * Math.cos(openAngle),
  );
  const mesh = makeTrianglePlate(
    material,
    width,
    length,
    hinge,
    tangent,
    openDirection,
    inset,
    normalOffset,
    thickness,
    panelSideHint,
  );
  if (closedDirection) {
    mesh.userData.solarPetal = {
      width,
      length,
      hinge: hinge.clone(),
      tangent: tangent.clone(),
      openDirection: openDirection.clone(),
      closedDirection: closedDirection.clone(),
      panelSideHint: panelSideHint.clone(),
      inset,
      normalOffset,
      thickness,
    } satisfies SolarPetalAnimation;
  }
  return mesh;
}

function makeTrianglePlate(
  material: THREE.Material,
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(thickness > 0 ? solarTrianglePetalGeom : solarTrianglePanelGeom, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(makeTrianglePlateMatrix(width, length, hinge, tangent, petalDirection, inset, normalOffset, thickness, panelSideHint));
  return mesh;
}

function makeTrianglePlateMatrix(
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  writeSolarPetalMatrix(
    matrix,
    width,
    length,
    hinge,
    tangent,
    petalDirection,
    inset,
    normalOffset,
    thickness,
    panelSideHint,
  );
  return matrix;
}

export function writeSolarPetalMatrix(
  matrix: THREE.Matrix4,
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): void {
  const tangentDir = _solarPetalTangent.copy(tangent).normalize();
  const petalDir = _solarPetalDirection.copy(petalDirection).normalize();
  const normal = _solarPetalNormal.crossVectors(tangentDir, petalDir).normalize();
  if (panelSideHint) {
    if (normal.dot(panelSideHint) < 0) normal.multiplyScalar(-1);
  } else if (normal.y < 0) {
    normal.multiplyScalar(-1);
  }
  const origin = _solarPetalOrigin.copy(hinge)
    .addScaledVector(petalDir, inset)
    .addScaledVector(normal, normalOffset);
  const xAxis = _solarPetalXAxis.copy(tangentDir).multiplyScalar(width);
  const yAxis = _solarPetalYAxis.copy(petalDir).multiplyScalar(Math.max(1, length - inset));
  const zAxis = _solarPetalZAxis.copy(normal).multiplyScalar(Math.max(1, thickness));
  matrix.makeBasis(xAxis, yAxis, zAxis);
  matrix.setPosition(origin);
}

function makeHingeBar(
  material: THREE.Material,
  length: number,
  radius: number,
  x: number,
  y: number,
  z: number,
  tangentX: number,
  tangentZ: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(cylinderGeom, material);
  mesh.scale.set(radius * 2, length, radius * 2);
  mesh.position.set(x, y, z);
  const tangent = new THREE.Vector3(tangentX, 0, tangentZ).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
  return mesh;
}

function makeSphere(
  material: THREE.Material,
  radius: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(sphereGeom, material);
  mesh.scale.setScalar(radius);
  mesh.position.set(x, y, z);
  return mesh;
}

function detail(
  mesh: THREE.Mesh,
  minTier: ConcreteGraphicsQuality,
  maxTier?: ConcreteGraphicsQuality,
  role: BuildingDetailRole = 'static',
): BuildingDetailMesh {
  return { mesh, minTier, maxTier, role };
}

export function disposeSolarCollectorGeoms(): void {
  solarPanelPyramidGeom.dispose();
  solarTrianglePanelGeom.dispose();
  solarTrianglePetalGeom.dispose();
  cylinderGeom.dispose();
  sphereGeom.dispose();
  solarCellMat.dispose();
  solarPetalBackMat.dispose();
}
