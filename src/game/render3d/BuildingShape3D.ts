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
  EXTRACTOR_BUILDING_VISUAL_HEIGHT,
  MEGA_BEAM_TOWER_VISUAL_HEIGHT,
  WIND_BUILDING_VISUAL_HEIGHT,
  getBuildingBlueprint,
} from '../sim/blueprints';
import type { BuildingRenderProfile } from '../sim/types';
import { getTurretConfig } from '../sim/turretConfigs';
import { BUILDING_PALETTE, SHINY_GRAY_METAL_MATERIAL } from './BuildingVisualPalette';
import {
  buildConstructionEmitterRigFromTurretConfig,
  buildProductionRateIndicator,
  disposeConstructionEmitterGeoms,
  type ConstructionTowerOrbitPart,
  type ProductionRateIndicatorRig,
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

export type WindTurbineRig = {
  root: THREE.Mesh;
  rotor: THREE.Mesh;
  rateIndicator?: ProductionRateIndicatorRig;
};

/** Per-LOD rotor meshes for the extractor. The detail system gates
 *  visibility by tier so only ONE rotor is on-screen at a time, but
 *  the animator advances the same yaw on every entry — flipping LOD
 *  bands is a free visibility toggle, no rebuild needed. */
export type ExtractorRig = {
  rotors: THREE.Mesh[];
  rateIndicator?: ProductionRateIndicatorRig;
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
const WIND_HEIGHT = WIND_BUILDING_VISUAL_HEIGHT;
const EXTRACTOR_VISUAL_HEIGHT = EXTRACTOR_BUILDING_VISUAL_HEIGHT;
// ── Shared cached geometries ───────────────────────────────────────────
// Unit box reused for all building slabs + accents; each caller scales
// it to the right dimensions. Shared across instances so every factory
// and every solar uses the same backing BufferGeometry.
const boxGeom = new THREE.BoxGeometry(1, 1, 1);
const cylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
const hexCylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const megaBeamTowerBodyGeom = createHexFrustumGeometry(0.36);
const extractorPyramidGeom = createHexFrustumGeometry();
const factorySphereGeom = new THREE.SphereGeometry(1, 18, 12);
const coneGeom = new THREE.ConeGeometry(0.5, 1, 18);
const windBladeGeom = createWindBladeGeometry();

const windTowerMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const windTrimMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });
const windNacelleMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.structureLight,
  metalness: 0.48,
  roughness: 0.16,
});
const windBladeMat = new THREE.MeshStandardMaterial({
  color: 0xd5dfe7,
  metalness: 0.38,
  roughness: 0.14,
});
const windGlassMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.photovoltaic,
  metalness: 1.0,
  roughness: 0.04,
});
const extractorBladeMat = new THREE.MeshStandardMaterial(SHINY_GRAY_METAL_MATERIAL);
const invisibleMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0,
  depthWrite: false,
});
const factoryFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });

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
      return buildWind(width, depth, primaryMat);
    case 'factory':
      return buildFactory(width, depth, primaryMat);
    case 'extractor':
      return buildExtractor(width, depth, primaryMat);
    case 'megaBeamTower':
      return buildMegaBeamTower(primaryMat);
    case 'unknown':
      return buildUnknown(primaryMat);
    default:
      throw new Error(`Unhandled building shape type: ${type as string}`);
  }
}

/** Metal extractor LOD ladder.
 *
 *  The complete readable extractor silhouette is the six-sided pyramid
 *  plus one rotating shiny hub/blade assembly. That simple version
 *  intentionally remains the ceiling for MEDIUM / HIGH / MAX, so the
 *  extractor does not swap into busier decorative variants as it moves
 *  through camera-sphere tiers.
 */
