import * as THREE from 'three';
import { WIND_BUILDING_VISUAL_HEIGHT } from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import type { ResourcePylonRig } from './ConstructionEmitterMesh3D';
import { buildResourcePylonRig } from './ConstructionEmitterMesh3D';
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
  makeTurbineBlade,
  windBladeMat,
  windGlassMat,
  windNacelleMat,
  windTowerMat,
  windTrimMat,
} from './BuildingMeshPrimitives3D';

/** Per-blade open/closed orientation pair. Animator slerps each blade
 *  between these as the wind turbine transitions in/out of its stowed
 *  pose. The pivot stays at the rotor hub — the blade tip swings from
 *  radial-fan to "tight against the pole" by reorienting the blade's
 *  spanwise (local Y) axis from in-plane to rotor-axis-aligned. */
export type WindBladeAnim = {
  openQuat: THREE.Quaternion;
  closedQuat: THREE.Quaternion;
};

export type WindTurbineRig = {
  root: THREE.Mesh;
  rotor: THREE.Mesh;
  pylon: ResourcePylonRig;
  /** Authored pitch applied to root.rotation.x at full close (1.0). */
  closedPitch: number;
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
  const energyPylon = buildResourcePylonRig({
    resource: 'energy',
    direction: 'inbound',
    pylonHeight: towerH,
    pylonBaseY: 0,
    x: 0,
    z: 0,
    pylonRadius: Math.max(1.8, towerRadius * 0.45),
    sprayTravelSpeed: 130,
    sprayParticleRadius: Math.max(1.2, towerRadius * 0.34),
    flowRadius: Math.max(42, towerH * 0.9),
    channel: 0,
  });
  for (const mesh of energyPylon.staticMeshes) {
    details.push(detail(mesh, 'low'));
  }

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
  const hub = makeCylinder(windNacelleMat, nacelleRadius * 1.56, bladeThickness * 1.6, 0, 0, 0);
  hub.rotation.x = Math.PI / 2;
  rotor.add(hub);

  const nose = makeCone(windNacelleMat, nacelleRadius * 0.74, nacelleRadius * 1.38, 0, 0, nacelleRadius * 0.5);
  nose.rotation.x = Math.PI / 2;
  rotor.add(nose);

  // Each blade is created at its open-pose rotation around the rotor's
  // Z axis (the spin axis). For the stowed pose we want all three blades
  // to point along rotor-local -Z so that, after the root pitches up
  // (rotor +Z → world +Y), they end up hanging straight down past the
  // top of the tower. The 3 blades share the same downward axis but
  // their chord widths point in different horizontal directions (120°
  // apart), so they don't actually z-fight — kept at exactly 0 to make
  // the closed pose read as "tight against the pole".
  const _stowRadialOffset = 0;
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const blade = makeTurbineBlade(windBladeMat, bladeLen, bladeW, bladeThickness, angle);
    const openQuat = blade.quaternion.clone();

    // Closed pose, blade-local basis in the rotor's frame:
    //   Y (spanwise) ≈ rotor-local -Z, with a small wedge toward the
    //     original radial out so the three blades fan very slightly
    //     and don't overlap exactly.
    //   X (chord width) = original radial direction in rotor XY plane
    //     so the blade's flat face still presents outward.
    //   Z = Y × X-equivalent, kept right-handed via cross product.
    const radialOpen = new THREE.Vector3(-Math.sin(angle), Math.cos(angle), 0);
    const closedY = new THREE.Vector3(
      radialOpen.x * _stowRadialOffset,
      radialOpen.y * _stowRadialOffset,
      -Math.sqrt(1 - _stowRadialOffset * _stowRadialOffset),
    ).normalize();
    const closedX = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
    const closedZ = new THREE.Vector3().crossVectors(closedX, closedY).normalize();
    // Re-orthogonalize X against Y (the radial offset slightly tilts
    // closedY out of the original X-Y plane, so re-derive X = Y × Z).
    closedX.copy(closedY).cross(closedZ).normalize();
    const closedBasis = new THREE.Matrix4().makeBasis(closedX, closedY, closedZ);
    const closedQuat = new THREE.Quaternion().setFromRotationMatrix(closedBasis);

    const anim: WindBladeAnim = { openQuat, closedQuat };
    blade.userData.windBlade = anim;
    rotor.add(blade);
  }

  details.push(detail(root, 'low', undefined, 'windRig'));
  return {
    primary,
    details,
    height: baseH,
    windRig: {
      root,
      rotor,
      pylon: energyPylon.rig,
      // Pitch the nacelle to point straight up. The root's open-pose
      // pitch is 0 (horizontal nacelle); -π/2 sends it skyward so the
      // rotor sits at the top of the tower with its face pointing up.
      closedPitch: -Math.PI / 2,
    },
  };
}
