import * as THREE from 'three';
import { EXTRACTOR_BUILDING_VISUAL_HEIGHT } from '../sim/blueprints';
import type { BuildingShape } from './BuildingShape3D';
import type { ResourcePylonRig } from './ConstructionEmitterMesh3D';
import { buildResourcePylonRig } from './ConstructionEmitterMesh3D';
import {
  createHexFrustumGeometry,
  cylinderGeom,
  detail,
  extractorBladeMat,
  invisibleMat,
} from './BuildingMeshPrimitives3D';

const extractorPyramidGeom = createHexFrustumGeometry();
const EXTRACTOR_FACE_COUNT = 6;
const HEX_CORNER_START_ANGLE = Math.PI / 6;

/** Hexagonal frustum proportions (top/bottom radii) hard-coded in
 *  createHexFrustumGeometry. The protective rotor panels derive their
 *  exact corners from these same normalized radii so the closed pose
 *  matches the rendered pyramid sides. */
const PYRAMID_TOP_RADIUS_FRACTION = 0.17;
const PYRAMID_BOTTOM_RADIUS_FRACTION = 0.5;
const EXTRACTOR_PANEL_EXTRUSION_SCALE = 4;
/** Closed-pose stand-off from the pyramid surface (in world units). Push
 *  the folded blades a small distance OUTWARD along the face normal so
 *  they don't z-fight with the pyramid body and so the slightly-thick
 *  blade reads as a panel sitting on the face rather than embedded in it. */
const CLOSED_BLADE_STANDOFF = 0.4;

type ExtractorFaceFrame = {
  bottom0: THREE.Vector3;
  bottom1: THREE.Vector3;
  top0: THREE.Vector3;
  top1: THREE.Vector3;
  center: THREE.Vector3;
  normal: THREE.Vector3;
  tangent: THREE.Vector3;
  slope: THREE.Vector3;
  radial: THREE.Vector3;
};

const extractorSidePanelGeomCache = new Map<string, THREE.BufferGeometry[]>();

/** Per-blade open/closed transform pair. The animator stores the current
 *  blend factor (0 = open, 1 = closed) and slerps/lerps between these on
 *  each frame. Each blade mesh is an extruded copy of one actual pyramid
 *  side face, so the closed pose can land on the matching face without
 *  scale tricks or average-width rectangles. */
export type ExtractorBladeAnim = {
  openPos: THREE.Vector3;
  closedPos: THREE.Vector3;
  openQuat: THREE.Quaternion;
  closedQuat: THREE.Quaternion;
  openScale: THREE.Vector3;
  closedScale: THREE.Vector3;
};

/** Rotor meshes for the extractor. The animator advances one shared
 *  yaw so rebuilds can never reset the spin phase. */
export type ExtractorRig = {
  rotors: THREE.Mesh[];
  pylon: ResourcePylonRig;
};

/** Metal extractor detail.
 *
 *  The complete readable extractor silhouette is the six-sided pyramid
 *  plus one rotating shiny hub/blade assembly. That simple version
 *  intentionally remains the frontend shape so the extractor does not
 *  swap into busier decorative variants with camera distance.
 */
export function buildMetalExtractorMesh(
  width: number,
  depth: number,
  primaryMat: THREE.Material,
): BuildingShape {
  const minDim = Math.min(width, depth);
  const pyramidHeight = Math.min(EXTRACTOR_BUILDING_VISUAL_HEIGHT * 0.64, Math.max(28, minDim * 0.78));
  const base = new THREE.Mesh(extractorPyramidGeom, primaryMat);

  const details: BuildingShape['details'] = [];
  const ratePillarBaseY = pyramidHeight + 2;
  const shortRatePillarHeight = Math.max(10, Math.min(16, EXTRACTOR_BUILDING_VISUAL_HEIGHT - ratePillarBaseY - 4));
  const ratePillarHeight = shortRatePillarHeight * 2;
  const ratePillarRadius = Math.max(3.8, minDim * 0.055);
  const metalPylon = buildResourcePylonRig({
    resource: 'metal',
    direction: 'inbound',
    showerRadius: ratePillarRadius * 1.7,
    pylonHeight: ratePillarHeight,
    pylonBaseY: ratePillarBaseY,
    x: 0,
    z: 0,
    pylonRadius: ratePillarRadius,
    sprayTravelSpeed: 110,
    sprayParticleRadius: Math.max(1.4, ratePillarRadius * 0.42),
    flowRadius: Math.max(30, ratePillarHeight * 1.1),
    channel: 1,
  });
  for (const mesh of metalPylon.staticMeshes) {
    details.push(detail(mesh, 'low'));
  }
  details.push(detail(metalPylon.rig.shower, 'low'));

  const rotorY = Math.min(
    EXTRACTOR_BUILDING_VISUAL_HEIGHT - 3,
    ratePillarBaseY + ratePillarHeight + Math.max(1.5, ratePillarRadius * 0.35),
  );

  const bladeLen = Math.max(32, minDim * 0.86);
  const bladeThickness = Math.max(4.5, minDim * 0.11);
  const panelThickness = Math.max(1.2, bladeThickness * 0.25) * EXTRACTOR_PANEL_EXTRUSION_SCALE;
  const bladeRootRadius = Math.max(ratePillarRadius * 2.2, minDim * 0.28);

  // Simple rotor — all six blades remain visible and rotating so the
  // silhouette is stable. No alternate glow/trim variant.
  const simpleRotor = makeExtractorRotor(
    bladeLen, bladeThickness, panelThickness,
    EXTRACTOR_FACE_COUNT, rotorY, bladeRootRadius, 0.5,
    width, depth, pyramidHeight,
  );
  details.push(detail(simpleRotor, 'min', undefined, 'extractorRotor'));

  return {
    primary: base,
    details,
    height: pyramidHeight,
    extractorRig: {
      rotors: [simpleRotor],
      pylon: metalPylon.rig,
    },
  };
}