function buildExtractor(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const minDim = Math.min(width, depth);
  const pyramidHeight = Math.min(EXTRACTOR_VISUAL_HEIGHT * 0.64, Math.max(28, minDim * 0.78));
  const base = new THREE.Mesh(extractorPyramidGeom, primaryMat);

  const details: BuildingDetailMesh[] = [];
  const ratePillarBaseY = pyramidHeight + 2;
  const shortRatePillarHeight = Math.max(10, Math.min(16, EXTRACTOR_VISUAL_HEIGHT - ratePillarBaseY - 4));
  const ratePillarHeight = shortRatePillarHeight * 2;
  const ratePillarRadius = Math.max(3.8, minDim * 0.055);
  const metalRateIndicator = buildProductionRateIndicator(
    'metal',
    ratePillarRadius * 1.7,
    ratePillarHeight,
    ratePillarBaseY,
    0,
    0,
    ratePillarRadius,
  );
  for (const mesh of metalRateIndicator.staticMeshes) {
    details.push(detail(mesh, 'low'));
  }
  details.push(detail(metalRateIndicator.rig.shower, 'low'));

  const rotorY = Math.min(
    EXTRACTOR_VISUAL_HEIGHT - 3,
    ratePillarBaseY + ratePillarHeight + Math.max(1.5, ratePillarRadius * 0.35),
  );

  const bladeLen = Math.max(32, minDim * 0.86);
  const bladeWidth = Math.max(10, minDim * 0.2);
  const bladeThickness = Math.max(4.5, minDim * 0.11);
  const bladeRootRadius = Math.max(ratePillarRadius * 2.2, minDim * 0.28);

  // Simple rotor — all six blades remain visible and rotating so the
  // silhouette is stable across LODs. No higher-tier glow/trim variant.
  const simpleRotor = makeExtractorRotor(
    bladeLen, bladeWidth, bladeThickness,
    6, rotorY, Math.PI / 6, bladeRootRadius, 0.5,
  );
  details.push(detail(simpleRotor, 'min', undefined, 'extractorRotor'));

  return {
    primary: base,
    details,
    height: pyramidHeight,
    extractorRig: {
      rotors: [simpleRotor],
      rateIndicator: metalRateIndicator.rig,
    },
  };
}

// ── Per-type builders ──────────────────────────────────────────────────

function buildWind(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const minDim = Math.min(width, depth);
  const towerRadius = Math.max(3, minDim * 0.1);
  const towerH = WIND_HEIGHT * 0.57;
  const baseH = 12;
  const primary = new THREE.Mesh(cylinderGeom, primaryMat);
  const details: BuildingDetailMesh[] = [];

  details.push(detail(
    makeCylinder(factoryFrameMat, Math.max(7, minDim * 0.28), 5, 0, baseH + 2.5, 0, hexCylinderGeom),
    'low',
  ));
  details.push(detail(
    makeCylinder(windTowerMat, towerRadius, towerH, 0, towerH / 2, 0),
    'low',
  ));
  const energyRateIndicator = buildProductionRateIndicator(
    'energy',
    towerRadius * 1.8,
    towerH,
    0,
  );
  details.push(detail(energyRateIndicator.rig.shower, 'low'));

  const root = new THREE.Mesh(boxGeom, invisibleMat);
  root.position.set(0, towerH, 0);
  root.visible = false;

  const nacelleLen = Math.max(32, minDim * 0.86);
  const nacelleRadius = Math.max(5.2, minDim * 0.16);
  const nacelle = makeCylinder(windNacelleMat, nacelleRadius, nacelleLen, 0, 0, 0);
  nacelle.rotation.x = Math.PI / 2;
  root.add(nacelle);

  const tailCap = makeCone(windTrimMat, nacelleRadius * 0.72, nacelleRadius * 1.7, 0, 0, -nacelleLen * 0.52);
  tailCap.rotation.x = -Math.PI / 2;
  root.add(tailCap);

  const panelLen = nacelleLen * 0.52;
  const panelH = nacelleRadius * 0.42;
  for (const side of [-1, 1]) {
    root.add(makeBox(
      windGlassMat,
      0.6,
      panelH,
      panelLen,
      side * nacelleRadius * 1.02,
      nacelleRadius * 0.1,
      -nacelleLen * 0.05,
    ));
    const fin = makeBox(
      windTrimMat,
      Math.max(1.4, nacelleRadius * 0.16),
      nacelleRadius * 1.9,
      nacelleLen * 0.3,
      side * nacelleRadius * 1.34,
      nacelleRadius * 0.15,
      -nacelleLen * 0.1,
    );
    fin.rotation.z = side * 0.2;
    root.add(fin);
  }

  const rotor = new THREE.Mesh(boxGeom, invisibleMat);
  rotor.position.set(0, 0, nacelleLen * 0.66);
  root.add(rotor);

  const bladeLen = Math.min(WIND_HEIGHT * 0.42, Math.max(86, minDim * 1.55));
  const bladeW = Math.max(8, minDim * 0.19);
  const bladeThickness = Math.max(1.6, minDim * 0.032);
  const hub = makeSphere(windNacelleMat, nacelleRadius * 0.78, 0, 0, 0);
  rotor.add(hub);

  const nose = makeCone(windNacelleMat, nacelleRadius * 0.74, nacelleRadius * 1.38, 0, 0, nacelleRadius * 0.5);
  nose.rotation.x = Math.PI / 2;
  rotor.add(nose);

  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2;
    const blade = makeTurbineBlade(windBladeMat, bladeLen, bladeW, bladeThickness, angle);
    rotor.add(blade);
  }

  details.push(detail(root, 'low', undefined, 'windRig'));
  return {
    primary,
    details,
    height: baseH,
    windRig: { root, rotor, rateIndicator: energyRateIndicator.rig },
  };
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

