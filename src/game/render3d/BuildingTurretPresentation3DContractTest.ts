import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import { getBuildingBlueprint } from '../sim/blueprints';
import { applyBuildingBlueprintRuntime } from '../sim/buildingEntityRuntime';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import type { EntityId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { BuildingEntityRenderer3D } from './BuildingEntityRenderer3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import { DETAIL_RUNG_CLOSE } from './EntityDetailLevel3D';
import type { EntityLodProxyRenderer3D } from './EntityLodProxyRenderer3D';
import type { EntityMesh } from './EntityMesh3D';
import { BuildingRenderPacket3D } from './EntityRenderPackets3D';
import { createRenderFrameState } from './RenderFrameState3D';
import type { ResourcePylonFlowController3D } from './ResourcePylonFlowController3D';
import type { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import { ScopedRenderMeshRetention3D } from './ScopedRenderMeshRetention3D';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[building turret presentation contract] ${message}`);
}

type BuildingRendererProbe = {
  meshes: { get(id: EntityId): EntityMesh | undefined };
};

/** A static building body must not make its independently animated turret
 *  inherit the sparse snapshot-dirty cadence. */
export function runBuildingTurretPresentation3DContractTest(): void {
  const worldState = new WorldState(9371, 512, 512);
  const blueprint = getBuildingBlueprint('towerCannon');
  const tower = worldState.createBuilding(
    200,
    220,
    blueprint.gridWidth * BUILD_GRID_CELL_SIZE,
    blueprint.gridHeight * BUILD_GRID_CELL_SIZE,
    blueprint.gridDepth * BUILD_GRID_CELL_SIZE,
    1,
  );
  applyBuildingBlueprintRuntime(tower, 'towerCannon');
  assertContract(tower.combat?.turrets.length === 1, 'fixture must mount one cannon turret');

  const clientViewState = {
    getEntitySetVersion: () => 1,
    getBuildings: () => [tower],
    getResourcePylonSourceIds: () => [],
  } as unknown as ClientViewState;
  const selectionOverlays = {
    getRangeStateVersion: () => 0,
    getUnitOverlayStateVersion: () => 0,
    buildingRangeOverlaysNeedUpdate: () => false,
    unitStaticOverlaysNeedUpdate: () => false,
    updateSelectionRing: () => undefined,
    updateRangeRings: () => undefined,
    updateHostVolumes: () => undefined,
  } as unknown as SelectionOverlayRenderer3D;
  const world = new THREE.Group();
  const primaryMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x888888 });
  const turretHeadGeom = new THREE.SphereGeometry(1, 8, 6);
  const barrelGeom = new THREE.CylinderGeometry(1, 1, 1, 8);
  const coneBarrelGeom = new THREE.CylinderGeometry(1, 0.5, 1, 8);
  const renderer = new BuildingEntityRenderer3D({
    world,
    clientViewState,
    selectionOverlays,
    constructionVisuals: {} as ConstructionVisualController3D,
    resourcePylonFlows: {} as ResourcePylonFlowController3D,
    turretHeadGeom,
    barrelGeom,
    coneBarrelGeom,
    getPrimaryMat: () => primaryMaterial,
    getTeamOrnamentMat: () => primaryMaterial,
    barrelMat: accentMaterial,
    disposeWorldParentedOverlays: () => undefined,
    metalDeposits: [],
    scopedMeshRetention: new ScopedRenderMeshRetention3D(),
    lodProxyRenderer: { pushBuildingProxy: () => undefined } as unknown as EntityLodProxyRenderer3D,
  });
  const rows = new BuildingRenderPacket3D();
  const frameState = createRenderFrameState();

  try {
    rows.pushEntity(tower, false, true, true);
    renderer.update(
      rows,
      frameState,
      0,
      10_000,
      0,
      false,
      () => DETAIL_RUNG_CLOSE,
    );

    const mesh = (renderer as unknown as BuildingRendererProbe).meshes.get(tower.id);
    assertContract(mesh !== undefined, 'first frame must create the tower mesh');
    assertContract(mesh.turrets.length === 1, 'tower mesh must expose its cannon turret');
    const initialVisualYaw = mesh.turrets[0].root.rotation.y;

    tower.combat.turrets[0].rotation = Math.PI / 2;
    rows.reset();
    rows.pushEntity(tower, false, false, false);
    renderer.update(
      rows,
      frameState,
      0,
      16,
      16,
      false,
      () => DETAIL_RUNG_CLOSE,
    );

    const nextVisualYaw = mesh.turrets[0].root.rotation.y;
    assertContract(
      Math.abs(nextVisualYaw - initialVisualYaw) > 1,
      'turret pose must update on a clean static-building frame',
    );
    assertContract(
      Math.abs(nextVisualYaw + Math.PI / 2) < 1e-5,
      'tower mesh must consume the current interpolated turret yaw',
    );
  } finally {
    renderer.destroy();
    primaryMaterial.dispose();
    accentMaterial.dispose();
    turretHeadGeom.dispose();
    barrelGeom.dispose();
    coneBarrelGeom.dispose();
  }
}
