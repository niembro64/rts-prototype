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
//
// Shapes are additive — the caller owns a `THREE.Group` containing the
// whole building and plugs in the primary + detail meshes returned by
// `buildBuildingShape()`. Geometries and materials are shared per-team
// via the material cache that Render3DEntities already maintains, so no
// new allocation pressure.

import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import {
  FACTORY_BASE_VISUAL_HEIGHT,
  SOLAR_BUILDING_VISUAL_HEIGHT,
  WIND_BUILDING_VISUAL_HEIGHT,
} from '../sim/buildingAnchors';

/** Short building types we have art for. Unknown types fall back to a
 *  plain primary-color slab (same as before). */
export type BuildingShapeType = 'solar' | 'wind' | 'factory' | 'unknown';

export type BuildingDetailRole =
  | 'static'
  | 'solarLeaf'
  | 'solarPanel'
  | 'solarTeamAccent'
  | 'windRig'
  | 'factoryUnitGhost'
  | 'factoryUnitCore'
  | 'factoryBuildPulse'
  | 'factorySpark';

export type BuildingDetailMesh = {
  mesh: THREE.Mesh;
  minTier: ConcreteGraphicsQuality;
  maxTier?: ConcreteGraphicsQuality;
  role?: BuildingDetailRole;
};

export type SolarPetalAnimation = {
  openMatrix: THREE.Matrix4;
  closedMatrix: THREE.Matrix4;
};

export type FactoryConstructionRig = {
  unitGhost: THREE.Mesh;
  unitCore: THREE.Mesh;
  buildPulses: THREE.Mesh[];
  sparks: THREE.Mesh[];
  nozzleLocal: THREE.Vector3;
  bayBaseY: number;
};

export type WindTurbineRig = {
  root: THREE.Mesh;
  rotor: THREE.Mesh;
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
};

// ── Standard dimensions ────────────────────────────────────────────────
/** Default fallback block height for unknown buildings. */
const DEFAULT_HEIGHT = 120;
/** Solar collector silhouette is a squat opened pyramid, but tall enough
 *  for the photovoltaic faces to read as the main structure. */
const SOLAR_HEIGHT = SOLAR_BUILDING_VISUAL_HEIGHT;
const WIND_HEIGHT = WIND_BUILDING_VISUAL_HEIGHT;
/** Factory primary is the compact cylindrical base of the tower. */
const FACTORY_BASE_HEIGHT = FACTORY_BASE_VISUAL_HEIGHT;

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
const factorySphereGeom = new THREE.SphereGeometry(1, 18, 12);
const coneGeom = new THREE.ConeGeometry(0.5, 1, 18);
const windBladeGeom = createWindBladeGeometry();

// Slightly lighter gray for structural columns/gantries.
const chimneyMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
// Solar-panel glass uses the same PBR trick as mirror panels: metalness=1
// and near-zero roughness reflect the scene PMREM, while the dark blue
// base tint keeps it reading as photovoltaic glass.
const solarCellMat = new THREE.MeshStandardMaterial({
  color: 0x123a58,
  metalness: 1.0,
  roughness: 0.02,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -4,
});
const solarPetalBackMat = new THREE.MeshLambertMaterial({
  color: 0x2b3036,
  side: THREE.DoubleSide,
});
const windTowerMat = new THREE.MeshLambertMaterial({ color: 0x33404d });
const windTrimMat = new THREE.MeshLambertMaterial({ color: 0x172331 });
const windNacelleMat = new THREE.MeshStandardMaterial({
  color: 0xe7f0f8,
  metalness: 0.48,
  roughness: 0.16,
});
const windBladeMat = new THREE.MeshStandardMaterial({
  color: 0xf7fbff,
  metalness: 0.38,
  roughness: 0.14,
});
const windGlassMat = new THREE.MeshStandardMaterial({
  color: 0x123a58,
  metalness: 1.0,
  roughness: 0.04,
});
const windGlowMat = new THREE.MeshBasicMaterial({
  color: 0x73e8ff,
  transparent: true,
  opacity: 0.82,
  depthWrite: false,
});
const invisibleMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0,
  depthWrite: false,
});
const factoryFrameMat = new THREE.MeshLambertMaterial({ color: 0x2c3038 });
const constructionGhostMat = new THREE.MeshLambertMaterial({
  color: 0x8fdcff,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
});
const constructionCoreMat = new THREE.MeshBasicMaterial({
  color: 0xffe08a,
  transparent: true,
  opacity: 0.8,
  depthWrite: false,
});
const constructionSparkMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.85,
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
  vec3 yellow = vec3(1.0, 0.78, 0.04);
  vec3 black = vec3(0.025, 0.022, 0.018);
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
      return buildSolar(width, depth, primaryMat);
    case 'wind':
      return buildWind(width, depth, primaryMat);
    case 'factory':
      return buildFactory(width, depth, primaryMat);
    default:
      return buildUnknown(primaryMat);
  }
}

