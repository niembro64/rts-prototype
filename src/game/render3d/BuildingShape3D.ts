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
import type { ConstructionEmitterSize } from '@/types/blueprints';
import {
  DEFAULT_BUILDING_VISUAL_HEIGHT,
  EXTRACTOR_BUILDING_VISUAL_HEIGHT,
  MEGA_BEAM_TOWER_VISUAL_HEIGHT,
  SOLAR_BUILDING_VISUAL_HEIGHT,
  WIND_BUILDING_VISUAL_HEIGHT,
  getBuildingBlueprint,
} from '../sim/blueprints';
import type { BuildingRenderProfile, TurretConfig } from '../sim/types';
import { getTurretConfig } from '../sim/turretConfigs';
import { BUILDING_PALETTE, SHINY_GRAY_METAL_MATERIAL } from './BuildingVisualPalette';
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

export type SolarPetalAnimation = {
  width: number;
  length: number;
  hinge: THREE.Vector3;
  tangent: THREE.Vector3;
  openDirection: THREE.Vector3;
  closedDirection: THREE.Vector3;
  panelSideHint: THREE.Vector3;
  inset: number;
  normalOffset: number;
  thickness: number;
};

export type ConstructionTowerOrbitPart = {
  mesh: THREE.Mesh;
  baseX: number;
  baseZ: number;
  baseRotationY: number;
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
};

/** Per-LOD rotor meshes for the extractor. The detail system gates
 *  visibility by tier so only ONE rotor is on-screen at a time, but
 *  the animator advances the same yaw on every entry — flipping LOD
 *  bands is a free visibility toggle, no rebuild needed. */
export type ExtractorRig = {
  rotors: THREE.Mesh[];
};

export type ConstructionEmitterRig = {
  group: THREE.Group;
  /** Same per-resource pylon trio the factory uses — three structural
   *  pylons evenly spaced around the emitter (energy / mana / metal),
   *  each wrapped by a translucent shower cylinder driven by the
   *  smoothed transfer rate. The render path EMAs rates derived from
   *  the build target's `buildable.paid` deltas (no extra wire
   *  payload — see Render3DEntities updateCommanderEmitter) and feeds
   *  per-resource colored sprays from each pylon top to the target. */
  showers: THREE.Mesh[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  showerRadius: number;
  pylonHeight: number;
  pylonBaseY: number;
  pylonTopsLocal: THREE.Vector3[];
  pylonTopBaseLocals: THREE.Vector3[];
  smoothedRates: { energy: number; mana: number; metal: number };
  /** Target id we last sampled `paid` from, plus the per-resource
   *  paid values, so the per-frame updater can compute deltas. Reset
   *  to null when the commander stops building. */
  lastPaidTargetId: number | null;
  lastPaid: { energy: number; mana: number; metal: number };
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
};

// ── Standard dimensions ────────────────────────────────────────────────
/** Default fallback block height for unknown buildings. */
const DEFAULT_HEIGHT = DEFAULT_BUILDING_VISUAL_HEIGHT;
/** Solar collector silhouette is a squat opened pyramid, but tall enough
 *  for the photovoltaic faces to read as the main structure. */
const SOLAR_HEIGHT = SOLAR_BUILDING_VISUAL_HEIGHT;
const WIND_HEIGHT = WIND_BUILDING_VISUAL_HEIGHT;
const EXTRACTOR_VISUAL_HEIGHT = EXTRACTOR_BUILDING_VISUAL_HEIGHT;
// ── Shared cached geometries ───────────────────────────────────────────
// Unit box reused for all building slabs + accents; each caller scales
// it to the right dimensions. Shared across instances so every factory
// and every solar uses the same backing BufferGeometry.
const boxGeom = new THREE.BoxGeometry(1, 1, 1);
const solarPanelPyramidGeom = new THREE.BufferGeometry();
solarPanelPyramidGeom.setAttribute('position', new THREE.Float32BufferAttribute([
  -0.5, -0.5,  0.5,   0.5, -0.5,  0.5,   0, 0.5, 0,
   0.5, -0.5, -0.5,  -0.5, -0.5, -0.5,   0, 0.5, 0,
   0.5, -0.5,  0.5,   0.5, -0.5, -0.5,   0, 0.5, 0,
  -0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,   0, 0.5, 0,
], 3));
solarPanelPyramidGeom.computeVertexNormals();
const solarTrianglePetalShape = new THREE.Shape([
  new THREE.Vector2(-0.5, 0),
  new THREE.Vector2(0.5, 0),
  new THREE.Vector2(0, 1),
]);
const solarTrianglePanelGeom = new THREE.ShapeGeometry(solarTrianglePetalShape);
const solarTrianglePetalGeom = new THREE.ExtrudeGeometry(solarTrianglePetalShape, {
  depth: 1,
  bevelEnabled: false,
  steps: 1,
});
const cylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
const hexCylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const extractorPyramidGeom = createHexFrustumGeometry();
const factorySphereGeom = new THREE.SphereGeometry(1, 18, 12);
const coneGeom = new THREE.ConeGeometry(0.5, 1, 18);
const windBladeGeom = createWindBladeGeometry();

// Solar-panel glass uses high metalness and low roughness to reflect
// the scene PMREM, while the dark blue base tint keeps it reading as
// photovoltaic glass.
const solarCellMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.photovoltaic,
  metalness: 1.0,
  roughness: 0.02,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -4,
});
const solarPetalBackMat = new THREE.MeshLambertMaterial({
  color: BUILDING_PALETTE.photovoltaicBack,
  side: THREE.DoubleSide,
});
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
const windGlowMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlow,
  transparent: true,
  opacity: 0.82,
  depthWrite: false,
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