function makeExtractorRotor(
  bladeReach: number,
  bladeThickness: number,
  panelThickness: number,
  bladeCount: number,
  y: number,
  bladeRootRadius: number,
  bladeLengthScale: number = 1,
  buildingWidth: number,
  buildingDepth: number,
  pyramidHeight: number,
): THREE.Mesh {
  const rotor = new THREE.Mesh(cylinderGeom, invisibleMat);
  rotor.position.set(0, y, 0);

  const groundClearance = Math.max(3.5, bladeThickness * 1.5);
  const fullVerticalDrop = Math.max(12, y - groundClearance);
  const rootRadius = Math.max(0, Math.min(bladeRootRadius, Math.max(0, bladeReach - 16)));
  const fullHorizontalSpan = Math.max(16, Math.min(bladeReach - rootRadius, fullVerticalDrop));
  const horizontalSpan = fullHorizontalSpan * bladeLengthScale;
  const verticalDrop = fullVerticalDrop * bladeLengthScale;
  const panelGeometries = getExtractorSidePanelGeometries(
    buildingWidth,
    buildingDepth,
    pyramidHeight,
    panelThickness,
  );

  for (let i = 0; i < bladeCount; i++) {
    const face = getExtractorFaceFrame(buildingWidth, buildingDepth, pyramidHeight, i);
    const openRadial = face.radial;
    const openTangent = face.tangent.clone();
    const openSlopeHint = new THREE.Vector3(
      -openRadial.x * horizontalSpan,
      verticalDrop,
      -openRadial.z * horizontalSpan,
    ).normalize();
    const openNormal = new THREE.Vector3()
      .crossVectors(openSlopeHint, openTangent)
      .normalize();
    const openSlope = new THREE.Vector3()
      .crossVectors(openTangent, openNormal)
      .normalize();
    const openCenterRadius = rootRadius + horizontalSpan * 0.5;
    const openPos = new THREE.Vector3(
      openRadial.x * openCenterRadius,
      -verticalDrop * 0.5,
      openRadial.z * openCenterRadius,
    );
    const openQuat = quatFromBasis(openTangent, openNormal, openSlope);

    const closedCenter = new THREE.Vector3(
      face.center.x + face.normal.x * (CLOSED_BLADE_STANDOFF + panelThickness * 0.5),
      face.center.y - y + face.normal.y * (CLOSED_BLADE_STANDOFF + panelThickness * 0.5),
      face.center.z + face.normal.z * (CLOSED_BLADE_STANDOFF + panelThickness * 0.5),
    );
    const closedQuat = quatFromBasis(face.tangent, face.normal, face.slope);

    const blade = new THREE.Mesh(panelGeometries[i], extractorBladeMat);
    blade.position.copy(openPos);
    blade.quaternion.copy(openQuat);

    const anim: ExtractorBladeAnim = {
      openPos,
      closedPos: closedCenter,
      openQuat,
      closedQuat,
      openScale: new THREE.Vector3(1, 1, 1),
      closedScale: new THREE.Vector3(1, 1, 1),
    };
    blade.userData.extractorBlade = anim;

    rotor.add(blade);
  }

  return rotor;
}

function getExtractorSidePanelGeometries(
  width: number,
  depth: number,
  pyramidHeight: number,
  panelThickness: number,
): THREE.BufferGeometry[] {
  const key = [
    width.toFixed(3),
    depth.toFixed(3),
    pyramidHeight.toFixed(3),
    panelThickness.toFixed(3),
  ].join(':');
  const cached = extractorSidePanelGeomCache.get(key);
  if (cached) return cached;

  const geometries: THREE.BufferGeometry[] = [];
  for (let i = 0; i < EXTRACTOR_FACE_COUNT; i++) {
    const face = getExtractorFaceFrame(width, depth, pyramidHeight, i);
    geometries.push(createExtractorSidePanelGeometry(face, panelThickness));
  }
  extractorSidePanelGeomCache.set(key, geometries);
  return geometries;
}

