import type * as THREE from 'three';
import {
  PRIMITIVE_GEOMETRY_QUALITY,
  createPrimitiveCircleGeometry,
  createPrimitiveConeGeometry,
  createPrimitiveCylinderGeometry,
  createPrimitiveRingGeometry,
  createPrimitiveSphereGeometry,
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

export function runPrimitiveGeometryQuality3DContractTest(): void {
  const tiers: readonly PrimitiveGeometryTier[] = ['close', 'mid', 'far'];
  for (const [role, quality] of Object.entries(PRIMITIVE_GEOMETRY_QUALITY) as Array<[
    PrimitiveGeometryRole,
    typeof PRIMITIVE_GEOMETRY_QUALITY[PrimitiveGeometryRole],
  ]>) {
    for (const tier of tiers) {
      const label = `${role}/${tier}`;
      const sphere = createPrimitiveSphereGeometry(role, tier);
      assertParam(sphere, `${label}/sphere`, 'widthSegments', quality.sphere[tier].widthSegments);
      assertParam(sphere, `${label}/sphere`, 'heightSegments', quality.sphere[tier].heightSegments);
      sphere.dispose();

      const cylinder = createPrimitiveCylinderGeometry(role, tier);
      assertParam(cylinder, `${label}/cylinder`, 'radialSegments', quality.cylinder[tier].radialSegments);
      cylinder.dispose();

      const cone = createPrimitiveConeGeometry(role, tier);
      assertParam(cone, `${label}/cone`, 'radialSegments', quality.cone[tier].radialSegments);
      cone.dispose();

      const circle = createPrimitiveCircleGeometry(role, tier);
      assertParam(circle, `${label}/circle`, 'segments', quality.circle[tier].radialSegments);
      circle.dispose();

      const ring = createPrimitiveRingGeometry(role, tier);
      assertParam(ring, `${label}/ring`, 'thetaSegments', quality.circle[tier].radialSegments);
      ring.dispose();

      const torus = createPrimitiveTorusGeometry(role, tier);
      assertParam(torus, `${label}/torus`, 'radialSegments', quality.torus[tier].tubeSegments);
      assertParam(torus, `${label}/torus`, 'tubularSegments', quality.torus[tier].radialSegments);
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
}
