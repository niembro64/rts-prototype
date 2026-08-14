// TechBuildingsMesh3D — the two prototype-only tech structures.
//
//   buildingShieldTargetingTech — "the oracle spire": a twisted
//     hyperboloid pylon wrapped by counter-rotating helical ribbons,
//     crowned with a floating targeting oculus inside tilted halo rings
//     and three down-swept bezier antenna petals.
//   buildingShieldTech — "the aegis forge": an S-curved lathe dome under
//     a translucent force bubble, hugged by staggered nautilus shell
//     plates and flanked by two tusk-like bezier horn pylons.
//
// Both are deliberately curve-heavy sculptures. Every curved geometry is
// memoized per LOD tier; ribbons, petals, shells, and horns drop out
// tier-by-tier so the composite triangle count descends monotonically.

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
  makeCylinder,
  makeSphere,
  teamOrnamentDetail,
  getActiveBuildingGeometryTier,
} from './BuildingMeshPrimitives3D';
import {
  createPrimitiveRingGeometry,
  getOrCreate,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

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

// ── Tiered curved geometry caches ──────────────────────────────────────
const spirePrimaryGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const spireRibbonGeomByTier = new Map<string, THREE.BufferGeometry>();
const spirePetalGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const spireHaloGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgePrimaryGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeShellGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeHornGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgeRingGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();

/** Twisted hyperboloid pylon, normalized to the unit box the renderer
 *  scales by (width, height, depth): Y spans [-0.5, 0.5]; the radius
 *  pinches to a waist and re-flares while the cross-section rotates. */
function createTwistedSpireGeometry(
  radialSegments: number,
  heightSegments: number,
  twistRad: number,
): THREE.BufferGeometry {
  const bottomRadius = 0.46;
  const waistRadius = 0.15;
  const topRadius = 0.24;
  const waistT = 0.62;
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

function getSpirePrimaryGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(spirePrimaryGeomByTier, tier, () => tier === 'close'
    ? createTwistedSpireGeometry(12, 7, 2.4)
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

function getSpireRibbonGeometry(
  tier: PrimitiveGeometryTier,
  phase: number,
): THREE.BufferGeometry {
  return getOrCreate(spireRibbonGeomByTier, `${tier}:${phase}`, () =>
    createHelixRibbonGeometry(
      14,
      124,
      23,
      10,
      2.4,
      phase,
      tier === 'close' ? 56 : tier === 'mid' ? 20 : 10,
      3,
      1.7,
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
      tier === 'close' ? 14 : tier === 'mid' ? 8 : 4,
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

  const baseRadius = Math.max(24, minDim * 0.44);
  details.push(detail(
    makeCylinder(techDarkMat, baseRadius, 9, 0, 4.5, 0, hexCylinderGeom),
    'min',
  ));
  details.push(detail(
    makeCylinder(techFrameMat, baseRadius * 0.78, 5, 0, 11.5, 0, hexCylinderGeom),
    'low',
  ));

  // Counter-rotating helical ribbons. The detail list is identical at
  // every tier (the LOD anchor contract); only the tube tessellation
  // simplifies. The second ribbon is tagged tinyTrim so the runtime
  // detail-level gate can drop it first.
  details.push(detail(new THREE.Mesh(getSpireRibbonGeometry(tier, 0), techShellMat), 'low'));
  details.push(detail(
    new THREE.Mesh(getSpireRibbonGeometry(tier, Math.PI), techShellMat),
    'low',
    undefined,
    'tinyTrim',
  ));

  // Crown: the floating oculus and its glow.
  const crownY = height * 0.88;
  details.push(detail(makeSphere(techDarkMat, 7.5, 0, crownY, 0), 'low'));
  details.push(detail(makeSphere(techGlowMat, 4.2, 0, crownY + 1.2, 0), 'low'));

  // Tilted halo rings around the oculus keep the crowned silhouette
  // readable at distance.
  const halo = new THREE.Mesh(getSpireHaloGeometry(tier), techGlowMat);
  halo.position.y = crownY;
  halo.rotation.set(Math.PI / 2 - 0.42, 0.3, 0);
  halo.scale.set(17, 17, 1);
  details.push(detail(halo, 'min'));
  const outerHalo = new THREE.Mesh(getSpireHaloGeometry(tier), techGlowMat);
  outerHalo.position.y = crownY;
  outerHalo.rotation.set(Math.PI / 2 + 0.3, -0.5, 0);
  outerHalo.scale.set(23, 23, 1);
  details.push(detail(outerHalo, 'low', undefined, 'tinyTrim'));

  // Three antenna petals swept outward-down from just below the oculus.
  for (let i = 0; i < 3; i++) {
    const petal = new THREE.Mesh(getSpirePetalGeometry(tier), techFrameMat);
    petal.position.y = crownY - 6;
    petal.rotation.y = (i / 3) * Math.PI * 2;
    details.push(detail(petal, 'low', undefined, 'tinyTrim'));
  }

  // Team identity: a hex collar where the spire meets the crown.
  details.push(teamOrnamentDetail(
    makeCylinder(primaryMat, Math.max(9, minDim * 0.17), 4.5, 0, height * 0.79, 0, hexCylinderGeom),
    'targetingSpireHalo',
  ));

  return { primary, details, height };
}

/** S-curved lathe dome for the aegis forge, normalized to the unit box:
 *  base flare, mid bulge, pinched neck, and an emitter tip. */
function getForgePrimaryGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgePrimaryGeomByTier, tier, () => {
    const profile: [number, number][] = tier === 'close'
      ? [
        [0.47, -0.5], [0.5, -0.34], [0.46, -0.18], [0.36, -0.02],
        [0.24, 0.12], [0.17, 0.26], [0.19, 0.38], [0.09, 0.46], [0.0, 0.5],
      ]
      : tier === 'mid'
        ? [[0.47, -0.5], [0.5, -0.3], [0.4, -0.06], [0.2, 0.2], [0.18, 0.38], [0.0, 0.5]]
        : [[0.47, -0.5], [0.44, -0.1], [0.16, 0.3], [0.0, 0.5]];
    const points = profile.map(([x, y]) => new THREE.Vector2(x, y));
    const segments = tier === 'close' ? 14 : tier === 'mid' ? 9 : 5;
    const geom = new THREE.LatheGeometry(points, segments);
    // Close the base so the dome reads as a solid grounded machine.
    const base = new THREE.CircleGeometry(0.47, segments);
    base.rotateX(Math.PI / 2);
    base.translate(0, -0.5, 0);
    const positions = [
      ...Array.from(geom.getAttribute('position').array),
    ];
    const indices = geom.getIndex();
    const merged = new THREE.BufferGeometry();
    const baseIndexOffset = positions.length / 3;
    positions.push(...Array.from(base.getAttribute('position').array));
    const mergedIndices = indices === null ? [] : Array.from(indices.array);
    const baseIndices = base.getIndex();
    if (baseIndices !== null) {
      for (let i = 0; i < baseIndices.count; i++) {
        mergedIndices.push(baseIndices.getX(i) + baseIndexOffset);
      }
    }
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setIndex(mergedIndices);
    merged.computeVertexNormals();
    geom.dispose();
    base.dispose();
    return merged;
  });
}

/** Partial-sphere nautilus plate hugging the dome flank. */
function getForgeShellGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgeShellGeomByTier, tier, () => new THREE.SphereGeometry(
    1,
    tier === 'close' ? 10 : tier === 'mid' ? 6 : 4,
    tier === 'close' ? 5 : tier === 'mid' ? 3 : 2,
    -0.75,
    1.5,
    0.55,
    0.85,
  ));
}

/** Tusk horn sweeping up and inward toward the bubble. */
function getForgeHornGeometry(tier: PrimitiveGeometryTier): THREE.BufferGeometry {
  return getOrCreate(forgeHornGeomByTier, tier, () => {
    const curve = new THREE.CubicBezierCurve3(
      new THREE.Vector3(30, 2, 0),
      new THREE.Vector3(36, 34, 0),
      new THREE.Vector3(28, 66, 0),
      new THREE.Vector3(10, 84, 0),
    );
    return new THREE.TubeGeometry(
      curve,
      tier === 'close' ? 18 : tier === 'mid' ? 9 : 5,
      2.6,
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

  const baseRadius = Math.max(24, minDim * 0.46);
  details.push(detail(
    makeCylinder(techDarkMat, baseRadius, 8, 0, 4, 0, hexCylinderGeom),
    'min',
  ));

  // The protective bubble the whole building exists to sell: a
  // translucent force sphere capping the emitter neck.
  const bubbleY = height * 0.72;
  const bubbleRadius = Math.max(16, minDim * 0.3);
  details.push(detail(makeSphere(techBubbleMat, bubbleRadius, 0, bubbleY, 0), 'min'));
  const bubbleRing = new THREE.Mesh(getForgeRingGeometry(tier), techGlowMat);
  bubbleRing.position.y = bubbleY - bubbleRadius * 0.55;
  bubbleRing.rotation.x = Math.PI / 2;
  bubbleRing.scale.set(bubbleRadius * 1.18, bubbleRadius * 1.18, 1);
  details.push(detail(bubbleRing, 'min'));

  // Staggered nautilus shell plates spiralling up the dome flank. The
  // detail list is identical at every tier (LOD anchor contract); the
  // plate tessellation carries the simplification.
  for (let i = 0; i < 3; i++) {
    const shell = new THREE.Mesh(getForgeShellGeometry(tier), techShellMat);
    const yaw = i * 2.15;
    shell.position.y = height * (0.3 + i * 0.09);
    shell.rotation.y = yaw;
    shell.scale.setScalar(minDim * (0.52 - i * 0.07));
    details.push(detail(shell, 'low', undefined, 'tinyTrim'));
  }

  // Two tusk horns cradling the bubble from opposite sides.
  for (const yaw of [0, Math.PI]) {
    const horn = new THREE.Mesh(getForgeHornGeometry(tier), techFrameMat);
    horn.rotation.y = yaw;
    horn.scale.setScalar(minDim / 60);
    details.push(detail(horn, 'low', undefined, 'tinyTrim'));
  }

  // Team identity: a hex crest band around the dome's bulge.
  details.push(teamOrnamentDetail(
    makeCylinder(primaryMat, baseRadius * 0.94, 4.5, 0, height * 0.3, 0, hexCylinderGeom),
    'shieldForgeCrest',
  ));

  return { primary, details, height };
}

export function disposeTechBuildingsMeshGeoms(): void {
  for (const map of [
    spirePrimaryGeomByTier,
    spirePetalGeomByTier,
    spireHaloGeomByTier,
    forgePrimaryGeomByTier,
    forgeShellGeomByTier,
    forgeHornGeomByTier,
    forgeRingGeomByTier,
  ]) {
    for (const geometry of map.values()) geometry.dispose();
    map.clear();
  }
  for (const geometry of spireRibbonGeomByTier.values()) geometry.dispose();
  spireRibbonGeomByTier.clear();
  techFrameMat.dispose();
  techDarkMat.dispose();
  techShellMat.dispose();
  techGlowMat.dispose();
  techBubbleMat.dispose();
}