/** Static beam tower — wider stepped base, hex-prism shaft, and a
 *  collar platform under the turret. The primary slab gets scaled to
 *  the building's full cuboid by the per-frame writer (so the
 *  silhouette inside the build grid stays correct); detail meshes
 *  carry the visible character — base flange, four corner ribs, and
 *  a turret collar — and ride along in absolute world units, so they
 *  don't deform when the primary scales.
 *
 *  The mounted beam turret is built and aimed by Render3DEntities
 *  through the same buildTurretMesh3D path units use, so head + barrel
 *  + spin/pitch behavior stays shared with unit-mounted weapons. This
 *  shape builder owns body geometry only; turret meshes are added on
 *  top by the caller from `entity.combat.turrets`. */
function buildMegaBeamTower(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(megaBeamTowerBodyGeom, primaryMat);

  // World-unit dimensions. The primary tapered shaft scales inside
  // the building's logical 40x80x40 cuboid (set by gridWidth/gridHeight
  // x cellSize and the visualHeight constant); details are sized in
  // those terms.
  const H = MEGA_BEAM_TOWER_VISUAL_HEIGHT; // 80 wu
  const FOOT = 40; // gridWidth × cellSize for the megaBeamTower entry

  const details: BuildingDetailMesh[] = [];

  // Stepped hex foundation flange — slightly wider, low and squat.
  // Reads as "this thing is bolted into the ground, not floating".
  const baseHeight = 14;
  const base = makeCylinder(
    primaryMat,
    FOOT * 0.68,
    baseHeight,
    0,
    baseHeight / 2,
    0,
    hexCylinderGeom,
  );
  details.push(detail(base, 'min', undefined, 'static'));

  const lowerBand = makeCylinder(
    extractorBladeMat,
    FOOT * 0.57,
    3,
    0,
    baseHeight + 1.5,
    0,
    hexCylinderGeom,
  );
  details.push(detail(lowerBand, 'min', undefined, 'static'));

  // Six sloped metal spars follow the taper from the wide base to the
  // narrower turret neck, making the shaft read as hexagonal and
  // engineered instead of a scaled box.
  const strutBottomRadius = FOOT * 0.42;
  const strutTopRadius = FOOT * 0.29;
  const strutBottomY = baseHeight + 3;
  const strutTopY = H - 8;
  const strutRadius = 1.7;
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
    const bottom = new THREE.Vector3(
      Math.cos(angle) * strutBottomRadius,
      strutBottomY,
      Math.sin(angle) * strutBottomRadius,
    );
    const top = new THREE.Vector3(
      Math.cos(angle) * strutTopRadius,
      strutTopY,
      Math.sin(angle) * strutTopRadius,
    );
    const delta = top.clone().sub(bottom);
    const length = delta.length();
    const strut = new THREE.Mesh(cylinderGeom, extractorBladeMat);
    strut.scale.set(strutRadius * 2, length, strutRadius * 2);
    strut.position.copy(bottom).addScaledVector(delta, 0.5);
    strut.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    details.push(detail(strut, 'min', undefined, 'static'));
  }

  // Turret socket — a compact hex collar at the top of the taper. The
  // actual rotating turret mesh is mounted on this centerline by
  // Render3DEntities.
  const neck = makeCylinder(
    primaryMat,
    FOOT * 0.41,
    7,
    0,
    H - 3.5,
    0,
    hexCylinderGeom,
  );
  details.push(detail(neck, 'min', undefined, 'static'));

  const socket = makeCylinder(
    extractorBladeMat,
    FOOT * 0.44,
    4,
    0,
    H + 2,
    0,
    hexCylinderGeom,
  );
  details.push(detail(socket, 'min', undefined, 'static'));

  return { primary, details, height: H };
}