// ── Per-type builders ──────────────────────────────────────────────────

/** Solar collector: a static pyramid-flower silhouette. The primary
 *  body is one wide photovoltaic pyramid. LOW+ detail adds four
 *  opened photovoltaic leaves attached at the pyramid base. */
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
    ), 'low', undefined, 'solarPanel'));

    const sideClosedDir = new THREE.Vector3(-sign * sideX, SOLAR_HEIGHT, 0);
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

  const minDim = Math.min(width, depth);
  const towerRadius = Math.max(7, minDim * 0.22);
  const collarRadius = Math.max(towerRadius * 1.35, minDim * 0.34);
  const towerH = Math.max(78, minDim * 1.9);
  const towerBaseY = FACTORY_BASE_HEIGHT;

  details.push(detail(
    makeCylinder(hazardStripeMat, collarRadius, 10, 0, FACTORY_BASE_HEIGHT + 5, 0, hexCylinderGeom),
    'low',
  ));
  details.push(detail(
    makeCylinder(chimneyMat, towerRadius, towerH, 0, towerBaseY + towerH / 2, 0),
    'low',
  ));

  const pylonRadius = Math.max(2.3, minDim * 0.055);
  const pylonOffset = Math.min(minDim * 0.38, collarRadius * 1.15);
  const pylonH = towerH * 0.66;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    details.push(detail(
      makeCylinder(
        factoryFrameMat,
        pylonRadius,
        pylonH,
        Math.cos(a) * pylonOffset,
        towerBaseY + pylonH / 2,
        Math.sin(a) * pylonOffset,
      ),
      'medium',
    ));
  }

  details.push(detail(
    makeCylinder(hazardStripeMat, collarRadius * 0.82, 8, 0, towerBaseY + towerH * 0.56, 0, hexCylinderGeom),
    'medium',
  ));

  const capY = towerBaseY + towerH + 5;
  details.push(detail(
    makeCylinder(hazardStripeMat, collarRadius * 0.72, 10, 0, capY, 0, hexCylinderGeom),
    'medium',
  ));

  const nozzleRadius = Math.max(6, towerRadius * 0.95);
  const nozzleY = capY + 5 + nozzleRadius * 0.45;
  const nozzle = makeSphere(
    constructionCoreMat,
    nozzleRadius,
    0,
    nozzleY,
    0,
  );
  details.push(detail(nozzle, 'medium'));
  details.push(detail(
    makeCylinder(hazardStripeMat, nozzleRadius * 1.18, 5, 0, nozzleY - nozzleRadius * 0.62, 0, hexCylinderGeom),
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
    const pulse = new THREE.Mesh(constructionOrbGeom, constructionCoreMat);
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
    height: FACTORY_BASE_HEIGHT,
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
  );
  if (closedDirection) {
    mesh.userData.solarPetal = {
      openMatrix: mesh.matrix.clone(),
      closedMatrix: makeTrianglePlateMatrix(
        width,
        length,
        hinge,
        tangent,
        closedDirection,
        inset,
        normalOffset,
        thickness,
      ),
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
): THREE.Mesh {
  const mesh = new THREE.Mesh(thickness > 0 ? solarTrianglePetalGeom : solarTrianglePanelGeom, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(makeTrianglePlateMatrix(width, length, hinge, tangent, petalDirection, inset, normalOffset, thickness));
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
): THREE.Matrix4 {
  const tangentDir = tangent.clone().normalize();
  const petalDir = petalDirection.clone().normalize();
  const normal = new THREE.Vector3().crossVectors(tangentDir, petalDir).normalize();
  if (normal.y < 0) normal.multiplyScalar(-1);
  const origin = hinge.clone()
    .addScaledVector(petalDir, inset)
    .addScaledVector(normal, normalOffset);
  const xAxis = tangentDir.multiplyScalar(width);
  const yAxis = petalDir.multiplyScalar(Math.max(1, length - inset));
  const zAxis = normal.multiplyScalar(Math.max(1, thickness));
  const matrix = new THREE.Matrix4();
  matrix.makeBasis(xAxis, yAxis, zAxis);
  matrix.setPosition(origin);
  return matrix;
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
  factorySphereGeom.dispose();
  coneGeom.dispose();
  windBladeGeom.dispose();
  constructionOrbGeom.dispose();
  chimneyMat.dispose();
  solarCellMat.dispose();
  solarPetalBackMat.dispose();
  windTowerMat.dispose();
  windTrimMat.dispose();
  windNacelleMat.dispose();
  windBladeMat.dispose();
  windGlassMat.dispose();
  windGlowMat.dispose();
  invisibleMat.dispose();
  factoryFrameMat.dispose();
  hazardStripeMat.dispose();
  constructionGhostMat.dispose();
  constructionCoreMat.dispose();
  constructionSparkMat.dispose();
}
