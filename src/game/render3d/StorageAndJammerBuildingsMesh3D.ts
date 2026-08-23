import * as THREE from 'three';
import type { BuildingShape } from './BuildingShape3D';
import {
  boxGeom,
  createHexFrustumGeometry,
  detail,
  hexCylinderGeom,
  invisibleMat,
  makeBox,
  makeCylinder,
  makeSphere,
  teamOrnamentDetail,
} from './BuildingMeshPrimitives3D';
import { BUILDING_PALETTE } from './BuildingVisualPalette';
import { markBuildingTeamOrnament } from './BuildingTeamOrnament3D';
import {
  createBuildingOperationalPosePart,
  createBuildingOperationalRig,
} from './BuildingOperationalRig3D';

const structureDarkMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.structureDark,
});
const structureMidMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.structureMid,
});
const structureLightMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.structureLight,
  metalness: 0.55,
  roughness: 0.36,
});
const radarJamGlowMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.constructionSpark,
  transparent: true,
  opacity: 0.68,
});
const sonarJamGlowMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlow,
  transparent: true,
  opacity: 0.62,
});
const metalCargoMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.metalResource,
  metalness: 0.72,
  roughness: 0.3,
});
const energyGlowMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlow,
  transparent: true,
  opacity: 0.7,
});
const metalVaultBodyGeom = new THREE.BoxGeometry(0.68, 1, 0.54);
metalVaultBodyGeom.name = 'metalStorageVault';
const jammerMastBodyGeom = createHexFrustumGeometry(0.06, 0.2);
jammerMastBodyGeom.name = 'jammerMastBody';
const energyCoreGeom = createHexFrustumGeometry(0.2, 0.32);
energyCoreGeom.name = 'energyStorageCore';

function makeHorizontalRod(
  material: THREE.Material,
  radius: number,
  length: number,
  axis: 'x' | 'z',
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const rod = makeCylinder(material, radius, length, x, y, z);
  if (axis === 'x') rod.rotation.z = Math.PI / 2;
  else rod.rotation.x = Math.PI / 2;
  return rod;
}

function makeRodBetween(
  material: THREE.Material,
  radius: number,
  start: THREE.Vector3,
  end: THREE.Vector3,
  geometry?: THREE.BufferGeometry,
): THREE.Mesh {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const rod = makeCylinder(
    material,
    radius,
    length,
    (start.x + end.x) * 0.5,
    (start.y + end.y) * 0.5,
    (start.z + end.z) * 0.5,
    geometry,
  );
  rod.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.multiplyScalar(1 / Math.max(length, 1e-9)),
  );
  return rod;
}

/** Land electronic-countermeasure tower. Its crossed phased-array arms read
 *  differently from Radar's directional dish even when seen as a far LOD. */
export function buildRadarJammerMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = 150;
  const minDim = Math.min(width, depth);
  const primary = new THREE.Mesh(jammerMastBodyGeom, primaryMat);
  const details: BuildingShape['details'] = [];
  const baseRadius = Math.max(16, minDim * 0.31);

  details.push(detail(makeCylinder(
    structureDarkMat,
    baseRadius,
    12,
    0,
    6,
    0,
    hexCylinderGeom,
  ), 'min'));
  details.push(teamOrnamentDetail(makeCylinder(
    primaryMat,
    baseRadius * 1.05,
    5,
    0,
    14,
    0,
    hexCylinderGeom,
  ), 'radarJammerCoil'));
  details.push(detail(makeCylinder(
    structureMidMat,
    Math.max(5, minDim * 0.08),
    height * 0.68,
    0,
    height * 0.48,
    0,
  ), 'low'));

  const sweepMount = new THREE.Mesh(boxGeom, invisibleMat);
  sweepMount.position.set(0, height * 0.79, 0);
  const sweep = new THREE.Group();
  sweepMount.add(sweep);
  const armLength = Math.max(44, minDim * 0.98);
  for (const axis of ['x', 'z'] as const) {
    sweep.add(makeHorizontalRod(
      structureLightMat,
      Math.max(2.2, minDim * 0.04),
      armLength,
      axis,
      0,
      0,
      0,
    ));
    sweep.add(makeHorizontalRod(
      radarJamGlowMat,
      Math.max(0.8, minDim * 0.014),
      armLength * 1.18,
      axis,
      0,
      4,
      0,
    ));
  }
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI * 0.5;
    const panelRadius = armLength * 0.38;
    const panel = makeBox(
      structureMidMat,
      Math.max(12, minDim * 0.22),
      Math.max(18, minDim * 0.34),
      Math.max(2.2, minDim * 0.035),
      Math.cos(angle) * panelRadius,
      1.5,
      Math.sin(angle) * panelRadius,
    );
    panel.rotation.y = -angle;
    panel.rotation.z = i % 2 === 0 ? 0.18 : -0.18;
    sweep.add(panel);
  }
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI * 0.25 + i * Math.PI * 0.5;
    const radius = armLength * 0.43;
    const coil = makeCylinder(
      primaryMat,
      Math.max(3.4, minDim * 0.055),
      Math.max(4, minDim * 0.07),
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius,
    );
    markAsRadarJammerCoil(coil);
    sweep.add(coil);
  }
  sweep.add(makeSphere(radarJamGlowMat, Math.max(6, minDim * 0.1), 0, 0, 0));
  details.push(detail(sweepMount, 'low', undefined, 'radarRig'));
  const operationalRig = createBuildingOperationalRig([
    createBuildingOperationalPosePart(sweepMount, {
      closedPosition: new THREE.Vector3(0, height * 0.48, 0),
      closedScale: new THREE.Vector3(0.55, 0.55, 0.55),
    }),
  ], { chassisClosedScaleY: 0.82 });
  return {
    primary,
    details,
    height,
    radarRig: { head: sweepMount, sweep },
    operationalRig,
  };
}

