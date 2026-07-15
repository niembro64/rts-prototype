// SwimRig3D — cetacean-style pectoral fins, dorsal fin, and horizontally
// paired tail flukes. This is a presentation rig only; the authoritative
// water propulsion/buoyancy profile lives in the `swim` locomotion preset.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { SwimConfig } from '@/types/blueprints';
import type { PlayerId } from '../sim/types';
import { getLocomotionMatByCache } from './RenderUtils';
import {
  type LocomotionBase,
  type LocomotionRenderPose,
  type RollingContactState,
  rollingContact,
  rollingLocomotionBodyActive,
  sampleRollingContactDistance,
} from './LocomotionRigShared3D';

const DEG_TO_RAD = Math.PI / 180;
const swimMaterials = new Map<number, THREE.MeshBasicMaterial>();
const panelGeometries = new Map<string, THREE.ExtrudeGeometry>();

export type SwimMesh = {
  type: 'swim';
  group: THREE.Group;
  pectoralHinges: [THREE.Group, THREE.Group];
  tailHinge: THREE.Group;
  contact: RollingContactState;
  cycleDistance: number;
  strokeAngle: number;
} & LocomotionBase;

function taperedPanelGeometry(tipToRootRatio: number): THREE.ExtrudeGeometry {
  const ratio = Math.max(0.08, Math.min(1, tipToRootRatio));
  const key = ratio.toFixed(4);
  let geometry = panelGeometries.get(key);
  if (geometry !== undefined) return geometry;
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(0.5, 0);
  shape.lineTo(ratio * 0.36, 1);
  shape.lineTo(ratio * -0.5, 1);
  shape.closePath();
  geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: false,
    steps: 1,
  });
  geometry.translate(0, 0, -0.5);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  panelGeometries.set(key, geometry);
  return geometry;
}

function dorsalGeometry(): THREE.ExtrudeGeometry {
  const key = 'dorsal';
  let geometry = panelGeometries.get(key);
  if (geometry !== undefined) return geometry;
  const shape = new THREE.Shape();
  shape.moveTo(-0.55, 0);
  shape.lineTo(0.45, 0);
  shape.lineTo(-0.2, 1);
  shape.closePath();
  geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: false,
    steps: 1,
  });
  geometry.translate(0, 0, -0.5);
  geometry.computeVertexNormals();
  panelGeometries.set(key, geometry);
  return geometry;
}

export function buildSwimRig(
  unitGroup: THREE.Group,
  radius: number,
  cfg: SwimConfig,
  ownerId: PlayerId | undefined,
): SwimMesh {
  const group = new THREE.Group();
  const material = getLocomotionMatByCache(
    swimMaterials,
    COLORS.units.locomotion.swim.fin.colorHex,
    ownerId,
  );
  const thickness = Math.max(0.25, radius * cfg.thicknessFrac);
  const pectoralRootChord = Math.max(0.5, radius * cfg.pectoralRootChordFrac);
  const pectoralTipChord = Math.max(0.25, radius * cfg.pectoralTipChordFrac);
  const pectoralSpan = Math.max(0.5, radius * cfg.pectoralSpanFrac);
  const pectoralGeometry = taperedPanelGeometry(pectoralTipChord / pectoralRootChord);
  const pectoralHinges: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];

  for (let index = 0; index < pectoralHinges.length; index++) {
    const side = index === 0 ? -1 : 1;
    const hinge = pectoralHinges[index];
    hinge.position.set(
      radius * cfg.pectoralOffsetXFrac,
      radius * cfg.pectoralHeightFrac,
      side * radius * cfg.pectoralLateralOffsetFrac,
    );
    const fin = new THREE.Mesh(pectoralGeometry, material);
    fin.scale.set(pectoralRootChord, thickness, side * pectoralSpan);
    hinge.add(fin);
    group.add(hinge);
  }

  const tailHinge = new THREE.Group();
  tailHinge.position.set(radius * cfg.tailOffsetXFrac, 0, 0);
  const tailGeometry = taperedPanelGeometry(0.32);
  for (const side of [-1, 1] as const) {
    const fluke = new THREE.Mesh(tailGeometry, material);
    fluke.scale.set(
      Math.max(0.5, radius * cfg.tailChordFrac),
      thickness,
      side * Math.max(0.5, radius * cfg.tailSpanFrac * 0.5),
    );
    tailHinge.add(fluke);
  }
  group.add(tailHinge);

  const dorsal = new THREE.Mesh(dorsalGeometry(), material);
  dorsal.position.set(radius * cfg.dorsalOffsetXFrac, 0, 0);
  dorsal.scale.set(
    Math.max(0.5, radius * cfg.dorsalChordFrac),
    Math.max(0.5, radius * cfg.dorsalHeightFrac),
    thickness,
  );
  group.add(dorsal);

  unitGroup.add(group);
  const mesh: SwimMesh = {
    type: 'swim',
    group,
    pectoralHinges,
    tailHinge,
    contact: rollingContact(0, 0),
    cycleDistance: Math.max(1, radius * cfg.cycleDistanceFrac),
    strokeAngle: cfg.strokeAngleDeg * DEG_TO_RAD,
    geometryKey: '',
  };
  poseSwimRigAtCycle(mesh, 0);
  return mesh;
}

export function updateSwimRig(
  mesh: SwimMesh,
  pose: LocomotionRenderPose,
  _dtMs: number,
): boolean {
  sampleRollingContactDistance(pose, mesh.contact);
  poseSwimRigAtCycle(mesh, mesh.contact.phase / mesh.cycleDistance * Math.PI * 2);
  return rollingLocomotionBodyActive(pose);
}

/** Deterministic pose helper shared by the loading preview. */
export function poseSwimRigAtCycle(mesh: SwimMesh, cycle: number): void {
  const stroke = Math.sin(cycle) * mesh.strokeAngle;
  // Orcas drive their horizontal flukes vertically, while pectoral fins
  // counter-phase subtly to keep the silhouette alive without looking avian.
  mesh.tailHinge.rotation.z = stroke;
  mesh.pectoralHinges[0].rotation.x = 0.08 - stroke * 0.22;
  mesh.pectoralHinges[1].rotation.x = -0.08 + stroke * 0.22;
}
