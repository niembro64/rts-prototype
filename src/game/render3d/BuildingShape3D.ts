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
  SOLAR_BUILDING_VISUAL_HEIGHT,
  WIND_BUILDING_VISUAL_HEIGHT,
  getFactoryBuildingVisualMetrics,
} from '../sim/blueprints';
import type { BuildingRenderProfile } from '../sim/types';
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
  | 'factoryBuildPulse'
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

export type FactoryConstructionRig = {
  unitGhost: THREE.Mesh;
  unitCore: THREE.Mesh;
  buildPulses: THREE.Mesh[];
  sparks: THREE.Mesh[];
  nozzleLocal: THREE.Vector3;
  bayBaseY: number;
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
  showerRadius: number;
  pylonHeight: number;
  pylonBaseY: number;
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
  nozzleLocal: THREE.Vector3;
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
const solarPanelCoarseLineGeom = createSolarPanelLineGeometry([0.36, 0.62]);
const solarPanelFineLineGeom = createSolarPanelLineGeometry([0.22, 0.38, 0.54, 0.70, 0.84]);
const cylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
const hexCylinderGeom = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const extractorPyramidGeom = createHexFrustumGeometry();
const factorySphereGeom = new THREE.SphereGeometry(1, 18, 12);
const coneGeom = new THREE.ConeGeometry(0.5, 1, 18);
const windBladeGeom = createWindBladeGeometry();

const BUILDING_PALETTE = {
  structureDark: 0x172331,
  structureMid: 0x34414d,
  structureLight: 0xc8d4dd,
  photovoltaic: 0x123a58,
  photovoltaicBack: 0x26313a,
  cyanGlow: 0x73ddeb,
  cyanGlass: 0x82dce9,
  constructionAmber: 0xe8cd72,
  constructionSpark: 0xdbe9ee,
} as const;

// Shared blue-gray structure used by non-team building frames.
const chimneyMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
// Solar-panel glass uses the same PBR trick as mirror panels: metalness=1
// and near-zero roughness reflect the scene PMREM, while the dark blue
// base tint keeps it reading as photovoltaic glass.
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
const solarPanelCoarseLineMat = new THREE.MeshBasicMaterial({
  color: 0x77c8d8,
  transparent: true,
  opacity: 0.34,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const solarPanelFineLineMat = new THREE.MeshBasicMaterial({
  color: 0xd4eef4,
  transparent: true,
  opacity: 0.46,
  depthWrite: false,
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
const extractorDarkMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });
const extractorBladeMat = new THREE.MeshStandardMaterial({
  color: BUILDING_PALETTE.structureLight,
  metalness: 0.78,
  roughness: 0.18,
});
const extractorGlowMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlow,
  transparent: true,
  opacity: 0.62,
  depthWrite: false,
});
const invisibleMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0,
  depthWrite: false,
});
const factoryFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });

