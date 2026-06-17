import * as THREE from 'three';
import type { Entity, EntityId, PlayerId, Turret } from '../sim/types';
import type { MetalDeposit } from '../../metalDepositConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getGraphicsConfig } from '@/clientBarConfig';
import type { ClientViewState } from '../network/ClientViewState';
import { getTurretHeadRadius } from '../math';
import {
  applyEntityGroupFade,
  disposeEntityGroupFade,
  DyingMeshFade,
  ENTITY_DEATH_FADE_MS,
} from './EntityFade3D';
import { VISION_FADE_IN_MS, VISION_FADE_OUT_MS } from '@/visionConfig';
import {
  buildBuildingShape,
  type BuildingShapeType,
} from './BuildingShape3D';
import type { EntityMesh } from './EntityMesh3D';
import type { RenderFrameState3D } from './RenderFrameState3D';
import { BuildingAnimationController3D } from './BuildingAnimationController3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import type { ResourcePylonFlowController3D } from './ResourcePylonFlowController3D';
import type { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import {
  buildTurretMesh3D,
  type TurretMesh,
} from './TurretMesh3D';
import { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import type { TurretBeamAimCache3D } from './TurretBeamAimCache3D';
import { BuildingRenderPacket3D } from './EntityRenderPackets3D';
import {
  TURRET_AIM_INPUT_STRIDE,
  TURRET_AIM_MODE_POSE,
  TURRET_AIM_MODE_WORLD_DIR,
  UnitTurretAimBatch3D,
} from './UnitTurretAimBatch3D';
import {
  BUILDING_POSE_INPUT_STRIDE,
  BuildingPoseBatch3D,
} from './BuildingPoseBatch3D';
import type { ScopedRenderMeshRetention3D } from './ScopedRenderMeshRetention3D';
import {
  setEulerYIfChanged,
  setEulerZIfChanged,
  setObjectVisibleIfChanged,
  setVector3IfChanged,
} from './threeTransformWriteUtils';
import type { EntityLodProxyRenderer3D } from './EntityLodProxyRenderer3D';

const BUILDING_HEIGHT = 120;

function entityHasPerFrameBuildingTurretWork(entity: Entity): boolean {
  const turrets = entity.combat?.turrets;
  if (!turrets || turrets.length === 0) return false;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    const barrel = turret.config.barrel;
    if (
      barrel !== undefined &&
      (barrel.type === 'simpleMultiBarrel' || barrel.type === 'coneMultiBarrel')
    ) {
      return true;
    }
  }
  return false;
}

function positionBuildingTurretRoot(turretMesh: TurretMesh, turret: Turret): void {
  const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.config);
  setVector3IfChanged(
    turretMesh.root.position,
    turret.mount.x,
    turret.mount.z - headRadius,
    turret.mount.y,
  );
  setObjectVisibleIfChanged(turretMesh.root, false);
  turretMesh.cachedRootVisible = false;
}

type BuildingTurretSpinEntry = {
  turretIndex: number;
  turretMesh: TurretMesh;
  active: boolean;
};

export type BuildingEntityMeshFactoryOptions = {
  entity: Entity;
  width: number;
  depth: number;
  ownerId: PlayerId | undefined;
  geometryKey: string;
  world: THREE.Group;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  coneBarrelGeom: THREE.CylinderGeometry;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  getTurretAccentMat: (playerId: PlayerId | undefined) => THREE.Material;
};

export function createBuildingEntityMesh3D(options: BuildingEntityMeshFactoryOptions): EntityMesh {
  const {
    entity,
    width,
    depth,
    ownerId,
    geometryKey,
    world,
    turretHeadGeom,
    barrelGeom,
    coneBarrelGeom,
    getPrimaryMat,
    getTurretAccentMat,
  } = options;
  const shapeType: BuildingShapeType = entity.buildingBlueprintId
    ? getBuildingConfig(entity.buildingBlueprintId).renderProfile
    : 'unknown';
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.userData.entityId = entity.id;

  const shape = buildBuildingShape(
    shapeType,
    width,
    depth,
    getPrimaryMat(ownerId),
    entity.buildingBlueprintId,
  );
  shape.primary.matrixAutoUpdate = false;
  shape.primary.userData.entityId = entity.id;

  const chassis = new THREE.Group();
  chassis.userData.entityId = entity.id;
  chassis.add(shape.primary);
  group.add(chassis);

  for (const detail of shape.details) {
    detail.mesh.userData.entityId = entity.id;
    group.add(detail.mesh);
  }

  const buildingTurretMeshes: TurretMesh[] = [];
  const buildingTurrets = entity.combat?.turrets;
  if (buildingTurrets) {
    const buildingGfx = getGraphicsConfig();
    for (let ti = 0; ti < buildingTurrets.length; ti++) {
      const turret = buildingTurrets[ti];
      const turretMesh = buildTurretMesh3D(group, turret, buildingGfx, {
        headGeom: turretHeadGeom,
        barrelGeom,
        coneBarrelGeom,
        primaryMat: getPrimaryMat(ownerId),
        turretAccentMat: getTurretAccentMat(ownerId),
      });
      positionBuildingTurretRoot(turretMesh, turret);
      if (turretMesh.head) turretMesh.head.userData.entityId = entity.id;
      for (const barrel of turretMesh.barrels) barrel.userData.entityId = entity.id;
      buildingTurretMeshes.push(turretMesh);
    }
  }

  world.add(group);

  return {
    group,
    chassis,
    chassisMeshes: [shape.primary],
    // Buildings don't use unit body-shape pools (they have their own
    // BuildingShape3D path), so the field is unused here.
    bodyShapeKey: '',
    turrets: buildingTurretMeshes,
    geometryKey,
    buildingDetails: shape.details,
    factoryBuildSpotRig: shape.factoryBuildSpotRig,
    windRig: shape.windRig,
    extractorRig: shape.extractorRig,
    solarRig: shape.solarRig,
    radarRig: shape.radarRig,
    converterRig: shape.converterRig,
    buildingRenderFrameKey: geometryKey,
    buildingRenderBlueprintId: entity.buildingBlueprintId,
    buildingRenderTurretCount: buildingTurrets?.length ?? 0,
    buildingHasPerFrameTurretWork: entityHasPerFrameBuildingTurretWork(entity),
    buildingHeight: shape.height,
    buildingPrimaryMaterialLocked: shape.primaryMaterialLocked === true,
    buildingBodyless: shape.bodyless === true,
    solarOpenAmount: entity.building?.activeState?.open === false ? 0 : 1,
  };
}

