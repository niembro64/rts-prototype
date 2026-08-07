// FlipperRig3D — four single-hinge hydrofoils. The same rigid panel is
// a short, leg-like support on land and unfolds into a wing/paddle in
// water. There are deliberately no knees, feet, or per-panel physics:
// locomotion physics stays in the flippers preset while this rig reads
// only the canonical rendered body pose and physical submerged fraction.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { FlipperConfig } from '@/types/blueprints';
import { lerp, smoothstep01 } from '../math';
import type { PlayerId } from '../sim/types';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';
import { getLocomotionMatByCache } from './RenderUtils';
import {
  type LocomotionBase,
  type LocomotionRenderPose,
  type RollingContactState,
  emaAlpha,
  rollingContact,
  rollingLocomotionBodyActive,
  sampleRollingContactDistance,
} from './LocomotionRigShared3D';

const DEG_TO_RAD = Math.PI / 180;
const WATER_BLEND_TAU_SEC = 0.18;
const WATER_NEUTRAL_DIHEDRAL_DEG = 7;
const WATER_SWEEP_DEG = 8;
const FLIPPER_BLEND_SETTLED_EPSILON = 0.002;

const flipperMaterials = new Map<number, THREE.MeshLambertMaterial>();
const flipperGeometries = new Map<string, THREE.BufferGeometry>();

type FlipperPanel = {
  hinge: THREE.Group;
  side: -1 | 1;
  front: boolean;
  phaseOffset: number;
  groundDownAngle: number;
};

export type FlipperMesh = {
  type: 'flippers';
  group: THREE.Group;
  panels: FlipperPanel[];
  contact: RollingContactState;
  waterBlend: number;
  cycleDistance: number;
  groundSweepAngle: number;
  waterStrokeAngle: number;
} & LocomotionBase;

function flipperGeometry(
  tipToRootRatio: number,
  tier: PrimitiveGeometryTier,
): THREE.BufferGeometry {
  const ratio = Math.max(0.1, Math.min(1, tipToRootRatio));
  const key = `${tier}:${ratio.toFixed(4)}`;
  let geometry = flipperGeometries.get(key);
  if (geometry) return geometry;

  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(0.5, 0);
  shape.lineTo(ratio * 0.5, 1);
  shape.lineTo(ratio * -0.5, 1);
  shape.closePath();
  geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 1,
    bevelEnabled: false,
    steps: 1,
  });
  // Shape Y becomes panel span Z; extrusion is centered into thickness Y.
  geometry.translate(0, 0, -0.5);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  flipperGeometries.set(key, geometry);
  return geometry;
}

export function buildFlippers(
  unitGroup: THREE.Group,
  radius: number,
  cfg: FlipperConfig,
  ownerId: PlayerId | undefined,
  geometryTier: PrimitiveGeometryTier = 'close',
): FlipperMesh {
  const group = new THREE.Group();
  const panels: FlipperPanel[] = [];
  const rootChord = Math.max(0.5, radius * cfg.rootChordFrac);
  const tipChord = Math.max(0.25, radius * cfg.tipChordFrac);
  const thickness = Math.max(0.35, radius * cfg.thicknessFrac);
  const geometry = flipperGeometry(tipChord / rootChord, geometryTier);
  const material = getLocomotionMatByCache(
    flipperMaterials,
    COLORS.units.locomotion.flipper.panel.colorHex,
    ownerId,
  );

  // One authored mount per panel. The four corners used to be derived from a
  // front/rear x pair crossed with a single lateral scalar, so every panel
  // shared one shoulder height and no panel could be moved on its own.
  for (const mount of cfg.mounts) {
    const offset = mount.offset;
    const side: -1 | 1 = offset.yUnitRadiusRatio < 0 ? -1 : 1;
    // Which end of the body a panel hangs off is a property of where it IS,
    // not a separate flag: the gait reads it back off the mount.
    const front = offset.xUnitRadiusRatio >= 0;
    const length = radius * mount.lengthFrac;
    const hinge = new THREE.Group();
    hinge.position.set(
      radius * offset.xUnitRadiusRatio,
      radius * offset.zUnitRadiusRatio,
      radius * offset.yUnitRadiusRatio,
    );
    const panel = new THREE.Mesh(geometry, material);
    panel.scale.set(rootChord, thickness, side * length);
    hinge.add(panel);
    group.add(hinge);

    // Front-left + rear-right move together; the opposite diagonal
    // receives π. This preserves a leg-like diagonal gait on land.
    const phaseOffset = (front ? 0 : Math.PI) + (side === 1 ? Math.PI : 0);
    const authoredDown = Math.max(0, cfg.groundDownAngleDeg * DEG_TO_RAD);
    const groundDownAngle = Math.min(
      authoredDown,
      Math.asin(Math.min(
        1,
        offset.zUnitRadiusRatio / Math.max(0.001, mount.lengthFrac),
      )),
    );
    panels.push({ hinge, side, front, phaseOffset, groundDownAngle });
  }

  unitGroup.add(group);
  return {
    type: 'flippers',
    group,
    panels,
    contact: rollingContact(0, 0),
    waterBlend: 0,
    cycleDistance: Math.max(1, radius * cfg.cycleDistanceFrac),
    groundSweepAngle: cfg.groundSweepAngleDeg * DEG_TO_RAD,
    waterStrokeAngle: cfg.waterStrokeAngleDeg * DEG_TO_RAD,
    geometryKey: '',
  };
}

export function updateFlippers(
  mesh: FlipperMesh,
  pose: LocomotionRenderPose,
  dtMs: number,
): boolean {
  sampleRollingContactDistance(pose, mesh.contact);
  const waterTarget = smoothstep01(pose.waterFraction);
  const blendAlpha = emaAlpha(Math.max(0, dtMs) / 1000, WATER_BLEND_TAU_SEC);
  mesh.waterBlend += (waterTarget - mesh.waterBlend) * blendAlpha;

  const cycle = mesh.contact.phase / mesh.cycleDistance * Math.PI * 2;
  poseFlippersAtCycle(mesh, cycle, mesh.waterBlend);

  return (
    rollingLocomotionBodyActive(pose) ||
    Math.abs(waterTarget - mesh.waterBlend) > FLIPPER_BLEND_SETTLED_EPSILON
  );
}

/** Deterministic pose helper shared with the loading preview. */
export function poseFlippersAtCycle(
  mesh: FlipperMesh,
  cycle: number,
  waterBlend: number,
): void {
  const blend = Math.max(0, Math.min(1, waterBlend));
  const waterNeutral = WATER_NEUTRAL_DIHEDRAL_DEG * DEG_TO_RAD;
  const waterSweep = WATER_SWEEP_DEG * DEG_TO_RAD;
  for (const panel of mesh.panels) {
    const swing = Math.sin(cycle + panel.phaseOffset);
    const groundDown = panel.side * panel.groundDownAngle;
    const groundSweep = panel.side * mesh.groundSweepAngle * swing;
    const waterDown = panel.side * (waterNeutral + mesh.waterStrokeAngle * swing);
    const waterSweepAngle = panel.side * waterSweep * (panel.front ? -1 : 1);
    panel.hinge.rotation.x = lerp(groundDown, waterDown, blend);
    panel.hinge.rotation.y = lerp(groundSweep, waterSweepAngle, blend);
  }
}
