import * as THREE from 'three';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { MetalDeposit } from '../../metalDepositConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getGraphicsConfig } from '@/clientBarConfig';
import {
  getConstructionPieceOpacity,
  isConstructionPieceMaterialized,
  isShell,
} from '../sim/buildableHelpers';
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
import { applyTurretAimPose3D, applyTurretAimWorldDir3D } from './TurretAimPose3D';
import { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import type { TurretBeamAimCache3D } from './TurretBeamAimCache3D';
import { BuildingRenderPacket3D } from './EntityRenderPackets3D';

const BUILDING_HEIGHT = 120;

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
  group.userData.entityId = entity.id;

  const shape = buildBuildingShape(shapeType, width, depth, getPrimaryMat(ownerId));
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
    const rows = buildingRows ?? this.populateFallbackBuildingRenderRows();

    for (let row = 0; row < rows.count; row++) {
      const entityId = rows.entityIdAt(row);
      const entity = this.clientViewState.getEntity(entityId);
      if (entity === undefined || entity.building === null) continue;
      if (pruneBuildings) this.seenIds.add(entityId);
      this.barrelSpin.advance(entity, spinDt);
      this.updateBuilding(entity, rows, row, frameState);
    }

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
    for (let i = 0; i < buildings.length; i++) rows.pushEntity(buildings[i]);
    return rows;
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

    let mesh = this.meshes.get(entity.id);
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

    this.updateTurretPoses(entity, mesh);
    this.selectionOverlays.updateRangeRings(mesh, entity);

    // Materialization fade — mounted turrets share the host body's build
    // fraction because they are not separate construction pieces.
    // Finished buildings sit at opacity 1, where applyEntityGroupFade
    // restores the real materials and costs nothing.
    const bodyOpacity = getConstructionPieceOpacity(entity, 'body');
    applyEntityGroupFade(mesh.group, bodyOpacity);
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
    mesh.group.position.set(x, buildingBaseY, y);
    mesh.group.rotation.y = -rotation;
    // Construction appearance is now the shared materialization fade
    // (applied per frame in updateBuilding), not a pale shell-material
    // swap — buildings alpha-fade in the same way as units.

    // Full size from frame one — construction is revealed by the shared
    // opacity fade (same as units), never by rising out of the ground.
    const height = mesh.buildingHeight ?? BUILDING_HEIGHT;
    const primary = mesh.chassisMeshes[0];
    if (mesh.buildingBodyless) {
      // Bodyless render profiles have no chassis to show. Keep the
      // primary hidden and unscaled.
      primary.visible = false;
    } else {
      primary.position.set(0, height / 2, 0);
      primary.scale.set(width, height, depth);
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

  private updateTurretPoses(entity: Entity, mesh: EntityMesh): void {
    const combatTurrets = entity.combat?.turrets;
    if (!combatTurrets || mesh.turrets.length !== combatTurrets.length) return;
    const underConstruction = isShell(entity);
    for (let turretIndex = 0; turretIndex < combatTurrets.length; turretIndex++) {
      const turret = combatTurrets[turretIndex];
      const turretMesh = mesh.turrets[turretIndex];
      const visible = isConstructionPieceMaterialized(entity, 'body');
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
        applyTurretAimPose3D(
          turretMesh,
          entity.transform.rotation,
          turret.rotation,
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
            ? this.getTurretAccentMat(entity.ownership?.playerId)
            : this.getPrimaryMat(entity.ownership?.playerId);
        }
        continue;
      }
      // Beam turrets colour like any other turret: a plain team-color head
      // (no engage flip) while their barrel tracks the beam below.
      if (followsBeam && turretMesh.head && !underConstruction) {
        turretMesh.head.material = this.getPrimaryMat(entity.ownership?.playerId);
      }
      if (!underConstruction) {
        const turretAccentMat = this.getTurretAccentMat(entity.ownership?.playerId);
        for (const barrel of turretMesh.barrels) barrel.material = turretAccentMat;
      }
      if (followsBeam) {
        // Aim the barrel along the last beam fired (frozen there when
        // idle); fall back to the forward idle pose until it first fires.
        const beamDir = this.beamAimCache?.get(entity.id, turretIndex) ?? null;
        if (beamDir) {
          applyTurretAimWorldDir3D(
            turretMesh,
            entity.transform.rotation,
            beamDir.x,
            beamDir.y,
            beamDir.z,
          );
        } else {
          applyTurretAimPose3D(
            turretMesh,
            entity.transform.rotation,
            turret.rotation,
            turret.pitch,
          );
        }
      } else {
        applyTurretAimPose3D(
          turretMesh,
          entity.transform.rotation,
          turret.rotation,
          turret.pitch,
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
}