function createWindBladeGeometry(): THREE.BufferGeometry {
  const stations = [
    { y: 0.06, halfW: 0.34, halfT: 0.46, sweep: -0.02 },
    { y: 0.48, halfW: 0.18, halfT: 0.28, sweep: -0.08 },
    { y: 1.0, halfW: 0.035, halfT: 0.09, sweep: 0.08 },
  ];
  const positions: number[] = [];
  for (const s of stations) {
    positions.push(
      s.sweep - s.halfW, s.y, -s.halfT,
      s.sweep + s.halfW, s.y, -s.halfT,
      s.sweep + s.halfW, s.y,  s.halfT,
      s.sweep - s.halfW, s.y,  s.halfT,
    );
  }

  const indices: number[] = [];
  const addFace = (a: number, b: number, c: number, d: number): void => {
    indices.push(a, b, c, a, c, d);
  };
  for (let i = 0; i < stations.length - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    addFace(a + 0, a + 1, b + 1, b + 0);
    addFace(a + 1, a + 2, b + 2, b + 1);
    addFace(a + 2, a + 3, b + 3, b + 2);
    addFace(a + 3, a + 0, b + 0, b + 3);
  }
  addFace(0, 3, 2, 1);
  const tip = (stations.length - 1) * 4;
  addFace(tip + 0, tip + 1, tip + 2, tip + 3);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function createHexFrustumGeometry(
  topRadius: number = 0.17,
  bottomRadius: number = 0.5,
): THREE.BufferGeometry {
  const positions: number[] = [];
  // Normalized footprint: when Render3DEntities scales the primary by
  // building width/depth, the widest base edge stays inside that exact
  // logical footprint instead of spilling past the building cells.
  const bottomY = -0.5;
  const topY = 0.5;
  const bottomCorners: THREE.Vector3[] = [];
  const topCorners: THREE.Vector3[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + (i / 6) * Math.PI * 2;
    bottomCorners.push(new THREE.Vector3(Math.cos(angle) * bottomRadius, bottomY, Math.sin(angle) * bottomRadius));
    topCorners.push(new THREE.Vector3(Math.cos(angle) * topRadius, topY, Math.sin(angle) * topRadius));
  }

  for (let i = 0; i < 6; i++) {
    const b0 = bottomCorners[i];
    const b1 = bottomCorners[(i + 1) % 6];
    const t0 = topCorners[i];
    const t1 = topCorners[(i + 1) % 6];
    positions.push(
      b0.x, b0.y, b0.z, t1.x, t1.y, t1.z, b1.x, b1.y, b1.z,
      b0.x, b0.y, b0.z, t0.x, t0.y, t0.z, t1.x, t1.y, t1.z,
    );
  }

  const bottomCenter = new THREE.Vector3(0, bottomY, 0);
  const topCenter = new THREE.Vector3(0, topY, 0);
  for (let i = 0; i < 6; i++) {
    const b0 = bottomCorners[(i + 1) % 6];
    const b1 = bottomCorners[i];
    positions.push(bottomCenter.x, bottomCenter.y, bottomCenter.z, b1.x, b1.y, b1.z, b0.x, b0.y, b0.z);
    const t0 = topCorners[i];
    const t1 = topCorners[(i + 1) % 6];
    positions.push(topCenter.x, topCenter.y, topCenter.z, t1.x, t1.y, t1.z, t0.x, t0.y, t0.z);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

function makeTurbineBlade(
  material: THREE.Material,
  length: number,
  rootWidth: number,
  thickness: number,
  angle: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(windBladeGeom, material);
  mesh.scale.set(rootWidth, length, thickness);
  mesh.rotation.z = angle;
  return mesh;
}

function applyBasis(mesh: THREE.Mesh, xAxis: THREE.Vector3, yAxis: THREE.Vector3, zAxis: THREE.Vector3): void {
  const basis = new THREE.Matrix4();
  basis.makeBasis(xAxis, yAxis, zAxis);
  mesh.quaternion.setFromRotationMatrix(basis);
}

function makeExtractorRotor(
  bladeReach: number,
  bladeWidth: number,
  bladeThickness: number,
  bladeCount: number,
  y: number,
  angleOffset: number,
  bladeRootRadius: number,
  bladeLengthScale: number = 1,
): THREE.Mesh {
  const rotor = new THREE.Mesh(cylinderGeom, invisibleMat);
  rotor.position.set(0, y, 0);

  const groundClearance = Math.max(3.5, bladeThickness * 1.5);
  const fullVerticalDrop = Math.max(12, y - groundClearance);
  const rootRadius = Math.max(0, Math.min(bladeRootRadius, Math.max(0, bladeReach - 16)));
  const fullHorizontalSpan = Math.max(16, Math.min(bladeReach - rootRadius, fullVerticalDrop));
  const horizontalSpan = fullHorizontalSpan * bladeLengthScale;
  const verticalDrop = fullVerticalDrop * bladeLengthScale;
  const bladeAxisLength = Math.hypot(horizontalSpan, verticalDrop);

  for (let i = 0; i < bladeCount; i++) {
    const angle = angleOffset + (i / bladeCount) * Math.PI * 2;
    const radialDir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const tangentDir = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle));
    const bladeDir = new THREE.Vector3(
      radialDir.x * horizontalSpan,
      -verticalDrop,
      radialDir.z * horizontalSpan,
    ).normalize();
    const normalDir = new THREE.Vector3().crossVectors(tangentDir, bladeDir).normalize();
    const centerRadius = rootRadius + horizontalSpan * 0.5;
    const centerX = radialDir.x * centerRadius;
    const centerY = -verticalDrop * 0.5;
    const centerZ = radialDir.z * centerRadius;

    const blade = makeBox(
      extractorBladeMat,
      bladeAxisLength,
      bladeThickness,
      bladeWidth,
      centerX,
      centerY,
      centerZ,
    );
    applyBasis(blade, bladeDir, normalDir, tangentDir);
    rotor.add(blade);
  }

  return rotor;
}

function makeBox(
  material: THREE.Material,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(boxGeom, material);
  mesh.scale.set(width, height, depth);
  mesh.position.set(x, y, z);
  return mesh;
}

function makeCylinder(
  material: THREE.Material,
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
  geom: THREE.BufferGeometry = cylinderGeom,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geom, material);
  mesh.scale.set(radius * 2, height, radius * 2);
  mesh.position.set(x, y, z);
  return mesh;
}

