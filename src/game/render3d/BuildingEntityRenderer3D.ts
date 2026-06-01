import * as THREE from 'three';
import { COLORS } from '@/colorsConfig';
import type { Entity, EntityId, PlayerId } from '../sim/types';
import type { MetalDeposit } from '../../metalDepositConfig';
import { getBuildingConfig } from '../sim/buildConfigs';
import { getGraphicsConfig } from '@/clientBarConfig';
import {
  getConstructionPieceOpacity,
  getConstructionPieceRenderFraction,
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
  /** Current local player id, for ghost-building detection (FOW-02a).
   *  A foreign building stays on the client after exiting vision
   *  (FOW-02 server change); the renderer needs to know which seat
   *  is "us" to decide whether each building is in current vision or
   *  should render with the desaturated ghost material. */
  getLocalPlayerId: () => PlayerId | undefined;
  metalDeposits: readonly MetalDeposit[];
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
  private readonly getPrimaryMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly getTurretAccentMat: (playerId: PlayerId | undefined) => THREE.Material;
  private readonly disposeWorldParentedOverlays: (mesh: EntityMesh) => void;
  private readonly getLocalPlayerId: () => PlayerId | undefined;
  private readonly animations: BuildingAnimationController3D;
  private readonly meshes = new Map<EntityId, EntityMesh>();
  private readonly seenIds = new Set<EntityId>();
  private lastEntitySetVersion = -1;
  // Shared death-out flow (same controller units use, see EntityFade3D): a
  // dead building/tower is kept and its whole group dissolved 1 → 0 before
  // teardown, while the blast + debris play out. Assigned in the constructor.
  private readonly dyingBuildings: DyingMeshFade<EntityMesh>;
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
    this.getPrimaryMat = options.getPrimaryMat;
    this.getTurretAccentMat = options.getTurretAccentMat;
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
      options.metalDeposits,
    );
    this.dyingBuildings = new DyingMeshFade<EntityMesh>(
      ENTITY_DEATH_FADE_MS,
      (mesh, fade) => applyEntityGroupFade(mesh.group, fade),
      (_id, mesh) => {
        this.world.remove(mesh.group);
        disposeEntityGroupFade(mesh.group);
        this.disposeWorldParentedOverlays(mesh);
      },
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
    // Advance any in-progress death-out fades every frame (independent of
    // the entity-set prune cadence below).
    this.dyingBuildings.update(currentDtMs);

    if (!pruneBuildings) return;
    for (const [id, mesh] of this.meshes) {
      if (this.seenIds.has(id)) continue;
      // Died: hand the mesh to the shared death-out fade rather than
      // tearing it down now — it dissolves in place while the blast +
      // debris play out, then frees. Overlays / selection ring / animation
      // stop immediately.
      this.disposeWorldParentedOverlays(mesh);
      if (mesh.ring) mesh.ring.visible = false;
      this.animations.unregister(id);
      this.meshes.delete(id);
      this.dyingBuildings.markDying(id, mesh);
    }
    this.lastEntitySetVersion = entitySetVersion;
  }

  destroy(): void {
    for (const mesh of this.meshes.values()) {
      this.world.remove(mesh.group);
      disposeEntityGroupFade(mesh.group);
      this.disposeWorldParentedOverlays(mesh);
    }
    this.meshes.clear();
    this.dyingBuildings.destroyAll();
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
    // If this id is mid death-fade and reappeared (id reuse / re-add),
    // finalize the dying mesh so we don't draw it under the rebuilt one.
    if (this.dyingBuildings.size > 0 && this.dyingBuildings.has(entity.id)) {
      this.dyingBuildings.finalize(entity.id);
    }
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
        getPrimaryMat: this.getPrimaryMat,
        getTurretAccentMat: this.getTurretAccentMat,
      });
      this.meshes.set(entity.id, mesh);
      this.animations.register(entity, mesh);
    }

    const progress = getConstructionPieceRenderFraction(entity, 'body');
    const selected = entity.selectable?.selected === true;
    const buildingBaseY = entity.building ? entity.transform.z - entity.building.depth / 2 : 0;
    const detailsReady = progress >= 1;
    const isGhost = this.isBuildingGhost(entity);
    const renderDirty =
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

    // Materialization fade — the same per-piece build-in opacity flow
    // units use (see EntityFade3D). The body ramps 0→1 over its build
    // fraction, then each turret over its own, so a tower's body
    // materializes before its gun. Finished buildings sit at opacity 1,
    // where applyEntityGroupFade restores the real materials and costs
    // nothing.
    const bodyOpacity = getConstructionPieceOpacity(entity, 'body');
    applyEntityGroupFade(mesh.group, bodyOpacity);
    const combatTurrets = entity.combat?.turrets;
    if (combatTurrets) {
      for (let ti = 0; ti < combatTurrets.length && ti < mesh.turrets.length; ti++) {
        const turretOpacity = getConstructionPieceOpacity(entity, 'turret', ti);
        if (turretOpacity !== bodyOpacity) {
          applyEntityGroupFade(mesh.turrets[ti].root, turretOpacity);
        }
      }
    }
  }

  private updateBuildingMesh(
    entity: Entity,
    mesh: EntityMesh,
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
    // Construction appearance is now the shared materialization fade
    // (applied per frame in updateBuilding), not a pale shell-material
    // swap — buildings dissolve in through the same dither as units.

    const height = mesh.buildingHeight ?? BUILDING_HEIGHT;
    const renderHeight = height * progress;
    const primary = mesh.chassisMeshes[0];
    primary.position.set(0, renderHeight / 2, 0);
    primary.scale.set(width, renderHeight, depth);
    primary.visible = true;

    if (mesh.buildingDetails) {
      for (const detail of mesh.buildingDetails) {
        detail.mesh.visible = detailsReady;
      }
    }

    this.selectionOverlays.updateSelectionRing(mesh, selected, Math.hypot(width, depth) * 0.55);

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
    const underConstruction = isShell(entity);
    for (let turretIndex = 0; turretIndex < combatTurrets.length; turretIndex++) {
      const turret = combatTurrets[turretIndex];
      const turretMesh = mesh.turrets[turretIndex];
      const visible = turret.hp > 0 && isConstructionPieceMaterialized(entity, 'turret', turretIndex);
      turretMesh.root.visible = visible;
      if (!visible) continue;
      const headRadius = turretMesh.headRadius ?? getTurretHeadRadius(turret.config);
      turretMesh.root.position.set(
        turret.mount.x,
        turret.mount.z - headRadius,
        turret.mount.y,
      );
      // Construction emitters have no head sphere, no barrels, and
      // don't aim — the rig is parented directly to turretMesh.root and
      // is driven each frame by ConstructionVisualController. Skip the
      // head/aim/barrel work that follows.
      if (turret.config.constructionEmitter) continue;
      if (turret.config.headOnly) {
        // No barrel to orient — skip the aim pose entirely. While the
        // shell override owns the head material during construction,
        // leave it alone; after construction, the engaged state flips
        // the head from player primary to the half-white lock-on cue.
        if (turretMesh.head && !underConstruction) {
          turretMesh.head.material = turret.state === 'engaged'
            ? this.getTurretAccentMat(entity.ownership?.playerId)
            : this.getPrimaryMat(entity.ownership?.playerId);
        }
        continue;
      }
      if (!underConstruction) {
        const turretAccentMat = this.getTurretAccentMat(entity.ownership?.playerId);
        for (const barrel of turretMesh.barrels) barrel.material = turretAccentMat;
      }
      applyTurretAimPose3D(
        turretMesh,
        entity.transform.rotation,
        turret.rotation,
        turret.pitch,
      );
    }
  }
}
