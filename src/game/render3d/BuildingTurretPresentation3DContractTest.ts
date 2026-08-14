import * as THREE from 'three';
import type { ClientViewState } from '../network/ClientViewState';
import { getBuildingBlueprint } from '../sim/blueprints';
import { applyBuildingBlueprintRuntime } from '../sim/buildingEntityRuntime';
import { BUILD_GRID_CELL_SIZE } from '../sim/buildGrid';
import type { EntityId } from '../sim/types';
import { WorldState } from '../sim/WorldState';
import { BuildingEntityRenderer3D } from './BuildingEntityRenderer3D';
import { DETAIL_RUNG_CLOSE } from './EntityDetailLevel3D';
import type { EntityLodProxyRenderer3D } from './EntityLodProxyRenderer3D';
import type { EntityMesh } from './EntityMesh3D';
import { BuildingRenderPacket3D } from './EntityRenderPackets3D';
import { createRenderFrameState } from './RenderFrameState3D';
import type { ResourcePylonFlowController3D } from './ResourcePylonFlowController3D';
import type { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import { ScopedRenderMeshRetention3D } from './ScopedRenderMeshRetention3D';
import { TurretMountCache3D } from './TurretMountCache3D';
import {
  createPrimitiveCylinderGeometry,
  createPrimitiveSphereGeometry,
} from './PrimitiveGeometryQuality3D';

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
  const beamBlueprint = getBuildingBlueprint('towerBeamMega');
  const beamTower = worldState.createBuilding(
    320,
    220,
    beamBlueprint.gridWidth * BUILD_GRID_CELL_SIZE,
    beamBlueprint.gridHeight * BUILD_GRID_CELL_SIZE,
    beamBlueprint.gridDepth * BUILD_GRID_CELL_SIZE,
    1,
  );
  applyBuildingBlueprintRuntime(beamTower, 'towerBeamMega');
  let beamPilotLightVisible = true;

  const clientViewState = {
    getEntitySetVersion: () => 1,
    getBuildings: () => [tower, beamTower],
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
  const turretHeadGeom = createPrimitiveSphereGeometry('turret', 'close');
  const barrelGeom = createPrimitiveCylinderGeometry('turret', 'close');
  const coneBarrelGeom = createPrimitiveCylinderGeometry('turret', 'close', 1, 0.5);
  const turretMountCache = new TurretMountCache3D();
  const renderer = new BuildingEntityRenderer3D({
    world,
    clientViewState,
    selectionOverlays,
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
    isBeamPilotLightVisible: () => beamPilotLightVisible,
    turretMountCache,
  });
  const rows = new BuildingRenderPacket3D();
  const frameState = createRenderFrameState();

  try {
    turretMountCache.reset(16);
    rows.pushEntity(tower, false, true, true);
    rows.pushEntity(beamTower, false, true, true);
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
    const beamMesh = (renderer as unknown as BuildingRendererProbe).meshes.get(beamTower.id);
    assertContract(mesh !== undefined, 'first frame must create the tower mesh');
    assertContract(beamMesh !== undefined, 'first frame must create the beam-tower mesh');
    assertContract(mesh.turrets.length === 1, 'tower mesh must expose its cannon turret');
    const initialVisualYaw = mesh.turrets[0].yawGroup.rotation.y;
    assertContract(
      beamMesh.turrets[0].barrels[0].visible,
      'an idle building beam turret shows its pilot-light cone',
    );
    world.updateMatrixWorld(true);
    const expectedPilotOrigin = new THREE.Vector3();
    beamMesh.turrets[0].pitchGroup?.getWorldPosition(expectedPilotOrigin);
    const renderedBeamOrigin = turretMountCache.getEmission(beamTower.id, 0, 0);
    assertContract(
      renderedBeamOrigin !== null &&
        Math.abs(renderedBeamOrigin.x - expectedPilotOrigin.x) < 1e-5 &&
        Math.abs(renderedBeamOrigin.y - expectedPilotOrigin.z) < 1e-5 &&
        Math.abs(renderedBeamOrigin.z - expectedPilotOrigin.y) < 1e-5,
      'building beam QueryWeapon begins at the pilot-light base, not its pointed tip',
    );

    tower.combat.turrets[0].rotation = Math.PI / 2;
    beamPilotLightVisible = false;
    rows.reset();
    turretMountCache.reset(16);
    rows.pushEntity(tower, false, false, false);
    rows.pushEntity(beamTower, false, false, false);
    renderer.update(
      rows,
      frameState,
      0,
      16,
      16,
      false,
      () => DETAIL_RUNG_CLOSE,
    );

    const nextVisualYaw = mesh.turrets[0].yawGroup.rotation.y;
    assertContract(
      Math.abs(nextVisualYaw - initialVisualYaw) > 1,
      'turret pose must update on a clean static-building frame',
    );
    assertContract(
      Math.abs(nextVisualYaw + Math.PI / 2) < 1e-5,
      'tower mesh must consume the current interpolated turret yaw',
    );
    assertContract(
      Math.abs(mesh.turrets[0].root.rotation.y) < 1e-8,
      'logical yaw turns the presented turret body without rotating its fixed mount anchor',
    );
    assertContract(
      !beamMesh.turrets[0].barrels[0].visible,
      'a firing building beam turret hides its pilot-light cone',
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
