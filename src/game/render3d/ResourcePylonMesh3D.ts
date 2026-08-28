import * as THREE from 'three';
import { RESOURCE_COLOR_HEX } from '@/colorsConfig';
import { BUILDING_PALETTE } from './BuildingVisualPalette';
import { makeBox, makeCone, makeCylinder } from './BuildingMeshPrimitives3D';
import {
  createPrimitiveCylinderGeometry,
  getOrCreate,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

export type ResourcePylonResource = 'energy' | 'metal';
export type ResourcePylonDirection = 'inbound' | 'outbound';

/** What sits on top of the mast where the pylon meets the world.
 *  - `collar`: a resource-coloured band capping the mast (extractor, converter).
 *  - `receiver`: the collar plus a sky-facing dish, for a host whose world
 *    source is above it (solar).
 *  - `none`: the host's own machine is the head (the wind nacelle rides the
 *    mast top), so the mast simply ends. */
type ResourcePylonHeadStyle = 'collar' | 'receiver' | 'none';

export type ResourcePylonRig = {
  resource: ResourcePylonResource;
  direction: ResourcePylonDirection;
  rootLocal: THREE.Vector3;
  rootBaseLocal: THREE.Vector3;
  topLocal: THREE.Vector3;
  topBaseLocal: THREE.Vector3;
  sprayTravelSpeed: number;
  sprayParticleRadius: number;
  /** Bead radius inside the mast bore. */
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
  head?: ResourcePylonHeadStyle;
};

const ringGeomByTier = new Map<PrimitiveGeometryTier, THREE.CylinderGeometry>();

function getRingGeom(tier: PrimitiveGeometryTier): THREE.CylinderGeometry {
  return getOrCreate(ringGeomByTier, tier, () =>
    createPrimitiveCylinderGeometry('unitDetail', tier, 0.5, 0.5, 1, 1, true));
}

const mastLegMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const mastRingMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.structureDark,
  side: THREE.DoubleSide,
});
const receiverDishMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const resourceCollarMaterial: Record<ResourcePylonResource, THREE.Material> = {
  energy: new THREE.MeshLambertMaterial({ color: RESOURCE_COLOR_HEX.energy }),
  metal: new THREE.MeshLambertMaterial({ color: RESOURCE_COLOR_HEX.metal }),
};

/** Three legs stand on a circle of this fraction of the pylon radius, so the
 *  mast's footprint is the authored radius while the bore between the legs
 *  stays open for the flow beads. */
const PYLON_MAST_LEG_COUNT = 3;
const MAST_LEG_CIRCLE_FRAC = 0.8;
const MAST_LEG_WIDTH_FRAC = 0.34;
const MAST_RING_RADIUS_FRAC = 1.05;
const MAST_RING_HEIGHT_FRAC = 0.28;
/** Rings are spaced about this many radii apart along the mast. */
const MAST_RING_PITCH_RADII = 3.2;
const MAST_RING_COUNT_MIN = 2;
const MAST_RING_COUNT_MAX = 6;
const COLLAR_RADIUS_FRAC = 1.5;
const COLLAR_HEIGHT_FRAC = 0.55;
const RECEIVER_RADIUS_FRAC = 2.2;
const RECEIVER_HEIGHT_FRAC = 1.1;
const BEAD_FRAC = 0.4;

/** How many rings a mast of this height carries. Deterministic from the
 *  host's authored dimensions, never from the geometry tier, because the
 *  detail list must be identical across tiers. */
function pylonMastRingCount(pylonHeight: number, pylonRadius: number): number {
  const pitch = Math.max(1, pylonRadius * MAST_RING_PITCH_RADII);
  return Math.max(MAST_RING_COUNT_MIN, Math.min(MAST_RING_COUNT_MAX, Math.round(pylonHeight / pitch)));
}

/** Shared mesh primitive for economy-resource endpoints. Construction work
 *  uses host-owned work stations and does not mount resource pylons.
 *
 *  The pylon is a conduit — root, tube, head — and this is its one visual
 *  vocabulary. The tube is an open lattice mast: three opaque legs and a few
 *  dark rings, solid structure that still leaves the bore visible for the
 *  flow beads riding it. The head is where the pylon meets the world and is
 *  chosen per host (`head`). `shaftMeshes` are the legs (they collapse along
 *  the mast in a host's closed pose); `headMeshes` are rings and head parts
 *  (they ride the mast and shrink). `staticMeshes` is both, in order. */
