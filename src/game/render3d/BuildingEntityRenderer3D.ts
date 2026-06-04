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
import { applyTurretAimPose3D, applyTurretAimWorldDir3D } from './TurretAimPose3D';
import { UnitBarrelSpinState3D } from './UnitBarrelSpinState3D';
import type { TurretBeamAimCache3D } from './TurretBeamAimCache3D';
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
  /** Gatling spin for tower-mounted multi-barrel turrets (e.g. the
   *  Anti-Air rocket gatling). Towers render per-Mesh, so they keep
   *  their own spin state separate from the unit renderer's. */
  private readonly barrelSpin = new UnitBarrelSpinState3D();
  /** Set each frame from update(): last beam direction per turret, read
   *  to aim beam-directed barrels on beam towers (turretBeamLong). */
  private beamAimCache: TurretBeamAimCache3D | null = null;
  private barrelSpinEnabled = false;

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

  update(
    frameState: RenderFrameState3D,
    spinDt: number,
    currentDtMs: number,
    timeMs: number,
    beamAimCache: TurretBeamAimCache3D,
  ): void {
    const buildings = this.clientViewState.getBuildings();
    const entitySetVersion = this.clientViewState.getEntitySetVersion();
    const pruneBuildings = entitySetVersion !== this.lastEntitySetVersion;
    if (pruneBuildings) this.seenIds.clear();
    this.constructionVisuals.beginFrame();
    this.beamAimCache = beamAimCache;
    this.barrelSpinEnabled = getGraphicsConfig().barrelSpin;

    // Refresh local vision sources once per frame for ghost detection
    // (FOW-02a). Reuses the same predicate / radius helpers the server
    // uses for snapshot filtering so a building rendered as a ghost
    // here matches what the server would consider out-of-vision.
    this.refreshLocalVisionSources();

    for (const entity of buildings) {
      if (pruneBuildings) this.seenIds.add(entity.id);
      this.barrelSpin.advance(entity, spinDt);
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
      // Shared beam-aim cache spans units + towers, so drop this tower's
      // entries precisely rather than via a seen-set sweep.
      beamAimCache.delete(id);
      this.dyingBuildings.markDying(id, mesh);
    }
    this.barrelSpin.prune(this.seenIds);
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
    this.barrelSpin.clear();
    this.ghostMat.dispose();
  }

  /** Walk the client's units + buildings and pull out the local player's
   *  alive full-vision sources for this frame. Result goes into a
   *  pre-allocated array (no per-frame allocation in the hot path).
   *  FOW-OPT-06: reads from the per-player cache slice rather than
   *  filtering the world-wide list per frame. */
  private refreshLocalVisionSources(): void {
    const localPlayerId = this.getLocalPlayerId();
    if (localPlayerId === undefined) {
      this.localVisionSources.length = 0;
      return;
    }
    let writeIndex = 0;
    writeIndex = this.collectLocalVisionSources(
      this.clientViewState.getUnitsByPlayer(localPlayerId),
      writeIndex,
    );
    writeIndex = this.collectLocalVisionSources(
      this.clientViewState.getBuildingsByPlayer(localPlayerId),
      writeIndex,
    );
    this.localVisionSources.length = writeIndex;
  }

  private collectLocalVisionSources(
    entities: readonly Entity[],
    writeIndex: number,
  ): number {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!canEntityProvideFullVision(entity)) continue;
      let source = this.localVisionSources[writeIndex];
      if (source === undefined) {
        source = { x: 0, y: 0, radius: 0 };
        this.localVisionSources[writeIndex] = source;
      }
      source.x = entity.transform.x;
      source.y = entity.transform.y;
      source.radius = getEntityFullVisionRadius(entity);
      writeIndex++;
    }
    return writeIndex;
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

    // Materialization fade — mounted turrets share the host body's build
    // fraction because they are not separate construction pieces.
    // Finished buildings sit at opacity 1, where applyEntityGroupFade
    // restores the real materials and costs nothing.
    const bodyOpacity = getConstructionPieceOpacity(entity, 'body');
    applyEntityGroupFade(mesh.group, bodyOpacity);
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
