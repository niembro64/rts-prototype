// TechBuildingsMesh3D — two curve-heavy research campuses.
//
//   buildingShieldTargetingTech — "the oracle calibration lab": an
//     octagonal test-court foundation carrying four domed experiment pods
//     and a twisted hyperboloid spire wrapped by counter-rotating helical
//     ribbons, crowned with a floating targeting oculus inside tilted halo
//     rings and three down-swept antenna petals.
//   buildingShieldTech — "the aegis containment lab": a pointed shield
//     foundation under a bulky S-curved lathe dome, hugged by staggered
//     nautilus shell plates, flanked by three research wings and two
//     tusk-like horn pylons, and capped by a live force bubble.
//
// Their foundations are authored polygons rather than scaled square slabs,
// so the visible bases and pixel-cell reservations describe the same idea.
// Every curved geometry is memoized per LOD tier; spires, ribbons, shells,
// horns and petals simplify their tessellation between rungs while their
// authored transforms stay identical across tiers (the LOD anchor contract).

import * as THREE from 'three';
import { BUILDING_PALETTE, SHINY_GRAY_METAL_MATERIAL } from './BuildingVisualPalette';
import {
  SHIELD_TARGETING_TECH_BUILDING_VISUAL_HEIGHT,
  SHIELD_TECH_BUILDING_VISUAL_HEIGHT,
} from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import {
  detail,
  hexCylinderGeom,
  makeBox,
  makeCylinder,
  makeSphere,
  teamOrnamentDetail,
  getActiveBuildingGeometryTier,
} from './BuildingMeshPrimitives3D';
import {
  createPrimitiveHemisphereGeometry,
  createPrimitiveRingGeometry,
  getOrCreate,
  getSharedPrimitiveTetrahedronGeometry,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';
import {
  createBuildingOperationalPosePart,
  createBuildingOperationalRig,
  type BuildingOperationalPosePart,
} from './BuildingOperationalRig3D';

// ── Shared materials ───────────────────────────────────────────────────
const techFrameMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureMid });
const techDarkMat = new THREE.MeshLambertMaterial({ color: BUILDING_PALETTE.structureDark });
const techShellMat = new THREE.MeshStandardMaterial({
  ...SHINY_GRAY_METAL_MATERIAL,
  side: THREE.DoubleSide,
});
const techGlowMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlow,
  transparent: true,
  opacity: 0.55,
  depthWrite: false,
});
const techBubbleMat = new THREE.MeshBasicMaterial({
  color: BUILDING_PALETTE.cyanGlass,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/** Extrusion depth of an authored foundation polygon, as a fraction of the
 *  host's visual height. Everything that stands on the deck derives its base
 *  from this, so a taller lab keeps its superstructure above the slab. */
const LAB_FOUNDATION_DEPTH = 0.12;

// ── Tiered curved geometry caches ──────────────────────────────────────
const spirePrimaryGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const spireShaftGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const spireRibbonGeomByKey = new Map<string, THREE.BufferGeometry>();
const spirePetalGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const spireHaloGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const podDomeGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgePrimaryGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeDomeGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeShellGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeHornGeomByKey = new Map<string, THREE.BufferGeometry>();
const forgeRingGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();

function getSpirePrimaryGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(spirePrimaryGeomByTier, tier, () => createLabFoundationGeometry(
    [
      [-0.24, -0.48], [0.24, -0.48], [0.39, -0.39], [0.48, -0.24],
      [0.48, 0.24], [0.39, 0.39], [0.24, 0.48], [-0.24, 0.48],
      [-0.39, 0.39], [-0.48, 0.24], [-0.48, -0.24], [-0.39, -0.39],
    ],
    [
      [-0.075, -0.075], [-0.075, 0.075], [0.075, 0.075], [0.075, -0.075],
    ],
    tier,
  ));
}

function createLabFoundationGeometry(
  outline: readonly (readonly [number, number])[],
  hole: readonly (readonly [number, number])[] | null,
  tier: PrimitiveGeometryTier,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
  shape.closePath();
  if (hole !== null) {
    const path = new THREE.Path();
    path.moveTo(hole[0][0], hole[0][1]);
    for (let i = 1; i < hole.length; i++) path.lineTo(hole[i][0], hole[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: LAB_FOUNDATION_DEPTH,
    steps: 1,
    bevelEnabled: tier !== 'far',
    bevelSegments: tier === 'close' ? 2 : 1,
    bevelSize: 0.012,
    bevelThickness: 0.012,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -0.5, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/** Twisted hyperboloid pylon, normalized to the unit box the caller scales
 *  by (span, height, span): Y spans [-0.5, 0.5]; the radius pinches to a
 *  waist and re-flares while the cross-section rotates. The waist is kept
 *  deliberately thick so the shaft reads as a bulky lab core rather than a
 *  wire sculpture. */
function createTwistedSpireGeometry(
  radialSegments: number,
  heightSegments: number,
  twistRad: number,
): THREE.BufferGeometry {
  const bottomRadius = 0.46;
  const waistRadius = 0.25;
  const topRadius = 0.32;
  const waistT = 0.58;
  const positions: number[] = [];
  const ringStart: number[] = [];
  const radiusAt = (t: number): number => {
    // Two quadratic arcs meeting at the waist keep the flank visibly
    // concave the whole way up — the hyperboloid silhouette.
    if (t < waistT) {
      const u = t / waistT;
      return bottomRadius + (waistRadius - bottomRadius) * u * (2 - u);
    }
    const u = (t - waistT) / (1 - waistT);
    return waistRadius + (topRadius - waistRadius) * u * u;
  };
  for (let h = 0; h <= heightSegments; h++) {
    const t = h / heightSegments;
    const radius = radiusAt(t);
    const twist = twistRad * t;
    ringStart.push(positions.length / 3);
    for (let r = 0; r < radialSegments; r++) {
      const angle = (r / radialSegments) * Math.PI * 2 + twist;
      positions.push(Math.cos(angle) * radius, t - 0.5, Math.sin(angle) * radius);
    }
  }
  const bottomCenter = positions.length / 3;
  positions.push(0, -0.5, 0);
  const topCenter = positions.length / 3;
  positions.push(0, 0.5, 0);

  const indices: number[] = [];
  for (let h = 0; h < heightSegments; h++) {
    for (let r = 0; r < radialSegments; r++) {
      const a = ringStart[h] + r;
      const b = ringStart[h] + ((r + 1) % radialSegments);
      const c = ringStart[h + 1] + r;
      const d = ringStart[h + 1] + ((r + 1) % radialSegments);
      indices.push(a, c, d, a, d, b);
    }
  }
  for (let r = 0; r < radialSegments; r++) {
    indices.push(bottomCenter, ringStart[0] + r, ringStart[0] + ((r + 1) % radialSegments));
    const top = ringStart[heightSegments];
    indices.push(topCenter, top + ((r + 1) % radialSegments), top + r);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

function getSpireShaftGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(spireShaftGeomByTier, tier, () => tier === 'close'
    ? createTwistedSpireGeometry(10, 6, 2.4)
    : tier === 'mid'
      ? createTwistedSpireGeometry(8, 4, 2.4)
      : createTwistedSpireGeometry(5, 2, 2.4));
}

/** Helical ribbon in world units, spiralling around the spire between
 *  yBottom and yTop while its orbit radius eases inward. */
function createHelixRibbonGeometry(
  yBottom: number,
  yTop: number,
  radiusBottom: number,
  radiusTop: number,
  turns: number,
  phase: number,
  tubularSegments: number,
  radialSegments: number,
  tubeRadius: number,
): THREE.BufferGeometry {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const angle = phase + t * turns * Math.PI * 2;
    const radius = radiusBottom + (radiusTop - radiusBottom) * t;
    points.push(new THREE.Vector3(
      Math.cos(angle) * radius,
      yBottom + (yTop - yBottom) * t,
      Math.sin(angle) * radius,
    ));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, tubularSegments, tubeRadius, radialSegments, false);
}

type RibbonSpec = Readonly<{
  yBottom: number;
  yTop: number;
  radiusBottom: number;
  radiusTop: number;
  tubeRadius: number;
  phase: number;
}>;

function getSpireRibbonGeometry(
  tier: PrimitiveGeometryTier,
  spec: RibbonSpec,
): THREE.BufferGeometry {
  const key = `${tier}:${spec.phase}:${spec.yBottom}:${spec.yTop}:`
    + `${spec.radiusBottom}:${spec.radiusTop}:${spec.tubeRadius}`;
  return getOrCreate(spireRibbonGeomByKey, key, () => createHelixRibbonGeometry(
    spec.yBottom,
    spec.yTop,
    spec.radiusBottom,
    spec.radiusTop,
    2.4,
    spec.phase,
    tier === 'close' ? 20 : tier === 'mid' ? 10 : 5,
    3,
    spec.tubeRadius,
  ));
}

/** One antenna petal arcing outward and down from the crown. Built along
 *  local axes and rotated into place per instance. */
function getSpirePetalGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(spirePetalGeomByTier, tier, () => {
    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(10, 6, 0),
      new THREE.Vector3(21, 2, 0),
      new THREE.Vector3(26, -12, 0),
    );
    return new THREE.TubeGeometry(
      curve,
      tier === 'close' ? 7 : tier === 'mid' ? 5 : 3,
      1.3,
      3,
      false,
    );
  });
}

function getSpireHaloGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(spireHaloGeomByTier, tier, () =>
    createPrimitiveRingGeometry('building', tier, 0.84, 1.0));
}

/** Flattened dome cap for the experiment pods and research wings, unit
 *  radius. The prisms underneath are low-segment, so the cap is authored one
 *  quality rung below its host tier: a fully smooth hemisphere costs several
 *  times the triangles and reads as a different material set bolted on. */
function getPodDomeGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(podDomeGeomByTier, tier, () =>
    createPrimitiveHemisphereGeometry('building', tier === 'close' ? 'mid' : 'far', 1));
}

/** Faceted core for the crowning glow. A smooth sphere is wasted on an
 *  additive, half-transparent piece this small. */
const crownGlowGeom = new THREE.OctahedronGeometry(1);

export function buildShieldTargetingTechMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = SHIELD_TARGETING_TECH_BUILDING_VISUAL_HEIGHT;
  const tier = getActiveBuildingGeometryTier();
  const minDim = Math.min(width, depth);
  const primary = new THREE.Mesh(getSpirePrimaryGeometry(tier), primaryMat);
  const details: BuildingShape['details'] = [];
  const operationalParts: BuildingOperationalPosePart[] = [];
  const deckY = height * LAB_FOUNDATION_DEPTH;

  // Four domed experiment pods ringing the open test court.
  const podRadius = minDim * 0.115;
  const podOrbit = minDim * 0.325;
  const podHeight = Math.max(34, height * 0.21);
  for (let i = 0; i < 4; i++) {
    const yaw = Math.PI * 0.25 + i * Math.PI * 0.5;
    const x = Math.cos(yaw) * podOrbit;
    const z = Math.sin(yaw) * podOrbit;
    const connector = makeBox(
      techFrameMat,
      podOrbit * 0.88,
      11,
      minDim * 0.08,
      x * 0.46,
      deckY + 6,
      z * 0.46,
    );
    connector.rotation.y = -yaw;
    details.push(detail(connector, 'low'));

    details.push(detail(
      makeCylinder(techShellMat, podRadius, podHeight, x, deckY + podHeight / 2, z),
      'min',
    ));
    const podDome = new THREE.Mesh(getPodDomeGeometry(tier), techShellMat);
    podDome.position.set(x, deckY + podHeight, z);
    podDome.scale.set(podRadius * 0.92, podRadius * 0.58, podRadius * 0.92);
    details.push(detail(podDome, 'min'));

    const window = makeBox(
      techGlowMat,
      podRadius * 1.2,
      9,
      3,
      x * (1 + podRadius / podOrbit),
      deckY + podHeight * 0.66,
      z * (1 + podRadius / podOrbit),
    );
    window.rotation.y = -yaw;
    details.push(detail(
      window,
      'low',
      undefined,
      'tinyTrim',
    ));
  }

  // The twisted calibration spire standing in the court, with a plinth wide
  // enough to bridge the reserved cells it rises out of.
  const plinthHeight = height * 0.05;
  details.push(detail(
    makeCylinder(
      techDarkMat,
      minDim * 0.235,
      plinthHeight,
      0,
      deckY + plinthHeight / 2,
      0,
      hexCylinderGeom,
    ),
    'min',
  ));
  const spireBaseY = deckY + plinthHeight;
  const spireTopY = height * 0.74;
  const spireHeight = spireTopY - spireBaseY;
  const spireSpan = minDim * 0.40;
  const spire = new THREE.Mesh(getSpireShaftGeometry(tier), techShellMat);
  spire.position.y = spireBaseY + spireHeight / 2;
  spire.scale.set(spireSpan, spireHeight, spireSpan);
  details.push(detail(spire, 'min'));

  // Counter-rotating helical ribbons. The detail list is identical at every
  // tier (the LOD anchor contract); only the tube tessellation simplifies.
  // The second ribbon is tagged tinyTrim so the runtime detail-level gate
  // can drop it first.
  const ribbonBase: Omit<RibbonSpec, 'phase'> = {
    yBottom: spireBaseY + minDim * 0.02,
    yTop: height * 0.71,
    radiusBottom: minDim * 0.245,
    radiusTop: minDim * 0.145,
    tubeRadius: minDim * 0.018,
  };
  details.push(detail(
    new THREE.Mesh(getSpireRibbonGeometry(tier, { ...ribbonBase, phase: 0 }), techShellMat),
    'low',
  ));
  details.push(detail(
    new THREE.Mesh(getSpireRibbonGeometry(tier, { ...ribbonBase, phase: Math.PI }), techShellMat),
    'low',
    undefined,
    'tinyTrim',
  ));

  // Crown: the floating oculus above a narrow neck, ringed by tilted halos.
  const neckHeight = height * 0.14;
  details.push(detail(
    makeCylinder(
      techFrameMat,
      minDim * 0.036,
      neckHeight,
      0,
      spireTopY + neckHeight * 0.5,
      0,
      hexCylinderGeom,
    ),
    'low',
  ));

  const crownY = height * 0.9;
  const crownStowY = height * 0.56;
  const crown = makeSphere(techDarkMat, minDim * 0.075, 0, crownY, 0);
  details.push(detail(crown, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(crown, {
    closedPosition: new THREE.Vector3(0, crownStowY, 0),
    closedScale: crown.scale.clone().multiplyScalar(0.72),
  }));
  const crownGlow = new THREE.Mesh(crownGlowGeom, techGlowMat);
  crownGlow.position.set(0, crownY + 3, 0);
  crownGlow.scale.setScalar(minDim * 0.046);
  details.push(detail(crownGlow, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(crownGlow, {
    closedPosition: new THREE.Vector3(0, crownStowY, 0),
    closedScale: crownGlow.scale.clone().multiplyScalar(0.34),
    motion: {
      bobAmplitude: Math.max(1.2, minDim * 0.01),
      bobHz: 0.58,
      pulseAmplitude: 0.12,
      pulseHz: 0.82,
    },
  }));

  for (const [index, tilt] of [0.34, -0.42].entries()) {
    const halo = new THREE.Mesh(getSpireHaloGeometry(tier), techGlowMat);
    halo.position.y = crownY;
    halo.rotation.set(Math.PI / 2 + tilt, index === 0 ? 0.24 : -0.38, 0);
    const radius = minDim * (index === 0 ? 0.16 : 0.225);
    halo.scale.set(radius, radius, 1);
    details.push(detail(halo, index === 0 ? 'min' : 'low', undefined, index === 0 ? undefined : 'tinyTrim'));
    operationalParts.push(createBuildingOperationalPosePart(halo, {
      closedPosition: new THREE.Vector3(0, crownStowY, 0),
      closedScale: new THREE.Vector3(radius * 0.42, radius * 0.42, 0.55),
      motion: {
        spinAxis: new THREE.Vector3(0, 1, 0),
        spinRadPerSec: index === 0 ? 0.92 : -0.72,
        phaseOffset: index * 0.4,
      },
    }));
  }

  // Three antenna petals swept outward and down from just below the oculus.
  for (let i = 0; i < 3; i++) {
    const petal = new THREE.Mesh(getSpirePetalGeometry(tier), techFrameMat);
    petal.position.y = crownY - minDim * 0.03;
    petal.rotation.y = (i / 3) * Math.PI * 2;
    petal.scale.setScalar(minDim / 135);
    details.push(detail(petal, 'low', undefined, 'tinyTrim'));
    operationalParts.push(createBuildingOperationalPosePart(petal, {
      closedPosition: new THREE.Vector3(0, crownStowY, 0),
      closedScale: petal.scale.clone().multiplyScalar(0.45),
    }));
  }

  const crownCollar = makeCylinder(
    primaryMat,
    minDim * 0.085,
    7,
    0,
    height * 0.755,
    0,
    hexCylinderGeom,
  );
  details.push(teamOrnamentDetail(
    crownCollar,
    'targetingSpireHalo',
  ));
  operationalParts.push(createBuildingOperationalPosePart(crownCollar, {
    closedPosition: new THREE.Vector3(0, height * 0.6, 0),
    closedScale: crownCollar.scale.clone().multiplyScalar(0.82),
  }));

  return {
    primary,
    details,
    height,
    operationalRig: createBuildingOperationalRig(
      operationalParts,
      { chassisClosedScaleY: 0.9 },
    ),
  };
}

function getForgePrimaryGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgePrimaryGeomByTier, tier, () => createLabFoundationGeometry(
    [
      [-0.32, -0.48], [0.32, -0.48], [0.48, -0.34], [0.48, 0.08],
      [0.4, 0.24], [0.25, 0.36], [0, 0.5], [-0.25, 0.36],
      [-0.4, 0.24], [-0.48, 0.08], [-0.48, -0.34],
    ],
    null,
    tier,
  ));
}