export type BuildingEntityRenderer3DOptions = {
  world: THREE.Group;
  clientViewState: ClientViewState;
  selectionOverlays: SelectionOverlayRenderer3D;
  constructionVisuals: ConstructionVisualController3D;
  resourcePylonFlows: ResourcePylonFlowController3D;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  coneBarrelGeom: THREE.CylinderGeometry;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  getTurretAccentMat: (playerId: PlayerId | undefined) => THREE.Material;
  disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
  metalDeposits: readonly MetalDeposit[];
  scopedMeshRetention: ScopedRenderMeshRetention3D;
  lodProxyRenderer: EntityLodProxyRenderer3D;
};

export class BuildingEntityRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly selectionOverlays: SelectionOverlayRenderer3D;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly resourcePylonFlows: ResourcePylonFlowController3D;
  private readonly turretHeadGeom: THREE.SphereGeometry;
  private readonly barrelGeom: THREE.CylinderGeometry;
  private readonly coneBarrelGeom: THREE.CylinderGeometry;
  private readonly getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly getTurretAccentMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
  private readonly scopedMeshRetention: ScopedRenderMeshRetention3D;
  private readonly lodProxyRenderer: EntityLodProxyRenderer3D;
  private readonly animations: BuildingAnimationController3D;
  private readonly meshes = new Map<EntityId, EntityMesh>();
  private renderScopeToken = 0;
  private lastEntitySetVersion = -1;
  // Shared death-out flow (same controller units use, see EntityFade3D): a
  // dead building/tower is kept and its whole group dissolved 1 → 0 before
  // teardown, while the blast + debris play out. Assigned in the constructor.
  private readonly dyingBuildings: DyingMeshFade<EntityMesh>;
  // Buildings/towers that left the local player's vision. Same as unit
  // vision fade-out: quiet alpha dissolve in place, distinct from death.
  private readonly vanishingBuildings: DyingMeshFade<EntityMesh>;
  /** Per-entity vision fade-IN clock. Kept outside row updates because
   *  buildings are usually submitted only when dirty, unlike units. */
  private readonly spawnFadeElapsed = new Map<EntityId, number>();
  /** Gatling spin for tower-mounted multi-barrel turrets (e.g. the
   *  Anti-Air rocket gatling). Towers render per-Mesh, so they keep
   *  their own spin state separate from the unit renderer's. */
  private readonly barrelSpin = new UnitBarrelSpinState3D();
  /** Set each frame from update(): last beam direction per turret, read
   *  to aim beam-directed heads on beam towers (turretBeamLong). */
  private beamAimCache: TurretBeamAimCache3D | null = null;
  private barrelSpinEnabled = false;
  private readonly fallbackBuildingRenderRows = new BuildingRenderPacket3D();
  private readonly turretAimBatch = new UnitTurretAimBatch3D();
  private turretAimInput = new Float32Array(TURRET_AIM_INPUT_STRIDE * 256);
  private turretAimCount = 0;
  private readonly turretAimMeshes: TurretMesh[] = [];
  private readonly buildingPoseBatch = new BuildingPoseBatch3D();
  private buildingPoseInput = new Float32Array(BUILDING_POSE_INPUT_STRIDE * 256);
  private buildingPoseCount = 0;
  private readonly buildingPoseMeshes: EntityMesh[] = [];
  private readonly buildingPoseRotations: number[] = [];
  private readonly buildingSpinEntries: BuildingTurretSpinEntry[] = [];
  private readonly buildingSpinEntriesByEntity = new Map<EntityId, BuildingTurretSpinEntry[]>();
  private buildingSpinDeadEntries = 0;
  private buildingSpinResetPending = false;
  private lastFrameStateKey: string | null = null;
  private lastRangeOverlayStateVersion = -1;
  private lastUnitOverlayStateVersion = -1;

  constructor(options: BuildingEntityRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.selectionOverlays = options.selectionOverlays;
    this.constructionVisuals = options.constructionVisuals;
    this.resourcePylonFlows = options.resourcePylonFlows;
    this.turretHeadGeom = options.turretHeadGeom;
    this.barrelGeom = options.barrelGeom;
    this.coneBarrelGeom = options.coneBarrelGeom;
    this.getPrimaryMat = options.getPrimaryMat;
    this.getTurretAccentMat = options.getTurretAccentMat;
    this.disposeWorldParentedOverlays = options.disposeWorldParentedOverlays;
    this.scopedMeshRetention = options.scopedMeshRetention;
    this.lodProxyRenderer = options.lodProxyRenderer;
    this.animations = new BuildingAnimationController3D(
      this.clientViewState,
      this.constructionVisuals,
      this.resourcePylonFlows,
      options.metalDeposits,
    );
    this.dyingBuildings = new DyingMeshFade<EntityMesh>(
      ENTITY_DEATH_FADE_MS,
      (mesh, fade) => applyEntityGroupFade(mesh.group, fade),
      (_id, mesh) => this.disposeBuildingMesh(mesh),
    );
    this.vanishingBuildings = new DyingMeshFade<EntityMesh>(
      VISION_FADE_OUT_MS,
      (mesh, fade) => applyEntityGroupFade(mesh.group, fade),
      (_id, mesh) => this.disposeBuildingMesh(mesh),
    );
  }

  markEntityKilled(id: EntityId): void {
    const mesh = this.meshes.get(id);
    if (mesh) mesh.killed = true;
  }

  update(
    buildingRows: BuildingRenderPacket3D | undefined,
    frameState: RenderFrameState3D,
    spinDt: number,
    currentDtMs: number,
    timeMs: number,
    beamAimCache: TurretBeamAimCache3D,
    scopedRender: boolean = false,
  ): void {
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const packetProvided = buildingRows !== undefined;
    const fallbackFullPrune = !packetProvided && entitySetVersion !== this.lastEntitySetVersion;
    const rangeOverlayStateVersion = this.selectionOverlays.getRangeStateVersion();
    const unitOverlayStateVersion = this.selectionOverlays.getUnitOverlayStateVersion();
    const forceFullRows =
      !scopedRender &&
      (
        !packetProvided ||
        this.lastFrameStateKey !== frameState.key ||
        this.lastRangeOverlayStateVersion !== rangeOverlayStateVersion ||
        this.lastUnitOverlayStateVersion !== unitOverlayStateVersion ||
        (this.meshes.size === 0 && this.clientViewState.getBuildings().length > 0)
      );
    const pruneBuildings = scopedRender || fallbackFullPrune || forceFullRows;
    const pruneToken = pruneBuildings
      ? ++this.renderScopeToken
      : 0;
    this.beamAimCache = beamAimCache;
    const nextBarrelSpinEnabled = getGraphicsConfig().barrelSpin;
    if (nextBarrelSpinEnabled !== this.barrelSpinEnabled) {
      this.buildingSpinResetPending = !nextBarrelSpinEnabled;
      this.barrelSpinEnabled = nextBarrelSpinEnabled;
    }
    this.beginTurretAimFrame();
    this.beginBuildingPoseFrame();
    if (buildingRows !== undefined) {
      this.removeBuildingMeshesFromPacket(buildingRows, beamAimCache);
    }
    const rows = forceFullRows
      ? this.populateFallbackBuildingRenderRows()
      : buildingRows ?? this.populateFallbackBuildingRenderRows();
    if (buildingRows === undefined) this.removeBuildingMeshesFromPacket(rows, beamAimCache);

    for (let row = 0; row < rows.count; row++) {
      const entityId = rows.entityIdAt(row);
      const entity = rows.entityAt(row);
      if (entity === undefined || entity.building === null) continue;

      const mesh = this.meshes.get(entityId);
      if (rows.lodProxyAt(row)) {
        this.lodProxyRenderer.pushBuilding(entity);
        if (mesh !== undefined) {
          if (pruneBuildings) mesh.renderSeenToken = pruneToken;
          this.deactivateBuildingMeshForLod(entityId, mesh, beamAimCache);
        }
        continue;
      }
      const wasLodProxyActive = mesh?.renderLodProxyActive === true;
      if (mesh !== undefined) {
        this.reactivateBuildingMeshForScope(entity, mesh);
        this.reactivateBuildingMeshForLod(entity, mesh);
      }
      const rowDirty = rows.renderDirtyAt(row) || rows.lifecycleDirtyAt(row);
      const activePrediction = rows.activePredictionAt(row);
      const needsTurretFrame = activePrediction;
      const bodyFadeActive =
        rows.bodyOpacity[row] < 1 || mesh?.buildingGroupFadeActive === true;
      const rangeOverlayVersionDirty =
        mesh !== undefined && mesh.buildingRangeOverlayVersion !== rangeOverlayStateVersion;
      const unitOverlayVersionDirty =
        mesh !== undefined && mesh.buildingUnitOverlayVersion !== unitOverlayStateVersion;
      const overlayDirty =
        mesh !== undefined &&
        (rowDirty || rangeOverlayVersionDirty || unitOverlayVersionDirty) &&
        this.staticBuildingOverlaysNeedUpdate(mesh, entity, rows, row);
      if (mesh !== undefined && rangeOverlayVersionDirty && !overlayDirty) {
        mesh.buildingRangeOverlayVersion = rangeOverlayStateVersion;
      }
      if (mesh !== undefined && unitOverlayVersionDirty && !overlayDirty) {
        mesh.buildingUnitOverlayVersion = unitOverlayStateVersion;
      }
      if (
        mesh !== undefined &&
        !rowDirty &&
        !needsTurretFrame &&
        !bodyFadeActive &&
        !overlayDirty &&
        !wasLodProxyActive
      ) {
        setObjectVisibleIfChanged(mesh.group, true);
        if (pruneBuildings) mesh.renderSeenToken = pruneToken;
        continue;
      }

      this.updateBuilding(
        entity,
        rows,
        row,
        frameState,
        rangeOverlayStateVersion,
        unitOverlayStateVersion,
        mesh === undefined || overlayDirty,
      );
      if (pruneBuildings) {
        const updatedMesh = this.meshes.get(entityId);
        if (updatedMesh !== undefined) updatedMesh.renderSeenToken = pruneToken;
      }
    }

    this.flushBuildingPoseRecords();
    this.flushTurretAimRecords();
    if (pruneBuildings) this.pruneUnseenBuildingMeshes(pruneToken, scopedRender, beamAimCache);
    this.updateBuildingTurretSpinQueue(spinDt);
    this.animations.update(spinDt, currentDtMs, timeMs);
    this.updateBuildingSpawnFades(currentDtMs);
    // Advance any in-progress death-out fades every frame (independent of
    // the entity-set prune cadence below).
    this.dyingBuildings.update(currentDtMs);
    this.vanishingBuildings.update(currentDtMs);

    this.lastEntitySetVersion = entitySetVersion;
    this.lastFrameStateKey = frameState.key;
    this.lastRangeOverlayStateVersion = rangeOverlayStateVersion;
    this.lastUnitOverlayStateVersion = unitOverlayStateVersion;
  }

  private populateFallbackBuildingRenderRows(): BuildingRenderPacket3D {
    const rows = this.fallbackBuildingRenderRows;
    rows.reset();
    const buildings = this.clientViewState.getBuildings();
    for (let i = 0; i < buildings.length; i++) {
      rows.pushEntity(buildings[i], false, true, true);
    }
    return rows;
  }

  private staticBuildingOverlaysNeedUpdate(
    mesh: EntityMesh,
    entity: Entity,
    rows: BuildingRenderPacket3D,
    row: number,
  ): boolean {
    return this.selectionOverlays.buildingRangeOverlaysNeedUpdate(
      mesh,
      entity,
      rows.selectedAt(row),
    ) || this.selectionOverlays.unitStaticOverlaysNeedUpdate(mesh, rows.selectedAt(row));
  }

  private disposeBuildingMesh(mesh: EntityMesh): void {
    this.world.remove(mesh.group);
    disposeEntityGroupFade(mesh.group);
    this.disposeWorldParentedOverlays(mesh);
  }

  private currentSpawnFadeIn(id: EntityId): number {
    if (VISION_FADE_IN_MS <= 0) return 1;
    const elapsed = this.spawnFadeElapsed.get(id);
    if (elapsed === undefined) return 1;
    return Math.min(elapsed, VISION_FADE_IN_MS) / VISION_FADE_IN_MS;
  }

  private applyBuildingEntityFade(mesh: EntityMesh, fade: number): void {
    if (fade < 1 || mesh.buildingGroupFadeActive === true) {
      applyEntityGroupFade(mesh.group, fade);
      mesh.buildingGroupFadeActive = fade < 1;
    }
  }

  private updateBuildingSpawnFades(dtMs: number): void {
    if (this.spawnFadeElapsed.size === 0) return;
    if (VISION_FADE_IN_MS <= 0) {
      for (const id of this.spawnFadeElapsed.keys()) {
        const mesh = this.meshes.get(id);
        if (mesh === undefined) continue;
        this.spawnFadeElapsed.set(id, VISION_FADE_IN_MS);
        this.applyBuildingEntityFade(mesh, mesh.buildingMaterializationOpacity ?? 1);
      }
      return;
    }

    for (const [id, prev] of this.spawnFadeElapsed) {
      if (prev === VISION_FADE_IN_MS) continue;
      const mesh = this.meshes.get(id);
      if (mesh === undefined) continue;
      const elapsed = Math.min(prev + dtMs, VISION_FADE_IN_MS);
      this.spawnFadeElapsed.set(id, elapsed);
      const fadeIn = elapsed / VISION_FADE_IN_MS;
      this.applyBuildingEntityFade(mesh, (mesh.buildingMaterializationOpacity ?? 1) * fadeIn);
    }
  }

  private removeBuildingMeshesFromPacket(
    rows: BuildingRenderPacket3D,
    beamAimCache: TurretBeamAimCache3D,
  ): void {
    for (let i = 0; i < rows.removedCount; i++) {
      this.removeBuildingMeshForViewRemoval(rows.removedEntityIdAt(i), beamAimCache);
    }
  }

  private removeBuildingMeshForViewRemoval(
    id: EntityId,
    beamAimCache: TurretBeamAimCache3D,
  ): void {
    const wasScopedHidden = this.scopedMeshRetention.forgetBuilding(id);
    this.unregisterBuildingSpinTurrets(id);
    beamAimCache.delete(id);
    this.spawnFadeElapsed.delete(id);

    const mesh = this.meshes.get(id);
    if (!mesh) return;

    this.disposeWorldParentedOverlays(mesh);
    if (mesh.ring) setObjectVisibleIfChanged(mesh.ring, false);
    this.animations.unregister(id);
    this.meshes.delete(id);
    if (wasScopedHidden) {
      this.disposeBuildingMesh(mesh);
      return;
    }
    if (mesh.killed) this.dyingBuildings.markDying(id, mesh);
    else this.vanishingBuildings.markDying(id, mesh);
  }

  private pruneUnseenBuildingMeshes(
    pruneToken: number,
    scopedRender: boolean,
    beamAimCache: TurretBeamAimCache3D,
  ): void {
    for (const [id, mesh] of this.meshes) {
      if (mesh.renderSeenToken === pruneToken) continue;
      if (scopedRender) {
        this.deactivateBuildingMeshForScope(id, mesh, beamAimCache);
      } else {
        this.removeBuildingMeshForViewRemoval(id, beamAimCache);
      }
    }
  }

  private deactivateBuildingMeshForScope(
    id: EntityId,
    mesh: EntityMesh,
    beamAimCache: TurretBeamAimCache3D,
  ): void {
    if (!this.scopedMeshRetention.markBuildingHidden(id)) return;
    this.animations.unregister(id);
    this.unregisterBuildingSpinTurrets(id);
    beamAimCache.delete(id);
    this.disposeWorldParentedOverlays(mesh);
    this.applyBuildingEntityFade(mesh, 0);
    setObjectVisibleIfChanged(mesh.group, false);
  }

  private deactivateBuildingMeshForLod(
    id: EntityId,
    mesh: EntityMesh,
    beamAimCache: TurretBeamAimCache3D,
  ): void {
    if (mesh.renderLodProxyActive === true) return;
    mesh.renderLodProxyActive = true;
    this.animations.unregister(id);
    this.unregisterBuildingSpinTurrets(id);
    beamAimCache.delete(id);
    this.disposeWorldParentedOverlays(mesh);
    this.applyBuildingEntityFade(mesh, 0);
    setObjectVisibleIfChanged(mesh.group, false);
  }

  private reactivateBuildingMeshForScope(entity: Entity, mesh: EntityMesh): void {
    if (!this.scopedMeshRetention.markBuildingActive(entity.id)) return;
    setObjectVisibleIfChanged(mesh.group, true);
    this.animations.register(entity, mesh);
    this.registerBuildingSpinTurrets(entity, mesh);
    this.applyBuildingEntityFade(
      mesh,
      (mesh.buildingMaterializationOpacity ?? 1) * this.currentSpawnFadeIn(entity.id),
    );
  }

  private reactivateBuildingMeshForLod(entity: Entity, mesh: EntityMesh): void {
    if (mesh.renderLodProxyActive !== true) return;
    mesh.renderLodProxyActive = false;
    setObjectVisibleIfChanged(mesh.group, true);
    this.animations.register(entity, mesh);
    this.registerBuildingSpinTurrets(entity, mesh);
    this.applyBuildingEntityFade(
      mesh,
      (mesh.buildingMaterializationOpacity ?? 1) * this.currentSpawnFadeIn(entity.id),
    );
  }

  destroy(): void {
    for (const mesh of this.meshes.values()) {
      this.disposeBuildingMesh(mesh);
    }
    this.meshes.clear();
    this.dyingBuildings.destroyAll();
    this.vanishingBuildings.destroyAll();
    this.spawnFadeElapsed.clear();
    this.renderScopeToken = 0;
    this.lastEntitySetVersion = -1;
    this.animations.destroy();
    this.barrelSpin.clear();
    this.buildingSpinEntries.length = 0;
    this.buildingSpinEntriesByEntity.clear();
    this.buildingSpinDeadEntries = 0;
    this.buildingSpinResetPending = false;
  }

  private updateBuilding(
    entity: Entity,
    rows: BuildingRenderPacket3D,
    row: number,
    frameState: RenderFrameState3D,
    rangeOverlayStateVersion: number,
    unitOverlayStateVersion: number,
    updateStaticOverlays: boolean,
  ): void {
    // If this id is mid death-fade and reappeared (id reuse / re-add),
    // finalize the dying mesh so we don't draw it under the rebuilt one.
    if (this.dyingBuildings.size > 0 && this.dyingBuildings.has(entity.id)) {
      this.dyingBuildings.finalize(entity.id);
    }
    if (this.vanishingBuildings.size > 0 && this.vanishingBuildings.has(entity.id)) {
      this.vanishingBuildings.finalize(entity.id);
    }
    const ownerId = rows.ownerIdAt(row);
    const width = rows.width[row];
    const depth = rows.footprintDepth[row];
    const blueprintId = rows.buildingBlueprintIds[row] ?? null;
    const turretCount = rows.turretCount[row];

    let mesh = this.meshes.get(entity.id);
    if (
      mesh &&
      (
        mesh.buildingRenderFrameKey !== frameState.key ||
        mesh.buildingRenderBlueprintId !== blueprintId ||
        mesh.buildingRenderTurretCount !== turretCount
      )
    ) {
      this.animations.unregister(entity.id);
      this.meshes.delete(entity.id);
      this.beamAimCache?.delete(entity.id);
      this.unregisterBuildingSpinTurrets(entity.id);
      this.scopedMeshRetention.forgetBuilding(entity.id);
      this.disposeBuildingMesh(mesh);
      mesh = undefined;
    }
    if (!mesh) {
      mesh = createBuildingEntityMesh3D({
        entity,
        width,
        depth,
        ownerId,
        geometryKey: frameState.key,
        world: this.world,
        turretHeadGeom: this.turretHeadGeom,
        barrelGeom: this.barrelGeom,
        coneBarrelGeom: this.coneBarrelGeom,
        getPrimaryMat: this.getPrimaryMat,
        getTurretAccentMat: this.getTurretAccentMat,
      });
      this.meshes.set(entity.id, mesh);
      this.animations.register(entity, mesh);
      this.registerBuildingSpinTurrets(entity, mesh);
      if (!this.spawnFadeElapsed.has(entity.id)) {
        this.spawnFadeElapsed.set(entity.id, 0);
      }
    }

    const progress = rows.progress[row];
    const selected = rows.selectedAt(row);
    const x = rows.x[row];
    const y = rows.y[row];
    const z = rows.z[row];
    const rotation = rows.rotation[row];
    const buildingBaseY = rows.baseY[row];
    const detailsReady = progress >= 1;
    const renderDirty =
      mesh.buildingCachedOwnerId !== ownerId ||
      mesh.buildingCachedProgress !== progress ||
      mesh.buildingCachedSelected !== selected ||
      mesh.buildingCachedWidth !== width ||
      mesh.buildingCachedDepth !== depth ||
      mesh.buildingCachedX !== x ||
      mesh.buildingCachedY !== y ||
      mesh.buildingCachedZ !== z ||
      mesh.buildingCachedRotation !== rotation;

    if (renderDirty) {
      this.updateBuildingMesh(
        mesh,
        ownerId,
        width,
        depth,
        progress,
        selected,
        x,
        y,
        z,
        rotation,
        buildingBaseY,
        detailsReady,
      );
    } else {
      setObjectVisibleIfChanged(mesh.group, true);
    }

    this.updateTurretPoses(entity, mesh, rows, row);
    if (updateStaticOverlays) {
      this.selectionOverlays.updateRangeRings(mesh, entity);
      this.selectionOverlays.updateBuildingRadiusRings(mesh, entity);
      mesh.buildingRangeOverlayVersion = rangeOverlayStateVersion;
      mesh.buildingUnitOverlayVersion = unitOverlayStateVersion;
    }

    // Materialization fade — mounted turrets share the host body's build
    // fraction because they are not separate construction pieces.
    // Finished buildings sit at opacity 1, where applyEntityGroupFade
    // restores the real materials and costs nothing.
    const bodyOpacity = rows.bodyOpacity[row];
    mesh.buildingMaterializationOpacity = bodyOpacity;
    this.applyBuildingEntityFade(mesh, bodyOpacity * this.currentSpawnFadeIn(entity.id));
    this.animations.sync(entity, mesh);
  }

  private updateBuildingMesh(
    mesh: EntityMesh,
    ownerId: PlayerId | undefined,
    width: number,
    depth: number,
    progress: number,
    selected: boolean,
    x: number,
    y: number,
    z: number,
    rotation: number,
    buildingBaseY: number,
    detailsReady: boolean,
  ): void {
    setObjectVisibleIfChanged(mesh.group, true);
    if (!mesh.buildingPrimaryMaterialLocked) {
      const primaryMat = this.getPrimaryMat(ownerId);
      for (const chassisMesh of mesh.chassisMeshes) chassisMesh.material = primaryMat;
    }
    if (mesh.buildingDetails) {
      const primaryMat = this.getPrimaryMat(ownerId);
      for (const detail of mesh.buildingDetails) {
        if (detail.role === 'solarTeamAccent') detail.mesh.material = primaryMat;
      }
    }
    const extractorAccents = mesh.extractorRig?.teamAccents;
    if (extractorAccents && extractorAccents.length > 0) {
      const primaryMat = this.getPrimaryMat(ownerId);
      for (const accent of extractorAccents) accent.material = primaryMat;
    }

    // Transform.z is the building's vertical center in sim space.
    // Render from the footprint base so buildings sit on the same
    // terrain height the server used when creating their collider.
    const height = mesh.buildingHeight ?? BUILDING_HEIGHT;
    this.enqueueBuildingPose(
      mesh,
      x,
      y,
      buildingBaseY,
      rotation,
      width,
      height,
      depth,
      mesh.buildingBodyless === true,
    );
    // Construction appearance is now the shared materialization fade
    // (applied per frame in updateBuilding), not a pale shell-material
    // swap — buildings alpha-fade in the same way as units.

    // Full size from frame one — construction is revealed by the shared
    // opacity fade (same as units), never by rising out of the ground.
    const primary = mesh.chassisMeshes[0];
    if (mesh.buildingBodyless) {
      // Bodyless render profiles have no chassis to show. Keep the
      // primary hidden and unscaled.
      setObjectVisibleIfChanged(primary, false);
    } else {
      setObjectVisibleIfChanged(primary, true);
    }

    if (mesh.buildingDetails) {
      // Details fade in with the body via applyEntityGroupFade — build-in
      // is opacity only, so every part materializes together at constant
      // size instead of popping in at completion. detailsReady still gates
      // their animation (see BuildingAnimationController3D), not existence.
      for (const detail of mesh.buildingDetails) {
        setObjectVisibleIfChanged(detail.mesh, true);
      }
    }

    this.selectionOverlays.updateSelectionRing(mesh, selected, Math.hypot(width, depth) * 0.55);

    mesh.buildingCachedOwnerId = ownerId;
    mesh.buildingCachedProgress = progress;
    mesh.buildingCachedSelected = selected;
    mesh.buildingCachedWidth = width;
    mesh.buildingCachedDepth = depth;
    mesh.buildingCachedX = x;
    mesh.buildingCachedY = y;
    mesh.buildingCachedZ = z;
    mesh.buildingCachedRotation = rotation;
    mesh.buildingCachedDetailsReady = detailsReady;
  }

  private updateTurretPoses(
    entity: Entity,
    mesh: EntityMesh,
    rows: BuildingRenderPacket3D,
    row: number,
  ): void {
    const combatTurrets = rows.turretsAt(row);
    if (!combatTurrets || mesh.turrets.length !== combatTurrets.length) return;
    const underConstruction = rows.shellAt(row);
    const bodyVisible = rows.bodyOpacity[row] > 0;
    const ownerId = rows.ownerIdAt(row);
    for (let turretIndex = 0; turretIndex < combatTurrets.length; turretIndex++) {
      const turret = combatTurrets[turretIndex];
      const turretMesh = mesh.turrets[turretIndex];
      const visible = bodyVisible;
      this.setTurretRootVisible(turretMesh, visible);
      if (!visible) continue;
      // Construction emitters have no head sphere, no barrels, and
      // don't pitch barrels. The root still consumes the authoritative
      // turret yaw/velocity stream so the whole fabricator construction
      // deck can rotate smoothly on the client.
      if (turret.config.constructionEmitter) {
        this.enqueueTurretAim(
          turretMesh,
          entity.transform.rotation,
          TURRET_AIM_MODE_POSE,
          turret.rotation,
          0,
          0,
          0,
          0,
        );
        continue;
      }
      const followsBeam = turretMesh.barrelFollowsBeam === true;
      // Head-only turrets that don't follow a beam draw a bare head: flip
      // its colour on engage and skip barrel posing entirely. While the
      // shell override owns the head material during construction, leave
      // it alone; after construction, the engaged state flips the head
      // from player primary to the half-white lock-on cue.
      if (turret.config.headOnly && !followsBeam) {
        if (turretMesh.head && !underConstruction) {
          this.setTurretHeadMaterial(
            turretMesh,
            turret.state === 'engaged'
              ? this.getTurretAccentMat(ownerId)
              : this.getPrimaryMat(ownerId),
          );
        }
        continue;
      }
      // Beam turrets colour like any other turret: a plain team-color head
      // (no engage flip) while the head tracks the beam direction below.
      if (followsBeam && turretMesh.head && !underConstruction) {
        this.setTurretHeadMaterial(turretMesh, this.getPrimaryMat(ownerId));
      }
      if (!underConstruction && !followsBeam) {
        this.setTurretBarrelMaterial(turretMesh, this.getTurretAccentMat(ownerId));
      }
      if (followsBeam) {
        // Aim the head along the last beam fired (frozen there when idle);
        // fall back to the forward idle pose until it first fires.
        const beamDir = this.beamAimCache?.get(entity.id, turretIndex) ?? null;
        if (beamDir) {
          this.enqueueTurretAim(
            turretMesh,
            entity.transform.rotation,
            TURRET_AIM_MODE_WORLD_DIR,
            0,
            0,
            beamDir.x,
            beamDir.y,
            beamDir.z,
          );
        } else {
          this.enqueueTurretAim(
            turretMesh,
            entity.transform.rotation,
            TURRET_AIM_MODE_POSE,
            turret.rotation,
            turret.pitch,
            0,
            0,
            0,
          );
        }
      } else {
        this.enqueueTurretAim(
          turretMesh,
          entity.transform.rotation,
          TURRET_AIM_MODE_POSE,
          turret.rotation,
          turret.pitch,
          0,
          0,
          0,
        );
      }
      // Gatling spin for multi-barrel tower turrets (e.g. the Anti-Air
      // rocket cluster). Single-barrel turrets have no spin state, so
      // angleFor returns undefined and the cluster stays still.
      if (turretMesh.spinGroup) {
        this.setTurretSpinRotation(
          turretMesh,
          this.barrelSpinEnabled
            ? this.barrelSpin.angleFor(entity.id, turretIndex) ?? 0
            : 0,
        );
      }
    }
  }

  private registerBuildingSpinTurrets(entity: Entity, mesh: EntityMesh): void {
    this.unregisterBuildingSpinTurrets(entity.id);
    const turrets = entity.combat?.turrets;
    if (!turrets || turrets.length === 0) return;
    const entries: BuildingTurretSpinEntry[] = [];
    for (
      let turretIndex = 0;
      turretIndex < turrets.length && turretIndex < mesh.turrets.length;
      turretIndex++
    ) {
      const turretMesh = mesh.turrets[turretIndex];
      if (!turretMesh.spinGroup) continue;
      const barrel = turrets[turretIndex].config.barrel;
      if (
        barrel === undefined ||
        (barrel.type !== 'simpleMultiBarrel' && barrel.type !== 'coneMultiBarrel')
      ) {
        continue;
      }
      const entry: BuildingTurretSpinEntry = {
        turretIndex,
        turretMesh,
        active: true,
      };
      entries.push(entry);
      this.buildingSpinEntries.push(entry);
    }
    if (entries.length > 0) this.buildingSpinEntriesByEntity.set(entity.id, entries);
  }

  private unregisterBuildingSpinTurrets(entityId: EntityId): void {
    const entries = this.buildingSpinEntriesByEntity.get(entityId);
    if (entries !== undefined) {
      for (const entry of entries) {
        if (!entry.active) continue;
        entry.active = false;
        this.buildingSpinDeadEntries++;
      }
      this.buildingSpinEntriesByEntity.delete(entityId);
    }
    this.barrelSpin.delete(entityId);
  }

  private updateBuildingTurretSpinQueue(spinDt: number): void {
    if (this.buildingSpinEntries.length === 0) return;

    if (!this.barrelSpinEnabled) {
      if (!this.buildingSpinResetPending) {
        this.compactBuildingSpinEntriesIfNeeded();
        return;
      }
      for (const entry of this.buildingSpinEntries) {
        if (entry.active) this.setTurretSpinRotation(entry.turretMesh, 0);
      }
      this.buildingSpinResetPending = false;
      this.compactBuildingSpinEntriesIfNeeded();
      return;
    }

    for (const [entityId, entries] of this.buildingSpinEntriesByEntity) {
      const entity = this.clientViewState.getEntity(entityId);
      if (entity === undefined || entity.combat === null) {
        this.unregisterBuildingSpinTurrets(entityId);
        continue;
      }
      this.barrelSpin.advance(entity, spinDt);
      for (const entry of entries) {
        if (!entry.active) continue;
        this.setTurretSpinRotation(
          entry.turretMesh,
          this.barrelSpin.angleFor(entityId, entry.turretIndex) ?? 0,
        );
      }
    }
    this.compactBuildingSpinEntriesIfNeeded();
  }

  private compactBuildingSpinEntriesIfNeeded(): void {
    if (
      this.buildingSpinDeadEntries <= 0 ||
      this.buildingSpinDeadEntries * 2 < this.buildingSpinEntries.length
    ) {
      return;
    }
    let write = 0;
    for (let read = 0; read < this.buildingSpinEntries.length; read++) {
      const entry = this.buildingSpinEntries[read];
      if (!entry.active) continue;
      this.buildingSpinEntries[write] = entry;
      write++;
    }
    this.buildingSpinEntries.length = write;
    this.buildingSpinDeadEntries = 0;
  }

  private setTurretRootVisible(turretMesh: TurretMesh, visible: boolean): void {
    if (turretMesh.cachedRootVisible === visible) return;
    setObjectVisibleIfChanged(turretMesh.root, visible);
    turretMesh.cachedRootVisible = visible;
  }

  private setTurretHeadMaterial(turretMesh: TurretMesh, material: THREE.Material): void {
    if (!turretMesh.head || turretMesh.cachedHeadMaterial === material) return;
    turretMesh.head.material = material;
    turretMesh.cachedHeadMaterial = material;
  }

  private setTurretBarrelMaterial(turretMesh: TurretMesh, material: THREE.Material): void {
    if (turretMesh.cachedBarrelMaterial === material) return;
    for (const barrel of turretMesh.barrels) barrel.material = material;
    turretMesh.cachedBarrelMaterial = material;
  }

  private setTurretSpinRotation(turretMesh: TurretMesh, rotationX: number): void {
    if (!turretMesh.spinGroup || turretMesh.cachedSpinRotationX === rotationX) return;
    turretMesh.spinGroup.rotation.x = rotationX;
    turretMesh.cachedSpinRotationX = rotationX;
  }

  private beginTurretAimFrame(): void {
    this.turretAimCount = 0;
    this.turretAimMeshes.length = 0;
  }

  private beginBuildingPoseFrame(): void {
    this.buildingPoseCount = 0;
    this.buildingPoseMeshes.length = 0;
    this.buildingPoseRotations.length = 0;
  }

  private flushBuildingPoseRecords(): void {
    const count = this.buildingPoseCount;
    if (count <= 0) return;

    const input = this.buildingPoseBatch.begin(count);
    input.set(this.buildingPoseInput.subarray(0, count * BUILDING_POSE_INPUT_STRIDE));
    const output = this.buildingPoseBatch.compute(count);
    const outputStride = this.buildingPoseBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const mesh = this.buildingPoseMeshes[i];
      const outputBase = i * outputStride;
      mesh.group.matrix.fromArray(output, outputBase);
      mesh.group.position.set(
        output[outputBase + 12],
        output[outputBase + 13],
        output[outputBase + 14],
      );
      mesh.group.rotation.y = this.buildingPoseRotations[i];
      mesh.group.matrixWorldNeedsUpdate = true;

      const primary = mesh.chassisMeshes[0];
      primary.matrix.fromArray(output, outputBase + 16);
      primary.matrixWorldNeedsUpdate = true;
    }
  }

  private flushTurretAimRecords(): void {
    const count = this.turretAimCount;
    if (count <= 0) return;

    const input = this.turretAimBatch.begin(count);
    input.set(this.turretAimInput.subarray(0, count * TURRET_AIM_INPUT_STRIDE));
    const output = this.turretAimBatch.compute(count);
    const outputStride = this.turretAimBatch.outputStride;

    for (let i = 0; i < count; i++) {
      const turretMesh = this.turretAimMeshes[i];
      const outputBase = i * outputStride;
      setEulerYIfChanged(turretMesh.root.rotation, output[outputBase]);
      if (turretMesh.pitchGroup) {
        setEulerZIfChanged(turretMesh.pitchGroup.rotation, output[outputBase + 1]);
      }
    }
  }

  private enqueueTurretAim(
    turretMesh: TurretMesh,
    hostRotation: number,
    mode: number,
    aimRotation: number,
    aimPitch: number,
    dirX: number,
    dirY: number,
    dirZ: number,
  ): void {
    const index = this.turretAimCount;
    this.turretAimCount++;
    this.ensureTurretAimInputCapacity(this.turretAimCount);

    const base = index * TURRET_AIM_INPUT_STRIDE;
    const input = this.turretAimInput;
    input[base] = hostRotation;
    input[base + 1] = mode;
    input[base + 2] = aimRotation;
    input[base + 3] = aimPitch;
    input[base + 4] = dirX;
    input[base + 5] = dirY;
    input[base + 6] = dirZ;
    input[base + 7] = 0;
    input[base + 8] = 0;
    input[base + 9] = 0;
    input[base + 10] = 1;
    input[base + 11] = 0;
    this.turretAimMeshes[index] = turretMesh;
  }

  private enqueueBuildingPose(
    mesh: EntityMesh,
    x: number,
    y: number,
    baseY: number,
    rotation: number,
    width: number,
    height: number,
    depth: number,
    bodyless: boolean,
  ): void {
    const index = this.buildingPoseCount;
    this.buildingPoseCount++;
    this.ensureBuildingPoseInputCapacity(this.buildingPoseCount);

    const base = index * BUILDING_POSE_INPUT_STRIDE;
    const input = this.buildingPoseInput;
    input[base] = x;
    input[base + 1] = y;
    input[base + 2] = baseY;
    input[base + 3] = rotation;
    input[base + 4] = width;
    input[base + 5] = height;
    input[base + 6] = depth;
    input[base + 7] = bodyless ? 1 : 0;
    this.buildingPoseMeshes[index] = mesh;
    this.buildingPoseRotations[index] = -rotation;
  }

  private ensureTurretAimInputCapacity(count: number): void {
    const needed = count * TURRET_AIM_INPUT_STRIDE;
    if (this.turretAimInput.length >= needed) return;
    let next = this.turretAimInput.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.turretAimInput);
    this.turretAimInput = expanded;
  }

  private ensureBuildingPoseInputCapacity(count: number): void {
    const needed = count * BUILDING_POSE_INPUT_STRIDE;
    if (this.buildingPoseInput.length >= needed) return;
    let next = this.buildingPoseInput.length;
    while (next < needed) next *= 2;
    const expanded = new Float32Array(next);
    expanded.set(this.buildingPoseInput);
    this.buildingPoseInput = expanded;
  }
}
