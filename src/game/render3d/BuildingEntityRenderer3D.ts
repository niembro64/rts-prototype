import * as THREE from 'three';
import type { Entity, EntityId, PlayerId } from '../sim/types';
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
import {
  buildBuildingShape,
  type BuildingShapeType,
} from './BuildingShape3D';
import type { EntityMesh } from './EntityMesh3D';
import type { RenderFrameState3D } from './RenderFrameState3D';
import { BuildingAnimationController3D } from './BuildingAnimationController3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
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

const BUILDING_HEIGHT = 120;

function entityHasPerFrameBuildingTurretWork(entity: Entity): boolean {
  const turrets = entity.combat?.turrets;
  if (!turrets || turrets.length === 0) return false;
  for (let i = 0; i < turrets.length; i++) {
    const turret = turrets[i];
    if (turret.config.constructionEmitter) return true;
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

  const shape = buildBuildingShape(shapeType, width, depth, getPrimaryMat(ownerId));
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
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  coneBarrelGeom: THREE.CylinderGeometry;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  getTurretAccentMat: (playerId: PlayerId | undefined) => THREE.Material;
  disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
  metalDeposits: readonly MetalDeposit[];
};

export class BuildingEntityRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly selectionOverlays: SelectionOverlayRenderer3D;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly turretHeadGeom: THREE.SphereGeometry;
  private readonly barrelGeom: THREE.CylinderGeometry;
  private readonly coneBarrelGeom: THREE.CylinderGeometry;
  private readonly getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly getTurretAccentMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
  private readonly animations: BuildingAnimationController3D;
  private readonly meshes = new Map<EntityId, EntityMesh>();
  private readonly seenIds = new Set<EntityId>();
  private lastEntitySetVersion = -1;
  // Shared death-out flow (same controller units use, see EntityFade3D): a
  // dead building/tower is kept and its whole group dissolved 1 → 0 before
  // teardown, while the blast + debris play out. Assigned in the constructor.
  private readonly dyingBuildings: DyingMeshFade<EntityMesh>;
  /** Gatling spin for tower-mounted multi-barrel turrets (e.g. the
   *  Anti-Air rocket gatling). Towers render per-Mesh, so they keep
   *  their own spin state separate from the unit renderer's. */
  private readonly barrelSpin = new UnitBarrelSpinState3D();
  /** Set each frame from update(): last beam direction per turret, read
   *  to aim beam-directed barrels on beam towers (turretBeamLong). */
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

  constructor(options: BuildingEntityRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.selectionOverlays = options.selectionOverlays;
    this.constructionVisuals = options.constructionVisuals;
    this.turretHeadGeom = options.turretHeadGeom;
    this.barrelGeom = options.barrelGeom;
    this.coneBarrelGeom = options.coneBarrelGeom;
    this.getPrimaryMat = options.getPrimaryMat;
    this.getTurretAccentMat = options.getTurretAccentMat;
    this.disposeWorldParentedOverlays = options.disposeWorldParentedOverlays;
    this.animations = new BuildingAnimationController3D(
      this.clientViewState,
      this.constructionVisuals,
      options.metalDeposits,
    );
    this.dyingBuildings = new DyingMeshFade<EntityMesh>(
      ENTITY_DEATH_FADE_MS,
      (mesh, fade) => applyEntityGroupFade(mesh.group, fade),
      (_id, mesh) => this.disposeBuildingMesh(mesh),
    );
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
    const pruneBuildings = scopedRender || entitySetVersion !== this.lastEntitySetVersion;
    if (pruneBuildings) this.seenIds.clear();
    this.constructionVisuals.beginFrame();
    this.beamAimCache = beamAimCache;
    this.barrelSpinEnabled = getGraphicsConfig().barrelSpin;
    this.beginTurretAimFrame();
    this.beginBuildingPoseFrame();
    const rows = buildingRows ?? this.populateFallbackBuildingRenderRows();

    for (let row = 0; row < rows.count; row++) {
      const entityId = rows.entityIdAt(row);
      const entity = rows.entityAt(row);
      if (entity === undefined || entity.building === null) continue;
      if (pruneBuildings) this.seenIds.add(entityId);

      const mesh = this.meshes.get(entityId);
      const rowDirty = rows.renderDirtyAt(row) || rows.lifecycleDirtyAt(row);
      const activePrediction = rows.activePredictionAt(row);
      const needsTurretFrame =
        activePrediction || entityHasPerFrameBuildingTurretWork(entity);
      const bodyFadeActive =
        rows.bodyOpacity[row] < 1 || mesh?.buildingGroupFadeActive === true;
      const overlayDirty = mesh !== undefined && this.staticBuildingOverlaysNeedUpdate(
        mesh,
        entity,
        rows,
        row,
      );
      if (
        mesh !== undefined &&
        !rowDirty &&
        !needsTurretFrame &&
        !bodyFadeActive &&
        !overlayDirty
      ) {
        mesh.group.visible = true;
        continue;
      }

      if (needsTurretFrame) this.barrelSpin.advance(entity, spinDt);
      this.updateBuilding(entity, rows, row, frameState);
    }

    this.flushBuildingPoseRecords();
    this.flushTurretAimRecords();
    this.animations.update(this.meshes, spinDt, currentDtMs, timeMs);
    // Advance any in-progress death-out fades every frame (independent of
    // the entity-set prune cadence below).
    this.dyingBuildings.update(currentDtMs);

    if (!pruneBuildings) return;
    for (const [id, mesh] of this.meshes) {
      if (this.seenIds.has(id)) continue;
      const liveEntity = this.clientViewState.getEntity(id);
      if (scopedRender && liveEntity !== undefined && liveEntity.building !== null) {
        this.animations.unregister(id);
        this.meshes.delete(id);
        beamAimCache.delete(id);
        this.disposeBuildingMesh(mesh);
        continue;
      }
      // Died: hand the mesh to the shared death-out fade rather than
      // tearing it down now — it dissolves in place while the blast +
      // debris play out, then frees. Overlays / selection ring / animation
      // stop immediately.
      this.disposeWorldParentedOverlays(mesh);
      if (mesh.ring) mesh.ring.visible = false;
      this.animations.unregister(id);
      this.meshes.delete(id);
      // Shared beam-aim cache spans units + towers, so drop this tower's
      // entries precisely rather than via a seen-set sweep.
      beamAimCache.delete(id);
      this.dyingBuildings.markDying(id, mesh);
    }
    this.barrelSpin.prune(this.seenIds);
    this.lastEntitySetVersion = entitySetVersion;
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
    );
  }

  private disposeBuildingMesh(mesh: EntityMesh): void {
    this.world.remove(mesh.group);
    disposeEntityGroupFade(mesh.group);
    this.disposeWorldParentedOverlays(mesh);
  }

  destroy(): void {
    for (const mesh of this.meshes.values()) {
      this.disposeBuildingMesh(mesh);
    }
    this.meshes.clear();
    this.dyingBuildings.destroyAll();
    this.seenIds.clear();
    this.lastEntitySetVersion = -1;
    this.animations.destroy();
    this.barrelSpin.clear();
  }

  private updateBuilding(
    entity: Entity,
    rows: BuildingRenderPacket3D,
    row: number,
    frameState: RenderFrameState3D,
  ): void {
    // If this id is mid death-fade and reappeared (id reuse / re-add),
    // finalize the dying mesh so we don't draw it under the rebuilt one.
    if (this.dyingBuildings.size > 0 && this.dyingBuildings.has(entity.id)) {
      this.dyingBuildings.finalize(entity.id);
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
      mesh.group.visible = true;
    }

    this.updateTurretPoses(entity, mesh, rows, row);
    this.selectionOverlays.updateRangeRings(mesh, entity);

    // Materialization fade — mounted turrets share the host body's build
    // fraction because they are not separate construction pieces.
    // Finished buildings sit at opacity 1, where applyEntityGroupFade
    // restores the real materials and costs nothing.
    const bodyOpacity = rows.bodyOpacity[row];
    if (bodyOpacity < 1 || mesh.buildingGroupFadeActive === true) {
      applyEntityGroupFade(mesh.group, bodyOpacity);
      mesh.buildingGroupFadeActive = bodyOpacity < 1;
    }
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
    mesh.group.visible = true;
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
      primary.visible = false;
    } else {
      primary.visible = true;
    }

    if (mesh.buildingDetails) {
      // Details fade in with the body via applyEntityGroupFade — build-in
      // is opacity only, so every part materializes together at constant
      // size instead of popping in at completion. detailsReady still gates
      // their animation (see BuildingAnimationController3D), not existence.
      for (const detail of mesh.buildingDetails) {
        detail.mesh.visible = true;
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
    const bodyMaterialized = rows.bodyMaterializedAt(row);
    const ownerId = rows.ownerIdAt(row);
    for (let turretIndex = 0; turretIndex < combatTurrets.length; turretIndex++) {
      const turret = combatTurrets[turretIndex];
      const turretMesh = mesh.turrets[turretIndex];
      const visible = bodyMaterialized;
      turretMesh.root.visible = visible;
      if (!visible) continue;
      const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.config);
      turretMesh.root.position.set(
        turret.mount.x,
        turret.mount.z - headRadius,
        turret.mount.y,
      );
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
          turretMesh.head.material = turret.state === 'engaged'
            ? this.getTurretAccentMat(ownerId)
            : this.getPrimaryMat(ownerId);
        }
        continue;
      }
      // Beam turrets colour like any other turret: a plain team-color head
      // (no engage flip) while their barrel tracks the beam below.
      if (followsBeam && turretMesh.head && !underConstruction) {
        turretMesh.head.material = this.getPrimaryMat(ownerId);
      }
      if (!underConstruction) {
        const turretAccentMat = this.getTurretAccentMat(ownerId);
        for (const barrel of turretMesh.barrels) barrel.material = turretAccentMat;
      }
      if (followsBeam) {
        // Aim the barrel along the last beam fired (frozen there when
        // idle); fall back to the forward idle pose until it first fires.
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
        turretMesh.spinGroup.rotation.x = this.barrelSpinEnabled
          ? this.barrelSpin.angleFor(entity.id, turretIndex) ?? 0
          : 0;
      }
    }
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
      turretMesh.root.rotation.y = output[outputBase];
      if (turretMesh.pitchGroup) turretMesh.pitchGroup.rotation.z = output[outputBase + 1];
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