/** S-curved containment dome, normalized to the unit box the caller scales
 *  by (span, height, span): base flare, mid bulge, pinched neck and an
 *  emitter shoulder. Both ends close on the axis, so the lathe alone is a
 *  solid grounded machine. */
function getForgeDomeGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgeDomeGeomByTier, tier, () => {
    const profile: [number, number][] = tier === 'close'
      ? [
        [0, -0.5], [0.47, -0.5], [0.5, -0.34], [0.46, -0.18], [0.36, -0.02],
        [0.26, 0.12], [0.2, 0.26], [0.23, 0.38], [0.12, 0.46], [0, 0.5],
      ]
      : tier === 'mid'
        ? [[0, -0.5], [0.47, -0.5], [0.5, -0.3], [0.4, -0.06], [0.22, 0.2], [0.21, 0.38], [0, 0.5]]
        : [[0, -0.5], [0.47, -0.5], [0.44, -0.1], [0.18, 0.3], [0, 0.5]];
    const points = profile.map(([x, y]) => new THREE.Vector2(x, y));
    const segments = tier === 'close' ? 12 : tier === 'mid' ? 8 : 5;
    const geometry = new THREE.LatheGeometry(points, segments);
    geometry.computeVertexNormals();
    return geometry;
  });
}

/** Partial-revolve nautilus plate hugging the dome flank: a unit-radius
 *  spherical band swept through a limited arc. */
function getForgeShellGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgeShellGeomByTier, tier, () => {
    const thetaStart = 0.55;
    const thetaLength = 0.85;
    const rows = tier === 'close' ? 4 : tier === 'mid' ? 3 : 2;
    const points: THREE.Vector2[] = [];
    for (let i = 0; i <= rows; i++) {
      const theta = thetaStart + (thetaLength * i) / rows;
      points.push(new THREE.Vector2(Math.sin(theta), Math.cos(theta)));
    }
    const geometry = new THREE.LatheGeometry(
      points,
      tier === 'close' ? 9 : tier === 'mid' ? 6 : 4,
      -0.75,
      1.5,
    );
    geometry.computeVertexNormals();
    return geometry;
  });
}

type HornSpec = Readonly<{
  baseRadius: number;
  topRadius: number;
  baseY: number;
  topY: number;
  tubeRadius: number;
}>;

/** Tusk horn sweeping up and inward toward the containment bubble. */
function getForgeHornGeometry(
  tier: PrimitiveGeometryTier,
  spec: HornSpec,
): THREE.BufferGeometry {
  const key = `${tier}:${spec.baseRadius}:${spec.topRadius}:`
    + `${spec.baseY}:${spec.topY}:${spec.tubeRadius}`;
  return getOrCreate(forgeHornGeomByKey, key, () => {
    const span = spec.topY - spec.baseY;
    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(spec.baseRadius, spec.baseY, 0),
      new THREE.Vector3(spec.baseRadius * 1.18, spec.baseY + span * 0.4, 0),
      new THREE.Vector3(spec.baseRadius * 0.92, spec.baseY + span * 0.78, 0),
      new THREE.Vector3(spec.topRadius, spec.topY, 0),
    );
    return new THREE.TubeGeometry(
      curve,
      tier === 'close' ? 12 : tier === 'mid' ? 7 : 4,
      spec.tubeRadius,
      3,
      false,
    );
  });
}

function getForgeRingGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgeRingGeomByTier, tier, () =>
    createPrimitiveRingGeometry('building', tier, 0.86, 1.0));
}

export function buildShieldTechMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = SHIELD_TECH_BUILDING_VISUAL_HEIGHT;
  const tier = getActiveBuildingGeometryTier();
  const minDim = Math.min(width, depth);
  const primary = new THREE.Mesh(getForgePrimaryGeometry(tier), primaryMat);
  const details: BuildingShape['details'] = [];
  const operationalParts: BuildingOperationalPosePart[] = [];
  const deckY = height * LAB_FOUNDATION_DEPTH;

  // The bulky S-curved containment dome is the building's mass; the wings
  // and shells are read against it rather than against a hidden plinth.
  const domeSpan = minDim * 0.38;
  const domeHeight = height * 0.62;
  const domeTopY = deckY + domeHeight;
  const dome = new THREE.Mesh(getForgeDomeGeometry(tier), techShellMat);
  dome.position.y = deckY + domeHeight / 2;
  dome.scale.set(domeSpan, domeHeight, domeSpan);
  details.push(detail(dome, 'min'));

  // Three discrete research wings sit on the pointed shield foundation.
  // Their spacing leaves the silhouette readable instead of rebuilding a
  // hidden square plinth out of decorative pieces.
  const wingRadius = minDim * 0.1;
  const wingHeight = Math.max(34, height * 0.26);
  const wingPositions: readonly (readonly [number, number])[] = [
    [0, -minDim * 0.34],
    [-minDim * 0.31, minDim * 0.19],
    [minDim * 0.31, minDim * 0.19],
  ];
  for (const [x, z] of wingPositions) {
    details.push(detail(
      makeCylinder(techShellMat, wingRadius, wingHeight, x, deckY + wingHeight / 2, z),
      'min',
    ));
    const wingDome = new THREE.Mesh(getPodDomeGeometry(tier), techShellMat);
    wingDome.position.set(x, deckY + wingHeight, z);
    wingDome.scale.set(wingRadius * 0.92, wingRadius * 0.6, wingRadius * 0.92);
    details.push(detail(wingDome, 'min'));

    const yaw = Math.atan2(z, x);
    const orbit = Math.max(1, Math.hypot(x, z));
    const window = makeBox(
      techGlowMat,
      wingRadius * 1.2,
      7,
      3,
      x * (1 + wingRadius / orbit),
      deckY + wingHeight * 0.62,
      z * (1 + wingRadius / orbit),
    );
    window.rotation.y = -yaw;
    details.push(detail(
      window,
      'low',
      undefined,
      'tinyTrim',
    ));
  }

  // Staggered nautilus shell plates spiralling up the dome flank. The detail
  // list is identical at every tier (LOD anchor contract); the plate
  // tessellation carries the simplification.
  // Each plate is a spherical band whose own radius is matched to the dome's
  // local flank radius at the height it wraps, then dropped by half its
  // radius so the band straddles that height instead of ballooning past it.
  const shellBands: readonly (readonly [number, number])[] = [
    [0.1, 0.58], [0.32, 0.53], [0.54, 0.43],
  ];
  for (const [index, [heightFraction, radiusFraction]] of shellBands.entries()) {
    const shell = new THREE.Mesh(getForgeShellGeometry(tier), techShellMat);
    const shellRadius = domeSpan * radiusFraction;
    shell.rotation.y = index * 2.15;
    shell.position.y = deckY + domeHeight * heightFraction - shellRadius * 0.51;
    shell.scale.setScalar(shellRadius);
    details.push(detail(shell, 'low', undefined, 'tinyTrim'));
  }

  // The protective bubble the whole building exists to sell: a translucent
  // force sphere capping the dome's emitter shoulder.
  const bubbleRadius = minDim * 0.135;
  const bubbleY = domeTopY + bubbleRadius * 0.85;
  const bubble = makeSphere(techBubbleMat, bubbleRadius, 0, bubbleY, 0);
  details.push(detail(bubble, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(bubble, {
    closedPosition: new THREE.Vector3(0, domeTopY * 0.86, 0),
    closedScale: bubble.scale.clone().multiplyScalar(0.54),
    motion: {
      bobAmplitude: Math.max(0.7, minDim * 0.01),
      bobHz: 0.5,
      pulseAmplitude: 0.07,
      pulseHz: 0.68,
    },
  }));
  const bubbleRing = new THREE.Mesh(getForgeRingGeometry(tier), techGlowMat);
  bubbleRing.position.y = bubbleY - bubbleRadius * 0.48;
  bubbleRing.rotation.x = Math.PI / 2;
  bubbleRing.scale.set(bubbleRadius * 1.22, bubbleRadius * 1.22, 1);
  details.push(detail(bubbleRing, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(bubbleRing, {
    closedPosition: new THREE.Vector3(0, domeTopY * 0.84, 0),
    closedScale: new THREE.Vector3(
      bubbleRadius * 0.56,
      bubbleRadius * 0.56,
      0.62,
    ),
    motion: {
      spinAxis: new THREE.Vector3(0, 1, 0),
      spinRadPerSec: 0.84,
    },
  }));

  // Two tusk horns cradling the bubble from opposite sides.
  const hornSpec: HornSpec = {
    baseRadius: minDim * 0.3,
    topRadius: minDim * 0.085,
    baseY: deckY,
    topY: bubbleY + bubbleRadius * 0.7,
    tubeRadius: minDim * 0.03,
  };
  for (const yaw of [0.62, 0.62 + Math.PI]) {
    const horn = new THREE.Mesh(getForgeHornGeometry(tier, hornSpec), techShellMat);
    horn.rotation.y = yaw;
    details.push(detail(horn, 'low', undefined, 'tinyTrim'));
  }

  // A field-coil crystal caps each research wing. They retract into the wing
  // when the lab is disabled, preserving the open/closed operational language
  // without adding a second forest of masts beside the horns.
  for (const [i, [x, z]] of wingPositions.entries()) {
    const cap = new THREE.Mesh(getSharedPrimitiveTetrahedronGeometry(1), techGlowMat);
    cap.position.set(x, deckY + wingHeight + minDim * 0.05, z);
    cap.scale.setScalar(minDim * 0.055);
    details.push(detail(cap, 'low', undefined, 'tinyTrim'));
    operationalParts.push(createBuildingOperationalPosePart(cap, {
      closedPosition: new THREE.Vector3(x, deckY + wingHeight * 0.55, z),
      closedScale: cap.scale.clone().multiplyScalar(0.42),
      motion: {
        pulseAmplitude: 0.09,
        pulseHz: 0.64,
        phaseOffset: i * 0.16,
      },
    }));
  }

  // Team identity: a hex crest band around the dome's bulge.
  const crest = makeCylinder(
    primaryMat,
    domeSpan * 0.47,
    7,
    0,
    deckY + domeHeight * 0.44,
    0,
    hexCylinderGeom,
  );
  details.push(teamOrnamentDetail(
    crest,
    'shieldForgeCrest',
  ));
  operationalParts.push(createBuildingOperationalPosePart(crest, {
    closedPosition: new THREE.Vector3(0, deckY + domeHeight * 0.34, 0),
    closedScale: crest.scale.clone().multiplyScalar(0.86),
  }));

  return {
    primary,
    details,
    height,
    operationalRig: createBuildingOperationalRig(
      operationalParts,
      { chassisClosedScaleY: 0.9 },
    ),
  };
}

export function disposeTechBuildingsMeshGeoms(): void {
  for (const map of [
    spirePrimaryGeomByTier,
    spireShaftGeomByTier,
    spirePetalGeomByTier,
    spireHaloGeomByTier,
    podDomeGeomByTier,
    forgePrimaryGeomByTier,
    forgeDomeGeomByTier,
    forgeShellGeomByTier,
    forgeRingGeomByTier,
  ]) {
    for (const geometry of map.values()) geometry.dispose();
    map.clear();
  }
  for (const map of [spireRibbonGeomByKey, forgeHornGeomByKey]) {
    for (const geometry of map.values()) geometry.dispose();
    map.clear();
  }
  crownGlowGeom.dispose();
  techFrameMat.dispose();
  techDarkMat.dispose();
  techShellMat.dispose();
  techGlowMat.dispose();
  techBubbleMat.dispose();
}