function markAsRadarJammerCoil(mesh: THREE.Mesh): void {
  markBuildingTeamOrnament(mesh, 'radarJammerCoil');
}

/** Sea-surface acoustic countermeasure buoy. The broad horizontal baffles sit
 *  below the waterline, making its downward function legible from shore. */
export function buildSonarJammerMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = 140;
  const waterlineY = height * 0.5;
  const minDim = Math.min(width, depth);
  const primary = new THREE.Mesh(jammerMastBodyGeom, primaryMat);
  const details: BuildingShape['details'] = [];
  const collarRadius = Math.max(15, minDim * 0.36);

  details.push(detail(makeCylinder(
    structureDarkMat,
    collarRadius,
    11,
    0,
    waterlineY + 5.5,
    0,
  ), 'min'));
  details.push(teamOrnamentDetail(makeCylinder(
    primaryMat,
    collarRadius * 1.06,
    4,
    0,
    waterlineY + 12,
    0,
  ), 'sonarJammerBaffle'));
  details.push(detail(makeCylinder(
    structureMidMat,
    Math.max(4, minDim * 0.07),
    height * 0.5,
    0,
    waterlineY - height * 0.18,
    0,
  ), 'low'));

  const sweepMount = new THREE.Mesh(boxGeom, invisibleMat);
  sweepMount.position.set(0, waterlineY - height * 0.29, 0);
  const sweep = new THREE.Group();
  sweepMount.add(sweep);
  const baffleLength = Math.max(42, minDim * 0.92);
  for (const axis of ['x', 'z'] as const) {
    sweep.add(makeHorizontalRod(
      structureLightMat,
      Math.max(2.5, minDim * 0.045),
      baffleLength,
      axis,
      0,
      0,
      0,
    ));
    sweep.add(makeHorizontalRod(
      sonarJamGlowMat,
      Math.max(0.9, minDim * 0.015),
      baffleLength * 1.2,
      axis,
      0,
      -4,
      0,
    ));
  }
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI * 0.5;
    const radius = baffleLength * 0.42;
    const baffle = makeBox(
      primaryMat,
      Math.max(5, minDim * 0.09),
      Math.max(4, minDim * 0.07),
      Math.max(8, minDim * 0.14),
      Math.cos(angle) * radius,
      0,
      Math.sin(angle) * radius,
    );
    markBuildingTeamOrnament(baffle, 'sonarJammerBaffle');
    sweep.add(baffle);
  }
  sweep.add(makeSphere(sonarJamGlowMat, Math.max(6, minDim * 0.1), 0, 0, 0));
  details.push(detail(sweepMount, 'low', undefined, 'radarRig'));
  const operationalRig = createBuildingOperationalRig([
    createBuildingOperationalPosePart(sweepMount, {
      closedPosition: new THREE.Vector3(0, waterlineY - height * 0.05, 0),
      closedScale: new THREE.Vector3(0.52, 0.52, 0.52),
    }),
  ], { chassisClosedScaleY: 0.84 });

  return {
    primary,
    details,
    height,
    radarRig: { head: sweepMount, sweep },
    operationalRig,
  };
}

