import type * as THREE from 'three';
import {
  PRIMITIVE_GEOMETRY_QUALITY,
  createExtrudedEquilateralTriangleGeometry,
  createPrimitiveCircleGeometry,
  createPrimitiveConeGeometry,
  createPrimitiveCylinderGeometry,
  createPrimitiveRingGeometry,
  createPrimitiveSphereGeometry,
  createPrimitiveTetrahedronGeometry,
  createPrimitiveTorusGeometry,
  getSharedPrimitiveRingGeometry,
  getSharedPrimitiveSphereGeometry,
  type PrimitiveGeometryRole,
  type PrimitiveGeometryTier,
} from './PrimitiveGeometryQuality3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`[primitive geometry quality contract] ${message}`);
  }
}

function parameters(geom: THREE.BufferGeometry, label: string): Record<string, number> {
  const params = (geom as { parameters?: unknown }).parameters;
  assertContract(params && typeof params === 'object', `${label} exposes geometry parameters`);
  return params as Record<string, number>;
}

function assertParam(
  geom: THREE.BufferGeometry,
  label: string,
  name: string,
  expected: number,
): void {
  const actual = parameters(geom, label)[name];
  assertContract(
    actual === expected,
    `${label}.${name} expected ${expected}, got ${String(actual)}`,
  );
}

type TriangleBudget = Partial<Record<PrimitiveGeometryTier, number>>;

type PrimitiveTriangleBudget = {
  sphere?: TriangleBudget;
  cylinder?: TriangleBudget;
  cone?: TriangleBudget;
  circle?: TriangleBudget;
  ring?: TriangleBudget;
  torus?: TriangleBudget;
};

const HIGH_COUNT_TRIANGLE_BUDGETS: Partial<
  Record<PrimitiveGeometryRole, PrimitiveTriangleBudget>
> = {
  unitBody: {
    sphere: { close: 168, mid: 100, far: 36 },
    cylinder: { close: 40, mid: 32, far: 24 },
    cone: { close: 40, mid: 32, far: 24 },
    circle: { close: 18, mid: 12, far: 8 },
    ring: { close: 36, mid: 24, far: 16 },
    torus: { close: 320, mid: 168, far: 100 },
  },
  unitDetail: {
    sphere: { close: 140, mid: 80, far: 36 },
    cylinder: { close: 32, mid: 24, far: 24 },
    cone: { close: 32, mid: 24, far: 24 },
    circle: { close: 16, mid: 10, far: 8 },
    ring: { close: 32, mid: 20, far: 16 },
    torus: { close: 192, mid: 120, far: 64 },
  },
  turret: {
    sphere: { close: 140, mid: 80, far: 36 },
    cylinder: { close: 32, mid: 24, far: 24 },
    cone: { close: 32, mid: 24, far: 24 },
    circle: { close: 14, mid: 10, far: 8 },
    ring: { close: 28, mid: 20, far: 16 },
    torus: { close: 168, mid: 100, far: 64 },
  },
  projectile: {
    sphere: { close: 80, mid: 36, far: 20 },
    cylinder: { close: 32, mid: 24, far: 20 },
    cone: { close: 32, mid: 24, far: 20 },
    circle: { close: 12, mid: 8, far: 6 },
    ring: { close: 24, mid: 16, far: 12 },
    torus: { close: 144, mid: 80, far: 48 },
  },
  locomotion: {
    sphere: { close: 140, mid: 80, far: 36 },
    cylinder: { close: 32, mid: 24, far: 24 },
    cone: { close: 32, mid: 24, far: 24 },
    circle: { close: 14, mid: 10, far: 8 },
    ring: { close: 28, mid: 20, far: 16 },
    torus: { close: 192, mid: 120, far: 64 },
  },
};

function triangleCount(geom: THREE.BufferGeometry): number {
  const index = geom.getIndex();
  const count = index !== null ? index.count : geom.getAttribute('position').count;
  return count / 3;
}

function assertMaxTriangles(
  geom: THREE.BufferGeometry,
  label: string,
  expectedMax: number | undefined,
): void {
  if (expectedMax === undefined) return;
  const actual = triangleCount(geom);
  assertContract(
    actual <= expectedMax,
    `${label} triangles expected <= ${expectedMax}, got ${actual}`,
  );
}

