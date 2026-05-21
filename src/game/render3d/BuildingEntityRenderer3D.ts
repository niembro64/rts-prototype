import * as THREE from 'three';
import type { ConcreteGraphicsQuality } from '@/types/graphics';
import { COLORS } from '@/colorsConfig';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getGraphicsConfig } from '@/clientBarConfig';
import { getBuildFraction } from '../sim/buildableHelpers';
import type { ClientViewState } from '../network/ClientViewState';
import { getTurretHeadRadius } from '../math';
import { applyShellOverride } from './ShellMaterial';
import {
  buildBuildingShape,
  type BuildingShapeType,
} from './BuildingShape3D';
import type { EntityMesh } from './EntityMesh3D';
import type { RenderFrameState3D } from './RenderFrameState3D';
import { buildingDetailVisible } from './RenderTier3D';
import { BuildingAnimationController3D } from './BuildingAnimationController3D';
import type { ConstructionVisualController3D } from './ConstructionVisualController3D';
import type { SelectionOverlayRenderer3D } from './SelectionOverlayRenderer3D';
import {
  buildTurretMesh3D,
  type TurretMesh,
} from './TurretMesh3D';
import { applyTurretAimPose3D } from './TurretAimPose3D';
import {
  canEntityProvideFullVision,
  getEntityFullVisionRadius,
  getEntityVisibilityPadding,
} from '../network/stateSerializerVisibility';

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
  barrelMat: THREE.Material;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
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
    const buildingGfx = getGraphicsConfig();
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
        coneBarrelGeom,
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
    geometryKey,
    buildingDetails: shape.details,
    factoryRig: shape.factoryRig,
    windRig: shape.windRig,
    extractorRig: shape.extractorRig,
    solarRig: shape.solarRig,
    buildingHeight: shape.height,
    buildingPrimaryMaterialLocked: shape.primaryMaterialLocked === true,
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
  barrelMat: THREE.Material;
  getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
  /** Current local player id, for ghost-building detection (FOW-02a).
   *  A foreign building stays on the client after exiting vision
   *  (FOW-02 server change); the renderer needs to know which seat
   *  is "us" to decide whether each building is in current vision or
   *  should render with the desaturated ghost material. */
  getLocalPlayerId: () => PlayerId | undefined;
};

type VisionSource = {
  x: number;
  y: number;
  radius: number;
};

export class BuildingEntityRenderer3D {
  private readonly world: THREE.Group;
  private readonly clientViewState: ClientViewState;
  private readonly selectionOverlays: SelectionOverlayRenderer3D;
  private readonly constructionVisuals: ConstructionVisualController3D;
  private readonly turretHeadGeom: THREE.SphereGeometry;
  private readonly barrelGeom: THREE.CylinderGeometry;
  private readonly coneBarrelGeom: THREE.CylinderGeometry;
  private readonly barrelMat: THREE.Material;
  private readonly getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
  private readonly getLocalPlayerId: () => PlayerId | undefined;
  private readonly animations: BuildingAnimationController3D;
  private readonly meshes = new Map<EntityId, EntityMesh>();
  private readonly seenIds = new Set<EntityId>();
  private lastEntitySetVersion = -1;
  /** Shared desaturated material applied to ghost buildings. Single
   *  instance (not per-player) — once a building is out of vision, the
   *  player's last-seen intel doesn't include current ownership shifts,
   *  and stripping team color is the standard "this is stale" cue. */
  private readonly ghostMat: THREE.MeshLambertMaterial;
  /** Per-frame scratch of local player's vision sources, used to mark
   *  ghost state on each building. Recomputed at the top of update()
   *  so it stays in sync with whichever seat the user is currently
   *  toggled to. */
  private readonly localVisionSources: VisionSource[] = [];

  constructor(options: BuildingEntityRenderer3DOptions) {
    this.world = options.world;
    this.clientViewState = options.clientViewState;
    this.selectionOverlays = options.selectionOverlays;
    this.constructionVisuals = options.constructionVisuals;
    this.turretHeadGeom = options.turretHeadGeom;
    this.barrelGeom = options.barrelGeom;
    this.coneBarrelGeom = options.coneBarrelGeom;
    this.barrelMat = options.barrelMat;
    this.getPrimaryMat = options.getPrimaryMat;
    this.disposeWorldParentedOverlays = options.disposeWorldParentedOverlays;
    this.getLocalPlayerId = options.getLocalPlayerId;
    this.ghostMat = new THREE.MeshLambertMaterial({
      color: COLORS.buildings.materials.buildingGhost.colorHex,
      transparent: true,
      opacity: COLORS.buildings.materials.buildingGhost.opacity,
      depthWrite: false,
    });
    this.animations = new BuildingAnimationController3D(
      this.clientViewState,
      this.constructionVisuals,
    );
  }

