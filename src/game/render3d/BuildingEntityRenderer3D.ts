import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getGraphicsConfigFor } from '@/clientBarConfig';
import { getBuildFraction } from '../sim/buildableHelpers';
import type { ClientViewState } from '../network/ClientViewState';
import { getTurretHeadRadius } from '../math';
import { applyShellOverride } from './ShellMaterial';
import {
  buildBuildingShape,
  type BuildingShapeType,
} from './BuildingShape3D';
import type { EntityMesh } from './EntityMesh3D';
import type { Lod3DState } from './Lod3D';
import {
  objectLodToGraphicsTier,
  type RenderObjectLodTier,
} from './RenderObjectLod';
import { buildingDetailVisible } from './RenderTier3D';
import { BuildingAnimationController3D } from './BuildingAnimationController3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import type { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import {
  buildTurretMesh3D,
  type TurretMesh,
} from './TurretMesh3D';
import { applyTurretAimPose3D } from './TurretAimPose3D';

const BUILDING_HEIGHT = 120;

export type BuildingEntityMeshFactoryOptions = {
  entity: Entity;
  width: number;
  depth: number;
  ownerId: PlayerId | undefined;
  globalGraphicsTier: ConcreteGraphicsQuality;
  lodKey: string;
  world: THREE.Group;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  barrelMat: THREE.Material;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
};

