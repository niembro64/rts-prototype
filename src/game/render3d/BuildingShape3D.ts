// BuildingShape3D — per-type 3D geometry for player-built buildings.
//
// Each building type gets its own recognizable silhouette, built from a
// team-colored primary body plus LOD-tagged type-specific accents:
//
//   solar   — static pyramid-flower collector: a wide team-colored
//             pyramid base, four opened photovoltaic leaves, and a
//             dark photovoltaic inner pyramid.
//   wind    — tower turbine with a globally wind-aligned nacelle and
//             spinning three-blade rotor.
//   factory — compact radial construction tower. Produced units are
//             assembled outside the tower footprint by spray particles.
//   extractor — squat metal pump with a rotating top extractor head.
//   cannonTower — static defense tower with a heavy cannon mount.
//
// Shapes are additive — the caller owns a `THREE.Group` containing the
// whole building and plugs in the primary + detail meshes returned by
// `buildBuildingShape()`. Geometries and materials are shared per-team
// via the material cache that Render3DEntities already maintains, so no
// new allocation pressure.

import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import { COLORS, RESOURCE_COLOR_HEX } from '@/colorsConfig';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  RADAR_BUILDING_VISUAL_HEIGHT,
} from '../sim/blueprints';
import type { BuildingRenderProfile } from '../sim/types';
import {
  buildSolarCollector,
  disposeSolarCollectorGeoms,
  type SolarRig,
} from './SolarCollectorMesh3D';
import { CONSTRUCTION_HAZARD_COLORS } from '@/constructionVisualConfig';
import { buildWindTurbineMesh, type WindTurbineRig } from './WindTurbineMesh3D';
import {
  buildMetalExtractorMesh,
  disposeMetalExtractorMeshGeoms,
  type ExtractorRig,
} from './MetalExtractorMesh3D';
import {
  boxGeom,
  createHexFrustumGeometry,
  disposeBuildingMeshPrimitives,
  detail,
  hexCylinderGeom,
  invisibleMat,
  makeBox,
  makeCylinder,
  makeSphere,
} from './BuildingMeshPrimitives3D';
import { BUILDING_PALETTE } from './BuildingVisualPalette';
import {
  buildCannonTowerMesh,
  buildMegaBeamTowerMesh,
  disposeMegaBeamTowerMeshGeoms,
} from './MegaBeamTowerMesh3D';
import {
  buildFactoryMesh,
  disposeFactoryMeshGeoms,
  type FactoryBuildSpotRig,
} from './FactoryMesh3D';
import {
  buildResourcePylonRig,
  type ResourcePylonRig,
} from './ConstructionEmitterMesh3D';

export type { WindTurbineRig } from './WindTurbineMesh3D';
export type { ExtractorRig } from './MetalExtractorMesh3D';
export type { FactoryBuildSpotRig } from './FactoryMesh3D';

/** Short building types we have art for. Unknown types fall back to a
 *  plain primary-color slab (same as before). */
export type BuildingShapeType = BuildingRenderProfile;

export type BuildingDetailRole =
  | 'static'
  | 'solarLeaf'
  | 'solarPanel'
  | 'solarTeamAccent'
  | 'windRig'
  | 'extractorRotor'
  | 'radarRig'
  | 'factoryUnitGhost'
  | 'factoryUnitCore'
  | 'factorySpark'
  | 'factoryShower';

export type BuildingDetailMesh = {
  mesh: THREE.Mesh;
  minTier: ConcreteGraphicsQuality;
  maxTier?: ConcreteGraphicsQuality;
  role?: BuildingDetailRole;
};

/** What the caller receives back from `buildBuildingShape()`. */
export type BuildingShape = {
  /** Main body. Scaled per-instance at the call site to the building's
   *  (width, height, depth). Usually team-primary colored, except
   *  material-locked art such as the solar collector pyramid. */
  primary: THREE.Mesh;
  /** When true, Render3DEntities must not replace `primary.material`
   *  with a team material after ownership changes. */
  primaryMaterialLocked?: boolean;
  /** Decorative accent meshes already positioned relative to the primary
   *  body. Each declares the client LOD tier range where it should exist. */
  details: BuildingDetailMesh[];
  /** The building's render height so the caller can position the
   *  primary body correctly on the ground plane. */
  height: number;
  factoryBuildSpotRig?: FactoryBuildSpotRig;
  windRig?: WindTurbineRig;
  extractorRig?: ExtractorRig;
  solarRig?: SolarRig;
  radarRig?: RadarRig;
  converterRig?: ResourceConverterRig;
};

