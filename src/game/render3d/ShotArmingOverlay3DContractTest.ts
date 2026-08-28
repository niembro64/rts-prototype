import * as THREE from 'three';
import {
  setVolumeToggle,
  VOLUME_TYPES,
} from '@/clientBarConfig';
import { WorldState } from '../sim/WorldState';
import { getBuildingBlueprint, getUnitBlueprint } from '../sim/blueprints';
import { applyBuildingBlueprintRuntime } from '../sim/buildingEntityRuntime';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import { createEntityVolume, writeArmingVolume } from '../sim/entityVolumes';
import { readNetworkUnitRadius } from '../network/unitSnapshotFields';
import type { EntityMesh } from './EntityMesh3D';
import { createSelectionOverlayFixture } from './selectionOverlayContractFixture';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[shot arming overlay contract] ${message}`);
}

function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(`[shot arming overlay contract] ${message}: expected ${expected}, got ${actual}`);
  }
}

export function runShotArmingOverlay3DContractTest(): void {
  const { renderer, selectedIds, radiusSphereGeom, restoreAndDispose } =
    createSelectionOverlayFixture();

  try {
    for (const type of VOLUME_TYPES) setVolumeToggle(type, type === 'arming');
    renderer.beginFrame();

    const world = new WorldState(7831, 512, 512);
    const host = world.createUnitFromBlueprint(
      120,
      140,
      1,
      'unitFormik',
    );
    assertContract(host.unit !== null, 'overlay host must carry a unit component');
    // Reproduce live-client radius hydration; ARM derives from this HIT shape.
    host.unit.radius = readNetworkUnitRadius(null, getUnitBlueprint('unitFormik').radius);
    const mesh = {
      group: new THREE.Group(),
      turrets: [],
    } as unknown as EntityMesh;
    renderer.updateHostVolumes(mesh, host);
    const unselectedUnitArmMesh = mesh.radiusRings?.arming;
    assertContract(
      unselectedUnitArmMesh === undefined,
      'ARM toggle must not create a sphere for an unselected unit',
    );
    assertContract(host.selectable !== null, 'overlay host must be selectable');
    host.selectable.selected = true;
    selectedIds.add(host.id);
    renderer.beginFrame();
    renderer.updateHostVolumes(mesh, host);

    const armMesh = mesh.radiusRings?.arming;
    assertContract(armMesh !== undefined, 'ARM toggle must create a unit sphere mesh');
    assertContract(armMesh.visible, 'ARM unit sphere mesh must be visible while its button is active');
    const unitArm = createEntityVolume();
    assertContract(writeArmingVolume(host, unitArm), 'unit must publish ARM geometry');
    assertContract(unitArm.shape === 'sphere', 'unit ARM must match its spherical HIT shape');
    assertNear(armMesh.scale.x, unitArm.halfX, 'unit ARM mesh must draw authoritative extent');

    const buildingBlueprint = getBuildingBlueprint('towerCannon');
    const building = world.createBuilding(
      280,
      280,
      buildingBlueprint.gridWidth * BUILD_GRID_CELL_SIZE,
      buildingBlueprint.gridHeight * BUILD_GRID_CELL_SIZE,
      buildingBlueprint.gridDepth * BUILD_GRID_CELL_SIZE,
      1,
    );
    applyBuildingBlueprintRuntime(building, 'towerCannon');
    const buildingMesh = {
      group: new THREE.Group(),
      turrets: [],
    } as unknown as EntityMesh;
    renderer.updateHostVolumes(buildingMesh, building);
    const unselectedBuildingArmMesh = buildingMesh.radiusRings?.arming;
    assertContract(
      unselectedBuildingArmMesh === undefined,
      'ARM toggle must not create a box for an unselected building',
    );
    assertContract(building.selectable !== null, 'overlay building must be selectable');
    building.selectable.selected = true;
    selectedIds.add(building.id);
    renderer.beginFrame();
    renderer.updateHostVolumes(buildingMesh, building);
    const buildingArmMesh = buildingMesh.radiusRings?.arming;
    assertContract(buildingArmMesh !== undefined, 'ARM toggle must create a building box mesh');
    assertContract(buildingArmMesh.visible, 'ARM building box mesh must be visible');
    assertContract(
      buildingArmMesh.geometry !== radiusSphereGeom,
      'building ARM must not regress to the old sphere geometry',
    );
    const buildingArm = createEntityVolume();
    assertContract(writeArmingVolume(building, buildingArm), 'building must publish ARM geometry');
    assertContract(buildingArm.shape === 'box', 'building ARM must match its box HIT shape');
    assertNear(buildingArmMesh.scale.x, buildingArm.halfX * 2, 'building ARM mesh x extent');
    assertNear(buildingArmMesh.scale.y, buildingArm.halfZ * 2, 'building ARM mesh z extent');
    assertNear(buildingArmMesh.scale.z, buildingArm.halfY * 2, 'building ARM mesh y extent');

    setVolumeToggle('arming', false);
    renderer.beginFrame();
    renderer.updateHostVolumes(mesh, host);
    assertContract(!armMesh.visible, 'ARM host sphere mesh must hide when its button is inactive');
    renderer.updateHostVolumes(buildingMesh, building);
    assertContract(!buildingArmMesh.visible, 'ARM host box mesh must hide when its button is inactive');
  } finally {
    restoreAndDispose();
  }
}
