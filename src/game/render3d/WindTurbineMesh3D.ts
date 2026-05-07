import * as THREE from 'three';
import { WIND_BUILDING_VISUAL_HEIGHT } from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import type { ProductionRateIndicatorRig } from './ConstructionEmitterMesh3D';
import { buildProductionRateIndicator } from './ConstructionEmitterMesh3D';
import {
  boxGeom,
  cylinderGeom,
  detail,
  factoryFrameMat,
  hexCylinderGeom,
  invisibleMat,
  makeBox,
  makeCone,
  makeCylinder,
  makeSphere,
  makeTurbineBlade,
  windBladeMat,
  windGlassMat,
  windNacelleMat,
  windTowerMat,
  windTrimMat,
} from './BuildingMeshPrimitives3D';

export type WindTurbineRig = {
  root: THREE.Mesh;
  rotor: THREE.Mesh;
  rateIndicator?: ProductionRateIndicatorRig;
};

export function buildWindTurbineMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const minDim = Math.min(width, depth);
  const towerRadius = Math.max(3, minDim * 0.1);
  const towerH = WIND_BUILDING_VISUAL_HEIGHT * 0.57;
  const baseH = 12;
  const primary = new THREE.Mesh(cylinderGeom, primaryMat);
  const details: BuildingShape['details'] = [];

  details.push(detail(
    makeCylinder(factoryFrameMat, Math.max(7, minDim * 0.28), 5, 0, baseH + 2.5, 0, hexCylinderGeom),
    'low',
  ));
  details.push(detail(
    makeCylinder(windTowerMat, towerRadius, towerH, 0, towerH / 2, 0),
    'low',
  ));
  const energyRateIndicator = buildProductionRateIndicator(
    'energy',
    towerRadius * 1.8,
    towerH,
    0,
  );
  details.push(detail(energyRateIndicator.rig.shower, 'low'));

  const root = new THREE.Mesh(boxGeom, invisibleMat);
  root.position.set(0, towerH, 0);
  root.visible = false;

  const nacelleLen = Math.max(32, minDim * 0.86);
  const nacelleRadius = Math.max(5.2, minDim * 0.16);
  const nacelle = makeCylinder(windNacelleMat, nacelleRadius, nacelleLen, 0, 0, 0);
  nacelle.rotation.x = Math.PI / 2;
  root.add(nacelle);

  const tailCap = makeCone(windTrimMat, nacelleRadius * 0.72, nacelleRadius * 1.7, 0, 0, -nacelleLen * 0.52);
  tailCap.rotation.x = -Math.PI / 2;
  root.add(tailCap);

  const panelLen = nacelleLen * 0.52;
  const panelH = nacelleRadius * 0.42;
  for (const side of [-1, 1]) {
    root.add(makeBox(
      windGlassMat,
      0.6,
      panelH,
      panelLen,
      side * nacelleRadius * 1.02,
      nacelleRadius * 0.1,
      -nacelleLen * 0.05,
    ));
    const fin = makeBox(
      windTrimMat,
      Math.max(1.4, nacelleRadius * 0.16),
      nacelleRadius * 1.9,
      nacelleLen * 0.3,
      side * nacelleRadius * 1.34,
      nacelleRadius * 0.15,
      -nacelleLen * 0.1,
    );
    fin.rotation.z = side * 0.2;
    root.add(fin);
  }

  const rotor = new THREE.Mesh(boxGeom, invisibleMat);
  rotor.position.set(0, 0, nacelleLen * 0.66);
  root.add(rotor);

  const bladeLen = Math.min(WIND_BUILDING_VISUAL_HEIGHT * 0.42, Math.max(86, minDim * 1.55));
  const bladeW = Math.max(8, minDim * 0.19);
  const bladeThickness = Math.max(1.6, minDim * 0.032);
  const hub = makeSphere(windNacelleMat, nacelleRadius * 0.78, 0, 0, 0);
  rotor.add(hub);

  const nose = makeCone(windNacelleMat, nacelleRadius * 0.74, nacelleRadius * 1.38, 0, 0, nacelleRadius * 0.5);
  nose.rotation.x = Math.PI / 2;
  rotor.add(nose);

  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const blade = makeTurbineBlade(windBladeMat, bladeLen, bladeW, bladeThickness, angle);
    rotor.add(blade);
  }

  details.push(detail(root, 'low', undefined, 'windRig'));
  return {
    primary,
    details,
    height: baseH,
    windRig: { root, rotor, rateIndicator: energyRateIndicator.rig },
  };
}