export function buildResourcePylonRig(options: ResourcePylonBuildOptions): {
  staticMeshes: THREE.Mesh[];
  shaftMeshes: THREE.Mesh[];
  headMeshes: THREE.Mesh[];
  rig: ResourcePylonRig;
} {
  const geometryTier = options.geometryTier ?? 'close';
  const head = options.head ?? 'collar';
  const shaftMeshes: THREE.Mesh[] = [];
  const headMeshes: THREE.Mesh[] = [];
  const radius = options.pylonRadius;
  const mastTopY = options.pylonBaseY + options.pylonHeight;
  let topY = mastTopY;
  if (radius > 0) {
    const legWidth = Math.max(0.9, radius * MAST_LEG_WIDTH_FRAC);
    const legCircle = radius * MAST_LEG_CIRCLE_FRAC;
    for (let i = 0; i < PYLON_MAST_LEG_COUNT; i++) {
      const angle = Math.PI / 2 + (i / PYLON_MAST_LEG_COUNT) * Math.PI * 2;
      shaftMeshes.push(makeBox(
        mastLegMat,
        legWidth,
        options.pylonHeight,
        legWidth,
        options.x + Math.cos(angle) * legCircle,
        options.pylonBaseY + options.pylonHeight * 0.5,
        options.z + Math.sin(angle) * legCircle,
      ));
    }
    const ringCount = pylonMastRingCount(options.pylonHeight, radius);
    const ringHeight = Math.max(0.6, radius * MAST_RING_HEIGHT_FRAC);
    for (let i = 0; i < ringCount; i++) {
      headMeshes.push(makeCylinder(
        mastRingMat,
        radius * MAST_RING_RADIUS_FRAC,
        ringHeight,
        options.x,
        options.pylonBaseY + options.pylonHeight * ((i + 0.5) / ringCount),
        options.z,
        getRingGeom(geometryTier),
      ));
    }
    if (head !== 'none') {
      const collarHeight = Math.max(1.2, radius * COLLAR_HEIGHT_FRAC);
      headMeshes.push(makeCylinder(
        resourceCollarMaterial[options.resource],
        radius * COLLAR_RADIUS_FRAC,
        collarHeight,
        options.x,
        mastTopY + collarHeight * 0.5,
        options.z,
      ));
      topY = mastTopY + collarHeight;
      if (head === 'receiver') {
        // A dish opening to the sky: an inverted cone whose apex sits on the
        // collar, so what falls from above lands in the pylon's mouth.
        const dishHeight = Math.max(1.4, radius * RECEIVER_HEIGHT_FRAC);
        const dish = makeCone(
          receiverDishMat,
          radius * RECEIVER_RADIUS_FRAC,
          dishHeight,
          options.x,
          topY + dishHeight * 0.5,
          options.z,
        );
        dish.rotation.x = Math.PI;
        headMeshes.push(dish);
        topY += dishHeight;
      }
    }
  }

  const topLocal = new THREE.Vector3(options.x, topY, options.z);
  const rootLocal = new THREE.Vector3(options.x, options.pylonBaseY, options.z);
  return {
    staticMeshes: [...shaftMeshes, ...headMeshes],
    shaftMeshes,
    headMeshes,
    rig: {
      resource: options.resource,
      direction: options.direction,
      rootLocal,
      rootBaseLocal: rootLocal.clone(),
      topLocal,
      topBaseLocal: topLocal.clone(),
      sprayTravelSpeed: options.sprayTravelSpeed,
      sprayParticleRadius: options.sprayParticleRadius,
      tubeBeadRadius: Math.max(0.5, radius * BEAD_FRAC),
      flowRadius: options.flowRadius,
      coneAngle: options.coneAngle,
      channel: options.channel,
      smoothedRate: 0,
      displaySmoothedRate: 0,
    },
  };
}

export function disposeResourcePylonGeometries(): void {
  for (const geometry of ringGeomByTier.values()) geometry.dispose();
  ringGeomByTier.clear();
  mastLegMat.dispose();
  mastRingMat.dispose();
  receiverDishMat.dispose();
  resourceCollarMaterial.energy.dispose();
  resourceCollarMaterial.metal.dispose();
}
