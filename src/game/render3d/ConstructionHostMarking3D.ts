import * as THREE from 'three';
import {
  CONSTRUCTION_HAZARD_COLORS,
  CONSTRUCTION_HAZARD_MARKING_STYLE,
  type ConstructionHostMarkingAxis,
  type ConstructionHostMarkingProfile,
} from '@/constructionVisualConfig';
import type { PrimitiveGeometryTier } from './PrimitiveGeometryQuality3D';

export type HazardColor = 'yellow' | 'black';
export type HazardUvPoint = readonly [u: number, v: number];
export type LinearHazardStripePolygon = Readonly<{
  color: HazardColor;
  points: readonly HazardUvPoint[];
}>;

type MarkingGeometrySet = Readonly<{
  yellow: THREE.BufferGeometry;
  black: THREE.BufferGeometry;
  housing?: THREE.BufferGeometry;
  latch?: THREE.BufferGeometry;
}>;

const markingGeometryCache = new Map<string, MarkingGeometrySet>();
const hazardYellowMat = new THREE.MeshBasicMaterial({
  color: CONSTRUCTION_HAZARD_COLORS.yellowHex,
  side: THREE.DoubleSide,
});
const hazardBlackMat = new THREE.MeshBasicMaterial({
  color: CONSTRUCTION_HAZARD_COLORS.blackHex,
  side: THREE.DoubleSide,
});
const hazardHousingMat = new THREE.MeshStandardMaterial({
  color: CONSTRUCTION_HAZARD_COLORS.blackHex,
  metalness: 0.42,
  roughness: 0.58,
  side: THREE.DoubleSide,
});
const hazardLatchMat = new THREE.MeshStandardMaterial({
  color: CONSTRUCTION_HAZARD_COLORS.yellowHex,
  metalness: 0.34,
  roughness: 0.52,
  side: THREE.DoubleSide,
});
const EPSILON = 1e-8;

function triangle(
  positions: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): void {
  positions.push(...a, ...b, ...c);
}

function polygonArea(points: readonly HazardUvPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index++) {
    const next = (index + 1) % points.length;
    twiceArea += points[index][0] * points[next][1] -
      points[next][0] * points[index][1];
  }
  return Math.abs(twiceArea) * 0.5;
}

function clipPolygon(
  points: readonly HazardUvPoint[],
  signedDistance: (point: HazardUvPoint) => number,
): HazardUvPoint[] {
  if (points.length === 0) return [];
  const result: HazardUvPoint[] = [];
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const startDistance = signedDistance(start);
    const endDistance = signedDistance(end);
    const startInside = startDistance >= -EPSILON;
    const endInside = endDistance >= -EPSILON;
    if (startInside && endInside) {
      result.push(end);
    } else if (startInside !== endInside) {
      const denominator = startDistance - endDistance;
      const amount = Math.abs(denominator) <= EPSILON
        ? 0
        : startDistance / denominator;
      const intersection: HazardUvPoint = [
        start[0] + (end[0] - start[0]) * amount,
        start[1] + (end[1] - start[1]) * amount,
      ];
      result.push(intersection);
      if (endInside) result.push(end);
    }
  }
  return result;
}

function positiveParity(value: number): number {
  return ((value % 2) + 2) % 2;
}

/** Partition a rectangular surface into equal-width linear bands whose
 * boundaries are `u + v = constant`. Because u and v are physical-distance
 * coordinates, every non-edge boundary is exactly 45 degrees. */
export function buildLinearHazardStripePolygons(
  width: number,
  height: number,
  stripeCount: number,
): readonly LinearHazardStripePolygon[] {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isInteger(stripeCount) ||
    stripeCount < 4 ||
    stripeCount % 2 !== 0
  ) {
    throw new Error('linear construction stripes require positive dimensions and an even stripe count of at least four');
  }
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const stripeWidth = width / stripeCount;
  const minSum = -halfWidth - halfHeight;
  const maxSum = halfWidth + halfHeight;
  const firstBand = Math.floor(minSum / stripeWidth) - 1;
  const lastBand = Math.ceil(maxSum / stripeWidth) + 1;
  const rectangle: readonly HazardUvPoint[] = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ];
  const result: LinearHazardStripePolygon[] = [];
  for (let band = firstBand; band <= lastBand; band++) {
    const lower = band * stripeWidth;
    const upper = (band + 1) * stripeWidth;
    let points = clipPolygon(rectangle, ([u, v]) => u + v - lower);
    points = clipPolygon(points, ([u, v]) => upper - u - v);
    if (points.length < 3 || polygonArea(points) <= EPSILON) continue;
    result.push(Object.freeze({
      color: positiveParity(band) === 0 ? 'yellow' : 'black',
      points: Object.freeze(points),
    }));
  }
  return Object.freeze(result);
}

