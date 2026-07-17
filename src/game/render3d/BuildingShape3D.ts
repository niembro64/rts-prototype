// BuildingShape3D — per-type 3D geometry for player-built buildings.
//
// Each building blueprint gets its own recognizable silhouette, built from a
// team-colored primary body plus type-specific accents:
//
//   solar   — static pyramid-flower collector: a wide team-colored
//             pyramid base, four opened photovoltaic leaves, and a
//             dark photovoltaic inner pyramid.
//   wind    — tower turbine with a globally wind-aligned nacelle and
//             spinning three-blade rotor.
//   factory — wide radial construction platform. Produced units are
//             assembled above the platform center by spray particles.
//   extractor — squat metal pump with a rotating top extractor head.
//   towerCannon — static defense tower with a heavy cannon mount.
//   towerAntiAir — compact missile tower with a fast launcher mount.
//
// Shapes are additive — the caller owns a `THREE.Group` containing the
// whole building and plugs in the primary + detail meshes returned by
// `buildBuildingShape()`. Geometries and materials are shared per-team
// via the material cache that Render3DEntities already maintains, so no
// new allocation pressure.

import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
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
  getActiveBuildingGeometryTier,
  hexCylinderGeom,
  invisibleMat,
  makeBox,
  makeCylinder,
  makeSphere,
  withBuildingGeometryTier,
} from './BuildingMeshPrimitives3D';
import { BUILDING_PALETTE } from './BuildingVisualPalette';
import {
  buildAntiAirTowerMesh,
  buildCannonTowerMesh,
  buildMegaBeamTowerMesh,
  disposeMegaBeamTowerMeshGeoms,
} from './MegaBeamTowerMesh3D';
import {
  buildFactoryMesh,
  disposeFactoryMeshGeoms,
} from './FactoryMesh3D';
import {
  buildResourcePylonRig,
  type ResourcePylonRig,
} from './ConstructionEmitterMesh3D';
import { PYLON_BUILDING_RESOURCE_CONVERTER_CONE_HALF_ANGLE_RAD } from '@/resourceConfig';
import type { StructureBlueprintId } from '@/types/blueprintIds';
import {
  createPrimitiveRingGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

export type { WindTurbineRig } from './WindTurbineMesh3D';
export type { ExtractorRig } from './MetalExtractorMesh3D';

/** Short building blueprints we have art for. Unknown types fall back to a
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
  | 'tinyTrim';

export type BuildingDetailMesh = {
  mesh: THREE.Mesh;
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
  /** When true, this host renders no body shell. The `primary` mesh is
   *  still returned (callers index `chassisMeshes[0]`) but the renderer
   *  keeps it hidden and unscaled. */
  bodyless?: boolean;
  /** Decorative accent meshes already positioned relative to the primary
   *  body. */
  details: BuildingDetailMesh[];
  /** The building's render height so the caller can position the
   *  primary body correctly on the ground plane. */
  height: number;
  isFactoryConstructionHost?: boolean;
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
const radarDishGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const radarRingGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();

function getRadarDishGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  let geometry = radarDishGeomByTier.get(tier);
  if (geometry === undefined) {
    geometry = tier === 'close'
      ? createRadarDishGeometry(4, 24)
      : tier === 'mid'
        ? createRadarDishGeometry(3, 14)
        : createRadarDishGeometry(1, 6);
    radarDishGeomByTier.set(tier, geometry);
  }
  return geometry;
}

function getRadarRingGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  let geometry = radarRingGeomByTier.get(tier);
  if (geometry === undefined) {
    // A dish rim is a thin visible face, not a pipe. RingGeometry preserves
    // the exact circular outline without submitting the torus's hidden inner
    // and outer walls (which used to dominate Radar even at Medium).
    geometry = createPrimitiveRingGeometry('building', tier, 0.945, 1.055);
    radarRingGeomByTier.set(tier, geometry);
  }
  return geometry;
}
const radarFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const radarDarkMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });
const radarDishMat = new THREE.MeshStandardMaterial({
  color: COLORS.buildings.materials.radarDish.colorHex,
  metalness: COLORS.buildings.materials.radarDish.metalness,
  roughness: COLORS.buildings.materials.radarDish.roughness,
  side: THREE.DoubleSide,
});
const radarSweepMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlow,
  transparent: true,
  opacity: 0.28,
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
  buildingBlueprintId?: StructureBlueprintId | null,
  geometryTier: PrimitiveGeometryTier = 'close',
): BuildingShape {
  return withBuildingGeometryTier(geometryTier, () => {
    switch (type) {
      case 'buildingSolar':
        return buildSolarCollector(width, depth, primaryMat);
      case 'buildingWind':
        return buildWindTurbineMesh(width, depth, primaryMat);
      case 'towerFabricator':
        return buildFactoryMesh(width, depth, primaryMat);
      case 'buildingExtractor':
        return buildMetalExtractorMesh(
          width,
          depth,
          primaryMat,
          buildingBlueprintId === 'buildingExtractorT2' ? 'advanced' : 'standard',
        );
      case 'buildingRadar':
        return buildRadarMesh(width, depth, primaryMat);
      case 'towerBeamMega':
        return buildMegaBeamTowerMesh(primaryMat);
      case 'towerCannon':
        return buildCannonTowerMesh(primaryMat);
      case 'towerAntiAir':
        return buildAntiAirTowerMesh(primaryMat);
      case 'buildingResourceConverter':
        return buildResourceConverterMesh(width, depth, primaryMat);
      case 'unknown':
        return buildUnknown(primaryMat);
      case 'bodyless':
        return buildBodyless(primaryMat);
      default:
        throw new Error(`Unhandled building shape type: ${type as string}`);
    }
  });
}