// Resource-shower cylinders that surround each of the factory's three
// pylons. Color matches the shell-bar palette so a glance reads
// "yellow = energy, cyan = mana, copper = metal" the same way the
// shell HUD does. Translucent + additive so the pylon underneath
// stays legible when the shower is at full height.
function makeFactoryShowerMat(hex: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: hex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
const factoryEnergyShowerMat = makeFactoryShowerMat(0xf5d442);
const factoryManaShowerMat = makeFactoryShowerMat(0x7ad7ff);
const factoryMetalShowerMat = makeFactoryShowerMat(0xd09060);
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
  vec3 yellow = vec3(0.89, 0.69, 0.18);
  vec3 black = vec3(0.075, 0.105, 0.13);
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

function createSolarPanelLineGeometry(crossbars: readonly number[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const addRect = (x0: number, y0: number, x1: number, y1: number): void => {
    positions.push(
      x0, y0, 0,
      x1, y0, 0,
      x1, y1, 0,
      x0, y0, 0,
      x1, y1, 0,
      x0, y1, 0,
    );
  };

  addRect(-0.014, 0.12, 0.014, 0.90);
  for (const y of crossbars) {
    const halfWidth = (1 - y) * 0.5;
    const margin = Math.max(0.035, halfWidth * 0.1);
    const x0 = -halfWidth + margin;
    const x1 = halfWidth - margin;
    if (x1 <= x0) continue;
    addRect(x0, y - 0.010, x1, y + 0.010);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

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
    case 'unknown':
      return buildUnknown(primaryMat);
    default:
      throw new Error(`Unhandled building shape type: ${type as string}`);
  }
}

/** Metal extractor LOD ladder.
 *
 *  Principle: every tier preserves the SILHOUETTE — pyramid base +
 *  chimney column + rotating fan — so the building reads as the same
 *  object at any zoom level. Higher tiers add DECORATIVE details
 *  (cap spheres, collar rings, glowing cutting edges) on top of that
 *  silhouette; lower tiers strip those small touches but keep the
 *  major masses visible.
 *
 *    min    — pyramid + base ring + chimney + simple 3-blade rotor.
 *             Silhouette is complete; no decorative trim.
 *    low    — + cap sphere on the chimney tip (small polish where
 *             the chimney meets the rotor mount).
 *    medium — + collar ring around the pyramid's top edge (reads as
 *             a structural seam).
 *    high   — + top-cap collar around the rotor base AND swap the
 *             3-blade rotor for the full 6-blade rotor with glowing
 *             cutting edges.
 *    max    — same content as high (the full rig is already at the
 *             ceiling of useful detail).
 *
 *  Tier-gating lives in the top-level detail array. Both rotor
 *  variants get parented as separate details with mutually exclusive
 *  tier ranges so only one is on-screen at a time. The animator
 *  advances yaw on every rotor in `extractorRig.rotors`; writing to
 *  the hidden one is free (one assign, no GPU work) and prevents an
 *  LOD-flip glitch where the swapped-in rotor would briefly show an
 *  old yaw.
 */
function buildExtractor(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const minDim = Math.min(width, depth);
  const footprintRadius = minDim * 0.5;
  const pyramidHeight = Math.min(EXTRACTOR_VISUAL_HEIGHT * 0.64, Math.max(28, minDim * 0.78));
  const base = new THREE.Mesh(extractorPyramidGeom, primaryMat);

  const details: BuildingDetailMesh[] = [];
  const hubRadius = Math.max(5.5, minDim * 0.15);
  const collarY = pyramidHeight - Math.max(1.8, minDim * 0.045);
  const rotorY = Math.min(EXTRACTOR_VISUAL_HEIGHT - 6, pyramidHeight + Math.max(4, minDim * 0.1));

  // MIN+ silhouette — base ring + chimney column. These are the
  // major masses that make the building read as an extractor at any
  // zoom level. Stripping them at min would collapse the building
  // back to "just a pyramid" which doesn't communicate the function.
  details.push(detail(
    makeCylinder(
      extractorDarkMat,
      Math.min(footprintRadius * 0.92, Math.max(12, minDim * 0.45)),
      5,
      0,
      2.5,
      0,
      hexCylinderGeom,
    ),
    'min',
  ));
  details.push(detail(
    makeCylinder(chimneyMat, hubRadius * 1.05, Math.max(8, rotorY - collarY), 0, (collarY + rotorY) * 0.5, 0, hexCylinderGeom),
    'min',
  ));

  // HIGH+ decorative — cap sphere where the chimney meets the rotor
  // mount. Lower LODs keep the six-blade motion silhouette but drop
  // this trim.
  const cap = makeSphere(primaryMat, hubRadius * 1.28, 0, rotorY, 0);
  details.push(detail(cap, 'high'));

  // HIGH+ decorative — collar ring around the pyramid's top edge.
  // Visually "tightens" the seam between the pyramid and the chimney.
  details.push(detail(
    makeCylinder(factoryFrameMat, Math.max(15, minDim * 0.38), 4.5, 0, collarY, 0, hexCylinderGeom),
    'high',
  ));

  // MAX decorative — top-cap collar around the rotor base. Fine
  // detail right next to the rotor; only worth drawing when the
  // camera is close enough to the rotor itself to read it.
  details.push(detail(
    makeCylinder(factoryFrameMat, hubRadius * 2.15, 4.2, 0, rotorY - 2.5, 0, hexCylinderGeom),
    'max',
  ));

  const bladeLen = Math.max(32, minDim * 0.86);
  const bladeWidth = Math.max(10, minDim * 0.2);
  const bladeThickness = Math.max(4.5, minDim * 0.11);
  const bladeRootRadius = Math.max(hubRadius * 1.7, minDim * 0.28);

  // MIN..MEDIUM rotor — all six blades remain visible and rotating so
  // the silhouette is stable across LODs. Lower tiers only strip the
  // cutting-edge glow and trim.
  const simpleRotor = makeExtractorRotor(
    bladeLen, bladeWidth, bladeThickness,
    6, rotorY, Math.PI / 6, bladeRootRadius, 0.5,
    /* withCuttingEdgeGlow */ false,
  );
  details.push(detail(simpleRotor, 'min', 'medium', 'extractorRotor'));

  // HIGH+ rotor — full six-blade rotor with glowing cutting edges.
  // Mutually exclusive tier range with the simple rotor (maxTier on
  // the simple variant = 'medium') so exactly one is visible per
  // frame; the LOD swap is a free visibility toggle.
  const fullRotor = makeExtractorRotor(
    bladeLen, bladeWidth, bladeThickness,
    6, rotorY, Math.PI / 6, bladeRootRadius, 0.5,
    /* withCuttingEdgeGlow */ true,
  );
  details.push(detail(fullRotor, 'high', undefined, 'extractorRotor'));

  return {
    primary: base,
    details,
    height: pyramidHeight,
    extractorRig: { rotors: [simpleRotor, fullRotor] },
  };
}

// ── Per-type builders ──────────────────────────────────────────────────

/** Solar collector LOD ladder:
 *    marker — cheap team box handled by Render3DEntities
 *    min    — single photovoltaic pyramid
 *    low    — animated solid petals + solar faces
 *    medium — team-color backing panels on petal exteriors
 *    high   — coarse photovoltaic cell lines
 *    max    — denser/brighter photovoltaic cell lines
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

  for (const sign of [-1, 1]) {
    const frontBackClosedDir = new THREE.Vector3(0, SOLAR_HEIGHT, -sign * frontBackZ);
    const frontBackPanelSide = new THREE.Vector3(0, 0, -sign);
    const frontBackPyramidPanelSide = new THREE.Vector3(0, 0, sign);
    const frontBackPyramidDir = new THREE.Vector3(0, SOLAR_HEIGHT, -sign * frontBackZ);
    details.push(detail(makeSolarStaticPanelOverlay(
      solarPanelCoarseLineGeom,
      solarPanelCoarseLineMat,
      frontBackSpan,
      frontBackLen,
      0,
      petalHingeY,
      sign * frontBackZ,
      1,
      0,
      frontBackPyramidDir,
      1.1,
      frontBackPyramidPanelSide,
    ), 'high', 'high', 'solarPanel'));
    details.push(detail(makeSolarStaticPanelOverlay(
      solarPanelFineLineGeom,
      solarPanelFineLineMat,
      frontBackSpan,
      frontBackLen,
      0,
      petalHingeY,
      sign * frontBackZ,
      1,
      0,
      frontBackPyramidDir,
      1.25,
      frontBackPyramidPanelSide,
    ), 'max', undefined, 'solarPanel'));
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
    details.push(detail(makeSolarPetalOverlay(
      solarPanelCoarseLineGeom,
      solarPanelCoarseLineMat,
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
      petalFaceOffset + 0.65,
      frontBackClosedDir,
      frontBackPanelSide,
    ), 'high', 'high', 'solarPanel'));
    details.push(detail(makeSolarPetalOverlay(
      solarPanelFineLineGeom,
      solarPanelFineLineMat,
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
      petalFaceOffset + 0.8,
      frontBackClosedDir,
      frontBackPanelSide,
    ), 'max', undefined, 'solarPanel'));

    const sideClosedDir = new THREE.Vector3(-sign * sideX, SOLAR_HEIGHT, 0);
    const sidePanelSide = new THREE.Vector3(-sign, 0, 0);
    const sidePyramidPanelSide = new THREE.Vector3(sign, 0, 0);
    const sidePyramidDir = new THREE.Vector3(-sign * sideX, SOLAR_HEIGHT, 0);
    details.push(detail(makeSolarStaticPanelOverlay(
      solarPanelCoarseLineGeom,
      solarPanelCoarseLineMat,
      sideSpan,
      sideLen,
      sign * sideX,
      petalHingeY,
      0,
      0,
      1,
      sidePyramidDir,
      1.1,
      sidePyramidPanelSide,
    ), 'high', 'high', 'solarPanel'));
    details.push(detail(makeSolarStaticPanelOverlay(
      solarPanelFineLineGeom,
      solarPanelFineLineMat,
      sideSpan,
      sideLen,
      sign * sideX,
      petalHingeY,
      0,
      0,
      1,
      sidePyramidDir,
      1.25,
      sidePyramidPanelSide,
    ), 'max', undefined, 'solarPanel'));
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
    details.push(detail(makeSolarPetalOverlay(
      solarPanelCoarseLineGeom,
      solarPanelCoarseLineMat,
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
      petalFaceOffset + 0.65,
      sideClosedDir,
      sidePanelSide,
    ), 'high', 'high', 'solarPanel'));
    details.push(detail(makeSolarPetalOverlay(
      solarPanelFineLineGeom,
      solarPanelFineLineMat,
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
      petalFaceOffset + 0.8,
      sideClosedDir,
      sidePanelSide,
    ), 'max', undefined, 'solarPanel'));
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
    makeCylinder(windGlowMat, Math.max(8.5, minDim * 0.34), 2.5, 0, baseH + 6.8, 0, hexCylinderGeom),
    'medium',
  ));
  details.push(detail(
    makeCylinder(windTowerMat, towerRadius, towerH, 0, towerH / 2, 0),
    'low',
  ));
  details.push(detail(
    makeCylinder(windTrimMat, towerRadius * 1.34, 4, 0, towerH * 0.38, 0, hexCylinderGeom),
    'medium',
  ));
  details.push(detail(
    makeCylinder(windTrimMat, towerRadius * 1.5, 4.5, 0, towerH * 0.72, 0, hexCylinderGeom),
    'medium',
  ));

  const conduitH = towerH * 0.68;
  for (const side of [-1, 1]) {
    details.push(detail(makeBox(
      windGlowMat,
      Math.max(0.9, towerRadius * 0.18),
      conduitH,
      Math.max(0.75, towerRadius * 0.14),
      side * towerRadius * 1.22,
      towerH * 0.5,
      towerRadius * 0.52,
    ), 'high'));
  }

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

/** Factory: compact radial construction tower. No yard geometry is
 *  drawn; only the small tower footprint exists visually/gameplay-wise. */
function buildFactory(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const primary = new THREE.Mesh(cylinderGeom, primaryMat);
  const details: BuildingDetailMesh[] = [];

  const metrics = getFactoryBuildingVisualMetrics(width, depth);

  details.push(detail(
    makeCylinder(hazardStripeMat, metrics.collarRadius, 10, 0, metrics.baseHeight + 5, 0, hexCylinderGeom),
    'low',
  ));
  details.push(detail(
    makeCylinder(
      chimneyMat,
      metrics.towerRadius,
      metrics.towerHeight,
      0,
      metrics.towerBaseY + metrics.towerHeight / 2,
      0,
    ),
    'low',
  ));

  // 3 structural pylons evenly spaced around the tower — one per
  // resource (energy / mana / metal). Each is a thin inner cylinder
  // wrapped by a thicker translucent "shower" cylinder that fills
  // bottom-up with the live transfer rate. The inner pylon is
  // intentionally narrower than the shower so the colored shower
  // reads as clearly outside the structural shaft.
  const showerMats = [factoryEnergyShowerMat, factoryManaShowerMat, factoryMetalShowerMat];
  const showers: THREE.Mesh[] = [];
  const innerPylonRadius = metrics.pylonRadius * 0.45;
  const showerRadius = metrics.pylonRadius * 1.85;
  const pylonBaseY = metrics.towerBaseY;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const px = Math.cos(a) * metrics.pylonOffset;
    const pz = Math.sin(a) * metrics.pylonOffset;
    details.push(detail(
      makeCylinder(
        factoryFrameMat,
        innerPylonRadius,
        metrics.pylonHeight,
        px,
        pylonBaseY + metrics.pylonHeight / 2,
        pz,
      ),
      'medium',
    ));
    // Shower starts hidden + zero-height; updateFactoryConstructionRig
    // scales scale.y and offsets position.y per resource rate fraction.
    const shower = makeCylinder(
      showerMats[i],
      showerRadius,
      1, // unit height — driver rescales per-frame
      px,
      pylonBaseY,
      pz,
    );
    shower.visible = false;
    shower.renderOrder = 6;
    showers.push(shower);
    details.push(detail(shower, 'medium', undefined, 'factoryShower'));
  }

  details.push(detail(
    makeCylinder(
      hazardStripeMat,
      metrics.collarRadius * 0.82,
      8,
      0,
      metrics.towerBaseY + metrics.towerHeight * 0.56,
      0,
      hexCylinderGeom,
    ),
    'medium',
  ));

  details.push(detail(
    makeCylinder(hazardStripeMat, metrics.collarRadius * 0.72, 10, 0, metrics.capY, 0, hexCylinderGeom),
    'medium',
  ));

  const nozzle = makeSphere(
    constructionCoreMat,
    metrics.nozzleRadius,
    0,
    metrics.nozzleY,
    0,
  );
  details.push(detail(nozzle, 'medium'));
  details.push(detail(
    makeCylinder(
      hazardStripeMat,
      metrics.nozzleRadius * 1.18,
      5,
      0,
      metrics.nozzleY - metrics.nozzleRadius * 0.62,
      0,
      hexCylinderGeom,
    ),
    'medium',
  ));

  const unitGhost = new THREE.Mesh(constructionOrbGeom, constructionGhostMat);
  unitGhost.visible = false;
  details.push(detail(unitGhost, 'medium', undefined, 'factoryUnitGhost'));

  const unitCore = new THREE.Mesh(constructionOrbGeom, constructionCoreMat);
  unitCore.visible = false;
  details.push(detail(unitCore, 'high', undefined, 'factoryUnitCore'));

  const buildPulses: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const pulse = new THREE.Mesh(constructionOrbGeom, constructionPulseMat);
    pulse.visible = false;
    buildPulses.push(pulse);
    details.push(detail(pulse, 'medium', 'medium', 'factoryBuildPulse'));
  }

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
    height: metrics.baseHeight,
    factoryRig: {
      unitGhost,
      unitCore,
      buildPulses,
      sparks,
      nozzleLocal: new THREE.Vector3(
        nozzle.position.x,
        nozzle.position.y,
        nozzle.position.z,
      ),
      bayBaseY: 0,
      showers,
      showerRadius,
      pylonHeight: metrics.pylonHeight,
      pylonBaseY,
    },
  };
}