  update(frameState: RenderFrameState3D, spinDt: number, currentDtMs: number, timeMs: number): void {
    const buildings = this.clientViewState.getBuildings();
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const pruneBuildings = entitySetVersion !== this.lastEntitySetVersion;
    if (pruneBuildings) this.seenIds.clear();
    this.constructionVisuals.beginFrame();

    // Refresh local vision sources once per frame for ghost detection
    // (FOW-02a). Reuses the same predicate / radius helpers the server
    // uses for snapshot filtering so a building rendered as a ghost
    // here matches what the server would consider out-of-vision.
    this.refreshLocalVisionSources();

    for (const entity of buildings) {
      if (pruneBuildings) this.seenIds.add(entity.id);
      this.updateBuilding(entity, frameState);
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
    this.ghostMat.dispose();
  }

  /** Walk the client's units + buildings and pull out the local player's
   *  alive full-vision sources for this frame. Result goes into a
   *  pre-allocated array (no per-frame allocation in the hot path).
   *  FOW-OPT-06: reads from the per-player cache slice rather than
   *  filtering the world-wide list per frame. */
  private refreshLocalVisionSources(): void {
    this.localVisionSources.length = 0;
    const localPlayerId = this.getLocalPlayerId();
    if (localPlayerId === undefined) return;
    const collect = (entities: readonly Entity[]): void => {
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        if (!canEntityProvideFullVision(entity)) continue;
        this.localVisionSources.push({
          x: entity.transform.x,
          y: entity.transform.y,
          radius: getEntityFullVisionRadius(entity),
        });
      }
    };
    collect(this.clientViewState.getUnitsByPlayer(localPlayerId));
    collect(this.clientViewState.getBuildingsByPlayer(localPlayerId));
  }

  /** True when the building is in the local view but no local vision
   *  source currently covers its footprint. Owned buildings are never
   *  ghosts (you always see your own). When the local-player id is
   *  undefined (spectator / global view) nothing is ghosted. Also
   *  short-circuits when fog of war is disabled — the player can see
   *  the whole map, so every foreign building should render in full
   *  team color rather than desaturated. */
  private isBuildingGhost(entity: Entity): boolean {
    const localPlayerId = this.getLocalPlayerId();
    if (localPlayerId === undefined) return false;
    if (entity.ownership?.playerId === localPlayerId) return false;
    if (this.clientViewState.getServerMeta()?.fogOfWarEnabled !== true) return false;
    const padding = getEntityVisibilityPadding(entity);
    const px = entity.transform.x;
    const py = entity.transform.y;
    for (let i = 0; i < this.localVisionSources.length; i++) {
      const src = this.localVisionSources[i];
      const dx = px - src.x;
      const dy = py - src.y;
      const r = src.radius + padding;
      if (dx * dx + dy * dy <= r * r) return false;
    }
    return true;
  }

  private updateBuilding(entity: Entity, frameState: RenderFrameState3D): void {
    const graphicsTier = frameState.gfx.tier;
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
        geometryKey: frameState.key,
        world: this.world,
        turretHeadGeom: this.turretHeadGeom,
        barrelGeom: this.barrelGeom,
        coneBarrelGeom: this.coneBarrelGeom,
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
    const detailsReady = progress >= 1;
    const isGhost = this.isBuildingGhost(entity);
    const renderDirty =
      mesh.buildingCachedGraphicsTier !== graphicsTier ||
      mesh.buildingCachedOwnerId !== ownerId ||
      mesh.buildingCachedProgress !== progress ||
      mesh.buildingCachedSelected !== selected ||
      mesh.buildingCachedWidth !== width ||
      mesh.buildingCachedDepth !== depth ||
      mesh.buildingCachedX !== entity.transform.x ||
      mesh.buildingCachedY !== entity.transform.y ||
      mesh.buildingCachedZ !== entity.transform.z ||
      mesh.buildingCachedRotation !== entity.transform.rotation ||
      mesh.buildingCachedIsGhost !== isGhost;

    if (renderDirty) {
      this.updateBuildingMesh(
        entity,
        mesh,
        graphicsTier,
        ownerId,
        width,
        depth,
        progress,
        selected,
        buildingBaseY,
        detailsReady,
        isGhost,
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
    graphicsTier: ConcreteGraphicsQuality,
    ownerId: PlayerId | undefined,
    width: number,
    depth: number,
    progress: number,
    selected: boolean,
    buildingBaseY: number,
    detailsReady: boolean,
    isGhost: boolean,
  ): void {
    mesh.group.visible = true;
    // Ghost buildings (FOW-02a) override the team-colored primary
    // material with a shared desaturated mat — same shape, different
    // shading, so the player can tell at a glance that this is
    // last-seen intel rather than live data. The material-locked
    // skip path is preserved for buildings that own their own material
    // (e.g. specialty meshes that bake team color in).
    const ghostMat = isGhost ? this.ghostMat : null;
    if (!mesh.buildingPrimaryMaterialLocked) {
      const primaryMat = ghostMat ?? this.getPrimaryMat(ownerId);
      for (const chassisMesh of mesh.chassisMeshes) chassisMesh.material = primaryMat;
    }
    if (mesh.buildingDetails) {
      const primaryMat = ghostMat ?? this.getPrimaryMat(ownerId);
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
    primary.visible = true;

    if (mesh.buildingDetails) {
      for (const detail of mesh.buildingDetails) {
        detail.mesh.visible = detailsReady && buildingDetailVisible(detail, graphicsTier);
      }
    }

    this.selectionOverlays.updateSelectionRing(mesh, selected, Math.hypot(width, depth) * 0.55);

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
    mesh.buildingCachedIsGhost = isGhost;
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