function getExtractorFaceFrame(
  width: number,
  depth: number,
  pyramidHeight: number,
  faceIndex: number,
): ExtractorFaceFrame {
  const bottom0 = getHexFrustumCorner(width, depth, PYRAMID_BOTTOM_RADIUS_FRACTION, 0, faceIndex);
  const bottom1 = getHexFrustumCorner(width, depth, PYRAMID_BOTTOM_RADIUS_FRACTION, 0, faceIndex + 1);
  const top0 = getHexFrustumCorner(width, depth, PYRAMID_TOP_RADIUS_FRACTION, pyramidHeight, faceIndex);
  const top1 = getHexFrustumCorner(width, depth, PYRAMID_TOP_RADIUS_FRACTION, pyramidHeight, faceIndex + 1);
  const center = new THREE.Vector3()
    .add(bottom0)
    .add(bottom1)
    .add(top0)
    .add(top1)
    .multiplyScalar(0.25);
  const bottomMid = new THREE.Vector3().addVectors(bottom0, bottom1).multiplyScalar(0.5);
  const topMid = new THREE.Vector3().addVectors(top0, top1).multiplyScalar(0.5);
  const edge = new THREE.Vector3().subVectors(bottom1, bottom0);
  const upSlope = new THREE.Vector3().subVectors(topMid, bottomMid);
  const normal = new THREE.Vector3().crossVectors(upSlope, edge).normalize();
  if (normal.x * center.x + normal.z * center.z < 0) normal.negate();

  const tangent = edge.normalize();
  const slope = new THREE.Vector3().crossVectors(tangent, normal).normalize();
  if (slope.dot(upSlope) < 0) {
    tangent.negate();
    slope.crossVectors(tangent, normal).normalize();
  }

  const radial = new THREE.Vector3(center.x, 0, center.z);
  if (radial.lengthSq() < 1e-6) {
    radial.set(normal.x, 0, normal.z);
  }
  radial.normalize();

  return {
    bottom0,
    bottom1,
    top0,
    top1,
    center,
    normal,
    tangent,
    slope,
    radial,
  };
}

function getHexFrustumCorner(
  width: number,
  depth: number,
  radiusFraction: number,
  y: number,
  cornerIndex: number,
): THREE.Vector3 {
  const angle = HEX_CORNER_START_ANGLE
    + ((cornerIndex % EXTRACTOR_FACE_COUNT) / EXTRACTOR_FACE_COUNT) * Math.PI * 2;
  return new THREE.Vector3(
    Math.cos(angle) * radiusFraction * width,
    y,
    Math.sin(angle) * radiusFraction * depth,
  );
}

function createExtractorSidePanelGeometry(
  face: ExtractorFaceFrame,
  panelThickness: number,
): THREE.BufferGeometry {
  const corners = [face.bottom0, face.bottom1, face.top1, face.top0];
  const localCorners = corners.map((corner) => {
    const delta = new THREE.Vector3().subVectors(corner, face.center);
    return {
      x: delta.dot(face.tangent),
      z: delta.dot(face.slope),
    };
  });
  const halfThickness = panelThickness * 0.5;
  const positions: number[] = [];
  for (const corner of localCorners) {
    positions.push(corner.x, halfThickness, corner.z);
  }
  for (const corner of localCorners) {
    positions.push(corner.x, -halfThickness, corner.z);
  }

  const sourceOrder = [0, 1, 2, 3];
  const outerOrder = polygonSignedArea(localCorners) > 0
    ? [...sourceOrder].reverse()
    : sourceOrder;
  const innerOrder = [...outerOrder].reverse().map((idx) => idx + 4);
  const indices: number[] = [];
  addQuadIndices(indices, outerOrder[0], outerOrder[1], outerOrder[2], outerOrder[3]);
  addQuadIndices(indices, innerOrder[0], innerOrder[1], innerOrder[2], innerOrder[3]);
  for (let i = 0; i < sourceOrder.length; i++) {
    const a = sourceOrder[i];
    const b = sourceOrder[(i + 1) % sourceOrder.length];
    addQuadIndices(indices, a, b, b + 4, a + 4);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  return geom;
}

function polygonSignedArea(points: ReadonlyArray<{ x: number; z: number }>): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return area * 0.5;
}

function addQuadIndices(
  indices: number[],
  a: number,
  b: number,
  c: number,
  d: number,
): void {
  indices.push(a, b, c, a, c, d);
}

function quatFromBasis(
  xAxis: THREE.Vector3,
  yAxis: THREE.Vector3,
  zAxis: THREE.Vector3,
): THREE.Quaternion {
  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

export function disposeMetalExtractorMeshGeoms(): void {
  extractorPyramidGeom.dispose();
  for (const geometries of extractorSidePanelGeomCache.values()) {
    for (const geom of geometries) geom.dispose();
  }
  extractorSidePanelGeomCache.clear();
}