function bufferGeometry(positions: readonly number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.constructionHazardStripeAngleDeg =
    CONSTRUCTION_HAZARD_MARKING_STYLE.stripeAngleDeg;
  geometry.userData.constructionHazardPattern = 'linear-open';
  geometry.userData.constructionHazardRadial = false;
  return geometry;
}

function positionsByColor(): Record<HazardColor, number[]> {
  return { yellow: [], black: [] };
}

function tierSubdivision(tier: PrimitiveGeometryTier): number {
  if (tier === 'close') return 3;
  if (tier === 'mid') return 2;
  return 1;
}

function appendMappedPolygon(
  positions: number[],
  points: readonly HazardUvPoint[],
  mapPoint: (point: HazardUvPoint) => readonly [number, number, number],
): void {
  const first = mapPoint(points[0]);
  for (let index = 1; index + 1 < points.length; index++) {
    triangle(positions, first, mapPoint(points[index]), mapPoint(points[index + 1]));
  }
}

function splitPolygonForCylinder(
  points: readonly HazardUvPoint[],
  circumference: number,
  segmentCount: number,
): readonly HazardUvPoint[][] {
  const slices: HazardUvPoint[][] = [];
  const left = -circumference * 0.5;
  const sliceWidth = circumference / segmentCount;
  for (let slice = 0; slice < segmentCount; slice++) {
    const minU = left + slice * sliceWidth;
    const maxU = minU + sliceWidth;
    let clipped = clipPolygon(points, ([u]) => u - minU);
    clipped = clipPolygon(clipped, ([u]) => maxU - u);
    if (clipped.length >= 3 && polygonArea(clipped) > EPSILON) {
      slices.push(clipped);
    }
  }
  return slices;
}

function buildSleeveGeometry(
  radius: number,
  length: number,
  stripeCount: number,
  tier: PrimitiveGeometryTier,
): MarkingGeometrySet {
  const byColor = positionsByColor();
  const circumference = Math.PI * 2 * radius;
  const polygons = buildLinearHazardStripePolygons(
    circumference,
    length,
    stripeCount,
  );
  const cylinderSegments = stripeCount * tierSubdivision(tier);
  for (const polygon of polygons) {
    const slices = splitPolygonForCylinder(
      polygon.points,
      circumference,
      cylinderSegments,
    );
    for (const slice of slices) {
      appendMappedPolygon(byColor[polygon.color], slice, ([arcDistance, axial]) => {
        const angle = arcDistance / radius;
        return [
          Math.cos(angle) * radius,
          axial,
          Math.sin(angle) * radius,
        ];
      });
    }
  }
  return Object.freeze({
    yellow: bufferGeometry(byColor.yellow),
    black: bufferGeometry(byColor.black),
  });
}

function axisVector(axis: ConstructionHostMarkingAxis): THREE.Vector3 {
  if (axis === 'forward') return new THREE.Vector3(1, 0, 0);
  if (axis === 'lateral') return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(0, 1, 0);
}

function panelAxes(
  axis: ConstructionHostMarkingAxis,
): readonly [u: THREE.Vector3, v: THREE.Vector3] {
  if (axis === 'forward') {
    return [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)];
  }
  if (axis === 'up') {
    return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
  }
  return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
}

function appendPanel(
  byColor: Record<HazardColor, number[]>,
  width: number,
  height: number,
  stripeCount: number,
  center: THREE.Vector3,
  axisU: THREE.Vector3,
  axisV: THREE.Vector3,
): void {
  const polygons = buildLinearHazardStripePolygons(width, height, stripeCount);
  for (const polygon of polygons) {
    appendMappedPolygon(byColor[polygon.color], polygon.points, ([u, v]) => {
      const point = center.clone()
        .addScaledVector(axisU, u)
        .addScaledVector(axisV, v);
      return [point.x, point.y, point.z];
    });
  }
}