export function buildConstructionEmitterRig(scale: number): ConstructionEmitterRig {
  const root = new THREE.Group();
  const baseRadius = Math.max(3, scale * 0.72);
  const mastRadius = Math.max(1.2, scale * 0.18);
  const mastHeight = Math.max(7, scale * 1.05);
  const headRadius = Math.max(3, scale * 0.48);

  root.add(makeCylinder(hazardStripeMat, baseRadius, Math.max(4, scale * 0.22), 0, scale * 0.11, 0, hexCylinderGeom));
  root.add(makeCylinder(factoryFrameMat, mastRadius, mastHeight, 0, scale * 0.22 + mastHeight / 2, 0));

  const headY = scale * 0.22 + mastHeight + headRadius * 0.78;
  root.add(makeCylinder(hazardStripeMat, headRadius * 1.18, Math.max(3.5, scale * 0.18), 0, headY - headRadius * 0.62, 0, hexCylinderGeom));
  root.add(makeSphere(constructionCoreMat, headRadius, 0, headY, 0));

  return {
    group: root,
    nozzleLocal: new THREE.Vector3(0, headY, 0),
  };
}

/** Fallback — plain team-primary slab at default height, no detail. */
function buildUnknown(primaryMat: THREE.Material): BuildingShape {
  const primary = new THREE.Mesh(boxGeom, primaryMat);
  return { primary, details: [], height: DEFAULT_HEIGHT };
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
  /** When true, each blade gets an emissive cutting-edge strip along
   *  its outer face. Used at HIGH+ tier; the LOW/MEDIUM rotor variant
   *  passes false to halve the per-blade draw cost. */
  withCuttingEdgeGlow: boolean = true,
): THREE.Mesh {
  const rotor = new THREE.Mesh(cylinderGeom, invisibleMat);
  rotor.position.set(0, y, 0);

  const hubRadius = Math.max(4.5, bladeWidth * 0.68);
  const hub = makeCylinder(extractorDarkMat, hubRadius, bladeThickness * 2.7, 0, 0, 0, hexCylinderGeom);
  rotor.add(hub);

  const crown = makeSphere(extractorBladeMat, hubRadius * 0.72, 0, bladeThickness * 1.45, 0);
  rotor.add(crown);

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

    if (withCuttingEdgeGlow) {
      const edgeCenterX = centerX + normalDir.x * bladeThickness * 0.56;
      const edgeCenterY = centerY + normalDir.y * bladeThickness * 0.56;
      const edgeCenterZ = centerZ + normalDir.z * bladeThickness * 0.56;
      const cuttingEdge = makeBox(
        extractorGlowMat,
        bladeAxisLength * 0.72,
        Math.max(1.2, bladeThickness * 0.18),
        Math.max(1.2, bladeWidth * 0.16),
        edgeCenterX,
        edgeCenterY,
        edgeCenterZ,
      );
      applyBasis(cuttingEdge, bladeDir, normalDir, tangentDir);
      rotor.add(cuttingEdge);
    }
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

function makeSolarPetalOverlay(
  geometry: THREE.BufferGeometry,
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
  inset: number,
  normalOffset: number,
  closedDirection: THREE.Vector3,
  panelSideHint: THREE.Vector3,
): THREE.Mesh {
  const hinge = new THREE.Vector3(hingeX, hingeY, hingeZ);
  const tangent = new THREE.Vector3(tangentX, 0, tangentZ);
  const openDirection = new THREE.Vector3(
    outwardX * Math.cos(openAngle),
    Math.sin(openAngle),
    outwardZ * Math.cos(openAngle),
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(makeTrianglePlateMatrix(
    width,
    length,
    hinge,
    tangent,
    openDirection,
    inset,
    normalOffset,
    0,
    panelSideHint,
  ));
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
    thickness: 0,
  } satisfies SolarPetalAnimation;
  return mesh;
}

function makeSolarStaticPanelOverlay(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  width: number,
  length: number,
  hingeX: number,
  hingeY: number,
  hingeZ: number,
  tangentX: number,
  tangentZ: number,
  panelDirection: THREE.Vector3,
  normalOffset: number,
  panelSideHint: THREE.Vector3,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(makeTrianglePlateMatrix(
    width,
    length,
    new THREE.Vector3(hingeX, hingeY, hingeZ),
    new THREE.Vector3(tangentX, 0, tangentZ),
    panelDirection,
    0,
    normalOffset,
    0,
    panelSideHint,
  ));
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
  solarPanelCoarseLineGeom.dispose();
  solarPanelFineLineGeom.dispose();
  cylinderGeom.dispose();
  hexCylinderGeom.dispose();
  extractorPyramidGeom.dispose();
  factorySphereGeom.dispose();
  coneGeom.dispose();
  windBladeGeom.dispose();
  constructionOrbGeom.dispose();
  chimneyMat.dispose();
  solarCellMat.dispose();
  solarPetalBackMat.dispose();
  solarPanelCoarseLineMat.dispose();
  solarPanelFineLineMat.dispose();
  windTowerMat.dispose();
  windTrimMat.dispose();
  windNacelleMat.dispose();
  windBladeMat.dispose();
  windGlassMat.dispose();
  windGlowMat.dispose();
  extractorDarkMat.dispose();
  extractorBladeMat.dispose();
  extractorGlowMat.dispose();
  invisibleMat.dispose();
  factoryFrameMat.dispose();
  hazardStripeMat.dispose();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionPulseMat.dispose();
  constructionSparkMat.dispose();
}
