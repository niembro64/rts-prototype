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
  getBuildingBlueprint,
} from '../sim/blueprints';
import type { BuildingRenderProfile } from '../sim/types';
import { getTurretConfig } from '../sim/turretConfigs';
import {
  buildConstructionEmitterRigFromTurretConfig,
  disposeConstructionEmitterGeoms,
  type ConstructionTowerOrbitPart,
} from './ConstructionEmitterMesh3D';
import {
  buildSolarCollector,
  disposeSolarCollectorGeoms,
  type SolarRig,
} from './SolarCollectorMesh3D';
import {
  BUILD_BUBBLE_GHOST_COLOR_HEX,
  BUILD_BUBBLE_GHOST_OPACITY,
  BUILD_BUBBLE_CORE_COLOR_HEX,
  BUILD_BUBBLE_CORE_OPACITY,
  BUILD_BUBBLE_PULSE_COLOR_HEX,
  BUILD_BUBBLE_PULSE_OPACITY,
  BUILD_BUBBLE_SPARK_COLOR_HEX,
  BUILD_BUBBLE_SPARK_OPACITY,
} from '@/shellConfig';
import { CONSTRUCTION_HAZARD_COLORS } from '@/constructionVisualConfig';
import { buildWindTurbineMesh, type WindTurbineRig } from './WindTurbineMesh3D';
import {
  buildMetalExtractorMesh,
  disposeMetalExtractorMeshGeoms,
  type ExtractorRig,
} from './MetalExtractorMesh3D';
import {
  boxGeom,
  cylinderGeom,
  detail,
  disposeBuildingMeshPrimitives,
} from './BuildingMeshPrimitives3D';
import {
  buildMegaBeamTowerMesh,
  disposeMegaBeamTowerMeshGeoms,
} from './MegaBeamTowerMesh3D';

export type { WindTurbineRig } from './WindTurbineMesh3D';
export type { ExtractorRig } from './MetalExtractorMesh3D';

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