function buildPanelGeometry(
  profile: Extract<ConstructionHostMarkingProfile, { kind: 'panel' }>,
  scale: number,
): MarkingGeometrySet {
  const byColor = positionsByColor();
  const [axisU, axisV] = panelAxes(profile.axis);
  appendPanel(
    byColor,
    profile.width * scale,
    profile.height * scale,
    profile.stripeCount,
    new THREE.Vector3(),
    axisU,
    axisV,
  );
  if (profile.mirrored) {
    const normal = axisVector(profile.axis);
    const normalOffset = profile.axis === 'forward'
      ? profile.center.forward
      : profile.axis === 'up' ? profile.center.up : profile.center.lateral;
    appendPanel(
      byColor,
      profile.width * scale,
      profile.height * scale,
      profile.stripeCount,
      normal.multiplyScalar(-2 * normalOffset * scale),
      axisU,
      axisV,
    );
  }
  return Object.freeze({
    yellow: bufferGeometry(byColor.yellow),
    black: bufferGeometry(byColor.black),
  });
}

function ringPlaneAxes(
  axis: ConstructionHostMarkingAxis,
): readonly [axisA: THREE.Vector3, axisB: THREE.Vector3] {
  if (axis === 'forward') {
    return [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  }
  if (axis === 'lateral') {
    return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
  }
  return [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)];
}

function appendBasisBox(
  positions: number[],
  center: THREE.Vector3,
  axisU: THREE.Vector3,
  axisV: THREE.Vector3,
  axisW: THREE.Vector3,
  width: number,
  height: number,
  depth: number,
): void {
  const mapPoint = (u: number, v: number, w: number): readonly [number, number, number] => {
    const point = center.clone()
      .addScaledVector(axisU, u)
      .addScaledVector(axisV, v)
      .addScaledVector(axisW, w);
    return [point.x, point.y, point.z];
  };
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const halfDepth = depth * 0.5;
  const backBottomLeft = mapPoint(-halfWidth, -halfHeight, -halfDepth);
  const backBottomRight = mapPoint(halfWidth, -halfHeight, -halfDepth);
  const backTopRight = mapPoint(halfWidth, halfHeight, -halfDepth);
  const backTopLeft = mapPoint(-halfWidth, halfHeight, -halfDepth);
  const frontBottomLeft = mapPoint(-halfWidth, -halfHeight, halfDepth);
  const frontBottomRight = mapPoint(halfWidth, -halfHeight, halfDepth);
  const frontTopRight = mapPoint(halfWidth, halfHeight, halfDepth);
  const frontTopLeft = mapPoint(-halfWidth, halfHeight, halfDepth);
  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
  ): void => {
    triangle(positions, a, b, c);
    triangle(positions, a, c, d);
  };
  quad(frontBottomLeft, frontBottomRight, frontTopRight, frontTopLeft);
  quad(backBottomRight, backBottomLeft, backTopLeft, backTopRight);
  quad(backBottomLeft, frontBottomLeft, frontTopLeft, backTopLeft);
  quad(frontBottomRight, backBottomRight, backTopRight, frontTopRight);
  quad(backTopLeft, frontTopLeft, frontTopRight, backTopRight);
  quad(backBottomRight, frontBottomRight, frontBottomLeft, backBottomLeft);
}

function appendChamferedBasisBox(
  positions: number[],
  center: THREE.Vector3,
  axisU: THREE.Vector3,
  axisV: THREE.Vector3,
  axisW: THREE.Vector3,
  width: number,
  height: number,
  depth: number,
  cornerChamfer: number,
): void {
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const halfDepth = depth * 0.5;
  const outline: readonly HazardUvPoint[] = [
    [-halfWidth + cornerChamfer, -halfHeight],
    [halfWidth - cornerChamfer, -halfHeight],
    [halfWidth, -halfHeight + cornerChamfer],
    [halfWidth, halfHeight - cornerChamfer],
    [halfWidth - cornerChamfer, halfHeight],
    [-halfWidth + cornerChamfer, halfHeight],
    [-halfWidth, halfHeight - cornerChamfer],
    [-halfWidth, -halfHeight + cornerChamfer],
  ];
  const mapPoint = (
    [u, v]: HazardUvPoint,
    w: number,
  ): readonly [number, number, number] => {
    const point = center.clone()
      .addScaledVector(axisU, u)
      .addScaledVector(axisV, v)
      .addScaledVector(axisW, w);
    return [point.x, point.y, point.z];
  };
  const front = outline.map((point) => mapPoint(point, halfDepth));
  const back = outline.map((point) => mapPoint(point, -halfDepth));
  for (let index = 1; index + 1 < outline.length; index++) {
    triangle(positions, front[0], front[index], front[index + 1]);
    triangle(positions, back[0], back[index + 1], back[index]);
  }
  for (let index = 0; index < outline.length; index++) {
    const next = (index + 1) % outline.length;
    triangle(positions, front[index], back[index], back[next]);
    triangle(positions, front[index], back[next], front[next]);
  }
}

