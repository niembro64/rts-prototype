// TechBuildingsMesh3D — two curve-heavy research campuses.
//
//   buildingShieldTargetingTech — "the oracle calibration lab": an
//     octagonal test-court foundation carrying four domed experiment pods
//     and a twisted hyperboloid spire, crowned with a floating targeting
//     oculus inside tilted halo rings and three down-swept antenna petals.
//   buildingShieldTech — "the aegis containment lab": a pointed shield
//     foundation under a bulky S-curved lathe dome, hugged by staggered
//     nautilus shell plates, flanked by three research wings and two
//     tusk-like horn pylons, and capped by a live force bubble.
//   buildingPrecisionTargetingTech — "the precision lab": an annular deck
//     around an open instrument court, three struts leaning inward to carry a
//     three-axis gimbal of nested rings around an alignment lens, and a
//     collimator mast above it. Nothing here is a spire or a dome: the lab
//     that removes firing randomness reads as an optical instrument.
//
// Their foundations are authored polygons rather than scaled square slabs,
// so the visible bases and pixel-cell reservations describe the same idea.
// Every curved geometry is memoized per LOD tier; spires, ribbons, shells,
// horns and petals simplify their tessellation between rungs while their
// authored transforms stay identical across tiers (the LOD anchor contract).

import * as THREE from 'three';
import { BUILDING_PALETTE, SHINY_GRAY_METAL_MATERIAL } from './BuildingVisualPalette';
import {
  PRECISION_TARGETING_TECH_BUILDING_VISUAL_HEIGHT,
  SHIELD_TARGETING_TECH_BUILDING_VISUAL_HEIGHT,
  SHIELD_TECH_BUILDING_VISUAL_HEIGHT,
} from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import {
  detail,
  hexCylinderGeom,
  makeCylinder,
  makeSphere,
  teamOrnamentDetail,
  getActiveBuildingGeometryTier,
} from './BuildingMeshPrimitives3D';
import {
  createPrimitiveHemisphereGeometry,
  createPrimitiveTorusGeometry,
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
const spirePetalGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const spireHaloGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const podDomeGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgePrimaryGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeDomeGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeShellGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeHornGeomByKey = new Map<string, THREE.BufferGeometry>();
const forgeRingGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const precisionPrimaryGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const precisionGimbalGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const precisionStrutGeomByKey = new Map<string, THREE.BufferGeometry>();

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

/** The spire's hyperboloid flank profile in unit-box space: two quadratic
 *  arcs meeting at the waist keep the flank visibly concave the whole way
 *  up. */
const SPIRE_BOTTOM_RADIUS = 0.46;
const SPIRE_WAIST_RADIUS = 0.25;
const SPIRE_TOP_RADIUS = 0.32;
const SPIRE_WAIST_T = 0.58;
function spireRadiusProfileAt(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  if (clamped < SPIRE_WAIST_T) {
    const u = clamped / SPIRE_WAIST_T;
    return SPIRE_BOTTOM_RADIUS + (SPIRE_WAIST_RADIUS - SPIRE_BOTTOM_RADIUS) * u * (2 - u);
  }
  const u = (clamped - SPIRE_WAIST_T) / (1 - SPIRE_WAIST_T);
  return SPIRE_WAIST_RADIUS + (SPIRE_TOP_RADIUS - SPIRE_WAIST_RADIUS) * u * u;
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
  const positions: number[] = [];
  const ringStart: number[] = [];
  const radiusAt = spireRadiusProfileAt;
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

/** The crown halos are real rings of material, not decals: they turn in three
 *  dimensions above the spire, so a flat RingGeometry vanished to a line edge-on
 *  every half revolution. This is the repo's shared square-section extruded
 *  torus, unit major radius, so callers scale it uniformly. */
function getSpireHaloGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(spireHaloGeomByTier, tier, () =>
    createPrimitiveTorusGeometry('building', tier, 1, 0.08));
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
    details.push(detail(
      makeCylinder(techShellMat, podRadius, podHeight, x, deckY + podHeight / 2, z),
      'min',
    ));
    const podDome = new THREE.Mesh(getPodDomeGeometry(tier), techShellMat);
    podDome.position.set(x, deckY + podHeight, z);
    podDome.scale.set(podRadius * 0.92, podRadius * 0.58, podRadius * 0.92);
    details.push(detail(podDome, 'min'));
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
    halo.scale.setScalar(radius);
    details.push(detail(halo, index === 0 ? 'min' : 'low', undefined, index === 0 ? undefined : 'tinyTrim'));
    operationalParts.push(createBuildingOperationalPosePart(halo, {
      closedPosition: new THREE.Vector3(0, crownStowY, 0),
      closedScale: new THREE.Vector3().setScalar(radius * 0.42),
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

/** The containment lab reads as a disc from every approach: its foundation is
 *  a regular polygon rather than the old pointed shield outline, and the
 *  blueprint's footprint mask is the matching circle of cells. */
function getForgePrimaryGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgePrimaryGeomByTier, tier, () => {
    const sides = tier === 'close' ? 18 : tier === 'mid' ? 12 : 8;
    const outline: [number, number][] = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      outline.push([Math.cos(angle) * 0.48, Math.sin(angle) * 0.48]);
    }
    return createLabFoundationGeometry(outline, null, tier);
  });
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

/** Tusk horn sweeping up and inward toward the containment bubble, planted on
 *  a heavy foot: TubeGeometry only carries one radius, so the finished tube's
 *  rings are pushed out from the curve by a per-ring factor that runs from a
 *  chunky base to a thin tip. TubeGeometry lays its vertices out as
 *  (tubularSegments + 1) rings of (radialSegments + 1) vertices sampled at the
 *  same uniform `getPointAt` positions this recomputes, so the ring centres
 *  line up exactly. */
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
    const tubularSegments = tier === 'close' ? 12 : tier === 'mid' ? 7 : 4;
    const radialSegments = 3;
    const geometry = new THREE.TubeGeometry(
      curve,
      tubularSegments,
      spec.tubeRadius,
      radialSegments,
      false,
    );
    const positions = geometry.getAttribute('position');
    const centre = new THREE.Vector3();
    const vertex = new THREE.Vector3();
    for (let i = 0; i <= tubularSegments; i++) {
      const t = i / tubularSegments;
      curve.getPointAt(t, centre);
      const scale = HORN_FOOT_SCALE + (HORN_TIP_SCALE - HORN_FOOT_SCALE) * t * t;
      for (let j = 0; j <= radialSegments; j++) {
        const index = i * (radialSegments + 1) + j;
        vertex.fromBufferAttribute(positions, index)
          .sub(centre)
          .multiplyScalar(scale)
          .add(centre);
        positions.setXYZ(index, vertex.x, vertex.y, vertex.z);
      }
    }
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    return geometry;
  });
}

