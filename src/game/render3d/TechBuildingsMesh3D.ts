// TechBuildingsMesh3D — two broad research campuses.
//
//   buildingShieldTargetingTech — an octagonal calibration lab wrapped
//     around an open test court, with four experiment pods and a central
//     targeting oculus carried in animated gimbals.
//   buildingShieldTech — a shield-plan containment lab with a pointed
//     foundation, three research wings, field-coil pylons, and a live
//     force bubble over the central chamber.
//
// Their foundations are authored polygons rather than scaled square slabs,
// so the visible bases and pixel-cell reservations describe the same idea.

import * as THREE from 'three';
import { BUILDING_PALETTE, SHINY_GRAY_METAL_MATERIAL } from './BuildingVisualPalette';
import {
  SHIELD_TARGETING_TECH_BUILDING_VISUAL_HEIGHT,
  SHIELD_TECH_BUILDING_VISUAL_HEIGHT,
} from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import {
  detail,
  getBuildingCylinderGeometry,
  hexCylinderGeom,
  makeBox,
  makeCylinder,
  makeSphere,
  teamOrnamentDetail,
  getActiveBuildingGeometryTier,
} from './BuildingMeshPrimitives3D';
import {
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

// ── Tiered curved geometry caches ──────────────────────────────────────
const spirePrimaryGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const spireHaloGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
const forgePrimaryGeomByTier = new Map<PrimitiveGeometryTier, THREE.BufferGeometry>();
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
    depth: 0.12,
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
  const operationalParts: BuildingOperationalPosePart[] = [];

  const podRadius = minDim * 0.105;
  const podOrbit = minDim * 0.29;
  const podHeight = Math.max(20, minDim * 0.105);
  for (let i = 0; i < 4; i++) {
    const yaw = Math.PI * 0.25 + i * Math.PI * 0.5;
    const x = Math.cos(yaw) * podOrbit;
    const z = Math.sin(yaw) * podOrbit;
    const connector = makeBox(
      techFrameMat,
      podOrbit * 0.82,
      7,
      Math.max(10, minDim * 0.055),
      x * 0.48,
      height * 0.13,
      z * 0.48,
    );
    connector.rotation.y = -yaw;
    details.push(detail(connector, 'low'));

    details.push(detail(
      makeCylinder(techShellMat, podRadius, podHeight, x, podHeight / 2 + 7, z, hexCylinderGeom),
      'min',
    ));
    const window = makeBox(
      techGlowMat,
      podRadius * 1.15,
      6,
      2.5,
      x * (1 + podRadius / podOrbit),
      podHeight * 0.62 + 7,
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

  // The open central court carries a real calibration instrument instead of
  // being filled by a generic square chassis.
  details.push(detail(
    makeCylinder(techDarkMat, minDim * 0.105, height * 0.42, 0, height * 0.28, 0, hexCylinderGeom),
    'min',
  ));
  details.push(detail(
    makeCylinder(techFrameMat, minDim * 0.075, height * 0.48, 0, height * 0.34, 0, hexCylinderGeom),
    'low',
  ));

  const crownY = height * 0.76;
  const crown = makeSphere(techDarkMat, minDim * 0.068, 0, crownY, 0);
  details.push(detail(crown, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(crown, {
    closedPosition: new THREE.Vector3(0, height * 0.48, 0),
    closedScale: crown.scale.clone().multiplyScalar(0.72),
  }));
  const crownGlow = makeSphere(techGlowMat, minDim * 0.038, 0, crownY + 1.5, 0);
  details.push(detail(crownGlow, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(crownGlow, {
    closedPosition: new THREE.Vector3(0, height * 0.48, 0),
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
    const radius = minDim * (index === 0 ? 0.15 : 0.205);
    halo.scale.set(radius, radius, 1);
    details.push(detail(halo, index === 0 ? 'min' : 'low', undefined, index === 0 ? undefined : 'tinyTrim'));
    operationalParts.push(createBuildingOperationalPosePart(halo, {
      closedPosition: new THREE.Vector3(0, height * 0.48, 0),
      closedScale: new THREE.Vector3(radius * 0.42, radius * 0.42, 0.55),
      motion: {
        spinAxis: new THREE.Vector3(0, 1, 0),
        spinRadPerSec: index === 0 ? 0.92 : -0.72,
        phaseOffset: index * 0.4,
      },
    }));
  }

  const crownCollar = makeCylinder(
    primaryMat,
    minDim * 0.09,
    6,
    0,
    height * 0.58,
    0,
    hexCylinderGeom,
  );
  details.push(teamOrnamentDetail(
    crownCollar,
    'targetingSpireHalo',
  ));
  operationalParts.push(createBuildingOperationalPosePart(crownCollar, {
    closedPosition: new THREE.Vector3(0, height * 0.46, 0),
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

  // Three discrete research wings sit on the pointed shield foundation.
  // Their spacing leaves the silhouette readable instead of rebuilding a
  // hidden square plinth out of decorative pieces.
  const wingRadius = minDim * 0.115;
  const wingHeight = Math.max(22, height * 0.24);
  const wingPositions: readonly (readonly [number, number])[] = [
    [-minDim * 0.255, -minDim * 0.155],
    [minDim * 0.255, -minDim * 0.155],
    [0, minDim * 0.255],
  ];
  for (const [x, z] of wingPositions) {
    details.push(detail(
      makeCylinder(techShellMat, wingRadius, wingHeight, x, wingHeight / 2 + 7, z, hexCylinderGeom),
      'min',
    ));
    const yaw = Math.atan2(z, x);
    const orbit = Math.max(1, Math.hypot(x, z));
    const window = makeBox(
      techGlowMat,
      wingRadius * 1.15,
      6,
      2.5,
      x * (1 + wingRadius / orbit),
      wingHeight * 0.62 + 7,
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

  const chamberRadius = minDim * 0.17;
  details.push(detail(
    makeCylinder(techFrameMat, chamberRadius * 0.91, height * 0.3, 0, height * 0.25, 0, hexCylinderGeom),
    'low',
  ));

  const bubbleY = height * 0.67;
  const bubbleRadius = minDim * 0.18;
  const bubble = makeSphere(techBubbleMat, bubbleRadius, 0, bubbleY, 0);
  details.push(detail(bubble, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(bubble, {
    closedPosition: new THREE.Vector3(0, height * 0.43, 0),
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
  bubbleRing.scale.set(bubbleRadius * 1.18, bubbleRadius * 1.18, 1);
  details.push(detail(bubbleRing, 'min'));
  operationalParts.push(createBuildingOperationalPosePart(bubbleRing, {
    closedPosition: new THREE.Vector3(0, height * 0.42, 0),
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

  // Four field-coil pylons frame the containment experiment. The upper glow
  // caps retract when the lab is disabled, preserving the existing open/
  // closed operational language without retaining the old fantasy horns.
  const coilOrbit = minDim * 0.255;
  for (let i = 0; i < 4; i++) {
    const yaw = Math.PI * 0.25 + i * Math.PI * 0.5;
    const x = Math.cos(yaw) * coilOrbit;
    const z = Math.sin(yaw) * coilOrbit;
    details.push(detail(
      makeCylinder(
        techFrameMat,
        minDim * 0.035,
        height * 0.46,
        x,
        height * 0.3,
        z,
        getBuildingCylinderGeometry('far'),
      ),
      'low',
    ));
    const cap = new THREE.Mesh(getSharedPrimitiveTetrahedronGeometry(1), techGlowMat);
    cap.position.set(x, height * 0.56, z);
    cap.scale.setScalar(minDim * 0.047);
    details.push(detail(cap, 'low', undefined, 'tinyTrim'));
    operationalParts.push(createBuildingOperationalPosePart(cap, {
      closedPosition: new THREE.Vector3(x, height * 0.31, z),
      closedScale: cap.scale.clone().multiplyScalar(0.42),
      motion: {
        pulseAmplitude: 0.09,
        pulseHz: 0.64,
        phaseOffset: i * 0.16,
      },
    }));
  }

  const crest = makeCylinder(
    primaryMat,
    chamberRadius,
    6,
    0,
    height * 0.38,
    0,
    hexCylinderGeom,
  );
  details.push(teamOrnamentDetail(
    crest,
    'shieldForgeCrest',
  ));
  operationalParts.push(createBuildingOperationalPosePart(crest, {
    closedPosition: new THREE.Vector3(0, height * 0.3, 0),
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
    spireHaloGeomByTier,
    forgePrimaryGeomByTier,
    forgeRingGeomByTier,
  ]) {
    for (const geometry of map.values()) geometry.dispose();
    map.clear();
  }
  techFrameMat.dispose();
  techDarkMat.dispose();
  techShellMat.dispose();
  techGlowMat.dispose();
  techBubbleMat.dispose();
}