const constructionBandMat = new THREE.ShaderMaterial({
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
  float diagonal = fract((vLocal.x * 0.8 + vLocal.y * 1.15 + vLocal.z * 0.45) * 4.4);
  vec3 yellow = ${CONSTRUCTION_HAZARD_YELLOW_GLSL};
  vec3 black = ${CONSTRUCTION_HAZARD_BLACK_GLSL};
  gl_FragColor = vec4(diagonal < 0.5 ? yellow : black, 1.0);
}
`,
});

// Resource-shower cylinders that surround each of the factory's three
// pylons. Color matches the shell-bar palette so a glance reads
// "yellow = energy, cyan = mana, copper = metal" the same way the
// shell HUD does. Translucent + additive so the pylon underneath
// stays legible when the shower is at full height.
const CONSTRUCTION_RESOURCE_COLORS = {
  energy: 0xf5d442,
  mana: 0x7ad7ff,
  metal: 0xd09060,
} as const;

function makeFactoryShowerMat(hex: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: hex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
const factoryEnergyShowerMat = makeFactoryShowerMat(CONSTRUCTION_RESOURCE_COLORS.energy);
const factoryManaShowerMat = makeFactoryShowerMat(CONSTRUCTION_RESOURCE_COLORS.mana);
const factoryMetalShowerMat = makeFactoryShowerMat(CONSTRUCTION_RESOURCE_COLORS.metal);
const factoryEnergyCapMat = new THREE.MeshLambertMaterial({ color: CONSTRUCTION_RESOURCE_COLORS.energy });
const factoryManaCapMat = new THREE.MeshLambertMaterial({ color: CONSTRUCTION_RESOURCE_COLORS.mana });
const factoryMetalCapMat = new THREE.MeshLambertMaterial({ color: CONSTRUCTION_RESOURCE_COLORS.metal });
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

const _solarPetalTangent = new THREE.Vector3();
const _solarPetalDirection = new THREE.Vector3();
const _solarPetalNormal = new THREE.Vector3();
const _solarPetalOrigin = new THREE.Vector3();
const _solarPetalXAxis = new THREE.Vector3();
const _solarPetalYAxis = new THREE.Vector3();
const _solarPetalZAxis = new THREE.Vector3();

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
      return buildSolar(width, depth, primaryMat);
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
  const hubRadius = Math.max(5.5, minDim * 0.15);
  const rotorY = Math.min(EXTRACTOR_VISUAL_HEIGHT - 6, pyramidHeight + Math.max(4, minDim * 0.1));

  const bladeLen = Math.max(32, minDim * 0.86);
  const bladeWidth = Math.max(10, minDim * 0.2);
  const bladeThickness = Math.max(4.5, minDim * 0.11);
  const bladeRootRadius = Math.max(hubRadius * 1.7, minDim * 0.28);

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
    extractorRig: { rotors: [simpleRotor] },
  };
}

// ── Per-type builders ──────────────────────────────────────────────────

/** Solar collector LOD ladder:
 *    marker — cheap team box handled by Render3DEntities
 *    min    — single photovoltaic pyramid
 *    low    — animated solid petals + solar faces
 *    medium — team-color backing panels on petal exteriors
 *    high   — same visual as medium
 *    max    — same visual as medium
 *
 *  Every petal-attached detail carries the same hinge animation data
 *  so closed/open transitions move as one rigid collector assembly. */
function buildSolar(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(solarPanelPyramidGeom, solarCellMat);
  const details: BuildingDetailMesh[] = [];

  const petalTilt = 0.42;
  const petalHingeY = 0;
  const petalThickness = 3.2;
  const panelRaise = 2.4;
  const petalFaceOffset = petalThickness + panelRaise;
  const teamAccentThickness = 0.85;
  const teamAccentOffset = -teamAccentThickness - 0.35;
  const frontBackAspect = width / Math.hypot(SOLAR_HEIGHT, depth * 0.5);
  const sideAspect = depth / Math.hypot(SOLAR_HEIGHT, width * 0.5);

  const frontBackSpan = width;
  const frontBackLen = frontBackSpan / frontBackAspect;
  const frontBackZ = depth * 0.5;
  const sideSpan = depth;
  const sideLen = sideSpan / sideAspect;
  const sideX = width * 0.5;
  const hingeRadius = Math.max(2.2, Math.min(width, depth) * 0.035);
  const hingeCapRadius = hingeRadius * 1.08;

  for (const xSign of [-1, 1] as const) {
    for (const zSign of [-1, 1] as const) {
      details.push(detail(makeSphere(
        solarPetalBackMat,
        hingeCapRadius,
        xSign * sideX,
        hingeCapRadius,
        zSign * frontBackZ,
      ), 'low'));
    }
  }

  for (const sign of [-1, 1]) {
    const frontBackClosedDir = new THREE.Vector3(0, SOLAR_HEIGHT, -sign * frontBackZ);
    const frontBackPanelSide = new THREE.Vector3(0, 0, -sign);
    details.push(detail(makeHingeBar(
      solarPetalBackMat,
      frontBackSpan,
      hingeRadius,
      0,
      hingeRadius,
      sign * frontBackZ,
      1,
      0,
    ), 'low'));
    details.push(detail(makeTrianglePetal(
      solarPetalBackMat,
      frontBackSpan,
      frontBackLen,
      0,
      petalHingeY,
      sign * frontBackZ,
      1,
      0,
      0,
      sign,
      petalTilt,
      0,
      0,
      petalThickness,
      frontBackClosedDir,
      frontBackPanelSide,
    ), 'low', undefined, 'solarLeaf'));
    details.push(detail(makeTrianglePetal(
      primaryMat,
      frontBackSpan * 0.58,
      frontBackLen * 0.42,
      0,
      petalHingeY,
      sign * frontBackZ,
      1,
      0,
      0,
      sign,
      petalTilt,
      frontBackLen * 0.2,
      teamAccentOffset,
      teamAccentThickness,
      frontBackClosedDir,
      frontBackPanelSide,
    ), 'medium', undefined, 'solarTeamAccent'));
    details.push(detail(makeTrianglePetal(
      solarCellMat,
      frontBackSpan,
      frontBackLen,
      0,
      petalHingeY,
      sign * frontBackZ,
      1,
      0,
      0,
      sign,
      petalTilt,
      0,
      petalFaceOffset,
      0,
      frontBackClosedDir,
      frontBackPanelSide,
    ), 'low', undefined, 'solarPanel'));

    const sideClosedDir = new THREE.Vector3(-sign * sideX, SOLAR_HEIGHT, 0);
    const sidePanelSide = new THREE.Vector3(-sign, 0, 0);
    details.push(detail(makeHingeBar(
      solarPetalBackMat,
      sideSpan,
      hingeRadius,
      sign * sideX,
      hingeRadius,
      0,
      0,
      1,
    ), 'low'));
    details.push(detail(makeTrianglePetal(
      solarPetalBackMat,
      sideSpan,
      sideLen,
      sign * sideX,
      petalHingeY,
      0,
      0,
      1,
      sign,
      0,
      petalTilt,
      0,
      0,
      petalThickness,
      sideClosedDir,
      sidePanelSide,
    ), 'low', undefined, 'solarLeaf'));
    details.push(detail(makeTrianglePetal(
      primaryMat,
      sideSpan * 0.58,
      sideLen * 0.42,
      sign * sideX,
      petalHingeY,
      0,
      0,
      1,
      sign,
      0,
      petalTilt,
      sideLen * 0.2,
      teamAccentOffset,
      teamAccentThickness,
      sideClosedDir,
      sidePanelSide,
    ), 'medium', undefined, 'solarTeamAccent'));
    details.push(detail(makeTrianglePetal(
      solarCellMat,
      sideSpan,
      sideLen,
      sign * sideX,
      petalHingeY,
      0,
      0,
      1,
      sign,
      0,
      petalTilt,
      0,
      petalFaceOffset,
      0,
      sideClosedDir,
      sidePanelSide,
    ), 'low', undefined, 'solarPanel'));
  }

  return { primary, details, height: SOLAR_HEIGHT, primaryMaterialLocked: true };
}

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
    const ribCenter = bladeLen * 0.54;
    const rib = makeBox(
      windGlowMat,
      bladeW * 0.16,
      bladeLen * 0.68,
      bladeThickness * 0.55,
      -Math.sin(angle) * ribCenter,
      Math.cos(angle) * ribCenter,
      bladeThickness * 0.95,
    );
    rib.rotation.z = angle;
    rotor.add(rib);
  }

  details.push(detail(root, 'low', undefined, 'windRig'));
  return {
    primary,
    details,
    height: baseH,
    windRig: { root, rotor },
  };
}

type ConstructionPylonTrio = {
  staticMeshes: THREE.Mesh[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  showers: THREE.Mesh[];
  pylonTopsLocal: THREE.Vector3[];
  pylonTopBaseLocals: THREE.Vector3[];
};

type ConstructionTowerResource = 'energy' | 'mana' | 'metal';
type ConstructionTowerSize = 'large' | 'small';

type ConstructionTowerVariant = {
  resource: ConstructionTowerResource;
  showerMaterial: THREE.Material;
  capMaterial: THREE.Material;
};

const CONSTRUCTION_TOWER_VARIANTS: readonly ConstructionTowerVariant[] = [
  { resource: 'energy', showerMaterial: factoryEnergyShowerMat, capMaterial: factoryEnergyCapMat },
  { resource: 'mana', showerMaterial: factoryManaShowerMat, capMaterial: factoryManaCapMat },
  { resource: 'metal', showerMaterial: factoryMetalShowerMat, capMaterial: factoryMetalCapMat },
] as const;

const CONSTRUCTION_TOWER_SIZE_STYLE: Record<ConstructionTowerSize, {
  baseRadiusMult: number;
  baseHeightMult: number;
  bandRadiusMult: number;
  bandHeightMult: number;
  capRadiusMult: number;
}> = {
  large: {
    baseRadiusMult: 2.85,
    baseHeightMult: 1.45,
    bandRadiusMult: 2.55,
    bandHeightMult: 0.95,
    capRadiusMult: 1.65,
  },
  small: {
    baseRadiusMult: 2.55,
    baseHeightMult: 1.25,
    bandRadiusMult: 2.25,
    bandHeightMult: 0.78,
    capRadiusMult: 1.55,
  },
};

function buildConstructionTowerPiece(
  variant: ConstructionTowerVariant,
  size: ConstructionTowerSize,
  teamBaseMat: THREE.Material,
  pylonHeight: number,
  innerPylonRadius: number,
  showerRadius: number,
  pylonBaseY: number,
  x: number,
  z: number,
): {
  staticMeshes: THREE.Mesh[];
  towerOrbitParts: ConstructionTowerOrbitPart[];
  shower: THREE.Mesh;
  topLocal: THREE.Vector3;
  topBaseLocal: THREE.Vector3;
} {
  const style = CONSTRUCTION_TOWER_SIZE_STYLE[size];
  const baseRadius = innerPylonRadius * style.baseRadiusMult;
  const baseHeight = Math.max(1.2, innerPylonRadius * style.baseHeightMult);
  const bandRadius = innerPylonRadius * style.bandRadiusMult;
  const bandHeight = Math.max(1.0, innerPylonRadius * style.bandHeightMult);
  const capRadius = Math.max(1.35, innerPylonRadius * style.capRadiusMult);
  const pylonTopY = pylonBaseY + pylonHeight;
  const capY = pylonTopY + capRadius * 0.36;

  // Team color lives on the base, not on the pillar.
  const teamBase = makeCylinder(
    teamBaseMat,
    baseRadius,
    baseHeight,
    x,
    pylonBaseY + baseHeight / 2,
    z,
    hexCylinderGeom,
  );
  // Construction bands are base hardware now, leaving the pillar
  // itself a clean dark-gray structural tower.
  const constructionBand = makeCylinder(
    constructionBandMat,
    bandRadius,
    bandHeight,
    x,
    pylonBaseY + baseHeight + bandHeight / 2,
    z,
    hexCylinderGeom,
  );
  const pylon = makeCylinder(
    factoryFrameMat,
    innerPylonRadius,
    pylonHeight,
    x,
    pylonBaseY + pylonHeight / 2,
    z,
  );
  const cap = makeSphere(variant.capMaterial, capRadius, x, capY, z);
  const staticMeshes = [teamBase, constructionBand, pylon, cap];

  const shower = makeCylinder(
    variant.showerMaterial,
    showerRadius,
    1,
    x,
    pylonBaseY,
    z,
  );
  shower.visible = false;
  shower.renderOrder = 6;
  const topLocal = new THREE.Vector3(x, capY + capRadius * 0.35, z);

  const towerOrbitParts: ConstructionTowerOrbitPart[] = [
    teamBase,
    constructionBand,
    pylon,
    cap,
    shower,
  ].map((mesh) => ({
    mesh,
    baseX: mesh.position.x,
    baseZ: mesh.position.z,
    baseRotationY: mesh.rotation.y,
  }));

  return {
    staticMeshes,
    towerOrbitParts,
    shower,
    topLocal,
    topBaseLocal: topLocal.clone(),
  };
}

function buildConstructionPylonTrio(
  size: ConstructionTowerSize,
  teamBaseMat: THREE.Material,
  pylonHeight: number,
  pylonOffset: number,
  innerPylonRadius: number,
  showerRadius: number,
  pylonBaseY: number,
): ConstructionPylonTrio {
  const staticMeshes: THREE.Mesh[] = [];
  const towerOrbitParts: ConstructionTowerOrbitPart[] = [];
  const showers: THREE.Mesh[] = [];
  const pylonTopsLocal: THREE.Vector3[] = [];
  const pylonTopBaseLocals: THREE.Vector3[] = [];

  for (let i = 0; i < CONSTRUCTION_TOWER_VARIANTS.length; i++) {
    const a = (i / CONSTRUCTION_TOWER_VARIANTS.length) * Math.PI * 2;
    const tower = buildConstructionTowerPiece(
      CONSTRUCTION_TOWER_VARIANTS[i],
      size,
      teamBaseMat,
      pylonHeight,
      innerPylonRadius,
      showerRadius,
      pylonBaseY,
      Math.cos(a) * pylonOffset,
      Math.sin(a) * pylonOffset,
    );
    staticMeshes.push(...tower.staticMeshes);
    towerOrbitParts.push(...tower.towerOrbitParts);
    showers.push(tower.shower);
    pylonTopsLocal.push(tower.topLocal);
    pylonTopBaseLocals.push(tower.topBaseLocal);
  }

  return { staticMeshes, towerOrbitParts, showers, pylonTopsLocal, pylonTopBaseLocals };
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

/** Reusable construction turret visual. The commander's build turret
 *  and the fabricator tower both instantiate this from the
 *  constructionTurret blueprint; only their mount point and visual
 *  variant differ. */
export function buildConstructionEmitterRigFromTurretConfig(
  turretConfig: Pick<TurretConfig, 'constructionEmitter'>,
  visualVariant: ConstructionEmitterSize | undefined,
  primaryMat: THREE.Material = factoryFrameMat,
): ConstructionEmitterRig {
  const spec = turretConfig.constructionEmitter;
  if (!spec) {
    throw new Error('Construction emitter rig requires a constructionEmitter turret config');
  }
  const variant = visualVariant ?? spec.defaultSize;
  const dims = spec.sizes[variant];
  if (!dims) {
    throw new Error(`Unknown construction emitter visual variant: ${variant}`);
  }

  const root = new THREE.Group();
  const pylonBaseY = 0;

  // Same energy / mana / metal trio as the factory; nothing else.
  const pylonTrio = buildConstructionPylonTrio(
    dims.towerSize,
    primaryMat,
    dims.pylonHeight,
    dims.pylonOffset,
    dims.innerPylonRadius,
    dims.showerRadius,
    pylonBaseY,
  );
  for (const mesh of pylonTrio.staticMeshes) root.add(mesh);
  for (const shower of pylonTrio.showers) root.add(shower);

  return {
    group: root,
    showers: pylonTrio.showers,
    towerOrbitParts: pylonTrio.towerOrbitParts,
    showerRadius: dims.showerRadius,
    pylonHeight: dims.pylonHeight,
    pylonBaseY,
    pylonTopsLocal: pylonTrio.pylonTopsLocal,
    pylonTopBaseLocals: pylonTrio.pylonTopBaseLocals,
    smoothedRates: { energy: 0, mana: 0, metal: 0 },
    lastPaidTargetId: null,
    lastPaid: { energy: 0, mana: 0, metal: 0 },
    towerSpinAmount: 0,
    towerSpinPhase: 0,
  };
}

/** Fallback — plain team-primary slab at default height, no detail. */
function buildUnknown(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  return { primary, details: [], height: DEFAULT_HEIGHT };
}

/** Static beam tower — tall narrow body. The mounted megaBeam turret
 *  is built and aimed by Render3DEntities through the same
 *  buildTurretMesh3D path units use, so head + barrel + spin/pitch
 *  groups are byte-identical to a Widow-mounted megaBeam. This shape
 *  builder is responsible only for the body slab; turret meshes are
 *  added on top by the caller from `entity.combat.turrets`. */
function buildMegaBeamTower(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  return { primary, details: [], height: MEGA_BEAM_TOWER_VISUAL_HEIGHT };
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

function createHexFrustumGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  // Normalized footprint: when Render3DEntities scales the primary by
  // building width/depth, the widest base edge stays inside that exact
  // logical footprint instead of spilling past the extractor cells.
  const bottomRadius = 0.5;
  const topRadius = 0.17;
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

  const hubRadius = Math.max(4.5, bladeWidth * 0.68);
  const hub = makeCylinder(extractorBladeMat, hubRadius, bladeThickness * 2.7, 0, 0, 0, hexCylinderGeom);
  rotor.add(hub);

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

function makeTrianglePetal(
  material: THREE.Material,
  width: number,
  length: number,
  hingeX: number,
  hingeY: number,
  hingeZ: number,
  tangentX: number,
  tangentZ: number,
  outwardX: number,
  outwardZ: number,
  openAngle: number,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  closedDirection?: THREE.Vector3,
  panelSideHint = new THREE.Vector3(0, 1, 0),
): THREE.Mesh {
  const hinge = new THREE.Vector3(hingeX, hingeY, hingeZ);
  const tangent = new THREE.Vector3(tangentX, 0, tangentZ);
  const openDirection = new THREE.Vector3(
    outwardX * Math.cos(openAngle),
    Math.sin(openAngle),
    outwardZ * Math.cos(openAngle),
  );
  const mesh = makeTrianglePlate(
    material,
    width,
    length,
    hinge,
    tangent,
    openDirection,
    inset,
    normalOffset,
    thickness,
    panelSideHint,
  );
  if (closedDirection) {
    mesh.userData.solarPetal = {
      width,
      length,
      hinge: hinge.clone(),
      tangent: tangent.clone(),
      openDirection: openDirection.clone(),
      closedDirection: closedDirection.clone(),
      panelSideHint: panelSideHint.clone(),
      inset,
      normalOffset,
      thickness,
    } satisfies SolarPetalAnimation;
  }
  return mesh;
}

function makeTrianglePlate(
  material: THREE.Material,
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(thickness > 0 ? solarTrianglePetalGeom : solarTrianglePanelGeom, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(makeTrianglePlateMatrix(width, length, hinge, tangent, petalDirection, inset, normalOffset, thickness, panelSideHint));
  return mesh;
}

function makeTrianglePlateMatrix(
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  writeSolarPetalMatrix(
    matrix,
    width,
    length,
    hinge,
    tangent,
    petalDirection,
    inset,
    normalOffset,
    thickness,
    panelSideHint,
  );
  return matrix;
}

export function writeSolarPetalMatrix(
  matrix: THREE.Matrix4,
  width: number,
  length: number,
  hinge: THREE.Vector3,
  tangent: THREE.Vector3,
  petalDirection: THREE.Vector3,
  inset = 0,
  normalOffset = 0,
  thickness = 0,
  panelSideHint?: THREE.Vector3,
): void {
  const tangentDir = _solarPetalTangent.copy(tangent).normalize();
  const petalDir = _solarPetalDirection.copy(petalDirection).normalize();
  const normal = _solarPetalNormal.crossVectors(tangentDir, petalDir).normalize();
  if (panelSideHint) {
    if (normal.dot(panelSideHint) < 0) normal.multiplyScalar(-1);
  } else if (normal.y < 0) {
    normal.multiplyScalar(-1);
  }
  const origin = _solarPetalOrigin.copy(hinge)
    .addScaledVector(petalDir, inset)
    .addScaledVector(normal, normalOffset);
  const xAxis = _solarPetalXAxis.copy(tangentDir).multiplyScalar(width);
  const yAxis = _solarPetalYAxis.copy(petalDir).multiplyScalar(Math.max(1, length - inset));
  const zAxis = _solarPetalZAxis.copy(normal).multiplyScalar(Math.max(1, thickness));
  matrix.makeBasis(xAxis, yAxis, zAxis);
  matrix.setPosition(origin);
}

function makeHingeBar(
  material: THREE.Material,
  length: number,
  radius: number,
  x: number,
  y: number,
  z: number,
  tangentX: number,
  tangentZ: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(cylinderGeom, material);
  mesh.scale.set(radius * 2, length, radius * 2);
  mesh.position.set(x, y, z);
  const tangent = new THREE.Vector3(tangentX, 0, tangentZ).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
  return mesh;
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
  solarPanelPyramidGeom.dispose();
  solarTrianglePanelGeom.dispose();
  solarTrianglePetalGeom.dispose();
  cylinderGeom.dispose();
  hexCylinderGeom.dispose();
  extractorPyramidGeom.dispose();
  factorySphereGeom.dispose();
  coneGeom.dispose();
  windBladeGeom.dispose();
  constructionOrbGeom.dispose();
  solarCellMat.dispose();
  solarPetalBackMat.dispose();
  windTowerMat.dispose();
  windTrimMat.dispose();
  windNacelleMat.dispose();
  windBladeMat.dispose();
  windGlassMat.dispose();
  windGlowMat.dispose();
  extractorBladeMat.dispose();
  invisibleMat.dispose();
  factoryFrameMat.dispose();
  constructionBandMat.dispose();
  hazardStripeMat.dispose();
  factoryEnergyShowerMat.dispose();
  factoryManaShowerMat.dispose();
  factoryMetalShowerMat.dispose();
  factoryEnergyCapMat.dispose();
  factoryManaCapMat.dispose();
  factoryMetalCapMat.dispose();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionPulseMat.dispose();
  constructionSparkMat.dispose();
}