export function runPrimitiveGeometryQuality3DContractTest(): void {
  const tiers: readonly PrimitiveGeometryTier[] = ['close', 'mid', 'far'];
  for (const [role, quality] of Object.entries(PRIMITIVE_GEOMETRY_QUALITY) as Array<[
    PrimitiveGeometryRole,
    typeof PRIMITIVE_GEOMETRY_QUALITY[PrimitiveGeometryRole],
  ]>) {
    const triangleBudget = HIGH_COUNT_TRIANGLE_BUDGETS[role];
    for (const tier of tiers) {
      const label = `${role}/${tier}`;
      const sphere = createPrimitiveSphereGeometry(role, tier);
      assertParam(sphere, `${label}/sphere`, 'widthSegments', quality.sphere[tier].widthSegments);
      assertParam(sphere, `${label}/sphere`, 'heightSegments', quality.sphere[tier].heightSegments);
      assertMaxTriangles(sphere, `${label}/sphere`, triangleBudget?.sphere?.[tier]);
      sphere.dispose();

      const cylinder = createPrimitiveCylinderGeometry(role, tier);
      assertParam(cylinder, `${label}/cylinder`, 'radialSegments', quality.cylinder[tier].radialSegments);
      assertMaxTriangles(cylinder, `${label}/cylinder`, triangleBudget?.cylinder?.[tier]);
      cylinder.dispose();

      const cone = createPrimitiveConeGeometry(role, tier);
      assertParam(cone, `${label}/cone`, 'radialSegments', quality.cone[tier].radialSegments);
      assertMaxTriangles(cone, `${label}/cone`, triangleBudget?.cone?.[tier]);
      cone.dispose();

      const circle = createPrimitiveCircleGeometry(role, tier);
      assertParam(circle, `${label}/circle`, 'segments', quality.circle[tier].radialSegments);
      assertMaxTriangles(circle, `${label}/circle`, triangleBudget?.circle?.[tier]);
      circle.dispose();

      const ring = createPrimitiveRingGeometry(role, tier);
      assertParam(ring, `${label}/ring`, 'thetaSegments', quality.circle[tier].radialSegments);
      assertMaxTriangles(ring, `${label}/ring`, triangleBudget?.ring?.[tier]);
      ring.dispose();

      const torus = createPrimitiveTorusGeometry(role, tier);
      assertParam(torus, `${label}/torus`, 'radialSegments', quality.torus[tier].tubeSegments);
      assertParam(torus, `${label}/torus`, 'tubularSegments', quality.torus[tier].radialSegments);
      assertMaxTriangles(torus, `${label}/torus`, triangleBudget?.torus?.[tier]);
      torus.dispose();
    }
  }

  const sharedSphereA = getSharedPrimitiveSphereGeometry('unitBody', 'close');
  const sharedSphereB = getSharedPrimitiveSphereGeometry('unitBody', 'close');
  const sharedSphereC = getSharedPrimitiveSphereGeometry('unitBody', 'mid');
  assertContract(sharedSphereA === sharedSphereB, 'shared sphere cache reuses identical keys');
  assertContract(sharedSphereA !== sharedSphereC, 'shared sphere cache separates tiers');

  const sharedRingA = getSharedPrimitiveRingGeometry('hud', 'close', 1, 1.15);
  const sharedRingB = getSharedPrimitiveRingGeometry('hud', 'close', 1, 1.15);
  const sharedRingC = getSharedPrimitiveRingGeometry('hud', 'mid', 1, 1.15);
  assertContract(sharedRingA === sharedRingB, 'shared ring cache reuses identical keys');
  assertContract(sharedRingA !== sharedRingC, 'shared ring cache separates tiers');

  const lowLegSegment = createExtrudedEquilateralTriangleGeometry();
  assertContract(
    triangleCount(lowLegSegment) === 8,
    'low leg segment is an eight-triangle equilateral triangular prism',
  );
  lowLegSegment.dispose();
  const lowLegJoint = createPrimitiveTetrahedronGeometry();
  assertContract(triangleCount(lowLegJoint) === 4, 'low leg joint is a four-face tetrahedron');
  lowLegJoint.dispose();
}