export type RadarRig = {
  head: THREE.Mesh;
  sweep: THREE.Mesh;
};

export type ResourceConverterRig = {
  energyPylon: ResourcePylonRig;
  metalPylon: ResourcePylonRig;
};

// ── Standard dimensions ────────────────────────────────────────────────
/** Default fallback block height for unknown buildings. */
const DEFAULT_HEIGHT = DEFAULT_BUILDING_VISUAL_HEIGHT;

const radarTowerGeom = createHexFrustumGeometry(0.055, 0.16);
const radarDishGeom = createRadarDishGeometry();
const radarRingGeom = new THREE.TorusGeometry(1, 0.055, 8, 36);
const radarFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const radarDarkMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });
const radarDishMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.radarDish.colorHex,
  metalness: COLORS.buildings.materials.radarDish.metalness,
  roughness: COLORS.buildings.materials.radarDish.roughness,
  side: THREE.DoubleSide,
});
const radarGlowMat = new THREE.MeshBasicMaterial({ color: BUILDING_PALETTE.cyanGlow });
const radarSweepMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlow,
  transparent: true,
  opacity: 0.72,
  depthWrite: false,
});

function shaderRgb(rgb: readonly [number, number, number]): string {
  return `vec3(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

const CONSTRUCTION_HAZARD_YELLOW_GLSL = shaderRgb(CONSTRUCTION_HAZARD_COLORS.yellowRgb);
const CONSTRUCTION_HAZARD_BLACK_GLSL = shaderRgb(CONSTRUCTION_HAZARD_COLORS.blackRgb);

const hazardStripeMat = new THREE.ShaderMaterial({
  vertexShader: `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,
  fragmentShader: `
varying vec3 vLocal;
void main() {
  float diagonal = fract((vLocal.x + vLocal.y * 0.72 + vLocal.z * 0.28) * 3.25);
  vec3 yellow = ${CONSTRUCTION_HAZARD_YELLOW_GLSL};
  vec3 black = ${CONSTRUCTION_HAZARD_BLACK_GLSL};
  gl_FragColor = vec4(diagonal < 0.5 ? yellow : black, 1.0);
}
`,
});

export function getConstructionHazardMaterial(): THREE.Material {
  return hazardStripeMat;
}

/** Build a type-specific building mesh set. `width` and `depth` are the
 *  building's footprint in world units (from `entity.building.width/height`);
 *  `primaryMat` is the team-colored MeshLambertMaterial the caller pulls
 *  from its per-player cache. */
export function buildBuildingShape(
  type: BuildingShapeType,
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  switch (type) {
    case 'solar':
      return buildSolarCollector(width, depth, primaryMat);
    case 'wind':
      return buildWindTurbineMesh(width, depth, primaryMat);
    case 'factory':
      return buildFactoryMesh(width, depth, primaryMat);
    case 'extractor':
      return buildMetalExtractorMesh(width, depth, primaryMat);
    case 'radar':
      return buildRadarMesh(width, depth, primaryMat);
    case 'megaBeamTower':
      return buildMegaBeamTowerMesh(primaryMat);
    case 'cannonTower':
      return buildCannonTowerMesh(primaryMat);
    case 'resourceConverter':
      return buildResourceConverterMesh(width, depth, primaryMat);
    case 'unknown':
      return buildUnknown(primaryMat);
    default:
      throw new Error(`Unhandled building shape type: ${type as string}`);
  }
}

/** Fallback — plain team-primary slab at default height, no detail. */
function buildUnknown(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  return { primary, details: [], height: DEFAULT_HEIGHT };
}

function buildRadarMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = RADAR_BUILDING_VISUAL_HEIGHT;
  const minDim = Math.min(width, depth);
  const primary = new THREE.Mesh(radarTowerGeom, primaryMat);
  const details: BuildingShape['details'] = [];

  const baseRadius = Math.max(30, minDim * 0.16);
  const baseH = Math.max(8, minDim * 0.08);
  details.push(detail(
    makeCylinder(radarDarkMat, baseRadius, baseH, 0, baseH / 2, 0, hexCylinderGeom),
    'min',
  ));
  details.push(detail(
    makeCylinder(radarFrameMat, baseRadius * 0.72, 4, 0, height * 0.38, 0, hexCylinderGeom),
    'low',
  ));
  details.push(detail(
    makeCylinder(radarFrameMat, baseRadius * 0.42, 5, 0, height * 0.78, 0, hexCylinderGeom),
    'low',
  ));

  const sweep = new THREE.Mesh(boxGeom, invisibleMat);
  sweep.position.set(0, height * 0.56, 0);
  const sweepRadius = Math.max(30, minDim * 0.1);
  const sweepRing = new THREE.Mesh(radarRingGeom, radarSweepMat);
  sweepRing.rotation.x = Math.PI / 2;
  sweepRing.scale.set(sweepRadius, sweepRadius, 4);
  sweep.add(sweepRing);
  sweep.add(makeBox(radarSweepMat, sweepRadius * 1.65, 1.4, 2.2, 0, 0, 0));
  sweep.add(makeBox(radarFrameMat, 2.2, 2.8, sweepRadius * 1.05, 0, 0, 0));
  sweep.add(makeSphere(radarGlowMat, 3.8, sweepRadius * 0.82, 0, 0));
  sweep.add(makeSphere(radarGlowMat, 3.8, -sweepRadius * 0.82, 0, 0));

  const head = new THREE.Mesh(boxGeom, invisibleMat);
  head.position.set(0, height * 0.9, 0);
  head.add(makeSphere(radarGlowMat, Math.max(5.5, minDim * 0.025), 0, 0, 0));
  head.add(makeCylinder(radarFrameMat, Math.max(5, minDim * 0.022), 8, 0, -6, 0, hexCylinderGeom));

  const dishPivot = new THREE.Mesh(boxGeom, invisibleMat);
  dishPivot.rotation.x = -0.58;
  dishPivot.position.set(0, 1, 0);
  const dishRadiusX = Math.max(36, minDim * 0.14);
  const dishRadiusY = dishRadiusX * 0.66;
  const dishDepth = Math.max(8, minDim * 0.04);
  const dish = new THREE.Mesh(radarDishGeom, radarDishMat);
  dish.scale.set(dishRadiusX, dishRadiusY, dishDepth);
  dishPivot.add(dish);

  const rim = new THREE.Mesh(radarRingGeom, radarFrameMat);
  rim.scale.set(dishRadiusX, dishRadiusY, 4);
  dishPivot.add(rim);

  const feedZ = Math.max(16, dishRadiusX * 0.36);
  dishPivot.add(makeSphere(radarGlowMat, Math.max(3.6, minDim * 0.045), 0, 0, feedZ));
  head.add(dishPivot);

  details.push(detail(sweep, 'low', undefined, 'radarRig'));
  details.push(detail(head, 'low', undefined, 'radarRig'));
  return {
    primary,
    height,
    details,
    radarRig: { head, sweep },
  };
}

