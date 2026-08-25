import * as THREE from 'three';
import {
  getRangeToggle,
  getVolumeToggle,
  RANGE_TYPES,
  setRangeToggle,
  setVolumeToggle,
} from '@/clientBarConfig';
import type { TurretRanges } from '@/types/combatTypes';
import type { RangeType } from '@/types/client';
import type { ClientViewState } from '../network/ClientViewState';
import { isAttackEmitter } from '../sim/emitterKinds';
import { WATER_LEVEL } from '../sim/Terrain';
import { WorldState } from '../sim/WorldState';
import type { EntityMesh } from './EntityMesh3D';
import type { OverlayLineSystem } from './OverlayLineSystem';
import { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import type { TurretMesh } from './TurretMesh3D';
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

    // Runtime wiring: TGT is independent from every TURR CIR switch and the
    // selection-overlay pass creates the shells for every attack turret.
    const previousRanges = new Map<RangeType, boolean>();
    for (const type of RANGE_TYPES) {
      previousRanges.set(type, getRangeToggle(type));
      setRangeToggle(type, false);
    }
    const previousTargetingVolume = getVolumeToggle('turretLockOn');
    setVolumeToggle('turretLockOn', true);
    const integrationWorld = new THREE.Group();
    const integrationSphereSource = new THREE.OctahedronGeometry(1, 1);
    const integrationSphereWireframe = new THREE.WireframeGeometry(integrationSphereSource);
    const selectedIds = new Set<number>();
    const integrationRenderer = new SelectionOverlayRenderer3D({
      world: integrationWorld,
      clientViewState: {
        getMapWidth: () => 512,
        getMapHeight: () => 512,
        getSelectedIds: () => selectedIds,
      } as unknown as ClientViewState,
      radiusSphereGeom: integrationSphereWireframe,
      overlayLines: undefined as unknown as OverlayLineSystem,
    });
    try {
      const simulation = new WorldState(81931, 512, 512);
      const host = simulation.createUnitFromBlueprint(120, 140, 1, 'unitJackal');
      simulation.addEntity(host);
      host.selectable!.selected = true;
      selectedIds.add(host.id);
      // Keep this a multi-selection so the ordinary single-selection
      // engagement ring does not enter this TGT-only integration probe.
      selectedIds.add(999_999);
      const turrets = host.combat?.turrets ?? [];
      const hostMesh = {
        group: new THREE.Group(),
        turrets: turrets.map(() => ({} as TurretMesh)),
      } as unknown as EntityMesh;
      integrationRenderer.beginFrame();
      integrationRenderer.updateRangeRings(hostMesh, host);
      const expectedShells = turrets.reduce((total, turret) => {
        if (!isAttackEmitter(turret)) return total;
        return total + 2 + (turret.ranges.tracking === null ? 0 : 2) +
          (turret.ranges.fire.min === null ? 0 : 2);
      }, 0);
      assertContract(
        expectedShells > 0 && integrationWorld.children.length === expectedShells,
        'VOLUMES TGT alone creates every configured shell on the selected host without TURR CIR',
      );

      host.selectable!.selected = false;
      selectedIds.clear();
      integrationRenderer.beginFrame();
      integrationRenderer.updateRangeRings(hostMesh, host);
      assertContract(
        integrationWorld.children.every((child) => child.visible === false),
        'deselecting a host hides its VOLUMES TGT shells even while the toggle remains enabled',
      );
      setRangeToggle('trackAcquire', true);
      integrationRenderer.beginFrame();
      assertContract(
        !integrationRenderer.unitRangeOverlaysNeedUpdate(hostMesh, false, host),
        'an enabled TURR CIR diagnostic must not schedule overlays for an unselected host',
      );
      host.selectable!.selected = true;
      selectedIds.add(host.id);
      selectedIds.add(999_999);
      integrationRenderer.beginFrame();
      assertContract(
        integrationRenderer.unitRangeOverlaysNeedUpdate(hostMesh, true, host),
        'an enabled TURR CIR diagnostic must schedule overlays for a selected host',
      );
      setRangeToggle('trackAcquire', false);

      setVolumeToggle('turretLockOn', false);
      integrationRenderer.beginFrame();
      integrationRenderer.updateRangeRings(hostMesh, host);
      assertContract(
        integrationWorld.children.every((child) => child.visible === false),
        'disabling VOLUMES TGT hides its world-parented turret shells',
      );
      integrationRenderer.removeWorldParentedOverlays(hostMesh);
      assertContract(
        Array.from(integrationWorld.children).length === 0,
        'entity teardown releases every integrated lock-on shell',
      );
    } finally {
      integrationRenderer.dispose();
      integrationSphereWireframe.dispose();
      integrationSphereSource.dispose();
      setVolumeToggle('turretLockOn', previousTargetingVolume);
      for (const type of RANGE_TYPES) {
        setRangeToggle(type, previousRanges.get(type) ?? false);
      }
    }
  } finally {
    renderer.dispose();
    sphereWireframe.dispose();
    sphereSource.dispose();
  }
}
