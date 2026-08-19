import * as THREE from 'three';
import type { TurretRanges } from '@/types/combatTypes';
import { WATER_LEVEL } from '../sim/Terrain';
import {
  TURRET_LOCK_ON_BOUNDARY_KEYS,
  TurretLockOnVolumeRenderer3D,
  type TurretLockOnBoundaryKey,
} from './TurretLockOnVolume3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[turret lock-on volume 3D contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-6) {
    throw new Error(
      `[turret lock-on volume 3D contract] ${message}: expected ${expected}, got ${actual}`,
    );
  }
}

function boundaryMesh(
  world: THREE.Group,
  key: TurretLockOnBoundaryKey,
): THREE.LineSegments {
  const mesh = world.children.find(
    (child) => child.userData.turretLockOnBoundary === key,
  );
  assertContract(mesh instanceof THREE.LineSegments, `missing ${key} lock-on shell`);
  return mesh;
}

export function runTurretLockOnVolume3DContractTest(): void {
  const world = new THREE.Group();
  const sphereSource = new THREE.OctahedronGeometry(1, 2);
  const sphereWireframe = new THREE.WireframeGeometry(sphereSource);
  const renderer = new TurretLockOnVolumeRenderer3D(world, sphereWireframe);
  const owner = {};
  const mount = { x: 10, y: 20, z: 30 };
  const ranges: TurretRanges = {
    tracking: { acquire: 100, release: 120 },
    fire: {
      max: { acquire: 80, release: 90 },
      min: { acquire: 30, release: 20 },
    },
  };

  try {
    renderer.update(owner, mount, ranges, 'turret-range-sphere');
    assertContract(
      world.children.length === TURRET_LOCK_ON_BOUNDARY_KEYS.length,
      'one toggle materializes every tracking, engagement, and minimum-range shell',
    );
    const sphere = boundaryMesh(world, 'engageAcquire');
    assertContract(
      sphere.geometry === sphereWireframe &&
        sphere.userData.turretRangeVolume === 'turret-range-sphere',
      'sphere mode uses the shared unit-sphere wireframe',
    );
    assertNear(sphere.position.x, mount.x, 'sphere uses authoritative mount x');
    assertNear(sphere.position.y, mount.z, 'sphere uses authoritative mount altitude');
    assertNear(sphere.position.z, mount.y, 'sphere maps sim y to Three z');
    assertNear(sphere.scale.x, ranges.fire.max.acquire, 'sphere uses the acquire radius');

    renderer.update(owner, mount, ranges, 'turret-range-cylinder-normal');
    const bounded = boundaryMesh(world, 'engageAcquire');
    const boundedVertexCount = bounded.geometry.getAttribute('position').count;
    assertNear(bounded.position.y, mount.z, 'bounded cylinder centers on mount altitude');
    assertNear(bounded.scale.y, ranges.fire.max.acquire, 'bounded cylinder reaches ±range');
    assertNear(
      bounded.userData.bottomZ,
      mount.z - ranges.fire.max.acquire,
      'bounded cylinder has a real lower cap',
    );
    assertNear(
      bounded.userData.topZ,
      mount.z + ranges.fire.max.acquire,
      'bounded cylinder has a real upper cap',
    );

    renderer.update(owner, mount, ranges, 'turret-range-bottom-unbounded');
    const bottomUnbounded = boundaryMesh(world, 'engageAcquire');
    assertContract(
      bottomUnbounded.userData.bottomUnbounded === true &&
        bottomUnbounded.userData.topUnbounded === false &&
        bottomUnbounded.userData.bottomZ === Number.NEGATIVE_INFINITY,
      'bottom-unbounded mode exposes its infinite lower extent',
    );
    assertContract(
      bottomUnbounded.geometry.getAttribute('position').count > boundedVertexCount,
      'bottom-unbounded display adds arrowheads instead of a false terminal cap',
    );

    renderer.update(
      owner,
      mount,
      ranges,
      'turret-range-top-water-and-bottom-unbounded',
    );
    const waterCapped = boundaryMesh(world, 'engageAcquire');
    assertNear(waterCapped.userData.topZ, WATER_LEVEL, 'water-limited top stops at surface');
    assertContract(
      waterCapped.userData.bottomUnbounded === true && waterCapped.position.y < WATER_LEVEL,
      'water-limited cylinder continues downward from its surface cap',
    );

    renderer.update(owner, mount, ranges, 'turret-range-top-and-bottom-unbounded');
    const fullyUnbounded = boundaryMesh(world, 'engageAcquire');
    assertContract(
      fullyUnbounded.userData.bottomUnbounded === true &&
        fullyUnbounded.userData.topUnbounded === true &&
        fullyUnbounded.userData.bottomZ === Number.NEGATIVE_INFINITY &&
        fullyUnbounded.userData.topZ === Number.POSITIVE_INFINITY,
      'fully unbounded mode exposes both infinite vertical ends',
    );

    renderer.hide(owner);
    assertContract(
      world.children.every((child) => child.visible === false),
      'disabling TGT hides every shell without reallocating it',
    );
    renderer.remove(owner);
    assertContract(
      Array.from(world.children).length === 0,
      'host teardown removes world-parented shells',
    );
  } finally {
    renderer.dispose();
    sphereWireframe.dispose();
    sphereSource.dispose();
  }
}