function buildRingBoxesGeometry(
  profile: Extract<ConstructionHostMarkingProfile, { kind: 'ringBoxes' }>,
  scale: number,
  tier: PrimitiveGeometryTier,
): MarkingGeometrySet {
  const byColor = positionsByColor();
  const housing: number[] = [];
  const latch: number[] = [];
  const lod = tier === 'close'
    ? profile.lod.high
    : tier === 'mid' ? profile.lod.medium : profile.lod.low;
  const normal = axisVector(profile.axis);
  const [axisA, axisB] = ringPlaneAxes(profile.axis);
  const hostOuterRadius = (profile.ringRadius + profile.tubeRadius) * scale;
  const boxBackRadius = hostOuterRadius - profile.mountInset * scale;
  const boxDepth = profile.boxDepth * scale;
  const boxCenterRadius = boxBackRadius + boxDepth * 0.5;
  const boxFrontRadius = boxBackRadius + boxDepth;
  for (let box = 0; box < profile.boxCount; box++) {
    const angle = box / profile.boxCount * Math.PI * 2;
    const radial = axisA.clone().multiplyScalar(Math.cos(angle))
      .addScaledVector(axisB, Math.sin(angle));
    const tangent = axisA.clone().multiplyScalar(-Math.sin(angle))
      .addScaledVector(axisB, Math.cos(angle));
    const housingCenter = radial.clone().multiplyScalar(boxCenterRadius);
    if (lod.chamferedHousing) {
      appendChamferedBasisBox(
        housing,
        housingCenter,
        tangent,
        normal,
        radial,
        profile.boxWidth * scale,
        profile.boxHeight * scale,
        boxDepth,
        profile.cornerChamfer * scale,
      );
    } else {
      appendBasisBox(
        housing,
        housingCenter,
        tangent,
        normal,
        radial,
        profile.boxWidth * scale,
        profile.boxHeight * scale,
        boxDepth,
      );
    }
    appendPanel(
      byColor,
      profile.faceWidth * scale,
      profile.faceHeight * scale,
      profile.stripeCount,
      radial.clone().multiplyScalar(
        boxFrontRadius + profile.faceLift * scale,
      ),
      tangent,
      normal,
    );
    if (lod.topLatch) {
      appendBasisBox(
        latch,
        radial.clone()
          .multiplyScalar(boxFrontRadius - profile.latchDepth * scale * 0.5)
          .addScaledVector(
            normal,
            (profile.boxHeight + profile.latchHeight) * scale * 0.5,
          ),
        tangent,
        normal,
        radial,
        profile.latchWidth * scale,
        profile.latchHeight * scale,
        profile.latchDepth * scale,
      );
    }
    if (lod.cornerFasteners) {
      const fastenerSize =
        Math.min(profile.boxWidth, profile.boxHeight) * scale * 0.075;
      const fastenerDepth = profile.boxDepth * scale * 0.09;
      const fastenerU =
        (profile.boxWidth * 0.5 - profile.cornerChamfer * 0.58) * scale;
      const fastenerV =
        (profile.boxHeight * 0.5 - profile.cornerChamfer * 0.65) * scale;
      for (const sideSign of [-1, 1] as const) {
        appendBasisBox(
          latch,
          radial.clone()
            .multiplyScalar(
              boxFrontRadius +
              profile.faceLift * scale +
              fastenerDepth * 0.5,
            )
            .addScaledVector(tangent, fastenerU * sideSign)
            .addScaledVector(normal, fastenerV),
          tangent,
          normal,
          radial,
          fastenerSize,
          fastenerSize,
          fastenerDepth,
        );
      }
    }
  }
  const housingGeometry = bufferGeometry(housing);
  housingGeometry.userData.constructionHostMarkingLodTier = tier;
  housingGeometry.userData.constructionHostMarkingHousingStyle =
    lod.chamferedHousing ? 'chamfered' : 'box';
  const base = {
    yellow: bufferGeometry(byColor.yellow),
    black: bufferGeometry(byColor.black),
    housing: housingGeometry,
  };
  if (latch.length === 0) return Object.freeze(base);
  const hardwareGeometry = bufferGeometry(latch);
  hardwareGeometry.userData.constructionHostMarkingTopLatch = lod.topLatch;
  hardwareGeometry.userData.constructionHostMarkingCornerFasteners =
    lod.cornerFasteners;
  return Object.freeze({
    ...base,
    latch: hardwareGeometry,
  });
}