/** Radius multipliers at the horn's foot and tip. */
const HORN_FOOT_SCALE = 3.2;
const HORN_TIP_SCALE = 0.65;

/** See getSpireHaloGeometry: the containment ring turns under the bubble, so it
 *  is a square-section torus rather than a flat disc. */
function getForgeRingGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgeRingGeomByTier, tier, () =>
    createPrimitiveTorusGeometry('building', tier, 1, 0.07));
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
  const domeSpan = minDim * 0.46;
  const domeHeight = height * 0.62;
  const domeTopY = deckY + domeHeight;
  const dome = new THREE.Mesh(getForgeDomeGeometry(tier), techShellMat);
  dome.position.y = deckY + domeHeight / 2;
  dome.scale.set(domeSpan, domeHeight, domeSpan);
  details.push(detail(dome, 'min'));

  // A low collar ring seats the dome on the deck. It replaces the three
  // silo wings that used to flank it: they broke the disc silhouette and
  // buried the dome's S-curve behind whichever one faced the camera.
  const collarHeight = height * 0.06;
  details.push(detail(
    makeCylinder(
      techDarkMat,
      domeSpan * 0.62,
      collarHeight,
      0,
      deckY + collarHeight / 2,
      0,
    ),
    'min',
  ));

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
  bubbleRing.scale.setScalar(bubbleRadius * 1.22);
  details.push(detail(bubbleRing, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(bubbleRing, {
    closedPosition: new THREE.Vector3(0, domeTopY * 0.84, 0),
    closedScale: new THREE.Vector3().setScalar(bubbleRadius * 0.56),
    motion: {
      spinAxis: new THREE.Vector3(0, 1, 0),
      spinRadPerSec: 0.84,
    },
  }));

  // Two tusk horns cradling the bubble from opposite sides. Their geometry is
  // authored around the building's own axis, so spinning each mesh about local
  // Y walks the pair around the dome instead of rolling them in place — the
  // lab's one large moving part, and the reason its OFF pose reads instantly.
  const hornSpec: HornSpec = {
    baseRadius: minDim * 0.4,
    topRadius: minDim * 0.085,
    baseY: deckY,
    topY: bubbleY + bubbleRadius * 0.7,
    tubeRadius: minDim * 0.024,
  };
  for (const [index, yaw] of [0.62, 0.62 + Math.PI].entries()) {
    const horn = new THREE.Mesh(getForgeHornGeometry(tier, hornSpec), techShellMat);
    horn.rotation.y = yaw;
    details.push(detail(horn, 'low'));
    operationalParts.push(createBuildingOperationalPosePart(horn, {
      motion: {
        spinAxis: new THREE.Vector3(0, 1, 0),
        spinRadPerSec: 0.46,
        phaseOffset: index * Math.PI,
      },
    }));
  }

  // Team identity: a hex crest band around the dome's bulge.
  const crest = makeCylinder(
    primaryMat,
    domeSpan * 0.46,
    8,
    0,
    deckY + domeHeight * 0.44,
    0,
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

/** Annular deck: a regular polygon with a matching polygon court cut out of
 *  its middle, so the visible ring and the blueprint's ring of reserved cells
 *  describe the same idea. */
function getPrecisionPrimaryGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(precisionPrimaryGeomByTier, tier, () => {
    const sides = tier === 'close' ? 16 : tier === 'mid' ? 12 : 8;
    const ring = (radius: number): [number, number][] => {
      const points: [number, number][] = [];
      for (let i = 0; i < sides; i++) {
        const angle = (i / sides) * Math.PI * 2;
        points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
      }
      return points;
    };
    // The hole winds the opposite way: an ExtrudeGeometry hole path must run
    // counter to its outline or the shape triangulates as a solid disc.
    return createLabFoundationGeometry(ring(0.48), ring(0.25).reverse(), tier);
  });
}

/** One gimbal band: the shared square-section extruded torus at unit major
 *  radius. A gimbal's whole read is three bands turning about three different
 *  axes, which only works if each band has real thickness — a flat ring
 *  disappears to a hairline twice per revolution. Callers scale it uniformly. */
function getPrecisionGimbalGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(precisionGimbalGeomByTier, tier, () =>
    createPrimitiveTorusGeometry('building', tier, 1, 0.035));
}