/** Dense armored racks carrying visible metal billets. */
export function buildMetalStorageMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const minDim = Math.min(width, depth);
  const linearScale = minDim / 80;
  const height = 80 * linearScale;
  const primary = new THREE.Mesh(metalVaultBodyGeom, primaryMat);
  const details: BuildingShape['details'] = [];
  const rackWidth = width * 0.72;
  const rackDepth = depth * 0.68;
  const billetRadius = Math.max(5, minDim * 0.07);
  const rackFaceZ = depth * 0.34;

  details.push(detail(makeBox(
    structureDarkMat,
    rackWidth,
    10 * linearScale,
    rackDepth,
    0,
    10 * linearScale,
    0,
  ), 'min'));
  for (const face of [-1, 1]) {
    const faceZ = face * rackFaceZ;
    for (const y of [23, 40, 57].map((value) => value * linearScale)) {
      details.push(detail(makeHorizontalRod(
        metalCargoMat,
        billetRadius,
        rackWidth * 0.88,
        'x',
        0,
        y,
        faceZ,
      ), 'low'));
    }
    for (const x of [-rackWidth * 0.47, rackWidth * 0.47]) {
      details.push(teamOrnamentDetail(makeBox(
        primaryMat,
        Math.max(5, minDim * 0.07),
        height * 0.76,
        Math.max(6, rackDepth * 0.13),
        x,
        height * 0.48,
        faceZ + face * billetRadius * 0.35,
      ), 'metalStorageBrace'));
    }
    details.push(detail(makeRodBetween(
      structureDarkMat,
      Math.max(1.8, minDim * 0.025),
      new THREE.Vector3(
        -rackWidth * 0.39,
        15 * linearScale,
        faceZ + face * billetRadius * 0.75,
      ),
      new THREE.Vector3(
        rackWidth * 0.39,
        68 * linearScale,
        faceZ + face * billetRadius * 0.75,
      ),
      hexCylinderGeom,
    ), 'low'));
    details.push(detail(makeRodBetween(
      structureDarkMat,
      Math.max(1.8, minDim * 0.025),
      new THREE.Vector3(
        rackWidth * 0.39,
        15 * linearScale,
        faceZ + face * billetRadius * 0.75,
      ),
      new THREE.Vector3(
        -rackWidth * 0.39,
        68 * linearScale,
        faceZ + face * billetRadius * 0.75,
      ),
      hexCylinderGeom,
    ), 'low'));
  }
  details.push(detail(makeBox(
    structureLightMat,
    rackWidth * 0.9,
    6 * linearScale,
    rackDepth * 0.86,
    0,
    height - 7 * linearScale,
    0,
  ), 'low'));
  for (const x of [-rackWidth * 0.3, rackWidth * 0.3]) {
    details.push(detail(makeBox(
      structureDarkMat,
      Math.max(4, minDim * 0.05),
      7 * linearScale,
      depth * 0.9,
      x,
      height - 2 * linearScale,
      0,
    ), 'low'));
  }
  return { primary, details, height };
}

/** Four capacitor banks joined by a bright central bus. */
export function buildEnergyStorageMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const minDim = Math.min(width, depth);
  const linearScale = minDim / 80;
  const height = 90 * linearScale;
  const primary = new THREE.Mesh(energyCoreGeom, primaryMat);
  const details: BuildingShape['details'] = [];
  const offsetX = width * 0.31;
  const offsetZ = depth * 0.31;
  const cellRadius = Math.max(8, minDim * 0.12);
  const cellHeight = height * 0.62;

  details.push(detail(makeCylinder(
    structureDarkMat,
    Math.max(24, minDim * 0.38),
    10 * linearScale,
    0,
    7 * linearScale,
    0,
    hexCylinderGeom,
  ), 'min'));
  for (const x of [-offsetX, offsetX]) {
    for (const z of [-offsetZ, offsetZ]) {
      details.push(detail(makeCylinder(
        structureLightMat,
        cellRadius,
        cellHeight,
        x,
        13 * linearScale + cellHeight * 0.5,
        z,
      ), 'low'));
      details.push(detail(makeSphere(
        energyGlowMat,
        cellRadius * 0.54,
        x,
        14 * linearScale + cellHeight,
        z,
      ), 'low'));
    }
  }
  const busY = height * 0.72;
  details.push(teamOrnamentDetail(makeBox(
    primaryMat,
    offsetX * 2.35,
    Math.max(5, minDim * 0.07),
    Math.max(6, minDim * 0.08),
    0,
    busY,
    0,
  ), 'energyStorageBusbar'));
  details.push(teamOrnamentDetail(makeBox(
    primaryMat,
    Math.max(6, minDim * 0.08),
    Math.max(5, minDim * 0.07),
    offsetZ * 2.35,
    0,
    busY,
    0,
  ), 'energyStorageBusbar'));
  details.push(detail(makeSphere(
    energyGlowMat,
    Math.max(7, minDim * 0.1),
    0,
    busY + 4 * linearScale,
    0,
  ), 'low'));
  return { primary, details, height };
}

export function disposeStorageAndJammerBuildingGeoms(): void {
  metalVaultBodyGeom.dispose();
  jammerMastBodyGeom.dispose();
  energyCoreGeom.dispose();
  structureDarkMat.dispose();
  structureMidMat.dispose();
  structureLightMat.dispose();
  radarJamGlowMat.dispose();
  sonarJamGlowMat.dispose();
  metalCargoMat.dispose();
  energyGlowMat.dispose();
}