function markingGeometry(
  profile: ConstructionHostMarkingProfile,
  scale: number,
  tier: PrimitiveGeometryTier,
): MarkingGeometrySet {
  const key = `${tier}:${scale.toFixed(5)}:${JSON.stringify(profile)}`;
  let pair = markingGeometryCache.get(key);
  if (pair !== undefined) return pair;
  if (profile.kind === 'sleeve') {
    pair = buildSleeveGeometry(
      profile.radius * scale,
      profile.length * scale,
      profile.stripeCount,
      tier,
    );
  } else if (profile.kind === 'panel') {
    pair = buildPanelGeometry(profile, scale);
  } else {
    pair = buildRingBoxesGeometry(profile, scale, tier);
  }
  markingGeometryCache.set(key, pair);
  return pair;
}

function markingGroup(geometry: MarkingGeometrySet): THREE.Group {
  const group = new THREE.Group();
  if (geometry.housing !== undefined) {
    const housing = new THREE.Mesh(geometry.housing, hazardHousingMat);
    housing.userData.constructionHostMarking = true;
    housing.userData.constructionHostMarkingPart = 'mounted-housing';
    housing.userData.constructionHostMarkingVolume = true;
    group.add(housing);
  }
  if (geometry.latch !== undefined) {
    const latch = new THREE.Mesh(geometry.latch, hazardLatchMat);
    latch.userData.constructionHostMarking = true;
    latch.userData.constructionHostMarkingPart = 'top-latch';
    latch.userData.constructionHostMarkingVolume = true;
    group.add(latch);
  }
  const yellow = new THREE.Mesh(geometry.yellow, hazardYellowMat);
  const black = new THREE.Mesh(geometry.black, hazardBlackMat);
  for (const [mesh, color] of [
    [yellow, 'yellow'],
    [black, 'black'],
  ] as const) {
    mesh.userData.constructionHostMarking = true;
    mesh.userData.constructionHostMarkingColor = color;
    mesh.userData.constructionHazardStripeAngleDeg =
      CONSTRUCTION_HAZARD_MARKING_STYLE.stripeAngleDeg;
    mesh.userData.constructionHazardPattern = 'linear-open';
    mesh.userData.constructionHazardRadial = false;
  }
  group.add(yellow, black);
  return group;
}

/** Build an open-ended hazard sleeve with true 45-degree surface bands.
 * This is also the shared primitive used by construction-emitter pylons. */
export function buildConstructionHazardSleeve(
  radius: number,
  length: number,
  stripeCount: number,
  tier: PrimitiveGeometryTier,
): THREE.Group {
  const key = `pylon:${tier}:${radius.toFixed(5)}:${length.toFixed(5)}:${stripeCount}`;
  let geometry = markingGeometryCache.get(key);
  if (geometry === undefined) {
    geometry = buildSleeveGeometry(radius, length, stripeCount, tier);
    markingGeometryCache.set(key, geometry);
  }
  return markingGroup(geometry);
}

/** Build one permanent construction-host marking. The returned group is in
 * unit-local coordinates: +X forward, +Y up, +Z lateral. */
export function buildConstructionHostMarking(
  profile: ConstructionHostMarkingProfile,
  scale: number,
  tier: PrimitiveGeometryTier,
): THREE.Group {
  const group = markingGroup(markingGeometry(profile, scale, tier));
  group.position.set(
    profile.center.forward * scale,
    profile.center.up * scale,
    profile.center.lateral * scale,
  );
  if (profile.kind === 'sleeve') {
    if (profile.axis === 'forward') group.rotation.z = -Math.PI / 2;
    if (profile.axis === 'lateral') group.rotation.x = Math.PI / 2;
  }
  return group;
}

export function disposeConstructionHostMarkingGeometries(): void {
  for (const pair of markingGeometryCache.values()) {
    pair.yellow.dispose();
    pair.black.dispose();
    pair.housing?.dispose();
    pair.latch?.dispose();
  }
  markingGeometryCache.clear();
  hazardYellowMat.dispose();
  hazardBlackMat.dispose();
  hazardHousingMat.dispose();
  hazardLatchMat.dispose();
}
