// SwimRig3D — two pectoral control fins and a rear ducted propulsor. This is
// a presentation rig only; the authoritative water propulsion/lift profile
// lives in the `submarine` locomotion preset.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { SwimConfig } from '@/types/blueprints';
import type { PlayerId } from '../sim/types';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import {
  appendHoverFanSmoke,
  buildRearPropulsionFan,
  type HoverFan,
} from './HoverRig3D';
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
const swimMaterials = new Map<number, THREE.MeshBasicMaterial>();
const panelGeometries = new Map<string, THREE.BufferGeometry>();

export type SwimMesh = {
  type: 'swim';
  group: THREE.Group;
  pectoralHinges: [THREE.Group, THREE.Group];
  rearFan: HoverFan;
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
  geometry = tier === 'far'
    ? new THREE.ShapeGeometry(shape)
    : new THREE.ExtrudeGeometry(shape, {
      depth: 1,
      bevelEnabled: tier === 'close',
      bevelSegments: tier === 'close' ? 1 : 0,
      bevelSize: tier === 'close' ? 0.03 : 0,
      bevelThickness: tier === 'close' ? 0.05 : 0,
      steps: 1,
    });
  if (tier !== 'far') geometry.translate(0, 0, -0.5);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  panelGeometries.set(key, geometry);
  return geometry;
}

export function buildSwimRig(
  unitGroup: THREE.Group,
  radius: number,
  cfg: SwimConfig,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
  entityId = 0,
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
  const pectoralGeometry = taperedPanelGeometry(
    pectoralTipChord / pectoralRootChord,
    geometryTier,
  );
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

  const rearFan = buildRearPropulsionFan(
    group, radius, cfg, entityId, ownerId, geometryTier,
  );

  unitGroup.add(group);
  const mesh: SwimMesh = {
    type: 'swim',
    group,
    pectoralHinges,
    rearFan,
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
  smokeOut?: SmokePuffEmitter[],
): boolean {
  sampleRollingContactDistance(pose, mesh.contact);
  poseSwimRigAtCycle(mesh, mesh.contact.phase / mesh.cycleDistance * Math.PI * 2);
  const active = rollingLocomotionBodyActive(pose);
  if (active && smokeOut) appendHoverFanSmoke(mesh.rearFan, smokeOut);
  return active;
}

/** Deterministic pose helper shared by the loading preview. */
export function poseSwimRigAtCycle(mesh: SwimMesh, cycle: number): void {
  const stroke = Math.sin(cycle) * mesh.strokeAngle;
  // The two forward control fins counter-phase subtly while the fixed rear
  // fan supplies the propulsive visual.
  mesh.pectoralHinges[0].rotation.x = 0.08 - stroke * 0.22;
  mesh.pectoralHinges[1].rotation.x = -0.08 + stroke * 0.22;
}