/** Fallback — plain team-primary slab at default height, no detail. */
function buildUnknown(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  return { primary, details: [], height: DEFAULT_HEIGHT };
}

/** No body shell — only the host's mounted turrets render. The primary
 *  mesh is created (callers expect `chassisMeshes[0]`) but flagged
 *  bodyless so the renderer never shows or scales it. Height 0 keeps any
 *  base-from-footprint math at the ground plane. */
function buildBodyless(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  primary.visible = false;
  return { primary, details: [], height: 0, bodyless: true };
}

function buildRadarMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = RADAR_BUILDING_VISUAL_HEIGHT;
  const geometryTier = getActiveBuildingGeometryTier();
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
  sweep.position.set(0, height * 0.52, 0);
  const sweepRadius = Math.max(24, minDim * 0.08);
  const sweepRing = new THREE.Mesh(getRadarRingGeometry(geometryTier), radarSweepMat);
  sweepRing.rotation.x = Math.PI / 2;
  sweepRing.scale.set(sweepRadius, sweepRadius, 4);
  sweep.add(sweepRing);
  sweep.add(makeBox(radarSweepMat, sweepRadius * 1.35, 0.8, 1.4, 0, 0, 0));
  sweep.add(makeBox(radarFrameMat, 1.8, 2.2, sweepRadius * 0.8, 0, 0, 0));

  const head = new THREE.Mesh(boxGeom, invisibleMat);
  head.position.set(0, height * 0.9, 0);
  head.add(makeSphere(radarDarkMat, Math.max(5.5, minDim * 0.025), 0, 0, 0));
  head.add(makeCylinder(radarFrameMat, Math.max(5, minDim * 0.022), 8, 0, -6, 0, hexCylinderGeom));

  const dishPivot = new THREE.Mesh(boxGeom, invisibleMat);
  dishPivot.rotation.x = -0.42;
  dishPivot.position.set(0, 1, 0);
  const dishRadiusX = Math.max(30, minDim * 0.12);
  const dishRadiusY = dishRadiusX * 0.58;
  const dishDepth = Math.max(6, minDim * 0.032);
  const dish = new THREE.Mesh(getRadarDishGeometry(geometryTier), radarDishMat);
  dish.scale.set(dishRadiusX, dishRadiusY, dishDepth);
  dishPivot.add(dish);

  const rim = new THREE.Mesh(getRadarRingGeometry(geometryTier), radarFrameMat);
  rim.scale.set(dishRadiusX, dishRadiusY, 4);
  dishPivot.add(rim);

  const feedZ = Math.max(14, dishRadiusX * 0.36);
  dishPivot.add(makeBox(radarFrameMat, dishRadiusX * 0.08, dishRadiusX * 0.08, feedZ, 0, 0, feedZ * 0.5));
  dishPivot.add(makeSphere(radarDarkMat, Math.max(2.8, minDim * 0.028), 0, 0, feedZ));
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
// Rooftop pylon machine. The converter has no decorative resource loops:
// conversion direction and magnitude are carried by the mounted pylons and
// their resource-ball flows.
const converterPlatformGeom = createHexFrustumGeometry(0.42, 0.5);
const converterFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const converterDarkMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });
const converterTrimMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.structureLight,
  metalness: 0.55,
  roughness: 0.35,
});
const converterStatusMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlass,
  transparent: true,
  opacity: 0.58,
  depthWrite: false,
});

function buildResourceConverterMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = 42;
  const minDim = Math.min(width, depth);
  const primary = new THREE.Mesh(converterPlatformGeom, primaryMat);
  const details: BuildingShape['details'] = [];

  const deckRadius = Math.max(18, minDim * 0.34);
  const deckH = Math.max(5, minDim * 0.085);
  const deckY = height + deckH * 0.42;
  const serviceH = Math.max(10, minDim * 0.18);
  const serviceW = Math.max(22, minDim * 0.42);
  const serviceD = Math.max(12, minDim * 0.22);
  const pylonBaseY = height + Math.max(13, minDim * 0.22);
  const pylonHeight = Math.max(28, minDim * 0.5);
  const pylonRadius = Math.max(3.8, minDim * 0.065);
  const pylonOffset = Math.max(15, minDim * 0.28);

  details.push(detail(
    makeCylinder(converterDarkMat, deckRadius, deckH, 0, deckY, 0, hexCylinderGeom),
    'low',
  ));
  details.push(detail(
    makeCylinder(converterFrameMat, deckRadius * 0.72, Math.max(4, deckH * 0.72), 0, deckY + deckH * 0.72, 0, hexCylinderGeom),
    'low',
  ));

  const serviceY = height + deckH + serviceH * 0.34;
  details.push(detail(
    makeBox(converterDarkMat, serviceW, serviceH, serviceD, 0, serviceY, 0),
    'low',
  ));
  details.push(detail(
    makeBox(converterTrimMat, serviceW * 0.86, Math.max(3, serviceH * 0.24), serviceD * 1.12, 0, serviceY + serviceH * 0.36, 0),
    'low',
  ));
  details.push(detail(
    makeBox(converterStatusMat, serviceW * 0.72, Math.max(1.6, serviceH * 0.14), serviceD * 1.2, 0, serviceY + serviceH * 0.18, 0),
    'low',
  ));

  const heatSinkW = Math.max(4, minDim * 0.07);
  const heatSinkH = Math.max(10, minDim * 0.18);
  const heatSinkD = Math.max(18, minDim * 0.34);
  for (const x of [-deckRadius * 0.74, deckRadius * 0.74]) {
    details.push(detail(
      makeBox(converterFrameMat, heatSinkW, heatSinkH, heatSinkD, x, deckY + heatSinkH * 0.32, 0),
      'low',
    ));
  }

  const pylonFootRadius = Math.max(7, pylonRadius * 2.05);
  const pylonFootH = Math.max(6, pylonRadius * 1.35);
  const supportH = Math.max(8, pylonBaseY - height - deckH * 0.8);
  for (const x of [-pylonOffset, pylonOffset]) {
    details.push(detail(
      makeBox(converterFrameMat, pylonFootRadius * 1.1, supportH, pylonFootRadius * 0.95, x, pylonBaseY - pylonFootH - supportH * 0.5, 0),
      'low',
    ));
  }
  details.push(detail(
    makeCylinder(converterDarkMat, pylonFootRadius, pylonFootH, -pylonOffset, pylonBaseY - pylonFootH * 0.5, 0, hexCylinderGeom),
    'low',
  ));
  details.push(detail(
    makeCylinder(converterDarkMat, pylonFootRadius, pylonFootH, pylonOffset, pylonBaseY - pylonFootH * 0.5, 0, hexCylinderGeom),
    'low',
  ));

  const energyPylon = buildResourcePylonRig({
    resource: 'energy',
    direction: 'inbound',
    pylonHeight,
    pylonBaseY,
    x: -pylonOffset,
    z: 0,
    pylonRadius,
    sprayTravelSpeed: 120,
    sprayParticleRadius: Math.max(1.35, pylonRadius * 0.42),
    flowRadius: Math.max(34, pylonHeight * 1.25),
    coneAngle: PYLON_BUILDING_RESOURCE_CONVERTER_CONE_HALF_ANGLE_RAD,
    channel: 0,
    geometryTier: getActiveBuildingGeometryTier(),
  });
  const metalPylon = buildResourcePylonRig({
    resource: 'metal',
    direction: 'outbound',
    pylonHeight,
    pylonBaseY,
    x: pylonOffset,
    z: 0,
    pylonRadius,
    sprayTravelSpeed: 120,
    sprayParticleRadius: Math.max(1.35, pylonRadius * 0.42),
    flowRadius: Math.max(34, pylonHeight * 1.25),
    coneAngle: PYLON_BUILDING_RESOURCE_CONVERTER_CONE_HALF_ANGLE_RAD,
    channel: 1,
    geometryTier: getActiveBuildingGeometryTier(),
  });
  for (const mesh of energyPylon.staticMeshes) details.push(detail(mesh, 'low'));
  for (const mesh of metalPylon.staticMeshes) details.push(detail(mesh, 'low'));

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
  for (const geometry of radarDishGeomByTier.values()) geometry.dispose();
  for (const geometry of radarRingGeomByTier.values()) geometry.dispose();
  radarDishGeomByTier.clear();
  radarRingGeomByTier.clear();
  radarFrameMat.dispose();
  radarDarkMat.dispose();
  radarDishMat.dispose();
  radarSweepMat.dispose();
  hazardStripeMat.dispose();
  converterPlatformGeom.dispose();
  converterFrameMat.dispose();
  converterDarkMat.dispose();
  converterTrimMat.dispose();
  converterStatusMat.dispose();
}
