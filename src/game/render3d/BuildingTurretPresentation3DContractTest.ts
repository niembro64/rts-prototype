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
  const beamTurrets = beamTower.combat?.turrets;
  assertContract(
    beamTurrets !== undefined && beamTurrets.length === 2,
    'heavy beam fixture must mount two logical barrel stations',
  );
  const torpedoBlueprint = getBuildingBlueprint('towerTorpedo');
  const torpedoTower = worldState.createBuilding(
    440,
    220,
    torpedoBlueprint.gridWidth * BUILD_GRID_CELL_SIZE,
    torpedoBlueprint.gridHeight * BUILD_GRID_CELL_SIZE,
    torpedoBlueprint.gridDepth * BUILD_GRID_CELL_SIZE,
    1,
  );
  applyBuildingBlueprintRuntime(torpedoTower, 'towerTorpedo');
  assertContract(
    torpedoTower.combat?.turrets.length === 2,
    'torpedo fixture must mount two physical launcher heads',
  );
  let beamPilotLightVisible = true;

  const clientViewState = {
    getEntitySetVersion: () => 1,
    getBuildings: () => [tower, beamTower, torpedoTower],
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
    rows.pushEntity(torpedoTower, false, true, true);
    renderer.update(
      rows,
      frameState,
      0,
      10_000,
      false,
      () => DETAIL_RUNG_CLOSE,
    );

    const mesh = (renderer as unknown as BuildingRendererProbe).meshes.get(tower.id);
    const beamMesh = (renderer as unknown as BuildingRendererProbe).meshes.get(beamTower.id);
    const torpedoMesh = (renderer as unknown as BuildingRendererProbe).meshes.get(torpedoTower.id);
    assertContract(mesh !== undefined, 'first frame must create the tower mesh');
    assertContract(beamMesh !== undefined, 'first frame must create the beam-tower mesh');
    assertContract(torpedoMesh !== undefined, 'first frame must create the torpedo-tower mesh');
    assertContract(mesh.turrets.length === 1, 'tower mesh must expose its cannon turret');
    assertContract(
      beamMesh.turrets.length === 2 && beamMesh.buildingTurretHostPieces?.length === 1,
      'heavy beam presentation exposes two barrel stations and one shared head piece',
    );
    const beamHead = beamMesh.buildingTurretHostPieces[0];
    assertContract(
      beamHead.pieceId === 'beamHead' &&
        beamHead.pitchRoot !== undefined &&
        beamMesh.turrets.every((turret) => turret.root.parent === beamHead.pitchRoot),
      'both heavy-beam barrels are scenegraph children of the same yaw-and-pitch head',
    );
    assertContract(
      beamMesh.turrets.every((turret) => turret.head === undefined),
      'heavy beam barrel stations do not render independent turret heads',
    );
    assertContract(
      beamMesh.turrets.every((turret) => turret.root.position.x === 24) &&
        Math.abs(beamMesh.turrets[0].root.position.z) === 24 &&
        Math.abs(beamMesh.turrets[1].root.position.z) === 24 &&
        beamMesh.turrets[0].root.position.z === -beamMesh.turrets[1].root.position.z,
      'heavy beam barrels sit farther apart and project ahead of the shared shaft attachment',
    );
    const beamHeadHousing = beamHead.pitchRoot.getObjectByName('heavyBeamHeadHousing');
    const beamHeadYoke = beamHead.pitchRoot.getObjectByName('heavyBeamHeadYoke');
    const beamEmitterPods = [
      beamHead.pitchRoot.getObjectByName('heavyBeamEmitterPodLeft'),
      beamHead.pitchRoot.getObjectByName('heavyBeamEmitterPodRight'),
    ];
    const beamEmitterBands = [
      beamHead.pitchRoot.getObjectByName('heavyBeamEmitterBandLeft'),
      beamHead.pitchRoot.getObjectByName('heavyBeamEmitterBandRight'),
    ];
    assertContract(
      beamHeadHousing instanceof THREE.Mesh &&
        beamHeadHousing.scale.x > 36 &&
        beamHeadHousing.scale.y >= 28 &&
        beamHeadYoke instanceof THREE.Mesh &&
        beamHeadYoke.scale.y > 60,
      'heavy beam shared head keeps its enlarged central housing and broad support yoke',
    );
    assertContract(
      beamEmitterPods.every((pod) => (
        pod instanceof THREE.Mesh &&
        Math.abs(pod.position.z) === 24 &&
        pod.position.x + pod.scale.y / 2 === 24
      )) &&
        beamEmitterBands.every((band) => (
          band instanceof THREE.Mesh &&
          Math.abs(band.position.z) === 24 &&
          band.position.x + band.scale.y / 2 === 24
        )),
      'two separate forward housings and bands terminate exactly at their beam-emitter sockets',
    );
    assertContract(
      torpedoMesh.turrets.length === 2 &&
        torpedoMesh.buildingTurretHostPieces?.length === 1,
      'torpedo presentation exposes two heads and one shared torso piece',
    );
    const torpedoTorso = torpedoMesh.buildingTurretHostPieces[0];
    assertContract(
      torpedoTorso.pieceId === 'torpedoTorso' &&
        torpedoMesh.turrets.every((turret) => turret.root.parent === torpedoTorso.root),
      'both torpedo heads are scenegraph children of the same torso, not independent building mounts',
    );
    assertContract(
      Math.abs(torpedoMesh.turrets[0].root.position.z) === 16 &&
        Math.abs(torpedoMesh.turrets[1].root.position.z) === 16 &&
        torpedoMesh.turrets[0].root.position.z === -torpedoMesh.turrets[1].root.position.z,
      'the paired torpedo heads occupy opposite sockets on their common yoke',
    );
    const initialVisualYaw = mesh.turrets[0].yawGroup.rotation.y;
    const beamPilot = beamMesh.turrets[0].barrels[0];
    const beamPilotMaterial = beamPilot.material as THREE.ShaderMaterial;
    const beamPilotInner = beamPilot.children.find(
      (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh === true,
    );
    assertContract(
      beamPilotMaterial.isShaderMaterial === true &&
        beamPilotMaterial.transparent === true &&
        beamPilotMaterial.depthWrite === false &&
        beamPilotMaterial.uniforms.uTipTaper?.value === 0,
      'building beam barrels use the tapered transparent beam-wave material, not an opaque white barrel cap',
    );
    assertContract(
      beamPilotInner !== undefined &&
        (beamPilotInner.material as THREE.ShaderMaterial).isShaderMaterial === true &&
        beamPilotInner.scale.x < 1 && beamPilotInner.scale.z < 1,
      'building beam barrels retain the same narrower inner-energy layer as unit beam emitters',
    );
    assertContract(
      beamPilot.visible,
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
    beamTurrets[0].hostPieceYaw = Math.PI / 4;
    beamTurrets[0].pitch = 0.3;
    beamTurrets[0].rotation = Math.PI / 4;
    beamTurrets[1].rotation = Math.PI / 4;
    beamTurrets[1].pitch = 0.3;
    torpedoTower.combat.turrets[0].hostPieceYaw = Math.PI / 3;
    torpedoTower.combat.turrets[0].rotation = Math.PI / 3;
    torpedoTower.combat.turrets[1].rotation = Math.PI / 3;
    beamPilotLightVisible = false;
    rows.reset();
    turretMountCache.reset(16);
    rows.pushEntity(tower, false, false, false);
    rows.pushEntity(beamTower, false, false, false);
    rows.pushEntity(torpedoTower, false, false, false);
    renderer.update(
      rows,
      frameState,
      0,
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
      Math.abs(torpedoTorso.root.rotation.y + Math.PI / 3) < 1e-5 &&
        torpedoMesh.turrets.every((turret) => Math.abs(turret.yawGroup.rotation.y) < 1e-5),
      'the common torpedo torso consumes world yaw while both fixed-forward child heads stay at local yaw zero',
    );
    assertContract(
      Math.abs(beamHead.root.rotation.y + Math.PI / 4) < 1e-5 &&
        Math.abs(beamHead.pitchRoot.rotation.z - 0.3) < 1e-5 &&
        beamMesh.turrets.every((turret) => (
          Math.abs(turret.yawGroup.rotation.y) < 1e-5 &&
          Math.abs(turret.pitchGroup?.rotation.z ?? 0) < 1e-5
        )),
      'the one heavy-beam head consumes yaw and pitch while both barrel children remain locally fixed',
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