function createRadarDishGeometry(
  radialSegments: number = 5,
  angularSegments: number = 28,
): THREE.BufferGeometry {
  const positions: number[] = [0, 0, -1];
  for (let r = 1; r <= radialSegments; r++) {
    const radius = r / radialSegments;
    const z = -1 + radius * radius;
    for (let a = 0; a < angularSegments; a++) {
      const angle = (a / angularSegments) * Math.PI * 2;
      positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z);
    }
  }

  const indices: number[] = [];
  const ringIndex = (ring: number, angle: number): number => (
    1 + (ring - 1) * angularSegments + (angle % angularSegments)
  );
  for (let a = 0; a < angularSegments; a++) {
    indices.push(0, ringIndex(1, a), ringIndex(1, a + 1));
  }
  for (let r = 2; r <= radialSegments; r++) {
    for (let a = 0; a < angularSegments; a++) {
      const a0 = ringIndex(r - 1, a);
      const a1 = ringIndex(r - 1, a + 1);
      const b0 = ringIndex(r, a);
      const b1 = ringIndex(r, a + 1);
      indices.push(a0, b0, b1, a0, b1, a1);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

// ── Resource converter ───────────────────────────────────────────────
// Squat hex platform with two perpendicular torus rings (energy + metal
// resource colors) cradling a central glow sphere. Reads at a glance as
// "transmutes one resource into the other."
const converterPlatformGeom = createHexFrustumGeometry(0.42, 0.5);
const converterRingGeom = new THREE.TorusGeometry(1, 0.075, 10, 32);
const converterFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const converterEnergyRingMat = new THREE.MeshStandardMaterial({
  color: RESOURCE_COLOR_HEX.energy,
  metalness: 0.4,
  roughness: 0.35,
  emissive: RESOURCE_COLOR_HEX.energy,
  emissiveIntensity: 0.35,
});
const converterMetalRingMat = new THREE.MeshStandardMaterial({
  color: RESOURCE_COLOR_HEX.metal,
  metalness: 0.6,
  roughness: 0.3,
  emissive: RESOURCE_COLOR_HEX.metal,
  emissiveIntensity: 0.2,
});
const converterCoreMat = new THREE.MeshBasicMaterial({ color: BUILDING_PALETTE.cyanGlow });

function buildResourceConverterMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = 60;
  const minDim = Math.min(width, depth);
  const primary = new THREE.Mesh(converterPlatformGeom, primaryMat);
  const details: BuildingShape['details'] = [];

  const ringRadius = Math.max(14, minDim * 0.32);
  const ringHeight = height * 0.62;
  const pylonBaseY = height * 0.18;
  const pylonHeight = Math.max(18, height * 0.5);
  const pylonRadius = Math.max(2.8, minDim * 0.045);
  const showerRadius = pylonRadius * 1.65;
  const pylonOffset = Math.max(ringRadius * 0.68, minDim * 0.2);

  const energyRing = new THREE.Mesh(converterRingGeom, converterEnergyRingMat);
  energyRing.scale.set(ringRadius, ringRadius, 1);
  energyRing.position.set(0, ringHeight, 0);
  energyRing.rotation.x = Math.PI / 2;
  details.push(detail(energyRing, 'low'));

  const metalRing = new THREE.Mesh(converterRingGeom, converterMetalRingMat);
  metalRing.scale.set(ringRadius * 0.86, ringRadius * 0.86, 1);
  metalRing.position.set(0, ringHeight, 0);
  metalRing.rotation.z = Math.PI / 2;
  details.push(detail(metalRing, 'low'));

  const coreRadius = Math.max(5, minDim * 0.09);
  details.push(detail(
    makeSphere(converterCoreMat, coreRadius, 0, ringHeight, 0),
    'min',
  ));

  const collarRadius = Math.max(8, minDim * 0.18);
  const collarH = Math.max(6, height * 0.12);
  details.push(detail(
    makeCylinder(converterFrameMat, collarRadius, collarH, 0, height * 0.36, 0, hexCylinderGeom),
    'low',
  ));

  const energyPylon = buildResourcePylonRig({
    resource: 'energy',
    direction: 'inbound',
    showerRadius,
    pylonHeight,
    pylonBaseY,
    x: -pylonOffset,
    z: 0,
    pylonRadius,
    sprayTravelSpeed: 120,
    sprayParticleRadius: Math.max(1.35, pylonRadius * 0.42),
    flowRadius: Math.max(34, pylonHeight * 1.25),
    channel: 0,
  });
  const metalPylon = buildResourcePylonRig({
    resource: 'metal',
    direction: 'outbound',
    showerRadius,
    pylonHeight,
    pylonBaseY,
    x: pylonOffset,
    z: 0,
    pylonRadius,
    sprayTravelSpeed: 120,
    sprayParticleRadius: Math.max(1.35, pylonRadius * 0.42),
    flowRadius: Math.max(34, pylonHeight * 1.25),
    channel: 1,
  });
  for (const mesh of energyPylon.staticMeshes) details.push(detail(mesh, 'low'));
  for (const mesh of metalPylon.staticMeshes) details.push(detail(mesh, 'low'));
  details.push(detail(energyPylon.rig.shower, 'low'));
  details.push(detail(metalPylon.rig.shower, 'low'));

  return {
    primary,
    details,
    height,
    converterRig: {
      energyPylon: energyPylon.rig,
      metalPylon: metalPylon.rig,
    },
  };
}

/** Tear down shared geometries + materials on renderer destroy. Callers
 *  (Render3DEntities.destroy) invoke once at app teardown. */
export function disposeBuildingGeoms(): void {
  disposeMegaBeamTowerMeshGeoms();
  disposeBuildingMeshPrimitives();
  disposeMetalExtractorMeshGeoms();
  disposeFactoryMeshGeoms();
  disposeSolarCollectorGeoms();
  radarTowerGeom.dispose();
  radarDishGeom.dispose();
  radarRingGeom.dispose();
  radarFrameMat.dispose();
  radarDarkMat.dispose();
  radarDishMat.dispose();
  radarGlowMat.dispose();
  radarSweepMat.dispose();
  hazardStripeMat.dispose();
  converterPlatformGeom.dispose();
  converterRingGeom.dispose();
  converterFrameMat.dispose();
  converterEnergyRingMat.dispose();
  converterMetalRingMat.dispose();
  converterCoreMat.dispose();
}
