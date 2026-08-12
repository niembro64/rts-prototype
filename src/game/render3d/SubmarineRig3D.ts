// SubmarineRig3D — two pectoral control fins and a rear ducted propulsor. This is
// a presentation rig only; the authoritative water propulsion/lift profile
// lives in the `submarine` locomotion preset.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { SubmarineConfig } from '@/types/blueprints';
import type { PlayerId } from '../sim/types';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import {
  appendDroneFanSmoke,
  buildRearPropulsionFan,
  type DroneFan,
} from './DroneRig3D';
import { getLocomotionMatByCache } from './RenderUtils';
import {
  type LocomotionBase,
  type LocomotionRenderPose,
  type RollingContactState,
  rollingContact,
  rollingLocomotionBodyActive,
  sampleRollingContactDistance,
} from './LocomotionRigShared3D';
import type { SmokePuffEmitter } from './SmokeTrail3D';

const DEG_TO_RAD = Math.PI / 180;
const submarineMaterials = new Map<number, THREE.MeshLambertMaterial>();
const panelGeometries = new Map<string, THREE.BufferGeometry>();

export type SubmarineMesh = {
  type: 'submarine';
  group: THREE.Group;
  pectoralHinges: [THREE.Group, THREE.Group];
  rearFan: DroneFan;
  contact: RollingContactState;
  cycleDistance: number;
  strokeAngle: number;
} & LocomotionBase;

function taperedPanelGeometry(
  tipToRootRatio: number,
  tier: PrimitiveGeometryTier,
): THREE.BufferGeometry {
  const ratio = Math.max(0.08, Math.min(1, tipToRootRatio));
  const key = `${tier}:${ratio.toFixed(4)}`;
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

export function buildSubmarineRig(
  unitGroup: THREE.Group,
  radius: number,
  cfg: SubmarineConfig,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
  entityId = 0,
): SubmarineMesh {
  const group = new THREE.Group();
  const material = getLocomotionMatByCache(
    submarineMaterials,
    COLORS.units.locomotion.submarine.fin.colorHex,
    ownerId,
  );
  const thickness = Math.max(0.25, radius * cfg.thicknessFrac);
  const pectoralRootChord = Math.max(0.5, radius * cfg.pectoralRootChordFrac);
  const pectoralTipChord = Math.max(0.25, radius * cfg.pectoralTipChordFrac);
  const pectoralSpan = Math.max(0.5, radius * cfg.pectoralSpanFrac);
  const pectoralGeometry = taperedPanelGeometry(
    pectoralTipChord / pectoralRootChord,
    geometryTier,
  );
  const pectoralHinges: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];

  // One authored mount per fin. The pair used to share a single lateral
  // scalar reflected by index, so neither fin could be moved on its own.
  for (let index = 0; index < pectoralHinges.length; index++) {
    const offset = cfg.pectorals[index].offset;
    const side = offset.yUnitRadiusRatio < 0 ? -1 : 1;
    const hinge = pectoralHinges[index];
    hinge.position.set(
      radius * offset.xUnitRadiusRatio,
      radius * offset.zUnitRadiusRatio,
      radius * offset.yUnitRadiusRatio,
    );
    const fin = new THREE.Mesh(pectoralGeometry, material);
    fin.scale.set(pectoralRootChord, thickness, side * pectoralSpan);
    hinge.add(fin);
    group.add(hinge);
  }

  const rearFan = buildRearPropulsionFan(
    group, radius, cfg.rearFan, entityId, ownerId, geometryTier,
  );

  unitGroup.add(group);
  const mesh: SubmarineMesh = {
    type: 'submarine',
    group,
    pectoralHinges,
    rearFan,
    contact: rollingContact(0, 0),
    cycleDistance: Math.max(1, radius * cfg.cycleDistanceFrac),
    strokeAngle: cfg.strokeAngleDeg * DEG_TO_RAD,
    geometryKey: '',
  };
  poseSubmarineRigAtCycle(mesh, 0);
  return mesh;
}

export function updateSubmarineRig(
  mesh: SubmarineMesh,
  pose: LocomotionRenderPose,
  _dtMs: number,
  smokeOut?: SmokePuffEmitter[],
): boolean {
  sampleRollingContactDistance(pose, mesh.contact);
  poseSubmarineRigAtCycle(mesh, mesh.contact.phase / mesh.cycleDistance * Math.PI * 2);
  const active = rollingLocomotionBodyActive(pose);
  if (active && smokeOut) appendDroneFanSmoke(mesh.rearFan, smokeOut);
  return active;
}

/** Deterministic pose helper shared by the loading preview. */
export function poseSubmarineRigAtCycle(mesh: SubmarineMesh, cycle: number): void {
  const stroke = Math.sin(cycle) * mesh.strokeAngle;
  // The two forward control fins counter-phase subtly while the fixed rear
  // fan supplies the propulsive visual.
  mesh.pectoralHinges[0].rotation.x = 0.08 - stroke * 0.22;
  mesh.pectoralHinges[1].rotation.x = -0.08 + stroke * 0.22;
}