function makeCone(
  material: THREE.Material,
  radius: number,
  height: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(coneGeom, material);
  mesh.scale.set(radius * 2, height, radius * 2);
  mesh.position.set(x, y, z);
  return mesh;
}

function makeSphere(
  material: THREE.Material,
  radius: number,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(factorySphereGeom, material);
  mesh.scale.setScalar(radius);
  mesh.position.set(x, y, z);
  return mesh;
}

function detail(
  mesh: THREE.Mesh,
  minTier: ConcreteGraphicsQuality,
  maxTier?: ConcreteGraphicsQuality,
  role: BuildingDetailRole = 'static',
): BuildingDetailMesh {
  return { mesh, minTier, maxTier, role };
}

/** Tear down shared geometries + materials on renderer destroy. Callers
 *  (Render3DEntities.destroy) invoke once at app teardown. */
export function disposeBuildingGeoms(): void {
  boxGeom.dispose();
  cylinderGeom.dispose();
  hexCylinderGeom.dispose();
  megaBeamTowerBodyGeom.dispose();
  extractorPyramidGeom.dispose();
  factorySphereGeom.dispose();
  coneGeom.dispose();
  windBladeGeom.dispose();
  constructionOrbGeom.dispose();
  disposeConstructionEmitterGeoms();
  disposeSolarCollectorGeoms();
  windTowerMat.dispose();
  windTrimMat.dispose();
  windNacelleMat.dispose();
  windBladeMat.dispose();
  windGlassMat.dispose();
  extractorBladeMat.dispose();
  invisibleMat.dispose();
  factoryFrameMat.dispose();
  hazardStripeMat.dispose();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionPulseMat.dispose();
  constructionSparkMat.dispose();
}