type StrutSpec = Readonly<{
  baseRadius: number;
  topRadius: number;
  baseY: number;
  topY: number;
  tubeRadius: number;
}>;

/** A deck strut leaning in and up to the gimbal mount. */
function getPrecisionStrutGeometry(
  tier: PrimitiveGeometryTier,
  spec: StrutSpec,
): THREE.BufferGeometry {
  const key = `${tier}:${spec.baseRadius}:${spec.topRadius}:`
    + `${spec.baseY}:${spec.topY}:${spec.tubeRadius}`;
  return getOrCreate(precisionStrutGeomByKey, key, () => {
    const span = spec.topY - spec.baseY;
    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(spec.baseRadius, spec.baseY, 0),
      new THREE.Vector3(spec.baseRadius * 0.96, spec.baseY + span * 0.45, 0),
      new THREE.Vector3(spec.topRadius * 1.6, spec.baseY + span * 0.82, 0),
      new THREE.Vector3(spec.topRadius, spec.topY, 0),
    );
    return new THREE.TubeGeometry(
      curve,
      tier === 'close' ? 9 : tier === 'mid' ? 6 : 3,
      spec.tubeRadius,
      3,
      false,
    );
  });
}

export function buildPrecisionTargetingTechMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const height = PRECISION_TARGETING_TECH_BUILDING_VISUAL_HEIGHT;
  const tier = getActiveBuildingGeometryTier();
  const minDim = Math.min(width, depth);
  const primary = new THREE.Mesh(getPrecisionPrimaryGeometry(tier), primaryMat);
  const details: BuildingShape['details'] = [];
  const operationalParts: BuildingOperationalPosePart[] = [];
  const deckY = height * LAB_FOUNDATION_DEPTH;

  const gimbalY = height * 0.62;
  const stowY = height * 0.34;

  // Three struts lean in off the deck ring and carry the whole instrument.
  // Nothing stands in the court itself — that is the point of the ring.
  const strutSpec: StrutSpec = {
    baseRadius: minDim * 0.36,
    topRadius: minDim * 0.05,
    baseY: deckY,
    topY: gimbalY - minDim * 0.03,
    tubeRadius: minDim * 0.031,
  };
  for (let i = 0; i < 3; i++) {
    const strut = new THREE.Mesh(getPrecisionStrutGeometry(tier, strutSpec), techShellMat);
    strut.rotation.y = (i / 3) * Math.PI * 2 + Math.PI / 6;
    details.push(detail(strut, 'min'));
  }

  // The alignment lens the gimbal holds, and its lit core.
  const lensRadius = minDim * 0.072;
  const lens = makeSphere(techDarkMat, lensRadius, 0, gimbalY, 0);
  details.push(detail(lens, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(lens, {
    closedPosition: new THREE.Vector3(0, stowY, 0),
    closedScale: lens.scale.clone().multiplyScalar(0.7),
  }));
  const lensCore = new THREE.Mesh(crownGlowGeom, techGlowMat);
  lensCore.position.set(0, gimbalY, 0);
  lensCore.scale.setScalar(lensRadius * 0.62);
  details.push(detail(lensCore, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(lensCore, {
    closedPosition: new THREE.Vector3(0, stowY, 0),
    closedScale: lensCore.scale.clone().multiplyScalar(0.3),
    motion: {
      pulseAmplitude: 0.16,
      pulseHz: 0.9,
    },
  }));

  // Three nested bands, each turning about a DIFFERENT local axis: that is
  // what makes it read as a gimbal instead of a stack of hoops. The rings lie
  // in their own XY plane, so local Z is the band's own normal.
  const gimbalAxes: readonly (readonly [number, number, number])[] = [
    [0, 0, 1], [1, 0, 0], [0, 1, 0],
  ];
  const gimbalTilts: readonly (readonly [number, number])[] = [
    [Math.PI / 2, 0], [Math.PI / 2 + 0.55, 0.4], [0.32, -0.5],
  ];
  for (let i = 0; i < 2; i++) {
    const band = new THREE.Mesh(getPrecisionGimbalGeometry(tier), techShellMat);
    const radius = minDim * (i === 0 ? 0.205 : 0.155);
    band.position.y = gimbalY;
    band.rotation.set(gimbalTilts[i + 1][0], gimbalTilts[i + 1][1], 0);
    band.scale.setScalar(radius);
    details.push(detail(band, 'min'));
    operationalParts.push(createBuildingOperationalPosePart(band, {
      closedPosition: new THREE.Vector3(0, stowY, 0),
      closedScale: new THREE.Vector3().setScalar(radius * 0.4),
      motion: {
        spinAxis: new THREE.Vector3(...gimbalAxes[i + 1]),
        spinRadPerSec: i === 0 ? 1.15 : -0.86,
        phaseOffset: i * 0.7,
      },
    }));
  }

  // Collimator mast and its emitter tip, straight up out of the gimbal.
  const mastHeight = height * 0.26;
  details.push(detail(
    makeCylinder(
      techFrameMat,
      minDim * 0.028,
      mastHeight,
      0,
      gimbalY + mastHeight * 0.5,
      0,
    ),
    'low',
  ));
  const emitter = new THREE.Mesh(getSharedPrimitiveTetrahedronGeometry(1), techGlowMat);
  emitter.position.set(0, gimbalY + mastHeight, 0);
  emitter.scale.setScalar(minDim * 0.032);
  details.push(detail(emitter, 'low', undefined, 'tinyTrim'));
  operationalParts.push(createBuildingOperationalPosePart(emitter, {
    closedPosition: new THREE.Vector3(0, stowY, 0),
    closedScale: emitter.scale.clone().multiplyScalar(0.35),
    motion: {
      pulseAmplitude: 0.12,
      pulseHz: 0.7,
      phaseOffset: 0.5,
    },
  }));

  // Team identity: the outermost gimbal band, turning about the lab's own axis.
  const teamBand = new THREE.Mesh(getPrecisionGimbalGeometry(tier), primaryMat);
  const teamRadius = minDim * 0.26;
  teamBand.position.y = gimbalY;
  teamBand.rotation.set(gimbalTilts[0][0], gimbalTilts[0][1], 0);
  teamBand.scale.setScalar(teamRadius);
  details.push(teamOrnamentDetail(teamBand, 'precisionGimbalRing'));
  operationalParts.push(createBuildingOperationalPosePart(teamBand, {
    closedPosition: new THREE.Vector3(0, stowY, 0),
    closedScale: new THREE.Vector3().setScalar(teamRadius * 0.42),
    motion: {
      spinAxis: new THREE.Vector3(...gimbalAxes[0]),
      spinRadPerSec: 0.62,
    },
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
    precisionPrimaryGeomByTier,
    precisionGimbalGeomByTier,
  ]) {
    for (const geometry of map.values()) geometry.dispose();
    map.clear();
  }
  for (const map of [forgeHornGeomByKey, precisionStrutGeomByKey]) {
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