export function createBuildingEntityMesh3D(options: BuildingEntityMeshFactoryOptions): EntityMesh {
  const {
    entity,
    width,
    depth,
    ownerId,
    globalGraphicsTier,
    lodKey,
    world,
    turretHeadGeom,
    barrelGeom,
    barrelMat,
    getPrimaryMat,
  } = options;
  const shapeType: BuildingShapeType = entity.buildingType
    ? getBuildingConfig(entity.buildingType).renderProfile
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

  if (shape.factoryRig?.group) {
    shape.factoryRig.group.userData.entityId = entity.id;
    shape.factoryRig.group.traverse((obj) => {
      obj.userData.entityId = entity.id;
    });
    group.add(shape.factoryRig.group);
  }

  const buildingTurretMeshes: TurretMesh[] = [];
  const buildingTurrets = entity.combat?.turrets;
  if (buildingTurrets) {
    // Use the GLOBAL gfx tier, not the per-entity distance tier, when
    // building the turret. Distance-LOD can briefly drop a tower to
    // marker/min while the camera is framing in, and the building mesh
    // is cached forever after that.
    const buildingTurretTier =
      shapeType === 'megaBeamTower' && globalGraphicsTier === 'min'
        ? 'low'
        : globalGraphicsTier;
    const buildingGfx = getGraphicsConfigFor(buildingTurretTier);
    for (let ti = 0; ti < buildingTurrets.length; ti++) {
      const turret = buildingTurrets[ti];
      if (turret.config.constructionEmitter) {
        // Construction emitter renders via factoryRig. Push an empty
        // placeholder so building turret indices stay aligned with
        // combat.turrets indices.
        buildingTurretMeshes.push({ root: new THREE.Group(), barrels: [] });
        continue;
      }
      const turretMesh = buildTurretMesh3D(group, turret, buildingGfx, {
        headGeom: turretHeadGeom,
        barrelGeom,
        barrelMat,
        primaryMat: getPrimaryMat(ownerId),
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
    lodKey,
    buildingDetails: shape.details,
    factoryRig: shape.factoryRig,
    windRig: shape.windRig,
    extractorRig: shape.extractorRig,
    solarRig: shape.solarRig,
    buildingHeight: shape.height,
    buildingPrimaryMaterialLocked: shape.primaryMaterialLocked === true,
    solarOpenAmount: entity.building?.solar?.open === false ? 0 : 1,
  };
}

export type BuildingEntityRenderer3DOptions = {
  world: THREE.Group;
  clientViewState: ClientViewState;
  selectionOverlays: SelectionOverlayRenderer3D;
  constructionVisuals: ConstructionVisualController3D;
  markerBoxGeom: THREE.BoxGeometry;
  turretHeadGeom: THREE.SphereGeometry;
  barrelGeom: THREE.CylinderGeometry;
  barrelMat: THREE.Material;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  resolveObjectLod: (entity: Entity) => RenderObjectLodTier;
  disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
};

export class BuildingEntityRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly selectionOverlays: SelectionOverlayRenderer3D;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly markerBoxGeom: THREE.BoxGeometry;
  private readonly turretHeadGeom: THREE.SphereGeometry;
  private readonly barrelGeom: THREE.CylinderGeometry;
  private readonly barrelMat: THREE.Material;
  private readonly getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly resolveObjectLod: (entity: Entity) => RenderObjectLodTier;
  private readonly disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
  private readonly animations: BuildingAnimationController3D;
  private readonly meshes = new Map<EntityId, EntityMesh>();
  private readonly seenIds = new Set<EntityId>();
  private lastEntitySetVersion = -1;

  constructor(options: BuildingEntityRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.selectionOverlays = options.selectionOverlays;
    this.constructionVisuals = options.constructionVisuals;
    this.markerBoxGeom = options.markerBoxGeom;
    this.turretHeadGeom = options.turretHeadGeom;
    this.barrelGeom = options.barrelGeom;
    this.barrelMat = options.barrelMat;
    this.getPrimaryMat = options.getPrimaryMat;
    this.resolveObjectLod = options.resolveObjectLod;
    this.disposeWorldParentedOverlays = options.disposeWorldParentedOverlays;
    this.animations = new BuildingAnimationController3D(
      this.clientViewState,
      this.constructionVisuals,
    );
  }

  update(lod: Lod3DState, spinDt: number, currentDtMs: number, timeMs: number): void {
    const buildings = this.clientViewState.getBuildings();
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const pruneBuildings = entitySetVersion !== this.lastEntitySetVersion;
    if (pruneBuildings) this.seenIds.clear();
    this.constructionVisuals.beginFrame();

    for (const entity of buildings) {
      if (pruneBuildings) this.seenIds.add(entity.id);
      this.updateBuilding(entity, lod);
    }

    this.animations.update(this.meshes, spinDt, currentDtMs, timeMs);

    if (!pruneBuildings) return;
    for (const [id, mesh] of this.meshes) {
      if (this.seenIds.has(id)) continue;
      this.world.remove(mesh.group);
      this.disposeWorldParentedOverlays(mesh);
      this.meshes.delete(id);
      this.animations.unregister(id);
    }
    this.lastEntitySetVersion = entitySetVersion;
  }

  destroy(): void {
    for (const mesh of this.meshes.values()) {
      this.world.remove(mesh.group);
      this.disposeWorldParentedOverlays(mesh);
    }
    this.meshes.clear();
    this.seenIds.clear();
    this.lastEntitySetVersion = -1;
    this.animations.destroy();
  }

  private updateBuilding(entity: Entity, lod: Lod3DState): void {
    // Buildings are sparse and strategically important. Do not apply
    // the 2D render-scope early-out here: it can disagree with the
    // perspective/frustum view at steep camera angles and make a
    // building vanish even though its 3D LOD cell should render a
    // full shape or marker. Let Three frustum-cull the final meshes.
    const objectTier = this.resolveObjectLod(entity);
    const markerOnly = objectTier === 'marker';
    const graphicsTier = markerOnly ? 'min' : objectLodToGraphicsTier(objectTier, lod.gfx.tier);
    const ownerId = entity.ownership?.playerId;
    const width = entity.building?.width ?? 100;
    const depth = entity.building?.height ?? 100;

    let mesh = this.meshes.get(entity.id);
    if (!mesh) {
      mesh = createBuildingEntityMesh3D({
        entity,
        width,
        depth,
        ownerId,
        globalGraphicsTier: lod.gfx.tier,
        lodKey: lod.key,
        world: this.world,
        turretHeadGeom: this.turretHeadGeom,
        barrelGeom: this.barrelGeom,
        barrelMat: this.barrelMat,
        getPrimaryMat: this.getPrimaryMat,
      });
      this.meshes.set(entity.id, mesh);
      this.animations.register(entity, mesh);
    }

    const buildable = entity.buildable;
    const progress =
      buildable && !buildable.isComplete
        ? Math.max(0.05, Math.min(1, getBuildFraction(buildable)))
        : 1;
    const selected = entity.selectable?.selected === true;
    const buildingBaseY = entity.building ? entity.transform.z - entity.building.depth / 2 : 0;
    const detailsReady = !markerOnly && progress >= 1;
    const renderDirty =
      mesh.buildingCachedTier !== objectTier ||
      mesh.buildingCachedGraphicsTier !== graphicsTier ||
      mesh.buildingCachedOwnerId !== ownerId ||
      mesh.buildingCachedProgress !== progress ||
      mesh.buildingCachedSelected !== selected ||
      mesh.buildingCachedWidth !== width ||
      mesh.buildingCachedDepth !== depth ||
      mesh.buildingCachedX !== entity.transform.x ||
      mesh.buildingCachedY !== entity.transform.y ||
      mesh.buildingCachedZ !== entity.transform.z ||
      mesh.buildingCachedRotation !== entity.transform.rotation;

    if (renderDirty) {
      this.updateBuildingMesh(
        entity,
        mesh,
        objectTier,
        graphicsTier,
        ownerId,
        width,
        depth,
        progress,
        selected,
        buildingBaseY,
        detailsReady,
      );
    } else {
      mesh.group.visible = true;
    }

    this.updateTurretPoses(entity, mesh);
    this.selectionOverlays.updateRangeRings(mesh, entity);
  }

  private updateBuildingMesh(
    entity: Entity,
    mesh: EntityMesh,
    objectTier: RenderObjectLodTier,
    graphicsTier: ConcreteGraphicsQuality,
    ownerId: PlayerId | undefined,
    width: number,
    depth: number,
    progress: number,
    selected: boolean,
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
    mesh.group.position.set(entity.transform.x, buildingBaseY, entity.transform.y);
    mesh.group.rotation.y = -entity.transform.rotation;
    applyShellOverride(
      mesh.group,
      !!(entity.buildable && !entity.buildable.isComplete && !entity.buildable.isGhost),
    );

    const height = mesh.buildingHeight ?? BUILDING_HEIGHT;
    const renderHeight = height * progress;
    const primary = mesh.chassisMeshes[0];
    primary.position.set(0, renderHeight / 2, 0);
    primary.scale.set(width, renderHeight, depth);
    primary.visible = objectTier !== 'marker';

    if (!mesh.lodMarker) {
      const marker = new THREE.Mesh(this.markerBoxGeom, this.getPrimaryMat(ownerId));
      marker.userData.entityId = entity.id;
      mesh.group.add(marker);
      mesh.lodMarker = marker;
    } else {
      mesh.lodMarker.material = this.getPrimaryMat(ownerId);
    }
    const markerHeight = entity.building?.depth ?? (mesh.buildingHeight ?? BUILDING_HEIGHT);
    mesh.lodMarker.visible = objectTier === 'marker';
    mesh.lodMarker.position.set(0, markerHeight / 2, 0);
    mesh.lodMarker.scale.set(width, markerHeight, depth);

    if (mesh.buildingDetails) {
      for (const detail of mesh.buildingDetails) {
        detail.mesh.visible = detailsReady && buildingDetailVisible(detail, graphicsTier);
      }
    }

    this.selectionOverlays.updateSelectionRing(mesh, selected, Math.hypot(width, depth) * 0.55);

    mesh.buildingCachedTier = objectTier;
    mesh.buildingCachedGraphicsTier = graphicsTier;
    mesh.buildingCachedOwnerId = ownerId;
    mesh.buildingCachedProgress = progress;
    mesh.buildingCachedSelected = selected;
    mesh.buildingCachedWidth = width;
    mesh.buildingCachedDepth = depth;
    mesh.buildingCachedX = entity.transform.x;
    mesh.buildingCachedY = entity.transform.y;
    mesh.buildingCachedZ = entity.transform.z;
    mesh.buildingCachedRotation = entity.transform.rotation;
    mesh.buildingCachedDetailsReady = detailsReady;
  }

  private updateTurretPoses(entity: Entity, mesh: EntityMesh): void {
    const combatTurrets = entity.combat?.turrets;
    if (!combatTurrets || mesh.turrets.length !== combatTurrets.length) return;
    for (let turretIndex = 0; turretIndex < combatTurrets.length; turretIndex++) {
      const turret = combatTurrets[turretIndex];
      const turretMesh = mesh.turrets[turretIndex];
      if (turret.config.constructionEmitter) continue;
      const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.config);
      turretMesh.root.position.set(
        turret.mount.x,
        turret.mount.z - headRadius,
        turret.mount.y,
      );
      applyTurretAimPose3D(
        turretMesh,
        entity.transform.rotation,
        turret.rotation,
        turret.pitch,
      );
    }
  }
}
