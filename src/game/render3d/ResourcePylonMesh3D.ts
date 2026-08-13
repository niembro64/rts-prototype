import * as THREE from 'three';
import { RESOURCE_COLOR_HEX } from '@/colorsConfig';
import { BUILDING_PALETTE } from './BuildingVisualPalette';
import { makeCylinder } from './BuildingMeshPrimitives3D';
import {
  createPrimitiveCylinderGeometry,
  getOrCreate,
  getSharedPrimitiveVertexDownTetrahedronGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

export type ResourcePylonResource = 'energy' | 'metal';
export type ResourcePylonDirection = 'inbound' | 'outbound';

export type ResourcePylonRig = {
  resource: ResourcePylonResource;
  direction: ResourcePylonDirection;
  rootLocal: THREE.Vector3;
  rootBaseLocal: THREE.Vector3;
  topLocal: THREE.Vector3;
  topBaseLocal: THREE.Vector3;
  sprayTravelSpeed: number;
  sprayParticleRadius: number;
  /** Bead radius inside the transparent pylon bore. */
  tubeBeadRadius: number;
  flowRadius: number;
  /** Half-angle in radians of the resource-flow cone. */
  coneAngle: number;
  channel: number;
  smoothedRate: number;
  displaySmoothedRate: number;
};

type ResourcePylonBuildOptions = {
  resource: ResourcePylonResource;
  direction: ResourcePylonDirection;
  pylonHeight: number;
  pylonBaseY: number;
  x: number;
  z: number;
  pylonRadius: number;
  sprayTravelSpeed: number;
  sprayParticleRadius: number;
  flowRadius: number;
  coneAngle: number;
  channel: number;
  geometryTier?: PrimitiveGeometryTier;
};

const strawCylinderGeomByTier = new Map<PrimitiveGeometryTier, THREE.CylinderGeometry>();

function getStrawCylinderGeom(tier: PrimitiveGeometryTier): THREE.CylinderGeometry {
  return getOrCreate(strawCylinderGeomByTier, tier, () =>
    createPrimitiveCylinderGeometry('unitDetail', tier, 0.5, 0.5, 1, 1, true));
}

const strawOuterMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.structureDark,
  transparent: true,
  opacity: 0.16,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const strawInnerMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.structureDark,
  transparent: true,
  opacity: 0.3,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const resourceCapMaterial: Record<ResourcePylonResource, THREE.Material> = {
  energy: new THREE.MeshLambertMaterial({ color: RESOURCE_COLOR_HEX.energy }),
  metal: new THREE.MeshLambertMaterial({ color: RESOURCE_COLOR_HEX.metal }),
};

const STRAW_BORE_FRAC = 0.6;
const STRAW_BEAD_FRAC = 0.4;

/** Shared mesh primitive for economy-resource endpoints. Construction work
 * uses host-owned work stations and does not mount resource pylons. */
export function buildResourcePylonRig(options: ResourcePylonBuildOptions): {
  staticMeshes: THREE.Mesh[];
  rig: ResourcePylonRig;
} {
  const geometryTier = options.geometryTier ?? 'close';
  const staticMeshes: THREE.Mesh[] = [];
  if (options.pylonRadius > 0) {
    for (const wall of makeStrawWalls(
      options.pylonRadius,
      options.pylonHeight,
      options.x,
      options.pylonBaseY + options.pylonHeight / 2,
      options.z,
      geometryTier,
    )) staticMeshes.push(wall);
    const cap = new THREE.Mesh(
      getSharedPrimitiveVertexDownTetrahedronGeometry(),
      resourceCapMaterial[options.resource],
    );
    cap.scale.setScalar(Math.max(1.6, options.pylonRadius * 1.45));
    cap.position.set(
      options.x,
      options.pylonBaseY + options.pylonHeight + Math.max(1, options.pylonRadius * 0.5),
      options.z,
    );
    staticMeshes.push(cap);
  }

  const capRadius = Math.max(1.6, options.pylonRadius * 1.45);
  const topLocal = new THREE.Vector3(
    options.x,
    options.pylonBaseY + options.pylonHeight + Math.max(1, options.pylonRadius * 0.5) + capRadius * 0.35,
    options.z,
  );
  const rootLocal = new THREE.Vector3(options.x, options.pylonBaseY, options.z);
  return {
    staticMeshes,
    rig: {
      resource: options.resource,
      direction: options.direction,
      rootLocal,
      rootBaseLocal: rootLocal.clone(),
      topLocal,
      topBaseLocal: topLocal.clone(),
      sprayTravelSpeed: options.sprayTravelSpeed,
      sprayParticleRadius: options.sprayParticleRadius,
      tubeBeadRadius: Math.max(0.5, options.pylonRadius * STRAW_BEAD_FRAC),
      flowRadius: options.flowRadius,
      coneAngle: options.coneAngle,
      channel: options.channel,
      smoothedRate: 0,
      displaySmoothedRate: 0,
    },
  };
}

export function disposeResourcePylonGeometries(): void {
  for (const geometry of strawCylinderGeomByTier.values()) geometry.dispose();
  strawCylinderGeomByTier.clear();
  strawOuterMat.dispose();
  strawInnerMat.dispose();
  resourceCapMaterial.energy.dispose();
  resourceCapMaterial.metal.dispose();
}

function makeStrawWalls(
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
  geometryTier: PrimitiveGeometryTier,
): THREE.Mesh[] {
  const geometry = getStrawCylinderGeom(geometryTier);
  return [
    makeCylinder(strawOuterMat, radius, height, x, y, z, geometry),
    makeCylinder(strawInnerMat, radius * STRAW_BORE_FRAC, height, x, y, z, geometry),
  ];
}