export type FactoryConstructionRig = {
  group: THREE.Group;
  unitGhost: THREE.Mesh;
  unitCore: THREE.Mesh;
  sparks: THREE.Mesh[];
  /** The three resource "showers" — translucent cylinders surrounding
   *  the factory's three structural pylons. Each fills bottom-up with
   *  its resource's transfer-rate fraction (0..1):
   *    showers[0] = energy (yellow)
   *    showers[1] = mana   (cyan)
   *    showers[2] = metal  (copper)
   *  `pylonHeight` and `pylonBaseY` (the pylon's bottom edge in
   *  chassis-local Y) are stored so the per-frame update can scale
   *  each shower with the live rate without re-deriving metrics. */
  showers: THREE.Mesh[];
  /** Visible tower pieces that orbit the emitter center only while
   *  construction is active. The fabricator and commander emitter both
   *  use the same tower part list so the animation contract cannot
   *  drift between them. */
  towerOrbitParts: ConstructionTowerOrbitPart[];
  showerRadius: number;
  pylonHeight: number;
  pylonBaseY: number;
  /** Chassis-local position of each pylon's top, in the same order
   *  as `showers` (energy / mana / metal). The per-frame update
   *  uses these as the SOURCE of the per-resource colored build
   *  sprays — each spray runs from a pylon top to the build spot. */
  pylonTopsLocal: THREE.Vector3[];
  /** Immutable pylon-top positions before orbital tower spin. The
   *  renderer rotates these into `pylonTopsLocal` with the same phase
   *  used for the visible tower pieces. */
  pylonTopBaseLocals: THREE.Vector3[];
  /** Smoothed transfer-rate fractions (0..1), one per resource in
   *  the same order as `showers`. The renderer EMAs the live sim
   *  rates into these so the showers + sprays don't pop on per-tick
   *  step changes. Zeroed at rig creation. */
  smoothedRates: { energy: number; mana: number; metal: number };
  towerSpinAmount: number;
  towerSpinPhase: number;
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

function shaderRgb(rgb: readonly [number, number, number]): string {
  return `vec3(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

const CONSTRUCTION_HAZARD_YELLOW_GLSL = shaderRgb(CONSTRUCTION_HAZARD_COLORS.yellowRgb);
const CONSTRUCTION_HAZARD_BLACK_GLSL = shaderRgb(CONSTRUCTION_HAZARD_COLORS.blackRgb);

// Build-bubble materials. Strictly whitish/grayish per shellConfig —
// no team color, no amber, no cyan glass. All four mats are kept as
// separate THREE.Material instances so the four roles (ghost shell,
// core orb, travelling pulses, sparks) can be tuned independently
// from shellConfig without recompiling shaders.
const constructionGhostMat = new THREE.MeshBasicMaterial({
  color: BUILD_BUBBLE_GHOST_COLOR_HEX,
  transparent: true,
  opacity: BUILD_BUBBLE_GHOST_OPACITY,
  depthWrite: false,
});
const constructionCoreMat = new THREE.MeshBasicMaterial({
  color: BUILD_BUBBLE_CORE_COLOR_HEX,
  transparent: true,
  opacity: BUILD_BUBBLE_CORE_OPACITY,
  depthWrite: false,
});
// Pulses get their own material so the travelling-orb tint can drift
// from the static-core tint without one knob driving both. (Same
// pattern factory had before the rename to whitish-only.)
const constructionPulseMat = new THREE.MeshBasicMaterial({
  color: BUILD_BUBBLE_PULSE_COLOR_HEX,
  transparent: true,
  opacity: BUILD_BUBBLE_PULSE_OPACITY,
  depthWrite: false,
});
const constructionSparkMat = new THREE.MeshBasicMaterial({
  color: BUILD_BUBBLE_SPARK_COLOR_HEX,
  transparent: true,
  opacity: BUILD_BUBBLE_SPARK_OPACITY,
  depthWrite: false,
});
const constructionOrbGeom = new THREE.SphereGeometry(1, 12, 8);
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
      return buildFactory(width, depth, primaryMat);
    case 'extractor':
      return buildMetalExtractorMesh(width, depth, primaryMat);
    case 'megaBeamTower':
      return buildMegaBeamTowerMesh(primaryMat);
    case 'unknown':
      return buildUnknown(primaryMat);
    default:
      throw new Error(`Unhandled building shape type: ${type as string}`);
  }
}

/** Factory: compact radial construction tower.
 *
 *  The tower is the large version of the same shared three-pylon
 *  construction emitter used by the commander's build turret:
 *  dark-gray resource pillars, team-colored bases, black/white
 *  construction bands on those bases, fixed resource endcaps, and
 *  live resource showers/sprays. The unitGhost + unitCore + sparks
 *  remain at the BUILD SPOT, visualizing the forming unit. */
function buildFactory(
  _width: number,
  _depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(cylinderGeom, primaryMat);
  const details: BuildingDetailMesh[] = [];
  const blueprint = getBuildingBlueprint('factory');
  const constructionMount = blueprint.turrets?.find((mount) => mount.turretId === 'constructionTurret');
  if (!constructionMount) {
    throw new Error('Factory blueprint must mount a constructionTurret');
  }
  const constructionConfig = getTurretConfig(constructionMount.turretId);
  const constructionRig = buildConstructionEmitterRigFromTurretConfig(
    constructionConfig,
    constructionMount.visualVariant,
    primaryMat,
  );
  constructionRig.group.position.set(
    constructionMount.mount.x,
    constructionMount.mount.z - constructionConfig.radius.body,
    constructionMount.mount.y,
  );
  constructionRig.group.visible = false;

  // Build-spot visuals. These follow the FORMING UNIT (not the tower)
  // so they stay even after the central tower pieces were removed.
  // The legacy buildPulses (orbs that travelled from the now-deleted
  // central nozzle to the build spot) are gone — the per-pylon
  // colored sprays carry the same "stuff is flowing into the build
  // spot" read.
  const unitGhost = new THREE.Mesh(constructionOrbGeom, constructionGhostMat);
  unitGhost.visible = false;
  details.push(detail(unitGhost, 'medium', undefined, 'factoryUnitGhost'));

  const unitCore = new THREE.Mesh(constructionOrbGeom, constructionCoreMat);
  unitCore.visible = false;
  details.push(detail(unitCore, 'high', undefined, 'factoryUnitCore'));

  const sparks: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const spark = new THREE.Mesh(constructionOrbGeom, constructionSparkMat);
    spark.visible = false;
    sparks.push(spark);
    details.push(detail(spark, 'max', undefined, 'factorySpark'));
  }

  return {
    primary,
    details,
    height: blueprint.visualHeight,
    factoryRig: {
      group: constructionRig.group,
      unitGhost,
      unitCore,
      sparks,
      showers: constructionRig.showers,
      towerOrbitParts: constructionRig.towerOrbitParts,
      showerRadius: constructionRig.showerRadius,
      pylonHeight: constructionRig.pylonHeight,
      pylonBaseY: constructionRig.pylonBaseY,
      pylonTopsLocal: constructionRig.pylonTopsLocal,
      pylonTopBaseLocals: constructionRig.pylonTopBaseLocals,
      smoothedRates: { energy: 0, mana: 0, metal: 0 },
      towerSpinAmount: 0,
      towerSpinPhase: 0,
    },
  };
}

/** Fallback — plain team-primary slab at default height, no detail. */
function buildUnknown(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  return { primary, details: [], height: DEFAULT_HEIGHT };
}

/** Tear down shared geometries + materials on renderer destroy. Callers
 *  (Render3DEntities.destroy) invoke once at app teardown. */
export function disposeBuildingGeoms(): void {
  disposeMegaBeamTowerMeshGeoms();
  disposeBuildingMeshPrimitives();
  disposeMetalExtractorMeshGeoms();
  constructionOrbGeom.dispose();
  disposeConstructionEmitterGeoms();
  disposeSolarCollectorGeoms();
  hazardStripeMat.dispose();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionPulseMat.dispose();
  constructionSparkMat.dispose();
}
