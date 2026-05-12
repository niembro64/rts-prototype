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
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
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
  disposeBuildingMeshPrimitives,
  detail,
  hexCylinderGeom,
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
  type FactoryConstructionRig,
} from './FactoryMesh3D';

export type { WindTurbineRig } from './WindTurbineMesh3D';
export type { ExtractorRig } from './MetalExtractorMesh3D';
export type { FactoryConstructionRig } from './FactoryMesh3D';

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
  factoryRig?: FactoryConstructionRig;
  windRig?: WindTurbineRig;
  extractorRig?: ExtractorRig;
  solarRig?: SolarRig;
};

// ── Standard dimensions ────────────────────────────────────────────────
/** Default fallback block height for unknown buildings. */
const DEFAULT_HEIGHT = DEFAULT_BUILDING_VISUAL_HEIGHT;

const radarFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const radarDishMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.structureLight,
  metalness: 0.72,
  roughness: 0.2,
});
const radarGlowMat = new THREE.MeshBasicMaterial({ color: BUILDING_PALETTE.cyanGlow });

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
      return buildRadarMesh(primaryMat);
    case 'megaBeamTower':
      return buildMegaBeamTowerMesh(primaryMat);
    case 'cannonTower':
      return buildCannonTowerMesh(primaryMat);
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

function buildRadarMesh(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  const mast = makeCylinder(radarFrameMat, 8, 110, 0, 76, 0, hexCylinderGeom);
  const hub = makeSphere(radarGlowMat, 12, 0, 120, 0);
  const dish = makeCylinder(radarDishMat, 0.5, 1, 0, 126, -10, hexCylinderGeom);
  dish.scale.set(58, 6, 46);
  dish.rotation.x = Math.PI / 2.35;
  const rim = makeCylinder(radarFrameMat, 0.5, 1, 0, 126, -11, hexCylinderGeom);
  rim.scale.set(64, 4, 52);
  rim.rotation.x = dish.rotation.x;

  return {
    primary,
    height: 150,
    details: [
      detail(mast, 'low'),
      detail(hub, 'low'),
      detail(rim, 'medium'),
      detail(dish, 'medium'),
    ],
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
  radarFrameMat.dispose();
  radarDishMat.dispose();
  radarGlowMat.dispose();
  hazardStripeMat.dispose();
}
